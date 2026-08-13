# E2E-Tests (Playwright)

Feedback-Loop, um Änderungen vor dem Commit zu verifizieren – funktional **und** visuell.

## Befehle

```bash
pnpm test:e2e         # alle E2E-Tests (funktional)
pnpm test:e2e:shots   # nur die Screenshots erzeugen -> e2e/screens/
```

Der Dev-Server wird bei Bedarf automatisch gestartet (`webServer` in
`playwright.config.ts`); ein bereits laufender Server auf Port 3000 wird
weiterverwendet.

## Dateien

- `app.spec.ts` – funktionale Tests (Tippen, Sprache, Filter/Suche, Löschen …).
- `agent.spec.ts` – Needle-Command-Verdrahtung mit gemockter Engine
  (deterministisch, ohne Modell-Download), inkl. Fuzzy-Enum-, Envelope- und
  Fast-Path-Fällen.
- `needle-live.spec.ts` – ECHTE Needle-2-WASM-Engine im Browser (Worker +
  Inferenz). Gated: `RUN_NEEDLE_LIVE=1 WEIGHTS_DIR=<pfad>` mit `needle.wasm` +
  `needle2.cact` (von huggingface.co/Cactus-Compute/needle2). Die Assets werden
  über einen lokalen HTTP-Server bedient – NICHT über page.route/fulfill:
  Playwright schneidet große Binaries bei Fetches aus Web Workern ab.
- `screenshots.spec.ts` – erzeugt benannte Screenshots unter `e2e/screens/`
  (`01-empty.png`, `02-entries.png`, `03-composer.png`). Diese PNGs sind der
  visuelle Check vor einem Commit.
- `helpers.ts`
  - `installSpeechMock(page)` – ersetzt die Web Speech API, damit Sprache ohne
    Mikrofon testbar ist.
  - `emitSpeech(page, text)` – schiebt ein Erkennungsergebnis in die laufende
    Aufnahme.
  - `seedEntries(page, entries)` – befüllt die Inbox über `localStorage`.
  - `installNeedleMock(page, rules)` – injiziert `window.__needleEngine`;
    verhindert zugleich den echten 22-MB-Preload beim App-Start.

## Artefakte

`e2e/screens/`, `e2e/report/`, `e2e/artifacts/` sind gitignored und werden bei
Bedarf neu erzeugt.
