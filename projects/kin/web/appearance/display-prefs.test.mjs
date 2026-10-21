// This device's text size, motion and reminder-alert choices (#524).
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEVICE_ONLY_KEY, MOTION_KEY, REMINDER_ALERTS_KEY, TEXT_SIZE_KEY, applyDisplayPrefs, applyStoredDisplayPrefs,
  prefersReducedMotion, readDisplayPref, writeDisplayPref,
} from "./display-prefs.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
}

test("unset, unknown or unreadable values read as the defaults", () => {
  const storage = memoryStorage();
  assert.equal(readDisplayPref(TEXT_SIZE_KEY, storage), "standard");
  assert.equal(readDisplayPref(MOTION_KEY, storage), "system");
  assert.equal(readDisplayPref(REMINDER_ALERTS_KEY, storage), "on");
  assert.equal(readDisplayPref(DEVICE_ONLY_KEY, storage), "off");
  storage.setItem(TEXT_SIZE_KEY, "huge");
  assert.equal(readDisplayPref(TEXT_SIZE_KEY, storage), "standard");
  assert.equal(readDisplayPref(MOTION_KEY, { getItem() { throw new Error("blocked"); } }), "system");
  assert.throws(() => readDisplayPref("kin.other", storage), RangeError);
});

test("choices are kept, a default is kept as nothing, and failures say so", () => {
  const storage = memoryStorage();
  assert.equal(writeDisplayPref(TEXT_SIZE_KEY, "larger", storage), true);
  assert.equal(readDisplayPref(TEXT_SIZE_KEY, storage), "larger");
  assert.equal(writeDisplayPref(TEXT_SIZE_KEY, "standard", storage), true);
  assert.equal(storage.values.has(TEXT_SIZE_KEY), false);
  assert.throws(() => writeDisplayPref(MOTION_KEY, "fast", storage), RangeError);
  assert.equal(writeDisplayPref(MOTION_KEY, "reduce", { setItem() { throw new Error("full"); } }), false);
});

test("text size and motion go on the document root, and Kin's own motion setting counts", () => {
  const root = { dataset: {} };
  applyDisplayPrefs({ textSize: "large", motion: "reduce" }, root);
  assert.deepEqual(root.dataset, { kinTextSize: "large", kinMotion: "reduce" });
  applyDisplayPrefs({ textSize: "standard", motion: "system" }, root);
  assert.deepEqual(root.dataset, {});
  const storage = memoryStorage();
  storage.setItem(TEXT_SIZE_KEY, "larger");
  applyStoredDisplayPrefs(storage, root);
  assert.deepEqual(root.dataset, { kinTextSize: "larger" });
  const view = (own, system) => ({ document: { documentElement: { dataset: own ? { kinMotion: "reduce" } : {} } }, matchMedia: () => ({ matches: system }) });
  assert.equal(prefersReducedMotion(view(true, false)), true);
  assert.equal(prefersReducedMotion(view(false, true)), true);
  assert.equal(prefersReducedMotion(view(false, false)), false);
});
