import Link from "next/link"
import { Shell } from "@/components/shell"
import { STATE_LABELS, WAITING_FOR_HUMAN } from "@/lib/campaigns"
import { listCampaigns } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export default async function CampaignsPage() {
  const user = await requireUser()
  const campaigns = await listCampaigns()
  return (
    <Shell user={user.name}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Kampagnen</h1>
        <Link href="/campaigns/new">Neue Kampagne</Link>
      </div>
      {!campaigns.length && <p className="muted">Noch keine Kampagne.</p>}
      <div className="grid">
        {campaigns.map((c) => {
          const total = Object.values(c.counts).reduce((a, b) => a + b, 0)
          const waiting = WAITING_FOR_HUMAN.reduce((a, s) => a + (c.counts[s] ?? 0), 0)
          return (
            <div className="card" key={c.key}>
              <Link href={`/campaigns/${c.key}`}><strong>{c.title}</strong></Link>
              <div className="muted">{c.key} · Angebot {c.offer} · {c.status}</div>
              <p>{c.segment}</p>
              <div>{total} Leads{waiting ? <span className="warn"> · {waiting} warten auf Freigabe</span> : null}</div>
              {!c.interest_balancing_ref && <div className="bad">Interessenabwägung fehlt: keine Brieffreigabe möglich</div>}
              <div className="pills">
                {Object.entries(c.counts).map(([state, n]) => (
                  <span key={state} className={`pill${WAITING_FOR_HUMAN.includes(state) ? " wait" : ""}`}>{STATE_LABELS[state] ?? state}: {n}</span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </Shell>
  )
}
