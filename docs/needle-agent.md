# Needle-Sprachbefehle (Cactus Needle 2, WASM im Browser)

Die Inbox lässt sich per natürlicher Sprache steuern: Befehl in die dunkle
Command-Bar tippen (oder diktieren und rüberkopieren), **Ausführen** — fertig.
Die Interpretation übernimmt **Needle 2**, ein 45M-Parameter-Tool-Calling-Modell
von [Cactus Compute](https://cactuscompute.com/needle), das **komplett im
Browser** läuft (WebAssembly). Kein Backend, keine Cloud, keine API-Keys —
passend zum Rest der App.

## Was geht

| Befehl (Beispiele) | Aktion | Pfad |
| --- | --- | --- |
| „zeig mir die Liste“ / „Kartenansicht“ | Ansicht wechseln | Fast-Path (sofort) |
| „nur Termine“ / „filter Ideen“ | Kategorie-Filter | Fast-Path (sofort) |
| „such nach Anna“ | Suche setzen | Fast-Path (sofort) |
| „Lösch die letzte Notiz“ | neuesten Eintrag löschen (kategorie-bewusst) | Fast-Path (sofort) |
| „export“ | JSON-Export | Fast-Path (sofort) |
| „leg eine Notiz an: Milch kaufen“ | Eintrag anlegen | Modell (~0,3–1,5 s) |
| „lösche den Zahnarzt-Termin“ | Einträge per Texttreffer löschen | Modell |
| „mach aus dem Buchtipp eine Aufgabe“ | Kategorie ändern | Modell |

**Fast-Path**: eindeutige Formulierungen werden per Regex direkt ausgeführt,
ganz ohne Modell (0 ms). Alles andere geht durch Needle 2.

## Architektur

```
Command-Bar (page.tsx)
  └─ tryFastPath()          app/agent/actions.ts   Regex -> ToolCall, 0 ms
  └─ resolveEngine()        app/agent/engine.ts    Schnittstelle + Worker-RPC
       └─ needle.worker.ts  Web Worker             WASM-Inferenz off-main-thread
            └─ vendor/needle.js                    offizieller Emscripten-Loader
  └─ runToolCalls()         app/agent/actions.ts   ToolCall -> App-Aktion
```

- **Tools** (`TOOLS` in `actions.ts`): 8 Aktionen im Needle-Format
  (`{name, description, parameters}`), Beschreibungen knapp und englisch.
  Sie werden beim Init **einmal** gebunden (KV-Sinks) — die Listenlänge kostet
  danach pro Anfrage nichts.
- **Assets**: Engine (`needle.wasm`, ~315 KB) und Modell (`needle2.cact`,
  ~14 MB) kommen von HuggingFace
  ([Cactus-Compute/needle2](https://huggingface.co/Cactus-Compute/needle2),
  **Revision gepinnt** in `needle.worker.ts`) und landen im Cache Storage —
  nach dem ersten Laden offline verfügbar. Preload startet ~1 s nach App-Start,
  Fortschritt zeigt der Chip in der Command-Bar (`Needle lädt … 43 %` →
  `Needle bereit`).
- **Antwortformat**: Needle liefert ein JSON-Envelope mit `function_calls`,
  `reasoning`, `confidence` und `validation`. Der Executor in `actions.ts`
  normalisiert Argumente fuzzy (z. B. „Liste“/„list view“ → `list`), versteht
  positionale Referenzen („letzte …“) und übersteht doppelte Argument-Keys.

## Debug-Panel

Unter der Command-Bar: **„Debug: Inferenz“** aufklappen. Zeigt pro Befehl:

- **Pfad** — Fast-Path (Regex) oder Needle 2 (WASM)
- **Roh-Ausgabe** — das unveränderte Modell-JSON
- **Reasoning** — Herleitung des Modells (z. B. `'Liste' -> view 'list'`)
- **Confidence** — kalibrierter Score; unter ~5 % ist die Aktion geraten
- **Dauer**

## Gesammelte Stolperfallen (teuer erkauft, bitte nicht wieder einbauen)

1. **Modell-Puffer nach `needle_load` niemals `_free()`en.** Die Engine
   referenziert die Gewichte zero-copy im übergebenen Puffer. Ein Free
   korrumpiert sie **still**: keine Fehler, aber leere `function_calls` und
   Confidence konstant 0.2.
2. **Das WASM-Build liefert in Node leere Antworten.** Nur im Browser testen
   (deshalb der Playwright-Live-Test statt Node-Smoke-Tests).
3. **Playwrights `route.fulfill` schneidet große Binaries bei Fetches aus Web
   Workern ab** (beobachtet: 13,7 MB → 17 KB). Im Live-Test die Assets deshalb
   über einen lokalen HTTP-Server bedienen und per
   `window.__NEEDLE2_WASM_URL` / `__NEEDLE2_CACT_URL` umbiegen.
4. **`vendor/needle.js` ist gepatcht**: `require("node:fs")`/UMD-Footer
   entfernt, ESM-Export angehängt. Ohne Patch injiziert Vites CJS-Plugin einen
   `node:fs`-Browser-Stub und das Modul stirbt im Worker. Beim Aktualisieren
   des Vendors (neue HF-Revision) Patch erneut anwenden — Header in der Datei
   beschreibt Quelle + Revision.
5. **`new Worker(new URL(...))` bricht im vinext-Dev-Modus** (file://-URL).
   Deshalb der Vite-`?worker`-Import in `engine.ts`.
6. **Engine + Modell müssen als Paar passen.** Immer dieselbe HF-Revision für
   `needle.wasm` und `needle2.cact` verwenden (deshalb der Revision-Pin).

## Tests

```bash
pnpm test:e2e          # 29 Tests mit gemockter Engine (window.__needleEngine)
pnpm test:e2e:shots    # Screenshots nach e2e/screens/ (visueller Check)

# Echte WASM-Inferenz im Browser (einmalig Assets besorgen):
mkdir -p /tmp/needle2 && cd /tmp/needle2
curl -LO https://huggingface.co/Cactus-Compute/needle2/resolve/main/wasm/needle.wasm
curl -LO https://huggingface.co/Cactus-Compute/needle2/resolve/main/needle2.cact
cd - && RUN_NEEDLE_LIVE=1 WEIGHTS_DIR=/tmp/needle2 npx playwright test needle-live.spec.ts
```

Der Mock wird in `e2e/helpers.ts` (`installNeedleMock`) injiziert und
verhindert zugleich den echten Modell-Download beim App-Start. Details zur
Test-Loop: [e2e/README.md](../e2e/README.md).

## Historie / Messwerte

- **Needle 1** (`needle-rs`, 26M, 22 MB INT4): 5–8 s pro Befehl. Ursache:
  Time-to-first-token ≈ 97 % der Laufzeit, der Tool-Kontext wurde bei jeder
  Anfrage neu encodiert (Prefill wächst überproportional mit der Kontextlänge).
- **Needle 2** (45M, 14 MB, CQ2-quantisiert): ~0,3–1,5 s pro Befehl, weil die
  Tools beim Init einmalig gebunden werden. Zusätzlich Reasoning, Confidence
  und grammatik-erzwungenes JSON (kein kaputtes Format möglich).
- Lizenz Needle 2: Apache-2.0.
