# letterflow – Hinweise für Agenten

- Öffentliches Repo: keine Leads, Firmen-Anschriften aus echten Kampagnen, Vorschläge, PDFs, Interessenabwägungen oder Secrets committen. Testdaten immer erfunden (Beispiel GmbH, Musterweg 1).
- Zustände von Leads nur über `acq.transition` ändern, nie per `update acq.leads set state`.
- Freigaben (`approved`, `page_approved`, `letter_approved`) gibt nur ein Mensch (`human:<name>`). Ein Agent ruft sie nie auf.
- Echter Briefversand (Pingen Produktion) bleibt gesperrt, bis der AV-Vertrag unterschrieben und der Versand ausdrücklich freigegeben ist.
- Schema-Änderungen an `acq` als neue Datei in `supabase/migrations/`; nicht ohne Freigabe in die Produktionsdatenbank einspielen.
- Vor dem Push: `npm run typecheck`, `npm test`, `npm run build`.
- Neue Issues bekommen die Zeile `BOS: <Aufgaben-ID>` (Business-OS-Aufgabe der Briefakquise: c8ed38e9-eba5-471e-a3a1-d8f67b61355a).
