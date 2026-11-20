import { describe, expect, it } from "vitest"
import type { Seed } from "@/lib/acq/pipeline"
import { briefUrls, setupPages, type DirectusDeps } from "@/lib/chain/directus-pages"

const TOKEN = "geheimes-test-token"
type Call = { method: string; path: string; body?: any }

function page(slug: string) {
  return {
    slug, company: "Beispiel GmbH", salutation: "Guten Tag", headline: "Hallo Beispiel GmbH", intro: "Intro", observation: "Beobachtung",
    points: "Punkte", offer: "dsb", letter: { address: ["Beispiel GmbH", "Musterweg 1"], subject: "Betreff", body: ["Text"] },
  }
}
const seed = (...slugs: string[]): Seed => ({ campaign: "muster-kampagne", letter: {}, pages: slugs.map(page) })

function fake(handler: (c: Call) => { status?: number; data?: unknown }) {
  const calls: Call[] = []
  const deps: DirectusDeps = {
    url: "https://cms.example.de/", collection: "landingpages", siteUrl: "https://www.example.de", token: TOKEN,
    fetch: async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`)
      const path = url.replace("https://cms.example.de", "")
      const call: Call = { method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      const r = handler(call)
      return new Response(JSON.stringify({ data: r.data }), { status: r.status ?? 200 })
    },
  }
  return { calls, deps }
}

describe("Directus-Seiten", () => {
  it("legt neue Seite und zwei Schlüssel an, ohne Brief", async () => {
    const { calls, deps } = fake((c) => {
      if (c.method === "GET") return { data: [] }
      if (c.path === "/items/landingpages") return { data: { id: 7 } }
      return { data: {} }
    })
    await setupPages(seed("beispiel-gmbh"), deps)
    const posts = calls.filter((c) => c.method === "POST")
    expect(posts).toHaveLength(3)
    expect(posts[0].body).toMatchObject({ slug: "beispiel-gmbh", campaign: "muster-kampagne", status: "published", offer: "dsb" })
    expect(posts[0].body).not.toHaveProperty("letter")
    expect(posts.slice(1).map((p) => p.body.purpose)).toEqual(["brief", "test"])
    for (const p of posts.slice(1)) {
      expect(p.path).toBe("/items/landingpages_keys")
      expect(p.body).toMatchObject({ landingpage: 7, active: true })
      expect(p.body.access_key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    }
  })

  it("aktualisiert vorhandene Seite nur in den Texten und legt keine Schlüssel an", async () => {
    const { calls, deps } = fake((c) => {
      if (c.path.startsWith("/items/landingpages?")) return { data: [{ id: 3 }] }
      if (c.path.startsWith("/items/landingpages_keys?")) return { data: [{ purpose: "brief", access_key: "a".repeat(22) }, { purpose: "test", access_key: "b".repeat(22) }] }
      return { data: {} }
    })
    await setupPages(seed("beispiel-gmbh"), deps)
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0)
    const patches = calls.filter((c) => c.method === "PATCH")
    expect(patches).toHaveLength(1)
    expect(patches[0].path).toBe("/items/landingpages/3")
    for (const field of ["slug", "letter", "status", "campaign"]) expect(patches[0].body).not.toHaveProperty(field)
    expect(patches[0].body.headline).toBe("Hallo Beispiel GmbH")
  })

  it("lehnt ungültige Slugs ab", async () => {
    const { calls, deps } = fake(() => ({ data: [] }))
    await expect(setupPages(seed("Ungültig Slug"), deps)).rejects.toThrow(/Ungültiger Slug/)
    expect(calls).toHaveLength(0)
  })

  it("meldet fehlende Website-URL und fehlendes Token verständlich", async () => {
    const { deps } = fake(() => ({ data: [] }))
    await expect(setupPages(seed("beispiel-gmbh"), { ...deps, siteUrl: "" })).rejects.toThrow(/Website-URL fehlt/)
    await expect(setupPages(seed("beispiel-gmbh"), { ...deps, token: "" })).rejects.toThrow(/DIRECTUS_SETUP_TOKEN/)
  })

  it("schreibt das Token nicht in Fehlertexte", async () => {
    const { deps } = fake(() => ({ status: 500, data: null }))
    const error = await setupPages(seed("beispiel-gmbh"), deps).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("500")
    expect((error as Error).message).not.toContain(TOKEN)
  })

  it("briefUrls liefert nur aktive brief-Schlüssel der angefragten Slugs", async () => {
    const { calls, deps } = fake(() => ({
      data: [
        { access_key: "a".repeat(22), landingpage: { slug: "beispiel-gmbh" } },
        { access_key: "b".repeat(22), landingpage: { slug: "andere-gmbh" } },
        { access_key: "kurz", landingpage: { slug: "zu-kurz" } },
      ],
    }))
    const urls = await briefUrls(["beispiel-gmbh", "zu-kurz", "fehlt"], deps)
    expect([...urls]).toEqual([["beispiel-gmbh", `https://www.example.de/fuer/beispiel-gmbh?k=${"a".repeat(22)}`]])
    const query = decodeURIComponent(calls[0].path)
    expect(query).toContain("filter[purpose][_eq]=brief")
    expect(query).toContain("filter[active][_eq]=true")
  })
})
