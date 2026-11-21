import { readInterestBalancing } from "@/lib/server/interest-balancings"
import { requireUser } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/** Eine Version der Interessenabwägung, byte-genau wie hochgeladen. Nur mit Login; Content-Type aus der Tabelle. */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string; version: string }> }) {
  await requireUser()
  const { key, version } = await params
  const file = /^\d{1,9}$/.test(version) ? await readInterestBalancing(key, Number(version)) : undefined
  if (!file) return new Response("Diese Version der Interessenabwägung gibt es nicht.", { status: 404, headers: { "Cache-Control": "private, no-store" } })
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  })
}
