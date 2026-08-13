/// <reference lib="webworker" />
// Web Worker für die Needle-Inferenz. Läuft off-main-thread, damit die 3–4 s
// pro Inferenz (single-thread WASM) die UI nicht einfrieren.
// Nachrichten: {id, type:"load"|"run", payload}. Antworten: {id, ok, result|error}.
// Fortschritt beim Modell-Download: {type:"progress", loaded, total}.
import init, { NeedleWasm } from "needle-rs";

const DEFAULT_WEIGHTS_URL =
  "https://huggingface.co/Abdalrahman/needle-rs-safetensors/resolve/main/needle.safetensors";
const DEFAULT_VOCAB_URL =
  "https://huggingface.co/Abdalrahman/needle-rs-safetensors/resolve/main/vocab.txt";
const MODEL_CACHE = "needle-model-v1";

type Engine = {
  run(query: string, toolsJson: string): string;
  run_stream(query: string, toolsJson: string, onToken: (id: number, piece: string) => void): string;
};
let engine: Engine | null = null;
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

async function ensureLoaded(weightsUrl?: string, vocabUrl?: string): Promise<void> {
  if (engine) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      await init();
      const [weightsRes, vocabRes] = await Promise.all([
        cachedFetch(weightsUrl ?? DEFAULT_WEIGHTS_URL, true),
        cachedFetch(vocabUrl ?? DEFAULT_VOCAB_URL, false),
      ]);
      const weights = new Uint8Array(await weightsRes.arrayBuffer());
      const vocab = await vocabRes.text();
      const loaded = NeedleWasm.load(weights, vocab);
      if (!loaded) throw new Error("Needle konnte nicht initialisiert werden");
      engine = loaded as unknown as Engine;
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data ?? {};
  try {
    if (type === "load") {
      const start = performance.now();
      await ensureLoaded(payload?.weightsUrl, payload?.vocabUrl);
      (self as unknown as Worker).postMessage({ id, ok: true, ms: performance.now() - start });
    } else if (type === "run") {
      await ensureLoaded(payload?.weightsUrl, payload?.vocabUrl);
      const start = performance.now();
      // Streaming: jedes Token sofort an den Main-Thread melden (Debug-Panel).
      const result = engine!.run_stream(payload.query, payload.tools, (_tokenId, piece) => {
        (self as unknown as Worker).postMessage({ type: "token", id, piece });
      });
      (self as unknown as Worker).postMessage({ id, ok: true, result, ms: performance.now() - start });
    }
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((error as Error)?.message ?? error) });
  }
};
