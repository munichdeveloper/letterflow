import type { Sql } from "postgres"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { handleMcpRequest, type McpDeps } from "@/lib/mcp/server"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/acq/store", () => ({ sqlAcqStore: () => ({}) }))
vi.mock("@/lib/server/db", () => ({ db: () => { throw new Error("keine Datenbank im Test") } }))
const advance = vi.hoisted(() => vi.fn())
vi.mock("@/lib/acq/pipeline", () => ({ advance }))

import { runChain } from "@/lib/server/chain"

const TOKEN = "test-token-client-a-" + "0123456789".repeat(3)
const CONFIG = JSON.stringify({ "client-a": TOKEN })

/** Minimale Sql-Attrappe mit Tabelle acq.chain_runs; Integrationen sind leer (Standard: Staging). */
function fakeSql() {
  const runs = new Map<string, string>()
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    const text = strings.join("?")
    if (text.includes("insert into acq.chain_runs")) {
      const [key, runId] = values as string[]
      if (runs.has(key)) return []
      runs.set(key, runId)
      return [{ run_id: runId }]
    }
    if (text.includes("delete from acq.chain_runs")) {
      const [key, runId] = values as string[]
      if (runs.get(key) === runId) runs.delete(key)
      return []
    }
    if (text.includes("acq.integrations")) return []
    throw new Error(`unerwartete Abfrage: ${text}`)
  }) as unknown as Sql
  return { sql, runs }
}

function setup(run?: McpDeps["runPipeline"]) {
  const deps: McpDeps = { clientsConfig: CONFIG, listCampaigns: async () => [], campaignLeads: async () => [], runPipeline: run, audit: () => {} }
  return (r: Request) => handleMcpRequest(r, deps)
}

async function connect(handler: (r: Request) => Promise<Response>) {
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: (input, init) => handler(new Request(input as string | URL, init)),
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }))
  return client
}

const run = (client: Client, args: Record<string, unknown>) => client.callTool({ name: "letterflow_run_pipeline", arguments: args })

describe("letterflow_run_pipeline", () => {
  // Block-Körper: Eine von beforeEach zurückgegebene Funktion (hier die Attrappe selbst) wäre sonst ein Aufräum-Hook.
  beforeEach(() => {
    advance.mockReset()
  })

  it("ist das fünfte Tool, und es gibt kein Freigabe-Tool", async () => {
    const { tools } = await (await connect(setup())).listTools()
    expect(tools).toHaveLength(5)
    expect(tools.at(-1)?.name).toBe("letterflow_run_pipeline")
    expect(tools.map((t) => t.name).join(" ")).not.toMatch(/approve/)
  })

  it("ruft runChain nur bei explizitem Aufruf und meldet nur started/status", async () => {
    const { sql } = fakeSql()
    advance.mockResolvedValue(undefined)
    const client = await connect(setup((c) => runChain(sql, c, {}, () => {})))
    await client.listTools()
    expect(advance).not.toHaveBeenCalled()
    const res = await run(client, { campaign: "test-kampagne" })
    expect(res.structuredContent).toEqual({ started: true, status: "completed" })
    expect(advance).toHaveBeenCalledTimes(1)
    expect(advance.mock.calls[0][2]).toBe("test-kampagne")
  })

  it("zwei gleichzeitige Aufrufe derselben Kampagne starten genau einen Lauf", async () => {
    const { sql, runs } = fakeSql()
    let release!: () => void
    advance.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    const handler = setup((c) => runChain(sql, c, {}, () => {}))
    const first = run(await connect(handler), { campaign: "k1" })
    await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(1))
    const second = await run(await connect(handler), { campaign: "k1" })
    expect(second.structuredContent).toEqual({ started: false, status: "already_running" })
    release()
    expect((await first).structuredContent).toEqual({ started: true, status: "completed" })
    expect(advance).toHaveBeenCalledTimes(1)
    expect(runs.size).toBe(0)
  })

  it("Fehler (z. B. Staging-Sperre, fehlende Freigabe) werden ohne Details gemeldet", async () => {
    const { sql } = fakeSql()
    advance.mockRejectedValue(new Error("Pingen: Echter Versand ist gesperrt; Max Muster, Musterstr. 1, Bearer geheim"))
    const res = await run(await connect(setup((c) => runChain(sql, c, {}, () => {}))), { campaign: "k1" })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).not.toMatch(/Muster|geheim|Pingen/)
  })

  it("lehnt ungültige Eingaben ab, ohne runChain aufzurufen", async () => {
    const runner = vi.fn()
    const client = await connect(setup(runner))
    expect((await run(client, { campaign: "../x y" })).isError).toBe(true)
    expect(runner).not.toHaveBeenCalled()
  })

  it("ist ohne runPipeline-Abhängigkeit geschlossen", async () => {
    expect((await run(await connect(setup()), { campaign: "k1" })).isError).toBe(true)
  })
})
