import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import postgres, { type Sql } from "postgres"

/**
 * Wegwerf-Postgres für Tests der Migrationen. Entweder ACQ_TEST_DATABASE_URL (Superuser einer Test-Instanz; der Test legt
 * darin eine eigene Datenbank an und löscht sie danach) oder ein lokales initdb/pg_ctl (z. B. /usr/lib/postgresql/<v>/bin,
 * auf GitHub-Runnern vorinstalliert). Lässt sich kein Postgres starten, liefert startTestDatabase() einen Grund zum
 * Überspringen (mit ACQ_TEST_DATABASE_REQUIRED=1 stattdessen einen Fehler). Fehler in den Migrationen schlagen immer fehl.
 * Geladen werden das Testgerüst des Kerns (tests/fixtures/acq-core-stub.sql) und alle Dateien aus supabase/migrations/.
 */

export type TestDatabase = {
  /** Superuser, Eigentümer der Migrationen. */
  admin: Sql
  /** Eine Verbindung mit den Rechten von bos_automation, wie die App. */
  app: Sql
  stop(): Promise<void>
}

type Server = { connect(): Sql; stop(): Promise<void> }

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

function findPgBin() {
  const candidates = [process.env.PG_BIN]
  try {
    candidates.push(execFileSync("pg_config", ["--bindir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim())
  } catch {
    // kein pg_config
  }
  const base = "/usr/lib/postgresql"
  if (existsSync(base)) {
    for (const v of readdirSync(base).sort((a, b) => Number(b) - Number(a))) candidates.push(join(base, v, "bin"))
  }
  return candidates.find((dir): dir is string => !!dir && existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl")))
}

async function fromUrl(url: string): Promise<Server> {
  const server = postgres(url, { max: 1, onnotice: () => {} })
  const name = `letterflow_test_${process.pid}_${Date.now()}`
  await server.unsafe(`create database ${name}`)
  const target = new URL(url)
  target.pathname = `/${name}`
  const opened: Sql[] = []
  return {
    connect() {
      const sql = postgres(target.toString(), { max: 1, onnotice: () => {} })
      opened.push(sql)
      return sql
    },
    async stop() {
      await Promise.allSettled(opened.map((sql) => sql.end()))
      await server.unsafe(`drop database if exists ${name}`)
      await server.end()
    },
  }
}

async function local(bin: string): Promise<Server> {
  const dir = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "letterflow-pg-"))
  const data = join(dir, "data")
  const port = 20000 + Math.floor(Math.random() * 30000)
  const run = (cmd: string, args: string[]) => {
    const result = spawnSync(join(bin, cmd), args, { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`${cmd} fehlgeschlagen: ${result.stderr || result.stdout || result.error}`)
  }
  try {
    run("initdb", ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8", "--no-locale"])
    run("pg_ctl", ["-D", data, "-l", join(dir, "log"), "-w", "-t", "60", "-o", `-k ${dir} -c listen_addresses='' -p ${port} -c fsync=off`, "start"])
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  const opened: Sql[] = []
  return {
    connect() {
      const sql = postgres({ host: dir, port, user: "postgres", database: "postgres", max: 1, onnotice: () => {} })
      opened.push(sql)
      return sql
    },
    async stop() {
      await Promise.allSettled(opened.map((sql) => sql.end()))
      spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"])
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Startet die Test-Datenbank mit allen Migrationen oder liefert den Grund, warum kein Postgres verfügbar ist. */
export async function startTestDatabase(): Promise<TestDatabase | { skip: string }> {
  const url = process.env.ACQ_TEST_DATABASE_URL
  const bin = url ? undefined : findPgBin()
  let server: Server
  try {
    if (!url && !bin) throw new Error("kein Postgres gefunden (ACQ_TEST_DATABASE_URL setzen oder initdb/pg_ctl installieren)")
    if (!url && process.getuid?.() === 0) throw new Error("initdb läuft nicht als root (ACQ_TEST_DATABASE_URL setzen)")
    server = url ? await fromUrl(url) : await local(bin!)
  } catch (error) {
    if (process.env.ACQ_TEST_DATABASE_REQUIRED) throw error
    return { skip: error instanceof Error ? error.message : String(error) }
  }
  try {
    const admin = server.connect()
    await admin.unsafe(readFileSync(join(ROOT, "tests", "fixtures", "acq-core-stub.sql"), "utf8"))
    const migrations = join(ROOT, "supabase", "migrations")
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      await admin.unsafe(readFileSync(join(migrations, file), "utf8"))
    }
    const app = server.connect()
    await app`set role bos_automation`
    return { admin, app, stop: () => server.stop() }
  } catch (error) {
    await server.stop()
    throw error
  }
}
