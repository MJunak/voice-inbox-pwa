// Needle-Engine hinter einer schmalen Schnittstelle.
// - Echte Implementierung: Needle 2 (offizielles Cactus-WASM) in einem Web
//   Worker. Tools werden beim Preload einmalig gebunden; eine Anfrage kostet
//   danach ~1,5 s (statt 5–8 s bei Needle 1, wo der Tool-Kontext jedes Mal
//   neu encodiert wurde).
// - Im Test wird über window.__needleEngine eine deterministische Mock-Engine
//   injiziert, sodass die Verdrahtung ohne Worker/Modell-Download testbar ist.

export interface NeedleEngine {
  run(query: string, toolsJson: string, onToken?: (piece: string) => void): Promise<string>;
}

export type ProgressCb = (loaded: number, total: number) => void;

// Vites ?worker-Import: liefert einen Worker-Konstruktor und wird sowohl im
// (vinext-)Dev-Modus als auch im Build korrekt aufgelöst – anders als
// new Worker(new URL(...), import.meta.url), das in vinext dev als file:// bricht.
import NeedleWorker from "./needle.worker?worker";

function injected(): NeedleEngine | undefined {
  return (window as unknown as { __needleEngine?: NeedleEngine }).__needleEngine;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
let progressCb: ProgressCb | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new NeedleWorker();
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data ?? {};
      if (data.type === "progress") {
        progressCb?.(data.loaded, data.total);
        return;
      }
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) entry.resolve(data.result as string);
      else entry.reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      for (const [, entry] of pending) entry.reject(new Error(event.message || "Worker-Fehler"));
      pending.clear();
    };
  }
  return worker;
}

// Test-/Debug-Overrides für die Asset-URLs (z. B. lokaler Server im E2E-Test;
// Playwrights route.fulfill schneidet große Binaries bei Worker-Fetches ab).
function urlOverrides(): { wasmUrl?: string; cactUrl?: string } {
  const w = window as unknown as { __NEEDLE2_WASM_URL?: string; __NEEDLE2_CACT_URL?: string };
  return { wasmUrl: w.__NEEDLE2_WASM_URL, cactUrl: w.__NEEDLE2_CACT_URL };
}

function call(type: "load" | "run", payload: Record<string, unknown>): Promise<string> {
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, payload: { ...urlOverrides(), ...payload } });
  });
}

// Lädt Modell + Engine im Worker vor und bindet die Tool-Liste (einmalig).
// Bei injizierter Test-Engine No-op.
export function preloadEngine(toolsJson: string, onProgress?: ProgressCb): Promise<void> {
  if (injected()) return Promise.resolve();
  progressCb = onProgress ?? progressCb;
  return call("load", { tools: toolsJson }).then(() => undefined);
}

const workerEngine: NeedleEngine = {
  run: (query, tools) => call("run", { query, tools }),
};

// Liefert die injizierte Test-Engine, sonst die Worker-Engine.
export function resolveEngine(onProgress?: ProgressCb): NeedleEngine {
  const mock = injected();
  if (mock) return mock;
  if (onProgress) progressCb = onProgress;
  return workerEngine;
}
