"use client"

import { useActionState } from "react"
import { login, runIntegrationTest, saveCampaign, saveIntegrationSettings, type FormState } from "@/app/actions"
import { OFFERS, type CampaignInput } from "@/lib/campaigns"

function Status({ state }: { state: FormState }) {
  if (state.error) return <p className="bad" role="alert">{state.error}</p>
  if (state.ok) return <p className="ok">{state.ok}</p>
  return null
}

export function LoginForm() {
  const [state, action, pending] = useActionState(login, {})
  return (
    <form action={action} className="stack">
      <label>Name<input name="name" autoComplete="username" required /></label>
      <label>Passwort<input name="password" type="password" autoComplete="current-password" required /></label>
      <button disabled={pending}>Anmelden</button>
      <Status state={state} />
    </form>
  )
}

export function CampaignForm({ campaign }: { campaign?: CampaignInput }) {
  const [state, action, pending] = useActionState(saveCampaign, {})
  const l = campaign?.letter
  return (
    <form action={action} className="stack">
      {campaign && <input type="hidden" name="existingKey" value={campaign.key} />}
      <label>Schlüssel<small>Kleinbuchstaben und Bindestriche, z. B. controla-n8n-agenturen-2026-11. Später nicht änderbar.</small>
        <input name="key" defaultValue={campaign?.key} disabled={!!campaign} required={!campaign} pattern="[a-z0-9][a-z0-9-]{2,60}" />
      </label>
      <label>Titel<input name="title" defaultValue={campaign?.title} required maxLength={120} /></label>
      <label>Angebot
        <select name="offer" defaultValue={campaign?.offer ?? "dsb"}>
          {OFFERS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      <label>Segment<small>Wen die Kampagne anschreibt (nur GmbH, UG, AG).</small>
        <textarea name="segment" defaultValue={campaign?.segment} required maxLength={300} />
      </label>
      <label>Interessenabwägung<small>Verweis auf die dokumentierte Abwägung. Ohne sie lässt die Datenbank keine Brieffreigabe zu (Regel 7).</small>
        <input name="interestBalancingRef" defaultValue={campaign?.interestBalancingRef ?? ""} maxLength={300} />
      </label>
      {campaign && (
        <label>Status
          <select name="status" defaultValue={campaign.status}>
            <option value="active">aktiv</option><option value="paused">pausiert</option><option value="closed">abgeschlossen</option>
          </select>
        </label>
      )}
      <h2>Brief</h2>
      <label>Absenderzeile<input name="sender" defaultValue={l?.sender} required maxLength={200} /></label>
      <label>Ort (für das Datum)<input name="place" defaultValue={l?.place} required maxLength={60} /></label>
      <label>Anrede<input name="salutation" defaultValue={l?.salutation ?? "Sehr geehrte Damen und Herren,"} maxLength={80} /></label>
      <label>Text zum QR-Code<textarea name="qrText" defaultValue={l?.qrText} required maxLength={400} /></label>
      <label>Grußformel<input name="closing" defaultValue={l?.closing ?? "Mit freundlichen Grüßen"} maxLength={80} /></label>
      <label>Unterschrift<small>Eine Zeile je Zeile, höchstens vier.</small>
        <textarea name="signature" defaultValue={l?.signature.join("\n")} required />
      </label>
      <label>Fußzeile<small>Absender, Herkunft der Anschrift, Widerspruch, Datenschutz.</small>
        <textarea name="footer" defaultValue={l?.footer} required maxLength={600} />
      </label>
      <div className="row"><button disabled={pending}>{campaign ? "Speichern" : "Kampagne anlegen"}</button></div>
      <Status state={state} />
    </form>
  )
}

type IntegrationProps = {
  integration: "directus" | "pingen" | "jev"
  config: Record<string, unknown>
  avvSignedAt: string | null
}

export function IntegrationForm({ integration, config, avvSignedAt }: IntegrationProps) {
  const [saved, save, saving] = useActionState(saveIntegrationSettings, {})
  const [tested, test, testing] = useActionState(runIntegrationTest, {})
  const value = (k: string) => (config[k] === undefined ? "" : String(config[k]))
  return (
    <>
      <form action={save} className="stack">
        <input type="hidden" name="integration" value={integration} />
        {integration === "directus" && (
          <>
            <label>URL<input name="url" type="url" defaultValue={value("url")} placeholder="https://cms.example.de" /></label>
            <label>Collection der Landingpages<input name="collection" defaultValue={value("collection") || "landingpages"} /></label>
            <label>Website-URL (ohne abschließenden Slash)<input name="siteUrl" type="url" defaultValue={value("siteUrl")} placeholder="https://www.example.de" /></label>
          </>
        )}
        {integration === "pingen" && (
          <>
            <label>Umgebung
              <select name="environment" defaultValue={value("environment") || "staging"}>
                <option value="staging">Staging (Sandbox)</option>
                <option value="production" disabled={!avvSignedAt}>Produktion{avvSignedAt ? "" : " (gesperrt bis AV-Vertrag)"}</option>
              </select>
            </label>
            <label>Organisations-ID<input name="organisationId" defaultValue={value("organisationId")} /></label>
            <label>AV-Vertrag unterschrieben am<small>Erst danach ist Produktion wählbar. Echter Versand braucht zusätzlich deine Freigabe je Brief.</small>
              <input name="avvSignedAt" type="date" defaultValue={avvSignedAt ?? ""} />
            </label>
          </>
        )}
        {integration === "jev" && (
          <>
            <label>Modell<input name="model" defaultValue={value("model") || "jev-latest"} /></label>
            <label>Grenze „personenbezogen“<small>Ab dieser Wahrscheinlichkeit geht ein Brief nicht raus (Standard 0,3).</small>
              <input name="privacyMax" inputMode="decimal" defaultValue={value("privacyMax") || "0.3"} />
            </label>
          </>
        )}
        <div className="row"><button disabled={saving}>Speichern</button></div>
        <Status state={saved} />
      </form>
      <form action={test} className="row" style={{ marginTop: 8 }}>
        <input type="hidden" name="integration" value={integration} />
        <button className="secondary" disabled={testing}>{testing ? "Teste …" : "Verbindung testen"}</button>
      </form>
      <Status state={tested} />
    </>
  )
}
