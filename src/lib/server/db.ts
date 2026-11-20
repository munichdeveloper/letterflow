import "server-only"
import postgres from "postgres"
import { databaseTlsOptions } from "@/lib/server/database-tls"

let connection: ReturnType<typeof postgres> | undefined

/** Business-OS-Datenbank, Schema acq. Login mit Rolle bos_automation; Zustände nur über acq.transition. */
export function db() {
  const url = process.env.ACQ_DATABASE_URL
  if (!url) throw new Error("ACQ_DATABASE_URL fehlt (Business-OS-Datenbank, Login mit Rolle bos_automation).")
  connection ??= postgres(url, {
    ssl: databaseTlsOptions(process.env.ACQ_DATABASE_CA_CERT),
    max: 3,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 20,
    onnotice: () => {},
    connection: { application_name: "letterflow", statement_timeout: 10000 },
  })
  return connection
}
