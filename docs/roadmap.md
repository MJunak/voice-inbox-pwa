# Roadmap

Stand: August 2026. Was die App heute ist, wo sie hin soll, in welcher
Reihenfolge — und warum genau in dieser.

## Ist-Stand

| Bereich | Stand | Wo |
| --- | --- | --- |
| Erfassung | Diktat (Web Speech API) + Textarea, Entwurf jederzeit editierbar | `app/page.tsx` |
| Kategorisierung | Regex-Heuristik DE/ES → Aufgabe/Termin/Notiz/Idee, Tag per Klick änderbar | `classify()` |
| Speicherung | `localStorage["voice-inbox-entries"]`, ein JSON-Array | `readStoredEntries()` |
| Steuerung | Needle 2 (45M, WASM) + Regex-Fast-Path, Aktions-Vorschau vor Ausführung | `app/agent/` |
| Sprachen | DE/ES/EN für Erkennung und Befehle | `SPEECH_LANGS` |
| Daten raus/rein | JSON-Export, JSON-Import (**ersetzt** den Bestand) | `exportJson()` / `importJson()` |
| Auslieferung | statische PWA auf GitHub Pages, Service Worker, offline | `.github/workflows/deploy-pages.yml` |

Kein Backend, kein Login, keine Cloud. Das bleibt so — siehe Leitplanken.

## Leitplanken

1. **Local-first.** Die App muss ohne Server vollständig funktionieren. Sync ist
   ein Zusatz, keine Voraussetzung. Kein Feature darf einen Server erzwingen.
2. **Kein fremder Dienst.** Wenn Server, dann der eigene. Keine BaaS-Anbindung,
   keine Fremd-Accounts, keine Telemetrie.
3. **Kein Login-Zwang.** Wer nur ein Gerät nutzt, sieht nie einen Anmeldedialog.
4. **Die statische Auslieferung bleibt.** Der Sync-Server ist ein getrenntes,
   optionales Stück Software mit eigenem Lebenszyklus.
5. **Eingabe zuerst.** Was den Weg von „Gedanke“ zu „abgelegt“ verlängert,
   fliegt raus.

## Reihenfolge

Phase 0 kommt vor allem anderen, weil sowohl Aufgaben-Features als auch Sync am
selben Punkt hängen: **die App kennt aktuell keine Zeitpunkte.** `created` ist
ein Anzeige-String (`"Gerade eben"`, `"Importiert"`), kein Zeitstempel. Ohne
`updatedAt` gibt es keine Konfliktauflösung, ohne Tombstones werden gelöschte
Einträge beim nächsten Sync wiederbelebt. Das Schema wird deshalb **einmal**
gezogen — inklusive der Felder aus Phase 1 —, damit der Sync es nicht zweimal
abbilden muss.

---

## Phase 0 — Datenfundament

**Ziel:** ein Schema, auf dem Aufgaben-Features und Sync ohne Nacharbeit stehen.

- `Entry` v2: `id`, `kind`, `text`, `createdAt` (ISO), `updatedAt` (ISO),
  `deletedAt` (ISO | null), `done` (bool), `dueAt` (ISO | null) — die letzten
  beiden bleiben in Phase 0 ungenutzt, sind aber im Schema und im Export.
- Speicher bekommt einen Umschlag: `{ schema: 2, entries: [...] }` statt nacktem
  Array. Migration v1 → v2 in `readStoredEntries()`, einmalig und verlustfrei
  (`created`-String wandert nach `legacyCreated`, `createdAt` bekommt die
  Migrationszeit als Näherung — Reihenfolge bleibt über die Array-Position
  erhalten).
- **Tombstones statt hartem Löschen.** Löschen setzt `deletedAt`, die UI filtert
  sie aus. Aufräumen nach 90 Tagen beim App-Start.
- `deviceId` (`crypto.randomUUID()`, persistent in `localStorage`) — wird in
  Phase 2 als Tie-Break und zur Pairing-Anzeige gebraucht.
- **Import merged, statt zu ersetzen** (Merge über `id` + `updatedAt`); das
  bisherige Ersetzen bleibt als ausdrückliche zweite Aktion erhalten.
- Zeitanzeige („vor 3 Min.“, „gestern“) aus dem echten Zeitstempel, mit
  `Intl.RelativeTimeFormat`.

**Fertig wenn:** ein bestehender v1-Bestand migriert ohne Verlust, Export
enthält echte Zeitstempel, Löschen hinterlässt einen Tombstone, e2e grün.

**Risiko:** Migration läuft auf echten Beständen genau einmal. Vor dem Schreiben
eine Sicherungskopie unter `voice-inbox-entries-v1-backup` ablegen und erst nach
zwei Wochen räumen.

---

## Phase 1 — Aufgaben-Substanz

**Ziel:** Die Inbox soll mehr können als Text aufbewahren.

- `done` umschaltbar, erledigte Einträge durchgestrichen und einklappbar,
  Filter „offen / erledigt / alle“.
- `dueAt` setzen — manuell und aus dem Text erkannt („morgen 15 Uhr“,
  „nächsten Dienstag“). Erkennung als eigene, testbare Funktion (`parseDate`),
  nicht im Modell: sie muss deterministisch und offline sein.
- Sortierung: fällig zuerst, überfällig hervorgehoben; ohne Fälligkeit weiter
  nach Erstellzeit.
- Wiedervorlage („später“ = +1 Tag / +1 Woche) — setzt nur `dueAt` um.
- **Erinnerungen** brauchen Web Push und damit einen Server (VAPID-Keys,
  Subscription-Speicher). Deshalb bewusst nach Phase 2 gehängt: der Sync-Server
  bringt die Infrastruktur ohnehin mit.

**Fertig wenn:** ein Termin mit „morgen 15 Uhr“ landet mit korrektem `dueAt` in
der Inbox und steht oben, ohne dass man ihn angefasst hat.

---

## Phase 2 — Sync über den eigenen Server

**Ziel:** Handy und Rechner zeigen denselben Bestand, ohne fremden Dienst.

Ausführliches Konzept: **[docs/sync.md](sync.md)** — Optionenvergleich,
Protokoll, Serverentwurf, Deployment über Tailscale *und* öffentlichen Reverse
Proxy, plus die Stolperfallen (Mixed Content, CORS, Uhren-Drift).

Meilensteine:

1. **M1 Server-MVP** — Node 22 + `node:sqlite`, ohne Fremdabhängigkeiten,
   `GET/POST /api/changes`, Bearer-Token, Health-Endpunkt.
2. **M2 Client-Sync** — Pull/Merge/Push-Schleife, Statusanzeige in der Topbar,
   funktioniert vollständig offline weiter.
3. **M3 Pairing** — Gerät koppeln per Code/QR, ein Token pro Gerät, einzeln
   widerrufbar.
4. **M4 Deployment** — Tailscale als Standardweg, öffentlicher Reverse Proxy als
   Fallback; systemd-Unit und Compose-Datei; Backup der SQLite-Datei.
5. **M5 PWA vom Homeserver** — dieselbe statische App zusätzlich vom eigenen
   Server ausliefern. Damit entfallen CORS und Mixed-Content-Fragen, und die
   Needle-Assets (14 MB) können lokal statt von HuggingFace kommen.

**Fertig wenn:** ein Eintrag, der offline im Flugmodus auf dem Handy entsteht,
nach dem Wiederverbinden ohne Zutun auf dem Rechner steht — und ein dort
gelöschter Eintrag nicht zurückkommt.

---

## Phase 3 — Teilen & Export

**Ziel:** Die Inbox ist eine Durchgangsstation, keine Sackgasse.

- **Web Share Target** im Manifest: aus jeder App heraus Text in die Inbox
  teilen (installierte PWA, Android/Chrome). Der Service Worker nimmt den
  POST entgegen und legt den Eintrag an.
- Export nach **Markdown** (eine Datei, nach Kategorie gegliedert) und **CSV**.
- **ICS** für Termine und Aufgaben mit `dueAt` — als Download, und sobald der
  Server steht als Abo-URL (`/api/calendar.ics?token=…`), die Kalender-Apps
  regelmäßig ziehen. Das ist der billigste Weg zu echten Erinnerungen auf allen
  Geräten.
- Ausgehende Übergabe an bestehendes Tooling: Datei-Ablage für Obsidian
  (Server schreibt in einen Ordner) und optional ein Webhook pro Kategorie.

**Fertig wenn:** ein aus dem Browser geteilter Link landet als Notiz in der
Inbox, und Termine erscheinen im Kalender des Handys.

---

## Phase 4 — Needle-Ausbau

**Ziel:** Die Sprachsteuerung deckt die neuen Felder ab und wird belastbar.

- Neue Tools: `completeMatching`, `setDue`, `snooze`, `createAppointment`
  (mit Datum) — die Tool-Liste kostet zur Laufzeit nichts, sie wird beim Init
  einmal gebunden (siehe [needle-agent.md](needle-agent.md)).
- Ketten: „lösch den Zahnarzt und zeig mir die Aufgaben“ als zwei Calls.
- Fast-Path für die neuen Aktionen in DE/ES/EN — Regex ist hier besser als das
  Modell, weil sofort und vorhersagbar.
- **Eval-Set**: Liste aus Befehl → erwarteter ToolCall, als e2e-Test gegen die
  echte WASM-Inferenz. Ohne das ist jede Modell- oder Prompt-Änderung ein
  Blindflug.
- **Asset-Auslieferung vom eigenen Server** (hängt an M5): Engine und Modell
  liegen dann nicht mehr nur bei HuggingFace, und der Revision-Pin ist unter
  eigener Kontrolle.

**Fertig wenn:** „erinner mich morgen um neun an die Steuer“ legt eine Aufgabe
mit korrektem `dueAt` an und das Eval-Set läuft grün.

---

## Später — bewusst nicht jetzt

| Thema | Warum zurückgestellt |
| --- | --- |
| **Originalaufnahme behalten** | Braucht IndexedDB für Blobs und macht die Sync-Nutzlast um Größenordnungen schwerer (Minuten Audio statt Kilobyte Text). Erst sinnvoll, wenn der Textsync stabil läuft. |
| **Ende-zu-Ende-Verschlüsselung** | Auf dem eigenen Server im VPN ist der Gewinn klein. Sobald der Server dauerhaft öffentlich steht, wird es relevant — Skizze steht in [sync.md](sync.md). |
| **Mehrbenutzer** | Ein Nutzer, mehrere Geräte ist der Fall. Mandantenfähigkeit würde Auth, Rechte und Datenmodell verkomplizieren, ohne heute jemandem zu helfen. |
| **Realtime-Push (SSE/WebSocket)** | Polling im Minutentakt plus Sync beim App-Fokus reicht für eine Inbox. Nachrüstbar, ohne das Protokoll zu ändern. |
| **Native App** | Die PWA deckt alles ab außer verlässlicher Hintergrund-Spracherkennung. Kein ausreichender Grund. |

## Offene Entscheidungen

| Frage | Optionen | Tendenz |
| --- | --- | --- |
| Wo lebt die PWA künftig? | GitHub Pages / Homeserver / beides | beides — Pages als Schaufenster, Homeserver als Arbeitsgerät (M5) |
| Serverlaufzeit | Node 22 + `node:sqlite` / Deno / Go | Node — kein neuer Toolchain-Zoo, `node:sqlite` ist eingebaut |
| Datumserkennung | eigener Parser / Bibliothek / Modell | eigener Parser für DE/ES/EN-Kernfälle, Modell nur als Auffangnetz |
| Konfliktstrategie | Last-Write-Wins / CRDT | LWW pro Eintrag, Konfliktkopie bei echtem Textkonflikt — Begründung in [sync.md](sync.md) |
