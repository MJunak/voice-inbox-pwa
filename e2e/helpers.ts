import type { Page } from "@playwright/test";

// Mock der Web Speech API. Wird per addInitScript vor dem App-Code injiziert,
// sodass Tests die Spracheingabe ohne echtes Mikrofon steuern können.
// Im Test: await emitSpeech(page, "Text") schiebt ein finales Ergebnis rein.
export async function installSpeechMock(page: Page) {
  await page.addInitScript(() => {
    class MockSpeechRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((event: { results: ArrayLike<unknown> }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        (window as unknown as { __activeRecognition: unknown }).__activeRecognition = this;
      }
      stop() {
        const w = window as unknown as { __activeRecognition: unknown };
        if (w.__activeRecognition === this) w.__activeRecognition = null;
        this.onend?.();
      }
    }
    const w = window as unknown as {
      SpeechRecognition: unknown;
      webkitSpeechRecognition: unknown;
      __emitSpeech: (transcript: string, isFinal?: boolean) => boolean;
    };
    w.SpeechRecognition = MockSpeechRecognition as unknown;
    w.webkitSpeechRecognition = MockSpeechRecognition as unknown;
    w.__emitSpeech = (transcript: string, isFinal = true) => {
      const rec = (window as unknown as { __activeRecognition: MockSpeechRecognition | null })
        .__activeRecognition;
      if (!rec || !rec.onresult) return false;
      const result = { isFinal, 0: { transcript }, length: 1 } as unknown as ArrayLike<unknown>[number];
      rec.onresult({ results: [result] as unknown as ArrayLike<unknown> });
      return true;
    };
  });
}

// Sendet ein Spracherkennungs-Ergebnis in die laufende Aufnahme.
export async function emitSpeech(page: Page, transcript: string, isFinal = true) {
  return page.evaluate(
    ({ transcript, isFinal }) =>
      (window as unknown as { __emitSpeech: (t: string, f: boolean) => boolean }).__emitSpeech(
        transcript,
        isFinal,
      ),
    { transcript, isFinal },
  );
}

// Injiziert eine deterministische Needle-Engine (window.__needleEngine), damit
// die Command-Verdrahtung ohne den echten 22-MB-Modell-Download getestet werden
// kann. `rules` bildet einen Query-Teilstring auf die JSON-Antwort ab, die die
// echte Needle-Engine liefern würde (z. B. '[{"name":"switch_view",...}]').
export type NeedleRule = { match: string; response: string };
export async function installNeedleMock(page: Page, rules: NeedleRule[]) {
  await page.addInitScript((rules) => {
    (window as unknown as { __needleEngine: unknown }).__needleEngine = {
      run(query: string) {
        const q = query.toLowerCase();
        const rule = (rules as NeedleRule[]).find((r) => q.includes(r.match.toLowerCase()));
        return Promise.resolve(rule ? rule.response : "[]");
      },
    };
  }, rules);
}

// Seedet die Inbox über localStorage, damit visuelle Tests einen realistischen
// Zustand zeigen können, ohne alles per Sprache/Tippen aufzubauen.
export type SeedEntry = { id: string; kind: string; text: string; created: string };
export async function seedEntries(page: Page, entries: SeedEntry[]) {
  await page.addInitScript((entries) => {
    localStorage.setItem("voice-inbox-entries", JSON.stringify(entries));
  }, entries);
}
