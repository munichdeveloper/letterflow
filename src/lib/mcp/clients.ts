import { createHash, timingSafeEqual } from "node:crypto"

/**
 * MCP-Clients aus dem Secret LETTERFLOW_MCP_CLIENTS: JSON-Objekt clientId -> token.
 *   LETTERFLOW_MCP_CLIENTS='{"claude-desktop":"<token>","rotation-next":"<token>"}'
 * Token: mindestens 32 zufällige Bytes (z. B. `openssl rand -base64url 32` oder `openssl rand -hex 32`).
 * Jede Abweichung macht die ganze Konfiguration ungültig: Der Endpunkt bleibt dann geschlossen.
 */

export const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/
/** 32 Byte als base64url = 43 Zeichen, als Hex = 64 Zeichen. */
const MIN_TOKEN_LENGTH = 43
const MAX_TOKEN_LENGTH = 256
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/
const MIN_DISTINCT_CHARS = 10

export type McpClients = ReadonlyMap<string, Buffer>

export type ClientsConfig = { ok: true; clients: McpClients } | { ok: false; reason: string }

const digest = (value: string) => createHash("sha256").update(value).digest()

/** Gibt nie Tokenwerte im Grund zurück. */
export function parseMcpClients(raw: string | undefined): ClientsConfig {
  if (!raw || !raw.trim()) return { ok: false, reason: "LETTERFLOW_MCP_CLIENTS fehlt." }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "LETTERFLOW_MCP_CLIENTS ist kein gültiges JSON." }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "LETTERFLOW_MCP_CLIENTS muss ein JSON-Objekt clientId -> token sein." }
  }
  const clients = new Map<string, Buffer>()
  const seen = new Set<string>()
  for (const [id, token] of Object.entries(parsed)) {
    if (!CLIENT_ID_PATTERN.test(id)) return { ok: false, reason: "Ungültige Client-ID in LETTERFLOW_MCP_CLIENTS." }
    if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH ||
        !TOKEN_PATTERN.test(token) || new Set(token).size < MIN_DISTINCT_CHARS) {
      return { ok: false, reason: `Token von Client „${id}“ ist zu schwach (mindestens 32 zufällige Bytes).` }
    }
    const hash = digest(token)
    const hex = hash.toString("hex")
    if (seen.has(hex)) return { ok: false, reason: "Jeder Client braucht ein eigenes Token." }
    seen.add(hex)
    clients.set(id, hash)
  }
  if (clients.size === 0) return { ok: false, reason: "LETTERFLOW_MCP_CLIENTS enthält keinen Client." }
  return { ok: true, clients }
}

/** Client-ID zum Bearer-Token oder null. Vergleich über SHA-256 in konstanter Zeit, ohne frühen Abbruch. */
export function authenticateBearer(header: string | null | undefined, clients: McpClients): string | null {
  const match = /^Bearer +([^\s]+)$/i.exec(header?.trim() ?? "")
  if (!match) return null
  const given = digest(match[1])
  let found: string | null = null
  for (const [id, expected] of clients) {
    if (timingSafeEqual(given, expected)) found = id
  }
  return found
}
