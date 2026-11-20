-- letterflow: Einstellungen der angebundenen Systeme und Pflege von Kampagnen aus der App.
-- Voraussetzung: business-os 20261120110000_acq_pipeline_core.sql (Schema acq, Rolle bos_automation).
-- Secrets (Tokens, Client-Secrets, API-Keys) stehen NIE in dieser Tabelle, nur in Umgebungsvariablen der App.

create table acq.integrations (
  key text primary key check (key in ('directus', 'pingen', 'jev')),
  config jsonb not null default '{}'::jsonb,
  -- Pingen Produktion: erst freischaltbar, wenn der AV-Vertrag unterschrieben ist (ACQ-09)
  avv_signed_at date,
  last_test_ok boolean,
  last_test_message text,
  last_test_at timestamptz,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  check (key <> 'pingen' or coalesce(config->>'environment', 'staging') = 'staging' or avv_signed_at is not null),
  check (config::text !~* '(secret|token|password|api_key)"\s*:')
);
comment on table acq.integrations is
  'Nicht geheime Einstellungen der Systeme der Briefakquise (letterflow). Secrets nur in Umgebungsvariablen.';

insert into acq.integrations (key, config, updated_by) values
  ('directus', '{"collection": "landingpages"}', 'system:migration'),
  ('pingen', '{"environment": "staging"}', 'system:migration'),
  ('jev', '{"model": "jev-latest", "privacyMax": 0.3}', 'system:migration');

revoke all on acq.integrations from public, anon, authenticated;
grant select, insert, update on acq.integrations to bos_automation;

-- Kampagnen in der App bearbeiten (Schlüssel und id bleiben fest)
grant update (title, offer, segment, letter, interest_balancing_ref, status) on acq.campaigns to bos_automation;
