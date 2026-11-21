-- letterflow: Interessenabwägung (Art. 6 Abs. 1 lit. f DSGVO) als Datei je Kampagne, versioniert und von einem
-- Menschen digital freigegeben. Regel 7 wird strenger: Ein Brief geht nur nach letter_approved, wenn die NEUESTE
-- Version der Kampagne freigegeben ist. acq.campaigns.interest_balancing_ref zählt dafür nicht mehr (Spalte bleibt).
-- Voraussetzung: business-os 20261120110000_acq_pipeline_core.sql (Schema acq, acq.campaigns, acq.leads, acq.events,
-- acq.transition, Rolle bos_automation).
--
-- Umsetzung von Regel 7: acq.transition ist der einzige Weg, einen Lead nach letter_approved zu bringen. Sie aktualisiert
-- dabei acq.leads und schreibt ein Ereignis in acq.events. Die Trigger unten hängen sich an genau diese beiden Schritte:
--   * acq.leads: kein Übergang nach letter_approved ohne freigegebene neueste Abwägung (Fehler bricht die Transaktion ab),
--   * acq.events: das Ereignis der Brieffreigabe bekommt im detail id, version und sha256 der geltenden Abwägung.
-- Die übrige Logik von acq.transition (erlaubte Übergänge, Mensch, Revision, PDF-Hash) bleibt unverändert.
-- Ihre alte Prüfung „interest_balancing_ref nicht leer“ erfüllt acq.approve_interest_balancing, indem sie eine leere
-- Spalte mit einem Verweis auf die freigegebene Version füllt; ein vorhandener Freitext bleibt stehen, zählt aber nicht.

create table acq.interest_balancings (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references acq.campaigns (id),
  -- je Kampagne fortlaufend, vergibt der Trigger acq.interest_balancings_before_insert
  version integer not null check (version >= 1),
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('text/markdown; charset=utf-8', 'application/pdf')),
  content bytea not null check (octet_length(content) between 1 and 2097152),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by text not null check (length(uploaded_by) between 1 and 100),
  uploaded_at timestamptz not null default now(),
  approved_by text check (approved_by ~ '^human:.+'),
  approved_at timestamptz,
  unique (campaign_id, version),
  check (sha256 = encode(pg_catalog.sha256(content), 'hex')),
  check ((approved_by is null) = (approved_at is null))
);
comment on table acq.interest_balancings is
  'Interessenabwägungen der Briefakquise (letterflow) je Kampagne, versioniert. Dateien werden nie geändert; '
  'freigeben nur über acq.approve_interest_balancing (Mensch). Regel 7 gilt für die neueste Version.';

-- Version vergeben, Freigabe beim Einfügen ausschließen. Die Sperre je Kampagne reiht gleichzeitige Uploads und
-- Freigaben hintereinander, damit „neueste Version“ eindeutig ist.
create function acq.interest_balancings_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('acq.interest_balancings:' || new.campaign_id::text, 0));
  select coalesce(max(b.version), 0) + 1 into new.version from acq.interest_balancings b where b.campaign_id = new.campaign_id;
  new.uploaded_at := pg_catalog.now();
  new.approved_by := null;
  new.approved_at := null;
  return new;
end $$;

create trigger interest_balancings_before_insert before insert on acq.interest_balancings
  for each row execute function acq.interest_balancings_before_insert();

-- Gespeicherte Dateien ändern sich nie. Erlaubt ist nur das einmalige Setzen der Freigabe.
create function acq.interest_balancings_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.campaign_id is distinct from old.campaign_id or new.version is distinct from old.version
     or new.file_name is distinct from old.file_name or new.content_type is distinct from old.content_type
     or new.content is distinct from old.content or new.sha256 is distinct from old.sha256
     or new.uploaded_by is distinct from old.uploaded_by or new.uploaded_at is distinct from old.uploaded_at then
    raise exception 'interest balancing files are immutable';
  end if;
  if old.approved_at is not null then
    raise exception 'interest balancing v% is already approved', old.version;
  end if;
  return new;
end $$;

create trigger interest_balancings_before_update before update on acq.interest_balancings
  for each row execute function acq.interest_balancings_before_update();

create function acq.interest_balancings_before_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'interest balancings are never deleted';
end $$;

create trigger interest_balancings_before_delete before delete on acq.interest_balancings
  for each row execute function acq.interest_balancings_before_delete();

-- Digitale Freigabe durch einen Menschen. p_sha256 ist der Hash, den die Person gesehen hat; nur die neueste Version.
create function acq.approve_interest_balancing(p_id uuid, p_sha256 text, p_actor text)
returns acq.interest_balancings
language plpgsql security definer set search_path = '' as $$
declare
  b acq.interest_balancings;
begin
  if p_actor is null or p_actor !~ '^human:.+' then
    raise exception 'interest balancing approval needs a human actor (got %)', coalesce(p_actor, 'null');
  end if;
  select * into b from acq.interest_balancings where id = p_id;
  if not found then
    raise exception 'interest balancing % not found', p_id;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('acq.interest_balancings:' || b.campaign_id::text, 0));
  select * into b from acq.interest_balancings where id = p_id for update;
  if p_sha256 is null or b.sha256 <> p_sha256 then
    raise exception 'interest balancing hash mismatch for v%', b.version;
  end if;
  if exists (select 1 from acq.interest_balancings o where o.campaign_id = b.campaign_id and o.version > b.version) then
    raise exception 'interest balancing v% is not the latest interest balancing of its campaign', b.version;
  end if;
  if b.approved_at is not null then
    return b; -- schon freigegeben, nichts ändern
  end if;
  update acq.interest_balancings set approved_by = p_actor, approved_at = pg_catalog.now() where id = p_id returning * into b;
  -- Alte Prüfung in acq.transition (Spalte nicht leer) erfüllen, ohne vorhandenen Text zu überschreiben.
  update acq.campaigns set interest_balancing_ref = 'letterflow:interest_balancings/' || b.id::text
  where id = b.campaign_id and coalesce(pg_catalog.btrim(interest_balancing_ref), '') = '';
  return b;
end $$;

-- Geltende Abwägung einer Kampagne: die neueste Version, falls freigegeben. Sonst Fehler (Regel 7).
create function acq.approved_interest_balancing(p_campaign_id uuid) returns acq.interest_balancings
language plpgsql security definer set search_path = '' as $$
declare
  b acq.interest_balancings;
begin
  select * into b from acq.interest_balancings where campaign_id = p_campaign_id order by version desc limit 1;
  if not found then
    raise exception 'letter approval needs an interest balancing: campaign % has none uploaded', p_campaign_id;
  end if;
  if b.approved_at is null then
    raise exception 'letter approval needs an approved interest balancing: latest version v% is not approved', b.version;
  end if;
  return b;
end $$;

-- Regel 7 am Lead: kein Übergang nach letter_approved ohne freigegebene neueste Abwägung.
create function acq.leads_require_interest_balancing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform acq.approved_interest_balancing(new.campaign_id);
  return new;
end $$;

create trigger leads_require_interest_balancing_insert before insert on acq.leads
  for each row when (new.state::text = 'letter_approved')
  execute function acq.leads_require_interest_balancing();
create trigger leads_require_interest_balancing_update before update of state on acq.leads
  for each row when (new.state::text = 'letter_approved' and old.state is distinct from new.state)
  execute function acq.leads_require_interest_balancing();

-- Ereignis der Brieffreigabe: id, version und sha256 der geltenden Abwägung festhalten.
create function acq.events_interest_balancing_detail() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b acq.interest_balancings;
begin
  b := acq.approved_interest_balancing((select l.campaign_id from acq.leads l where l.id = new.lead_id));
  new.detail := coalesce(new.detail, '{}'::jsonb)
    || pg_catalog.jsonb_build_object('interest_balancing', pg_catalog.jsonb_build_object('id', b.id, 'version', b.version, 'sha256', b.sha256));
  return new;
end $$;

create trigger events_interest_balancing_detail before insert on acq.events
  for each row when (new.to_state::text = 'letter_approved')
  execute function acq.events_interest_balancing_detail();

-- Rechte: nur lesen und einfügen (ohne version und Freigabe-Spalten), freigeben nur über die Funktion.
alter table acq.interest_balancings enable row level security;

revoke all on acq.interest_balancings from public, anon, authenticated;
grant select on acq.interest_balancings to bos_automation;
grant insert (campaign_id, file_name, content_type, content, sha256, uploaded_by) on acq.interest_balancings to bos_automation;

create policy interest_balancings_select on acq.interest_balancings for select to bos_automation using (true);
create policy interest_balancings_insert on acq.interest_balancings for insert to bos_automation with check (true);

revoke all on function acq.approve_interest_balancing(uuid, text, text) from public, anon, authenticated;
grant execute on function acq.approve_interest_balancing(uuid, text, text) to bos_automation;

revoke all on function acq.approved_interest_balancing(uuid) from public, anon, authenticated;
revoke all on function acq.interest_balancings_before_insert() from public, anon, authenticated;
revoke all on function acq.interest_balancings_before_update() from public, anon, authenticated;
revoke all on function acq.interest_balancings_before_delete() from public, anon, authenticated;
revoke all on function acq.leads_require_interest_balancing() from public, anon, authenticated;
revoke all on function acq.events_interest_balancing_detail() from public, anon, authenticated;
