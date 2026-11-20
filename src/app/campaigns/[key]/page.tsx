import Link from "next/link"
import { notFound } from "next/navigation"
import { Shell } from "@/components/shell"
import { STATE_LABELS, WAITING_FOR_HUMAN } from "@/lib/campaigns"
import { campaignLeads, getCampaign } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export default async function CampaignPage({ params }: { params: Promise<{ key: string }> }) {
  const user = await requireUser()
  const { key } = await params
  const campaign = await getCampaign(key)
  if (!campaign) notFound()
  const leads = await campaignLeads(key)
  return (
    <Shell user={user.name}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{campaign.title}</h1>
        <Link href={`/campaigns/${key}/edit`}>Bearbeiten</Link>
      </div>
      <p className="muted">{campaign.key} · Angebot {campaign.offer} · {campaign.status}</p>
      <p>{campaign.segment}</p>
      {campaign.interest_balancing_ref
        ? <p>Interessenabwägung: {campaign.interest_balancing_ref}</p>
        : <p className="bad">Interessenabwägung fehlt: Briefe dieser Kampagne können nicht freigegeben werden.</p>}
      <h2>Leads</h2>
      <p className="muted">Firma anklicken, um Belege, Seite und Brief zu sehen und freizugeben oder abzulehnen.</p>
      <div className="scroll">
        <table>
          <thead>
            <tr><th>Firma</th><th>Zustand</th><th>Seite</th><th>Belege</th><th>Brief</th><th>Geändert</th></tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <td><Link href={`/campaigns/${key}/leads/${l.domain}`}><strong>{l.company}</strong></Link><div className="muted">{l.domain}</div></td>
                <td className={WAITING_FOR_HUMAN.includes(l.state) ? "warn" : l.state === "failed" || l.state === "rejected" ? "bad" : undefined}>
                  {STATE_LABELS[l.state] ?? l.state}
                  {l.state_reason && <div className="muted">{l.state_reason}</div>}
                </td>
                <td>{l.slug ?? "–"}{l.latest_revision ? <div className="muted">Rev. {l.latest_revision}{l.approved_revision ? `, frei: ${l.approved_revision}` : ""}</div> : null}</td>
                <td>{l.evidence_count}</td>
                <td>{l.letter_status ?? "–"}</td>
                <td>{new Date(l.updated_at).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}</td>
              </tr>
            ))}
            {!leads.length && <tr><td colSpan={6} className="muted">Noch keine Leads.</td></tr>}
          </tbody>
        </table>
      </div>
    </Shell>
  )
}
