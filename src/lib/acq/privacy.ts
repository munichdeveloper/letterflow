import { z } from "zod"

/**
 * Letzter Prüfschritt vor dem Versand (Johannes, 20.11.2026): Jev (TypeSafe System One) schätzt, wie
 * wahrscheinlich die Kontaktdaten eines Briefs personenbezogene Daten enthalten. Ergänzt die festen Regeln
 * aus rules.ts, ersetzt sie nicht. Gleiche API wie der Model Router der Software Factory (src/llm/router.ts).
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone"
/** Ab dieser Wahrscheinlichkeit für "personenbezogen" geht der Brief nicht raus. Bewusst niedrig. */
export const PRIVACY_MAX = 0.3

export type Contact = { company: string; address: string[]; domain: string }
export type PrivacyScore = { personal: number; choice: "personal" | "company"; model: string }

const INSTRUCTIONS =
  "Diese Kontaktdaten stehen als Anschrift auf einem Werbebrief an ein Unternehmen. Enthalten sie personenbezogene Daten " +
  "einer natürlichen Person? Personenbezogen ist zum Beispiel: ein Vor- oder Nachname im Firmennamen oder in der Anschrift, " +
  "eine Privatanschrift, ein Einzelunternehmen oder eine erkennbare Ein-Personen-Gesellschaft. Nicht personenbezogen ist eine " +
  "juristische Person (GmbH, UG, AG) mit Fantasie- oder Sachnamen, adressiert an die Geschäftsführung unter der Geschäftsanschrift."

const answerSchema = z.object({
  answers: z.object({
    privacy: z.object({
      choice: z.enum(["personal", "company"]),
      confidence: z.number().min(0).max(1).optional(),
      probabilities: z.record(z.string(), z.number()).optional(),
    }),
  }),
})

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** Wirft, wenn Jev nicht erreichbar ist oder keine verwertbare Antwort gibt: dann geht nichts raus. */
export async function jevPrivacyScore(
  contact: Contact,
  options: { key: string; model?: string; timeoutMs?: number; fetcher?: Fetcher },
): Promise<PrivacyScore> {
  const model = options.model ?? "jev-latest"
  const response = await (options.fetcher ?? fetch)(JEV_URL, {
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    headers: { authorization: `Bearer ${options.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      state: JSON.stringify({ firma: contact.company, anschrift: contact.address, domain: contact.domain }),
      questions: {
        privacy: {
          type: "choice",
          instructions: INSTRUCTIONS,
          criteria: {
            personal: "Enthält personenbezogene Daten einer natürlichen Person.",
            company: "Nur Angaben einer juristischen Person, keine natürliche Person erkennbar.",
          },
        },
      },
    }),
  })
  if (!response.ok) throw new Error(`Jev antwortet mit HTTP ${response.status}`)
  const answer = answerSchema.parse(await response.json()).answers.privacy
  // Wie im Model Router: confidence ist (p_max - 1/n) / (1 - 1/n), bei zwei Optionen also p_max = c/2 + 1/2.
  const pChoice = answer.probabilities?.[answer.choice] ?? (answer.confidence === undefined ? undefined : answer.confidence / 2 + 0.5)
  const pPersonal = answer.probabilities?.personal ?? (pChoice === undefined ? undefined : answer.choice === "personal" ? pChoice : 1 - pChoice)
  if (pPersonal === undefined || !Number.isFinite(pPersonal)) throw new Error("Jev hat keine Wahrscheinlichkeit geliefert")
  return { personal: Math.min(1, Math.max(0, pPersonal)), choice: answer.choice, model }
}
