import type { Sql } from "postgres"
import type { Evidence, LeadCandidate, LeadState } from "./contracts"

/** Zugriff auf das Schema acq im Business OS (Login mit Rolle bos_automation). Zustände nur über acq.transition. */

export type CampaignRow = { id: string; key: string; title: string; offer: string; segment: string; letter: Record<string, unknown>; interest_balancing_ref: string | null; status: string }
export type LeadRow = {
  id: string; campaign_id: string; domain: string; company: string; legal_form: string; street: string; postal_code: string; city: string
  slug: string | null; state: LeadState; state_reason: string | null; resume_state: LeadState | null
  approved_revision: number | null; letter_pdf_sha256: string | null; approved_pdf_sha256: string | null
}
export type ProposalRow = { id: string; lead_id: string; revision: number; content: any; content_sha256: string; created_by: string }

export interface AcqStore {
  campaign(key: string): Promise<CampaignRow>
  insertLead(campaignId: string, lead: LeadCandidate, source: string): Promise<{ lead: LeadRow; inserted: boolean }>
  leads(campaignId: string, states?: LeadState[]): Promise<LeadRow[]>
  leadByDomain(campaignId: string, domain: string): Promise<LeadRow | undefined>
  evidence(leadId: string): Promise<Pick<Evidence, "ref" | "kind">[]>
  latestProposal(leadId: string): Promise<ProposalRow | undefined>
  addProposal(leadId: string, content: unknown, sha256: string, actor: string): Promise<ProposalRow>
  setSlug(leadId: string, slug: string): Promise<void>
  suppress(domain: string, company: string, reason: string, source: string): Promise<void>
  transition(leadId: string, to: LeadState, actor: string, reason?: string | null, detail?: Record<string, unknown>): Promise<LeadRow>
}

export function sqlAcqStore(sql: Sql): AcqStore {
  return {
    async campaign(key) {
      const [row] = await sql<CampaignRow[]>`select * from acq.campaigns where key = ${key}`
      if (!row) throw new Error(`Kampagne „${key}“ gibt es nicht (acq.campaigns).`)
      return row
    },
    async insertLead(campaignId, l, source) {
      return sql.begin(async (tx) => {
        const inserted = await tx<LeadRow[]>`
          insert into acq.leads (campaign_id, domain, company, legal_form, street, postal_code, city, niche, region, fit_reason, source)
          values (${campaignId}, ${l.domain}, ${l.company}, ${l.legalForm}, ${l.street}, ${l.postalCode}, ${l.city}, ${l.niche ?? null}, ${l.region ?? null}, ${l.fitReason}, ${source})
          on conflict (campaign_id, domain) do nothing
          returning *`
        if (!inserted.length) {
          const [existing] = await tx<LeadRow[]>`select * from acq.leads where campaign_id = ${campaignId} and domain = ${l.domain}`
          return { lead: existing, inserted: false }
        }
        const lead = inserted[0]
        for (const e of l.evidence) {
          await tx`insert into acq.evidence (lead_id, ref, kind, claim, source_url, quote, retrieved_at)
                   values (${lead.id}, ${e.ref}, ${e.kind}, ${e.claim}, ${e.sourceUrl}, ${e.quote ?? null}, ${e.retrievedAt})`
        }
        return { lead, inserted: true }
      })
    },
    async leads(campaignId, states) {
      return states
        ? sql<LeadRow[]>`select * from acq.leads where campaign_id = ${campaignId} and state = any(${states}) order by created_at`
        : sql<LeadRow[]>`select * from acq.leads where campaign_id = ${campaignId} order by created_at`
    },
    async leadByDomain(campaignId, domain) {
      const [row] = await sql<LeadRow[]>`select * from acq.leads where campaign_id = ${campaignId} and domain = ${domain}`
      return row
    },
    async evidence(leadId) {
      return sql<Pick<Evidence, "ref" | "kind">[]>`select ref, kind from acq.evidence where lead_id = ${leadId}`
    },
    async latestProposal(leadId) {
      const [row] = await sql<ProposalRow[]>`select * from acq.proposals where lead_id = ${leadId} order by revision desc limit 1`
      return row
    },
    async addProposal(leadId, content, sha256, actor) {
      const [row] = await sql<ProposalRow[]>`select * from acq.add_proposal(${leadId}, ${sql.json(content as any)}, ${sha256}, ${actor})`
      return row
    },
    async setSlug(leadId, slug) {
      await sql`update acq.leads set slug = ${slug}, updated_at = now() where id = ${leadId} and (slug is null or slug = ${slug})`
    },
    async suppress(domain, company, reason, source) {
      await sql`insert into acq.suppression (domain, company, reason, source) values (${domain}, ${company}, ${reason}, ${source}) on conflict do nothing`
    },
    async transition(leadId, to, actor, reason = null, detail = {}) {
      const [row] = await sql<LeadRow[]>`select * from acq.transition(${leadId}, ${to}, ${actor}, ${reason}, ${sql.json(detail as any)})`
      return row
    },
  }
}
