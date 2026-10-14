import test from "node:test";
import assert from "node:assert/strict";
import { decryptHouseholdSettings, encryptHouseholdSettings, normalizeHouseholdName, resolveAppearance, useHouseholdAppearance } from "./household.js";

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

test("shared settings encryption binds household, epoch, and revision", async () => {
  const householdKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const value = { version: 1, revision: 0, name: "Our Home", appearance: { version: 1, owner: "household", mode: "dark", colorSource: "preset", seed: "#397052", manual: { source: "preset", name: "Forest", seed: "#397052" }, image: null } };
  const encrypted = await encryptHouseholdSettings(value, { householdId: "a".repeat(32), keyEpoch: 1, householdKey });
  const record = { revision: 1, keyEpoch: 1, ciphertext: Buffer.from(encrypted.ciphertext).toString("base64url"), digest: encrypted.digest };
  assert.equal((await decryptHouseholdSettings(record, { householdId: "a".repeat(32), householdKey })).name, "Our Home");
  await assert.rejects(() => decryptHouseholdSettings(record, { householdId: "b".repeat(32), householdKey }));
});
