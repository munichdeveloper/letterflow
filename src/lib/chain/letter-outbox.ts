import { createHash } from "node:crypto"
import type { Sql } from "postgres"
import { PingenError, type PingenClient } from "./pingen"

export type LetterStatus = "queued" | "uploading" | "created" | "submitted" | "sent" | "failed" | "unclear" | "cancelled"
export type LetterRow = {
  id: string
  campaign: string
  landing_slug: string
  company: string
  environment: "sandbox" | "production"
  idempotency_key: string
  pdf_sha256: string
  status: LetterStatus
  provider_letter_id: string | null
  provider_status: string | null
  attempts: number
  last_error: string | null
}
export type RecordFields = { providerLetterId?: string; providerStatus?: string; priceValue?: number; priceCurrency?: string; error?: string }

export interface OutboxStore {
  claim(campaign: string, slug: string, company: string, environment: "sandbox", pdfSha256: string): Promise<{ claimed: boolean; letter: LetterRow }>
  record(id: string, status: LetterStatus, fields?: RecordFields): Promise<LetterRow>
  list(campaign: string, environment: "sandbox"): Promise<LetterRow[]>
}

export function sha256(data: Uint8Array) {
  return createHash("sha256").update(data).digest("hex")
}

/** acq.claim_letter / acq.record_letter through a connection of role bos_automation. */
export function sqlOutboxStore(sql: Sql): OutboxStore {
  return {
    async claim(campaign, slug, company, environment, pdfSha256) {
      const [row] = await sql<{ claimed: boolean; letter: LetterRow }[]>`select claimed, letter from acq.claim_letter(${campaign}, ${slug}, ${company}, ${environment}, ${pdfSha256})`
      return row
    },
    async record(id, status, f = {}) {
      const [row] = await sql<{ letter: LetterRow }[]>`select acq.record_letter(${id}, ${status}, ${f.providerLetterId ?? null}, ${f.providerStatus ?? null}, ${f.priceValue ?? null}, ${f.priceCurrency ?? null}, ${f.error ?? null}) as letter`
      return row.letter
    },
    async list(campaign, environment) {
      return sql<LetterRow[]>`select * from acq.letters where campaign = ${campaign} and environment = ${environment} order by landing_slug`
    },
  }
}

export type UploadResult =
  | { slug: string; action: "created"; letter: LetterRow }
  | { slug: string; action: "skipped"; letter: LetterRow; pdfChanged: boolean }
  | { slug: string; action: "failed" | "unclear"; letter: LetterRow; error: string }

/**
 * A provider answer of 4xx (other than 408 and 429) means the letter was refused and not created:
 * safe to retry after fixing it. Anything else (network error, timeout, 5xx, 408, 429) may have
 * created the letter anyway, so the row becomes `unclear` and is never retried automatically.
 */
function definitelyNotCreated(error: unknown) {
  return error instanceof PingenError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
}

export async function uploadLetter({ store, pingen, campaign, slug, company, pdf }: { store: OutboxStore; pingen: PingenClient; campaign: string; slug: string; company: string; pdf: Uint8Array }): Promise<UploadResult> {
  const hash = sha256(pdf)
  const { claimed, letter } = await store.claim(campaign, slug, company, "sandbox", hash)
  if (!claimed) return { slug, action: "skipped", letter, pdfChanged: letter.pdf_sha256 !== hash }
  try {
    const created = await pingen.createDraftLetter(pdf, `${slug}.pdf`, letter.idempotency_key)
    const row = await store.record(letter.id, "created", { providerLetterId: created.id, providerStatus: created.status, priceValue: created.priceValue, priceCurrency: created.priceCurrency })
    return { slug, action: "created", letter: row }
  } catch (error) {
    const message = error instanceof Error ? `${error.message}${error instanceof PingenError && error.detail ? `: ${error.detail}` : ""}` : String(error)
    const status = definitelyNotCreated(error) ? "failed" : "unclear"
    const row = await store.record(letter.id, status, { error: message.slice(0, 2000) })
    return { slug, action: status, letter: row, error: message }
  }
}

/** Hands created sandbox letters to Pingen's (staging) dispatch. Never touches other states. */
export async function submitSandboxLetter({ store, pingen, letter }: { store: OutboxStore; pingen: PingenClient; letter: LetterRow }) {
  if (letter.environment !== "sandbox" || letter.status !== "created" || !letter.provider_letter_id) return letter
  const sent = await pingen.sendLetter(letter.provider_letter_id)
  return store.record(letter.id, "submitted", { providerStatus: sent.status })
}

/** Reads the provider status; a letter Pingen reports as sent becomes `sent`. */
export async function syncLetter({ store, pingen, letter }: { store: OutboxStore; pingen: PingenClient; letter: LetterRow }) {
  if (!letter.provider_letter_id || ["created", "submitted"].includes(letter.status)) return letter
  const current = await pingen.getLetter(letter.provider_letter_id)
  const status: LetterStatus = current.status === "sent" ? "sent" : letter.status
  return store.record(letter.id, status, { providerStatus: current.status, priceValue: current.priceValue, priceCurrency: current.priceCurrency })
}
