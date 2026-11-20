import "server-only"
import { randomUUID } from "node:crypto"
import type { Sql } from "postgres"
import { advance, type ChainDeps, type UploadOutcome } from "@/lib/acq/pipeline"
import { jevPrivacyScore } from "@/lib/acq/privacy"
import { sqlAcqStore } from "@/lib/acq/store"
import { LetterSettingsSchema } from "@/lib/campaigns"
import { briefUrls, setupPages, type DirectusDeps } from "@/lib/chain/directus-pages"
import { sqlOutboxStore, syncLetter, uploadLetter, type OutboxStore } from "@/lib/chain/letter-outbox"
import { buildLetterPdf } from "@/lib/chain/letter-pdf"
import { createPingenClient, pingenConfig, type PingenClient } from "@/lib/chain/pingen"
import { INTEGRATION_KEYS, parseIntegrationConfig, type IntegrationConfig } from "@/lib/integrations"
import { readLetterPdf, saveLetterPdf } from "@/lib/server/letter-pdfs"

/**
 * Umsetzung von ChainDeps aus den Modulen dieses Repos: Seiten in Directus, Brief-PDF (pdfkit, acq.letter_pdfs),
 * Outbox und Pingen (nur Sandbox/Staging) und die Jev-Prüfung. Freigaben gibt es hier nicht, die gibt nur ein Mensch.
 */

export const CHAIN_ACTOR = "system:acq"

type Env = Record<string, string | undefined>
export type LeadRef = { id: string; letter_pdf_sha256: string | null }

/** Alles, was chainDeps nach außen braucht. Tests ersetzen einzelne Teile durch Fälschungen. */
export type ChainModules = {
  setupPages: typeof setupPages
  briefUrls: typeof briefUrls
  buildLetterPdf: typeof buildLetterPdf
  saveLetterPdf: typeof saveLetterPdf
  readLetterPdf: typeof readLetterPdf
  jevPrivacyScore: typeof jevPrivacyScore
  uploadLetter: typeof uploadLetter
  syncLetter: typeof syncLetter
  /** Lead einer Kampagne zum Slug der Seite. */
  leadBySlug(campaign: string, slug: string): Promise<LeadRef | undefined>
  outbox: OutboxStore
  /** Pingen-Client, erst beim ersten Upload bzw. Abgleich angelegt. Nur Staging. */
  pingen(): PingenClient
  fetch: DirectusDeps["fetch"]
  now(): Date
}

function defaultModules(sql: Sql, integrations: IntegrationConfig, env: Env): ChainModules {
  let client: PingenClient | undefined
  return {
    setupPages,
    briefUrls,
    buildLetterPdf,
    saveLetterPdf,
    readLetterPdf,
    jevPrivacyScore,
    uploadLetter,
    syncLetter,
    async leadBySlug(campaign, slug) {
      const [row] = await sql<LeadRef[]>`
        select l.id, l.letter_pdf_sha256
        from acq.leads l join acq.campaigns c on c.id = l.campaign_id
        where c.key = ${campaign} and l.slug = ${slug}`
      return row
    },
    outbox: sqlOutboxStore(sql),
    pingen() {
      // pingenConfig und createPingenClient lehnen alles außer „staging“ ab.
      client ??= createPingenClient(pingenConfig(integrations.pingen, env))
      return client
    },
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
  }
}

export function chainDeps(
  sql: Sql,
  integrations: IntegrationConfig,
  env: Env = process.env,
  options: { log?: (line: string) => void; modules?: Partial<ChainModules> } = {},
): ChainDeps {
  const m: ChainModules = { ...defaultModules(sql, integrations, env), ...options.modules }
  const directus = (): DirectusDeps => ({
    url: integrations.directus.url ?? "",
    collection: integrations.directus.collection,
    siteUrl: integrations.directus.siteUrl ?? "",
    token: env.DIRECTUS_SETUP_TOKEN ?? "",
    fetch: m.fetch,
  })
  const assertStaging = () => {
    if (integrations.pingen.environment !== "staging") {
      throw new Error("Pingen: Echter Versand ist gesperrt, erlaubt ist nur die Umgebung „staging“.")
    }
  }
  const lead = async (campaign: string, slug: string) => {
    const row = await m.leadBySlug(campaign, slug)
    if (!row) throw new Error(`${slug}: kein Lead mit dieser Seite in Kampagne ${campaign}.`)
    return row
  }

  return {
    async setupPages(seed) {
      await m.setupPages(seed, directus())
    },

    async buildLetters(seed) {
      const letter = LetterSettingsSchema.parse(seed.letter)
      const urls = await m.briefUrls(seed.pages.map((p) => p.slug), directus())
      const missing = seed.pages.filter((p) => !urls.has(p.slug)).map((p) => p.slug)
      if (missing.length) {
        throw new Error(`Keine Brief-URL für ${missing.join(", ")}: In Directus fehlt die Seite oder ihr aktiver Schlüssel „brief“.`)
      }
      // Datum in Europe/Berlin: buildLetterPdf formatiert es in dieser Zeitzone.
      const date = m.now()
      const pdfs = new Map<string, Uint8Array>()
      for (const page of seed.pages) {
        const { id } = await lead(seed.campaign, page.slug)
        const pdf = await m.buildLetterPdf({ letter, page, url: urls.get(page.slug)!, date })
        await m.saveLetterPdf(id, pdf, CHAIN_ACTOR)
        pdfs.set(page.slug, pdf)
      }
      return pdfs
    },

    async readLetter(campaign, slug) {
      const row = await m.leadBySlug(campaign, slug)
      if (!row?.letter_pdf_sha256) return undefined
      return m.readLetterPdf(row.id, row.letter_pdf_sha256)
    },

    async upload(campaign, slug, company, pdf): Promise<UploadOutcome> {
      assertStaging()
      const result = await m.uploadLetter({ store: m.outbox, pingen: m.pingen(), campaign, slug, company, pdf })
      return { action: result.action, status: result.letter.status, error: "error" in result ? result.error : undefined }
    },

    async privacyScore(contact) {
      const key = env.TYPESAFE_API_KEY?.trim()
      if (!key) throw new Error("Umgebungsvariable TYPESAFE_API_KEY fehlt (Jev-Prüfung).")
      return m.jevPrivacyScore(contact, { key, model: integrations.jev.model })
    },

    async sync(campaign, slug) {
      assertStaging()
      const letter = (await m.outbox.list(campaign, "sandbox")).find((l) => l.landing_slug === slug)
      if (!letter) return undefined
      const row = await m.syncLetter({ store: m.outbox, pingen: m.pingen(), letter })
      return row.status
    },

    log: options.log ?? ((line) => console.log(line)),
  }
}

/** Einstellungen aller Systeme aus acq.integrations; fehlende Zeilen bekommen die Standardwerte. */
export async function loadIntegrations(sql: Sql): Promise<IntegrationConfig> {
  const rows = await sql<{ key: string; config: unknown }[]>`select key, config from acq.integrations`
  const byKey = new Map(rows.map((r) => [r.key, r.config]))
  return Object.fromEntries(INTEGRATION_KEYS.map((key) => [key, parseIntegrationConfig(key, byKey.get(key) ?? {})])) as IntegrationConfig
}

/** Nach dieser Zeit darf ein neuer Lauf eine liegengebliebene Markierung (abgebrochener Prozess) übernehmen. */
export const CHAIN_RUN_TTL_SECONDS = 30 * 60

/**
 * Treibt die Kette einer Kampagne voran. Läuft für diese Kampagne schon ein Lauf, startet kein zweiter.
 *
 * Die Sperre ist eine Zeile in acq.chain_runs (Kampagne, Lauf-ID, Ablaufzeit), atomar per insert ... on conflict
 * gesetzt und im finally wieder gelöscht, auch nach einem Fehler. Bewusst keine Advisory-Sperre: Die gilt nur,
 * solange eine Transaktion oder Verbindung offen bleibt. Eine Transaktion wäre während des ganzen Laufs (Directus,
 * PDF, Jev, Pingen) im Leerlauf und fiele einem idle_in_transaction_session_timeout zum Opfer. Eine reservierte
 * Verbindung (sql.reserve()) würde dem Pool (max: 3) je Lauf eine Verbindung entziehen, sodass bei drei
 * gleichzeitigen Läufen die Abfragen in advance auf keine freie Verbindung mehr warten (Deadlock). Die Markierung
 * braucht nur kurze Einzelabfragen.
 */
export async function runChain(sql: Sql, campaignKey: string, env: Env = process.env, log?: (line: string) => void) {
  const lines: string[] = []
  const write = (line: string) => {
    lines.push(line)
    log?.(line)
  }
  const runId = randomUUID()
  const [claimed] = await sql<{ run_id: string }[]>`
    insert into acq.chain_runs (campaign_key, run_id, expires_at)
    values (${campaignKey}, ${runId}, now() + ${CHAIN_RUN_TTL_SECONDS}::int * interval '1 second')
    on conflict (campaign_key) do update
      set run_id = excluded.run_id, started_at = now(), expires_at = excluded.expires_at
      where acq.chain_runs.expires_at <= now()
    returning run_id`
  if (!claimed) {
    write("Für diese Kampagne läuft schon ein Lauf. Bitte warten und dann die Seite neu laden.")
    return { ran: false, lines }
  }
  try {
    const integrations = await loadIntegrations(sql)
    await advance(sqlAcqStore(sql), chainDeps(sql, integrations, env, { log: write }), campaignKey, { privacyMax: integrations.jev.privacyMax })
    return { ran: true, lines }
  } finally {
    // Nur die eigene Markierung löschen: Nach Ablauf kann ein anderer Lauf sie übernommen haben.
    await sql`delete from acq.chain_runs where campaign_key = ${campaignKey} and run_id = ${runId}`
  }
}
