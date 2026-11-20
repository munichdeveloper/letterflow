import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { COMMANDS, runCli, usage, type CliContext } from "@/lib/acq/cli"

function context() {
  const lines: string[] = []
  const store = new Proxy({}, { get: (_, name) => vi.fn(async () => { throw new Error(`store.${String(name)} unerwartet`) }) })
  const ctx: CliContext = {
    store: store as CliContext["store"],
    readFile: vi.fn(async () => "{}"),
    run: vi.fn(async () => ({ ran: true })),
    overview: vi.fn(async () => [{ company: "Beispiel GmbH", domain: "beispiel.de", slug: "beispiel-gmbh", state: "page_ready", state_reason: null, letter_status: null }]),
    log: (line) => lines.push(line),
  }
  return { ctx, lines, store }
}

const FREIGABE = /approv|freigab|release|letter_approved|page_approved/i

describe("Befehlszeile acq", () => {
  it("kennt genau die vier Befehle und keinen Freigabe-Befehl", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(["import-leads", "import-proposals", "run", "status"])
    for (const name of Object.keys(COMMANDS)) expect(name).not.toMatch(FREIGABE)
    expect(usage()).not.toMatch(/approv|release/i)
    expect(readFileSync(new URL("../scripts/acq.ts", import.meta.url), "utf8")).not.toMatch(/\bapprove\b|transition\(/)
  })

  it("lehnt Freigabe-Befehle als unbekannt ab", async () => {
    for (const name of ["approve", "freigeben", "approve-letter", "toString", "__proto__"]) {
      const { ctx } = context()
      const errors: string[] = []
      expect(await runCli([name, "beispiel-kampagne"], ctx, (l) => errors.push(l))).toBe(1)
      expect(errors[0]).toBe(`Unbekannter Befehl: ${name}`)
      expect(ctx.run).not.toHaveBeenCalled()
    }
  })

  it("führt run und status aus", async () => {
    const { ctx, lines } = context()
    expect(await runCli(["run", "beispiel-kampagne"], ctx)).toBe(0)
    expect(ctx.run).toHaveBeenCalledWith("beispiel-kampagne")
    expect(await runCli(["status", "beispiel-kampagne"], ctx)).toBe(0)
    expect(lines.at(-1)).toContain("beispiel.de (Beispiel GmbH)")
  })

  it("meldet einen schon laufenden Lauf und fehlende Argumente", async () => {
    const { ctx } = context()
    ctx.run = vi.fn(async () => ({ ran: false }))
    const errors: string[] = []
    expect(await runCli(["run", "beispiel-kampagne"], ctx, (l) => errors.push(l))).toBe(1)
    expect(errors[0]).toMatch(/läuft schon/)
    expect(await runCli(["import-leads"], ctx, () => {})).toBe(1)
    expect(await runCli([], ctx, () => {})).toBe(1)
  })
})
