# letterflow

App für die B2B-Briefakquise: Kampagnen anlegen, Leads durch die Kette verfolgen und die angebundenen Systeme
(Directus, Pingen, Jev) konfigurieren und testen.

> **Öffentliches Repo.** Hier stehen nur Code und Beispielwerte. Leads, Vorschläge, Briefe, QR-Schlüssel,
> Interessenabwägungen und Secrets gehören nie ins Repo (`.gitignore` sperrt `data/`, `landingpage-qr/`, `*.pdf`, `.env*`).

## Wie die Kette funktioniert

Die Daten liegen im Schema `acq` der Business-OS-Datenbank (Supabase). Jeder Lead hat einen Zustand; ändern
darf ihn nur die Datenbankfunktion `acq.transition`. Sie prüft erlaubte Übergänge, bindet Freigaben an einen
Menschen (`human:<name>`), an die Revision des Seitentextes bzw. den Hash des Brief-PDFs und verlangt vor jeder
Brieffreigabe, dass die neueste Interessenabwägung der Kampagne freigegeben ist (Regel 7, siehe „Interessenabwägung“).

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
| Interessenabwägung prüfen, speichern, freigeben (`acq.interest_balancings`) | `src/lib/interest-balancing.ts`, `src/lib/server/interest-balancings.ts` |
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
   (`20261120150000_acq_integrations.sql`, `20261120160000_acq_letter_pdfs.sql`, `20261120170000_acq_chain_runs.sql`,
   `20261121100000_acq_interest_balancings.sql`).
2. `.env.example` nach `.env.local` kopieren und ausfüllen. Passwort-Hash je Person: `npm run user:hash -- <name>`.
3. `npm install`, dann `npm run dev`.

Prüfen: `npm test`, `npm run typecheck`, `npm run build`. Die Datenbank-Tests (`tests/interest-balancing-db.test.ts`)
starten ein Wegwerf-Postgres über `initdb`/`pg_ctl` (oder nutzen `ACQ_TEST_DATABASE_URL`) und laufen gegen ein
Testgerüst des Kerns; ohne Postgres werden sie übersprungen.

## Interessenabwägung

Auf **Bearbeiten** einer Kampagne lädt man die Abwägung (Art. 6 Abs. 1 lit. f DSGVO) als `.md` oder PDF hoch, höchstens
2 MB. Jede Datei wird eine neue Version in `acq.interest_balancings`; gespeicherte Dateien ändern sich nie. **Abwägung
freigeben** ruft `acq.approve_interest_balancing` mit dem angemeldeten Menschen auf; die Datenbank nimmt nur `human:<name>`,
den angezeigten SHA-256 und die neueste Version an. Eine Brieffreigabe geht nur, solange die neueste Version freigegeben
ist; das Ereignis hält `id`, `version` und `sha256` der Abwägung fest. Das alte Freitextfeld `interest_balancing_ref` zählt
nicht mehr und wird in der App nicht mehr bearbeitet.

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

## MCP-Endpunkt

`/api/mcp` ist ein geschützter MCP-Server (Streamable HTTP, zustandslos, Node-Runtime, offizielles
`@modelcontextprotocol/sdk`). Er bietet bisher genau ein Tool, nur lesend:

- `letterflow_list_campaigns` – Eingabe `{status?: "active"|"paused"|"closed", limit?: 1–100}`; Ausgabe je Kampagne
  nur `key`, `title`, `offer`, `segment`, `status`, `counts` (kein Brieftext, keine Interessenabwägung).

Jeder Request braucht `Authorization: Bearer <token>`; Web-Cookies gelten nicht. Ohne gültiges Token oder bei
fehlender bzw. ungültiger Konfiguration antwortet der Endpunkt mit 401 bzw. 503, ohne die Datenbank anzufassen.
Es gibt nur `POST` (kein Server-Stream, keine Sitzungen); Anfragen sind auf 64 KB begrenzt.
Das Audit-Log (`console.info`, JSON) enthält nur Zeit, Client-ID, Tool, Ergebnis und Dauer.

**Secret `LETTERFLOW_MCP_CLIENTS`:** JSON-Objekt `clientId -> token`.

```
LETTERFLOW_MCP_CLIENTS='{"agent-eins":"<token>","agent-zwei":"<token>"}'
```

- Client-ID: `^[a-z][a-z0-9-]{1,30}$`. Token: mindestens 32 zufällige Bytes, z. B. `openssl rand -hex 32`
  (zu kurze oder gleichförmige Token, doppelte Token und kaputtes JSON machen die ganze Konfiguration ungültig;
  der Endpunkt bleibt dann geschlossen).
- **Tokenrotation:** neuen Eintrag mit neuem Token ergänzen, Secret setzen und neu starten, den Client umstellen,
  danach den alten Eintrag entfernen. Jeder Client hat ein eigenes, unabhängig rotierbares Token.

Beispielaufruf mit dem MCP-Client des SDK (Tools entdecken und aufrufen):

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const client = new Client({ name: "beispiel", version: "1.0.0" })
await client.connect(new StreamableHTTPClientTransport(new URL("https://<host>/api/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${process.env.LETTERFLOW_MCP_TOKEN}` } },
}))
console.log((await client.listTools()).tools.map((t) => t.name))
console.log(await client.callTool({ name: "letterflow_list_campaigns", arguments: { status: "active", limit: 10 } }))
```

`tests/mcp.test.ts` prüft Handshake, Tool-Aufruf und Authentifizierung mit genau diesem SDK-Client gegen den
Handler. Andere Clients (z. B. ChatGPT) sind nicht getestet. Der Endpunkt gehört hinter HTTPS (Coolify/Proxy).

## Betrieb

Container (`Dockerfile`), z. B. über Coolify. Die App braucht ausgehend: Supabase, Directus, Pingen, api.typesafe.ai.
