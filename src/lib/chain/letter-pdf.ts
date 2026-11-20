import PDFDocument from "pdfkit"
import { toBuffer } from "qrcode"
import type { SeedPage } from "@/lib/acq/pipeline"
import type { LetterSettings } from "@/lib/campaigns"

/**
 * Brief-PDF je Lead, DIN 5008 Form B für Pingen. Das Ergebnis wird unverändert gespeichert
 * (acq.letter_pdfs), weil die Freigabe an den SHA-256 genau dieser Bytes gebunden ist und pdfkit
 * ein Erstellungsdatum einträgt: ein neu gebautes PDF hätte einen anderen Hash.
 */

const mm = (value: number) => (value * 72) / 25.4
const PAGE = { width: mm(210), height: mm(297) }
const LEFT = mm(25)
const RIGHT = mm(20)
const TEXT_WIDTH = PAGE.width - LEFT - RIGHT
// Pingen keeps the zone above the address (stamp area) and the page border free for its own franking
// and folding: no return address in the window, no fold marks. The sender goes into the letterhead.
const SENDER_Y = mm(20)
const ADDRESS_Y = mm(63.5) // address zone starts 62.7 mm from the top
const DATE_Y = mm(97)
const SUBJECT_Y = mm(105)
const FOOTER_Y = mm(279) // footer note; the body must end above it
const QR_SIZE = mm(27)
const FONT_SIZES = [10.5, 10, 9.5, 9]

export type LetterPdfInput = {
  /** Briefeinstellungen der Kampagne (LetterSettingsSchema). */
  letter: LetterSettings
  page: SeedPage
  /** Landingpage-URL mit dem Brief-Schlüssel, wird zum QR-Code. */
  url: string
  date?: Date
}

function germanDate(date: Date) {
  return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" }).format(date)
}

type Doc = InstanceType<typeof PDFDocument>
type Job = { letter: LetterSettings; page: SeedPage; qr: Buffer; date: string }

/** Draws one letter on the current page and returns the y position where the content ends. */
function drawLetter(doc: Doc, { letter: campaign, page, qr, date }: Job, fontSize: number) {
  const gap = fontSize * 0.62
  const lineGap = fontSize * 0.24
  doc.fillColor("#000").font("Helvetica").fontSize(8).text(campaign.sender, LEFT, SENDER_Y, { width: TEXT_WIDTH, align: "right", lineBreak: false })
  doc.fontSize(10.5).text(page.letter.address.join("\n"), LEFT, ADDRESS_Y, { width: mm(80), lineGap: 1.5 })
  doc.fontSize(fontSize).text(`${campaign.place}, ${date}`, LEFT, DATE_Y, { width: TEXT_WIDTH, align: "right" })
  doc.font("Helvetica-Bold").text(page.letter.subject, LEFT, SUBJECT_Y, { width: TEXT_WIDTH, lineGap })
  doc.font("Helvetica").moveDown(1.1).text(campaign.salutation, { width: TEXT_WIDTH, lineGap })
  doc.y += gap
  for (const paragraph of page.letter.body) {
    if (paragraph.startsWith("- ")) {
      const y = doc.y
      doc.text("•", LEFT + mm(1.5), y, { lineBreak: false })
      doc.text(paragraph.slice(2), LEFT + mm(6), y, { width: TEXT_WIDTH - mm(6), lineGap })
    } else {
      doc.text(paragraph, LEFT, doc.y, { width: TEXT_WIDTH, lineGap })
    }
    doc.y += gap
  }
  // QR code with its explanation beside it
  const qrY = doc.y + gap * 0.4
  doc.image(qr, LEFT, qrY, { width: QR_SIZE, height: QR_SIZE })
  const textX = LEFT + QR_SIZE + mm(5)
  const textWidth = TEXT_WIDTH - QR_SIZE - mm(5)
  const textHeight = doc.heightOfString(campaign.qrText, { width: textWidth, lineGap })
  doc.text(campaign.qrText, textX, qrY + Math.max(0, (QR_SIZE - textHeight) / 2), { width: textWidth, lineGap })
  doc.text(campaign.closing, LEFT, qrY + QR_SIZE + gap * 1.6, { width: TEXT_WIDTH })
  doc.y += mm(11) // room for the handwritten signature
  doc.text(campaign.signature.join("\n"), LEFT, doc.y, { width: TEXT_WIDTH, lineGap })
  const end = doc.y
  doc.fontSize(7.5).fillColor("#444").text(campaign.footer, LEFT, FOOTER_Y, { width: TEXT_WIDTH, lineGap: 1 })
  doc.fillColor("#000")
  return end
}

function newDoc(title: string, author: string) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, info: { Title: title, Author: author } })
  let pages = 0
  doc.on("pageAdded", () => pages++)
  return { doc, pages: () => pages }
}

/** Draws the letter and reports whether it stayed on one page with the body above the footer. */
function fits(doc: Doc, pages: () => number, job: Job, size: number) {
  doc.addPage()
  const end = drawLetter(doc, job, size)
  return pages() === 1 && end <= FOOTER_Y - mm(4)
}

const tooLong = (job: Job) =>
  new Error(`Der Brief für ${job.page.slug} passt auch in ${FONT_SIZES.at(-1)} pt nicht auf eine Seite. Bitte den Text kürzen.`)

/** Largest font size at which the letter ends above the footer; measured on a throwaway document. */
function fittingFontSize(job: Job) {
  for (const size of FONT_SIZES) {
    const probe = newDoc("probe", "probe")
    const ok = fits(probe.doc, probe.pages, job, size)
    probe.doc.end()
    if (ok) return size
  }
  throw tooLong(job)
}

/** Baut das Brief-PDF (genau eine Seite) und liefert seine Bytes. Wirft, wenn der Text nicht auf eine Seite passt. */
export async function buildLetterPdf({ letter, page, url, date = new Date() }: LetterPdfInput): Promise<Uint8Array> {
  // Error correction M and the standard quiet zone of 4 modules, rendered large enough for print.
  const qr = await toBuffer(url, { type: "png", errorCorrectionLevel: "M", margin: 4, width: 900 })
  const job: Job = { letter, page, qr, date: germanDate(date) }
  const size = fittingFontSize(job)
  const { doc, pages } = newDoc(`Brief an ${page.company}`, letter.signature[0])
  const chunks: Buffer[] = []
  const done = new Promise<Uint8Array>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk))
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))))
    doc.on("error", reject)
  })
  const ok = fits(doc, pages, job, size)
  doc.end()
  const pdf = await done
  if (!ok) throw tooLong(job)
  return pdf
}
