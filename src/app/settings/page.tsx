import { IntegrationForm } from "@/components/forms"
import { Shell } from "@/components/shell"
import { INTEGRATIONS, missingSecrets } from "@/lib/integrations"
import { listIntegrations, testDatabase } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const user = await requireUser()
  const [database, integrations] = await Promise.all([testDatabase(), listIntegrations().catch(() => null)])
  return (
    <Shell user={user.name}>
      <h1>Angebundene Systeme</h1>
      <p className="muted">Hier stehen nur Einstellungen ohne Geheimnisse. Tokens und Schlüssel kommen als Umgebungsvariablen in die App.</p>

      <div className="card">
        <strong>Business OS (Supabase, Schema acq)</strong>
        <p className={database.ok ? "ok" : "bad"}>{database.message}</p>
      </div>

      {!integrations && <p className="bad">Tabelle acq.integrations fehlt: Migration supabase/migrations/20261120150000_acq_integrations.sql einspielen.</p>}

      {integrations?.map(({ key, row }) => {
        const info = INTEGRATIONS[key]
        const missing = missingSecrets(key)
        return (
          <div className="card" key={key}>
            <strong>{info.title}</strong>
            <div className="muted">{info.purpose}</div>
            <p>
              Umgebungsvariablen: {info.secrets.map((s) => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}
              {missing.length ? <span className="bad"> fehlt: {missing.join(", ")}</span> : <span className="ok"> gesetzt</span>}
            </p>
            {row?.last_test_at && (
              <p className={row.last_test_ok ? "ok" : "bad"}>
                Letzter Test {new Date(row.last_test_at).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}: {row.last_test_message}
              </p>
            )}
            <IntegrationForm integration={key} config={row?.config ?? {}} avvSignedAt={row?.avv_signed_at ?? null} />
          </div>
        )
      })}
    </Shell>
  )
}
