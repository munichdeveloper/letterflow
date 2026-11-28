-- Testgerüst: stark verkleinerte Nachbildung des Kerns aus business-os 20261120110000_acq_pipeline_core.sql, nur so
-- viel, dass die Migrationen von letterflow in einer leeren Test-Datenbank laufen. NICHT der echte Kern und nie in
-- eine echte Datenbank einspielen. acq.allowed_transition und acq.transition sind die Fassungen des Kerns (Stand
-- Produktion 21.11.2026, alte Regel 7: interest_balancing_ref nicht leer); Migration 20261121100000 ersetzt acq.transition.

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
  resume_state text,
  approved_revision int,
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

create table acq.proposals (
  lead_id uuid not null references acq.leads (id),
  revision int not null,
  primary key (lead_id, revision)
);

create table acq.suppressions (
  domain text,
  company text
);

create function acq.is_suppressed(p_domain text, p_company text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from acq.suppressions s where s.domain = p_domain or s.company = p_company)
$$;

create function acq.allowed_transition(p_from text, p_to text)
returns boolean
language sql
immutable
as $function$
  select (p_from, p_to) in (
    ('discovered', 'checked'), ('discovered', 'rejected'),
    ('checked', 'approved'), ('checked', 'rejected'),
    ('approved', 'researched'), ('approved', 'rejected'),
    ('researched', 'researched'), ('researched', 'page_ready'), ('researched', 'rejected'),
    ('page_ready', 'page_ready'), ('page_ready', 'page_approved'), ('page_ready', 'researched'), ('page_ready', 'rejected'),
    ('page_approved', 'letter_ready'), ('page_approved', 'researched'),
    ('letter_ready', 'letter_ready'), ('letter_ready', 'letter_approved'), ('letter_ready', 'researched'), ('letter_ready', 'rejected'),
    ('letter_approved', 'queued'), ('letter_approved', 'researched'), ('letter_approved', 'rejected'),
    ('queued', 'sent')
  )
  or (p_to = 'suppressed' and p_from not in ('suppressed', 'sent'))
  or (p_to = 'failed' and p_from not in ('rejected', 'suppressed', 'sent', 'failed'))
$function$;

create function acq.transition(p_lead_id uuid, p_to text, p_actor text, p_reason text default null::text, p_detail jsonb default '{}'::jsonb)
 returns acq.leads
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_lead acq.leads%rowtype;
  v_to text := p_to;
  v_reason text := p_reason;
  v_campaign acq.campaigns%rowtype;
  v_prev text;
begin
  select * into v_lead from acq.leads where id = p_lead_id for update;
  if not found then raise exception 'lead % not found', p_lead_id using errcode = 'P0002'; end if;
  if coalesce(btrim(p_actor), '') = '' then raise exception 'actor required' using errcode = '22023'; end if;
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
    if (p_detail->>'revision') is null
       or (p_detail->>'revision')::int <> (select max(revision) from acq.proposals where lead_id = p_lead_id) then
      raise exception 'page approval must name the latest proposal revision' using errcode = '22023';
    end if;
  end if;

  if v_to = 'letter_ready' and coalesce(p_detail->>'pdf_sha256', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'letter_ready needs pdf_sha256' using errcode = '22023';
  end if;

  if v_to = 'letter_approved' then
    if v_lead.letter_pdf_sha256 is null or p_detail->>'pdf_sha256' is distinct from v_lead.letter_pdf_sha256 then
      raise exception 'letter approval must name the current PDF hash' using errcode = '22023';
    end if;
    select * into v_campaign from acq.campaigns where id = v_lead.campaign_id;
    if coalesce(btrim(v_campaign.interest_balancing_ref), '') = '' then
      raise exception 'campaign % has no documented interest balancing (rule 7)', v_campaign.key using errcode = '22023';
    end if;
  end if;

  perform set_config('acq.in_transition', 'on', true);
  update acq.leads l set
    state = v_to,
    state_reason = v_reason,
    resume_state = case when v_to = 'failed' then v_prev else null end,
    approved_revision = case
      when v_to = 'page_approved' then (p_detail->>'revision')::int
      when v_to = 'researched' then null
      else l.approved_revision end,
    letter_pdf_sha256 = case
      when v_to = 'letter_ready' then p_detail->>'pdf_sha256'
      when v_to = 'researched' then null
      else l.letter_pdf_sha256 end,
    approved_pdf_sha256 = case
      when v_to = 'letter_approved' then p_detail->>'pdf_sha256'
      when v_to in ('researched', 'letter_ready') then null
      else l.approved_pdf_sha256 end,
    updated_at = now()
  where l.id = p_lead_id
  returning * into v_lead;
  perform set_config('acq.in_transition', 'off', true);

  insert into acq.events (lead_id, from_state, to_state, actor, detail)
  values (p_lead_id, v_prev, v_to, p_actor, coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('reason', v_reason));
  return v_lead;
end $function$;

revoke all on function acq.transition(uuid, text, text, text, jsonb) from public;
grant execute on function acq.transition(uuid, text, text, text, jsonb) to bos_automation;
grant select, insert on acq.campaigns to bos_automation;
grant select, insert on acq.leads to bos_automation;
grant select on acq.events to bos_automation;
