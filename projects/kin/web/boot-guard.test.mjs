// The start-up guard (#594): a failed module graph loads the page again, at
// most twice in a row, and a reload it makes never turns a locked start into
// a refresh-resume (#351).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./boot-guard.js", import.meta.url), "utf8");

function page({ navigation = "navigate", stored = {}, storageThrows = false } = {}) {
  const items = new Map(Object.entries(stored));
  const storage = {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
  const listeners = [];
  const appended = [];
  let defined;
  const element = (tagName) => ({
    tagName: tagName.toUpperCase(), children: [], attributes: {}, listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  });
  const body = { appendChild(child) { appended.push(child); } };
  const win = {
    reloads: 0,
    location: { reload() { win.reloads += 1; } },
    get sessionStorage() { if (storageThrows) throw new Error("blocked"); return storage; },
    performance: { getEntriesByType: () => [{ type: navigation }] },
    customElements: { whenDefined: () => new Promise((resolve) => { defined = resolve; }) },
    addEventListener(type, callback, capture) { listeners.push({ type, callback, capture }); },
    document: {
      body,
      createElement: element,
      querySelector: (selector) => (selector === "[data-kin-boot-failed]" ? appended[0] ?? null : null),
    },
  };
  vm.runInNewContext(source, { window: win, Number, String, Boolean });
  const fail = (src = "http://kin.test/components/kin-app.js") => {
    for (const { type, callback } of listeners) if (type === "error") callback({ target: { tagName: "SCRIPT", type: "module", src } });
  };
  return { win, items, listeners, appended, fail, start: () => defined?.() };
}

test("the guard listens for errors while capturing, on the window", () => {
  const { listeners } = page();
  assert.deepEqual(listeners.map(({ type, capture }) => [type, capture]), [["error", true]]);
});

test("a failed app module graph loads the page again, twice at most, then explains", () => {
  const first = page();
  first.fail();
  assert.equal(first.win.reloads, 1);
  assert.equal(first.items.get("kin.boot-retry"), "1");

  const second = page({ navigation: "reload", stored: Object.fromEntries(first.items) });
  second.fail();
  assert.equal(second.win.reloads, 1);
  assert.equal(second.items.get("kin.boot-retry"), "2");

  const third = page({ navigation: "reload", stored: Object.fromEntries(second.items) });
  third.fail();
  assert.equal(third.win.reloads, 0, "no third reload in a row");
  assert.equal(third.appended.length, 1);
  assert.equal(third.appended[0].attributes.role, "alert");
  third.fail();
  assert.equal(third.appended.length, 1, "the message is shown once");
  third.appended[0].children[1].listeners.click();
  assert.equal(third.win.reloads, 1, "Try again reloads");
  assert.equal(third.items.has("kin.boot-retry"), false, "and starts counting again");
});

test("a reload after a load that wasn't a refresh drops the resume ticket, so it stays locked", () => {
  const navigated = page({ navigation: "navigate", stored: { "kin.reload-resume": "{}" } });
  navigated.fail();
  assert.equal(navigated.win.reloads, 1);
  assert.equal(navigated.items.has("kin.reload-resume"), false);

  const refreshed = page({ navigation: "reload", stored: { "kin.reload-resume": "{}" } });
  refreshed.fail();
  assert.equal(refreshed.win.reloads, 1);
  assert.equal(refreshed.items.get("kin.reload-resume"), "{}", "a refresh stays a refresh");
});

test("only the app's own module script counts as a failed start", () => {
  const { win, listeners } = page();
  const onError = listeners[0].callback;
  onError({ target: win });
  onError({ target: { tagName: "IMG", src: "http://kin.test/components/kin-app.js" } });
  onError({ target: { tagName: "SCRIPT", type: "module", src: "http://kin.test/other.js" } });
  onError({ target: { tagName: "SCRIPT", type: "", src: "http://kin.test/components/kin-app.js" } });
  assert.equal(win.reloads, 0);
});

test("a started Kin clears the count", async () => {
  const { items, start } = page({ stored: { "kin.boot-retry": "2" } });
  start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(items.has("kin.boot-retry"), false);
});

test("without session storage the guard explains rather than risk reloading for ever", () => {
  const { win, appended, fail } = page({ storageThrows: true });
  fail();
  assert.equal(win.reloads, 0);
  assert.equal(appended.length, 1);
});
