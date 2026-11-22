import "server-only"
import type { Sql } from "postgres"
import { sha256 } from "@/lib/acq/pipeline"
import type { InterestBalancingFile, InterestBalancingStatus } from "@/lib/interest-balancing"
import { db } from "@/lib/server/db"

/**
 * Interessenabwägungen je Kampagne (acq.interest_balancings). Jede hochgeladene Datei wird eine neue Version; die
 * Datenbank vergibt die Versionsnummer, prüft den SHA-256 und erlaubt nur select und insert. Freigeben geht nur über
 * acq.approve_interest_balancing mit einem Menschen als Akteur, und nur für die neueste Version.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Speichert die Datei als neue Version der Kampagne. */
export async function saveInterestBalancing(campaignKey: string, file: InterestBalancingFile, actor: string, sql: Sql = db()) {
  const [row] = await sql<InterestBalancingStatus[]>`
    insert into acq.interest_balancings (campaign_id, file_name, content_type, content, sha256, uploaded_by)
    select c.id, ${file.fileName}, ${file.contentType}, ${new Uint8Array(file.content)}, ${sha256(file.content)}, ${actor}
    from acq.campaigns c where c.key = ${campaignKey}
    returning id, version, file_name, content_type, sha256, uploaded_by, uploaded_at, approved_by, approved_at`
  if (!row) throw new Error(`Kampagne „${campaignKey}“ gibt es nicht.`)
  return row
}

/** Alle Versionen einer Kampagne, neueste zuerst (ohne Inhalt). */
export async function listInterestBalancings(campaignKey: string, sql: Sql = db()) {
  return sql<InterestBalancingStatus[]>`
    select b.id, b.version, b.file_name, b.content_type, b.sha256, b.uploaded_by, b.uploaded_at, b.approved_by, b.approved_at
    from acq.interest_balancings b join acq.campaigns c on c.id = b.campaign_id
    where c.key = ${campaignKey} order by b.version desc`
}

/** Die Datei einer Version, byte-genau wie hochgeladen, oder undefined. */
export async function readInterestBalancing(campaignKey: string, version: number, sql: Sql = db()) {
  if (!Number.isSafeInteger(version) || version < 1) return undefined
  const [row] = await sql<{ file_name: string; content_type: string; sha256: string; content: Uint8Array }[]>`
    select b.file_name, b.content_type, b.sha256, b.content
    from acq.interest_balancings b join acq.campaigns c on c.id = b.campaign_id
    where c.key = ${campaignKey} and b.version = ${version}`
  if (!row) return undefined
  const content = new Uint8Array(row.content)
  if (sha256(content) !== row.sha256) throw new Error(`Gespeicherte Interessenabwägung v${version} passt nicht zu ihrem Hash.`)
  return { fileName: row.file_name, contentType: row.content_type, content }
}

/**
 * Digitale Freigabe durch einen Menschen (actor = human:<name>, aus der Sitzung). sha256 ist der Hash der Version,
 * die angezeigt wurde; die Datenbank lehnt andere Akteure, andere Hashes und ältere Versionen ab.
 */
export async function approveInterestBalancing(campaignKey: string, id: string, hash: string, actor: string, sql: Sql = db()) {
  if (!UUID.test(id)) throw new Error("Unbekannte Interessenabwägung.")
  const [own] = await sql<{ id: string }[]>`
    select b.id from acq.interest_balancings b join acq.campaigns c on c.id = b.campaign_id
    where c.key = ${campaignKey} and b.id = ${id}`
  if (!own) throw new Error("Diese Interessenabwägung gehört nicht zu dieser Kampagne.")
  const [row] = await sql<Pick<InterestBalancingStatus, "id" | "version" | "sha256" | "approved_by" | "approved_at">[]>`
    select b.id, b.version, b.sha256, b.approved_by, b.approved_at from acq.approve_interest_balancing(${id}, ${hash}, ${actor}) b`
  return row
}
