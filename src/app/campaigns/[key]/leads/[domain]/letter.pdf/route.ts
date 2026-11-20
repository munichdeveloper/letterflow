import { readLetterPdf } from "@/lib/server/letter-pdfs"
import { leadLetterPdfRef } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/** Das Brief-PDF, an dessen SHA-256 (acq.leads.letter_pdf_sha256) die Brieffreigabe gebunden ist. Nur mit Login. */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string; domain: string }> }) {
  await requireUser()
  const { key, domain } = await params
  const lead = await leadLetterPdfRef(key, decodeURIComponent(domain))
  const pdf = lead?.letter_pdf_sha256 ? await readLetterPdf(lead.id, lead.letter_pdf_sha256) : undefined
  if (!pdf) return new Response("Kein Brief-PDF gespeichert.", { status: 404, headers: { "Cache-Control": "private, no-store" } })
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
    },
  })
}
