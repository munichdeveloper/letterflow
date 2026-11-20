import { z } from "zod"

/**
 * Verträge der automatischen Briefakquise (ACQ-01). Ein Agent (Skill) liefert Leads, Belege und
 * Seitenbeschreibungen nur in diesen Formaten; das System prüft sie hier und mit den Regeln aus
 * lib/acq/rules.ts, bevor irgendetwas gespeichert wird. Kein HTML, kein Code, keine Preise.
 */

const https = z.string().url().refine((url) => url.startsWith("https://"), "Quelle muss https sein")

export const EvidenceSchema = z.object({
  ref: z.string().regex(/^[a-z0-9-]{1,40}$/, "ref: Kleinbuchstaben, Ziffern, Bindestrich"),
  kind: z.enum(["fact", "hypothesis"]),
  claim: z.string().min(5).max(500),
  sourceUrl: https,
  quote: z.string().max(500).optional(),
  retrievedAt: z.string().datetime({ offset: true }),
})
export type Evidence = z.infer<typeof EvidenceSchema>

export const LeadCandidateSchema = z.object({
  company: z.string().min(3).max(120),
  legalForm: z.enum(["GmbH", "UG", "AG"]),
  domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Domain ohne Schema und Pfad, klein geschrieben"),
  street: z.string().min(3).max(120),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().min(2).max(80),
  niche: z.string().max(200).optional(),
  region: z.string().max(80).optional(),
  fitReason: z.string().min(10).max(500),
  // Pflichtschritte, die der Agent belegen muss
  imprintUrl: https,
  advertisingObjection: z.boolean(), // Werbewiderspruch im Impressum gefunden?
  robotsAllowed: z.boolean(), // erlaubt robots.txt das Lesen der genutzten Seiten?
  personNameInCompany: z.boolean(), // enthält der Firmenname einen Personennamen?
  singlePersonCompany: z.boolean(), // erkennbare Ein-Personen-GmbH?
  evidence: z.array(EvidenceSchema).min(1).max(20),
})
export type LeadCandidate = z.infer<typeof LeadCandidateSchema>

export const LeadBatchSchema = z.object({
  campaign: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/),
  agent: z.string().min(2).max(80),
  leads: z.array(LeadCandidateSchema).min(1).max(50),
})
export type LeadBatch = z.infer<typeof LeadBatchSchema>

/**
 * Seitenbeschreibung + Brieftext eines Leads. Die Felder der Seite entsprechen den Feldern in Directus
 * (headline, intro, observation), der Brief dem Format von scripts/build-landing-letters.ts in dsb-new.
 */
export const ProposalSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  page: z.object({
    headline: z.string().min(10).max(90),
    intro: z.string().min(20).max(400),
    observations: z
      .array(z.object({ text: z.string().min(20).max(400), evidenceRef: z.string() }))
      .min(1)
      .max(3),
    // Vorschlagspunkte; Pflicht beim Angebot "dsb", bei Controla stehen die Angebote fest auf der Seite
    proposal: z.array(z.string().min(10).max(160)).max(4).default([]),
    // Angebot der Seite, wenn es je Firma abweicht (Controla: "saas" oder "managed"); sonst das der Kampagne
    offer: z.enum(["saas", "managed", "dsb"]).optional(),
  }),
  letter: z.object({
    subject: z.string().min(10).max(90),
    body: z.array(z.string().min(1).max(700)).min(2).max(10),
    evidenceRefs: z.array(z.string()).min(1),
  }),
})
export type Proposal = z.infer<typeof ProposalSchema>

export const ProposalBatchSchema = z.object({
  campaign: z.string(),
  agent: z.string().min(2).max(80),
  proposals: z.array(ProposalSchema.extend({ domain: z.string() })).min(1).max(50),
})
export type ProposalBatch = z.infer<typeof ProposalBatchSchema>

export const LEAD_STATES = [
  "discovered", "checked", "approved", "researched", "page_ready", "page_approved",
  "letter_ready", "letter_approved", "queued", "sent", "rejected", "suppressed", "failed",
] as const
export type LeadState = (typeof LEAD_STATES)[number]
