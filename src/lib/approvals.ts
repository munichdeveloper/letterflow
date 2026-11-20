/**
 * Welche Entscheidung ein Mensch in welchem Zustand treffen kann. Die Datenbank (acq.transition) prüft
 * dasselbe noch einmal; hier geht es darum, nur passende Knöpfe zu zeigen.
 */

export type Stage = "lead" | "page" | "letter"

export const STAGE_FOR_STATE: Record<string, Stage | undefined> = {
  checked: "lead",
  page_ready: "page",
  letter_ready: "letter",
}

export const STAGE_LABELS: Record<Stage, string> = {
  lead: "Lead freigeben",
  page: "Seite freigeben",
  letter: "Brief freigeben",
}

/** Zustände, aus denen acq.allowed_transition ein Ablehnen erlaubt. */
const REJECTABLE = new Set(["discovered", "checked", "approved", "researched", "page_ready", "letter_ready", "failed"])

export function canReject(state: string) {
  return REJECTABLE.has(state)
}

/** Nach technischem Fehler: nur zurück in einen Zustand ohne Freigabe (wie pnpm acq resume). */
export function canResume(state: string, resumeState: string | null) {
  return state === "failed" && !!resumeState && !["approved", "page_approved", "letter_approved"].includes(resumeState)
}

export function actorFor(name: string) {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error("Ungültiger Name für eine Freigabe.")
  return `human:${name}`
}
