import { describe, expect, it } from "vitest"
import { actorFor, canReject, canResume, STAGE_FOR_STATE } from "@/lib/approvals"

describe("Freigaben", () => {
  it("bietet je Zustand nur die passende Freigabe an", () => {
    expect(STAGE_FOR_STATE.checked).toBe("lead")
    expect(STAGE_FOR_STATE.page_ready).toBe("page")
    expect(STAGE_FOR_STATE.letter_ready).toBe("letter")
    for (const s of ["discovered", "approved", "researched", "page_approved", "letter_approved", "queued", "sent", "rejected", "suppressed", "failed"]) {
      expect(STAGE_FOR_STATE[s]).toBeUndefined()
    }
  })

  it("erlaubt Ablehnen nur, wo acq.allowed_transition es zulässt", () => {
    for (const s of ["checked", "page_ready", "letter_ready", "failed"]) expect(canReject(s)).toBe(true)
    for (const s of ["page_approved", "letter_approved", "queued", "sent", "rejected", "suppressed"]) expect(canReject(s)).toBe(false)
  })

  it("macht nach Fehler nie direkt in einer Freigabe weiter", () => {
    expect(canResume("failed", "letter_ready")).toBe(true)
    expect(canResume("failed", "researched")).toBe(true)
    expect(canResume("failed", "letter_approved")).toBe(false)
    expect(canResume("failed", null)).toBe(false)
    expect(canResume("letter_ready", "researched")).toBe(false)
  })

  it("baut den Akteur nur aus gültigen Namen", () => {
    expect(actorFor("johannes")).toBe("human:johannes")
    expect(() => actorFor("system:acq")).toThrow()
    expect(() => actorFor("")).toThrow()
  })
})
