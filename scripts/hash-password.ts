/**
 * Passwort-Hash für LETTERFLOW_USERS erzeugen:
 *   npm run user:hash -- johannes
 * Liest das Passwort von stdin (nicht aus der Kommandozeile, damit es nicht in der Shell-Historie landet).
 */
import { createInterface } from "node:readline/promises"
import { hashPassword } from "../src/lib/auth"

const name = process.argv[2]?.trim().toLowerCase()
if (!name || !/^[a-z][a-z0-9-]{1,30}$/.test(name)) {
  console.error("Aufruf: npm run user:hash -- <name>")
  process.exit(1)
}
const rl = createInterface({ input: process.stdin, output: process.stderr })
const password = await rl.question("Passwort: ")
rl.close()
if (password.length < 12) {
  console.error("Bitte mindestens 12 Zeichen.")
  process.exit(1)
}
console.log(`${name}:${hashPassword(password)}`)
