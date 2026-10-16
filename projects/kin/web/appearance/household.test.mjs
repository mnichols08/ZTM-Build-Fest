import test from "node:test";
import assert from "node:assert/strict";
import { decryptHouseholdSettings, encryptHouseholdSettings, normalizeHouseholdName, personalAppearanceFromDraft, resolveAppearance, useHouseholdAppearance } from "./household.js";

const shared = { appearance: { mode: "dark", colorSource: "preset", seed: "#397052", manual: { source: "preset", name: "Forest", seed: "#397052" }, image: { bytes: new Uint8Array([1]), type: "image/webp" } } };

test("household names are normalized and reject unsafe input", () => {
  assert.equal(normalizeHouseholdName("  Cafe\u0301 Home  "), "Café Home");
  assert.throws(() => normalizeHouseholdName(" \n "));
  assert.throws(() => normalizeHouseholdName(`Home\u202e`));
  assert.throws(() => normalizeHouseholdName("x".repeat(81)));
});

test("appearance inheritance resolves each property independently", () => {
  const resolved = resolveAppearance({ owner: "member", mode: "light", colorSource: undefined, image: null }, shared);
  assert.equal(resolved.mode, "light");
  assert.equal(resolved.seed, "#397052");
  assert.equal(resolved.image, null);
});

test("use household appearance clears every personal override", () => {
  const personal = useHouseholdAppearance("member");
  assert.equal(resolveAppearance(personal, shared).mode, "dark");
  assert.equal(resolveAppearance(personal, shared).image.type, "image/webp");
});

test("changing personal color keeps an inherited household background", () => {
  const personal = useHouseholdAppearance("member");
  const baseline = resolveAppearance(personal, shared);
  const draft = {
    ...baseline,
    colorSource: "preset",
    seed: "#345C8C",
    manual: { source: "preset", name: "Ocean", seed: "#345C8C" },
  };
  const saved = personalAppearanceFromDraft(personal, draft, baseline);
  assert.equal(saved.colorSource, "preset");
  assert.equal(saved.seed, "#345C8C");
  assert.equal(saved.image, undefined);
  assert.equal(resolveAppearance(saved, shared).image.type, "image/webp");

  const removed = personalAppearanceFromDraft(saved, { ...draft, image: null }, draft);
  assert.equal(removed.image, null);
  assert.equal(resolveAppearance(removed, shared).image, null);
});

test("resetting to Kin defaults stores explicit values instead of inheritance", () => {
  const personal = useHouseholdAppearance("member");
  const baseline = {
    version: 1, owner: "member", mode: "system", colorSource: "default",
    seed: "#984D38", manual: null, image: null,
  };
  const saved = personalAppearanceFromDraft(personal, baseline, baseline, { forceExplicit: true });
  assert.deepEqual(saved, { ...baseline, version: 2 });

  const changedHousehold = {
    appearance: {
      version: 1, owner: "household", mode: "dark", colorSource: "preset",
      seed: "#397052", manual: { source: "preset", name: "Forest", seed: "#397052" },
      image: { seed: "#684033", type: "image/webp", width: 1, height: 1, bytes: new Uint8Array([1]) },
    },
  };
  assert.deepEqual(resolveAppearance(saved, changedHousehold), baseline);
});

test("shared settings encryption binds household, epoch, and revision", async () => {
  const householdKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const value = { version: 1, revision: 0, name: "Our Home", appearance: { version: 1, owner: "household", mode: "dark", colorSource: "preset", seed: "#397052", manual: { source: "preset", name: "Forest", seed: "#397052" }, image: null } };
  const encrypted = await encryptHouseholdSettings(value, { householdId: "a".repeat(32), keyEpoch: 1, householdKey });
  const record = { revision: 1, keyEpoch: 1, ciphertext: Buffer.from(encrypted.ciphertext).toString("base64url"), digest: encrypted.digest };
  assert.equal((await decryptHouseholdSettings(record, { householdId: "a".repeat(32), householdKey })).name, "Our Home");
  await assert.rejects(() => decryptHouseholdSettings(record, { householdId: "b".repeat(32), householdKey }));
});
