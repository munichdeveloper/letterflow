import { describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { authenticateBearer, parseMcpClients } from "@/lib/mcp/clients"
import { handleMcpRequest, type AuditEntry, type McpDeps } from "@/lib/mcp/server"
import { toPublicCampaign, type CampaignRow } from "@/lib/mcp/tools"

// Jeder direkte Datenbankzugriff (Schreiben, Pipeline) würde hier auffallen; MCP darf nur die übergebenen Loader nutzen.
const dbCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock("@/lib/server/db", () => ({ db: () => { dbCalls.count++; throw new Error("keine Datenbank im Test") } }))

const TOKEN_A = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ0bC2eF4hJ6kL8nP0r" // 43 Zeichen, Testwert
const TOKEN_B = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const CONFIG = JSON.stringify({ "client-a": TOKEN_A, "client-b": TOKEN_B })
const URL_ = "http://localhost/api/mcp"

const ROWS: CampaignRow[] = [
  { key: "k-active-1", title: "Aktiv 1", offer: "dsb", segment: "Beispiel GmbH", status: "active", interest_balancing_ref: "GEHEIM-REF", letter: { sender: "Musterweg 1" }, counts: { discovered: 2 } },
  { key: "k-paused", title: "Pausiert", offer: "dsb", segment: "Segment", status: "paused", interest_balancing_ref: null, letter: {}, counts: {} },
  { key: "k-active-2", title: "Aktiv 2", offer: "dsb", segment: "Segment", status: "active", interest_balancing_ref: null, letter: {}, counts: { sent: 1 } },
  { key: "k-closed", title: "Beendet", offer: "dsb", segment: "Segment", status: "closed", interest_balancing_ref: null, letter: {}, counts: {} },
]

const LEADS = Array.from({ length: 120 }, (_, i) => ({
  id: `uuid-${i}`, company: `Firma ${i}`, domain: `firma${i}.example`, slug: `geheimer-slug-${i}`, state: i === 0 ? "letter_ready" : "discovered",
  state_reason: null, updated_at: new Date("2026-01-01T00:00:00Z"), latest_revision: 1, approved_revision: null, evidence_count: 3,
  letter_status: "draft", street: "Geheimstr. 1", letter_pdf_sha256: "deadbeef", research: "Recherchetext",
}))

function setup(overrides: Partial<McpDeps> = {}) {
  const listCampaigns = vi.fn(async () => ROWS)
  const campaignLeads = vi.fn(async (_key: string) => LEADS)
  const audit: AuditEntry[] = []
  const deps: McpDeps = { clientsConfig: CONFIG, listCampaigns, campaignLeads, audit: (e) => audit.push(e), ...overrides }
  const handler = (request: Request) => handleMcpRequest(request, deps)
  return { listCampaigns, campaignLeads, audit, handler }
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

const INITIALIZE = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
}

async function connect(handler: (r: Request) => Promise<Response>, token = TOKEN_A) {
  const client = new Client({ name: "test", version: "1.0.0" })
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: (input, init) => handler(new Request(input as string | URL, init)),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

describe("MCP-Konfiguration", () => {
  it("nimmt gültige Clients an", () => {
    const parsed = parseMcpClients(CONFIG)
    expect(parsed.ok && [...parsed.clients.keys()]).toEqual(["client-a", "client-b"])
  })

  it.each([
    ["fehlt", undefined],
    ["leer", "  "],
    ["kein JSON", "{kaputt"],
    ["Array", "[]"],
    ["leeres Objekt", "{}"],
    ["Token zu kurz", JSON.stringify({ "client-a": "kurz" })],
    ["Token kaum Entropie", JSON.stringify({ "client-a": "a".repeat(64) })],
    ["Token kein String", JSON.stringify({ "client-a": 12345 })],
    ["ungültige Client-ID", JSON.stringify({ "Client A!": TOKEN_A })],
    ["doppeltes Token", JSON.stringify({ "client-a": TOKEN_A, "client-b": TOKEN_A })],
    ["ein schlechter Eintrag", JSON.stringify({ "client-a": TOKEN_A, "client-b": "kurz" })],
  ])("lehnt ab: %s", (_name, raw) => {
    expect(parseMcpClients(raw).ok).toBe(false)
  })

  it("nennt in Fehlergründen keine Tokenwerte", () => {
    const parsed = parseMcpClients(JSON.stringify({ "client-a": TOKEN_A, "client-b": "kurz-geheim" }))
    expect(parsed.ok).toBe(false)
    expect(JSON.stringify(parsed)).not.toContain("kurz-geheim")
    expect(JSON.stringify(parsed)).not.toContain(TOKEN_A)
  })

  it("ordnet Bearer-Token dem Client zu", () => {
    const parsed = parseMcpClients(CONFIG)
    if (!parsed.ok) throw new Error("Konfiguration ungültig")
    expect(authenticateBearer(`Bearer ${TOKEN_A}`, parsed.clients)).toBe("client-a")
    expect(authenticateBearer(`bearer ${TOKEN_B}`, parsed.clients)).toBe("client-b")
    expect(authenticateBearer(`Bearer ${TOKEN_A}x`, parsed.clients)).toBeNull()
    expect(authenticateBearer(TOKEN_A, parsed.clients)).toBeNull()
    expect(authenticateBearer("Basic abc", parsed.clients)).toBeNull()
    expect(authenticateBearer(null, parsed.clients)).toBeNull()
  })
})

describe("MCP-Handshake mit SDK-Client", () => {
  it("entdeckt genau ein Tool und ruft es auf", async () => {
    const { handler, listCampaigns, audit } = setup()
    const client = await connect(handler)
    expect(client.getServerVersion()?.name).toBe("letterflow")

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["letterflow_list_campaigns", "letterflow_get_status"])
    expect(listCampaigns).not.toHaveBeenCalled()

    const result = await client.callTool({ name: "letterflow_list_campaigns", arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(listCampaigns).toHaveBeenCalledTimes(1)
    const data = JSON.parse((result.content as { text: string }[])[0].text)
    expect(data.campaigns).toHaveLength(4)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ client: "client-a", tool: "letterflow_list_campaigns", result: "ok" })
    await client.close()
  })

  it("filtert nach Status und begrenzt", async () => {
    const { handler } = setup()
    const client = await connect(handler, TOKEN_B)
    const call = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "letterflow_list_campaigns", arguments: args })
      return result
    }
    const active = await call({ status: "active" })
    expect((active.structuredContent as { campaigns: { key: string }[] }).campaigns.map((c) => c.key)).toEqual(["k-active-1", "k-active-2"])
    const limited = await call({ limit: 1 })
    expect((limited.structuredContent as { campaigns: unknown[] }).campaigns).toHaveLength(1)
    const both = await call({ status: "active", limit: 1 })
    expect((both.structuredContent as { campaigns: { key: string }[] }).campaigns.map((c) => c.key)).toEqual(["k-active-1"])
    await client.close()
  })

  it("liefert nur die Whitelist-Felder", async () => {
    const { handler } = setup()
    const client = await connect(handler)
    const result = await client.callTool({ name: "letterflow_list_campaigns", arguments: { status: "active" } })
    const raw = JSON.stringify(result)
    for (const secret of ["letter", "interest_balancing_ref", "GEHEIM-REF", "Musterweg 1", TOKEN_A]) expect(raw).not.toContain(secret)
    const first = (result.structuredContent as { campaigns: Record<string, unknown>[] }).campaigns[0]
    expect(Object.keys(first).sort()).toEqual(["counts", "key", "offer", "segment", "status", "title"])
    await client.close()
  })

  it("weist ungültige Eingaben ab", async () => {
    const { handler, listCampaigns } = setup()
    const client = await connect(handler)
    for (const args of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { status: "deleted" }]) {
      const outcome = await client.callTool({ name: "letterflow_list_campaigns", arguments: args }).then((r) => r.isError === true, () => true)
      expect(outcome).toBe(true)
    }
    expect(listCampaigns).not.toHaveBeenCalled()
    await client.close()
  })

  it("gibt bei Datenbankfehlern keine Details weiter", async () => {
    const { handler, audit } = setup({ listCampaigns: async () => { throw new Error("password authentication failed for postgres://u:SECRET@host") } })
    const client = await connect(handler)
    const result = await client.callTool({ name: "letterflow_list_campaigns", arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain("SECRET")
    expect(JSON.stringify(result)).not.toContain("postgres")
    expect(audit[0]).toMatchObject({ result: "error" })
    await client.close()
  })
})

describe("MCP-Authentifizierung", () => {
  const cases: [string, () => Request][] = [
    ["ohne Authorization", () => post(INITIALIZE)],
    ["falsches Token", () => post(INITIALIZE, { authorization: `Bearer ${TOKEN_A}0` })],
    ["falsches Schema", () => post(INITIALIZE, { authorization: `Basic ${TOKEN_A}` })],
    ["nur Web-Cookie", () => post(INITIALIZE, { cookie: `letterflow_session=${TOKEN_A}` })],
    ["Token nur im Cookie", () => post(INITIALIZE, { cookie: `authorization=Bearer ${TOKEN_A}` })],
  ]

  it.each(cases)("401 und kein DB-Zugriff: %s", async (_name, make) => {
    const { handler, listCampaigns, audit } = setup()
    const response = await handler(make())
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/)
    expect(listCampaigns).not.toHaveBeenCalled()
    expect(audit).toEqual([expect.objectContaining({ client: null, tool: null, result: "denied" })])
  })

  it("prüft auch Tool-Aufrufe ohne Token, ohne DB-Zugriff", async () => {
    const { handler, listCampaigns } = setup()
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "letterflow_list_campaigns", arguments: {} } }
    expect((await handler(post(call))).status).toBe(401)
    expect(listCampaigns).not.toHaveBeenCalled()
  })

  it.each([
    ["fehlende Konfiguration", undefined],
    ["ungültige Konfiguration", "{kaputt"],
    ["zu schwaches Token", JSON.stringify({ "client-a": "kurz" })],
  ])("bleibt geschlossen (503, kein DB-Zugriff): %s", async (_name, config) => {
    const { handler, listCampaigns } = setup({ clientsConfig: config })
    const response = await handler(post(INITIALIZE, { authorization: `Bearer ${TOKEN_A}` }))
    expect(response.status).toBe(503)
    expect(listCampaigns).not.toHaveBeenCalled()
  })
})

describe("MCP-Fehlerfälle", () => {
  const auth = { authorization: `Bearer ${TOKEN_A}` }

  it("erlaubt nur POST", async () => {
    const { handler } = setup()
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await handler(new Request(URL_, { method, headers: auth }))
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("POST")
    }
  })

  it("lehnt kaputtes JSON ab", async () => {
    const { handler } = setup()
    const response = await handler(post("{nicht json", auth))
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe(-32700)
  })

  it("lehnt zu große Anfragen ab", async () => {
    const { handler, listCampaigns } = setup()
    const response = await handler(post(JSON.stringify({ ...INITIALIZE, pad: "x".repeat(70 * 1024) }), auth))
    expect(response.status).toBe(413)
    expect(listCampaigns).not.toHaveBeenCalled()
  })

  it("beantwortet unbekannte Tools kontrolliert", async () => {
    const { handler, listCampaigns } = setup()
    const client = await connect(handler)
    const outcome = await client.callTool({ name: "letterflow_import_leads", arguments: {} }).then((r) => r.isError === true, () => true)
    expect(outcome).toBe(true)
    expect(listCampaigns).not.toHaveBeenCalled()
    await client.close()
  })

  it("bricht zu lange Abfragen ab", async () => {
    const { handler, audit } = setup({ listCampaigns: () => new Promise(() => {}), toolTimeoutMs: 20 })
    const client = await connect(handler)
    const result = await client.callTool({ name: "letterflow_list_campaigns", arguments: {} })
    expect(result.isError).toBe(true)
    expect(audit[0]).toMatchObject({ result: "error" })
    await client.close()
  })
})

describe("MCP-Logs", () => {
  it("enthalten keine Tokens, Payloads oder Kampagnendaten", async () => {
    const lines: string[] = []
    const spies = (["info", "log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")) }))
    try {
      // Standard-Audit (console.info), ohne eigenen audit-Hook
      const listCampaigns = vi.fn(async () => ROWS)
      const campaignLeads = vi.fn(async (_key: string) => LEADS)
      const handler = (request: Request) => handleMcpRequest(request, { clientsConfig: CONFIG, listCampaigns, campaignLeads })
      const client = await connect(handler)
      await client.callTool({ name: "letterflow_list_campaigns", arguments: { status: "active" } })
      await client.close()
      await handler(post(INITIALIZE, { authorization: "Bearer falsches-geheimes-token" }))
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
    const output = lines.join("\n")
    expect(output).toContain("client-a")
    expect(output).toContain("letterflow_list_campaigns")
    for (const secret of [TOKEN_A, TOKEN_B, "falsches-geheimes-token", "GEHEIM-REF", "Musterweg 1", "k-active-1", "Aktiv 1"]) {
      expect(output).not.toContain(secret)
    }
    for (const line of lines) {
      const entry = JSON.parse(line)
      expect(Object.keys(entry).sort()).toEqual(["client", "durationMs", "event", "result", "time", "tool"])
    }
  })
})

describe("Ausgabe-Whitelist", () => {
  it("übernimmt keine weiteren Felder", () => {
    const out = toPublicCampaign({ ...ROWS[0], extra: "x" })
    expect(Object.keys(out).sort()).toEqual(["counts", "key", "offer", "segment", "status", "title"])
  })
})

describe("letterflow_get_status", () => {
  const SENSITIVE = ["Geheimstr", "deadbeef", "Recherchetext", "geheimer-slug", "uuid-", "GEHEIM-REF", "street", "slug", "sha256"]

  it("liefert Kampagnenliste als Whitelist, begrenzt auf 100", async () => {
    const { handler, campaignLeads } = setup()
    const client = await connect(handler)
    const result = await client.callTool({ name: "letterflow_get_status", arguments: { campaign: "k-active-1", limit: 100 } })
    const data = result.structuredContent as { total: number; returned: number; leads: Record<string, unknown>[] }
    expect(data.total).toBe(120)
    expect(data.leads).toHaveLength(100)
    expect(Object.keys(data.leads[0]).sort()).toEqual(
      ["approved_revision", "company", "domain", "evidence_count", "latest_revision", "letter_status", "state", "state_reason", "updated_at"])
    for (const word of SENSITIVE) expect(JSON.stringify(result)).not.toContain(word)
    expect(campaignLeads).toHaveBeenCalledTimes(1)
    const def = await client.callTool({ name: "letterflow_get_status", arguments: { campaign: "k-active-1" } })
    expect((def.structuredContent as { leads: unknown[] }).leads).toHaveLength(50)
  })

  it("liefert einen Lead mit requires_human_approval", async () => {
    const { handler } = setup()
    const client = await connect(handler)
    const result = await client.callTool({ name: "letterflow_get_status", arguments: { campaign: "k-active-1", domain: "firma0.example" } })
    const lead = (result.structuredContent as { lead: Record<string, unknown> }).lead
    expect(lead).toMatchObject({ company: "Firma 0", state: "letter_ready", requires_human_approval: true, updated_at: "2026-01-01T00:00:00.000Z" })
    for (const word of SENSITIVE) expect(JSON.stringify(result)).not.toContain(word)
  })

  it("behandelt unbekannte Kampagne und Domain kontrolliert, ohne Leads zu laden", async () => {
    const { handler, campaignLeads } = setup()
    const client = await connect(handler)
    const a = await client.callTool({ name: "letterflow_get_status", arguments: { campaign: "gibt-es-nicht" } })
    expect(a.isError).toBe(true)
    expect(campaignLeads).not.toHaveBeenCalled()
    const b = await client.callTool({ name: "letterflow_get_status", arguments: { campaign: "k-active-1", domain: "nope.example" } })
    expect(b.isError).toBe(true)
  })

  it.each([
    [{}], [{ campaign: "" }], [{ campaign: "k", limit: 0 }], [{ campaign: "k", limit: 101 }], [{ campaign: "k", limit: 1.5 }],
    [{ campaign: "k'; drop" }], [{ campaign: "k", domain: "a b" }],
  ])("weist ungültige Eingabe ab: %j", async (args) => {
    const { handler, campaignLeads } = setup()
    const client = await connect(handler)
    const outcome = await client.callTool({ name: "letterflow_get_status", arguments: args }).then((r) => r.isError === true, () => true)
    expect(outcome).toBe(true)
    expect(campaignLeads).not.toHaveBeenCalled()
  })

  it("führt keine Schreib- oder Provider-Operation aus", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    try {
      const { handler, campaignLeads, listCampaigns } = setup()
      const client = await connect(handler)
      await client.callTool({ name: "letterflow_get_status", arguments: { campaign: "k-active-1" } })
      await client.callTool({ name: "letterflow_get_status", arguments: { campaign: "k-active-1", domain: "firma0.example" } })
      await client.close()
      // Nur die beiden lesenden Loader, kein direkter DB-Zugriff, kein externer HTTP-Aufruf (Provider).
      expect(listCampaigns).toHaveBeenCalledTimes(2)
      expect(campaignLeads).toHaveBeenCalledTimes(2)
      expect(campaignLeads).toHaveBeenCalledWith("k-active-1")
      expect(dbCalls.count).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
    const { tools } = await connect(setup().handler).then((c) => c.listTools())
    expect(tools.find((t) => t.name === "letterflow_get_status")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
  })

  it("weist ungültige Tokens ab, ohne die Datenbank anzufassen", async () => {
    const { handler, campaignLeads, listCampaigns } = setup()
    const response = await handler(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "letterflow_get_status", arguments: { campaign: "k-active-1" } } }, { authorization: "Bearer falsch" }))
    expect(response.status).toBe(401)
    expect(campaignLeads).not.toHaveBeenCalled()
    expect(listCampaigns).not.toHaveBeenCalled()
  })
})
