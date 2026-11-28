-- letterflow: Korrekturen aus der Review von business-os#36 (Kern des Schemas acq).
--
-- 1. acq.lead_created schreibt das erste Ereignis mit Eigentümerrechten. bos_automation darf acq.events nur
--    lesen; mit Aufruferrechten scheiterte schon der erste Lead-Import im AFTER-INSERT-Trigger.
-- 2. queued -> sent ist eine Tatsachenmeldung des Anbieters und wird nicht mehr von der Sperrliste in suppressed
--    umgeschrieben, sonst verliert die Historie den tatsächlichen Versand.
-- 3. Die Seitenfreigabe vergleicht die Revision NULL-sicher: ohne Vorschlag gibt es keine Freigabe.
-- acq.transition ist sonst unverändert gegenüber 20261122120000_acq_interest_balancings_transition.sql.

create or replace function acq.lead_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.state <> 'discovered' then raise exception 'new leads start as discovered' using errcode = '22023'; end if;
  insert into acq.events (lead_id, from_state, to_state, actor, detail)
  values (new.id, null, 'discovered', new.source, '{}'::jsonb);
  return new;
end $$;
revoke all on function acq.lead_created() from public, anon, authenticated;

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

  -- Sperrliste gewinnt, außer bei Endzuständen und der Versandbestätigung queued -> sent (Tatsache des Anbieters;
  -- vor der Übergabe greift sie beim Übergang letter_approved -> queued)
  if v_to not in ('suppressed', 'rejected', 'failed', 'sent') and acq.is_suppressed(v_lead.domain, v_lead.company) then
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
       or (v_detail->>'revision')::int is distinct from (select max(revision) from acq.proposals where lead_id = p_lead_id)
       or not exists (select 1 from acq.proposals where lead_id = p_lead_id) then
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

revoke all on function acq.transition(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function acq.transition(uuid, text, text, text, jsonb) to bos_automation;
