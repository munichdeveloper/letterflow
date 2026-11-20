import type { Sql } from "postgres"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/acq/store", () => ({ sqlAcqStore: () => ({}) }))
vi.mock("@/lib/server/db", () => ({ db: () => { throw new Error("keine Datenbank im Test") } }))
const advance = vi.hoisted(() => vi.fn())
vi.mock("@/lib/acq/pipeline", () => ({ advance }))

import { runChain } from "@/lib/server/chain"

/**
 * Gefälschter Sql-Client mit Pool (max Verbindungen) und Tabelle acq.chain_runs. Jede Abfrage hält eine Verbindung
 * nur für die Dauer der Abfrage. begin und reserve gibt es nicht: Wer sie nutzt, scheitert im Test.
 */
function fakeSql(max = 3) {
  const runs = new Map<string, string>()
  let busy = 0
  const waiting: (() => void)[] = []
  const acquire = async () => {
    if (busy >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    busy++
  }
  const release = () => {
    busy--
    waiting.shift()?.()
  }
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    await acquire()
    try {
      await new Promise((resolve) => setTimeout(resolve, 1))
      const text = strings.join("?")
      if (text.includes("insert into acq.chain_runs")) {
        const [key, runId] = values as string[]
        if (runs.has(key)) return []
        runs.set(key, runId)
        return [{ run_id: runId }]
      }
      if (text.includes("delete from acq.chain_runs")) {
        const [key, runId] = values as string[]
        if (runs.get(key) === runId) runs.delete(key)
        return []
      }
      if (text.includes("acq.integrations")) return []
      throw new Error(`unerwartete Abfrage: ${text}`)
    } finally {
      release()
    }
  }) as unknown as Sql
  return { sql, runs }
}

const env = {}

describe("runChain: Sperre je Kampagne", () => {
  // Block statt Ausdruck: Gibt beforeEach eine Funktion zurück, ruft Vitest sie als Aufräumfunktion auf, hier also advance.
  beforeEach(() => {
    advance.mockReset()
  })

  it("zwei gleichzeitige Läufe für dieselbe Kampagne: genau einer läuft", async () => {
    const { sql } = fakeSql()
    let release!: () => void
    advance.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    const first = runChain(sql, "k1", env)
    await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(1))
    const second = await runChain(sql, "k1", env)
    expect(second.ran).toBe(false)
    expect(second.lines.join(" ")).toContain("läuft schon ein Lauf")
    release()
    expect((await first).ran).toBe(true)
    expect(advance).toHaveBeenCalledTimes(1)
  })

  it("drei gleichzeitige Läufe für verschiedene Kampagnen bei max 3 hängen nicht", async () => {
    const { sql, runs } = fakeSql(3)
    advance.mockImplementation(async () => {
      // advance braucht selbst Verbindungen, solange die Läufe offen sind
      await sql`select 1 from acq.integrations`
      await new Promise((resolve) => setTimeout(resolve, 5))
      await sql`select 1 from acq.integrations`
    })
    const results = await Promise.all(["a", "b", "c"].map((k) => runChain(sql, k, env)))
    expect(results.map((r) => r.ran)).toEqual([true, true, true])
    expect(runs.size).toBe(0)
  })

  it("wirft advance, ist die Sperre danach frei und ein neuer Lauf startet", async () => {
    const { sql, runs } = fakeSql()
    advance.mockRejectedValueOnce(new Error("Directus nicht erreichbar"))
    await expect(runChain(sql, "k1", env)).rejects.toThrow("Directus nicht erreichbar")
    expect(runs.size).toBe(0)
    advance.mockResolvedValueOnce(undefined)
    expect((await runChain(sql, "k1", env)).ran).toBe(true)
    expect(advance).toHaveBeenCalledTimes(2)
  })

  it("hält während advance keine Transaktion und keine reservierte Verbindung", async () => {
    const { sql } = fakeSql()
    expect((sql as { begin?: unknown }).begin).toBeUndefined()
    expect((sql as { reserve?: unknown }).reserve).toBeUndefined()
    advance.mockResolvedValue(undefined)
    expect((await runChain(sql, "k1", env)).ran).toBe(true)
  })
})
