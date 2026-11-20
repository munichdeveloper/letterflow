import type { Evidence, LeadCandidate, Proposal } from "./contracts"

/**
 * Deterministische Regeln der Briefakquise (Rechtsregeln aus briefakquise-rechtslage-online.md,
 * verbindlich seit 18.11.2026, plus Produktentscheidung vom 10.11.2026: keine Preise im Erstkontakt).
 * Was der Agent behauptet, wird hier nicht geglaubt, sondern geprüft, soweit das ohne Netz geht.
 */

export type LeadVerdict =
  | { action: "accept" }
  | { action: "reject"; reasons: string[] }
  | { action: "suppress"; reasons: string[] }

const LEGAL_FORM_SUFFIX: Record<LeadCandidate["legalForm"], RegExp> = {
  GmbH: /\bGmbH(\s*&\s*Co\.?\s*KG)?$/,
  UG: /\bUG(\s*\(haftungsbeschränkt\))?$/,
  AG: /\bAG$/,
}

// Häufige Vornamen: ein Treffer im Firmennamen deutet auf einen Personennamen (Regel 1). Bewusst
// streng: lieber eine Firma zu viel aussortieren.
const FIRST_NAMES = new Set(
  (
    "alexander andreas anna andrea benjamin bernd birgit christian christina claudia daniel david dirk " +
    "elke felix florian frank gabriele georg hans heike helmut jan jens johannes jonas jörg julia jürgen " +
    "karin katharina klaus lars laura lena lukas manfred marc marcel marco maria marie markus martin " +
    "matthias max maximilian michael monika nicole niklas oliver patrick paul peter petra philipp ralf " +
    "sabine sandra sarah sascha sebastian simon sophie stefan stephan susanne sven thomas tim tobias " +
    "torsten ulrich ursula uwe werner wolfgang"
  ).split(" "),
)

export function companyHasPersonName(company: string) {
  return company
    .toLowerCase()
    .split(/[^a-zäöüß]+/)
    .some((word) => FIRST_NAMES.has(word))
}

export function checkLead(lead: LeadCandidate): LeadVerdict {
  // Werbewiderspruch geht vor: die Firma kommt auf die Sperrliste, nicht nur aus dieser Kampagne.
  if (lead.advertisingObjection) return { action: "suppress", reasons: ["Werbewiderspruch im Impressum"] }

  const reasons: string[] = []
  if (!LEGAL_FORM_SUFFIX[lead.legalForm].test(lead.company.trim())) reasons.push(`Firmenname passt nicht zur Rechtsform ${lead.legalForm}`)
  if (lead.personNameInCompany || companyHasPersonName(lead.company)) reasons.push("Firmenname enthält (vermutlich) einen Personennamen")
  if (lead.singlePersonCompany) reasons.push("erkennbare Ein-Personen-Gesellschaft")
  if (!lead.robotsAllowed) reasons.push("robots.txt erlaubt das Lesen nicht")

  const ownSite = (url: string) => {
    const host = new URL(url).hostname.replace(/^www\./, "")
    return host === lead.domain || host.endsWith(`.${lead.domain}`)
  }
  if (!ownSite(lead.imprintUrl)) reasons.push("Impressum liegt nicht auf der Domain der Firma")
  if (!lead.evidence.some((e) => e.kind === "fact" && ownSite(e.sourceUrl))) reasons.push("kein Fakt mit Beleg von der eigenen Website")
  const refs = lead.evidence.map((e) => e.ref)
  if (new Set(refs).size !== refs.length) reasons.push("doppelte Beleg-IDs")
  const personal = lead.evidence.find((e) => mentionsPerson(`${e.claim} ${e.quote ?? ""}`))
  if (personal) reasons.push(`Beleg ${personal.ref} nennt eine Person`)

  return reasons.length ? { action: "reject", reasons } : { action: "accept" }
}

const PRICE = /(\d[\d.,]*\s?(€|eur\b|euro))|((€|eur\b)\s?\d)|stundensatz|tagessatz|festpreis|pauschalpreis|preisrahmen|kostet\s|kosten\s+(ab|von|nur)|rabatt/i
const PERSON = /(^|[^\p{L}])([Hh]err|[Ff]rau|Hr\.|Fr\.|Dr\.|[Gg]eschäftsführer(in)?|[Ii]nhaber(in)?|CEO|[Gg]ründer(in)?)\s+\p{Lu}\p{Ll}+/u
const MARKUP = /<[a-z/!]|javascript:|\{\{|\}\}/i

export function mentionsPerson(text: string) {
  return PERSON.test(text)
}

/** Prüft eine Seitenbeschreibung gegen die gespeicherten Belege des Leads. Liefert alle Verstöße. */
export function checkProposal(proposal: Proposal, evidence: Pick<Evidence, "ref" | "kind">[], campaignOffer?: string): string[] {
  const problems: string[] = []
  if ((proposal.page.offer ?? campaignOffer) === "dsb" && proposal.page.proposal.length === 0) problems.push("Angebot dsb braucht mindestens einen Vorschlagspunkt")
  const byRef = new Map(evidence.map((e) => [e.ref, e]))

  for (const [i, observation] of proposal.page.observations.entries()) {
    const ev = byRef.get(observation.evidenceRef)
    if (!ev) problems.push(`Beobachtung ${i + 1}: Beleg ${observation.evidenceRef} gibt es nicht`)
    else if (ev.kind === "hypothesis" && !observation.text.trim().endsWith("?")) problems.push(`Beobachtung ${i + 1}: Hypothese nur als Frage formulieren`)
  }
  for (const ref of proposal.letter.evidenceRefs) if (!byRef.has(ref)) problems.push(`Brief: Beleg ${ref} gibt es nicht`)

  const texts = [
    proposal.page.headline, proposal.page.intro, ...proposal.page.observations.map((o) => o.text), ...proposal.page.proposal,
    proposal.letter.subject, ...proposal.letter.body,
  ]
  for (const text of texts) {
    if (PRICE.test(text)) problems.push(`Preisangabe oder Preisversprechen: „${text.slice(0, 60)}…“`)
    if (mentionsPerson(text)) problems.push(`Personenname: „${text.slice(0, 60)}…“`)
    if (MARKUP.test(text)) problems.push(`Markup oder Code: „${text.slice(0, 60)}…“`)
  }
  return problems
}

/** Anschrift im Brief: immer an die Geschäftsführung, nie an eine Person (Regel 2). */
export function letterAddress(lead: { company: string; street: string; postalCode: string; city: string }) {
  return [lead.company, "Geschäftsführung", lead.street, `${lead.postalCode} ${lead.city}`]
}
