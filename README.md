# Voice Inbox PWA

Eine lokale, installierbare Voice-Inbox für Gedanken, Aufgaben, Termine und Ideen.

## Eigenschaften

- Spracheingabe über die Web Speech API
- lokale Kategorisierung ohne Backend
- Steuerung per natürlicher Sprache über ein lokales LLM
  (Cactus Needle 2, WASM im Browser) – siehe [docs/needle-agent.md](docs/needle-agent.md)
- Speicherung ausschließlich im Browser
- Suche und Filter, Karten- und Listenansicht
- JSON-Export/-Import des gesamten Bestands
- offlinefähige PWA mit Service Worker
- keine Anmeldung und keine Cloud erforderlich

## Wohin es geht

- [docs/roadmap.md](docs/roadmap.md) – geplante Features und ihre Reihenfolge
- [docs/sync.md](docs/sync.md) – Konzept für Sync zwischen Geräten über einen
  eigenen Server auf dem Homeserver
- [docs/assistant.md](docs/assistant.md) – Konzept für den Assistenten: ein
  großes Modell räumt den Bestand auf, priorisiert und erzeugt Einträge aus
  eingefügtem Text

## Entwicklung

```bash
pnpm install
pnpm dev
```

Für einen Produktions-Build:

```bash
pnpm build
```

Der Produktions-Build erzeugt die statische PWA in `dist-pages`. Der optionale
Cloudflare-Worker-Build steht separat über `pnpm build:worker` zur Verfügung.

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
