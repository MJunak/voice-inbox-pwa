const CACHE = "voice-inbox-v5";
// Geteilte Inhalte (Web Share Target) liegen hier nur bis die App sie abholt.
const SHARE_CACHE = "voice-inbox-share";
const ROOT = new URL("./", self.location.href).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([ROOT, `${ROOT}manifest.webmanifest`, `${ROOT}favicon.svg`]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key)))),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Share Target per POST: Inhalt nie in die URL (Server-Logs, Cache-Schlüssel),
  // sondern zwischenlagern und ohne Query auf die App umleiten.
  if (event.request.method === "POST" && url.origin === self.location.origin && url.pathname === `${ROOT}share-target`) {
    event.respondWith(
      (async () => {
        const form = await event.request.formData();
        const parts = ["title", "text", "url"].map((key) => String(form.get(key) ?? "").trim()).filter(Boolean);
        const text = parts.filter((part, index) => parts.indexOf(part) === index).join("\n");
        if (text) await (await caches.open(SHARE_CACHE)).put(`${ROOT}__shared`, new Response(text));
        return Response.redirect(ROOT, 303);
      })(),
    );
    return;
  }

  // API calls and browser-extension requests must bypass this app-shell cache.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !["http:", "https:"].includes(url.protocol)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Nur die App-Shell cachen, keine URLs mit Query-String.
        if (response.ok && response.type === "basic" && !url.search) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request, { ignoreSearch: event.request.mode === "navigate" })) ?? Response.error()),
  );
});
