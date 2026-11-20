import { createHash } from "node:crypto"
import { LeadBatchSchema, ProposalBatchSchema, ProposalSchema, type Proposal } from "./contracts"
import { checkLead, checkProposal, letterAddress } from "./rules"
import { PRIVACY_MAX, type Contact, type PrivacyScore } from "./privacy"
import type { AcqStore, CampaignRow, LeadRow } from "./store"

/**
 * Die automatische Kette (ACQ-01/08). Der Agent liefert Leads und Seitenbeschreibungen als Dateien;
 * advance() treibt jeden Lead so weit, wie es ohne Mensch geht, und hält an jeder Freigabe an.
 * Jeder Schritt ist wiederholbar: Supabase hält den Zustand, nicht dieser Prozess.
 */

export const SYSTEM = "system:acq"

export type SeedPage = {
  slug: string
  company: string
  salutation: string
  headline: string
  intro: string
  observation: string
  points: string
  offer: string
  letter: { address: string[]; subject: string; body: string[] }
}
export type Seed = { campaign: string; letter: Record<string, unknown>; pages: SeedPage[] }

export type UploadOutcome = { action: "created" | "skipped" | "failed" | "unclear"; status: string; error?: string }

export interface ChainDeps {
  /** Seiten in Directus anlegen bzw. Texte aktualisieren (heute dsb-new: pnpm landing:setup --seed … --update). */
  setupPages(seed: Seed): Promise<void>
  /** Brief-PDFs bauen und zurückgeben (heute dsb-new: pnpm landing:letters). */
  buildLetters(seed: Seed): Promise<Map<string, Uint8Array>>
  /** Freigegebene PDF lesen, wie sie auf der Platte liegt. */
  readLetter(campaign: string, slug: string): Promise<Uint8Array | undefined>
  /** In die Versand-Outbox und zu Pingen (Sandbox) laden. */
  upload(campaign: string, slug: string, company: string, pdf: Uint8Array): Promise<UploadOutcome>
  /** Letzte Prüfung vor dem Versand: Jev schätzt, ob die Kontaktdaten personenbezogen sind. Wirft, wenn Jev nicht antwortet. */
  privacyScore(contact: Contact): Promise<PrivacyScore>
  /** Status beim Anbieter abgleichen; liefert den Outbox-Status. */
  sync(campaign: string, slug: string): Promise<string | undefined>
  log(line: string): void
}

export function sha256(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex")
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function proposalHash(proposal: Proposal) {
  return sha256(canonical(proposal))
}

// ---------------------------------------------------------------------------------------------
// Eingang vom Agenten

export async function importLeads(store: AcqStore, input: unknown, log: (line: string) => void) {
  const batch = LeadBatchSchema.parse(input)
  const campaign = await store.campaign(batch.campaign)
  if (campaign.status !== "active") throw new Error(`Kampagne ${campaign.key} ist ${campaign.status}.`)
  const summary = { checked: 0, rejected: 0, suppressed: 0, known: 0 }
  for (const candidate of batch.leads) {
    const { lead, inserted } = await store.insertLead(campaign.id, candidate, `agent:${batch.agent}`)
    if (!inserted) {
      summary.known++
      log(`= ${candidate.domain}: schon bekannt (${lead.state})`)
      continue
    }
    const verdict = checkLead(candidate)
    if (verdict.action === "suppress") {
      await store.suppress(candidate.domain, candidate.company, verdict.reasons.join("; "), `agent:${batch.agent}`)
      await store.transition(lead.id, "suppressed", SYSTEM, verdict.reasons.join("; "))
      summary.suppressed++
      log(`⛔ ${candidate.domain}: gesperrt – ${verdict.reasons.join("; ")}`)
    } else if (verdict.action === "reject") {
      await store.transition(lead.id, "rejected", SYSTEM, verdict.reasons.join("; "))
      summary.rejected++
      log(`✗ ${candidate.domain}: abgelehnt – ${verdict.reasons.join("; ")}`)
    } else {
      const row = await store.transition(lead.id, "checked", SYSTEM)
      if (row.state === "suppressed") {
        summary.suppressed++
        log(`⛔ ${candidate.domain}: steht auf der Sperrliste`)
      } else {
        summary.checked++
        log(`✓ ${candidate.domain}: geprüft, wartet auf Freigabe`)
      }
    }
  }
  return summary
}

export async function importProposals(store: AcqStore, input: unknown, log: (line: string) => void) {
  const batch = ProposalBatchSchema.parse(input)
  const campaign = await store.campaign(batch.campaign)
  const summary = { stored: 0, unchanged: 0, refused: 0 }
  for (const { domain, ...raw } of batch.proposals) {
    const proposal = ProposalSchema.parse(raw)
    const lead = await store.leadByDomain(campaign.id, domain)
    if (!lead) { summary.refused++; log(`✗ ${domain}: kein Lead in ${campaign.key}`); continue }
    if (!["approved", "researched", "page_ready", "page_approved", "letter_ready", "letter_approved"].includes(lead.state)) {
      summary.refused++
      log(`✗ ${domain}: Zustand ${lead.state} – erst nach Freigabe des Leads, vor dem Versand`)
      continue
    }
    if (lead.slug && lead.slug !== proposal.slug) { summary.refused++; log(`✗ ${domain}: Slug ist schon ${lead.slug}`); continue }
    const problems = checkProposal(proposal, await store.evidence(lead.id), campaign.offer)
    if (problems.length) { summary.refused++; log(`✗ ${domain}: ${problems.join(" | ")}`); continue }
    const before = await store.latestProposal(lead.id)
    await store.setSlug(lead.id, proposal.slug)
    const row = await store.addProposal(lead.id, proposal, proposalHash(proposal), `agent:${batch.agent}`)
    if (before && before.revision === row.revision) { summary.unchanged++; log(`= ${domain}: unverändert (Revision ${row.revision})`) }
    else { summary.stored++; log(`✓ ${domain}: Revision ${row.revision} gespeichert`) }
  }
  return summary
}

// ---------------------------------------------------------------------------------------------
// Kette vorantreiben

export function seedPage(campaign: CampaignRow, lead: LeadRow, proposal: Proposal): SeedPage {
  return {
    slug: proposal.slug,
    company: lead.company,
    salutation: "Sehr geehrte Damen und Herren,",
    headline: proposal.page.headline,
    intro: proposal.page.intro,
    observation: proposal.page.observations.map((o) => o.text).join("\n\n"),
    points: proposal.page.proposal.join("\n"),
    offer: proposal.page.offer ?? campaign.offer,
    letter: {
      address: letterAddress({ company: lead.company, street: lead.street, postalCode: lead.postal_code, city: lead.city }),
      subject: proposal.letter.subject,
      body: proposal.letter.body,
    },
  }
}

async function seedFor(store: AcqStore, campaign: CampaignRow, leads: LeadRow[], approvedOnly: boolean): Promise<Seed> {
  const pages: SeedPage[] = []
  for (const lead of leads) {
    const proposal = await store.latestProposal(lead.id)
    if (!proposal) throw new Error(`${lead.domain}: keine Seitenbeschreibung`)
    if (approvedOnly && proposal.revision !== lead.approved_revision) throw new Error(`${lead.domain}: freigegeben ist Revision ${lead.approved_revision}, neueste ist ${proposal.revision}`)
    pages.push(seedPage(campaign, lead, ProposalSchema.parse(proposal.content)))
  }
  return { campaign: campaign.key, letter: campaign.letter, pages }
}

export async function advance(store: AcqStore, deps: ChainDeps, campaignKey: string, options: { privacyMax?: number } = {}) {
  const privacyMax = options.privacyMax ?? PRIVACY_MAX
  const campaign = await store.campaign(campaignKey)
  if (campaign.status !== "active") throw new Error(`Kampagne ${campaign.key} ist ${campaign.status}.`)
  const fail = async (lead: LeadRow, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    await store.transition(lead.id, "failed", SYSTEM, message.slice(0, 500))
    deps.log(`✗ ${lead.domain}: ${message}`)
  }

  // 1. Seitenbeschreibung liegt vor → Seite in Directus
  const researched = await store.leads(campaign.id, ["researched"])
  if (researched.length) {
    try {
      await deps.setupPages(await seedFor(store, campaign, researched, false))
      for (const lead of researched) {
        const proposal = await store.latestProposal(lead.id)
        await store.transition(lead.id, "page_ready", SYSTEM, null, { revision: proposal!.revision })
        deps.log(`→ ${lead.domain}: Seite angelegt (Revision ${proposal!.revision}), wartet auf Freigabe`)
      }
    } catch (error) {
      for (const lead of researched) await fail(lead, error)
    }
  }

  // 2. Seite freigegeben → Brief-PDF
  const pageApproved = await store.leads(campaign.id, ["page_approved"])
  if (pageApproved.length) {
    try {
      const pdfs = await deps.buildLetters(await seedFor(store, campaign, pageApproved, true))
      for (const lead of pageApproved) {
        const pdf = pdfs.get(lead.slug!)
        if (!pdf) { await fail(lead, new Error("PDF wurde nicht erzeugt")); continue }
        await store.transition(lead.id, "letter_ready", SYSTEM, null, { pdf_sha256: sha256(pdf) })
        deps.log(`→ ${lead.domain}: Brief erzeugt, wartet auf Freigabe`)
      }
    } catch (error) {
      for (const lead of pageApproved) await fail(lead, error)
    }
  }

  // 3. Brief freigegeben → Jev-Prüfung → Outbox + Pingen (Sandbox). Nur genau das freigegebene PDF.
  for (const lead of await store.leads(campaign.id, ["letter_approved"])) {
    try {
      const pdf = await deps.readLetter(campaign.key, lead.slug!)
      if (!pdf || sha256(pdf) !== lead.approved_pdf_sha256) throw new Error("PDF auf der Platte ist nicht das freigegebene")
      const address = letterAddress({ company: lead.company, street: lead.street, postalCode: lead.postal_code, city: lead.city })
      const privacy = await deps.privacyScore({ company: lead.company, address, domain: lead.domain })
      const percent = Math.round(privacy.personal * 100)
      if (privacy.personal >= privacyMax) {
        await store.transition(lead.id, "rejected", SYSTEM, `Jev: personenbezogene Daten wahrscheinlich (${percent} %)`, { privacy })
        deps.log(`✗ ${lead.domain}: Jev hält die Kontaktdaten zu ${percent} % für personenbezogen, nicht versendet`)
        continue
      }
      const result = await deps.upload(campaign.key, lead.slug!, lead.company, pdf)
      if (result.action === "created" || result.action === "skipped") {
        await store.transition(lead.id, "queued", SYSTEM, null, { outbox_status: result.status, privacy })
        deps.log(`→ ${lead.domain}: Jev ${percent} % personenbezogen, in der Outbox (${result.status})`)
      } else {
        await fail(lead, new Error(`Upload ${result.action}: ${result.error ?? ""}`))
      }
    } catch (error) {
      await fail(lead, error)
    }
  }

  // 4. Status beim Anbieter
  for (const lead of await store.leads(campaign.id, ["queued"])) {
    try {
      const status = await deps.sync(campaign.key, lead.slug!)
      if (status === "sent") {
        await store.transition(lead.id, "sent", SYSTEM)
        deps.log(`✓ ${lead.domain}: versendet`)
      }
    } catch (error) {
      deps.log(`! ${lead.domain}: Statusabgleich fehlgeschlagen (${error instanceof Error ? error.message : error}), nächster Lauf versucht es erneut`)
    }
  }
}

/** Freigabe durch einen Menschen. Bindet sich an die neueste Revision bzw. das aktuelle PDF. */
export async function approve(store: AcqStore, campaignKey: string, domain: string, stage: "lead" | "page" | "letter", by: string) {
  const campaign = await store.campaign(campaignKey)
  const lead = await store.leadByDomain(campaign.id, domain)
  if (!lead) throw new Error(`${domain}: kein Lead in ${campaignKey}`)
  const actor = `human:${by}`
  if (stage === "lead") return store.transition(lead.id, "approved", actor)
  if (stage === "page") {
    const proposal = await store.latestProposal(lead.id)
    if (!proposal) throw new Error(`${domain}: keine Seitenbeschreibung`)
    return store.transition(lead.id, "page_approved", actor, null, { revision: proposal.revision })
  }
  return store.transition(lead.id, "letter_approved", actor, null, { pdf_sha256: lead.letter_pdf_sha256 })
}
