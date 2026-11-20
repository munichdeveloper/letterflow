import { describe, expect, it } from "vitest"
import { createPingenClient, PingenError, pingenConfig, type PingenConfig } from "@/lib/chain/pingen"
import { sha256, submitSandboxLetter, syncLetter, uploadLetter, type LetterRow, type LetterStatus, type OutboxStore, type RecordFields } from "@/lib/chain/letter-outbox"

const ORG = "00000000-0000-4000-8000-000000000001"
const config: PingenConfig = { environment: "staging", clientId: "test-id", clientSecret: "test-secret", organisationId: ORG }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown }

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { calls, impl }
}

function pingenHandler(overrides: { create?: () => Response; put?: () => Response; letter?: () => Response } = {}) {
  return (c: Call) => {
    if (c.url.endsWith("/auth/access-tokens")) return json({ access_token: "tok", expires_in: 3600 })
    if (c.url.endsWith("/file-upload")) return json({ data: { attributes: { url: "https://upload.example/file", url_signature: "sig" } } })
    if (c.method === "PUT") return overrides.put?.() ?? new Response(null, { status: 200 })
    if (c.method === "POST") return overrides.create?.() ?? json({ data: { id: "letter-1", attributes: { status: "draft", file_pages: 1, price_value: 0.9, price_currency: "EUR" } } })
    return overrides.letter?.() ?? json({ data: { id: "letter-1", attributes: { status: "draft" } } })
  }
}

function letterRow(patch: Partial<LetterRow> = {}): LetterRow {
  return {
    id: "row-1", campaign: "kampagne", landing_slug: "beispiel", company: "Beispiel GmbH", environment: "sandbox", idempotency_key: "key-1",
    pdf_sha256: "x", status: "queued", provider_letter_id: null, provider_status: null, attempts: 1, last_error: null, ...patch,
  }
}

function fakeStore(claim: { claimed: boolean; letter: LetterRow }) {
  const records: { id: string; status: LetterStatus; fields?: RecordFields }[] = []
  const store: OutboxStore = {
    async claim() { return claim },
    async record(id, status, fields) { records.push({ id, status, fields }); return letterRow({ id, status }) },
    async list() { return [] },
  }
  return { store, records }
}

const pdf = new Uint8Array([1, 2, 3])

describe("createPingenClient", () => {
  it("lehnt production ab", () => {
    expect(() => createPingenClient({ ...config, environment: "production" })).toThrow(/nur Staging/)
  })

  it("speichert die Anmeldung zwischen", async () => {
    const f = fakeFetch(pingenHandler())
    const client = createPingenClient(config, f.impl)
    await client.getLetter("letter-1")
    await client.getLetter("letter-1")
    expect(f.calls.filter((c) => c.url.endsWith("/auth/access-tokens"))).toHaveLength(1)
    expect(f.calls[0].url).toBe("https://identity-staging.pingen.com/auth/access-tokens")
    expect(f.calls[1].headers.Authorization).toBe("Bearer tok")
  })

  it("lädt GET file-upload → PUT → POST als Entwurf hoch", async () => {
    const f = fakeFetch(pingenHandler())
    const letter = await createPingenClient(config, f.impl).createDraftLetter(pdf, "beispiel.pdf", "key-1")
    const steps = f.calls.filter((c) => !c.url.endsWith("/auth/access-tokens")).map((c) => `${c.method} ${new URL(c.url).pathname}`)
    expect(steps).toEqual(["GET /file-upload", "PUT /file", `POST /organisations/${ORG}/deliveries/letters`])
    const post = f.calls.find((c) => c.method === "POST" && c.url.includes("/deliveries/letters"))!
    expect(post.headers["Idempotency-Key"]).toBe("key-1")
    const attributes = (JSON.parse(post.body as string) as { data: { attributes: Record<string, unknown> } }).data.attributes
    expect(attributes.auto_send).toBe(false)
    expect(letter).toEqual({ id: "letter-1", status: "draft", pages: 1, priceValue: 0.9, priceCurrency: "EUR" })
  })
})

describe("pingenConfig", () => {
  const env = { PINGEN_CLIENT_ID: "test-id", PINGEN_CLIENT_SECRET: "test-secret" }

  it("baut die Konfiguration aus Einstellung und Umgebung", () => {
    expect(pingenConfig({ environment: "staging", organisationId: ORG }, env)).toEqual(config)
  })

  it("lehnt production ab, auch ohne gesperrten AV-Vertrag", () => {
    expect(() => pingenConfig({ environment: "production", organisationId: ORG }, env)).toThrow(/nur die Umgebung „staging“/)
  })

  it("meldet fehlende Werte ohne Secrets", () => {
    expect(() => pingenConfig({ environment: "staging" }, env)).toThrow(/Organisations-ID/)
    const error = (() => { try { pingenConfig({ environment: "staging", organisationId: ORG }, { PINGEN_CLIENT_ID: "geheim-id" }) } catch (e) { return e as Error } })()!
    expect(error.message).toContain("PINGEN_CLIENT_SECRET")
    expect(error.message).not.toContain("geheim-id")
  })
})

describe("uploadLetter", () => {
  const fresh = () => fakeStore({ claimed: true, letter: letterRow() })

  it("legt den Brief an und speichert die Pingen-ID", async () => {
    const { store, records } = fresh()
    const result = await uploadLetter({ store, pingen: createPingenClient(config, fakeFetch(pingenHandler()).impl), campaign: "kampagne", slug: "beispiel", company: "Beispiel GmbH", pdf })
    expect(result.action).toBe("created")
    expect(records).toEqual([{ id: "row-1", status: "created", fields: { providerLetterId: "letter-1", providerStatus: "draft", priceValue: 0.9, priceCurrency: "EUR" } }])
  })

  it.each([400, 401, 404, 422])("4xx (%i) → failed", async (status) => {
    const { store, records } = fresh()
    const f = fakeFetch(pingenHandler({ create: () => new Response("kaputt", { status }) }))
    const result = await uploadLetter({ store, pingen: createPingenClient(config, f.impl), campaign: "kampagne", slug: "beispiel", company: "Beispiel GmbH", pdf })
    expect(result.action).toBe("failed")
    expect(records[0].status).toBe("failed")
    expect(records[0].fields?.error).toContain("kaputt")
  })

  it.each([408, 429, 500, 502, 503])("%i → unclear", async (status) => {
    const { store, records } = fresh()
    const f = fakeFetch(pingenHandler({ create: () => new Response("", { status }) }))
    const result = await uploadLetter({ store, pingen: createPingenClient(config, f.impl), campaign: "kampagne", slug: "beispiel", company: "Beispiel GmbH", pdf })
    expect(result.action).toBe("unclear")
    expect(records[0].status).toBe("unclear")
  })

  it("Netzwerkfehler → unclear", async () => {
    const { store, records } = fresh()
    const f = fakeFetch((c) => { if (c.method === "PUT") throw new TypeError("fetch failed"); return pingenHandler()(c) })
    const result = await uploadLetter({ store, pingen: createPingenClient(config, f.impl), campaign: "kampagne", slug: "beispiel", company: "Beispiel GmbH", pdf })
    expect(result).toMatchObject({ action: "unclear", error: "fetch failed" })
    expect(records[0].status).toBe("unclear")
  })

  it("PingenError mit 4xx beim PUT → failed", async () => {
    const { store } = fresh()
    const f = fakeFetch(pingenHandler({ put: () => new Response("", { status: 403 }) }))
    const result = await uploadLetter({ store, pingen: createPingenClient(config, f.impl), campaign: "kampagne", slug: "beispiel", company: "Beispiel GmbH", pdf })
    expect(result.action).toBe("failed")
  })

  it("überspringt bereits beanspruchte Briefe und meldet geänderte PDFs", async () => {
    for (const [stored, changed] of [[sha256(pdf), false], ["anderer-hash", true]] as const) {
      const { store, records } = fakeStore({ claimed: false, letter: letterRow({ pdf_sha256: stored, status: "created" }) })
      const f = fakeFetch(pingenHandler())
      const result = await uploadLetter({ store, pingen: createPingenClient(config, f.impl), campaign: "kampagne", slug: "beispiel", company: "Beispiel GmbH", pdf })
      expect(result).toMatchObject({ action: "skipped", pdfChanged: changed })
      expect(f.calls).toHaveLength(0)
      expect(records).toHaveLength(0)
    }
  })
})

describe("syncLetter", () => {
  const sync = async (providerStatus: string, status: LetterStatus) => {
    const { store, records } = fakeStore({ claimed: false, letter: letterRow() })
    const f = fakeFetch(pingenHandler({ letter: () => json({ data: { id: "letter-1", attributes: { status: providerStatus } } }) }))
    await syncLetter({ store, pingen: createPingenClient(config, f.impl), letter: letterRow({ status, provider_letter_id: "letter-1" }) })
    return records
  }

  it("setzt sent nur, wenn Pingen sent meldet", async () => {
    expect((await sync("sent", "unclear"))[0].status).toBe("sent")
    expect((await sync("processing", "unclear"))[0]).toMatchObject({ status: "unclear", fields: { providerStatus: "processing" } })
  })

  it("lässt Briefe ohne Pingen-ID unberührt", async () => {
    const { store, records } = fakeStore({ claimed: false, letter: letterRow() })
    const f = fakeFetch(pingenHandler())
    await syncLetter({ store, pingen: createPingenClient(config, f.impl), letter: letterRow({ status: "unclear" }) })
    expect(records).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
  })
})

describe("submitSandboxLetter", () => {
  it("versendet nur angelegte Sandbox-Briefe", async () => {
    const { store, records } = fakeStore({ claimed: false, letter: letterRow() })
    const f = fakeFetch(pingenHandler({ letter: () => json({ data: { id: "letter-1", attributes: { status: "submitted" } } }) }))
    const pingen = createPingenClient(config, f.impl)
    await submitSandboxLetter({ store, pingen, letter: letterRow({ status: "failed", provider_letter_id: "letter-1" }) })
    await submitSandboxLetter({ store, pingen, letter: letterRow({ status: "created", environment: "production", provider_letter_id: "letter-1" }) })
    expect(records).toHaveLength(0)
    await submitSandboxLetter({ store, pingen, letter: letterRow({ status: "created", provider_letter_id: "letter-1" }) })
    expect(records).toEqual([{ id: "row-1", status: "submitted", fields: { providerStatus: "submitted" } }])
    expect(f.calls.some((c) => c.method === "PATCH" && c.url.endsWith("/letter-1/send"))).toBe(true)
  })
})

describe("PingenError", () => {
  it("trägt Status und Detail", () => {
    const error = new PingenError("x", 418, "d")
    expect([error.status, error.detail]).toEqual([418, "d"])
  })
})
