# letterflow

App für die B2B-Briefakquise: Kampagnen anlegen, Leads durch die Kette verfolgen und die angebundenen Systeme
(Directus, Pingen, Jev) konfigurieren und testen.

> **Öffentliches Repo.** Hier stehen nur Code und Beispielwerte. Leads, Vorschläge, Briefe, QR-Schlüssel,
> Interessenabwägungen und Secrets gehören nie ins Repo (`.gitignore` sperrt `data/`, `landingpage-qr/`, `*.pdf`, `.env*`).

## Wie die Kette funktioniert

Die Daten liegen im Schema `acq` der Business-OS-Datenbank (Supabase). Jeder Lead hat einen Zustand; ändern
darf ihn nur die Datenbankfunktion `acq.transition`. Sie prüft erlaubte Übergänge, bindet Freigaben an einen
Menschen (`human:<name>`), an die Revision des Seitentextes bzw. den Hash des Brief-PDFs und verlangt vor jeder
Brieffreigabe eine dokumentierte Interessenabwägung der Kampagne.

```
discovered → checked → approved → researched → page_ready → page_approved → letter_ready → letter_approved → queued → sent
            (Regeln)   (Mensch)   (Agent)      (Directus)   (Mensch)        (PDF)          (Mensch)          (Jev, Pingen)
```

| Teil | Wo |
| --- | --- |
| Verträge (Lead, Beleg, Seitentext, Brief) | `src/lib/acq/contracts.ts` |
| Feste Regeln (Rechtsform, Personennamen, Preise, Werbewiderspruch) | `src/lib/acq/rules.ts` |
| Ablauf und Freigaben | `src/lib/acq/pipeline.ts` |
| Jev-Prüfung vor dem Versand (personenbezogen?) | `src/lib/acq/privacy.ts` |
| Datenbankzugriff | `src/lib/acq/store.ts` |
| Systeme, Einstellungen, Verbindungstests | `src/lib/integrations.ts` |
| Brief-PDF bauen (pdfkit, QR-Code) | `src/lib/chain/letter-pdf.ts` |
| Brief-PDFs speichern und lesen (`acq.letter_pdfs`) | `src/lib/server/letter-pdfs.ts` |
| Schema `acq` (Kern) | business-os `supabase/migrations/20261120110000_acq_pipeline_core.sql` |
| Schema-Erweiterungen von letterflow | `supabase/migrations/` |

Der Kern stammt aus dsb-new#88. Seitenaufbau (Directus), Brief-PDF und Versand (Pingen-Outbox) laufen jetzt
hier (siehe „Kette“).

## Kette

`src/lib/server/chain.ts` setzt `ChainDeps` aus `src/lib/acq/pipeline.ts` mit den Modulen dieses Repos um:
Seiten in Directus (`setupPages`), Brief-PDF mit QR-Code zur Brief-URL (`briefUrls`, `buildLetterPdf`,
gespeichert in `acq.letter_pdfs`), Jev-Prüfung und Upload in die Outbox bzw. zu Pingen. Pingen läuft nur auf
Staging (Umgebung `sandbox` der Outbox); ein Upload nach `production` ist in keinem Code-Pfad vorgesehen.

In der App startet **Kette anstoßen** auf der Kampagnenseite einen Lauf und zeigt danach seine Log-Zeilen.
Pro Kampagne läuft höchstens ein Lauf gleichzeitig (Lauf-Markierung in `acq.chain_runs`, ohne offene Transaktion). Dasselbe auf der Befehlszeile:

```
npm run acq -- import-leads <datei>       # Leads des Agenten (JSON) einlesen und prüfen
npm run acq -- import-proposals <datei>   # Seitenbeschreibungen des Agenten (JSON) einlesen
npm run acq -- run <kampagne>             # Kette bis zur nächsten Freigabe vorantreiben
npm run acq -- status <kampagne>          # Zustand aller Leads (acq.lead_overview)
```

Freigaben gibt es auf der Befehlszeile bewusst nicht: Die gibt nur ein Mensch in der App.

Umgebungsvariablen (App und Befehlszeile):

- `ACQ_DATABASE_URL` (und bei Bedarf `ACQ_DATABASE_CA_CERT`): Business-OS-Datenbank, Rolle `bos_automation`.
- `DIRECTUS_SETUP_TOKEN`: Seiten und Schlüssel anlegen, Brief-URLs lesen.
- `PINGEN_CLIENT_ID`, `PINGEN_CLIENT_SECRET`: Pingen Staging.
- `TYPESAFE_API_KEY`: Jev-Prüfung vor dem Upload.

Die übrigen Einstellungen (Directus-URL, Collection, Website-URL, Pingen-Organisation, Jev-Modell und Grenze
`privacyMax`) kommen aus `acq.integrations` (**Systeme** in der App).

## Einrichten

1. Migrationen aus `supabase/migrations/` der Reihe nach in der Business-OS-Datenbank einspielen
   (`20261120150000_acq_integrations.sql`, `20261120160000_acq_letter_pdfs.sql`, `20261120170000_acq_chain_runs.sql`).
2. `.env.example` nach `.env.local` kopieren und ausfüllen. Passwort-Hash je Person: `npm run user:hash -- <name>`.
3. `npm install`, dann `npm run dev`.

Prüfen: `npm test`, `npm run typecheck`, `npm run build`.

## Angebundene Systeme

Unter **Systeme** stehen die Einstellungen ohne Geheimnisse (Tabelle `acq.integrations`, die Datenbank lehnt
Felder wie `token` oder `secret` ab). Tokens und Schlüssel kommen ausschließlich als Umgebungsvariablen.
Jeder Test liest nur, legt nichts an und versendet nichts.

- **Directus:** URL und Collection der Landingpages; `DIRECTUS_SETUP_TOKEN`.
- **Pingen:** Umgebung und Organisations-ID; `PINGEN_CLIENT_ID`, `PINGEN_CLIENT_SECRET`. Produktion lässt sich
  erst wählen, wenn das Datum des unterschriebenen AV-Vertrags eingetragen ist (auch per Check in der Datenbank).
  Der Versandcode bleibt zusätzlich auf Staging gesperrt, bis der echte Versand freigegeben ist.
- **Jev (TypeSafe System One):** Modell und Grenze für „personenbezogen“ (Standard 0,3); `TYPESAFE_API_KEY`.

## Login

Login je Person, weil jede Freigabe einem Menschen zugeordnet wird. Nutzer stehen in `LETTERFLOW_USERS`
(`name:scrypt:<salt>:<hash>`, mehrere mit Komma), die Sitzung ist ein signiertes Cookie (`LETTERFLOW_SESSION_SECRET`).

## Betrieb

Container (`Dockerfile`), z. B. über Coolify. Die App braucht ausgehend: Supabase, Directus, Pingen, api.typesafe.ai.
