-- letterflow: gebaute Brief-PDFs, unverändert gespeichert (das Dateisystem des Containers ist schreibgeschützt).
-- Die Brieffreigabe bindet sich an den SHA-256 genau dieses PDFs (acq.leads.letter_pdf_sha256); pdfkit schreibt ein
-- Erstellungsdatum hinein, ein neu gebautes PDF hätte einen anderen Hash. Darum nie neu bauen, nur lesen.
-- Voraussetzung: 20261120150000_acq_integrations.sql. Enthält keine Daten.

create table acq.letter_pdfs (
  lead_id uuid not null references acq.leads on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  pdf bytea not null,
  created_at timestamptz not null default now(),
  created_by text,
  primary key (lead_id, sha256)
);
comment on table acq.letter_pdfs is
  'Gebaute Brief-PDFs je Lead, byte-genau wie freigegeben (sha256 = SHA-256 der Bytes). Nur anhängen, nie ändern.';

alter table acq.letter_pdfs enable row level security;
create policy letter_pdfs_select on acq.letter_pdfs for select to bos_automation using (true);
create policy letter_pdfs_insert on acq.letter_pdfs for insert to bos_automation with check (true);

revoke all on acq.letter_pdfs from public, anon, authenticated;
grant select, insert on acq.letter_pdfs to bos_automation;
