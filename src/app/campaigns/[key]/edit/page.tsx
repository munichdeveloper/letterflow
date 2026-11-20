import { notFound } from "next/navigation"
import { CampaignForm } from "@/components/forms"
import { Shell } from "@/components/shell"
import { LetterSettingsSchema, type CampaignInput } from "@/lib/campaigns"
import { getCampaign } from "@/lib/server/queries"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export default async function EditCampaignPage({ params }: { params: Promise<{ key: string }> }) {
  const user = await requireUser()
  const { key } = await params
  const row = await getCampaign(key)
  if (!row) notFound()
  const letter = LetterSettingsSchema.safeParse(row.letter)
  const campaign = {
    key: row.key,
    title: row.title,
    offer: row.offer,
    segment: row.segment,
    interestBalancingRef: row.interest_balancing_ref,
    status: row.status,
    letter: letter.success ? letter.data : { ...(row.letter as object), signature: [] },
  } as CampaignInput
  return (
    <Shell user={user.name}>
      <h1>{row.title} bearbeiten</h1>
      <CampaignForm campaign={campaign} />
    </Shell>
  )
}
