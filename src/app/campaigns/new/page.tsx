import { CampaignForm } from "@/components/forms"
import { Shell } from "@/components/shell"
import { requireUser } from "@/lib/server/session"

export default async function NewCampaignPage() {
  const user = await requireUser()
  return (
    <Shell user={user.name}>
      <h1>Neue Kampagne</h1>
      <CampaignForm />
    </Shell>
  )
}
