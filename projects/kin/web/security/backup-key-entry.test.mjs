import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_KEY_ENTRY_KEY, backupKeyEntryName, dismissPasskeySuggestion, entryDeviceName, entryHint,
  legacyEntryName, passkeyOffer, passkeySuggestionDismissed, rememberedEntries, rememberEntry, unlockEntryName,
} from "./backup-key-entry.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values };
}

const brokenStorage = {
  getItem() { throw new DOMException("blocked", "SecurityError"); },
  setItem() { throw new DOMException("blocked", "SecurityError"); },
};

test("entry names carry the device and the key label", () => {
  assert.equal(backupKeyEntryName("K-7F3A", "Mikey's phone"), "Kin backup key — Mikey's phone (K-7F3A)");
  assert.equal(backupKeyEntryName("K-7F3A", "Chrome on Android"), "Kin backup key — Chrome on Android (K-7F3A)");
});

test("an unknown or anonymous device falls back to the label alone", () => {
  for (const name of [null, undefined, "", "   ", "This device", "Device"])
    assert.equal(backupKeyEntryName("K-7F3A", name), "Kin backup key (K-7F3A)");
  assert.equal(backupKeyEntryName(null, "Chrome on Android"), "Kin backup key — Chrome on Android");
  assert.equal(backupKeyEntryName(null, null), "Kin backup key");
});

test("device names are tidied and bounded", () => {
  assert.equal(entryDeviceName("  Mikey's\n\tphone  "), "Mikey's phone");
  const long = entryDeviceName("😀".repeat(80));
  assert.equal([...long].length, 48);
  assert.ok(long.endsWith("…"));
});

test("unlock asks for the remembered entry for the current label, else the older name", () => {
  const remembered = [{ label: "K-7F3A", name: "Kin backup key — Chrome on Android (K-7F3A)" }];
  assert.equal(unlockEntryName("K-7F3A", remembered), remembered[0].name);
  // A key saved before #579, or with storage cleared: the older entry name.
  assert.equal(unlockEntryName("K-11B0", remembered), "Kin recovery key K-11B0");
  assert.equal(unlockEntryName("K-7F3A", []), "Kin recovery key K-7F3A");
  assert.equal(unlockEntryName("K-7F3A"), "Kin recovery key K-7F3A");
  assert.equal(unlockEntryName(null, remembered), "Kin recovery key");
  assert.equal(legacyEntryName("K-7F3A"), "Kin recovery key K-7F3A");
});

test("an unfinished replacement doesn't lose the current key's entry", () => {
  const storage = memoryStorage();
  rememberEntry("K-7F3A", "Kin backup key — Chrome on Android (K-7F3A)", storage);
  // Replacement remembers its new entry when submitted, before it finishes.
  rememberEntry("K-11B0", "Kin backup key — Chrome on Android (K-11B0)", storage);
  const entries = rememberedEntries(storage);
  assert.equal(unlockEntryName("K-7F3A", entries), "Kin backup key — Chrome on Android (K-7F3A)");
  assert.equal(unlockEntryName("K-11B0", entries), "Kin backup key — Chrome on Android (K-11B0)");
  for (const label of ["K-0001", "K-0002", "K-0003"]) rememberEntry(label, `Kin backup key (${label})`, storage);
  assert.deepEqual(rememberedEntries(storage).map((entry) => entry.label), ["K-0003", "K-0002", "K-0001"], "only a few, newest first");
  rememberEntry("K-0001", "Kin backup key — Edge on Windows (K-0001)", storage);
  assert.deepEqual(rememberedEntries(storage).map((entry) => entry.label), ["K-0001", "K-0003", "K-0002"], "one entry per label");
});

test("the hint names the label both entry formats end with", () => {
  assert.equal(entryHint("K-7F3A"), "Use the saved entry ending K-7F3A.");
  assert.ok(backupKeyEntryName("K-7F3A", "Mikey's phone").endsWith("K-7F3A)"));
  assert.ok(legacyEntryName("K-7F3A").endsWith("K-7F3A"));
  assert.equal(entryHint(null), "");
});

test("the remembered entry round-trips and tolerates missing or broken storage", () => {
  const storage = memoryStorage();
  assert.deepEqual(rememberedEntries(storage), []);
  rememberEntry("K-7F3A", "Kin backup key — Chrome on Android (K-7F3A)", storage);
  assert.deepEqual(rememberedEntries(storage), [{ label: "K-7F3A", name: "Kin backup key — Chrome on Android (K-7F3A)" }]);
  assert.ok(!storage.values.get(BACKUP_KEY_ENTRY_KEY).match(/[a-f0-9]{64}/), "only a name is stored");
  rememberEntry(null, "x", storage);
  assert.equal(rememberedEntries(storage).length, 1, "no label, nothing remembered");
  storage.setItem(BACKUP_KEY_ENTRY_KEY, "{not json");
  assert.deepEqual(rememberedEntries(storage), []);
  storage.setItem(BACKUP_KEY_ENTRY_KEY, JSON.stringify([{ label: "K-7F3A", name: 5 }, { label: "K-11B0", name: "ok" }, "junk"]));
  assert.deepEqual(rememberedEntries(storage), [{ label: "K-11B0", name: "ok" }]);
  storage.setItem(BACKUP_KEY_ENTRY_KEY, JSON.stringify({ label: "K-7F3A", name: "not a list" }));
  assert.deepEqual(rememberedEntries(storage), []);
  assert.deepEqual(rememberedEntries(brokenStorage), []);
  assert.deepEqual(rememberedEntries(null), []);
  assert.doesNotThrow(() => rememberEntry("K-7F3A", "name", brokenStorage));
});

test("the passkey suggestion dismissal is remembered per device", () => {
  const storage = memoryStorage();
  assert.equal(passkeySuggestionDismissed(storage), false);
  dismissPasskeySuggestion(storage);
  assert.equal(passkeySuggestionDismissed(storage), true);
  assert.equal(passkeySuggestionDismissed(brokenStorage), false);
  assert.doesNotThrow(() => dismissPasskeySuggestion(brokenStorage));
});

test("passkey offers: after setup, after a backup-key unlock, and never where they can't work", () => {
  const base = { identity: true, passkeys: 0, supported: true, online: true, justSetUp: false, sessionDismissed: false, suggestionDismissed: false };
  assert.equal(passkeyOffer({ ...base, justSetUp: true }), "setup");
  assert.equal(passkeyOffer({ ...base, justSetUp: true, suggestionDismissed: true }), "setup", "the setup step is its own question");
  assert.equal(passkeyOffer(base), "suggestion");
  assert.equal(passkeyOffer({ ...base, suggestionDismissed: true }), null, "a dismissed suggestion stays dismissed");
  assert.equal(passkeyOffer({ ...base, sessionDismissed: true, justSetUp: true }), null, "Not now goes on");
  assert.equal(passkeyOffer({ ...base, passkeys: 1, justSetUp: true }), null, "already on");
  assert.equal(passkeyOffer({ ...base, supported: false, justSetUp: true }), null, "unsupported");
  assert.equal(passkeyOffer({ ...base, online: false, justSetUp: true }), null, "offline");
  assert.equal(passkeyOffer({ ...base, identity: false, justSetUp: true }), null, "no household identity to enrol against");
});
