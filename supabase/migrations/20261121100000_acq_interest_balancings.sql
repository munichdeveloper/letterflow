-- letterflow: Interessenabwägung (Art. 6 Abs. 1 lit. f DSGVO) als Datei je Kampagne, versioniert und von einem
-- Menschen digital freigegeben. Regel 7 wird strenger: Ein Brief geht nur nach letter_approved, wenn die NEUESTE
-- Version der Kampagne freigegeben ist. acq.campaigns.interest_balancing_ref zählt dafür nicht mehr (Spalte bleibt).
-- Voraussetzung: business-os 20261120110000_acq_pipeline_core.sql (Schema acq, acq.campaigns, acq.leads, acq.events,
-- acq.transition, Rolle bos_automation).
--
-- Umsetzung von Regel 7: acq.transition ist der einzige Weg, einen Lead nach letter_approved zu bringen. Diese Migration
-- ersetzt sie durch eine neue Fassung, die bis auf Regel 7 der Fassung aus dem Kern entspricht (erlaubte Übergänge,
-- Sperrliste, Mensch, Revision, PDF-Hash). Für letter_approved verlangt sie statt „interest_balancing_ref nicht leer“
-- die freigegebene neueste Abwägung der Kampagne, hält dafür die Sperre der Kampagne (kein Upload dazwischen) und
-- schreibt id, version und sha256 der Abwägung in das Ereignis.

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
  return b;
end $$;

-- Geltende Abwägung einer Kampagne: die neueste Version, falls freigegeben. Sonst Fehler (Regel 7).
-- Nimmt dieselbe Sperre je Kampagne wie Upload und Freigabe: Lädt jemand gleichzeitig eine neue Version hoch, wartet die
-- Brieffreigabe auf deren Commit und prüft dann gegen die neue (noch nicht freigegebene) Version.
create function acq.approved_interest_balancing(p_campaign_id uuid) returns acq.interest_balancings
language plpgsql security definer set search_path = '' as $$
declare
  b acq.interest_balancings;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('acq.interest_balancings:' || p_campaign_id::text, 0));
  select * into b from acq.interest_balancings where campaign_id = p_campaign_id order by version desc limit 1;
  if not found then
    raise exception 'letter approval needs an interest balancing: campaign % has none uploaded', p_campaign_id;
  end if;
  if b.approved_at is null then
    raise exception 'letter approval needs an approved interest balancing: latest version v% is not approved', b.version;
  end if;
  return b;
end $$;

-- acq.transition mit neuer Regel 7. Signatur, Rückgabe und Rechte bleiben wie im Kern.
create or replace function acq.transition(p_lead_id uuid, p_to text, p_actor text, p_reason text default null, p_detail jsonb default '{}'::jsonb)
returns acq.leads
language plpgsql security definer set search_path = '' as $$
declare
  v_lead acq.leads%rowtype;
  v_to text := p_to;
  v_reason text := p_reason;
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_balancing acq.interest_balancings%rowtype;
  v_prev text;
begin
  select * into v_lead from acq.leads where id = p_lead_id for update;
  if not found then raise exception 'lead % not found', p_lead_id using errcode = 'P0002'; end if;
  if coalesce(pg_catalog.btrim(p_actor), '') = '' then raise exception 'actor required' using errcode = '22023'; end if;
  v_prev := v_lead.state;

  if v_to not in ('suppressed', 'rejected', 'failed') and acq.is_suppressed(v_lead.domain, v_lead.company) then
    v_to := 'suppressed';
    v_reason := 'Sperrliste';
  end if;

  if v_lead.state = 'failed' then
    if v_to <> coalesce(v_lead.resume_state, '') and v_to not in ('rejected', 'suppressed') then
      raise exception 'failed lead % can only resume to %', p_lead_id, v_lead.resume_state using errcode = '22023';
    end if;
  elsif not acq.allowed_transition(v_lead.state, v_to) then
    raise exception 'transition % -> % not allowed', v_lead.state, v_to using errcode = '22023';
  end if;

  if v_to in ('approved', 'page_approved', 'letter_approved') and p_actor !~ '^human:.+' then
    raise exception 'state % needs a human approval', v_to using errcode = '42501';
  end if;

  if v_to = 'page_approved' then
    if (v_detail->>'revision') is null
       or (v_detail->>'revision')::int <> (select max(revision) from acq.proposals where lead_id = p_lead_id) then
      raise exception 'page approval must name the latest proposal revision' using errcode = '22023';
    end if;
  end if;

  if v_to = 'letter_ready' and coalesce(v_detail->>'pdf_sha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'letter_ready needs pdf_sha256' using errcode = '22023';
  end if;

  if v_to = 'letter_approved' then
    if v_lead.letter_pdf_sha256 is null or v_detail->>'pdf_sha256' is distinct from v_lead.letter_pdf_sha256 then
      raise exception 'letter approval must name the current PDF hash' using errcode = '22023';
    end if;
    -- Regel 7: neueste Abwägung der Kampagne muss freigegeben sein. acq.approved_interest_balancing nimmt die Sperre der
    -- Kampagne bis zum Ende der Transaktion, damit kein Upload einer neueren Version dazwischen fällt.
    v_balancing := acq.approved_interest_balancing(v_lead.campaign_id);
    v_detail := v_detail || pg_catalog.jsonb_build_object('interest_balancing',
      pg_catalog.jsonb_build_object('id', v_balancing.id, 'version', v_balancing.version, 'sha256', v_balancing.sha256));
  end if;

  perform pg_catalog.set_config('acq.in_transition', 'on', true);
  update acq.leads l set
    state = v_to,
    state_reason = v_reason,
    resume_state = case when v_to = 'failed' then v_prev else null end,
    approved_revision = case
      when v_to = 'page_approved' then (v_detail->>'revision')::int
      when v_to = 'researched' then null
      else l.approved_revision end,
    letter_pdf_sha256 = case
      when v_to = 'letter_ready' then v_detail->>'pdf_sha256'
      when v_to = 'researched' then null
      else l.letter_pdf_sha256 end,
    approved_pdf_sha256 = case
      when v_to = 'letter_approved' then v_detail->>'pdf_sha256'
      when v_to in ('researched', 'letter_ready') then null
      else l.approved_pdf_sha256 end,
    updated_at = pg_catalog.now()
  where l.id = p_lead_id
  returning * into v_lead;
  perform pg_catalog.set_config('acq.in_transition', 'off', true);

  insert into acq.events (lead_id, from_state, to_state, actor, detail)
  values (p_lead_id, v_prev, v_to, p_actor, v_detail || pg_catalog.jsonb_build_object('reason', v_reason));
  return v_lead;
end $$;

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
