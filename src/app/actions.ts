"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { ZodError } from "zod"
import { checkLogin, createSessionToken, SESSION_COOKIE } from "@/lib/auth"
import type { LeadState } from "@/lib/acq/contracts"
import { approve } from "@/lib/acq/pipeline"
import { sqlAcqStore } from "@/lib/acq/store"
import { actorFor, canReject, canResume, STAGE_FOR_STATE } from "@/lib/approvals"
import { campaignFromForm } from "@/lib/campaigns"
import { INTEGRATION_KEYS, parseIntegrationConfig, testIntegration, type IntegrationKey } from "@/lib/integrations"
import { db } from "@/lib/server/db"
import { createCampaign, getIntegration, leadDetail, recordIntegrationTest, saveIntegration, updateCampaign } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export type FormState = { error?: string; ok?: string }

function message(error: unknown) {
  if (error instanceof ZodError) return error.issues.map((i) => `${i.path.join(".") || "Eingabe"}: ${i.message}`).join(" · ")
  const text = error instanceof Error ? error.message : String(error)
  // Meldungen von acq.transition verständlich machen
  if (/interest balancing/.test(text)) return "Für diese Kampagne fehlt die dokumentierte Interessenabwägung. Erst eintragen, dann den Brief freigeben."
  if (/needs a human approval/.test(text)) return "Diese Freigabe braucht einen Menschen."
  if (/not allowed/.test(text)) return `Dieser Schritt ist im aktuellen Zustand nicht erlaubt (${text}).`
  return text
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
  if (key === "directus") return { url: text("url"), collection: text("collection"), siteUrl: text("siteUrl") }
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

/**
 * Freigeben, Ablehnen oder nach Fehler weitermachen. Die Freigabe bindet sich an genau das, was angezeigt wurde:
 * Zustand, Seitentext-Revision bzw. PDF-Hash müssen noch stimmen, sonst wird nichts geändert.
 */
export async function decideLead(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser()
  const text = (name: string) => String(form.get(name) ?? "").trim()
  const campaign = text("campaign")
  const domain = text("domain")
  try {
    const actor = actorFor(user.name)
    const detail = await leadDetail(campaign, domain)
    if (!detail) throw new Error("Diesen Lead gibt es nicht.")
    const { lead, proposal } = detail
    if (lead.state !== text("expectedState")) throw new Error("Der Lead hat sich inzwischen geändert. Bitte die Seite neu laden.")
    const store = sqlAcqStore(db())
    const decision = text("decision")
    if (decision === "approve") {
      const stage = STAGE_FOR_STATE[lead.state]
      if (!stage) throw new Error("In diesem Zustand gibt es nichts freizugeben.")
      if (stage === "page" && String(proposal?.revision ?? "") !== text("revision")) throw new Error("Es gibt eine neuere Revision des Seitentextes. Bitte neu laden.")
      if (stage === "letter" && (lead.letter_pdf_sha256 ?? "") !== text("pdfSha256")) throw new Error("Das Brief-PDF hat sich geändert. Bitte neu laden.")
      await approve(store, campaign, domain, stage, user.name)
    } else if (decision === "reject") {
      const reason = text("reason")
      if (reason.length < 3) throw new Error("Bitte einen Grund angeben.")
      if (!canReject(lead.state)) throw new Error("In diesem Zustand kann der Lead nicht abgelehnt werden.")
      await store.transition(lead.id, "rejected", actor, reason.slice(0, 500))
    } else if (decision === "resume") {
      if (!canResume(lead.state, lead.resume_state)) throw new Error("Weitermachen geht nur nach technischem Fehler und nicht in eine Freigabe hinein.")
      const extra = lead.resume_state === "letter_ready" ? { pdf_sha256: lead.letter_pdf_sha256 } : {}
      await store.transition(lead.id, lead.resume_state as LeadState, actor, null, extra)
    } else {
      throw new Error("Unbekannte Entscheidung.")
    }
  } catch (error) {
    return { error: message(error) }
  }
  revalidatePath(`/campaigns/${campaign}`)
  revalidatePath(`/campaigns/${campaign}/leads/${domain}`)
  return { ok: "Gespeichert." }
}
