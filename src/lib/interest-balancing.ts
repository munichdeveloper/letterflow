/**
 * Interessenabwägung je Kampagne (Regel 7, Art. 6 Abs. 1 lit. f DSGVO): Datei prüfen und Stand beschreiben.
 * Gespeichert wird in acq.interest_balancings (siehe lib/server/interest-balancings.ts), freigeben darf nur ein Mensch.
 * Ohne Node-Abhängigkeiten, damit auch Client-Komponenten Grenze und Dateitypen kennen.
 */

export const INTEREST_BALANCING_MAX_BYTES = 2 * 1024 * 1024
export const INTEREST_BALANCING_ACCEPT = ".md,.pdf,text/markdown,application/pdf"

export const INTEREST_BALANCING_TYPES = { md: "text/markdown; charset=utf-8", pdf: "application/pdf" } as const
export type InterestBalancingContentType = (typeof INTEREST_BALANCING_TYPES)[keyof typeof INTEREST_BALANCING_TYPES]

export type InterestBalancingFile = { fileName: string; contentType: InterestBalancingContentType; content: Uint8Array }

/** Stand einer Version, wie ihn die Seiten anzeigen (ohne Inhalt). */
export type InterestBalancingStatus = {
  id: string
  version: number
  file_name: string
  content_type: string
  sha256: string
  uploaded_by: string
  uploaded_at: string | Date
  approved_by: string | null
  approved_at: string | Date | null
}

const tooLarge = (fileName: string) => `„${fileName}“ ist größer als 2 MB. Bitte eine kleinere Datei hochladen.`

/** Prüft eine hochgeladene Datei: nur .md (UTF-8-Text) oder .pdf, nicht leer, höchstens 2 MB. Wirft mit verständlicher Meldung. */
export function checkInterestBalancingFile(name: string, content: Uint8Array): InterestBalancingFile {
  const fileName = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(-200)
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase()
  if (ext !== "md" && ext !== "pdf") {
    throw new Error(`„${fileName || "Datei"}“ ist weder Markdown (.md) noch PDF (.pdf). Bitte die Interessenabwägung als .md oder .pdf hochladen.`)
  }
  if (!content.length) throw new Error(`„${fileName}“ ist leer.`)
  if (content.length > INTEREST_BALANCING_MAX_BYTES) {
    throw new Error(tooLarge(fileName))
  }
  if (ext === "pdf") {
    if (String.fromCharCode(...content.subarray(0, 5)) !== "%PDF-") throw new Error(`„${fileName}“ endet auf .pdf, ist aber kein PDF.`)
  } else {
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content)
    } catch {
      throw new Error(`„${fileName}“ ist kein Markdown-Text (UTF-8).`)
    }
    if (text.includes("\u0000")) throw new Error(`„${fileName}“ ist kein Markdown-Text (UTF-8).`)
  }
  return { fileName, contentType: INTEREST_BALANCING_TYPES[ext], content }
}

/** Liest die Datei aus dem Upload-Formular (Feld „file“) und prüft sie. */
export async function interestBalancingFromForm(form: FormData, field = "file"): Promise<InterestBalancingFile> {
  const file = form.get(field)
  if (!(file instanceof File) || (!file.name && !file.size)) throw new Error("Bitte eine Datei auswählen.")
  if (file.size > INTEREST_BALANCING_MAX_BYTES) {
    throw new Error(tooLarge(file.name))
  }
  return checkInterestBalancingFile(file.name, new Uint8Array(await file.arrayBuffer()))
}

/** Regel 7: Briefe gehen nur frei, wenn die neueste Version freigegeben ist. */
export function isInterestBalancingApproved(latest: InterestBalancingStatus | null | undefined) {
  return !!latest?.approved_at
}

const day = (d: string | Date) =>
  new Date(d).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" })

/** z. B. „Interessenabwägung v2, freigegeben am 21.11.2026 von johannes“. */
export function interestBalancingLabel(latest: InterestBalancingStatus | null | undefined) {
  if (!latest) return "Interessenabwägung fehlt"
  if (latest.approved_at) {
    return `Interessenabwägung v${latest.version}, freigegeben am ${day(latest.approved_at)} von ${(latest.approved_by ?? "").replace(/^human:/, "")}`
  }
  return `Interessenabwägung v${latest.version} hochgeladen, noch nicht freigegeben`
}
