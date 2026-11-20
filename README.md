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
| Schema `acq` (Kern) | business-os `supabase/migrations/20261120110000_acq_pipeline_core.sql` |
| Schema-Erweiterungen von letterflow | `supabase/migrations/` |

Der Kern stammt aus dsb-new#88. Seitenaufbau (Directus), Brief-PDF und Versand (Pingen-Outbox) laufen vorerst
weiter über `pnpm acq` in dsb-new und ziehen schrittweise hierher um.

## Einrichten

1. Migration `supabase/migrations/20261120150000_acq_integrations.sql` in der Business-OS-Datenbank einspielen.
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
