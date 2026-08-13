/// <reference lib="webworker" />
// Web Worker für Needle 2 (Cactus, offizielles WASM-Build).
// Architektur-Vorteil ggü. Needle 1: die Tool-Liste wird EINMAL bei needle_init
// gebunden (KV-Sinks), nicht pro Anfrage neu encodiert -> ~1,5 s statt 5–8 s.
// Assets (Engine 315 KB + Modell 13,7 MB) kommen von HuggingFace mit gepinnter
// Revision und landen im Cache Storage (offline-fähig nach erstem Laden).
// Achtung: Das WASM-Build liefert in Node leere Antworten – nur im Browser nutzen.
import createNeedle from "./vendor/needle.js";

const REVISION = "07f3e789e993e8ecf69ef5409fd7558f5fe43202";
const BASE = `https://huggingface.co/Cactus-Compute/needle2/resolve/${REVISION}`;
const DEFAULT_WASM_URL = `${BASE}/wasm/needle.wasm`;
const DEFAULT_CACT_URL = `${BASE}/needle2.cact`;
const MODEL_CACHE = "needle2-model-v1";
const OUT_CAPACITY = 16384;

type EmscriptenModule = {
  _malloc(n: number): number;
  _free(p: number): void;
  HEAPU8: Uint8Array;
  UTF8ToString(p: number): string;
  _needle_load(p: number, n: bigint): number;
  _needle_init(systemPtr: number, toolsPtr: number): number;
  _needle_complete(inputPtr: number, maxTokens: number, outPtr: number, cap: number): number;
  _needle_reset(): void;
};

let runtime: EmscriptenModule | null = null;
let outPtr = 0;
let boundTools: string | null = null;
let loadPromise: Promise<void> | null = null;

async function cachedFetch(url: string, withProgress: boolean): Promise<Response> {
  const caches = (self as unknown as { caches?: CacheStorage }).caches;
  if (caches) {
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) return hit;
    const response = await fetchWithProgress(url, withProgress);
    await cache.put(url, response.clone());
    return response;
  }
  return fetchWithProgress(url, withProgress);
}

async function fetchWithProgress(url: string, withProgress: boolean): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download fehlgeschlagen (${response.status})`);
  if (!withProgress || !response.body) return response;
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    (self as unknown as Worker).postMessage({ type: "progress", loaded, total });
  }
  return new Response(new Blob(chunks as BlobPart[]), { headers: response.headers });
}

function cString(M: EmscriptenModule, value: string): number {
  const bytes = new TextEncoder().encode(value);
  const p = M._malloc(bytes.length + 1);
  M.HEAPU8.set(bytes, p);
  M.HEAPU8[p + bytes.length] = 0;
  return p;
}

async function ensureLoaded(wasmUrl?: string, cactUrl?: string): Promise<EmscriptenModule> {
  if (runtime) return runtime;
  if (!loadPromise) {
    loadPromise = (async () => {
      const [wasmRes, cactRes] = await Promise.all([
        cachedFetch(wasmUrl ?? DEFAULT_WASM_URL, false),
        cachedFetch(cactUrl ?? DEFAULT_CACT_URL, true),
      ]);
      const M = (await createNeedle({ wasmBinary: new Uint8Array(await wasmRes.arrayBuffer()) })) as EmscriptenModule;
      const model = new Uint8Array(await cactRes.arrayBuffer());
      const p = M._malloc(model.length);
      M.HEAPU8.set(model, p);
      const rc = M._needle_load(p, BigInt(model.length));
      // WICHTIG: p NIEMALS freigeben – die Engine referenziert die Gewichte
      // zero-copy in diesem Puffer. Ein _free(p) führt zu stillem Weight-
      // Corruption (leere function_calls, confidence konstant 0.2).
      if (rc !== 0) throw new Error(`Needle-2-Modell konnte nicht geladen werden (rc=${rc})`);
      outPtr = M._malloc(OUT_CAPACITY);
      runtime = M;
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  await loadPromise;
  return runtime!;
}

// Bindet die Tool-Liste (idempotent; nur bei Änderung wird neu initialisiert).
function bindTools(M: EmscriptenModule, tools: string) {
  if (boundTools === tools) return;
  const sysPtr = cString(M, "");
  const toolsPtr = cString(M, tools);
  try {
    if (M._needle_init(sysPtr, toolsPtr) < 0) throw new Error("needle_init fehlgeschlagen");
    boundTools = tools;
  } finally {
    M._free(sysPtr);
    M._free(toolsPtr);
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data ?? {};
  try {
    if (type === "load") {
      const M = await ensureLoaded(payload?.wasmUrl, payload?.cactUrl);
      if (payload?.tools) bindTools(M, payload.tools);
      (self as unknown as Worker).postMessage({ id, ok: true });
    } else if (type === "run") {
      const M = await ensureLoaded(payload?.wasmUrl, payload?.cactUrl);
      bindTools(M, payload.tools);
      M._needle_reset();
      const start = performance.now();
      const qPtr = cString(M, payload.query);
      try {
        M._needle_complete(qPtr, 512, outPtr, OUT_CAPACITY);
      } finally {
        M._free(qPtr);
      }
      const result = M.UTF8ToString(outPtr);
      (self as unknown as Worker).postMessage({ id, ok: true, result, ms: performance.now() - start });
    }
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((error as Error)?.message ?? error) });
  }
};
