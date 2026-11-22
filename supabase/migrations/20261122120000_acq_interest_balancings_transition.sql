-- letterflow: Umstellung einer Datenbank, in der 20261121100000_acq_interest_balancings.sql in der früheren Fassung
-- (Regel 7 über Trigger auf acq.leads und acq.events, Freigabe füllt interest_balancing_ref) eingespielt ist, auf die
-- aktuelle Fassung: Regel 7 in acq.transition. In einer Datenbank mit der aktuellen Fassung ändert diese Datei nichts.

drop trigger if exists leads_require_interest_balancing_insert on acq.leads;
drop trigger if exists leads_require_interest_balancing_update on acq.leads;
drop trigger if exists events_interest_balancing_detail on acq.events;
drop function if exists acq.leads_require_interest_balancing();
drop function if exists acq.events_interest_balancing_detail();

create or replace function acq.approve_interest_balancing(p_id uuid, p_sha256 text, p_actor text)
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

create or replace function acq.approved_interest_balancing(p_campaign_id uuid) returns acq.interest_balancings
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
