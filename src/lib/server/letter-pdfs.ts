import "server-only"
import { createHash } from "node:crypto"
import { db } from "@/lib/server/db"

/** Gebaute Brief-PDFs (acq.letter_pdfs). Die Bytes bleiben unverändert: die Brieffreigabe bindet sich an ihren SHA-256. */

/** Speichert das PDF unverändert und liefert den SHA-256 der Bytes. Dasselbe PDF zweimal zu speichern ist harmlos. */
export async function saveLetterPdf(leadId: string, pdf: Uint8Array, by: string) {
  const bytes = Buffer.from(pdf)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  await db()`
    insert into acq.letter_pdfs (lead_id, sha256, pdf, created_by)
    values (${leadId}, ${sha256}, ${bytes}, ${by})
    on conflict (lead_id, sha256) do nothing`
  return sha256
}

/** Genau das PDF mit diesem Hash, oder undefined. */
export async function readLetterPdf(leadId: string, sha256: string) {
  const [row] = await db()<{ pdf: Buffer }[]>`
    select pdf from acq.letter_pdfs where lead_id = ${leadId} and sha256 = ${sha256}`
  return row ? new Uint8Array(row.pdf) : undefined
}
