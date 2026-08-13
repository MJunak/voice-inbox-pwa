# Sync zwischen Geräten (eigener Server)

Konzept für Phase 2 der [Roadmap](roadmap.md). Ziel: Handy und Rechner zeigen
denselben Bestand, ohne dass ein fremder Dienst beteiligt ist. Der Server läuft
auf dem eigenen Homeserver, erreichbar bevorzugt über Tailscale, im Fallback
über eine öffentliche Domain.

Noch nicht gebaut — dieses Dokument legt fest, *was* gebaut wird und welche
Fallen dabei zu erwarten sind.

## Anforderungen

1. **Ohne Server voll benutzbar.** Wer nichts konfiguriert, merkt vom Sync
   nichts. Die App bleibt local-first.
2. **Offline schreibbar auf allen Geräten.** Was im Flugzeug entsteht, geht
   später hoch. Kein Zustand, in dem Erfassen blockiert ist.
3. **Löschungen halten.** Ein auf Gerät A gelöschter Eintrag darf nicht von
   Gerät B wiederbelebt werden.
4. **Kein Datenverlust bei Konflikten.** Im Zweifel lieber ein Eintrag zu viel
   als ein überschriebener Text.
5. **Betriebsaufwand klein.** Eine Datei als Datenbank, ein Prozess, ein Backup.
6. **Nachrüstbar.** Bestehende Geräte mit lokalem Bestand müssen sich
   anschließen können, ohne dass etwas verloren geht.

## Optionen — und warum eine davon

| Variante | Wie | Warum nicht / doch |
| --- | --- | --- |
| **Datei-Sync** (Syncthing/Nextcloud-Ordner mit der JSON) | App exportiert, ein Ordner-Sync verteilt | Browser-Sandbox: eine PWA schreibt nicht frei ins Dateisystem. Und paralleles Bearbeiten führt zu Dateikonflikten statt Eintragskonflikten — der Nutzer müsste JSON mergen. |
| **P2P/CRDT** (Yjs oder Automerge über WebRTC) | Geräte gleichen direkt ab, Server nur als Signaling | Technisch elegant, konfliktfrei per Konstruktion. Aber: Signaling-Server braucht man trotzdem, beide Geräte müssen gleichzeitig online sein, und die Bibliothek plus Dokumentmodell kosten mehr Komplexität als die ganze restliche App. Für kurze Textnotizen mit einem einzigen Nutzer ist zeichengenaues Merging Overkill. |
| **Fremd-Backend** (Supabase, Firebase) | Fertige Sync-SDKs | Widerspricht Leitplanke 2. Nicht weiter betrachtet. |
| **Eigener Server mit Delta-API** ✅ | Server hält die Wahrheit als Änderungsjournal, Clients ziehen/schieben Deltas | Wenig Code, ein Prozess, SQLite. Beide Geräte müssen nie gleichzeitig online sein. Konflikte sind selten und werden explizit behandelt. **Das wird gebaut.** |

## Architektur

```
Gerät A (PWA)                     Homeserver                    Gerät B (PWA)
 localStorage  ──push──▶  ┌──────────────────────┐  ◀──push──   localStorage
 (Wahrheit für   ◀─pull──  │  sync-server (Node)  │   ──pull─▶   (Wahrheit für
  dieses Gerät)            │  SQLite: entries     │              dieses Gerät)
                           │         devices      │
                           └──────────────────────┘
                            Tailscale (bevorzugt)
                            Caddy/öffentlich (Fallback)
```

Der Server ist **dumm**: er speichert Einträge, vergibt fortlaufende
Sequenznummern und beantwortet „was hat sich seit `seq` geändert?“. Er
interpretiert weder Kategorien noch Texte. Die gesamte Logik — Klassifizierung,
Needle, UI — bleibt im Client. Damit bleibt die App ohne Server vollständig
funktionsfähig und der Server über Jahre unangetastet lauffähig.

## Datenmodell

Baut auf `Entry` v2 aus Phase 0 auf:

```ts
type Entry = {
  id: string;          // crypto.randomUUID(), global eindeutig — Merges kollidieren nie
  kind: Kind;
  text: string;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO — jede Änderung setzt das neu
  deletedAt: string | null;  // Tombstone statt hartem Löschen
  done: boolean;
  dueAt: string | null;
};
```

Serverseitig kommen zwei Felder dazu, die der Client nie setzt:

- `seq` — monoton steigender Zähler pro Schreibvorgang. Der Cursor für
  Delta-Abfragen. **Nicht** die Uhrzeit: Sequenznummern sind unabhängig von
  Uhren-Drift.
- `receivedAt` — Serverzeit des Eingangs, dient als Tie-Break.

```sql
CREATE TABLE entries (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  due_at     TEXT,
  device_id  TEXT NOT NULL,     -- wer zuletzt geschrieben hat
  seq        INTEGER NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX entries_seq ON entries(seq);

CREATE TABLE devices (
  token_hash TEXT PRIMARY KEY,  -- SHA-256 des Tokens, nie das Token selbst
  device_id  TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT
);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- u. a. seq-Zähler
```

## Konflikte

**Last-Write-Wins pro Eintrag**, verglichen über `updatedAt`; bei exakt gleicher
Zeit gewinnt die lexikografisch kleinere `deviceId` (deterministisch, damit alle
Geräte unabhängig zum selben Ergebnis kommen).

Löschen ist dabei kein Sonderfall: ein Tombstone ist ein Update wie jedes
andere. Wer später gelöscht hat, gewinnt; wer später bearbeitet hat, holt den
Eintrag zurück. Das ist die erwartbare Semantik.

**Eine Ausnahme, damit Leitplanke 4 hält:** Haben beide Seiten *denselben*
Eintrag seit dem letzten gemeinsamen Sync am **Text** geändert und
unterscheiden sich die Texte, legt der Client statt eines stillen Überschreibens
eine **Konfliktkopie** an — neue `id`, Text des Verlierers, Präfix
`„⚠ Konflikt (Gerät X, <Zeit>):“`. Der Nutzer entscheidet, keine Zeile geht
verloren. Erkennbar ist der Fall daran, dass die lokale Version seit
`lastSyncSeq` verändert wurde *und* der Server eine abweichende Version liefert.

Kategorie, `done` und `dueAt` laufen ohne Konfliktkopie über LWW — dort ist ein
verlorener Klick billig, ein verlorener Satz nicht.

## Protokoll

Drei Endpunkte, JSON, Bearer-Token im `Authorization`-Header.

### `GET /api/changes?since=<seq>&limit=<n>`

```jsonc
// Antwort
{
  "entries": [ /* Entry-Objekte, aufsteigend nach seq, inkl. Tombstones */ ],
  "seq": 4711,        // höchste ausgelieferte Sequenznummer
  "more": false,      // true → sofort weiterziehen (Paginierung)
  "serverTime": "2026-08-13T09:14:02.116Z"
}
```

`since=0` liefert den kompletten Bestand — das ist zugleich der Weg, auf dem ein
frisch gekoppeltes Gerät alles bekommt.

### `POST /api/changes`

```jsonc
// Anfrage
{
  "deviceId": "…",
  "entries": [ /* alle lokal seit lastPushedAt geänderten Entries */ ]
}

// Antwort
{
  "applied": 3,
  "rejected": [ { "id": "…", "reason": "stale", "current": { /* Entry */ } } ],
  "seq": 4714,
  "serverTime": "2026-08-13T09:14:02.310Z"
}
```

Der Server wendet dieselbe LWW-Regel an und weist veraltete Schreibvorgänge mit
der aktuellen Serverversion zurück, statt sie stumpf zu übernehmen. Der Client
verarbeitet `rejected` genau wie eingehende Änderungen — inklusive
Konfliktkopie.

Ein Push ist **idempotent**: dieselbe Nutzlast zweimal geschickt ändert nichts,
weil `updatedAt` identisch bleibt. Damit ist ein Retry nach Netzabbruch
gefahrlos.

### `GET /api/health`

Ohne Auth, antwortet `{ "ok": true, "version": "…" }`. Der Client nutzt ihn, um
zwischen VPN- und öffentlicher URL zu wählen (siehe Deployment).

## Sync-Schleife im Client

```
pull(seq=lastSyncSeq) → merge → push(lokale Änderungen) → lastSyncSeq speichern
```

Erst ziehen, dann schieben: so ist beim Push der lokale Stand bereits maximal
aktuell und die Zahl der Zurückweisungen minimal.

Ausgelöst wird die Schleife bei:

- App-Start (nach dem ersten Rendern, nicht davor — die App darf nie auf das
  Netz warten),
- lokaler Änderung, entprellt um ~2 s,
- `visibilitychange` auf sichtbar (der Fall „Handy wieder aufgeklappt“),
- `online`-Event,
- und sonst alle 60 s, solange der Tab sichtbar ist.

Zustände für die Anzeige in der Topbar: `aus` (nicht konfiguriert) · `synchron`
· `synchronisiert …` · `offline (n ausstehend)` · `Fehler`. Bei Fehlern wird
exponentiell zurückgestuft (2 s → 60 s), niemals blockierend.

Eine Outbox-Tabelle braucht es nicht: „lokal geändert“ ist genau
`updatedAt > lastPushedAt`. Ein Feld weniger, das inkonsistent werden kann.

## Server

Node 22 mit eingebautem `node:sqlite` — **keine** Laufzeitabhängigkeiten. Das
ist der Punkt: ein Sync-Server, den man in fünf Jahren noch startet, ohne dass
ein npm-Baum verrottet ist.

```
server/
  index.mjs      # HTTP, Routing, Auth   (~150 Zeilen)
  db.mjs         # Schema, Migrationen, Queries
  pair.mjs       # CLI: Gerät koppeln, Token widerrufen, Liste
  README.md
```

Start: `node --experimental-sqlite server/index.mjs` (in Node 22 ist
`node:sqlite` noch hinter dem Flag; ab Node 24 entfällt es).

Konfiguration über Umgebungsvariablen: Port, Pfad der Datenbankdatei, erlaubte
Origins. Keine Konfigurationsdatei.

## Auth & Pairing

Ein Nutzer, mehrere Geräte — also **ein Token pro Gerät**, kein Passwort, kein
Login-Formular:

1. Auf dem Server `node server/pair.mjs new "Pixel"` → gibt ein einmaliges,
   zufälliges Token (32 Byte, base64url) samt QR-Code im Terminal aus.
2. In der PWA unter „Sync“ Server-URL und Token eintragen (oder QR mit der
   Kamera scannen).
3. Der Server speichert nur den SHA-256-Hash des Tokens. Verlorenes Token heißt
   neu koppeln, nicht wiederherstellen.
4. `node server/pair.mjs revoke <label>` sperrt ein einzelnes Gerät, ohne die
   anderen anzufassen.

Der Vergleich des Token-Hashes läuft über `crypto.timingSafeEqual`.

## Deployment

Der Server hört ausschließlich auf `127.0.0.1:8787`. Beide Zugangswege sind
Reverse Proxies davor — so ist nie ein ungeschützter Port offen.

### Weg A — Tailscale (Standard)

```bash
tailscale serve --bg http://127.0.0.1:8787
# erreichbar als https://homeserver.<tailnet>.ts.net
```

TLS-Zertifikat kommt von Tailscale, keine Portfreigabe im Router, kein
öffentlich erreichbarer Dienst. Läuft das VPN auf dem Handy nicht, synct die App
schlicht nicht — sie funktioniert lokal weiter und holt später nach.

Wichtig: den **MagicDNS-Namen** verwenden, nicht die 100.x-Adresse. Nur zum
Namen passt das Zertifikat, und Browser behandeln nackte IPs in privaten
Netzbereichen zunehmend restriktiv.

### Weg B — Öffentlich (Fallback)

```caddy
sync.deine-domain.de {
  reverse_proxy 127.0.0.1:8787
  rate_limit { zone sync { key {remote_host}; events 60; window 1m } }
}
```

Let's Encrypt übernimmt Caddy selbst. Zusätzlich: nur `/api/*` durchreichen,
fail2ban auf wiederholte 401er, und Backups vom Server weg auf ein zweites
Medium.

### Beides gleichzeitig

Die App speichert **zwei** URLs. Vor jedem Sync-Lauf entscheidet ein
`GET /api/health` mit 1,5 s Timeout: VPN-URL zuerst, bei Fehlschlag die
öffentliche, Ergebnis für 5 Minuten gemerkt. Die Entscheidung darf die UI nie
blockieren.

Betrieb: systemd-Unit mit `Restart=always` (Compose-Datei als Alternative
danebenlegen), Backup per `sqlite3 .backup` in ein Snapshot-Verzeichnis, das
ohnehin gesichert wird.

## Stolperfallen

Das sind die Punkte, an denen dieses Vorhaben typischerweise Zeit verbrennt:

1. **Mixed Content.** Die PWA liegt auf GitHub Pages, also HTTPS. Ein
   `http://homeserver:8787` wird vom Browser hart blockiert — ohne
   verwertbare Fehlermeldung im Netzwerk-Tab. Der Sync-Server **muss** TLS
   sprechen. Weg A und B liefern das beide.
2. **CORS.** Pages-Origin ≠ Server-Origin, und der `Authorization`-Header
   erzwingt einen Preflight. Der Server muss `OPTIONS` beantworten und
   `Access-Control-Allow-Origin` (exakter Origin, nicht `*`, sobald
   Credentials im Spiel sind), `-Headers: authorization, content-type` sowie
   `-Max-Age` setzen. Fehlt der Preflight-Zweig, sieht man nur „Failed to
   fetch“.
3. **Beide Probleme verschwinden mit M5**: liefert der Homeserver die PWA selbst
   aus, ist alles same-origin. Das ist der eigentliche Grund, warum M5 in der
   Roadmap steht.
4. **Uhren-Drift bricht LWW.** Geht ein Gerät zehn Minuten vor, gewinnt es jeden
   Konflikt. Gegenmittel: Der Server schickt in jeder Antwort `serverTime`; der
   Client misst den Versatz, korrigiert seine `updatedAt`-Werte beim Push und
   warnt sichtbar ab ±2 Minuten Abweichung.
5. **Der Service Worker darf `/api/*` niemals cachen.** Ein gecachter
   Sync-Response ist der schmerzhafteste denkbare Bug: die App meldet Erfolg und
   synchronisiert nichts. In `public/sw.js` eine Network-only-Route setzen,
   bevor der Sync-Client dazukommt.
6. **`localStorage` fasst nur ~5 MB** und ist synchron. Für Text reicht das
   lange, aber die Migration nach IndexedDB sollte man beim Schema-Umbau in
   Phase 0 zumindest nicht verbauen (Zugriff über ein schmales
   Storage-Modul kapseln, nicht `localStorage` quer durch die Komponente).
7. **Zurückgewiesene Pushes müssen verarbeitet werden.** Wer `rejected` nur
   protokolliert, produziert Geräte, die dauerhaft auseinanderlaufen und es
   nicht merken.
8. **Erstes Koppeln eines Geräts mit vorhandenem Bestand** ist kein leerer
   Fall: `since=0` ziehen, dann *mergen* (nicht ersetzen) und alles Lokale
   pushen. Der Import-Merge aus Phase 0 ist genau derselbe Codepfad — einmal
   bauen, zweimal nutzen.

## Sicherheit

Bedrohungsmodell: ein Nutzer, ein Server, im Zweifel öffentlich erreichbar.

- Token mit 256 Bit Entropie, serverseitig nur als Hash, Vergleich in konstanter
  Zeit.
- Rate-Limit am Proxy; der Server selbst verzögert nach fehlgeschlagenen Auths.
- Keine Nutzdaten in Logs — Logzeilen enthalten `deviceId` und Anzahl, nie
  Eintragstexte.
- HTTPS erzwungen, HSTS auf dem öffentlichen Weg.
- Backups sind Klartext. Sie gehören auf ein verschlüsseltes Medium.

**Ende-zu-Ende-Verschlüsselung** ist bewusst nicht in Phase 2: Solange der
Server der eigene ist und im VPN steht, schützt sie kaum, kostet aber
Schlüsselverwaltung auf jedem Gerät und macht serverseitige Extras wie den
ICS-Feed unmöglich. Falls der Server dauerhaft öffentlich steht, ist der Weg:
Passphrase → Argon2id → AES-GCM über `text` (nur dieses Feld), Metadaten
`updatedAt`/`kind` bleiben klar, damit die Sync-Logik unverändert bleibt. Das
Protokoll oben muss dafür nicht angefasst werden — nur der Feldinhalt.

## Rollout

| Schritt | Ergebnis |
| --- | --- |
| M1 | Server läuft lokal, `curl` gegen `/api/changes` funktioniert, Tests für LWW und Tombstones |
| M2 | Zwei Browserprofile am selben lokalen Server halten sich synchron |
| M3 | Kopplung per QR, Widerruf getestet |
| M4 | Tailscale und öffentlicher Weg produktiv, systemd, Backup eingerichtet |
| M5 | PWA zusätzlich vom Homeserver, same-origin, Needle-Assets lokal |

**Abnahmetest**, der alles auf einmal prüft: Handy in den Flugmodus, drei
Einträge anlegen, einen davon am Rechner löschen, einen anderen am Rechner
umschreiben, Flugmodus aus. Erwartet: der gelöschte Eintrag bleibt weg, der
umgeschriebene existiert genau einmal (oder als klar markierte Konfliktkopie,
falls beide Seiten am Text waren), die drei neuen stehen auf beiden Geräten.
