// Only source-controlled static shell assets are eligible for this cache.
// API, archives, projections, drafts and keys never pass through Cache.put.
const CACHE = "kin-static-v0.30.0";
const SHELL = [
  "/", "/index.html", "/styles/app.css", "/manifest.webmanifest", "/icon.svg",
  "/browser-time.js", "/calendar-export.js", "/household-validation.js", "/search.js", "/reminders.js", "/wasm/kin-engine.js", "/wasm/kin_engine.wasm",
  "/storage/event-store.js", "/storage/encrypted-idb.js", "/storage/root-rotation.js",
  "/security/local-vault.js", "/security/passkey-unlock.js", "/security/archive.js",
  "/sync/crypto.js", "/sync/key-store.js", "/sync/sync-coordinator.js",
  ...["app", "security", "household", "compose", "item", "today", "handoff-list", "talk-list", "search", "pulse", "catch-up", "routines", "areas", "notes"].map((name) => `/components/kin-${name}.js`),
];
const ALLOWED = new Set(SHELL);

self.addEventListener("install", (event) => {
  // Cache each public shell asset independently. A missing build artifact must
  // not leave the previous worker unusable or make online launch fail.
  const replacingWorker = Boolean(self.registration.active);
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    const results = await Promise.allSettled(SHELL.map(async (path) => {
      const response = await fetch(path, { cache: "reload" });
      if (!response.ok || response.type === "opaque") throw new Error("Shell asset unavailable");
      await cache.put(path, response);
    }));
    // Keep the previous worker and its cache if this version cannot stage a
    // complete shell. A partial new cache must never replace a working offline shell.
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Kin could not stage the complete offline shell.");
    if (replacingWorker) {
      for (const client of await self.clients.matchAll({ type: "window" }))
        client.postMessage({ type: "KIN_UPDATE_READY" });
    }
  }));
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "KIN_SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("kin-static-") && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate" && ["/", "/pair"].includes(url.pathname)) {
    // Never cache the requested URL (which could contain a pairing code).
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then((cache) => cache.match("/index.html"))));
  } else if (!url.search && ALLOWED.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(url.pathname);
      if (cached && cached.ok) return cached;
      if (cached) await cache.delete(url.pathname);
      return fetch(event.request);
    }));
  }
});
