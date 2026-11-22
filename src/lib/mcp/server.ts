import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { authenticateBearer, parseMcpClients } from "@/lib/mcp/clients"
import { getStatusInput, getStatusTool, importLeadsInput, importLeadsTool, importProposalsInput, importProposalsTool, type ImportLeadsRunner, type ImportProposalsRunner, listCampaignsInput, listCampaignsTool, runPipelineInput, runPipelineTool, type PipelineRunner, type CampaignRow, type LeadStatusRow } from "@/lib/mcp/tools"

export const MAX_BODY_BYTES = 64 * 1024
export const TOOL_TIMEOUT_MS = 15_000

/** Audit ohne Payloads und ohne Tokens: nur Zeit, Client, Tool, Ergebnis, Dauer. */
export type AuditEntry = {
  time: string
  client: string | null
  tool: string | null
  result: "ok" | "error" | "denied"
  durationMs: number
}

export type McpDeps = {
  /** Wert von LETTERFLOW_MCP_CLIENTS. */
  clientsConfig: string | undefined
  /** Datenbankabfrage; wird erst nach erfolgreicher Authentifizierung durch ein Tool aufgerufen. */
  listCampaigns: () => Promise<CampaignRow[]>
  /** Lead-Übersicht einer Kampagne (nur lesend). */
  campaignLeads: (key: string) => Promise<LeadStatusRow[]>
  /** Schreibender Import; ruft im Betrieb importLeads(sqlAcqStore(db()), …) auf. Fehlt er, bleibt das Tool geschlossen. */
  importLeads?: ImportLeadsRunner
  /** Schreibender Vorschlagsimport; ruft im Betrieb importProposals(sqlAcqStore(db()), …) auf. Fehlt er, bleibt das Tool geschlossen. */
  importProposals?: ImportProposalsRunner
  /** Expliziter Kettenlauf; ruft im Betrieb runChain(db(), campaign, process.env, log) auf. Fehlt er, bleibt das Tool geschlossen. */
  runPipeline?: PipelineRunner
  audit?: (entry: AuditEntry) => void
  now?: () => Date
  toolTimeoutMs?: number
}

const defaultAudit = (entry: AuditEntry) => console.info(JSON.stringify({ event: "mcp", ...entry }))

function jsonRpcError(status: number, code: number, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Neuer Server je Request (zustandslos); der Tool-Handler kennt den authentifizierten Client. */
export function createMcpServer(clientId: string, deps: McpDeps) {
  const audit = deps.audit ?? defaultAudit
  const now = deps.now ?? (() => new Date())
  const server = new McpServer({ name: "letterflow", version: "0.1.0" })
  server.registerTool(
    "letterflow_list_campaigns",
    {
      title: "Kampagnen auflisten",
      description: "Listet Briefakquise-Kampagnen (Schlüssel, Titel, Angebot, Segment, Status, Anzahl Leads je Zustand). Nur lesend.",
      inputSchema: listCampaignsInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const started = Date.now()
      const done = (result: "ok" | "error") =>
        audit({ time: now().toISOString(), client: clientId, tool: "letterflow_list_campaigns", result, durationMs: Date.now() - started })
      try {
        const data = await withTimeout(listCampaignsTool(input, deps.listCampaigns), deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS)
        done("ok")
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data }
      } catch {
        // Keine Fehlermeldung der Datenbank weitergeben (kann Verbindungsdaten enthalten).
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: "Die Kampagnenliste konnte nicht gelesen werden." }] }
      }
    },
  )
  server.registerTool(
    "letterflow_get_status",
    {
      title: "Status abfragen",
      description: "Status einer Kampagne (Leads mit Zustand, Revisionen, Belegzahl, Briefstatus) oder eines Leads (mit domain). Nur lesend, nur freigegebene Metadaten.",
      inputSchema: getStatusInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const started = Date.now()
      const done = (result: "ok" | "error") =>
        audit({ time: now().toISOString(), client: clientId, tool: "letterflow_get_status", result, durationMs: Date.now() - started })
      try {
        const out = await withTimeout(getStatusTool(input, deps), deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS)
        if (!out.ok) {
          done("error")
          return { isError: true, content: [{ type: "text" as const, text: out.message }] }
        }
        done("ok")
        return { content: [{ type: "text" as const, text: JSON.stringify(out.data) }], structuredContent: out.data }
      } catch {
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: "Der Status konnte nicht gelesen werden." }] }
      }
    },
  )
  server.registerTool(
    "letterflow_import_leads",
    {
      title: "Leads importieren",
      description: "Importiert 1–50 recherchierte Unternehmen mit Quellenbelegen in eine aktive Kampagne (Zustand checked, rejected oder suppressed). Startet keine Pipeline und gibt nichts frei. Bereits bekannte Domains werden als known gezählt.",
      inputSchema: importLeadsInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const started = Date.now()
      const done = (result: "ok" | "error") =>
        audit({ time: now().toISOString(), client: clientId, tool: "letterflow_import_leads", result, durationMs: Date.now() - started })
      const run = deps.importLeads
      if (!run) {
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: "Der Import ist nicht verfügbar." }] }
      }
      try {
        const out = await withTimeout(importLeadsTool(input, clientId, run), deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS)
        if (!out.ok) {
          done("error")
          return { isError: true, content: [{ type: "text" as const, text: out.message }] }
        }
        done("ok")
        return { content: [{ type: "text" as const, text: JSON.stringify(out.data) }], structuredContent: out.data }
      } catch {
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: "Der Import ist fehlgeschlagen." }] }
      }
    },
  )
  server.registerTool(
    "letterflow_import_proposals",
    {
      title: "Vorschläge importieren",
      description: "Übergibt 1–50 Landingpage- und Briefvorschläge (je Domain) für bereits menschlich freigegebene Leads. Gezählt wird stored, unchanged oder refused. Erzeugt keine Seiten, baut keine PDFs, startet keine Pipeline und gibt nichts frei.",
      inputSchema: importProposalsInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const started = Date.now()
      const done = (result: "ok" | "error") =>
        audit({ time: now().toISOString(), client: clientId, tool: "letterflow_import_proposals", result, durationMs: Date.now() - started })
      const run = deps.importProposals
      if (!run) {
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: "Der Import ist nicht verfügbar." }] }
      }
      try {
        const out = await withTimeout(importProposalsTool(input, clientId, run), deps.toolTimeoutMs ?? TOOL_TIMEOUT_MS)
        if (!out.ok) {
          done("error")
          return { isError: true, content: [{ type: "text" as const, text: out.message }] }
        }
        done("ok")
        return { content: [{ type: "text" as const, text: JSON.stringify(out.data) }], structuredContent: out.data }
      } catch {
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: "Der Import ist fehlgeschlagen." }] }
      }
    },
  )
  server.registerTool(
    "letterflow_run_pipeline",
    {
      title: "Pipeline starten",
      description: "Startet die LetterFlow-Kette einer Kampagne ausdrücklich (runChain). Verarbeitet nur bereits menschlich freigegebene Schritte, gibt nichts frei, versendet nur über Pingen Staging. Läuft schon ein Lauf, wird kein zweiter gestartet (already_running).",
      inputSchema: runPipelineInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const started = Date.now()
      const done = (result: "ok" | "error") =>
        audit({ time: now().toISOString(), client: clientId, tool: "letterflow_run_pipeline", result, durationMs: Date.now() - started })
      const run = deps.runPipeline
      if (!run) {
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: "Der Pipeline-Lauf ist nicht verfügbar." }] }
      }
      // Bewusst ohne Tool-Timeout: Ein Abbruch der Antwort würde den Lauf nicht stoppen; die Sperre läuft über runChain.
      const out = await runPipelineTool(input, run)
      if (!out.ok) {
        done("error")
        return { isError: true, content: [{ type: "text" as const, text: out.message }] }
      }
      done("ok")
      return { content: [{ type: "text" as const, text: JSON.stringify(out.data) }], structuredContent: out.data }
    },
  )
  return server
}

async function readLimitedBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > max) return null
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Streamable HTTP, zustandslos: jeder POST wird einzeln geprüft und beantwortet. */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const audit = deps.audit ?? defaultAudit
  const now = deps.now ?? (() => new Date())
  const started = Date.now()
  const denied = () => audit({ time: now().toISOString(), client: null, tool: null, result: "denied", durationMs: Date.now() - started })

  // Authentifizierung vor allem anderen; Cookies zählen nicht.
  const config = parseMcpClients(deps.clientsConfig)
  if (!config.ok) {
    denied()
    return jsonRpcError(503, -32000, "MCP-Endpunkt ist nicht konfiguriert.")
  }
  const clientId = authenticateBearer(request.headers.get("authorization"), config.clients)
  if (!clientId) {
    denied()
    return jsonRpcError(401, -32001, "Nicht autorisiert.", { "www-authenticate": 'Bearer realm="letterflow-mcp"' })
  }

  // Zustandslos: kein Server-Stream (GET) und keine Sitzungen (DELETE).
  if (request.method !== "POST") return jsonRpcError(405, -32000, "Nur POST ist erlaubt.", { allow: "POST" })

  const text = await readLimitedBody(request, MAX_BODY_BYTES)
  if (text === null) return jsonRpcError(413, -32000, "Anfrage zu groß.")
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(text)
  } catch {
    return jsonRpcError(400, -32700, "Ungültiges JSON.")
  }

  const server = createMcpServer(clientId, deps)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    const response = await transport.handleRequest(request, { parsedBody })
    response.headers.set("cache-control", "no-store")
    return response
  } catch {
    return jsonRpcError(500, -32603, "Interner Fehler.")
  } finally {
    // Der Transport ist je Request; Aufräumen darf die Antwort nicht verhindern.
    void server.close().catch(() => {})
  }
}
