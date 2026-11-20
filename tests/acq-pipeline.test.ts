import { describe, expect, it } from "vitest"
import type { LeadCandidate, LeadState, Proposal } from "@/lib/acq/contracts"
import { advance, approve, importLeads, importProposals, sha256, type ChainDeps, type Seed } from "@/lib/acq/pipeline"
import { jevPrivacyScore } from "@/lib/acq/privacy"
import { checkLead, checkProposal, companyHasPersonName } from "@/lib/acq/rules"
import type { AcqStore, CampaignRow, LeadRow, ProposalRow } from "@/lib/acq/store"

const NOW = "2026-11-20T10:00:00+01:00"

function candidate(overrides: Partial<LeadCandidate> = {}): LeadCandidate {
  return {
    company: "Beispiel Vertrieb GmbH",
    legalForm: "GmbH",
    domain: "beispiel-vertrieb.de",
    street: "Musterweg 1",
    postalCode: "80331",
    city: "München",
    fitReason: "Bietet Telefon- und E-Mail-Akquise für B2B-Kunden an.",
    imprintUrl: "https://www.beispiel-vertrieb.de/impressum",
    advertisingObjection: false,
    robotsAllowed: true,
    personNameInCompany: false,
    singlePersonCompany: false,
    evidence: [
      { ref: "leistungen", kind: "fact", claim: "Bietet Kaltakquise per Telefon und E-Mail an.", sourceUrl: "https://www.beispiel-vertrieb.de/leistungen", retrievedAt: NOW },
      { ref: "brief", kind: "hypothesis", claim: "Briefe nutzt die Agentur bisher nicht.", sourceUrl: "https://www.beispiel-vertrieb.de/leistungen", retrievedAt: NOW },
    ],
    ...overrides,
  }
}

function proposal(overrides: Partial<Proposal["page"]> = {}): Proposal {
  return {
    slug: "beispiel-vertrieb",
    page: {
      headline: "Briefe als dritter Kanal neben Telefon und E-Mail",
      intro: "Schön, dass Sie den QR-Code gescannt haben. Hier steht ausführlicher, was ich Ihnen vorschlage.",
      observations: [
        { text: "Sie bieten Ihren Kunden Kaltakquise per Telefon und E-Mail an.", evidenceRef: "leistungen" },
        { text: "Wäre ein persönlicher Brief als Türöffner eine Ergänzung für Ihre Kunden?", evidenceRef: "brief" },
      ],
      proposal: ["Ich baue Ihnen eine Kette aus Recherche, persönlicher Seite und Brief."],
      ...overrides,
    },
    letter: {
      subject: "Ein dritter Kanal für Ihre Akquisekunden",
      body: ["auf Ihrer Website beschreiben Sie Telefon- und E-Mail-Akquise.", "Darf ich Ihnen zeigen, wie das aussieht?"],
      evidenceRefs: ["leistungen"],
    },
  }
}

// ---------------------------------------------------------------------------------------------

describe("checkLead", () => {
  it("accepts a clean GmbH", () => expect(checkLead(candidate())).toEqual({ action: "accept" }))

  it("suppresses on an advertising objection", () => {
    expect(checkLead(candidate({ advertisingObjection: true })).action).toBe("suppress")
  })

  it("rejects person names, wrong legal form, robots and foreign sources", () => {
    expect(checkLead(candidate({ company: "Thomas Muster Vertrieb GmbH" })).action).toBe("reject")
    expect(checkLead(candidate({ company: "Beispiel Vertrieb UG (haftungsbeschränkt)" })).action).toBe("reject")
    expect(checkLead(candidate({ legalForm: "UG", company: "Beispiel Vertrieb UG (haftungsbeschränkt)" })).action).toBe("accept")
    expect(checkLead(candidate({ robotsAllowed: false })).action).toBe("reject")
    expect(checkLead(candidate({ singlePersonCompany: true })).action).toBe("reject")
    expect(checkLead(candidate({ imprintUrl: "https://northdata.de/beispiel" })).action).toBe("reject")
    const onlyForeign = candidate({ evidence: [{ ref: "x", kind: "fact", claim: "Firma existiert seit 2010.", sourceUrl: "https://www.northdata.de/x", retrievedAt: NOW }] })
    expect(checkLead(onlyForeign).action).toBe("reject")
  })

  it("rejects evidence that names a person", () => {
    const named = candidate({ evidence: [{ ref: "gf", kind: "fact", claim: "Geschäftsführer Hansen leitet das Team.", sourceUrl: "https://www.beispiel-vertrieb.de/team", retrievedAt: NOW }] })
    expect(checkLead(named)).toMatchObject({ action: "reject" })
  })

  it("spots first names in company names", () => {
    expect(companyHasPersonName("Peter & Partner GmbH")).toBe(true)
    expect(companyHasPersonName("Nordwind UG")).toBe(false)
  })
})

describe("checkProposal", () => {
  const evidence = [{ ref: "leistungen", kind: "fact" as const }, { ref: "brief", kind: "hypothesis" as const }]

  it("accepts a proposal with existing evidence", () => expect(checkProposal(proposal(), evidence)).toEqual([]))

  it("needs proposal points only for the DSB offer", () => {
    const controla = proposal({ proposal: [], offer: "managed" })
    expect(checkProposal(controla, evidence, "saas")).toEqual([])
    expect(checkProposal(proposal({ proposal: [] }), evidence, "dsb").join()).toMatch(/Vorschlagspunkt/)
  })

  it("refuses prices, persons, markup, unknown evidence and hypotheses stated as facts", () => {
    const bad = proposal({
      observations: [
        { text: "Briefe nutzen Sie bisher gar nicht, das ist eine Lücke.", evidenceRef: "brief" },
        { text: "Sie haben einen großen Kundenstamm im Mittelstand.", evidenceRef: "erfunden" },
      ],
      proposal: ["Umsetzung ab 2.900 € pauschal", "Herr Hansen bekommt eine Demo", "<script>alert(1)</script> klingt gut"],
    })
    const problems = checkProposal(bad, evidence).join("\n")
    expect(problems).toMatch(/Hypothese nur als Frage/)
    expect(problems).toMatch(/erfunden gibt es nicht/)
    expect(problems).toMatch(/Preisangabe/)
    expect(problems).toMatch(/Personenname/)
    expect(problems).toMatch(/Markup/)
  })
})

// ---------------------------------------------------------------------------------------------
// In-memory copy of acq.transition / acq.add_proposal (business-os migration 20261120110000)

const ALLOWED = new Set([
  "discovered>checked", "discovered>rejected", "checked>approved", "checked>rejected", "approved>researched", "approved>rejected",
  "researched>researched", "researched>page_ready", "researched>rejected", "page_ready>page_ready", "page_ready>page_approved",
  "page_ready>researched", "page_ready>rejected", "page_approved>letter_ready", "page_approved>researched", "letter_ready>letter_ready",
  "letter_ready>letter_approved", "letter_ready>researched", "letter_ready>rejected", "letter_approved>queued", "letter_approved>researched", "letter_approved>rejected", "queued>sent",
])

function memoryStore() {
  const campaign: CampaignRow = { id: "c1", key: "dsb-agenturen", title: "T", offer: "dsb", segment: "Akquiseagenturen", letter: {}, interest_balancing_ref: "doc", status: "active" }
  const leads = new Map<string, LeadRow>()
  const evidence = new Map<string, { ref: string; kind: "fact" | "hypothesis" }[]>()
  const proposals: ProposalRow[] = []
  const suppression = new Set<string>()
  const events: string[] = []
  const store: AcqStore = {
    async campaign(key) { if (key !== campaign.key) throw new Error("unknown"); return campaign },
    async insertLead(campaignId, l) {
      const existing = [...leads.values()].find((x) => x.domain === l.domain)
      if (existing) return { lead: existing, inserted: false }
      const lead: LeadRow = { id: l.domain, campaign_id: campaignId, domain: l.domain, company: l.company, legal_form: l.legalForm, street: l.street, postal_code: l.postalCode, city: l.city, slug: null, state: "discovered", state_reason: null, resume_state: null, approved_revision: null, letter_pdf_sha256: null, approved_pdf_sha256: null }
      leads.set(lead.id, lead)
      evidence.set(lead.id, l.evidence.map((e) => ({ ref: e.ref, kind: e.kind })))
      return { lead, inserted: true }
    },
    async leads(_c, states) { return [...leads.values()].filter((l) => !states || states.includes(l.state)) },
    async leadByDomain(_c, domain) { return leads.get(domain) },
    async evidence(id) { return evidence.get(id) ?? [] },
    async latestProposal(id) { return proposals.filter((p) => p.lead_id === id).at(-1) },
    async addProposal(id, content, sha, actor) {
      const last = await store.latestProposal(id)
      if (last && last.content_sha256 === sha) return last
      const row = { id: `${id}-${proposals.length}`, lead_id: id, revision: (last?.revision ?? 0) + 1, content, content_sha256: sha, created_by: actor }
      proposals.push(row)
      await store.transition(id, "researched", actor)
      return row
    },
    async setSlug(id, slug) { leads.get(id)!.slug = slug },
    async suppress(domain) { suppression.add(domain) },
    async transition(id, to, actor, reason = null, detail: any = {}) {
      const lead = leads.get(id)!
      let target: LeadState = to
      if (!["suppressed", "rejected", "failed"].includes(to) && suppression.has(lead.domain)) target = "suppressed"
      const ok = lead.state === "failed" ? target === lead.resume_state || ["rejected", "suppressed"].includes(target)
        : ALLOWED.has(`${lead.state}>${target}`) || (target === "suppressed" && !["suppressed", "sent"].includes(lead.state))
          || (target === "failed" && !["rejected", "suppressed", "sent", "failed"].includes(lead.state))
      if (!ok) throw new Error(`transition ${lead.state} -> ${target} not allowed`)
      if (["approved", "page_approved", "letter_approved"].includes(target) && !actor.startsWith("human:")) throw new Error("needs a human approval")
      if (target === "page_approved" && detail.revision !== (await store.latestProposal(id))?.revision) throw new Error("revision")
      if (target === "letter_approved" && detail.pdf_sha256 !== lead.letter_pdf_sha256) throw new Error("pdf")
      const prev = lead.state
      Object.assign(lead, {
        state: target, state_reason: reason, resume_state: target === "failed" ? prev : null,
        approved_revision: target === "page_approved" ? detail.revision : target === "researched" ? null : lead.approved_revision,
        letter_pdf_sha256: target === "letter_ready" ? detail.pdf_sha256 : target === "researched" ? null : lead.letter_pdf_sha256,
        approved_pdf_sha256: target === "letter_approved" ? detail.pdf_sha256 : ["researched", "letter_ready"].includes(target) ? null : lead.approved_pdf_sha256,
      })
      events.push(`${lead.domain}:${prev}>${target}`)
      return { ...lead }
    },
  }
  return { store, leads, suppression, events }
}

function fakeDeps(overrides: Partial<ChainDeps> = {}) {
  const pdfs = new Map<string, Uint8Array>()
  const uploads: string[] = []
  const seeds: Seed[] = []
  const deps: ChainDeps = {
    async setupPages(seed) { seeds.push(seed) },
    async buildLetters(seed) {
      for (const page of seed.pages) pdfs.set(page.slug, new TextEncoder().encode(`PDF ${page.slug} ${page.letter.address.join("|")}`))
      return new Map(pdfs)
    },
    async readLetter(_c, slug) { return pdfs.get(slug) },
    async upload(_c, slug) { uploads.push(slug); return { action: "created", status: "created" } },
    async privacyScore() { return { personal: 0.05, choice: "company", model: "jev-latest" } },
    async sync() { return "sent" },
    log() {},
    ...overrides,
  }
  return { deps, pdfs, uploads, seeds }
}

const log = () => {}

describe("chain", () => {
  it("runs a lead from import to sent, stopping at every human gate", async () => {
    const { store, leads } = memoryStore()
    const { deps, pdfs, uploads, seeds } = fakeDeps()
    expect(await importLeads(store, { campaign: "dsb-agenturen", agent: "claude", leads: [candidate()] }, log)).toMatchObject({ checked: 1 })
    const lead = () => leads.get("beispiel-vertrieb.de")!

    // without lead approval no proposal is accepted
    expect(await importProposals(store, { campaign: "dsb-agenturen", agent: "claude", proposals: [{ domain: "beispiel-vertrieb.de", ...proposal() }] }, log)).toMatchObject({ refused: 1 })
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "lead", "johannes")
    expect(await importProposals(store, { campaign: "dsb-agenturen", agent: "claude", proposals: [{ domain: "beispiel-vertrieb.de", ...proposal() }] }, log)).toMatchObject({ stored: 1 })
    expect(lead().state).toBe("researched")

    await advance(store, deps, "dsb-agenturen")
    expect(lead().state).toBe("page_ready")
    await advance(store, deps, "dsb-agenturen") // waits for the page approval
    expect(lead().state).toBe("page_ready")

    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "page", "johannes")
    await advance(store, deps, "dsb-agenturen")
    expect(lead().state).toBe("letter_ready")
    expect(new TextDecoder().decode(pdfs.get("beispiel-vertrieb"))).toContain("Geschäftsführung")
    expect(seeds[0].pages[0].offer).toBe("dsb")
    expect(uploads).toEqual([])

    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "letter", "johannes")
    await advance(store, deps, "dsb-agenturen")
    expect(uploads).toEqual(["beispiel-vertrieb"])
    expect(lead().state).toBe("sent")
  })

  it("never uploads a PDF other than the approved one", async () => {
    const { store, leads } = memoryStore()
    const { deps, pdfs, uploads } = fakeDeps()
    await importLeads(store, { campaign: "dsb-agenturen", agent: "claude", leads: [candidate()] }, log)
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "lead", "johannes")
    await importProposals(store, { campaign: "dsb-agenturen", agent: "claude", proposals: [{ domain: "beispiel-vertrieb.de", ...proposal() }] }, log)
    await advance(store, deps, "dsb-agenturen")
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "page", "johannes")
    await advance(store, deps, "dsb-agenturen")
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "letter", "johannes")
    pdfs.set("beispiel-vertrieb", new TextEncoder().encode("anderes PDF"))
    await advance(store, deps, "dsb-agenturen")
    expect(uploads).toEqual([])
    expect(leads.get("beispiel-vertrieb.de")).toMatchObject({ state: "failed", resume_state: "letter_approved" })
  })

  it("a new proposal revision drops the page approval", async () => {
    const { store, leads } = memoryStore()
    const { deps } = fakeDeps()
    await importLeads(store, { campaign: "dsb-agenturen", agent: "claude", leads: [candidate()] }, log)
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "lead", "johannes")
    await importProposals(store, { campaign: "dsb-agenturen", agent: "claude", proposals: [{ domain: "beispiel-vertrieb.de", ...proposal() }] }, log)
    await advance(store, deps, "dsb-agenturen")
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "page", "johannes")
    await importProposals(store, { campaign: "dsb-agenturen", agent: "claude", proposals: [{ domain: "beispiel-vertrieb.de", ...proposal({ headline: "Eine neue Überschrift für die Seite" }) }] }, log)
    expect(leads.get("beispiel-vertrieb.de")).toMatchObject({ state: "researched", approved_revision: null })
  })

  it("suppression wins and the agent cannot approve", async () => {
    const { store, leads, suppression } = memoryStore()
    await importLeads(store, { campaign: "dsb-agenturen", agent: "claude", leads: [candidate(), candidate({ domain: "andere-agentur.de", company: "Andere Agentur GmbH", imprintUrl: "https://andere-agentur.de/impressum", advertisingObjection: true })] }, log)
    expect(leads.get("andere-agentur.de")!.state).toBe("suppressed")
    expect(suppression.has("andere-agentur.de")).toBe(true)
    await expect(store.transition("beispiel-vertrieb.de", "approved", "agent:claude")).rejects.toThrow(/human/)
    suppression.add("beispiel-vertrieb.de")
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "lead", "johannes")
    expect(leads.get("beispiel-vertrieb.de")!.state).toBe("suppressed")
  })

  it("a failing page setup marks the leads failed and keeps the resume point", async () => {
    const { store, leads } = memoryStore()
    const { deps } = fakeDeps({ async setupPages() { throw new Error("Directus 503") } })
    await importLeads(store, { campaign: "dsb-agenturen", agent: "claude", leads: [candidate()] }, log)
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "lead", "johannes")
    await importProposals(store, { campaign: "dsb-agenturen", agent: "claude", proposals: [{ domain: "beispiel-vertrieb.de", ...proposal() }] }, log)
    await advance(store, deps, "dsb-agenturen")
    expect(leads.get("beispiel-vertrieb.de")).toMatchObject({ state: "failed", resume_state: "researched", state_reason: "Directus 503" })
  })

  it("hashes are stable", () => expect(sha256("a")).toHaveLength(64))
})

describe("Jev-Prüfung vor dem Versand", () => {
  async function toLetterApproved(deps: ChainDeps) {
    const { store, leads } = memoryStore()
    await importLeads(store, { campaign: "dsb-agenturen", agent: "claude", leads: [candidate()] }, log)
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "lead", "johannes")
    await importProposals(store, { campaign: "dsb-agenturen", agent: "claude", proposals: [{ domain: "beispiel-vertrieb.de", ...proposal() }] }, log)
    await advance(store, deps, "dsb-agenturen")
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "page", "johannes")
    await advance(store, deps, "dsb-agenturen")
    await approve(store, "dsb-agenturen", "beispiel-vertrieb.de", "letter", "johannes")
    return { store, lead: () => leads.get("beispiel-vertrieb.de")! }
  }

  it("lehnt ab, wenn Jev personenbezogene Daten für wahrscheinlich hält", async () => {
    const contacts: unknown[] = []
    const { deps, uploads } = fakeDeps({ async privacyScore(c) { contacts.push(c); return { personal: 0.62, choice: "personal", model: "jev-latest" } } })
    const { store, lead } = await toLetterApproved(deps)
    await advance(store, deps, "dsb-agenturen")
    expect(uploads).toEqual([])
    expect(lead()).toMatchObject({ state: "rejected" })
    expect(lead().state_reason).toMatch(/62 %/)
    expect(contacts[0]).toMatchObject({ address: expect.arrayContaining(["Geschäftsführung"]), domain: "beispiel-vertrieb.de" })
  })

  it("versendet nichts, wenn Jev nicht antwortet, und versucht es im nächsten Lauf erneut", async () => {
    const { deps, uploads } = fakeDeps({ async privacyScore() { throw new Error("TYPESAFE_API_KEY fehlt") } })
    const { store, lead } = await toLetterApproved(deps)
    await advance(store, deps, "dsb-agenturen")
    expect(uploads).toEqual([])
    expect(lead()).toMatchObject({ state: "failed", resume_state: "letter_approved" })
  })

  it("liest die Antwort von Jev wie der Model Router", async () => {
    const reply = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 })
    const contact = { company: "Beispiel GmbH", address: ["Beispiel GmbH", "Geschäftsführung"], domain: "beispiel.de" }
    expect((await jevPrivacyScore(contact, { key: "k", fetcher: reply({ answers: { privacy: { choice: "company", probabilities: { company: 0.9, personal: 0.1 } } } }) })).personal).toBeCloseTo(0.1)
    expect((await jevPrivacyScore(contact, { key: "k", fetcher: reply({ answers: { privacy: { choice: "company", confidence: 0.8 } } }) })).personal).toBeCloseTo(0.1)
    expect((await jevPrivacyScore(contact, { key: "k", fetcher: reply({ answers: { privacy: { choice: "personal", confidence: 0.2 } } }) })).personal).toBeCloseTo(0.6)
    await expect(jevPrivacyScore(contact, { key: "k", fetcher: async () => new Response("", { status: 503 }) })).rejects.toThrow(/503/)
  })
})
