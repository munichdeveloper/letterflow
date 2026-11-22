import { describe, expect, it } from "vitest"
import {
  checkInterestBalancingFile, interestBalancingFromForm, interestBalancingLabel, isInterestBalancingApproved, type InterestBalancingStatus,
} from "@/lib/interest-balancing"

const text = (s: string) => new TextEncoder().encode(s)

function form(name: string, content: Uint8Array<ArrayBuffer> | string) {
  const f = new FormData()
  f.set("file", new File([content], name))
  return f
}

describe("Interessenabwägung hochladen", () => {
  it("nimmt Markdown und PDF an und setzt den Content-Type", () => {
    expect(checkInterestBalancingFile("abwaegung.md", text("# Abwägung"))).toMatchObject({ fileName: "abwaegung.md", contentType: "text/markdown; charset=utf-8" })
    expect(checkInterestBalancingFile("C:\\Ordner\\Abwägung.PDF", text("%PDF-1.7\n"))).toMatchObject({ fileName: "Abwägung.PDF", contentType: "application/pdf" })
  })

  it("lehnt andere Typen, leere, falsche und zu große Dateien verständlich ab", async () => {
    expect(() => checkInterestBalancingFile("abwaegung.docx", text("x"))).toThrow("„abwaegung.docx“ ist weder Markdown (.md) noch PDF (.pdf). Bitte die Interessenabwägung als .md oder .pdf hochladen.")
    expect(() => checkInterestBalancingFile("abwaegung", text("x"))).toThrow(/weder Markdown/)
    expect(() => checkInterestBalancingFile("abwaegung.md", new Uint8Array())).toThrow("„abwaegung.md“ ist leer.")
    expect(() => checkInterestBalancingFile("abwaegung.pdf", text("# kein PDF"))).toThrow("„abwaegung.pdf“ endet auf .pdf, ist aber kein PDF.")
    expect(() => checkInterestBalancingFile("abwaegung.md", new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(/kein Markdown-Text/)
    const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61)
    expect(() => checkInterestBalancingFile("abwaegung.md", big)).toThrow("„abwaegung.md“ ist größer als 2 MB. Bitte eine kleinere Datei hochladen.")
    expect(() => checkInterestBalancingFile("abwaegung.md", new Uint8Array(2 * 1024 * 1024).fill(0x61))).not.toThrow()
    await expect(interestBalancingFromForm(form("abwaegung.pdf", new Uint8Array(3 * 1024 * 1024)))).rejects.toThrow("„abwaegung.pdf“ ist größer als 2 MB. Bitte eine kleinere Datei hochladen.")
    await expect(interestBalancingFromForm(form("abwaegung.txt", "Text"))).rejects.toThrow(/weder Markdown/)
    await expect(interestBalancingFromForm(new FormData())).rejects.toThrow("Bitte eine Datei auswählen.")
  })

  it("liest die Datei aus dem Formular", async () => {
    const file = await interestBalancingFromForm(form("abwaegung.md", "# Abwägung\n\nBeispiel GmbH"))
    expect(new TextDecoder().decode(file.content)).toBe("# Abwägung\n\nBeispiel GmbH")
  })
})

describe("Stand der Interessenabwägung", () => {
  const v2: InterestBalancingStatus = {
    id: "00000000-0000-4000-8000-000000000002", version: 2, file_name: "abwaegung.md", content_type: "text/markdown; charset=utf-8",
    sha256: "a".repeat(64), uploaded_by: "human:johannes", uploaded_at: "2026-11-21T08:00:00Z", approved_by: null, approved_at: null,
  }

  it("beschreibt fehlend, hochgeladen und freigegeben", () => {
    expect(interestBalancingLabel(null)).toBe("Interessenabwägung fehlt")
    expect(isInterestBalancingApproved(null)).toBe(false)
    expect(interestBalancingLabel(v2)).toBe("Interessenabwägung v2 hochgeladen, noch nicht freigegeben")
    expect(isInterestBalancingApproved(v2)).toBe(false)
    const approved = { ...v2, approved_by: "human:johannes", approved_at: "2026-11-21T09:30:00Z" }
    expect(interestBalancingLabel(approved)).toBe("Interessenabwägung v2, freigegeben am 21.11.2026 von johannes")
    expect(isInterestBalancingApproved(approved)).toBe(true)
  })
})
