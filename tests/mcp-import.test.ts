import { describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { importLeads } from "@/lib/acq/pipeline"
import type { AcqStore, LeadRow } from "@/lib/acq/store"
import { handleMcpRequest, type McpDeps } from "@/lib/mcp/server"

vi.mock("@/lib/server/db", () => ({ db: () => { throw new Error("keine Datenbank im Test") } }))

const TOKEN_A = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ0bC2eF4hJ6kL8nP0r"
const CONFIG = JSON.stringify({ "client-a": TOKEN_A })
const URL_ = "http://localhost/api/mcp"
const NOW = "2026-11-20T10:00:00+01:00"

const lead = (overrides: Record<string, unknown> = {}) => ({
  company: "Beispiel Vertrieb GmbH", legalForm: "GmbH", domain: "beispiel-vertrieb.example",
  street: "Musterweg 1", postalCode: "80331", city: "München",
  fitReason: "Bietet Telefon- und E-Mail-Akquise für B2B-Kunden an.",
  imprintUrl: "https://www.beispiel-vertrieb.example/impressum",
  advertisingObjection: false, robotsAllowed: true, personNameInCompany: false, singlePersonCompany: false,
  evidence: [{ ref: "leistungen", kind: "fact", claim: "Bietet Kaltakquise per Telefon an.", sourceUrl: "https://www.beispiel-vertrieb.example/leistungen", retrievedAt: NOW }],
  ...overrides,
})

function memory() {
  const leads = new Map<string, LeadRow>()
  const suppressed = new Set<string>()
  const actors: string[] = []
  const transitions: string[] = []
  const store = {
    async campaign(key: string) { if (key !== "test-kampagne") throw new Error("unknown"); return { id: "c1", key, status: "active" } },
    async insertLead(_c: string, l: { domain: string }, actor: string) {
      actors.push(actor)
      const existing = leads.get(l.domain)
      if (existing) return { lead: existing, inserted: false }
      const row = { id: l.domain, domain: l.domain, state: "discovered" } as LeadRow
      leads.set(l.domain, row)
      return { lead: row, inserted: true }
    },
    async suppress(domain: string, _c: string, _r: string, actor: string) { actors.push(actor); suppressed.add(domain) },
    async transition(id: string, to: string, actor: string) {
      const row = leads.get(id)!
      const target = to === "checked" && suppressed.has(row.domain) ? "suppressed" : to
      row.state = target as LeadRow["state"]
      transitions.push(`${target}:${actor}`)
      return { ...row }
    },
  } as unknown as AcqStore
  return { store, leads, suppressed, actors, transitions }
}

function setup() {
  const m = memory()
  const run = vi.fn((batch, log) => importLeads(m.store, batch, log))
  const deps: McpDeps = { clientsConfig: CONFIG, listCampaigns: async () => [], campaignLeads: async () => [], importLeads: run, audit: () => {} }
  const handler = (r: Request) => handleMcpRequest(r, deps)
  return { ...m, run, handler }
}

async function call(handler: (r: Request) => Promise<Response>, args: unknown) {
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), {
    fetch: (input, init) => handler(new Request(input as string | URL, init)),
    requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } },
  }))
  return client.callTool({ name: "letterflow_import_leads", arguments: args as Record<string, unknown> })
}

describe("letterflow_import_leads", () => {
  it("importiert in den Zustand checked; Actor ist der authentifizierte Client, nie ein mitgesendeter", async () => {
    const s = setup()
    const res = await call(s.handler, { campaign: "test-kampagne", agent: "human:chef", leads: [lead()] })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ checked: 1, rejected: 0, suppressed: 0, known: 0 })
    expect(s.leads.get("beispiel-vertrieb.example")!.state).toBe("checked")
    expect(s.actors).toEqual(["agent:client-a"])
    expect(s.run.mock.calls[0][0].agent).toBe("client-a")
    expect(JSON.stringify(res)).not.toMatch(/Musterweg|Kaltakquise|TOKEN|aB3dE5/)
  })

  it("zählt Wiederholungen als known und lässt Ablehnung und Sperre unverändert", async () => {
    const s = setup()
    await call(s.handler, { campaign: "test-kampagne", leads: [lead()] })
    const again = await call(s.handler, { campaign: "test-kampagne", leads: [lead()] })
    expect(again.structuredContent).toEqual({ checked: 0, rejected: 0, suppressed: 0, known: 1 })
    const mixed = await call(s.handler, {
      campaign: "test-kampagne",
      leads: [lead({ domain: "objekt.example", advertisingObjection: true }), lead({ domain: "ablehnung.example", robotsAllowed: false })],
    })
    const out = mixed.structuredContent as Record<string, number>
    expect(out.suppressed + out.rejected).toBe(2)
    expect(out.checked).toBe(0)
    expect(s.leads.get("objekt.example")!.state).toBe("suppressed")
    expect(s.suppressed.has("objekt.example")).toBe(true)
    expect(s.actors.every((a) => a === "agent:client-a")).toBe(true)
  })

  it("weist ungültige Daten und mehr als 50 Leads ohne Seiteneffekt ab", async () => {
    const s = setup()
    const many = Array.from({ length: 51 }, (_, i) => lead({ domain: `firma${i}.example` }))
    for (const args of [
      { campaign: "test-kampagne", leads: many },
      { campaign: "test-kampagne", leads: [] },
      { campaign: "test-kampagne", leads: [lead({ evidence: [] })] },
      { campaign: "test-kampagne", leads: [lead({ domain: "https://x.example/pfad" })] },
      { campaign: "BIG CAMPAIGN", leads: [lead()] },
    ]) {
      const res = await call(s.handler, args).catch(() => ({ isError: true }))
      expect(res.isError).toBe(true)
    }
    expect(s.run).not.toHaveBeenCalled()
    expect(s.leads.size).toBe(0)
  })

  it("gibt keine Fehlerdetails des Imports zurück und gibt nichts frei", async () => {
    const s = setup()
    const res = await call(s.handler, { campaign: "gibt-es-nicht", leads: [lead()] })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res)).not.toMatch(/unknown/)
    const ok = setup()
    await call(ok.handler, { campaign: "test-kampagne", leads: [lead()] })
    expect(ok.transitions.every((t) => t.startsWith("checked:") || t.startsWith("rejected:") || t.startsWith("suppressed:"))).toBe(true)
    expect(ok.leads.get("beispiel-vertrieb.example")!.state).toBe("checked")
  })
})
