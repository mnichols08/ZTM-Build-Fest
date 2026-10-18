// Only source-controlled static shell assets are eligible for this cache.
// API, archives, projections, drafts and keys never pass through Cache.put.
// index.html supplies the current release in the registration URL. The old
// active worker keeps its own version while the new worker stages separately.
// The release may carry semver build metadata (a fingerprint of the served
// shell files added by the Kin server) so a changed shell gets a new cache.
const RELEASE = new URL(self.location.href).searchParams.get("v");
if (!/^\d+\.\d+\.\d+(\+[a-z0-9]{1,32})?$/.test(RELEASE ?? "")) throw new Error("Kin service worker release is missing.");
const CACHE = `kin-static-v${RELEASE}`;
const SHELL = [
  // Not the manifest or /install-icon/*: they depend on the household that
  // published an install identity (#78), so they always come from the network.
  "/", "/index.html", "/styles/app.css", "/icon.svg",
  "/browser-time.js", "/platform.js", "/pairing-link.js", "/device-link.js", "/calendar-export.js", "/household-validation.js", "/search.js", "/reminders.js", "/wasm/kin-engine.js", "/wasm/kin_engine.wasm", "/wasm/kin-qr.js",
  "/wasm/wire.js", "/wasm/history-mirror.js", "/wasm/projection-decode.js", "/wasm/projection/reader.js", "/wasm/projection/items.js",
  "/wasm/projection/conversations.js", "/wasm/projection/routines.js", "/wasm/projection/records.js",
  "/routes.js", "/today-view.js", "/reminder-time.js", "/capture-plan.js", "/keyboard-commands.js", "/bulk-actions.js", "/recurrence.js",
  "/attachments/attachment-crypto.js", "/attachments/attachment-lifecycle.js", "/attachments/attachment-permissions.js", "/attachments/attachment-preview.js", "/attachments/attachment-progress.js", "/attachments/object-urls.js",
  "/storage/event-store.js", "/storage/event-arena.js", "/storage/encrypted-idb.js", "/storage/root-rotation.js", "/storage/quarantine.js",
  "/security/local-vault.js", "/security/passkey-unlock.js", "/security/archive.js", "/security/archive-stream.js", "/security/key-label.js",
  "/appearance/palette.js", "/appearance/image.js", "/appearance/store.js", "/appearance/household.js", "/appearance/install-icons.js",
  "/sync/crypto.js", "/sync/key-store.js", "/sync/sync-coordinator.js", "/sync/envelope-wire.js",
  ...["app", "appearance", "household-defaults", "install-identity", "notifications", "security", "household", "quick-add", "command-palette", "compose", "item", "item-detail", "today", "handoff-list", "talk-list", "search", "segment-nav", "sync-status", "reminder", "pulse", "catch-up", "routines", "areas", "notes", "attachments", "responsibility", "bulk-bar", "playbook-editor", "routine-schedule", "qr", "qr-scanner"].map((name) => `/components/kin-${name}.js`),
  "/components/app/appearance.js", "/components/app/attachments.js", "/components/app/commands/append.js", "/components/app/commands/bulk.js", "/components/app/commands/conversations.js", "/components/app/commands/items.js", "/components/app/commands/records.js", "/components/app/commands/routines.js", "/components/app/constants.js", "/components/app/context.js", "/components/app/detail.js", "/components/app/navigation.js", "/components/app/peer-channel.js", "/components/app/refresh.js", "/components/app/render.js", "/components/app/session.js", "/components/app/shell.js", "/components/app/status.js", "/components/app/sync.js", "/components/app/views.js",
  ...["dom", "focus", "icons", "operation", "props", "session-guard"].map((name) => `/components/shared/${name}.js`),
  ...["api", "auth", "lifecycle", "link", "membership", "pairing", "views"].map((name) => `/components/household/${name}.js`),
  ...["archive", "protection", "unlock", "views"].map((name) => `/components/security/${name}.js`),
  ...["focus", "sections", "selection"].map((name) => `/components/today/${name}.js`),
  "/components/item-detail/sections.js", "/components/notes/notes.js", "/components/notes/references.js",
];
const ALLOWED = new Set(SHELL);

self.addEventListener("install", (event) => {
  // Cache each public shell asset independently. A missing build artifact must
  // not leave the previous worker unusable or make online launch fail.
  const replacingWorker = Boolean(self.registration.active);
  event.waitUntil((async () => {
    if ((await caches.keys()).includes(CACHE))
      throw new Error("Kin release cache already exists; a changed shell needs a new release version.");
    const cache = await caches.open(CACHE);
    try {
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
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
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

// ---- Push notifications (#85) ----------------------------------------------
// A push says only that something is new: the payload is fixed and carries no
// household content, and this worker never opens the key stores or decrypts
// anything. It always shows a notification (browsers require one for every
// push). Nothing here is cached.

// The installed app's own name (#78), if the household published one, so the
// notification matches the home-screen icon. Kin otherwise.
async function notificationIdentity() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch("/manifest.webmanifest", { credentials: "include", cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error("no manifest");
    const manifest = await response.json();
    const name = typeof manifest.short_name === "string" && manifest.short_name.trim() ? manifest.short_name.trim().slice(0, 48) : "Kin";
    const icon = manifest.icons?.find((entry) => entry.type === "image/png" && entry.purpose !== "maskable")?.src;
    return { name, icon: typeof icon === "string" && icon.startsWith("/") ? icon : "/icon.svg" };
  } catch {
    return { name: "Kin", icon: "/icon.svg" };
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const { name, icon } = await notificationIdentity();
    await self.registration.showNotification(name === "Kin" ? "Kin" : name, {
      body: name === "Kin" ? "Something new in Kin" : `Something new in ${name}`,
      tag: "kin-new",
      renotify: false,
      icon,
      badge: icon,
      data: { url: "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    // Focus an open Kin window, else open one. Kin's own lock applies.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) return existing.focus();
    return self.clients.openWindow("/");
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;
    if (!applicationServerKey) return;
    const subscription = event.newSubscription ??
      await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    const json = subscription.toJSON();
    await fetch("/api/push/subscription", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    }).catch(() => {});
  })());
});
