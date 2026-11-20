import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

/**
 * Login je Person. Freigaben in der Kette sind an einen Menschen gebunden (Akteur human:<name>),
 * deshalb kein gemeinsamer Zugangscode. Nutzer stehen in LETTERFLOW_USERS:
 *   LETTERFLOW_USERS="johannes:scrypt:<salt>:<hash>"   (mehrere mit Komma; Hash per npm run user:hash)
 * Die Sitzung ist ein HMAC-signiertes Cookie mit LETTERFLOW_SESSION_SECRET (mindestens 32 Zeichen).
 */

export const SESSION_COOKIE = "letterflow_session"
const SESSION_HOURS = 12

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  return `scrypt:${salt}:${scryptSync(password, salt, 32).toString("hex")}`
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split(":")
  if (scheme !== "scrypt" || !salt || !hash) return false
  const expected = Buffer.from(hash, "hex")
  const actual = scryptSync(password, salt, expected.length)
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function parseUsers(value = process.env.LETTERFLOW_USERS ?? "") {
  const users = new Map<string, string>()
  for (const entry of value.split(",").map((e) => e.trim()).filter(Boolean)) {
    const index = entry.indexOf(":")
    const name = entry.slice(0, index).trim().toLowerCase()
    if (index > 0 && /^[a-z][a-z0-9-]{1,30}$/.test(name)) users.set(name, entry.slice(index + 1).trim())
  }
  return users
}

function secret(value = process.env.LETTERFLOW_SESSION_SECRET) {
  if (!value || value.length < 32) throw new Error("LETTERFLOW_SESSION_SECRET fehlt oder ist kürzer als 32 Zeichen.")
  return value
}

const sign = (payload: string, key: string) => createHmac("sha256", key).update(payload).digest("base64url")

export function createSessionToken(name: string, now = Date.now(), key = secret()) {
  const payload = Buffer.from(JSON.stringify({ name, exp: now + SESSION_HOURS * 3600_000 })).toString("base64url")
  return `${payload}.${sign(payload, key)}`
}

export function readSessionToken(token: string | undefined, now = Date.now(), key = secret()): { name: string } | null {
  if (!token) return null
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null
  const expected = Buffer.from(sign(payload, key))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { name?: unknown; exp?: unknown }
    if (typeof data.name !== "string" || typeof data.exp !== "number" || data.exp < now) return null
    return { name: data.name }
  } catch {
    return null
  }
}

/** Liefert den Namen bei richtigem Passwort, sonst null. Gleiche Rechenzeit auch für unbekannte Namen. */
export function checkLogin(name: string, password: string, users = parseUsers()) {
  const key = name.trim().toLowerCase()
  const stored = users.get(key)
  const ok = verifyPassword(password, stored ?? hashPassword("x", "0".repeat(32)))
  return stored && ok ? key : null
}
