// Needle-Engine hinter einer schmalen Schnittstelle.
// - Echte Implementierung: needle-rs (WASM) in einem Web Worker (off-main-thread,
//   damit die ~3–4 s Inferenz die UI nicht einfrieren).
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
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void; onToken?: (piece: string) => void }>();
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
      if (data.type === "token") {
        pending.get(data.id)?.onToken?.(data.piece as string);
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

function call(type: "load" | "run", payload: Record<string, unknown>, onToken?: (piece: string) => void): Promise<string> {
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onToken });
    getWorker().postMessage({ id, type, payload });
  });
}

// Lädt das Modell im Worker vor (einmalig). Bei injizierter Test-Engine No-op.
export function preloadEngine(onProgress?: ProgressCb): Promise<void> {
  if (injected()) return Promise.resolve();
  progressCb = onProgress ?? progressCb;
  return call("load", {}).then(() => undefined);
}

const workerEngine: NeedleEngine = {
  run: (query, tools, onToken) => call("run", { query, tools }, onToken),
};

// Liefert die injizierte Test-Engine, sonst die Worker-Engine (synchron;
// das eigentliche Laden passiert lazy im Worker bzw. via preloadEngine).
export function resolveEngine(onProgress?: ProgressCb): NeedleEngine {
  const mock = injected();
  if (mock) return mock;
  if (onProgress) progressCb = onProgress;
  return workerEngine;
}
