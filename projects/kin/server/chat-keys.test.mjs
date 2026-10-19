// The dedicated chat key (#123): a household's chat content is sealed under a
// key only devices of members allowed to read are given. The service tracks
// who holds a wrapped copy and who may, makes an adult's device rotate it when
// someone loses access, and never sees a key.
import assert from "node:assert/strict";
import test from "node:test";
import { ChatBlobService } from "./chat-blob-service.mjs";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const hex = (byte, length = 16) => byte.toString(16).padStart(2, "0").repeat(length);
const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

function envelope(who, sequence) {
  return {
    protocolVersion: 1, envelopeVersion: 1, eventId: hex(sequence + 10), householdId: who.householdId, deviceId: who.deviceId,
    deviceSequence: sequence, logicalTime: String(sequence), keyEpoch: 1, nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(40, sequence).toString("base64url"), signature: Buffer.alloc(64, 2).toString("base64url"),
  };
}

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  sync.liveService = { eventsAccepted() {}, revalidate() {} };
  const relay = new ChatRelayService({ syncService: sync, store });
  sync.chatRelayService = relay;
  new ChatBlobService({ pairingService: pairing, store });
  const admin = pairing.bootstrap({ credential: credential(`founder-${Math.random()}`) });
  const admit = (options) => {
    const invitation = pairing.createPairing(admin.sessionToken, options);
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`m-${Math.random()}`), deviceLabel: "Phone" });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const child = admit({ kind: "limited" });
  const guest = admit({ kind: "temporary", expiresAt: Date.now() + 86_400_000 });
  const adult = admit({ kind: "adult" });
  sync.enable(admin.sessionToken);
  let counter = 0;
  for (const who of [admin, child, guest, adult]) pairing.devices.get(who.deviceId).syncKeyFingerprint = hex(++counter + 100, 32);
  const auth = (who) => sync.authorize(who.sessionToken);
  const setPolicy = (limited, temporary) => pairing.setChatPolicy(admin.sessionToken, { limited, temporary }, admin.memberId);
  const fingerprint = (who) => pairing.devices.get(who.deviceId).syncKeyFingerprint;
  // A key package as the service sees it: routing fields it checks, opaque rest.
  const pack = (sender, recipient, keyEpoch) => ({
    version: 1, grantId: hex(keyEpoch * 16 + Math.floor(Math.random() * 15) + 1), householdId: `chat:${admin.householdId}`,
    senderDeviceId: sender.deviceId, recipientDeviceId: recipient.deviceId, recipientFingerprint: fingerprint(recipient), keyEpoch,
    expiresAt: Date.now() + 600_000, ephemeralPublicKey: { kty: "EC" }, salt: "s", nonce: "n", wrappedKey: "w", signature: "g",
  });
  const rotation = (sender, recipients, epoch) => ({
    expectedEpoch: epoch - 1, epoch,
    packages: recipients.map((to) => ({ deviceId: to.deviceId, keyEpoch: epoch, package: pack(sender, to, epoch) })),
  });
  return { pairing, sync, relay, admin, child, guest, adult, auth, setPolicy, pack, rotation, fingerprint };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store), store); } finally { store.close(); }
  });
}

bothStores("a household nobody is shut out of never needs a chat key", (h) => {
  for (const who of [h.admin, h.child, h.guest, h.adult])
    assert.deepEqual(h.sync.status(who.sessionToken).chat.key, { epoch: 0, pending: false, action: null, held: 0 });
  h.relay.push(h.auth(h.child), [envelope(h.child, 1)]);
});

bothStores("shutting a class out asks an adult's device for a chat key, and pauses sending until it exists", (h) => {
  h.setPolicy("none", "write");
  assert.deepEqual(h.sync.status(h.admin.sessionToken).chat.key, { epoch: 0, pending: true, action: "rotate", held: 0 });
  assert.deepEqual(h.sync.status(h.adult.sessionToken).chat.key, { epoch: 0, pending: true, action: "rotate", held: 0 });
  assert.deepEqual(h.sync.status(h.guest.sessionToken).chat.key, { epoch: 0, pending: true, action: null, held: 0 }, "a Temporary member can't rotate");
  assert.equal(h.sync.status(h.child.sessionToken).chat.key.action, null);
  assert.throws(() => h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)]), rejects("chat_key_rotation_pending", 409));
  const plan = h.relay.keys(h.auth(h.admin)).plan;
  assert.equal(plan.action, "rotate");
  assert.deepEqual(plan.recipients.map((entry) => entry.deviceId).sort(), [h.admin, h.guest, h.adult].map((who) => who.deviceId).sort(), "only devices that may read");
  assert.throws(() => h.relay.keys(h.auth(h.child)), rejects("chat_unavailable", 403));
});

bothStores("a rotation must reach exactly the devices that may read", (h) => {
  h.setPolicy("none", "write");
  const admin = h.auth(h.admin);
  const readers = [h.admin, h.guest, h.adult];
  assert.throws(() => h.relay.putKeys(admin, h.rotation(h.admin, [h.admin, h.adult], 1)), rejects("chat_keys_invalid", 400), "a reader left out");
  assert.throws(() => h.relay.putKeys(admin, h.rotation(h.admin, [...readers, h.child], 1)), rejects("chat_keys_invalid", 400), "someone shut out included");
  assert.throws(() => h.relay.putKeys(admin, { ...h.rotation(h.admin, readers, 2), expectedEpoch: 1 }), rejects("chat_keys_stale", 409), "wrong epoch");
  assert.throws(() => h.relay.putKeys(h.auth(h.guest), h.rotation(h.guest, readers, 1)), rejects("chat_keys_stale", 409), "only an adult's device");
  const forged = h.rotation(h.admin, readers, 1);
  forged.packages[0].package.senderDeviceId = h.adult.deviceId;
  assert.throws(() => h.relay.putKeys(admin, forged), rejects("chat_keys_invalid", 400), "a package must name its real sender");
  const wrongFamily = h.rotation(h.admin, readers, 1);
  wrongFamily.packages[0].package.householdId = h.admin.householdId;
  assert.throws(() => h.relay.putKeys(admin, wrongFamily), rejects("chat_keys_invalid", 400), "a household-key package isn't a chat key");
  const result = h.relay.putKeys(admin, h.rotation(h.admin, readers, 1));
  assert.equal(result.epoch, 1);
  assert.equal(result.pending, false);
  assert.equal(h.relay.keys(h.auth(h.guest)).packages.length, 1);
  assert.equal(h.relay.keys(h.auth(h.guest)).packages[0].keyEpoch, 1);
  assert.throws(() => h.relay.putKeys(admin, h.rotation(h.admin, readers, 2)), rejects("chat_keys_stale", 409), "no rotation when none is needed");
  h.relay.push(h.auth(h.adult), [envelope(h.adult, 1)]);
  assert.throws(() => h.relay.keys(h.auth(h.child)), rejects("chat_unavailable", 403), "the shut-out device is given nothing");
  assert.equal(h.pairing.events.some((event) => event.type === "chat_key_rotated" && event.epoch === 1), true);
});

bothStores("two devices rotating at once: the first wins", (h) => {
  h.setPolicy("none", "write");
  const readers = [h.admin, h.guest, h.adult];
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, readers, 1));
  assert.throws(() => h.relay.putKeys(h.auth(h.adult), h.rotation(h.adult, readers, 1)), rejects("chat_keys_stale", 409));
});

bothStores("giving access back asks a holder to share the key; other members can't", (h) => {
  h.setPolicy("none", "write");
  const readers = [h.admin, h.guest, h.adult];
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, readers, 1));
  h.setPolicy("read", "write");
  assert.deepEqual(h.sync.status(h.admin.sessionToken).chat.key, { epoch: 1, pending: false, action: "grant", held: 1 });
  assert.equal(h.sync.status(h.child.sessionToken).chat.key.action, null, "the member waiting for it can't grant");
  const plan = h.relay.keys(h.auth(h.admin)).plan;
  assert.deepEqual(plan.recipients.map((entry) => [entry.deviceId, entry.keyEpochs]), [[h.child.deviceId, [1]]]);
  const grant = (sender, recipient, keyEpoch) => ({ expectedEpoch: 1, epoch: 1, packages: [{ deviceId: recipient.deviceId, keyEpoch, package: h.pack(sender, recipient, keyEpoch) }] });
  assert.throws(() => h.relay.putKeys(h.auth(h.child), grant(h.child, h.child, 1)), rejects("chat_keys_invalid", 400), "a device can't grant itself");
  assert.throws(() => h.relay.putKeys(h.auth(h.admin), grant(h.admin, h.guest, 1)), rejects("chat_keys_invalid", 400), "someone who already holds it");
  assert.throws(() => h.relay.putKeys(h.auth(h.admin), grant(h.admin, h.child, 2)), rejects("chat_keys_invalid", 400), "an epoch that doesn't exist");
  h.relay.putKeys(h.auth(h.admin), grant(h.admin, h.child, 1));
  assert.equal(h.relay.keys(h.auth(h.child)).packages[0].senderDeviceId, h.admin.deviceId);
  assert.deepEqual(h.sync.status(h.admin.sessionToken).chat.key, { epoch: 1, pending: false, action: null, held: 1 });
});

bothStores("a revoked device that held the key means rotating it", (h) => {
  h.setPolicy("none", "write");
  h.relay.putKeys(h.auth(h.admin), h.rotation(h.admin, [h.admin, h.guest, h.adult], 1));
  h.pairing.devices.get(h.guest.deviceId).revokedAt = Date.now();
  assert.deepEqual(h.sync.status(h.admin.sessionToken).chat.key, { epoch: 1, pending: true, action: "rotate", held: 1 });
  assert.throws(() => h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)]), rejects("chat_key_rotation_pending", 409));
  h.relay.putKeys(h.auth(h.adult), h.rotation(h.adult, [h.admin, h.adult], 2));
  assert.equal(h.sync.status(h.admin.sessionToken).chat.key.epoch, 2);
  h.relay.push(h.auth(h.admin), [envelope(h.admin, 1)]);
});
