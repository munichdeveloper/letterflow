-- letterflow: gebaute Brief-PDFs je Lead, unverändert gespeichert.
-- Voraussetzung: business-os 20261120110000_acq_pipeline_core.sql (Schema acq, Tabelle acq.leads, Rolle bos_automation).
-- Die Brieffreigabe bindet sich an den SHA-256 genau dieses PDFs (acq.leads.letter_pdf_sha256). pdfkit schreibt ein
-- Erstellungsdatum hinein, ein neu gebautes PDF hätte also einen anderen Hash. Deshalb nur select und insert, nie update.

create table acq.letter_pdfs (
  lead_id uuid not null references acq.leads on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  pdf bytea not null,
  created_at timestamptz not null default now(),
  created_by text not null,
  primary key (lead_id, sha256)
);
comment on table acq.letter_pdfs is
  'Gebaute Brief-PDFs der Briefakquise (letterflow), byte-genau wie freigegeben. Nur einfügen und lesen.';

alter table acq.letter_pdfs enable row level security;

revoke all on acq.letter_pdfs from public, anon, authenticated;
grant select, insert on acq.letter_pdfs to bos_automation;

create policy letter_pdfs_select on acq.letter_pdfs for select to bos_automation using (true);
create policy letter_pdfs_insert on acq.letter_pdfs for insert to bos_automation with check (true);
