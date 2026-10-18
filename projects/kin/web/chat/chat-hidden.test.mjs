// "Delete for me" records (#119): sealed to the member's own devices,
// signed by one of them, bound to household, member and revision.
import assert from "node:assert/strict";
import test from "node:test";
import { exportDevicePublicKeys, generateDeviceKeys } from "../sync/crypto.js";
import { openHiddenRecord, sealHiddenRecord } from "./chat-hidden.js";

const HOUSEHOLD = "aa".repeat(16), ME = "bb".repeat(16), OTHER = "cc".repeat(16);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);

async function device(deviceId, memberId) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  return { keys, entry: { deviceId, memberId, publicKeys, fingerprint: `f${deviceId.slice(0, 4)}`, verifiedKeyHistory: [{ publicKeys }] } };
}

test("a record opens on each of the member's devices and nowhere else", async () => {
  const phone = await device(id(1), ME), laptop = await device(id(2), ME), theirs = await device(id(3), OTHER), later = await device(id(4), ME);
  const record = await sealHiddenRecord({
    ids: [id(9), id(8), id(9)], householdId: HOUSEHOLD, memberId: ME, revision: 3, senderDeviceId: id(1),
    signingKey: phone.keys.signingPrivateKey, recipients: [phone.entry, laptop.entry],
  });
  assert.equal(JSON.stringify(record).includes(id(9)), false, "the IDs are sealed");
  const senders = [phone.entry, laptop.entry, later.entry];
  const open = (who, extra = {}) => openHiddenRecord({ record, householdId: HOUSEHOLD, memberId: ME, revision: 3, deviceId: who.entry.deviceId, agreementPrivateKey: who.keys.agreementPrivateKey, senders, ...extra });
  assert.deepEqual(await open(phone), [id(8), id(9)], "sorted, once each");
  assert.deepEqual(await open(laptop), [id(8), id(9)]);
  // A device added since can't open it until another device writes again.
  await assert.rejects(open(later), (error) => error.code === "chat_hidden_not_for_me");
  // Another member's device has nothing to open (and their key can't pose as a recipient).
  await assert.rejects(open({ ...theirs, entry: { ...theirs.entry, deviceId: id(2) } }), (error) => error.code === "chat_hidden_invalid");
  // Moved to another member, revision or household, or signed by a stranger: refused.
  await assert.rejects(open(phone, { revision: 4 }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(open(phone, { memberId: OTHER }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(open(phone, { householdId: id(7) }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(open(phone, { senders: [laptop.entry] }), (error) => error.code === "chat_hidden_invalid", "sender not a trusted device of the member");
  await assert.rejects(open(phone, { senders: [{ ...phone.entry, revokedAt: 1 }, laptop.entry] }), (error) => error.code === "chat_hidden_invalid", "revoked sender");
  await assert.rejects(open(phone, { senders: [{ ...phone.entry, memberId: OTHER }] }), (error) => error.code === "chat_hidden_invalid");
  // Tampering anywhere breaks the signature.
  for (const change of [
    { ciphertext: record.ciphertext.slice(0, -2) + (record.ciphertext.endsWith("AA") ? "BA" : "AA") },
    { recipients: [record.recipients[1], record.recipients[0]] },
    { recipients: [record.recipients[0]] },
  ])
    await assert.rejects(openHiddenRecord({ record: { ...record, ...change }, householdId: HOUSEHOLD, memberId: ME, revision: 3, deviceId: id(1), agreementPrivateKey: phone.keys.agreementPrivateKey, senders }), (error) => error.code === "chat_hidden_invalid");
});

test("a record must include its sender and stay within its bound", async () => {
  const phone = await device(id(1), ME), laptop = await device(id(2), ME);
  const seal = (extra) => sealHiddenRecord({ ids: [id(9)], householdId: HOUSEHOLD, memberId: ME, revision: 1, senderDeviceId: id(1), signingKey: phone.keys.signingPrivateKey, recipients: [phone.entry], ...extra });
  await assert.rejects(seal({ recipients: [laptop.entry] }), (error) => error.code === "chat_hidden_invalid");
  await assert.rejects(seal({ ids: ["not an id"] }), (error) => error.code === "chat_hidden_full");
  await assert.rejects(seal({ ids: Array.from({ length: 10_001 }, (_, index) => index.toString(16).padStart(32, "0")) }), (error) => error.code === "chat_hidden_full");
  assert.ok(await seal({}));
});
