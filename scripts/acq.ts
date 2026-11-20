/**
 * Kette von der Befehlszeile:
 *   npm run acq -- import-leads <datei>
 *   npm run acq -- import-proposals <datei>
 *   npm run acq -- run <kampagne>
 *   npm run acq -- status <kampagne>
 * Keine Freigaben: die gibt nur ein Mensch in der App.
 * Läuft mit der Bedingung react-server (siehe package.json), weil die Servermodule `server-only` importieren.
 */
import { readFile } from "node:fs/promises"
import { runCli, type OverviewRow } from "../src/lib/acq/cli"
import { sqlAcqStore } from "../src/lib/acq/store"
import { runChain } from "../src/lib/server/chain"
import { db } from "../src/lib/server/db"

const argv = process.argv.slice(2)
let code = 1
try {
  // Verbindung erst beim ersten Zugriff: Die Hilfe braucht keine Datenbank.
  code = await runCli(argv, {
    get store() {
      return sqlAcqStore(db())
    },
    readFile: (path) => readFile(path, "utf8"),
    run: (campaign) => runChain(db(), campaign, process.env, (line) => console.log(line)),
    overview: (campaign) => db()<OverviewRow[]>`
      select company, domain, slug, state, state_reason, letter_status
      from acq.lead_overview where campaign = ${campaign} order by updated_at`,
    log: (line) => console.log(line),
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
}
if (process.env.ACQ_DATABASE_URL) await db().end({ timeout: 5 })
process.exit(code)
