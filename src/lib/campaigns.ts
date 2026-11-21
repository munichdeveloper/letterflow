import { z } from "zod"

/** Kampagne, wie letterflow sie anlegt und bearbeitet (acq.campaigns). */

export const OFFERS = ["dsb", "saas", "managed"] as const
export const CAMPAIGN_STATUS = ["active", "paused", "closed"] as const

const line = (max: number) => z.string().trim().min(1).max(max)

export const LetterSettingsSchema = z.object({
  sender: line(200),
  place: line(60),
  salutation: line(80).default("Sehr geehrte Damen und Herren,"),
  qrText: line(400),
  closing: line(80).default("Mit freundlichen Grüßen"),
  signature: z.array(line(120)).min(1).max(4),
  // Pflichtangaben im Werbebrief: Absender, Herkunft der Anschrift, Widerspruch, Datenschutz
  footer: line(600),
})
export type LetterSettings = z.infer<typeof LetterSettingsSchema>

export const CampaignInputSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/, "Schlüssel: Kleinbuchstaben, Ziffern, Bindestrich (3–61 Zeichen)"),
  title: line(120),
  offer: z.enum(OFFERS),
  segment: line(300),
  letter: LetterSettingsSchema,
  status: z.enum(CAMPAIGN_STATUS).default("active"),
})
export type CampaignInput = z.infer<typeof CampaignInputSchema>

/** Liest das Formular. Signatur: eine Zeile je Zeilenumbruch. */
export function campaignFromForm(form: FormData): CampaignInput {
  const text = (name: string) => String(form.get(name) ?? "")
  return CampaignInputSchema.parse({
    key: text("key").trim(),
    title: text("title"),
    offer: text("offer"),
    segment: text("segment"),
    status: text("status") || "active",
    letter: {
      sender: text("sender"),
      place: text("place"),
      salutation: text("salutation") || undefined,
      qrText: text("qrText"),
      closing: text("closing") || undefined,
      signature: text("signature").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      footer: text("footer"),
    },
  })
}

/** Leads je Zustand für die Übersicht, in der Reihenfolge der Kette. */
export const STATE_LABELS: Record<string, string> = {
  discovered: "Gefunden",
  checked: "Geprüft, wartet auf Freigabe",
  approved: "Freigegeben, Recherche läuft",
  researched: "Seitentext liegt vor",
  page_ready: "Seite wartet auf Freigabe",
  page_approved: "Seite freigegeben",
  letter_ready: "Brief wartet auf Freigabe",
  letter_approved: "Brief freigegeben",
  queued: "In der Versand-Outbox",
  sent: "Versendet",
  rejected: "Abgelehnt",
  suppressed: "Gesperrt",
  failed: "Technischer Fehler",
}

export const WAITING_FOR_HUMAN = ["checked", "page_ready", "letter_ready"]
