# Voice Inbox PWA

Eine lokale, installierbare Voice-Inbox für Gedanken, Aufgaben, Termine und Ideen.

## Eigenschaften

- Spracheingabe über die Web Speech API
- lokale Kategorisierung ohne Backend
- Steuerung per natürlicher Sprache über ein lokales LLM
  (Cactus Needle 2, WASM im Browser) – siehe [docs/needle-agent.md](docs/needle-agent.md)
- Speicherung im Browser, optional synchronisiert über den eigenen Server
- Einträge abhaken (Filter Offen / Erledigt / Gesamt) und nachträglich bearbeiten
- Fälligkeiten werden aus dem Text erkannt („morgen 15 Uhr“, „am Freitag“,
  „12.10.“, „in 3 Tagen“, „tomorrow at 3pm“, „mañana a las 10“); fällige
  Einträge stehen oben, Überfälliges ist rot, Wiedervorlage per +1 Tag/Woche
- Suche und Filter, Karten- und Listenansicht
- JSON-Export/-Import (Import ergänzt den Bestand statt ihn zu ersetzen) und
  Markdown-Export mit Checkboxen
- Teilen-Ziel: Als installierte PWA (Android/Chrome) lässt sich Text aus
  anderen Apps direkt in die Inbox teilen
- offlinefähige PWA mit Service Worker
- keine Anmeldung und keine Cloud erforderlich

## Entwicklung

```bash
pnpm install
pnpm dev
```

Tests:

```bash
pnpm lint && pnpm typecheck
pnpm test          # Build + Unit-Tests (Datenmodell, Datumserkennung)
pnpm test:server   # Sync-Server (Python)
pnpm test:e2e      # Playwright, inkl. Zwei-Geräte-Sync gegen den echten Server
```

In Containern mit vorinstalliertem Chromium: `PW_CHROMIUM_PATH=/pfad/zu/chromium pnpm test:e2e`.

Für einen Produktions-Build:

```bash
pnpm build
```

Der Produktions-Build erzeugt die statische PWA in `dist-pages`. Der optionale
Cloudflare-Worker-Build steht separat über `pnpm build:worker` zur Verfügung.

## Sync über den eigenen Server

`server/` enthält einen kleinen Sync-Server (Python-Standardbibliothek +
SQLite, keine Abhängigkeiten). Start per Docker:

```bash
cp .env.example .env   # API_TOKEN und ALLOWED_ORIGIN setzen
docker compose up -d   # lauscht auf 127.0.0.1:8787, davor z. B. Tailscale oder Reverse Proxy
```

In der App oben rechts „Sync einrichten“ öffnen, API-Adresse und Token
eintragen. Danach synchronisiert die App automatisch: kurz nach jeder Änderung,
beim Wiederverbinden und beim Zurückkehren in die App. Konflikte löst
„neuester Stand gewinnt“ pro Eintrag; Löschungen werden als Tombstones
übertragen, damit sie auf anderen Geräten nicht wieder auftauchen.

## GitHub Pages

Der Workflow `.github/workflows/deploy-pages.yml` baut und veröffentlicht die
statische App bei jedem Push auf `main`. Er kann außerdem im Actions-Tab manuell
gestartet werden. Im Repository muss unter **Settings → Pages** als Quelle
**GitHub Actions** ausgewählt sein.

Für einen lokalen Pages-Build:

```bash
pnpm build
```

Die Spracheingabe funktioniert derzeit am zuverlässigsten in Chrome und Edge. Browser können für ihre Spracherkennung trotz lokal installierter PWA eine Internetverbindung benötigen.
