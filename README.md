# Voice Inbox PWA

Eine lokale, installierbare Voice-Inbox für Gedanken, Aufgaben, Termine und Ideen.

## Eigenschaften

- Spracheingabe über die Web Speech API
- lokale Kategorisierung ohne Backend
- Speicherung ausschließlich im Browser
- Suche und Filter
- offlinefähige PWA mit Service Worker
- keine Anmeldung und keine Cloud erforderlich

## Entwicklung

```bash
pnpm install
pnpm dev
```

Für einen Produktions-Build:

```bash
pnpm build
```

Die Spracheingabe funktioniert derzeit am zuverlässigsten in Chrome und Edge. Browser können für ihre Spracherkennung trotz lokal installierter PWA eine Internetverbindung benötigen.
