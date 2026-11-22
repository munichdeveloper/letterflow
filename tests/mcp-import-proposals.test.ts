import { describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { importProposals } from "@/lib/acq/pipeline"
import type { AcqStore, LeadRow } from "@/lib/acq/store"
import { handleMcpRequest, type McpDeps } from "@/lib/mcp/server"

vi.mock("@/lib/server/db", () => ({ db: () => { throw new Error("keine Datenbank im Test") } }))

const TOKEN_A = "test-token-client-a-" + "0123456789".repeat(3)
const CONFIG = JSON.stringify({ "client-a": TOKEN_A })

const proposal = (overrides: Record<string, unknown> = {}) => ({
  domain: "beispiel-vertrieb.example",
  slug: "beispiel-vertrieb",
  page: {
    headline: "Telefonakquise sauber und nachweisbar",
    intro: "Ein kurzer Einstieg für die Geschäftsführung von Beispiel Vertrieb.",
    observations: [{ text: "Beispiel Vertrieb bietet Kaltakquise per Telefon an.", evidenceRef: "leistungen" }],
    proposal: ["Einwilligungen je Kontakt dokumentieren"],
    offer: "dsb",
  },
  letter: {
    subject: "Dokumentierte Telefonakquise",
    body: ["Sehr geehrte Damen und Herren,", "wir haben Ihre Leistungen gesehen."],
    evidenceRefs: ["leistungen"],
  },
  ...overrides,
})

function memory(state = "approved") {
  const leads = new Map<string, LeadRow>([["beispiel-vertrieb.example", { id: "l1", domain: "beispiel-vertrieb.example", state, slug: null } as unknown as LeadRow]])
  const proposals: { content: unknown; sha: string; revision: number }[] = []
  const actors: string[] = []
  const store = {
    async campaign(key: string) { if (key !== "test-kampagne") throw new Error("unknown-secret"); return { id: "c1", key, status: "active", offer: "dsb" } },
    async leadByDomain(_c: string, d: string) { return leads.get(d) },
    async evidence() { return [{ ref: "leistungen", kind: "fact" }] },
    async latestProposal() { return proposals.at(-1) },
    async setSlug(_id: string, slug: string) { leads.get("beispiel-vertrieb.example")!.slug = slug },
    async addProposal(_id: string, content: unknown, sha: string, actor: string) {
      actors.push(actor)
      const last = proposals.at(-1)
      if (last && last.sha === sha) return last
      const row = { content, sha, revision: proposals.length + 1 }
      proposals.push(row)
      return row
    },
  } as unknown as AcqStore
  return { store, leads, proposals, actors }
}

function setup(state?: string) {
  const m = memory(state)
  const run = vi.fn((batch, log) => importProposals(m.store, batch, log))
  const deps: McpDeps = { clientsConfig: CONFIG, listCampaigns: async () => [], campaignLeads: async () => [], importProposals: run, audit: () => {} }
  return { ...m, run, handler: (r: Request) => handleMcpRequest(r, deps) }
}

async function call(handler: (r: Request) => Promise<Response>, args: unknown) {
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    fetch: (input, init) => handler(new Request(input as string | URL, init)),
    requestInit: { headers: { Authorization: `Bearer ${TOKEN_A}` } },
  }))
  return client.callTool({ name: "letterflow_import_proposals", arguments: args as Record<string, unknown> })
}

describe("letterflow_import_proposals", () => {
  it("speichert einen Vorschlag mit Revision 1; Actor ist der authentifizierte Client", async () => {
    const s = setup()
    const res = await call(s.handler, { campaign: "test-kampagne", agent: "human:chef", proposals: [{ ...proposal(), agent: "human:chef" }] })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ stored: 1, unchanged: 0, refused: 0 })
    expect(s.proposals[0].revision).toBe(1)
    expect(s.actors).toEqual(["agent:client-a"])
    expect(s.run.mock.calls[0][0].agent).toBe("client-a")
    expect(s.leads.get("beispiel-vertrieb.example")!.state).toBe("approved")
    expect(JSON.stringify(res)).not.toMatch(/Kaltakquise|TOKEN/)
  })

  it("zählt unveränderte Wiederholung als unchanged", async () => {
    const s = setup()
    await call(s.handler, { campaign: "test-kampagne", proposals: [proposal()] })
    const again = await call(s.handler, { campaign: "test-kampagne", proposals: [proposal()] })
    expect(again.structuredContent).toEqual({ stored: 0, unchanged: 1, refused: 0 })
  })

  it("verweigert nicht freigegebene und unbekannte Leads, Slug-Wechsel und unbelegte Aussagen", async () => {
    const early = setup("checked")
    expect((await call(early.handler, { campaign: "test-kampagne", proposals: [proposal()] })).structuredContent).toEqual({ stored: 0, unchanged: 0, refused: 1 })
    const s = setup()
    expect((await call(s.handler, { campaign: "test-kampagne", proposals: [proposal({ domain: "fremd.example" })] })).structuredContent).toEqual({ stored: 0, unchanged: 0, refused: 1 })
    await call(s.handler, { campaign: "test-kampagne", proposals: [proposal()] })
    expect((await call(s.handler, { campaign: "test-kampagne", proposals: [proposal({ slug: "anderer-slug" })] })).structuredContent).toEqual({ stored: 0, unchanged: 0, refused: 1 })
    const bad = proposal()
    bad.page.observations[0].evidenceRef = "erfunden"
    const res = await call(s.handler, { campaign: "test-kampagne", proposals: [bad] })
    expect(res.structuredContent).toEqual({ stored: 0, unchanged: 0, refused: 1 })
    expect(JSON.stringify(res)).not.toContain("erfunden")
    expect(s.proposals).toHaveLength(1)
  })

  it("weist Zod-Verstöße und Größenüberschreitung ohne Aufruf ab; Fehler bleiben bereinigt", async () => {
    const s = setup()
    const many = Array.from({ length: 51 }, (_, i) => proposal({ domain: `firma${i}.example` }))
    for (const args of [
      { campaign: "test-kampagne", proposals: many },
      { campaign: "test-kampagne", proposals: [] },
      { campaign: "test-kampagne", proposals: [proposal({ slug: "Ungültig Slug" })] },
      { campaign: "test-kampagne", proposals: [proposal({ letter: { subject: "kurz", body: ["x"], evidenceRefs: [] } })] },
    ]) {
      const res = await call(s.handler, args).catch(() => ({ isError: true }))
      expect(res.isError).toBe(true)
    }
    expect(s.run).not.toHaveBeenCalled()
    const unknown = await call(s.handler, { campaign: "gibt-es-nicht", proposals: [proposal()] })
    expect(unknown.isError).toBe(true)
    expect(JSON.stringify(unknown)).not.toMatch(/unknown-secret/)
  })
})
