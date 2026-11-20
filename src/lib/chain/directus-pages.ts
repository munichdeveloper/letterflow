import { randomBytes } from "node:crypto"
import type { Seed, SeedPage } from "@/lib/acq/pipeline"

/**
 * Seiten und Schlüssel in Directus anlegen (nur serverseitig verwenden, braucht das Setup-Token).
 * Collections, Felder und Rechte legt die Website an; hier entstehen nur Seiten und Schlüssel.
 */

export const LANDING_PATH = "/fuer"
export const LANDING_KEY_PARAM = "k"
const SEED_PURPOSES = ["brief", "test"] as const

export type DirectusDeps = {
  url: string
  collection: string
  siteUrl: string
  token: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

export function landingOffer(value: unknown): "saas" | "managed" | "dsb" {
  return value === "managed" || value === "dsb" ? value : "saas"
}

export function isValidLandingSlug(slug: string) {
  return slug.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

export function isValidLandingKey(key: unknown): key is string {
  return typeof key === "string" && /^[A-Za-z0-9_-]{12,64}$/.test(key)
}

export function landingPageUrl(siteUrl: string, slug: string, key: string) {
  return `${siteUrl}${LANDING_PATH}/${slug}?${LANDING_KEY_PARAM}=${encodeURIComponent(key)}`
}

function assertDeps(deps: DirectusDeps) {
  if (!deps.siteUrl?.trim()) throw new Error("Website-URL fehlt: Bitte unter „Systeme“ bei Directus eintragen.")
  if (!deps.token?.trim()) throw new Error("Umgebungsvariable DIRECTUS_SETUP_TOKEN fehlt.")
  if (!deps.url?.trim()) throw new Error("Directus-URL fehlt: Bitte unter „Systeme“ bei Directus eintragen.")
}

async function api(deps: DirectusDeps, method: string, route: string, body?: unknown): Promise<{ status: number; data: any }> {
  const base = deps.url.replace(/\/$/, "")
  const res = await deps.fetch(`${base}${route}`, {
    method,
    headers: { Authorization: `Bearer ${deps.token.trim()}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = {}
  }
  // 403/404 on a GET means "does not exist" (Directus answers 403 for unknown collections); writes must succeed
  if (!res.ok && !(method === "GET" && (res.status === 403 || res.status === 404))) {
    // Never include the request headers (token) in the message.
    throw new Error(`Directus ${method} ${route}: HTTP ${res.status} ${JSON.stringify(json.errors ?? "").slice(0, 300)}`)
  }
  return { status: res.status, data: json.data }
}

/** The seed also carries the letter of each page; that part never goes to Directus. */
function pageFields(entry: SeedPage): Omit<SeedPage, "letter"> {
  const { letter: _letter, ...fields } = entry
  return fields
}

/** Seite anlegen oder Texte aktualisieren, fehlende Schlüssel „brief“ und „test“ anlegen. */
export async function setupPages(seed: Seed, deps: DirectusDeps): Promise<void> {
  assertDeps(deps)
  const pages = deps.collection
  const keys = `${deps.collection}_keys`
  for (const raw of seed.pages) {
    const entry = pageFields(raw)
    if (!isValidLandingSlug(entry.slug)) throw new Error(`Ungültiger Slug: ${entry.slug}`)
    const { data: found } = await api(deps, "GET", `/items/${pages}?filter[slug][_eq]=${encodeURIComponent(entry.slug)}&fields=id&limit=1`)
    let pageId: string | number | undefined = found?.[0]?.id
    if (pageId === undefined) {
      const { data } = await api(deps, "POST", `/items/${pages}`, { ...entry, offer: landingOffer(entry.offer), campaign: seed.campaign, status: "published" })
      pageId = data.id as string | number
    } else {
      // Texts only: status, campaign and keys stay as they are, so printed QR codes keep working.
      const { slug: _slug, ...texts } = entry
      await api(deps, "PATCH", `/items/${pages}/${pageId}`, { ...texts, offer: landingOffer(entry.offer) })
    }
    const { data: existing } = await api(deps, "GET", `/items/${keys}?filter[landingpage][_eq]=${pageId}&fields=access_key,purpose&limit=50`)
    for (const purpose of SEED_PURPOSES) {
      let key = existing?.find((row: any) => row.purpose === purpose)?.access_key
      if (!key) {
        // 16 random bytes, URL-safe: short enough for a small QR code, far too long to guess.
        key = randomBytes(16).toString("base64url")
        await api(deps, "POST", `/items/${keys}`, { landingpage: pageId, access_key: key, purpose, active: true })
      }
      if (!isValidLandingKey(key)) throw new Error(`${entry.slug}: Schlüssel „${purpose}“ in Directus ist kürzer als 12 Zeichen`)
    }
  }
}

/** slug → URL mit dem aktiven „brief“-Schlüssel, nur für die übergebenen Slugs. */
export async function briefUrls(slugs: string[], deps: DirectusDeps): Promise<Map<string, string>> {
  assertDeps(deps)
  const wanted = new Set(slugs)
  const urls = new Map<string, string>()
  if (!wanted.size) return urls
  const params = new URLSearchParams({ "filter[purpose][_eq]": "brief", "filter[active][_eq]": "true", fields: "access_key,landingpage.slug", limit: "-1" })
  const { data } = await api(deps, "GET", `/items/${deps.collection}_keys?${params.toString()}`)
  for (const row of data ?? []) {
    const slug = row.landingpage?.slug
    if (wanted.has(slug) && isValidLandingSlug(slug) && isValidLandingKey(row.access_key) && !urls.has(slug)) {
      urls.set(slug, landingPageUrl(deps.siteUrl, slug, row.access_key))
    }
  }
  return urls
}
