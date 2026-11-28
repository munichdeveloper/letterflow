import { notFound } from "next/navigation"
import { CampaignForm, InterestBalancingApprove, InterestBalancingUpload } from "@/components/forms"
import { Shell } from "@/components/shell"
import { LetterSettingsSchema, type CampaignInput } from "@/lib/campaigns"
import { interestBalancingLabel, isInterestBalancingApproved } from "@/lib/interest-balancing"
import { listInterestBalancings } from "@/lib/server/interest-balancings"
import { getCampaign } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

const time = (d: string | Date) => new Date(d).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })

export default async function EditCampaignPage({ params }: { params: Promise<{ key: string }> }) {
  const user = await requireUser()
  const { key } = await params
  const row = await getCampaign(key)
  if (!row) notFound()
  const balancings = await listInterestBalancings(key)
  const latest = balancings[0]
  const letter = LetterSettingsSchema.safeParse(row.letter)
  const campaign = {
    key: row.key,
    title: row.title,
    offer: row.offer,
    segment: row.segment,
    status: row.status,
    letter: letter.success ? letter.data : { ...(row.letter as object), signature: [] },
  } as CampaignInput
  return (
    <Shell user={user.name}>
      <h1>{row.title} bearbeiten</h1>

      <h2>Interessenabwägung</h2>
      <p className={isInterestBalancingApproved(latest) ? "ok" : "bad"}>
        {interestBalancingLabel(latest)}{isInterestBalancingApproved(latest) ? "" : ": keine Brieffreigabe möglich (Regel 7)"}
      </p>
      {latest && !latest.approved_at && (
        <InterestBalancingApprove campaign={row.key} id={latest.id} sha256={latest.sha256} version={latest.version} />
      )}
      {balancings.length > 0 && (
        <div className="scroll" style={{ margin: "12px 0" }}>
          <table>
            <thead><tr><th>Version</th><th>Datei</th><th>Hochgeladen</th><th>Freigabe</th></tr></thead>
            <tbody>
              {balancings.map((b) => (
                <tr key={b.id}>
                  <td>v{b.version}</td>
                  <td>
                    <a href={`/campaigns/${row.key}/interest-balancing/${b.version}`} target="_blank" rel="noreferrer">{b.file_name}</a>
                    <div className="muted">SHA-256 {b.sha256.slice(0, 12)}…</div>
                  </td>
                  <td>{time(b.uploaded_at)}<div className="muted">{b.uploaded_by}</div></td>
                  <td>{b.approved_at ? <>{time(b.approved_at)}<div className="muted">{b.approved_by}</div></> : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <InterestBalancingUpload campaign={row.key} />

      <h2>Kampagne</h2>
      <CampaignForm campaign={campaign} />
    </Shell>
  )
}
