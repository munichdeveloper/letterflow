import "server-only"
import { sha256 } from "@/lib/acq/pipeline"
import { db } from "@/lib/server/db"

/**
 * Gebaute Brief-PDFs (acq.letter_pdfs). Gespeichert wird genau das gebaute PDF, denn die Brieffreigabe
 * bindet sich an seinen SHA-256 (acq.leads.letter_pdf_sha256); ein neu gebautes PDF hätte einen anderen Hash.
 * Die Tabelle erlaubt nur select und insert: ein gespeichertes PDF ändert sich nie.
 */

const SHA256 = /^[0-9a-f]{64}$/

/** Speichert das PDF unverändert und liefert seinen SHA-256. Dasselbe PDF erneut zu speichern ändert nichts. */
export async function saveLetterPdf(leadId: string, pdf: Uint8Array, by: string) {
  if (!pdf.length) throw new Error("Leeres Brief-PDF.")
  const hash = sha256(pdf)
  await db()`
    insert into acq.letter_pdfs (lead_id, sha256, pdf, created_by)
    values (${leadId}, ${hash}, ${new Uint8Array(pdf)}, ${by})
    on conflict (lead_id, sha256) do nothing`
  return hash
}

/** Genau das PDF mit diesem Hash oder undefined. */
export async function readLetterPdf(leadId: string, hash: string): Promise<Uint8Array | undefined> {
  if (!SHA256.test(hash)) return undefined
  const [row] = await db()<{ pdf: Uint8Array }[]>`
    select pdf from acq.letter_pdfs where lead_id = ${leadId} and sha256 = ${hash}`
  if (!row) return undefined
  const pdf = new Uint8Array(row.pdf)
  if (sha256(pdf) !== hash) throw new Error(`Gespeichertes Brief-PDF ${hash.slice(0, 12)}… passt nicht zu seinem Hash.`)
  return pdf
}
