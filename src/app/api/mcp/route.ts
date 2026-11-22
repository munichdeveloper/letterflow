import { handleMcpRequest } from "@/lib/mcp/server"
import { listCampaigns } from "@/lib/server/queries"

// MCP (Streamable HTTP, zustandslos). Eigene Bearer-Prüfung; Web-Cookies gelten hier nicht.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const handle = (request: Request) =>
  handleMcpRequest(request, { clientsConfig: process.env.LETTERFLOW_MCP_CLIENTS, listCampaigns })

export const POST = handle
export const GET = handle
export const DELETE = handle
