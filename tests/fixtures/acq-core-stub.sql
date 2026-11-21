-- Testgerüst: stark verkleinerte Nachbildung des Kerns aus business-os 20261120110000_acq_pipeline_core.sql, nur so
-- viel, dass die Migrationen von letterflow in einer leeren Test-Datenbank laufen. NICHT der echte Kern und nie in
-- eine echte Datenbank einspielen. Wie der Kern verlangt acq.transition für Freigaben einen Menschen, bindet die
-- Brieffreigabe an den PDF-Hash und prüft (alte Regel 7) nur, dass interest_balancing_ref nicht leer ist.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bos_automation') then create role bos_automation; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;

create schema acq;
grant usage on schema acq to bos_automation;

create table acq.campaigns (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  title text not null,
  offer text not null,
  segment text not null,
  letter jsonb not null default '{}'::jsonb,
  interest_balancing_ref text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table acq.leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references acq.campaigns (id),
  domain text not null,
  company text not null,
  state text not null default 'discovered',
  state_reason text,
  letter_pdf_sha256 text,
  approved_pdf_sha256 text,
  updated_at timestamptz not null default now(),
  unique (campaign_id, domain)
);

create table acq.events (
  id bigserial primary key,
  lead_id uuid not null references acq.leads (id),
  from_state text,
  to_state text not null,
  actor text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function acq.transition(p_lead_id uuid, p_to text, p_actor text, p_reason text default null, p_detail jsonb default '{}'::jsonb)
returns acq.leads
language plpgsql security definer set search_path = '' as $$
declare
  l acq.leads;
  c acq.campaigns;
begin
  select * into l from acq.leads where id = p_lead_id for update;
  if not found then raise exception 'lead % not found', p_lead_id; end if;
  if p_to in ('approved', 'page_approved', 'letter_approved') and p_actor !~ '^human:.+' then
    raise exception 'transition to % needs a human approval', p_to;
  end if;
  if not (l.state, p_to) in (('letter_ready', 'letter_approved'), ('page_approved', 'letter_ready'), ('letter_ready', 'rejected')) then
    raise exception 'transition % -> % not allowed', l.state, p_to;
  end if;
  if p_to = 'letter_ready' then
    l.letter_pdf_sha256 := p_detail->>'pdf_sha256';
  end if;
  if p_to = 'letter_approved' then
    select * into c from acq.campaigns where id = l.campaign_id;
    if coalesce(btrim(c.interest_balancing_ref), '') = '' then
      raise exception 'campaign % has no documented interest balancing', c.key;
    end if;
    if p_detail->>'pdf_sha256' is distinct from l.letter_pdf_sha256 then
      raise exception 'letter approval does not match the current pdf';
    end if;
    l.approved_pdf_sha256 := l.letter_pdf_sha256;
  end if;
  insert into acq.events (lead_id, from_state, to_state, actor, detail) values (l.id, l.state, p_to, p_actor, p_detail);
  update acq.leads set state = p_to, state_reason = p_reason, letter_pdf_sha256 = l.letter_pdf_sha256,
    approved_pdf_sha256 = l.approved_pdf_sha256, updated_at = now()
  where id = l.id returning * into l;
  return l;
end $$;

revoke all on function acq.transition(uuid, text, text, text, jsonb) from public;
grant execute on function acq.transition(uuid, text, text, text, jsonb) to bos_automation;
grant select, insert on acq.campaigns to bos_automation;
grant select, insert on acq.leads to bos_automation;
grant select on acq.events to bos_automation;
