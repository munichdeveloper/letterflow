-- letterflow: Lauf-Markierung je Kampagne, damit pro Kampagne höchstens eine Kette gleichzeitig läuft.
-- Voraussetzung: business-os 20261120110000_acq_pipeline_core.sql (Schema acq, Rolle bos_automation).
-- Die Markierung wird atomar gesetzt (insert ... on conflict) und am Ende des Laufs gelöscht. Sie hält keine
-- Verbindung und keine Transaktion offen. expires_at fängt einen abgebrochenen Prozess ab: Nach Ablauf darf ein
-- neuer Lauf die Markierung übernehmen.

create table acq.chain_runs (
  campaign_key text primary key,
  run_id uuid not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null
);
comment on table acq.chain_runs is
  'Laufende Ketten der Briefakquise (letterflow), höchstens eine je Kampagne. Zeilen sind kurzlebig.';

alter table acq.chain_runs enable row level security;

revoke all on acq.chain_runs from public, anon, authenticated;
grant select, insert, update, delete on acq.chain_runs to bos_automation;

create policy chain_runs_all on acq.chain_runs for all to bos_automation using (true) with check (true);
