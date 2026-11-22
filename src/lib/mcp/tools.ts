import { z } from "zod"

export const CAMPAIGN_STATUSES = ["active", "paused", "closed"] as const
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 100

/** Eingabe von letterflow_list_campaigns (als Form für registerTool). */
export const listCampaignsInput = {
  status: z.enum(CAMPAIGN_STATUSES).optional().describe("Nur Kampagnen mit diesem Status."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Höchstzahl Kampagnen (1–${MAX_LIMIT}, Standard ${DEFAULT_LIMIT}).`),
}
export const listCampaignsInputSchema = z.object(listCampaignsInput)
export type ListCampaignsInput = z.infer<typeof listCampaignsInputSchema>

/** Was die Abfrage liefert; Felder wie letter und interest_balancing_ref kommen nie in die Ausgabe. */
export type CampaignRow = {
  key: string
  title: string
  offer: string
  segment: string
  status: string
  counts: Record<string, number>
  [extra: string]: unknown
}

export type PublicCampaign = Pick<CampaignRow, "key" | "title" | "offer" | "segment" | "status" | "counts">

/** Ausgabe-Whitelist: genau diese Felder, nie `...row`. */
export function toPublicCampaign(row: CampaignRow): PublicCampaign {
  const counts: Record<string, number> = {}
  for (const [state, n] of Object.entries(row.counts ?? {})) if (typeof n === "number") counts[state] = n
  return { key: row.key, title: row.title, offer: row.offer, segment: row.segment, status: row.status, counts }
}

export async function listCampaignsTool(input: ListCampaignsInput, load: () => Promise<CampaignRow[]>) {
  const rows = await load()
  const filtered = input.status ? rows.filter((row) => row.status === input.status) : rows
  const campaigns = filtered.slice(0, input.limit ?? DEFAULT_LIMIT).map(toPublicCampaign)
  return { campaigns }
}

/** Eingabe von letterflow_get_status. */
export const getStatusInput = {
  campaign: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).describe("Kampagnenschlüssel."),
  domain: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/).optional().describe("Domain eines Leads; ohne Angabe wird die Kampagnenliste geliefert."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Nur Kampagnenliste: Höchstzahl Leads (1–${MAX_LIMIT}, Standard ${DEFAULT_LIMIT}).`),
}
export const getStatusInputSchema = z.object(getStatusInput)
export type GetStatusInput = z.infer<typeof getStatusInputSchema>

/** Zeile der Lead-Übersicht; weitere Felder (Slug, id, …) werden nie ausgegeben. */
export type LeadStatusRow = {
  company: string
  domain: string
  state: string
  state_reason: string | null
  latest_revision: number | null
  approved_revision: number | null
  evidence_count: number
  letter_status: string | null
  updated_at: Date | string
  [extra: string]: unknown
}

export type PublicLeadStatus = {
  company: string
  domain: string
  state: string
  state_reason: string | null
  latest_revision: number | null
  approved_revision: number | null
  evidence_count: number
  letter_status: string | null
  updated_at: string
}

/** Zustände, in denen ein Mensch freigeben muss (wie STAGE_FOR_STATE in approvals.ts). */
const HUMAN_APPROVAL_STATES = new Set(["checked", "page_ready", "letter_ready"])

export function toPublicLeadStatus(row: LeadStatusRow): PublicLeadStatus {
  const updated = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)
  return {
    company: row.company,
    domain: row.domain,
    state: row.state,
    state_reason: row.state_reason ?? null,
    latest_revision: row.latest_revision ?? null,
    approved_revision: row.approved_revision ?? null,
    evidence_count: Number(row.evidence_count) || 0,
    letter_status: row.letter_status ?? null,
    updated_at: Number.isNaN(updated.getTime()) ? "" : updated.toISOString(),
  }
}

export type GetStatusLoaders = {
  listCampaigns: () => Promise<CampaignRow[]>
  campaignLeads: (key: string) => Promise<LeadStatusRow[]>
}

export type GetStatusResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string }

/** Nur lesend: ausschließlich die beiden Loader, keine Zustandsänderung, kein Provider. */
export async function getStatusTool(input: GetStatusInput, loaders: GetStatusLoaders): Promise<GetStatusResult> {
  const campaigns = await loaders.listCampaigns()
  if (!campaigns.some((c) => c.key === input.campaign)) return { ok: false, message: "Unbekannte Kampagne." }
  const leads = await loaders.campaignLeads(input.campaign)
  if (input.domain !== undefined) {
    const domain = input.domain.toLowerCase()
    const row = leads.find((l) => String(l.domain).toLowerCase() === domain)
    if (!row) return { ok: false, message: "Unbekannte Domain in dieser Kampagne." }
    const lead = toPublicLeadStatus(row)
    return { ok: true, data: { campaign: input.campaign, lead: { ...lead, requires_human_approval: HUMAN_APPROVAL_STATES.has(lead.state) } } }
  }
  const limit = input.limit ?? DEFAULT_LIMIT
  return {
    ok: true,
    data: { campaign: input.campaign, total: leads.length, returned: Math.min(limit, leads.length), leads: leads.slice(0, limit).map(toPublicLeadStatus) },
  }
}
