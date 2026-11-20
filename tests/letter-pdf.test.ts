import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { SeedPage } from "@/lib/acq/pipeline"
import { buildLetterPdf } from "@/lib/chain/letter-pdf"
import { LetterSettingsSchema } from "@/lib/campaigns"

vi.mock("server-only", () => ({}))

// Gefälschte SQL-Schicht: nur die beiden Anweisungen aus letter-pdfs.ts, bytea wie postgres.js als Buffer.
const store = new Map<string, { pdf: Buffer; createdBy: string }>()
vi.mock("@/lib/server/db", () => ({
  db: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?")
    if (/insert into acq\.letter_pdfs/.test(text)) {
      const [leadId, sha256, pdf, by] = values as [string, string, Buffer, string]
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("check violation")
      const key = `${leadId}/${sha256}`
      if (!store.has(key)) store.set(key, { pdf: Buffer.from(pdf), createdBy: by })
      return []
    }
    if (/from acq\.letter_pdfs/.test(text)) {
      const [leadId, sha256] = values as [string, string]
      const row = store.get(`${leadId}/${sha256}`)
      return row ? [{ pdf: Buffer.from(row.pdf) }] : []
    }
    throw new Error(`unerwartete Anweisung: ${text}`)
  },
}))

const letter = LetterSettingsSchema.parse({
  sender: "Beispiel GmbH · Musterweg 1 · 12345 Musterstadt",
  place: "Musterstadt",
  qrText: "Scannen Sie den QR-Code und sehen Sie sich die Seite an.",
  signature: ["Max Muster", "Beispiel GmbH · www.example.de"],
  footer: "Werbung von der Beispiel GmbH, Musterweg 1, 12345 Musterstadt. Widerspruch genügt formlos.",
})

function page(body: string[]): SeedPage {
  return {
    slug: "beispiel-gmbh", company: "Beispiel GmbH", salutation: "Sehr geehrte Damen und Herren,", headline: "h", intro: "i",
    observation: "o", points: "p", offer: "dsb",
    letter: { address: ["Beispiel GmbH", "Musterweg 1", "12345 Musterstadt"], subject: "Ein Vorschlag für Ihre Website", body },
  }
}

const url = "https://example.de/beispiel-gmbh?brief=abc123"
const date = new Date("2026-11-20T12:00:00Z")

describe("buildLetterPdf", () => {
  it("baut ein PDF mit genau einer Seite", async () => {
    const pdf = await buildLetterPdf({
      letter, page: page(["Erster Absatz mit etwas Text.", "- Ein Punkt", "- Noch ein Punkt", "Schlussabsatz."]), url, date,
    })
    const text = Buffer.from(pdf).toString("latin1")
    expect(text.startsWith("%PDF")).toBe(true)
    expect(text.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(1)
  })

  it("wirft bei überlangem Text statt eine zweite Seite zu bauen", async () => {
    const long = Array.from({ length: 40 }, () => "Dies ist ein sehr langer Absatz, der den Brief weit über eine Seite hinaus füllt. ".repeat(4))
    await expect(buildLetterPdf({ letter, page: page(long), url, date })).rejects.toThrow(/passt .* nicht auf eine Seite/)
  })
})

describe("Brief-PDFs ablegen", () => {
  it("liefert byte-genau dasselbe PDF und speichert den SHA-256 der Bytes", async () => {
    const { readLetterPdf, saveLetterPdf } = await import("@/lib/server/letter-pdfs")
    const leadId = "00000000-0000-4000-8000-000000000001"
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x0a, 0x0d, 0x31])
    const sha256 = await saveLetterPdf(leadId, pdf, "system:acq")
    expect(sha256).toBe(createHash("sha256").update(pdf).digest("hex"))
    expect(store.has(`${leadId}/${sha256}`)).toBe(true)
    expect(await readLetterPdf(leadId, sha256)).toEqual(pdf)
    expect(await saveLetterPdf(leadId, pdf, "system:acq")).toBe(sha256)
    expect(await readLetterPdf(leadId, "0".repeat(64))).toBeUndefined()
    expect(await readLetterPdf("00000000-0000-4000-8000-000000000002", sha256)).toBeUndefined()
  })
})
