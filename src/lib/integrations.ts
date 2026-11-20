import { z } from "zod"
import { jevPrivacyScore, PRIVACY_MAX } from "@/lib/acq/privacy"

/**
 * Angebundene Systeme der Briefakquise. Nicht geheime Einstellungen liegen in acq.integrations,
 * Secrets ausschließlich in Umgebungsvariablen (das Repo ist öffentlich, die Tabelle lehnt Secrets ab).
 */

export const INTEGRATION_KEYS = ["directus", "pingen", "jev"] as const
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number]

const nonSecret = (value: Record<string, unknown>) =>
  !Object.keys(value).some((k) => /secret|token|password|api_?key/i.test(k))

export const IntegrationConfigSchemas = {
  directus: z
    .object({
      url: z.string().url().refine((u) => u.startsWith("https://"), "Directus-URL muss https sein").optional(),
      collection: z.string().regex(/^[a-z0-9_]{2,60}$/).default("landingpages"),
    })
    .strict(),
  pingen: z
    .object({
      environment: z.enum(["staging", "production"]).default("staging"),
      organisationId: z.string().uuid().optional(),
    })
    .strict(),
  jev: z
    .object({
      model: z.string().min(2).max(60).default("jev-latest"),
      privacyMax: z.number().min(0.05).max(0.9).default(PRIVACY_MAX),
    })
    .strict(),
} satisfies Record<IntegrationKey, z.ZodType>

export type IntegrationConfig = { [K in IntegrationKey]: z.infer<(typeof IntegrationConfigSchemas)[K]> }

export const INTEGRATIONS: Record<IntegrationKey, { title: string; purpose: string; secrets: string[] }> = {
  directus: { title: "Directus", purpose: "Landingpages je Lead anlegen und aktualisieren", secrets: ["DIRECTUS_SETUP_TOKEN"] },
  pingen: { title: "Pingen", purpose: "Briefe drucken und versenden", secrets: ["PINGEN_CLIENT_ID", "PINGEN_CLIENT_SECRET"] },
  jev: { title: "Jev (TypeSafe)", purpose: "Letzte Prüfung vor dem Versand: Ist die Anschrift personenbezogen?", secrets: ["TYPESAFE_API_KEY"] },
}

export function parseIntegrationConfig<K extends IntegrationKey>(key: K, value: unknown): IntegrationConfig[K] {
  const parsed = IntegrationConfigSchemas[key].parse(value) as IntegrationConfig[K]
  if (!nonSecret(parsed as Record<string, unknown>)) throw new Error("Secrets gehören in Umgebungsvariablen, nicht in die Einstellungen.")
  return parsed
}

/** Pingen Produktion nur mit unterschriebenem AV-Vertrag. Der Versand selbst bleibt zusätzlich im Versandcode gesperrt. */
export function assertPingenAllowed(config: IntegrationConfig["pingen"], avvSignedAt: string | null) {
  if (config.environment === "production" && !avvSignedAt) {
    throw new Error("Pingen Produktion ist gesperrt, bis der AV-Vertrag mit Pingen unterschrieben ist.")
  }
}

export type TestResult = { ok: boolean; message: string }
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>
type Env = Record<string, string | undefined>

export function missingSecrets(key: IntegrationKey, env: Env = process.env) {
  return INTEGRATIONS[key].secrets.filter((name) => !env[name]?.trim())
}

const PINGEN_IDENTITY = { staging: "https://identity-staging.pingen.com", production: "https://identity.pingen.com" }

/** Verbindungstest je System. Liest nur, legt nichts an und versendet nichts. */
export async function testIntegration<K extends IntegrationKey>(
  key: K,
  config: IntegrationConfig[K],
  options: { env?: Env; fetcher?: Fetcher; avvSignedAt?: string | null } = {},
): Promise<TestResult> {
  const env = options.env ?? process.env
  const fetcher = options.fetcher ?? fetch
  const missing = missingSecrets(key, env)
  if (missing.length) return { ok: false, message: `Fehlt in der Umgebung: ${missing.join(", ")}` }
  try {
    if (key === "directus") {
      const c = config as IntegrationConfig["directus"]
      if (!c.url) return { ok: false, message: "Directus-URL ist nicht eingetragen." }
      const base = c.url.replace(/\/$/, "")
      const res = await fetcher(`${base}/collections/${c.collection}`, {
        headers: { authorization: `Bearer ${env.DIRECTUS_SETUP_TOKEN!.trim()}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.status === 401 || res.status === 403) return { ok: false, message: `Token wird abgelehnt (HTTP ${res.status}).` }
      if (res.status === 404) return { ok: false, message: `Collection „${c.collection}“ gibt es nicht.` }
      if (!res.ok) return { ok: false, message: `Directus antwortet mit HTTP ${res.status}.` }
      return { ok: true, message: `Verbunden, Collection „${c.collection}“ ist lesbar.` }
    }
    if (key === "pingen") {
      const c = config as IntegrationConfig["pingen"]
      assertPingenAllowed(c, options.avvSignedAt ?? null)
      if (!c.organisationId) return { ok: false, message: "Organisations-ID ist nicht eingetragen." }
      const res = await fetcher(`${PINGEN_IDENTITY[c.environment]}/auth/access-tokens`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: "letter",
          client_id: env.PINGEN_CLIENT_ID!.trim(),
          client_secret: env.PINGEN_CLIENT_SECRET!.trim(),
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return { ok: false, message: `Anmeldung bei Pingen (${c.environment}) fehlgeschlagen: HTTP ${res.status}.` }
      return { ok: true, message: `Anmeldung bei Pingen (${c.environment}) klappt.` }
    }
    const c = config as IntegrationConfig["jev"]
    const score = await jevPrivacyScore(
      { company: "Beispiel Vertrieb GmbH", address: ["Beispiel Vertrieb GmbH", "Geschäftsführung", "Musterweg 1", "80331 München"], domain: "beispiel-vertrieb.de" },
      { key: env.TYPESAFE_API_KEY!.trim(), model: c.model, fetcher },
    )
    return { ok: true, message: `Jev antwortet (${c.model}): Beispielanschrift zu ${Math.round(score.personal * 100)} % personenbezogen.` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
