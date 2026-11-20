import { importLeads, importProposals } from "./pipeline"
import type { AcqStore } from "./store"

/**
 * Befehle von `npm run acq -- <befehl>`. Bewusst ohne Freigabe-Befehl: Freigaben gibt nur ein Mensch in der App.
 */

export type OverviewRow = { company: string; domain: string; slug: string | null; state: string; state_reason: string | null; letter_status: string | null }

export interface CliContext {
  store: AcqStore
  readFile(path: string): Promise<string>
  /** advance() für die Kampagne, mit Sperre gegen parallele Läufe. */
  run(campaign: string): Promise<{ ran: boolean }>
  overview(campaign: string): Promise<OverviewRow[]>
  log(line: string): void
}

type Command = { args: string; description: string; exec(arg: string, ctx: CliContext): Promise<void> }

async function readJson(ctx: CliContext, path: string) {
  try {
    return JSON.parse(await ctx.readFile(path)) as unknown
  } catch (error) {
    throw new Error(`${path}: kein lesbares JSON (${error instanceof Error ? error.message : error})`)
  }
}

export const COMMANDS: Record<string, Command> = {
  "import-leads": {
    args: "<datei>",
    description: "Leads des Agenten einlesen und mit den festen Regeln prüfen",
    async exec(file, ctx) {
      const summary = await importLeads(ctx.store, await readJson(ctx, file), (line) => ctx.log(line))
      ctx.log(`Geprüft ${summary.checked}, abgelehnt ${summary.rejected}, gesperrt ${summary.suppressed}, bekannt ${summary.known}`)
    },
  },
  "import-proposals": {
    args: "<datei>",
    description: "Seitenbeschreibungen des Agenten einlesen",
    async exec(file, ctx) {
      const summary = await importProposals(ctx.store, await readJson(ctx, file), (line) => ctx.log(line))
      ctx.log(`Gespeichert ${summary.stored}, unverändert ${summary.unchanged}, abgelehnt ${summary.refused}`)
    },
  },
  run: {
    args: "<kampagne>",
    description: "Kette bis zur nächsten Freigabe vorantreiben",
    async exec(campaign, ctx) {
      const { ran } = await ctx.run(campaign)
      if (!ran) throw new Error(`Für ${campaign} läuft schon ein Lauf.`)
    },
  },
  status: {
    args: "<kampagne>",
    description: "Zustand aller Leads der Kampagne (acq.lead_overview)",
    async exec(campaign, ctx) {
      const rows = await ctx.overview(campaign)
      if (!rows.length) return ctx.log(`Keine Leads in ${campaign}.`)
      for (const r of rows) {
        const extra = [r.slug, r.letter_status && `Brief ${r.letter_status}`, r.state_reason].filter(Boolean).join(" · ")
        ctx.log(`${r.state.padEnd(16)} ${r.domain} (${r.company})${extra ? ` – ${extra}` : ""}`)
      }
    },
  },
}

export function usage() {
  return [
    "Aufruf: npm run acq -- <befehl> <argument>",
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${`${name} ${c.args}`.padEnd(30)} ${c.description}`),
    "Freigaben gibt nur ein Mensch in der App.",
  ].join("\n")
}

/** Führt einen Befehl aus und liefert den Exit-Code. */
export async function runCli(argv: string[], ctx: CliContext, error: (line: string) => void = console.error): Promise<number> {
  const [name, arg, ...rest] = argv
  const command = name && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!command || !arg || rest.length) {
    if (name && !command) error(`Unbekannter Befehl: ${name}`)
    error(usage())
    return 1
  }
  try {
    await command.exec(arg, ctx)
    return 0
  } catch (e) {
    error(e instanceof Error ? e.message : String(e))
    return 1
  }
}
