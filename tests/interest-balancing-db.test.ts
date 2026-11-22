import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/db", () => ({ db: () => { throw new Error("keine Produktionsdatenbank im Test") } }))

import { sha256 } from "@/lib/acq/pipeline"
import { interestBalancingFromForm } from "@/lib/interest-balancing"
import { approveInterestBalancing, listInterestBalancings, readInterestBalancing, saveInterestBalancing } from "@/lib/server/interest-balancings"
import { startTestDatabase, type TestDatabase } from "./helpers/postgres"

/**
 * Regel 7 in der Datenbank: Migration 20261121100000_acq_interest_balancings.sql gegen ein Testgerüst des Kerns
 * (tests/fixtures/acq-core-stub.sql). Nur erfundene Daten. Die App-Verbindung hat die Rechte von bos_automation.
 */

const started = await startTestDatabase()
const pg = "skip" in started ? undefined : started
if ("skip" in started) console.warn(`Datenbank-Tests übersprungen: ${started.skip}`)

const ACTOR = "human:johannes"
const PDF_HASH = "a".repeat(64)

function upload(name: string, content: string | Uint8Array<ArrayBuffer>, type = "") {
  const form = new FormData()
  form.set("file", new File([typeof content === "string" ? new TextEncoder().encode(content) : content], name, { type }))
  return interestBalancingFromForm(form)
}

async function createCampaign(sql: Sql, key: string, ref: string | null = null) {
  await sql`insert into acq.campaigns (key, title, offer, segment, interest_balancing_ref)
            values (${key}, 'Beispielkampagne', 'dsb', 'Beispiel GmbH und andere erfundene Firmen', ${ref})`
}

async function letterReadyLead(sql: Sql, campaign: string, domain: string) {
  const [lead] = await sql<{ id: string }[]>`
    insert into acq.leads (campaign_id, domain, company, state, letter_pdf_sha256)
    select id, ${domain}, 'Beispiel GmbH', 'letter_ready', ${PDF_HASH} from acq.campaigns where key = ${campaign}
    returning id`
  return lead.id
}

function approveLetter(sql: Sql, leadId: string) {
  return sql<{ state: string }[]>`select state from acq.transition(${leadId}, 'letter_approved', ${ACTOR}, null, ${sql.json({ pdf_sha256: PDF_HASH })})`
}

describe.skipIf(!pg)("Interessenabwägung in der Datenbank (Regel 7)", () => {
  const db = pg as TestDatabase
  let app: Sql

  beforeAll(() => {
    app = db.app
  })

  afterAll(async () => {
    await db.stop()
  })

  it("Upload einer .md- und einer .pdf-Datei legt Version 1 und 2 an", async () => {
    await createCampaign(app, "beispiel-upload")
    const md = await saveInterestBalancing("beispiel-upload", await upload("abwaegung.md", "# Interessenabwägung\n\nErfundenes Beispiel."), ACTOR, app)
    const pdf = await saveInterestBalancing("beispiel-upload", await upload("abwaegung.pdf", "%PDF-1.4\n% erfunden\n", "application/pdf"), ACTOR, app)
    expect([md.version, pdf.version]).toEqual([1, 2])
    expect(md).toMatchObject({ file_name: "abwaegung.md", content_type: "text/markdown; charset=utf-8", uploaded_by: ACTOR, approved_by: null, approved_at: null })
    expect(pdf).toMatchObject({ file_name: "abwaegung.pdf", content_type: "application/pdf", sha256: sha256("%PDF-1.4\n% erfunden\n") })
    expect((await listInterestBalancings("beispiel-upload", app)).map((b) => b.version)).toEqual([2, 1])
    const read = await readInterestBalancing("beispiel-upload", 1, app)
    expect(new TextDecoder().decode(read!.content)).toBe("# Interessenabwägung\n\nErfundenes Beispiel.")
    expect(read!.contentType).toBe("text/markdown; charset=utf-8")
  })

  it("lehnt andere Typen und Dateien über 2 MB mit verständlicher Meldung ab", async () => {
    await expect(upload("abwaegung.docx", "x")).rejects.toThrow(/weder Markdown \(\.md\) noch PDF/)
    const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x61)
    await expect(upload("abwaegung.md", big)).rejects.toThrow(/größer als 2 MB/)
    // Auch an der App vorbei nimmt die Datenbank nichts über 2 MB an
    await expect(app`
      insert into acq.interest_balancings (campaign_id, file_name, content_type, content, sha256, uploaded_by)
      select id, 'gross.md', 'text/markdown; charset=utf-8', ${big}, ${sha256(big)}, ${ACTOR} from acq.campaigns where key = 'beispiel-upload'`).rejects.toThrow()
  })

  it("acq.approve_interest_balancing: nur ein Mensch, nur der richtige Hash, nur die neueste Version", async () => {
    await createCampaign(app, "beispiel-freigabe")
    const v1 = await saveInterestBalancing("beispiel-freigabe", await upload("v1.md", "# Version 1"), ACTOR, app)
    const v2 = await saveInterestBalancing("beispiel-freigabe", await upload("v2.md", "# Version 2"), ACTOR, app)
    const call = (id: string, hash: string, actor: string) => app`select version from acq.approve_interest_balancing(${id}, ${hash}, ${actor})`
    await expect(call(v2.id, v2.sha256, "system:acq")).rejects.toThrow(/needs a human/)
    await expect(call(v2.id, v2.sha256, "agent:x")).rejects.toThrow(/needs a human/)
    await expect(call(v2.id, "0".repeat(64), ACTOR)).rejects.toThrow(/hash mismatch/)
    await expect(call(v1.id, v1.sha256, ACTOR)).rejects.toThrow(/not the latest/)
    const approved = await approveInterestBalancing("beispiel-freigabe", v2.id, v2.sha256, ACTOR, app)
    expect(approved).toMatchObject({ id: v2.id, version: 2, approved_by: ACTOR })
    expect(approved.approved_at).toBeTruthy()
    const [old] = await app<{ approved_at: Date | null }[]>`select approved_at from acq.interest_balancings where id = ${v1.id}`
    expect(old.approved_at).toBeNull()
  })

  it("acq.transition: Brieffreigabe nur mit freigegebener neuester Abwägung, Ereignis hält sie fest", async () => {
    // Altes Freitextfeld ist gefüllt, zählt aber nicht mehr
    await createCampaign(app, "beispiel-brief", "Abwägung liegt im Ordner")
    const first = await letterReadyLead(app, "beispiel-brief", "beispiel-eins.de")
    await expect(approveLetter(app, first)).rejects.toThrow(/interest balancing/)

    const v1 = await saveInterestBalancing("beispiel-brief", await upload("abwaegung.md", "# Abwägung v1"), ACTOR, app)
    await expect(approveLetter(app, first)).rejects.toThrow(/not approved/)

    await approveInterestBalancing("beispiel-brief", v1.id, v1.sha256, ACTOR, app)
    expect((await approveLetter(app, first))[0].state).toBe("letter_approved")
    const [event] = await app<{ detail: Record<string, any> }[]>`
      select detail from acq.events where lead_id = ${first} and to_state = 'letter_approved'`
    expect(event.detail.interest_balancing).toEqual({ id: v1.id, version: 1, sha256: v1.sha256 })
    expect(event.detail.pdf_sha256).toBe(PDF_HASH)

    // Neue Version hochgeladen, noch nicht freigegeben: wieder keine Brieffreigabe
    const second = await letterReadyLead(app, "beispiel-brief", "beispiel-zwei.de")
    await saveInterestBalancing("beispiel-brief", await upload("abwaegung.pdf", "%PDF-1.4\n% v2\n"), ACTOR, app)
    await expect(approveLetter(app, second)).rejects.toThrow(/v2 is not approved/)
    const [lead] = await app<{ state: string }[]>`select state from acq.leads where id = ${second}`
    expect(lead.state).toBe("letter_ready")
  })

  it("Brieffreigabe wartet auf einen gleichzeitigen Upload und prüft gegen die neue Version", async () => {
    await createCampaign(app, "beispiel-gleichzeitig")
    const lead = await letterReadyLead(app, "beispiel-gleichzeitig", "beispiel-vier.de")
    const v1 = await saveInterestBalancing("beispiel-gleichzeitig", await upload("v1.md", "# Abwägung v1"), ACTOR, app)
    await approveInterestBalancing("beispiel-gleichzeitig", v1.id, v1.sha256, ACTOR, app)
    const v2 = new TextEncoder().encode("# Abwägung v2")
    let approval: Promise<unknown> | undefined
    await db.admin.begin(async (tx) => {
      // Upload von v2 hält die Sperre der Kampagne bis zum Commit
      await tx`insert into acq.interest_balancings (campaign_id, file_name, content_type, content, sha256, uploaded_by)
               select id, 'v2.md', 'text/markdown; charset=utf-8', ${v2}, ${sha256(v2)}, ${ACTOR} from acq.campaigns where key = 'beispiel-gleichzeitig'`
      approval = approveLetter(app, lead).then(() => "freigegeben", (error: Error) => error.message)
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    expect(await approval).toMatch(/v2 is not approved/)
  })

  it("leere interest_balancing_ref blockiert nicht, wenn die neueste Version freigegeben ist", async () => {
    await createCampaign(app, "beispiel-ohne-ref")
    const lead = await letterReadyLead(app, "beispiel-ohne-ref", "beispiel-drei.de")
    const v1 = await saveInterestBalancing("beispiel-ohne-ref", await upload("abwaegung.md", "# Abwägung"), ACTOR, app)
    await approveInterestBalancing("beispiel-ohne-ref", v1.id, v1.sha256, ACTOR, app)
    expect((await approveLetter(app, lead))[0].state).toBe("letter_approved")
  })

  it("bos_automation kann gespeicherte Abwägungen weder ändern noch löschen noch vorab freigeben", async () => {
    await createCampaign(app, "beispiel-rechte")
    const v1 = await saveInterestBalancing("beispiel-rechte", await upload("abwaegung.md", "# Original"), ACTOR, app)
    await expect(app`update acq.interest_balancings set content = ${new TextEncoder().encode("# Anders")} where id = ${v1.id}`).rejects.toThrow(/permission denied/)
    await expect(app`update acq.interest_balancings set approved_by = ${ACTOR}, approved_at = now() where id = ${v1.id}`).rejects.toThrow(/permission denied/)
    await expect(app`delete from acq.interest_balancings where id = ${v1.id}`).rejects.toThrow(/permission denied/)
    await expect(app`
      insert into acq.interest_balancings (campaign_id, file_name, content_type, content, sha256, uploaded_by, approved_by, approved_at)
      select id, 'x.md', 'text/markdown; charset=utf-8', ${new TextEncoder().encode("# x")}, ${sha256("# x")}, ${ACTOR}, ${ACTOR}, now()
      from acq.campaigns where key = 'beispiel-rechte'`).rejects.toThrow(/permission denied/)
    await expect(app`
      insert into acq.interest_balancings (campaign_id, file_name, content_type, content, sha256, uploaded_by)
      select id, 'x.md', 'text/markdown; charset=utf-8', ${new TextEncoder().encode("# x")}, ${"0".repeat(64)}, ${ACTOR}
      from acq.campaigns where key = 'beispiel-rechte'`).rejects.toThrow(/check constraint/)
    // Selbst der Eigentümer kann den Inhalt nicht ändern oder Zeilen löschen
    await expect(db.admin`update acq.interest_balancings set file_name = 'anders.md' where id = ${v1.id}`).rejects.toThrow(/immutable/)
    await expect(db.admin`delete from acq.interest_balancings where id = ${v1.id}`).rejects.toThrow(/never deleted/)
    const [row] = await app<{ content: Uint8Array; approved_at: Date | null }[]>`select content, approved_at from acq.interest_balancings where id = ${v1.id}`
    expect(new TextDecoder().decode(row.content)).toBe("# Original")
    expect(row.approved_at).toBeNull()
  })

  it("anon und authenticated haben keine Rechte", async () => {
    for (const role of ["anon", "authenticated"]) {
      const [rights] = await db.admin<{ tbl: boolean; fn: boolean }[]>`
        select has_table_privilege(${role}, 'acq.interest_balancings', 'select,insert,update,delete') as tbl,
               has_function_privilege(${role}, 'acq.approve_interest_balancing(uuid, text, text)', 'execute') as fn`
      expect(rights).toEqual({ tbl: false, fn: false })
    }
  })
})
