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
