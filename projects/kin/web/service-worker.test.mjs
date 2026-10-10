import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function worker({ failPath, offline = false } = {}) {
  const listeners = new Map(); const stored = new Map([['kin-static-v0.28.0', new Map([['/index.html', new Response('old')]])]]);
  const clients = [{ postMessage() {} }];
  const cacheApi = {
    async open(name) { if (!stored.has(name)) stored.set(name, new Map()); const entries = stored.get(name); return { async put(key, value) { entries.set(key, value); }, async match(key) { return entries.get(key); }, async delete(key) { return entries.delete(key); } }; },
    async keys() { return [...stored.keys()]; }, async delete(name) { return stored.delete(name); },
  };
  const self = { registration: { active: true }, clients: { async matchAll() { return clients; }, async claim() {} }, location: { origin: 'https://kin.test' }, addEventListener(type, callback) { listeners.set(type, callback); }, async skipWaiting() {} };
  const context = { self, caches: cacheApi, URL, Response, Promise, fetch: async (request) => { const path = typeof request === 'string' ? request : new URL(request.url).pathname; if (offline || path === failPath) throw new Error('offline'); return new Response(`asset:${path}`); } };
  vm.runInNewContext(await readFile(new URL('./service-worker.js', import.meta.url), 'utf8'), context);
  return { listeners, stored };
}

test('complete new shell stages all assets while retaining prior cache until activation', async () => {
  const { listeners, stored } = await worker(); let install;
  listeners.get('install')({ waitUntil(value) { install = value; } }); await install;
  const next = stored.get('kin-static-v0.29.0'); assert.ok(next.has('/reminders.js')); assert.ok(next.has('/wasm/kin_engine.wasm'));
  assert.ok(stored.has('kin-static-v0.28.0'));
  let activation; listeners.get('activate')({ waitUntil(value) { activation = value; } }); await activation;
  assert.deepEqual([...stored.keys()], ['kin-static-v0.29.0']);
});

test('failed shell staging leaves the known-good cache available', async () => {
  const { listeners, stored } = await worker({ failPath: '/index.html' }); let install;
  listeners.get('install')({ waitUntil(value) { install = value; } }); await assert.rejects(install);
  assert.ok(stored.has('kin-static-v0.28.0'));
});

test('manifest declares an installable local app shell', async () => {
  const manifest = JSON.parse(await readFile(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  for (const key of ['name', 'short_name', 'description', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons']) assert.ok(manifest[key], key);
  assert.ok(manifest.icons.every(icon => icon.src.startsWith('/')));
});

test('offline navigation falls back to the shell and API requests bypass the worker', async () => {
  const { listeners, stored } = await worker({ offline: true });
  stored.set('kin-static-v0.29.0', new Map([['/index.html', new Response('offline-shell')]]));
  let response; let called = false;
  listeners.get('fetch')({ request: { method: 'GET', url: 'https://kin.test/', mode: 'navigate' }, respondWith(value) { called = true; response = value; } });
  assert.equal((await response).status, 200); assert.equal(await (await response).text(), 'offline-shell');
  called = false;
  listeners.get('fetch')({ request: { method: 'GET', url: 'https://kin.test/api/status', mode: 'cors' }, respondWith() { called = true; } });
  assert.equal(called, false);
});
