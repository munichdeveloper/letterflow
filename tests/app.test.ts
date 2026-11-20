import { describe, expect, it } from "vitest"
import { checkLogin, createSessionToken, hashPassword, parseUsers, readSessionToken, verifyPassword } from "@/lib/auth"
import { campaignFromForm } from "@/lib/campaigns"
import { assertPingenAllowed, parseIntegrationConfig, testIntegration } from "@/lib/integrations"

const KEY = "k".repeat(40)

describe("Login", () => {
  it("prüft Passwörter und Nutzerliste", () => {
    const stored = hashPassword("ein-langes-passwort")
    expect(verifyPassword("ein-langes-passwort", stored)).toBe(true)
    expect(verifyPassword("falsch", stored)).toBe(false)
    const users = parseUsers(`Johannes:${stored}, kaputt, x:y`)
    expect([...users.keys()]).toEqual(["johannes"])
    expect(checkLogin("JOHANNES ", "ein-langes-passwort", users)).toBe("johannes")
    expect(checkLogin("johannes", "falsch", users)).toBeNull()
    expect(checkLogin("unbekannt", "ein-langes-passwort", users)).toBeNull()
  })

  it("akzeptiert nur signierte, nicht abgelaufene Sitzungen", () => {
    const token = createSessionToken("johannes", 1_000, KEY)
    expect(readSessionToken(token, 2_000, KEY)).toEqual({ name: "johannes" })
    expect(readSessionToken(token, 1_000 + 13 * 3600_000, KEY)).toBeNull()
    expect(readSessionToken(token, 2_000, "z".repeat(40))).toBeNull()
    const [payload, signature] = token.split(".")
    const forged = Buffer.from(JSON.stringify({ name: "admin", exp: 9e15 })).toString("base64url")
    expect(readSessionToken(`${forged}.${signature}`, 2_000, KEY)).toBeNull()
    expect(readSessionToken(payload, 2_000, KEY)).toBeNull()
  })
})

describe("Kampagnenformular", () => {
  it("liest Brief-Einstellungen und Unterschrift zeilenweise", () => {
    const form = new FormData()
    const fields: Record<string, string> = {
      key: "dsb-akquiseagenturen-2026-11", title: "DSB: Akquiseagenturen", offer: "dsb", segment: "Akquiseagenturen (GmbH/UG/AG)",
      sender: "Absender · Straße 1 · 80331 München", place: "München", qrText: "Scannen Sie den QR-Code.",
      signature: "Max Muster\r\nFirma · www.example.de\n", footer: "Werbung von … Widerspruch genügt formlos.", interestBalancingRef: "",
    }
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    const input = campaignFromForm(form)
    expect(input.letter.signature).toEqual(["Max Muster", "Firma · www.example.de"])
    expect(input.letter.salutation).toBe("Sehr geehrte Damen und Herren,")
    expect(input.interestBalancingRef).toBeNull()
    expect(input.status).toBe("active")
    form.set("key", "Mit Leerzeichen")
    expect(() => campaignFromForm(form)).toThrow()
  })
})

describe("Angebundene Systeme", () => {
  it("lehnt Secrets in den Einstellungen ab", () => {
    expect(() => parseIntegrationConfig("directus", { url: "https://cms.example.de", token: "geheim" })).toThrow()
    expect(() => parseIntegrationConfig("directus", { url: "http://cms.example.de" })).toThrow()
    expect(parseIntegrationConfig("jev", {})).toEqual({ model: "jev-latest", privacyMax: 0.3 })
  })

  it("sperrt Pingen Produktion ohne AV-Vertrag", () => {
    expect(() => assertPingenAllowed({ environment: "production" }, null)).toThrow(/AV-Vertrag/)
    expect(() => assertPingenAllowed({ environment: "production" }, "2026-11-21")).not.toThrow()
    expect(() => assertPingenAllowed({ environment: "staging" }, null)).not.toThrow()
  })

  it("meldet fehlende Umgebungsvariablen, ohne etwas aufzurufen", async () => {
    let called = false
    const result = await testIntegration("pingen", { environment: "staging" }, { env: {}, fetcher: async () => { called = true; return new Response() } })
    expect(result).toEqual({ ok: false, message: "Fehlt in der Umgebung: PINGEN_CLIENT_ID, PINGEN_CLIENT_SECRET" })
    expect(called).toBe(false)
  })

  it("testet Pingen gegen den Identity-Host der Umgebung", async () => {
    const urls: string[] = []
    const env = { PINGEN_CLIENT_ID: "id", PINGEN_CLIENT_SECRET: "secret" }
    const fetcher = async (url: string) => { urls.push(url); return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 }) }
    const ok = await testIntegration("pingen", { environment: "staging", organisationId: "00000000-0000-4000-8000-000000000001" }, { env, fetcher })
    expect(ok.ok).toBe(true)
    expect(urls).toEqual(["https://identity-staging.pingen.com/auth/access-tokens"])
    const blocked = await testIntegration("pingen", { environment: "production", organisationId: "00000000-0000-4000-8000-000000000001" }, { env, fetcher })
    expect(blocked.ok).toBe(false)
    expect(urls).toHaveLength(1)
  })

  it("meldet abgelehnte Directus-Tokens verständlich", async () => {
    const result = await testIntegration(
      "directus",
      { url: "https://cms.example.de/", collection: "landingpages" },
      { env: { DIRECTUS_SETUP_TOKEN: "t" }, fetcher: async (url) => { expect(url).toBe("https://cms.example.de/collections/landingpages"); return new Response("", { status: 403 }) } },
    )
    expect(result).toEqual({ ok: false, message: "Token wird abgelehnt (HTTP 403)." })
  })
})
