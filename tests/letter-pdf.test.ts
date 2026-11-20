import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { SeedPage } from "@/lib/acq/pipeline"
import { LetterSettingsSchema } from "@/lib/campaigns"
import { buildLetterPdf } from "@/lib/chain/letter-pdf"
import { readLetterPdf, saveLetterPdf } from "@/lib/server/letter-pdfs"

// Gefälschte SQL-Schicht: hält acq.letter_pdfs im Speicher und verhält sich wie postgres.js (bytea kommt als Buffer zurück).
const fake = vi.hoisted(() => {
  type Row = { lead_id: string; sha256: string; pdf: Buffer; created_by: string }
  const rows = new Map<string, Row>()
  const statements: string[] = []
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim()
    statements.push(text)
    if (text.startsWith("insert into acq.letter_pdfs (lead_id, sha256, pdf, created_by)")) {
      const [leadId, sha256, pdf, by] = values as [string, string, Uint8Array, string]
      if (!(pdf instanceof Uint8Array)) throw new Error("pdf muss als Bytes (bytea) übergeben werden")
      const key = `${leadId}/${sha256}`
      if (!rows.has(key)) rows.set(key, { lead_id: leadId, sha256, pdf: Buffer.from(pdf), created_by: by })
      return []
    }
    if (text.startsWith("select pdf from acq.letter_pdfs where lead_id = $ and sha256 = $")) {
      const row = rows.get(`${values[0]}/${values[1]}`)
      return row ? [{ pdf: Buffer.from(row.pdf) }] : []
    }
    throw new Error(`Unerwartete Abfrage: ${text}`)
  }
  return { rows, statements, sql }
})
vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/db", () => ({ db: () => fake.sql }))

const letter = LetterSettingsSchema.parse({
  sender: "Beispiel Beratung · Musterweg 1 · 12345 Musterstadt",
  place: "Musterstadt",
  qrText: "Scannen Sie den QR-Code: Dort steht, was wir uns für Ihre Firma angesehen haben.",
  signature: ["Max Muster", "Beispiel Beratung · www.example.de"],
  footer: "Werbung der Beispiel Beratung, Musterweg 1, 12345 Musterstadt. Ihre Anschrift stammt aus dem Impressum Ihrer Website. Einem weiteren Brief können Sie jederzeit formlos widersprechen.",
})

function seedPage(body: string[]): SeedPage {
  return {
    slug: "beispiel-gmbh", company: "Beispiel GmbH", salutation: "Guten Tag", headline: "Hallo Beispiel GmbH", intro: "Intro",
    observation: "Beobachtung", points: "Punkte", offer: "dsb",
    letter: { address: ["Beispiel GmbH", "Geschäftsführung", "Musterweg 1", "12345 Musterstadt"], subject: "Datenschutz bei der Beispiel GmbH", body },
  }
}

const PAGE_URL = "https://www.example.de/fuer/beispiel-gmbh?k=abcdefghijklmnopqrstuv"
const pageCount = (pdf: Uint8Array) => (Buffer.from(pdf).toString("latin1").match(/\/Type \/Page(?!s)/g) ?? []).length

describe("Brief-PDF", () => {
  it("baut genau eine Seite mit dem ersten Unterschriftsnamen als Autor", async () => {
    const body = ["Auf Ihrer Website ist uns aufgefallen, dass …", "- erster Punkt", "- zweiter Punkt", "Wir zeigen Ihnen gern, wie es einfacher geht."]
    const pdf = await buildLetterPdf({ letter, page: seedPage(body), url: PAGE_URL, date: new Date("2026-11-20T10:00:00Z") })
    expect(pdf).toBeInstanceOf(Uint8Array)
    const text = Buffer.from(pdf).toString("latin1")
    expect(text.startsWith("%PDF")).toBe(true)
    expect(pageCount(pdf)).toBe(1)
    // pdfkit legt jeden Info-Eintrag als eigenes Objekt ab: /Author 13 0 R … 13 0 obj (Max Muster) endobj
    const authorRef = text.match(/\/Author (\d+) 0 R/)?.[1]
    expect(authorRef).toBeDefined()
    expect(text).toMatch(new RegExp(`(^|\\n)${authorRef} 0 obj\\s*\\(Max Muster\\)`))
  })

  it("wirft statt einer zweiten Seite, wenn der Text zu lang ist", async () => {
    const body = Array.from({ length: 40 }, (_, i) => `Absatz ${i + 1}: ${"Ein sehr langer Satz über Datenschutz und Organisation. ".repeat(4)}`)
    await expect(buildLetterPdf({ letter, page: seedPage(body), url: PAGE_URL })).rejects.toThrow(/passt .* nicht auf eine Seite/)
  })
})

describe("Brief-PDF speichern", () => {
  const leadId = "00000000-0000-4000-8000-000000000001"

  it("liefert byte-genau dasselbe PDF zurück, Schlüssel ist der SHA-256 der Bytes", async () => {
    const pdf = await buildLetterPdf({ letter, page: seedPage(["Kurzer Text."]), url: PAGE_URL })
    const hash = await saveLetterPdf(leadId, pdf, "system:test")
    expect(hash).toBe(createHash("sha256").update(pdf).digest("hex"))
    const stored = fake.rows.get(`${leadId}/${hash}`)
    expect(stored?.sha256).toBe(hash)
    expect(stored?.created_by).toBe("system:test")
    expect(Buffer.compare(stored!.pdf, Buffer.from(pdf))).toBe(0)

    const read = await readLetterPdf(leadId, hash)
    expect(read).toBeInstanceOf(Uint8Array)
    expect(Buffer.compare(Buffer.from(read!), Buffer.from(pdf))).toBe(0)

    // erneut speichern ändert nichts
    expect(await saveLetterPdf(leadId, pdf, "system:test")).toBe(hash)
    expect(fake.rows.size).toBe(1)
  })

  it("liefert undefined für unbekannte oder ungültige Hashes", async () => {
    expect(await readLetterPdf(leadId, "0".repeat(64))).toBeUndefined()
    expect(await readLetterPdf("00000000-0000-4000-8000-000000000002", [...fake.rows.values()][0].sha256)).toBeUndefined()
    const before = fake.statements.length
    expect(await readLetterPdf(leadId, "kein-hash")).toBeUndefined()
    expect(fake.statements.length).toBe(before)
  })
})
