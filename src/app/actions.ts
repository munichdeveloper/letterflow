"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { ZodError } from "zod"
import { checkLogin, createSessionToken, SESSION_COOKIE } from "@/lib/auth"
import { campaignFromForm } from "@/lib/campaigns"
import { INTEGRATION_KEYS, parseIntegrationConfig, testIntegration, type IntegrationKey } from "@/lib/integrations"
import { createCampaign, getIntegration, recordIntegrationTest, saveIntegration, updateCampaign } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export type FormState = { error?: string; ok?: string }

function message(error: unknown) {
  if (error instanceof ZodError) return error.issues.map((i) => `${i.path.join(".") || "Eingabe"}: ${i.message}`).join(" · ")
  return error instanceof Error ? error.message : String(error)
}

export async function login(_: FormState, form: FormData): Promise<FormState> {
  const name = checkLogin(String(form.get("name") ?? ""), String(form.get("password") ?? ""))
  if (!name) return { error: "Name oder Passwort stimmt nicht." }
  ;(await cookies()).set(SESSION_COOKIE, createSessionToken(name), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 12 * 3600,
  })
  redirect("/")
}

export async function logout() {
  ;(await cookies()).delete(SESSION_COOKIE)
  redirect("/login")
}

export async function saveCampaign(_: FormState, form: FormData): Promise<FormState> {
  await requireUser()
  const existing = String(form.get("existingKey") ?? "")
  let key: string
  try {
    if (existing) form.set("key", existing) // Schlüssel ist beim Bearbeiten fest
    const input = campaignFromForm(form)
    key = existing ? await updateCampaign(existing, input) : await createCampaign(input)
  } catch (error) {
    return { error: message(error) }
  }
  revalidatePath("/")
  redirect(`/campaigns/${key}`)
}

function integrationKey(form: FormData): IntegrationKey {
  const key = String(form.get("integration") ?? "")
  if (!(INTEGRATION_KEYS as readonly string[]).includes(key)) throw new Error("Unbekanntes System")
  return key as IntegrationKey
}

function configFromForm(key: IntegrationKey, form: FormData) {
  const text = (name: string) => String(form.get(name) ?? "").trim() || undefined
  if (key === "directus") return { url: text("url"), collection: text("collection") }
  if (key === "pingen") return { environment: text("environment"), organisationId: text("organisationId") }
  const max = text("privacyMax")
  return { model: text("model"), privacyMax: max === undefined ? undefined : Number(max.replace(",", ".")) }
}

export async function saveIntegrationSettings(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser()
  try {
    const key = integrationKey(form)
    await saveIntegration(key, configFromForm(key, form), String(form.get("avvSignedAt") ?? "") || null, `human:${user.name}`)
    revalidatePath("/settings")
    return { ok: "Gespeichert." }
  } catch (error) {
    return { error: message(error) }
  }
}

export async function runIntegrationTest(_: FormState, form: FormData): Promise<FormState> {
  await requireUser()
  try {
    const key = integrationKey(form)
    const row = await getIntegration(key)
    if (!row) return { error: "Erst die Einstellungen speichern." }
    const result = await testIntegration(key, parseIntegrationConfig(key, row.config), { avvSignedAt: row.avv_signed_at })
    await recordIntegrationTest(key, result)
    revalidatePath("/settings")
    return result.ok ? { ok: result.message } : { error: result.message }
  } catch (error) {
    return { error: message(error) }
  }
}
