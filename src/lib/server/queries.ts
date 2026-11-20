import "server-only"
import type { CampaignInput } from "@/lib/campaigns"
import { assertPingenAllowed, INTEGRATION_KEYS, parseIntegrationConfig, type IntegrationKey, type TestResult } from "@/lib/integrations"
import { db } from "@/lib/server/db"

export type CampaignSummary = {
  key: string
  title: string
  offer: string
  segment: string
  status: string
  interest_balancing_ref: string | null
  letter: Record<string, unknown>
  counts: Record<string, number>
}

export async function listCampaigns() {
  return db()<CampaignSummary[]>`
    select c.key, c.title, c.offer, c.segment, c.status, c.interest_balancing_ref, c.letter,
           coalesce((select jsonb_object_agg(state, n) from (
              select l.state, count(*)::int as n from acq.leads l where l.campaign_id = c.id group by l.state) s), '{}'::jsonb) as counts
    from acq.campaigns c
    order by c.status = 'active' desc, c.created_at desc`
}

export async function getCampaign(key: string) {
  const [row] = await db()<CampaignSummary[]>`
    select c.key, c.title, c.offer, c.segment, c.status, c.interest_balancing_ref, c.letter, '{}'::jsonb as counts
    from acq.campaigns c where c.key = ${key}`
  return row
}

export type LeadOverviewRow = {
  id: string
  company: string
  domain: string
  slug: string | null
  state: string
  state_reason: string | null
  updated_at: Date
  latest_revision: number | null
  approved_revision: number | null
  evidence_count: number
  letter_status: string | null
}

export async function campaignLeads(key: string) {
  return db()<LeadOverviewRow[]>`
    select id, company, domain, slug, state, state_reason, updated_at, latest_revision, approved_revision,
           evidence_count::int as evidence_count, letter_status
    from acq.lead_overview where campaign = ${key} order by updated_at desc`
}

export async function createCampaign(input: CampaignInput) {
  const sql = db()
  const [row] = await sql<{ key: string }[]>`
    insert into acq.campaigns (key, title, offer, segment, letter, interest_balancing_ref, status)
    values (${input.key}, ${input.title}, ${input.offer}, ${input.segment}, ${sql.json(input.letter)}, ${input.interestBalancingRef}, ${input.status})
    on conflict (key) do nothing
    returning key`
  if (!row) throw new Error(`Eine Kampagne mit dem Schlüssel „${input.key}“ gibt es schon.`)
  return row.key
}

export async function updateCampaign(key: string, input: CampaignInput) {
  const sql = db()
  const [row] = await sql<{ key: string }[]>`
    update acq.campaigns set title = ${input.title}, offer = ${input.offer}, segment = ${input.segment},
      letter = ${sql.json(input.letter)}, interest_balancing_ref = ${input.interestBalancingRef}, status = ${input.status}
    where key = ${key} returning key`
  if (!row) throw new Error(`Kampagne „${key}“ gibt es nicht.`)
  return row.key
}

export type IntegrationRow = {
  key: IntegrationKey
  config: Record<string, unknown>
  avv_signed_at: string | null
  last_test_ok: boolean | null
  last_test_message: string | null
  last_test_at: Date | null
  updated_by: string
  updated_at: Date
}

export async function listIntegrations() {
  const rows = await db()<IntegrationRow[]>`
    select key, config, avv_signed_at::text, last_test_ok, last_test_message, last_test_at, updated_by, updated_at
    from acq.integrations`
  const byKey = new Map(rows.map((r) => [r.key, r]))
  return INTEGRATION_KEYS.map((key) => byKey.get(key) ?? null).map((row, i) => ({ key: INTEGRATION_KEYS[i], row }))
}

export async function getIntegration(key: IntegrationKey) {
  const [row] = await db()<IntegrationRow[]>`
    select key, config, avv_signed_at::text, last_test_ok, last_test_message, last_test_at, updated_by, updated_at
    from acq.integrations where key = ${key}`
  return row
}

export async function saveIntegration(key: IntegrationKey, rawConfig: unknown, avvSignedAt: string | null, actor: string) {
  const config = parseIntegrationConfig(key, rawConfig)
  if (key === "pingen") assertPingenAllowed(config as { environment: "staging" | "production" }, avvSignedAt)
  const sql = db()
  await sql`
    insert into acq.integrations (key, config, avv_signed_at, updated_by, updated_at)
    values (${key}, ${sql.json(config as Record<string, unknown>)}, ${avvSignedAt}, ${actor}, now())
    on conflict (key) do update set config = excluded.config, avv_signed_at = excluded.avv_signed_at,
      updated_by = excluded.updated_by, updated_at = now(), last_test_ok = null, last_test_message = null, last_test_at = null`
}

export async function recordIntegrationTest(key: IntegrationKey, result: TestResult) {
  await db()`update acq.integrations set last_test_ok = ${result.ok}, last_test_message = ${result.message.slice(0, 500)}, last_test_at = now()
             where key = ${key}`
}

export async function testDatabase(): Promise<TestResult> {
  try {
    const [row] = await db()<{ campaigns: number; leads: number }[]>`
      select (select count(*)::int from acq.campaigns) as campaigns, (select count(*)::int from acq.leads) as leads`
    return { ok: true, message: `Verbunden: ${row.campaigns} Kampagnen, ${row.leads} Leads.` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
