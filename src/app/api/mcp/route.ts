import { handleMcpRequest } from "@/lib/mcp/server"
import { importLeads, importProposals } from "@/lib/acq/pipeline"
import { sqlAcqStore } from "@/lib/acq/store"
import { runChain } from "@/lib/server/chain"
import { db } from "@/lib/server/db"
import { campaignLeads, listCampaigns } from "@/lib/server/queries"

// MCP (Streamable HTTP, zustandslos). Eigene Bearer-Prüfung; Web-Cookies gelten hier nicht.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const handle = (request: Request) =>
  handleMcpRequest(request, {
    clientsConfig: process.env.LETTERFLOW_MCP_CLIENTS,
    listCampaigns,
    campaignLeads,
    importLeads: (batch, log) => importLeads(sqlAcqStore(db()), batch, log),
    importProposals: (batch, log) => importProposals(sqlAcqStore(db()), batch, log),
    // Roh-Logs bleiben im Server; das Tool liefert nur started/status.
    runPipeline: (campaign) => runChain(db(), campaign, process.env, () => {}),
  })

export const POST = handle
export const GET = handle
export const DELETE = handle
