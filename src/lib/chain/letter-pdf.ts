import PDFDocument from "pdfkit"
import QRCode from "qrcode"
import type { SeedPage } from "@/lib/acq/pipeline"
import type { LetterSettings } from "@/lib/campaigns"

/**
 * Brief-PDF im Layout DIN 5008 Form B für Pingen. Der Rückgabewert wird unverändert gespeichert (acq.letter_pdfs):
 * pdfkit schreibt ein Erstellungsdatum hinein, ein neu gebautes PDF hätte einen anderen SHA-256.
 */

const mm = (value: number) => (value * 72) / 25.4
const PAGE = { width: mm(210), height: mm(297) }
const LEFT = mm(25)
const RIGHT = mm(20)
const TEXT_WIDTH = PAGE.width - LEFT - RIGHT
// Pingen hält die Zone über der Anschrift (Frankierung) und den Seitenrand für Frankierung und Falz frei:
// keine Absenderzeile im Fenster, keine Falzmarken. Der Absender steht im Briefkopf.
const SENDER_Y = mm(20)
const ADDRESS_Y = mm(63.5) // Anschriftzone beginnt 62,7 mm von oben
const DATE_Y = mm(97)
const SUBJECT_Y = mm(105)
const FOOTER_Y = mm(279) // Fußnote; der Text muss darüber enden
const QR_SIZE = mm(27)
const FONT_SIZES = [10.5, 10, 9.5, 9]

function germanDate(date: Date) {
  return new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" }).format(date)
}

type Doc = InstanceType<typeof PDFDocument>
type Job = { letter: LetterSettings; page: SeedPage; qr: Buffer; date: string }

/** Zeichnet den Brief auf die aktuelle Seite und liefert die y-Position, an der der Inhalt endet. */
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
  // QR-Code mit Erklärung daneben
  const qrY = doc.y + gap * 0.4
  doc.image(qr, LEFT, qrY, { width: QR_SIZE, height: QR_SIZE })
  const textX = LEFT + QR_SIZE + mm(5)
  const textWidth = TEXT_WIDTH - QR_SIZE - mm(5)
  const textHeight = doc.heightOfString(campaign.qrText, { width: textWidth, lineGap })
  doc.text(campaign.qrText, textX, qrY + Math.max(0, (QR_SIZE - textHeight) / 2), { width: textWidth, lineGap })
  doc.text(campaign.closing, LEFT, qrY + QR_SIZE + gap * 1.6, { width: TEXT_WIDTH })
  doc.y += mm(11) // Platz für die handschriftliche Unterschrift
  doc.text(campaign.signature.join("\n"), LEFT, doc.y, { width: TEXT_WIDTH, lineGap })
  const end = doc.y
  doc.fontSize(7.5).fillColor("#444").text(campaign.footer, LEFT, FOOTER_Y, { width: TEXT_WIDTH, lineGap: 1 })
  doc.fillColor("#000")
  return end
}

function newDoc(title: string, author: string) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, info: { Title: title, Author: author } })
  const state = { pages: 0, chunks: [] as Buffer[] }
  doc.on("pageAdded", () => { state.pages++ })
  doc.on("data", (chunk: Buffer) => state.chunks.push(chunk))
  const finish = () => new Promise<void>((resolve, reject) => {
    doc.on("end", resolve)
    doc.on("error", reject)
    doc.end()
  })
  return { doc, state, finish }
}

/** Größte Schriftgröße, bei der der Brief auf einer Seite über der Fußnote endet; gemessen auf einem Wegwerf-Dokument. */
async function fittingFontSize(job: Job, author: string) {
  for (const size of FONT_SIZES) {
    const probe = newDoc("probe", author)
    probe.doc.addPage()
    const end = drawLetter(probe.doc, job, size)
    await probe.finish()
    if (probe.state.pages === 1 && end <= FOOTER_Y - mm(4)) return size
  }
  throw new Error(`Der Brief für ${job.page.slug} passt auch in ${FONT_SIZES.at(-1)} pt nicht auf eine Seite. Bitte den Text kürzen.`)
}

/** Baut das Brief-PDF (eine A4-Seite). `url` ist die Landingpage-URL mit dem Brief-Schlüssel für den QR-Code. */
export async function buildLetterPdf({ letter, page, url, date }: { letter: LetterSettings; page: SeedPage; url: string; date: Date }): Promise<Uint8Array> {
  // QR-Code: Fehlerkorrektur M und die übliche Ruhezone von 4 Modulen, groß genug für den Druck.
  const qr = await QRCode.toBuffer(url, { type: "png", errorCorrectionLevel: "M", margin: 4, width: 900 })
  const job: Job = { letter, page, qr, date: germanDate(date) }
  const author = letter.signature[0]
  const size = await fittingFontSize(job, author)
  const out = newDoc(page.letter.subject, author)
  out.doc.addPage()
  drawLetter(out.doc, job, size)
  await out.finish()
  if (out.state.pages !== 1) throw new Error(`Der Brief für ${page.slug} passt nicht auf eine Seite. Bitte den Text kürzen.`)
  return new Uint8Array(Buffer.concat(out.state.chunks))
}
