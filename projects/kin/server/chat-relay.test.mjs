// The chat relay (#111): chat events in their own encrypted stream, apart
// from the household relay, with the same envelope rules. Each service test
// runs against the in-memory and the durable store.
import assert from "node:assert/strict";
import test from "node:test";
import { ChatRelayService } from "./chat-relay-service.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../web/sync/envelope-wire.js";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const hex = (byte, length = 16) => byte.toString(16).padStart(2, "0").repeat(length);

/** An envelope as the service sees it: valid in shape, opaque inside. */
function envelope(who, { eventId, deviceSequence, logicalTime = deviceSequence, keyEpoch = 1 }) {
  return {
    protocolVersion: 1,
    envelopeVersion: 1,
    eventId,
    householdId: who.householdId,
    deviceId: who.deviceId,
    deviceSequence,
    logicalTime: String(logicalTime),
    keyEpoch,
    nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(40, deviceSequence).toString("base64url"),
    signature: Buffer.alloc(64, 2).toString("base64url"),
  };
}

function household(store = null) {
  const pairing = new PairingService({ store });
  const sync = new EncryptedSyncService(pairing, { store });
  const hints = [];
  sync.liveService = { eventsAccepted: (householdId, deviceId) => hints.push(deviceId), revalidate() {} };
  const relay = new ChatRelayService({ syncService: sync, store });
  const adult = pairing.bootstrap({ credential: credential(`adult-${Math.random()}`) });
  const invitation = pairing.createDevicePairing(adult.sessionToken);
  const claim = pairing.claimPairing({ code: invitation.code, credential: credential(`laptop-${Math.random()}`), deviceLabel: "Laptop" });
  pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
  const laptop = pairing.activateClaim(claim.claimToken);
  sync.enable(adult.sessionToken);
  const auth = (who) => sync.authorize(who.sessionToken);
  return { pairing, sync, relay, adult, laptop, auth, hints };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

bothStores("chat events are pushed, ordered and pulled in their own stream", (h) => {
  const first = envelope(h.adult, { eventId: hex(1), deviceSequence: 1 });
  const second = envelope(h.adult, { eventId: hex(2), deviceSequence: 2 });
  const result = h.relay.push(h.auth(h.adult), [first, second]);
  assert.equal(result.accepted, 2);
  assert.deepEqual(h.hints, [h.adult.deviceId], "the household's other devices hear about it");
  const reply = envelope(h.laptop, { eventId: hex(3), deviceSequence: 1, logicalTime: 3 });
  h.relay.push(h.auth(h.laptop), [reply]);
  const page = h.relay.pull(h.auth(h.laptop), "", "2");
  assert.deepEqual(page.events.map((row) => row.envelope.eventId), [hex(1), hex(2)]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(h.relay.status(h.auth(h.adult)).deviceSequence, 2, "a device can pick up its chat sequence");
  assert.deepEqual(h.relay.status(h.auth(h.laptop)).deviceSequence, 1);
  const rest = h.relay.pull(h.auth(h.laptop), page.nextCursor, "20");
  assert.deepEqual(rest.events.map((row) => row.envelope.eventId), [hex(3)]);
  assert.equal(rest.hasMore, false);
  // The household relay never sees chat.
  assert.deepEqual(h.sync.pull(h.adult.sessionToken, "", "20").events, []);
});

bothStores("the envelope rules hold: sequences, duplicates, devices, epochs, cursors", (h) => {
  const auth = h.auth(h.adult);
  h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]);
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(2), deviceSequence: 3 })]), rejects("sync_sequence_gap", 409));
  // The same event again is fine; the same ID with other bytes is not.
  assert.equal(h.relay.push(auth, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]).accepted, 1);
  const altered = envelope(h.adult, { eventId: hex(1), deviceSequence: 2 });
  assert.throws(() => h.relay.push(auth, [altered]), rejects("event_duplicate_conflict", 409));
  // Another device's envelope, a key epoch nobody holds, an empty batch.
  assert.throws(() => h.relay.push(auth, [envelope(h.laptop, { eventId: hex(4), deviceSequence: 1 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(5), deviceSequence: 2, keyEpoch: 2 })]), rejects("event_envelope_invalid", 400));
  assert.throws(() => h.relay.push(auth, []), rejects("sync_batch_invalid", 400));
  assert.throws(() => h.relay.push(auth, [envelope(h.adult, { eventId: hex(6), deviceSequence: 2, logicalTime: 10 ** 15 })]), rejects("logical_time_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "AAAAAAAAAAk", "20"), rejects("sync_cursor_invalid", 400));
  assert.throws(() => h.relay.pull(auth, "", "21"), rejects("sync_cursor_invalid", 400));
});

bothStores("chat waits out a key rotation and needs household sync set up", (h) => {
  h.sync.state(h.adult.householdId).rotationPending = true;
  assert.throws(() => h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("sync_rotation_pending", 409));
  h.sync.state(h.adult.householdId).rotationPending = false;
  h.sync.state(h.adult.householdId).enabled = false;
  assert.throws(() => h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("chat_sync_unavailable", 409));
});

bothStores("members who can't take part can't use the chat relay", (h) => {
  const auth = h.auth(h.adult);
  const removed = { ...auth, member: { ...auth.member, active: false } };
  assert.throws(() => h.relay.push(removed, [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]), rejects("chat_unavailable", 403));
  assert.throws(() => h.relay.pull(removed, "", "20"), rejects("chat_unavailable", 403));
});

test("the chat relay persists and household deletion purges it", () => {
  const store = new DurableStore(":memory:");
  try {
    const h = household(store);
    h.relay.push(h.auth(h.adult), [envelope(h.adult, { eventId: hex(1), deviceSequence: 1 })]);
    const reopened = new ChatRelayService({ syncService: h.sync, store });
    assert.equal(reopened.pull(h.auth(h.laptop), "", "20").events.length, 1);
    assert.deepEqual(store.chatRelayState(h.adult.householdId), { nextSequence: 2, eventCount: 1, maxLogicalTime: "1" });
    assert.ok(store.householdPurgeStatus(h.adult.householdId).counts.chatEvents > 0);
    store.forcePurgeHousehold(h.adult.householdId, Date.now());
    assert.equal(store.householdPurgeStatus(h.adult.householdId).counts.chatEvents, 0);
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("the chat event routes move binary batches and pages", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${url}/api/chat/events`)).status, 401);
  const adult = app.service.bootstrap({ credential: credential("adult") });
  app.syncService.enable(adult.sessionToken);
  const cookie = `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`;
  const push = await fetch(`${url}/api/chat/events`, {
    method: "POST", headers: { cookie, "content-type": ENVELOPE_CONTENT_TYPE },
    body: encodeEnvelopeBatch([envelope(adult, { eventId: hex(7), deviceSequence: 1 })]),
  });
  assert.equal(push.status, 200);
  assert.equal((await push.json()).accepted, 1);
  const pull = await fetch(`${url}/api/chat/events?cursor=&limit=20`, { headers: { cookie } });
  assert.equal(pull.status, 200);
  const page = decodeEventPage(new Uint8Array(await pull.arrayBuffer()));
  assert.deepEqual(page.events.map((row) => row.envelope.eventId), [hex(7)]);
  const household = await fetch(`${url}/api/sync/events?cursor=&limit=20`, { headers: { cookie } });
  assert.equal(decodeEventPage(new Uint8Array(await household.arrayBuffer())).events.length, 0);
});
