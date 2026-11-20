import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { Seed, SeedPage } from "@/lib/acq/pipeline"
import type { LetterRow } from "@/lib/chain/letter-outbox"
import type { LetterPdfInput } from "@/lib/chain/letter-pdf"
import type { IntegrationConfig } from "@/lib/integrations"
import { chainDeps, type ChainModules } from "@/lib/server/chain"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/db", () => ({ db: () => { throw new Error("keine Datenbank im Test") } }))

const hash = (pdf: Uint8Array) => createHash("sha256").update(pdf).digest("hex")
const sql = (() => { throw new Error("keine Datenbank im Test") }) as never

const integrations: IntegrationConfig = {
  directus: { url: "https://cms.example.de", collection: "landingpages", siteUrl: "https://www.example.de" },
  pingen: { environment: "staging", organisationId: "00000000-0000-4000-8000-000000000001" },
  jev: { model: "jev-test", privacyMax: 0.3 },
}
const env = { DIRECTUS_SETUP_TOKEN: "test-token", TYPESAFE_API_KEY: "test-key" }

function page(slug: string, company: string): SeedPage {
  return {
    slug, company, salutation: "Sehr geehrte Damen und Herren,", headline: `Hallo ${company}`, intro: "Intro",
    observation: "Beobachtung", points: "Punkte", offer: "dsb",
    letter: { address: [company, "Geschäftsführung", "Musterweg 1", "12345 Musterstadt"], subject: "Datenschutz", body: ["Text"] },
  }
}

const seed: Seed = {
  campaign: "beispiel-kampagne",
  letter: {
    sender: "Beispiel Beratung · Musterweg 1 · 12345 Musterstadt",
    place: "Musterstadt",
    qrText: "Scannen Sie den QR-Code.",
    signature: ["Max Muster"],
    footer: "Werbung der Beispiel Beratung, Musterweg 1, 12345 Musterstadt.",
  },
  pages: [page("beispiel-gmbh", "Beispiel GmbH"), page("muster-ag", "Muster AG")],
}

/** Gefälschte Module: Leads, gespeicherte PDFs und Directus-Schlüssel im Speicher. */
function fakes(options: { urls?: string[] } = {}) {
  const leads = new Map([
    ["beispiel-gmbh", { id: "lead-1", letter_pdf_sha256: null as string | null }],
    ["muster-ag", { id: "lead-2", letter_pdf_sha256: null as string | null }],
  ])
  const stored = new Map<string, Uint8Array>() // `${leadId}/${sha256}`
  let built = 0
  const modules: Partial<ChainModules> = {
    now: () => new Date("2026-11-20T10:00:00Z"),
    leadBySlug: async (campaign, slug) => (campaign === seed.campaign ? leads.get(slug) : undefined),
    briefUrls: vi.fn(async (slugs: string[]) =>
      new Map(slugs.filter((s) => (options.urls ?? slugs).includes(s)).map((s) => [s, `https://www.example.de/fuer/${s}?k=abcdefghijklmnop`]))),
    buildLetterPdf: vi.fn(async ({ page, url, date }: LetterPdfInput) => new TextEncoder().encode(`%PDF ${page.slug} ${url} ${date?.toISOString()} #${++built}`)),
    saveLetterPdf: vi.fn(async (leadId: string, pdf: Uint8Array) => {
      const h = hash(pdf)
      stored.set(`${leadId}/${h}`, new Uint8Array(pdf))
      return h
    }),
    readLetterPdf: vi.fn(async (leadId: string, h: string) => stored.get(`${leadId}/${h}`)),
    uploadLetter: vi.fn(),
    syncLetter: vi.fn(),
    jevPrivacyScore: vi.fn(async () => ({ personal: 0.1, choice: "company" as const, model: "jev-test" })),
    pingen: vi.fn(() => ({}) as never),
  }
  return { leads, stored, modules }
}

describe("chainDeps", () => {
  it("buildLetters speichert jedes PDF für den Lead seiner Seite und gibt es zurück", async () => {
    const f = fakes()
    const deps = chainDeps(sql, integrations, env, { modules: f.modules, log: () => {} })
    const pdfs = await deps.buildLetters(seed)
    expect([...pdfs.keys()]).toEqual(["beispiel-gmbh", "muster-ag"])
    expect(f.modules.saveLetterPdf).toHaveBeenCalledTimes(2)
    expect(f.stored.get(`lead-1/${hash(pdfs.get("beispiel-gmbh")!)}`)).toEqual(pdfs.get("beispiel-gmbh"))
    expect(f.stored.get(`lead-2/${hash(pdfs.get("muster-ag")!)}`)).toEqual(pdfs.get("muster-ag"))
    expect(f.modules.buildLetterPdf).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://www.example.de/fuer/beispiel-gmbh?k=abcdefghijklmnop",
      date: new Date("2026-11-20T10:00:00Z"),
      letter: expect.objectContaining({ place: "Musterstadt", closing: "Mit freundlichen Grüßen" }),
    }))
    expect(f.modules.briefUrls).toHaveBeenCalledWith(["beispiel-gmbh", "muster-ag"], expect.objectContaining({ token: "test-token", collection: "landingpages" }))
  })

  it("readLetter liefert genau das gespeicherte PDF zum Hash des Leads", async () => {
    const f = fakes()
    const deps = chainDeps(sql, integrations, env, { modules: f.modules, log: () => {} })
    const first = await deps.buildLetters(seed)
    const second = await deps.buildLetters(seed) // neu gebaut: anderes PDF, anderer Hash
    expect(hash(second.get("beispiel-gmbh")!)).not.toBe(hash(first.get("beispiel-gmbh")!))

    expect(await deps.readLetter(seed.campaign, "beispiel-gmbh")).toBeUndefined() // noch kein Hash am Lead
    f.leads.get("beispiel-gmbh")!.letter_pdf_sha256 = hash(first.get("beispiel-gmbh")!)
    const read = await deps.readLetter(seed.campaign, "beispiel-gmbh")
    expect(read).toEqual(first.get("beispiel-gmbh"))
    expect(hash(read!)).toBe(f.leads.get("beispiel-gmbh")!.letter_pdf_sha256)
    expect(f.modules.readLetterPdf).toHaveBeenLastCalledWith("lead-1", hash(first.get("beispiel-gmbh")!))
    expect(await deps.readLetter(seed.campaign, "unbekannt")).toBeUndefined()
  })

  it("meldet eine fehlende Brief-URL verständlich und baut dann nichts", async () => {
    const f = fakes({ urls: ["beispiel-gmbh"] })
    const deps = chainDeps(sql, integrations, env, { modules: f.modules, log: () => {} })
    await expect(deps.buildLetters(seed)).rejects.toThrow(/Keine Brief-URL für muster-ag.*Schlüssel „brief“/)
    expect(f.modules.buildLetterPdf).not.toHaveBeenCalled()
    expect(f.modules.saveLetterPdf).not.toHaveBeenCalled()
  })

  it("lädt nur nach Staging hoch und meldet den Outbox-Status", async () => {
    const f = fakes()
    const letter = { id: "l1", status: "created" } as LetterRow
    f.modules.uploadLetter = vi.fn(async () => ({ slug: "beispiel-gmbh", action: "created" as const, letter }))
    const deps = chainDeps(sql, integrations, env, { modules: f.modules, log: () => {} })
    const pdf = new Uint8Array([1, 2, 3])
    expect(await deps.upload(seed.campaign, "beispiel-gmbh", "Beispiel GmbH", pdf)).toEqual({ action: "created", status: "created", error: undefined })

    const production = { ...integrations, pingen: { ...integrations.pingen, environment: "production" as const } }
    const blocked = chainDeps(sql, production, env, { modules: f.modules, log: () => {} })
    await expect(blocked.upload(seed.campaign, "beispiel-gmbh", "Beispiel GmbH", pdf)).rejects.toThrow(/staging/)
    await expect(blocked.sync(seed.campaign, "beispiel-gmbh")).rejects.toThrow(/staging/)
    expect(f.modules.uploadLetter).toHaveBeenCalledTimes(1)
  })

  it("fragt Jev mit dem Schlüssel aus der Umgebung und dem eingestellten Modell", async () => {
    const f = fakes()
    const contact = { company: "Beispiel GmbH", address: ["Beispiel GmbH", "Musterweg 1"], domain: "beispiel.de" }
    await chainDeps(sql, integrations, env, { modules: f.modules, log: () => {} }).privacyScore(contact)
    expect(f.modules.jevPrivacyScore).toHaveBeenCalledWith(contact, { key: "test-key", model: "jev-test" })
    await expect(chainDeps(sql, integrations, {}, { modules: f.modules }).privacyScore(contact)).rejects.toThrow(/TYPESAFE_API_KEY/)
  })
})
