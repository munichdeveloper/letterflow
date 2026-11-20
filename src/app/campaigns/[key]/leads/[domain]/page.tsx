import Link from "next/link"
import { notFound } from "next/navigation"
import { LeadDecision } from "@/components/decision"
import { Shell } from "@/components/shell"
import { letterAddress } from "@/lib/acq/rules"
import { canReject, canResume, STAGE_FOR_STATE, STAGE_LABELS } from "@/lib/approvals"
import { STATE_LABELS, WAITING_FOR_HUMAN } from "@/lib/campaigns"
import { getCampaign, leadDetail } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

const time = (d: Date) => new Date(d).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })

export default async function LeadPage({ params }: { params: Promise<{ key: string; domain: string }> }) {
  const user = await requireUser()
  const { key, domain } = await params
  const [campaign, detail] = await Promise.all([getCampaign(key), leadDetail(key, decodeURIComponent(domain))])
  if (!campaign || !detail) notFound()
  const { lead, evidence, events, proposal } = detail
  const stage = STAGE_FOR_STATE[lead.state]
  const page = proposal?.content?.page
  const letter = proposal?.content?.letter
  const missingBalancing = stage === "letter" && !campaign.interest_balancing_ref

  return (
    <Shell user={user.name}>
      <p><Link href={`/campaigns/${key}`}>← {campaign.title}</Link></p>
      <h1>{lead.company}</h1>
      <p className="muted">{lead.domain} · {lead.legal_form} · {lead.postal_code} {lead.city}</p>
      <p className={WAITING_FOR_HUMAN.includes(lead.state) ? "warn" : lead.state === "failed" || lead.state === "rejected" ? "bad" : undefined}>
        <strong>{STATE_LABELS[lead.state] ?? lead.state}</strong>
        {lead.state_reason && <> · {lead.state_reason}</>}
      </p>
      {missingBalancing && (
        <p className="bad">Für diese Kampagne fehlt die Interessenabwägung. <Link href={`/campaigns/${key}/edit`}>Eintragen</Link>, sonst lässt die Datenbank keine Brieffreigabe zu.</p>
      )}
      {stage === "letter" && (
        <p className="muted">Das PDF selbst liegt noch in dsb-new (Ansicht kommt mit letterflow#3). Freigegeben wird genau das PDF mit dem Hash {lead.letter_pdf_sha256?.slice(0, 12)}…</p>
      )}

      <LeadDecision
        campaign={key}
        domain={lead.domain}
        state={lead.state}
        approveLabel={stage && !missingBalancing ? STAGE_LABELS[stage] : undefined}
        revision={stage === "page" ? proposal?.revision : undefined}
        pdfSha256={stage === "letter" ? lead.letter_pdf_sha256 : undefined}
        canReject={canReject(lead.state)}
        canResume={canResume(lead.state, lead.resume_state)}
        resumeLabel={lead.resume_state ? `Weitermachen bei „${STATE_LABELS[lead.resume_state] ?? lead.resume_state}“` : undefined}
      />

      <h2>Warum diese Firma</h2>
      <p>{lead.fit_reason ?? "–"}</p>
      {lead.niche && <p className="muted">Nische: {lead.niche}</p>}

      <h2>Belege ({evidence.length})</h2>
      <div className="scroll">
        <table>
          <thead><tr><th>Ref</th><th>Art</th><th>Aussage</th><th>Quelle</th></tr></thead>
          <tbody>
            {evidence.map((e) => (
              <tr key={e.ref}>
                <td><code>{e.ref}</code></td>
                <td>{e.kind === "fact" ? "Fakt" : "Hypothese"}</td>
                <td>{e.claim}{e.quote && <div className="muted">„{e.quote}“</div>}</td>
                <td><a href={e.source_url} target="_blank" rel="noreferrer noopener">{new URL(e.source_url).pathname || "/"}</a><div className="muted">{time(e.retrieved_at)}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {proposal && (
        <>
          <h2>Seite (Revision {proposal.revision}{lead.approved_revision ? `, freigegeben: ${lead.approved_revision}` : ""})</h2>
          <div className="card">
            {lead.slug && <div className="muted">/{lead.slug}</div>}
            <h3 style={{ marginTop: 4 }}>{page?.headline}</h3>
            <p>{page?.intro}</p>
            {page?.observations?.map((o: { text: string; evidenceRef: string }, i: number) => (
              <p key={i}>{o.text} <span className="muted">[{o.evidenceRef}]</span></p>
            ))}
            {page?.proposal?.length > 0 && <ul>{page.proposal.map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>}
            <div className="muted">Angebot: {page?.offer ?? campaign.offer} · erstellt von {proposal.created_by}, {time(proposal.created_at)}</div>
          </div>

          <h2>Brief</h2>
          <div className="card">
            <div className="muted" style={{ whiteSpace: "pre-line" }}>
              {letterAddress({ company: lead.company, street: lead.street, postalCode: lead.postal_code, city: lead.city }).join("\n")}
            </div>
            <p><strong>{letter?.subject}</strong></p>
            <p>{String((campaign.letter as Record<string, unknown>).salutation ?? "Sehr geehrte Damen und Herren,")}</p>
            {letter?.body?.map((b: string, i: number) => <p key={i} style={{ whiteSpace: "pre-line" }}>{b}</p>)}
            <div className="muted">Belege: {letter?.evidenceRefs?.join(", ")}</div>
          </div>
        </>
      )}

      <h2>Verlauf</h2>
      <div className="scroll">
        <table>
          <thead><tr><th>Zeit</th><th>Schritt</th><th>Wer</th><th>Details</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>{time(e.created_at)}</td>
                <td>{e.from_state ? `${STATE_LABELS[e.from_state] ?? e.from_state} → ` : ""}{STATE_LABELS[e.to_state] ?? e.to_state}</td>
                <td>{e.actor}</td>
                <td className="muted">{Object.entries(e.detail ?? {}).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  )
}
