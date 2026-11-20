"use client"

import { useActionState, useState } from "react"
import { decideLead, type FormState } from "@/app/actions"

type Props = {
  campaign: string
  domain: string
  state: string
  approveLabel?: string
  revision?: number
  pdfSha256?: string | null
  canReject: boolean
  canResume: boolean
  resumeLabel?: string
}

/** Knöpfe für die Entscheidung eines Menschen. Jede Form schickt mit, was angezeigt wurde. */
export function LeadDecision(props: Props) {
  const [state, action, pending] = useActionState<FormState, FormData>(decideLead, {})
  const [rejecting, setRejecting] = useState(false)
  const hidden = (
    <>
      <input type="hidden" name="campaign" value={props.campaign} />
      <input type="hidden" name="domain" value={props.domain} />
      <input type="hidden" name="expectedState" value={props.state} />
      {props.revision !== undefined && <input type="hidden" name="revision" value={props.revision} />}
      {props.pdfSha256 && <input type="hidden" name="pdfSha256" value={props.pdfSha256} />}
    </>
  )
  if (!props.approveLabel && !props.canReject && !props.canResume) return null
  return (
    <div className="card">
      <div className="row">
        {props.approveLabel && (
          <form action={action}>
            {hidden}
            <input type="hidden" name="decision" value="approve" />
            <button disabled={pending}>{props.approveLabel}</button>
          </form>
        )}
        {props.canResume && (
          <form action={action}>
            {hidden}
            <input type="hidden" name="decision" value="resume" />
            <button className="secondary" disabled={pending}>{props.resumeLabel ?? "Weitermachen"}</button>
          </form>
        )}
        {props.canReject && !rejecting && (
          <button className="secondary" type="button" onClick={() => setRejecting(true)}>Ablehnen …</button>
        )}
      </div>
      {props.canReject && rejecting && (
        <form action={action} className="stack" style={{ marginTop: 12 }}>
          {hidden}
          <input type="hidden" name="decision" value="reject" />
          <label>Grund der Ablehnung<input name="reason" required minLength={3} maxLength={500} autoFocus /></label>
          <div className="row">
            <button disabled={pending}>Endgültig ablehnen</button>
            <button className="secondary" type="button" onClick={() => setRejecting(false)}>Abbrechen</button>
          </div>
        </form>
      )}
      {state.error && <p className="bad" role="alert">{state.error}</p>}
      {state.ok && <p className="ok">{state.ok}</p>}
    </div>
  )
}
