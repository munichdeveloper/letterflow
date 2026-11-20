import type { IntegrationConfig } from "@/lib/integrations"

export type PingenEnvironment = "staging" | "production"
export type PingenConfig = {
  environment: PingenEnvironment
  clientId: string
  clientSecret: string
  organisationId: string
  apiUrl?: string
  identityUrl?: string
}
export type PingenLetter = { id: string; status: string; pages?: number; priceValue?: number; priceCurrency?: string }

export class PingenError extends Error {
  constructor(message: string, readonly status: number, readonly detail?: string) {
    super(message)
  }
}

const HOSTS: Record<PingenEnvironment, { api: string; identity: string }> = {
  staging: { api: "https://api-staging.pingen.com", identity: "https://identity-staging.pingen.com" },
  production: { api: "https://api.pingen.com", identity: "https://identity.pingen.com" },
}

type Fetch = typeof fetch
type Env = Record<string, string | undefined>

/**
 * Baut die PingenConfig aus der gespeicherten Einstellung (acq.integrations, Schlüssel `pingen`)
 * und den Secrets aus der Umgebung. Die Meldungen nennen nur Namen, nie Werte.
 */
export function pingenConfig(integration: IntegrationConfig["pingen"], env: Env = process.env): PingenConfig {
  if (integration.environment !== "staging") {
    throw new Error("Pingen: Echter Versand ist gesperrt, erlaubt ist nur die Umgebung „staging“.")
  }
  const organisationId = integration.organisationId?.trim()
  if (!organisationId) throw new Error("Pingen: Organisations-ID ist nicht eingetragen.")
  const clientId = env.PINGEN_CLIENT_ID?.trim()
  const clientSecret = env.PINGEN_CLIENT_SECRET?.trim()
  const missing = [!clientId && "PINGEN_CLIENT_ID", !clientSecret && "PINGEN_CLIENT_SECRET"].filter(Boolean)
  if (missing.length) throw new Error(`Pingen: Fehlt in der Umgebung: ${missing.join(", ")}`)
  return { environment: integration.environment, clientId: clientId!, clientSecret: clientSecret!, organisationId }
}

function letterFrom(json: unknown): PingenLetter {
  const data = (json as { data?: { id?: string; attributes?: Record<string, unknown> } })?.data
  if (!data?.id) throw new PingenError("Pingen-Antwort ohne Brief-ID", 502)
  const a = data.attributes ?? {}
  return {
    id: data.id,
    status: typeof a.status === "string" ? a.status : "unknown",
    pages: typeof a.file_pages === "number" ? a.file_pages : undefined,
    priceValue: typeof a.price_value === "number" ? a.price_value : undefined,
    priceCurrency: typeof a.price_currency === "string" ? a.price_currency : undefined,
  }
}

export function createPingenClient(config: PingenConfig, fetchImpl: Fetch = fetch) {
  if (config.environment !== "staging") throw new Error("Pingen-Client: nur Staging erlaubt.")
  const api = (config.apiUrl ?? HOSTS[config.environment].api).replace(/\/$/, "")
  const identity = (config.identityUrl ?? HOSTS[config.environment].identity).replace(/\/$/, "")
  const letters = `${api}/organisations/${encodeURIComponent(config.organisationId)}/deliveries/letters`
  let token: { value: string; expires: number } | undefined

  async function accessToken() {
    if (token && token.expires > Date.now() + 30_000) return token.value
    const res = await fetchImpl(`${identity}/auth/access-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "letter", client_id: config.clientId, client_secret: config.clientSecret }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new PingenError(`Pingen-Anmeldung fehlgeschlagen (${res.status})`, res.status, await res.text().catch(() => undefined))
    const json = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!json.access_token) throw new PingenError("Pingen-Anmeldung ohne access_token", 502)
    token = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 }
    return token.value
  }

  async function call(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/vnd.api+json", ...(body ? { "Content-Type": "application/vnd.api+json" } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new PingenError(`Pingen ${method} ${new URL(url).pathname} → ${res.status}`, res.status, (await res.text().catch(() => "")).slice(0, 1000))
    return res.status === 204 ? undefined : res.json()
  }

  return {
    environment: config.environment,
    /** Meldet sich an (Token wird zwischengespeichert). Für die Verbindungsprüfung unter „Systeme“. */
    async authenticate(): Promise<void> {
      await accessToken()
    },
    /** Uploads the PDF and creates the letter as a draft (auto_send false): nothing is printed or mailed. */
    async createDraftLetter(pdf: Uint8Array, fileName: string, idempotencyKey: string): Promise<PingenLetter> {
      const upload = (await call("GET", `${api}/file-upload`)) as { data?: { attributes?: { url?: string; url_signature?: string } } }
      const target = upload?.data?.attributes
      if (!target?.url || !target.url_signature) throw new PingenError("Pingen gab keine Upload-URL zurück", 502)
      const put = await fetchImpl(target.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: pdf as BodyInit, signal: AbortSignal.timeout(60_000) })
      if (!put.ok) throw new PingenError(`PDF-Upload fehlgeschlagen (${put.status})`, put.status)
      const created = await call(
        "POST",
        letters,
        {
          data: { type: "letters", attributes: { file_original_name: fileName, file_url: target.url, file_url_signature: target.url_signature, address_position: "left", auto_send: false } },
        },
        { "Idempotency-Key": idempotencyKey },
      )
      return letterFrom(created)
    },
    async getLetter(id: string): Promise<PingenLetter> {
      return letterFrom(await call("GET", `${letters}/${encodeURIComponent(id)}`))
    },
    /** Staging only (the client refuses production at construction). */
    async sendLetter(id: string, options = { deliveryProduct: "cheap", printMode: "simplex", printSpectrum: "grayscale" }): Promise<PingenLetter> {
      return letterFrom(
        await call("PATCH", `${letters}/${encodeURIComponent(id)}/send`, {
          data: { id, type: "letters", attributes: { delivery_product: options.deliveryProduct, print_mode: options.printMode, print_spectrum: options.printSpectrum } },
        }),
      )
    },
  }
}
export type PingenClient = ReturnType<typeof createPingenClient>
