const CACHE = "voice-inbox-v3";
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
        .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API calls and browser-extension requests must bypass this app-shell cache.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !["http:", "https:"].includes(url.protocol)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) ?? Response.error()),
  );
});
