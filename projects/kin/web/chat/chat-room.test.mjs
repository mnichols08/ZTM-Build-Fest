// The chat room's transport (#111): sending while offline, the chat relay
// stream against the real service, authentication of what arrives, sequence
// recovery, resealing, deletion of replaced blobs, and the coordinator's
// chat pass. A small JavaScript stand-in plays the engine so these run
// without the WASM build; kin-engine.test.mjs covers the real chat engine.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createKinServer } from "../../server/server.mjs";
import { exportDevicePublicKeys, generateDeviceKeys, generateHouseholdKey } from "../sync/crypto.js";
import { decodeEnvelopeBatch, encodeEventPage } from "../sync/envelope-wire.js";
import { SyncCoordinator } from "../sync/sync-coordinator.js";
import { ChatBlobClient } from "./chat-blob-client.js";
import { ChatBlobStore } from "./chat-blob-store.js";
import { ChatBlobs } from "./chat-blobs.js";
import { ChatLogStore, chatLogDatabaseName } from "./chat-log-store.js";
import { ChatRecords } from "./chat-records.js";
import { chatAdmins, chatTextProblem, ChatRoom, MAX_CHAT_PULL } from "./chat-room.js";
import { fakeIndexedDB, fakeKeyRange } from "./fake-indexeddb.test-support.mjs";
import { memberLabels } from "../components/household/member-labels.js";
import { loadKinEngine } from "../wasm/kin-engine.js";

const WASM = new URL("../wasm/kin_engine.wasm", import.meta.url);

const encoder = new TextEncoder(), decoder = new TextDecoder();
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
const KINDS = { "post-chat-message": "CHAT_MESSAGE_POSTED", "edit-chat-message": "CHAT_MESSAGE_EDITED", "delete-chat-message": "CHAT_MESSAGE_DELETED" };

/** The engine calls the room makes, over JSON "canonical events". */
function fakeEngine() {
  const decode = (bytes) => JSON.parse(decoder.decode(bytes));
  const metadata = (bytes) => {
    const event = decode(bytes);
    return {
      kind: event.kind, eventId: bytesOf(event.eventId), householdId: bytesOf(event.householdId),
      actorId: bytesOf(event.actorId), deviceId: bytesOf(event.deviceId),
      timestamp: event.timestamp, logicalTime: BigInt(event.logicalTime),
    };
  };
  const events = (source) => Array.from({ length: source.length }, (_, index) => decode(source.record(index)))
    .sort((left, right) => Number(BigInt(left.logicalTime) - BigInt(right.logicalTime)) || (left.eventId < right.eventId ? -1 : 1));
  return {
    calls: { page: 0, execute: 0 },
    texts: new Map(),
    putChatTexts(entries) {
      return entries.map(({ blobRef, text }) => {
        const ok = text.length > 0 && !/[\u0000-\u0008]/.test(text);
        if (ok) this.texts.set(blobRef, text);
        return ok;
      });
    },
    eventMetadata: metadata,
    eventMetadataBatch: (records) => records.map(metadata),
    executeChatCommand(command, identity, source) {
      this.calls.execute += 1;
      assert.equal(typeof source.copyRecordsTo, "function", "the chat log goes to the engine as a view");
      const event = { ...identity, logicalTime: String(identity.logicalTime), kind: KINDS[command.type], command };
      const encodedEvent = encoder.encode(JSON.stringify(event));
      return { encodedEvent, metadata: metadata(encodedEvent) };
    },
    chatPage(source, options) {
      this.calls.page += 1;
      const messages = new Map(), retired = [];
      for (const { command, actorId, deviceId, timestamp } of events(source)) {
        const message = messages.get(command.messageId);
        if (command.type === "post-chat-message" && !message)
          messages.set(command.messageId, { messageId: command.messageId, authorId: actorId, deviceId, postedAt: timestamp, status: "live", contentKind: command.contentKind ?? "text", blobRef: command.blobRef, blobKey: bytesOf(command.blobKey) });
        else if (message && message.status !== "deleted" && (actorId === message.authorId || (command.byAdmin && options.admins.includes(actorId)))) {
          retired.push(message.blobRef);
          if (command.type === "edit-chat-message") Object.assign(message, { status: "edited", blobRef: command.blobRef, blobKey: bytesOf(command.blobKey) });
          else Object.assign(message, { status: command.byAdmin ? "removed-by-admin" : "deleted", blobRef: null, blobKey: null });
        }
      }
      const list = [...messages.values()].map((message, index) => ({
        ...message, index,
        text: options.includeText === false ? null : this.texts.get(message.blobRef) ?? null,
      }));
      const shown = new Set(list.map((message) => message.blobRef));
      return { total: list.length, start: 0, messages: list, retired: options.includeRetired ? retired.filter((ref) => !shown.has(ref)) : [] };
    },
  };
}

async function service(t) {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = app.service.bootstrap({ credential: { id: "admin", publicKey: "key-admin", algorithm: -7 } });
  const invitation = app.service.createPairing(admin.sessionToken);
  const claim = app.service.claimPairing({ code: invitation.code, credential: { id: "partner", publicKey: "key-partner", algorithm: -7 }, deviceLabel: "Phone" });
  app.service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const partner = app.service.activateClaim(claim.claimToken);
  app.syncService.enable(admin.sessionToken);
  // Another device of a member (same-member pairing).
  let devices = 0;
  const pairDevice = (who) => {
    const invite = app.service.createDevicePairing(who.sessionToken);
    const deviceClaim = app.service.claimPairing({ code: invite.code, credential: { id: `extra-${(devices += 1)}`, publicKey: `key-extra-${devices}`, algorithm: -7 }, deviceLabel: "Tablet" });
    app.service.approvePairing(who.sessionToken, invite.pairingId, deviceClaim.version);
    return app.service.activateClaim(deviceClaim.claimToken);
  };
  return { app, base, admin, partner, pairDevice, householdId: admin.householdId };
}

/** The coordinator's request() for one device: JSON, or bytes for pages. */
function requester(base, who) {
  const cookie = `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}`;
  const call = async (path, { binary = false, ...options } = {}) => {
    if (call.offline) {
      const error = new Error("Household sync could not be reached.");
      error.code = "connection_unavailable";
      throw error;
    }
    call.paths.push(`${options.method ?? "GET"} ${path.split("?")[0]}`);
    const response = await fetch(base + path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}), cookie } });
    if (binary && response.ok) return new Uint8Array(await response.arrayBuffer());
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(value.message);
      error.code = value.error;
      throw error;
    }
    return value;
  };
  call.paths = [];
  call.offline = false;
  call.fetch = (path, init) => {
    call.paths.push(`${init.method} ${path}`);
    return fetch(base + path, { ...init, headers: { ...init.headers, cookie } });
  };
  return call;
}

/** One device: its keys, its directory entry, its chat storage. */
async function device(who, { householdId, epochs, memberKind = "adult", householdAdmin = false }) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  return {
    who,
    deviceKeys: { keys },
    entry: { deviceId: who.deviceId, memberId: who.memberId, publicKeys, verifiedKeyHistory: [{ publicKeys }], historyFromEpoch: 1, memberKind, memberActive: true, householdAdmin },
    keyStore: {
      vault: { assertUnlocked() {} },
      getEpoch: async (household, keyEpoch) => (household === householdId && epochs.has(keyEpoch) ? { keyEpoch, householdKey: epochs.get(keyEpoch) } : null),
      listEpochs: async () => [...epochs].map(([keyEpoch, householdKey]) => ({ keyEpoch, householdKey })),
    },
    indexedDB: fakeIndexedDB(),
  };
}

async function openRoom(phone, { base, householdId, engine = fakeEngine(), request = requester(base, phone.who), indexedDB = phone.indexedDB, locks, preparePhoto } = {}) {
  const blobs = new ChatBlobs({ store: await ChatBlobStore.open(householdId, { indexedDB }), client: new ChatBlobClient({ fetch: request.fetch }) });
  const room = await ChatRoom.open({
    identity: { householdId, memberId: phone.who.memberId, deviceId: phone.who.deviceId },
    keyStore: phone.keyStore, deviceKeys: phone.deviceKeys, engine, request, blobs,
    indexedDB, keyRange: fakeKeyRange, locks, ...(preparePhoto ? { preparePhoto } : {}),
  });
  return { room, request, blobs, engine };
}

const STATUS = { currentEpoch: 1, rotationPending: false };
const texts = async ({ room, blobs }) => Promise.all(room.page().messages.map(async (message) =>
  message.blobRef ? (await blobs.openText({ ref: message.blobRef, key: message.blobKey })).text ?? null : message.status));

test("a message written offline waits, then reaches the other device through the chat relay", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  const changes = [];
  a.room.subscribe(() => changes.push(a.room.pending.size));

  a.request.offline = true;
  const first = await a.room.send("Dinner at 6 🍝");
  const second = await a.room.send("Bring bread");
  assert.ok(a.room.isPending(first.eventId) && a.room.isPending(second.eventId), "shown as waiting to send");
  assert.ok(a.room.pendingMessages.has(first.messageId) && a.room.pendingMessages.has(second.messageId), "by message, for the view");
  assert.deepEqual(await texts(a), ["Dinner at 6 🍝", "Bring bread"], "the sender sees them at once");
  assert.ok(changes.length >= 2);
  await assert.rejects(a.room.sync({ status: STATUS, devices }), (error) => error.code === "connection_unavailable");
  assert.ok(a.room.isPending(first.eventId), "still waiting while offline");

  a.request.offline = false;
  assert.deepEqual(await a.room.sync({ status: STATUS, devices }), { hasMore: false });
  assert.equal(a.room.pending.size, 0, "sent");
  assert.equal(a.room.pendingMessages.size, 0);
  assert.ok(a.request.paths.includes("GET /api/chat/status"), "a new log asks the relay where it stands");
  assert.deepEqual(a.request.paths.filter((path) => path.startsWith("PUT /api/chat/blobs/")).length, 2, "content uploads before its event");

  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(await texts(b), ["Dinner at 6 🍝", "Bring bread"]);
  // The view opens texts through the room: fetched, checked, handed to the
  // engine, then paged with the text in place.
  const unopened = b.room.page().messages;
  assert.deepEqual(unopened.map((message) => message.text), [null, null]);
  const opened = await b.room.loadTexts(unopened);
  assert.deepEqual([...opened.values()].map((result) => result.text), ["Dinner at 6 🍝", "Bring bread"]);
  assert.deepEqual(b.room.page().messages.map((message) => message.text), ["Dinner at 6 🍝", "Bring bread"]);
  assert.equal(b.room.authorLabel(s.admin.memberId), "Adult 1", "named as People & devices names members");
  assert.equal(b.room.authorLabel(s.partner.memberId), "You");
  assert.equal(b.room.authorLabel("ee".repeat(16)), "Household member");
  assert.equal(a.room.authorLabel(s.partner.memberId), "Adult 2", "the founder sees the partner as Household access does");
  assert.equal(b.request.paths.filter((path) => path === "GET /api/chat/status").length, 1, "a new log settles its sequence once");
  assert.equal(b.room.records.length, 2);
  // Pulling again finds nothing new and stores nothing twice.
  await b.room.sync({ status: STATUS, devices });
  assert.equal(b.request.paths.filter((path) => path === "GET /api/chat/status").length, 1, "nothing to send, a settled log: no status call");
  await a.room.sync({ status: STATUS, devices });
  assert.equal(a.room.records.length, 2, "its own events coming back are not stored again");
  assert.equal(b.room.records.length, 2);

  // The household relay never carried any of it.
  assert.equal(s.app.syncService.pull(s.admin.sessionToken, "", "20").events.length, 0);

  // Reopened (after a lock), the log decrypts from storage alone.
  b.room.close();
  assert.equal(b.room.records.length, 0, "locking drops the decrypted log");
  const reopened = await openRoom(laptop, s);
  assert.deepEqual(await texts(reopened), ["Dinner at 6 🍝", "Bring bread"]);
  await assert.rejects(b.room.send("after lock"), (error) => error.code === "chat_locked");
});

test("only authenticated chat events are stored; one that can never pass is skipped, not a wall", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s);
  await a.room.send("hello");
  await a.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
  await a.room.send("again");
  await a.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });

  // A device this one doesn't know yet (paired after it read the directory)
  // pauses chat: nothing is stored or read past, and the next pass retries.
  const b = await openRoom(laptop, s);
  await assert.rejects(b.room.sync({ status: STATUS, devices: [laptop.entry] }), (error) => error.code === "chat_device_unknown");
  assert.equal(b.room.records.length, 0);
  assert.equal((await b.room.store.state()).cursor, "", "not read past");
  // So does a missing key epoch.
  const forgetful = await device(s.partner, { householdId: s.householdId, epochs: new Map() });
  const c = await openRoom(forgetful, s);
  await assert.rejects(c.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] }), (error) => error.code === "chat_key_missing");
  await b.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
  assert.equal(b.room.records.length, 2);

  // A signature that doesn't verify against the directory this pass read
  // (the device changed its key since) pauses chat; with a fresh directory
  // the event arrives.
  const stale = await openRoom({ ...laptop, indexedDB: fakeIndexedDB() }, s);
  const wrongKey = { ...phone.entry, verifiedKeyHistory: laptop.entry.verifiedKeyHistory };
  await assert.rejects(stale.room.sync({ status: STATUS, devices: [wrongKey, laptop.entry] }), (error) => error.code === "event_signature_invalid");
  assert.equal((await stale.room.store.state()).cursor, "", "not read past");
  await stale.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
  assert.equal(stale.room.records.length, 2);
  assert.deepEqual(stale.room.refused, []);

  // What no retry can fix is skipped and remembered: a device revoked before
  // this epoch, history from before the device's grant, an author who isn't
  // the signing device's member, and a signature that fails on two passes.
  let phoneEvents = 2;
  for (const [signer, code, passes] of [
    [{ ...phone.entry, revokedAt: 1 }, "chat_event_refused", 1],
    [{ ...phone.entry, historyFromEpoch: 2 }, "chat_event_refused", 1],
    [{ ...phone.entry, memberId: s.partner.memberId }, "chat_event_refused", 1],
    [wrongKey, "event_signature_invalid", 2],
  ]) {
    const fresh = await openRoom({ ...laptop, indexedDB: fakeIndexedDB() }, s);
    const seen = [];
    fresh.room.subscribe(() => seen.push(fresh.room.refused.length));
    if (passes === 2) {
      await assert.rejects(fresh.room.sync({ status: STATUS, devices: [signer, laptop.entry] }), (error) => error.code === code);
      assert.deepEqual(fresh.room.refused, [], "one failure isn't enough");
    }
    assert.deepEqual(await fresh.room.sync({ status: STATUS, devices: [signer, laptop.entry] }), { hasMore: false });
    assert.equal(fresh.room.records.length, 0, "nothing refused is kept");
    assert.deepEqual(fresh.room.refused.map((entry) => entry.code), new Array(phoneEvents).fill(code));
    assert.ok(seen.includes(phoneEvents), "the view hears about it");
    const state = await fresh.room.store.state();
    assert.notEqual(state.cursor, "", "read past, so chat goes on");
    assert.equal(state.refused.length, phoneEvents, "remembered across unlocks");
    // Later events from good devices still arrive.
    await a.room.send(`after ${code}`);
    phoneEvents += 1;
    await a.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
    await fresh.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
    assert.equal(fresh.room.records.length, 1);
  }
});

test("a device that lost its chat log continues its sequence; a lost acknowledgement isn't sent twice", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s);
  await a.room.send("one");
  await a.room.send("two");
  await a.room.sync({ status: STATUS, devices });

  // The same device with fresh storage writes before it ever syncs: its
  // provisional first sequence is renumbered after the relay's count.
  const fresh = await openRoom({ ...phone, indexedDB: fakeIndexedDB() }, s);
  fresh.request.offline = true;
  await fresh.room.send("three");
  assert.equal((await fresh.room.store.outbox())[0].deviceSequence, 1, "provisional");
  fresh.request.offline = false;
  await fresh.room.sync({ status: STATUS, devices });
  assert.equal(fresh.room.pending.size, 0);
  assert.deepEqual((await fresh.room.store.state()).deviceSequence, 3);
  // Written against an empty log, "three" has logical time 1, like "one",
  // so replay orders it among the earliest: Lamport order, as for household
  // events.
  assert.deepEqual((await texts(fresh)).sort(), ["one", "three", "two"]);

  // The relay accepts a push but the reply is lost: the next pass sees the
  // relay already has it and drops it from the outbox without resending.
  await fresh.room.send("four");
  const realRequest = fresh.room.request;
  fresh.room.request = async (path, options) => {
    const value = await realRequest(path, options);
    if (options?.method === "POST") {
      fresh.room.request = realRequest;
      throw Object.assign(new Error("lost"), { code: "connection_unavailable" });
    }
    return value;
  };
  await assert.rejects(fresh.room.sync({ status: STATUS, devices }));
  assert.equal(fresh.room.pending.size, 1);
  const posts = realRequest.paths.filter((path) => path === "POST /api/chat/events").length;
  await fresh.room.sync({ status: STATUS, devices });
  assert.equal(fresh.room.pending.size, 0);
  assert.equal(realRequest.paths.filter((path) => path === "POST /api/chat/events").length, posts, "not pushed again");

  const b = await openRoom(laptop, s);
  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual((await texts(b)).sort(), ["four", "one", "three", "two"]);
});

test("a long outbox goes out over several passes, two batches at a time", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s);
  a.request.offline = true;
  for (let index = 0; index < 41; index += 1) await a.room.send(`message ${index}`);
  a.request.offline = false;
  assert.deepEqual(await a.room.sync({ status: STATUS, devices: [phone.entry] }), { hasMore: true });
  assert.equal(a.room.pending.size, 1);
  assert.equal(a.request.paths.filter((path) => path === "POST /api/chat/events").length, 2);
  assert.ok(a.request.paths.length <= 50, "a pass stays well inside the request budget");
  assert.deepEqual(await a.room.sync({ status: STATUS, devices: [phone.entry] }), { hasMore: false });
  assert.equal(a.room.pending.size, 0);
});

test("editing and deleting delete the replaced content on the service and on every device", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, memberKind: "limited" });
  const devices = [phone.entry, laptop.entry];
  assert.deepEqual(chatAdmins(devices), [s.admin.memberId], "admins are the service's household admins");
  assert.deepEqual(chatAdmins([{ ...phone.entry, memberActive: false }]), []);
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await b.room.send("typo");
  await b.room.send("rude");
  await b.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  const [typo, rude] = a.room.page().messages;
  assert.deepEqual(await texts(a), ["typo", "rude"]);

  const [own] = b.room.page().messages;
  await b.room.edit(own, "fixed");
  await a.room.remove(rude, { byAdmin: true });
  await b.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(await texts(a), ["fixed", "removed-by-admin"]);
  assert.deepEqual(await texts(b), ["fixed", "removed-by-admin"]);
  // Gone from the service and from both devices' blob stores.
  for (const ref of [typo.blobRef, rude.blobRef]) {
    assert.deepEqual(await a.blobs.client.download(ref), { deleted: true });
    assert.equal(await a.blobs.store.get(ref), null);
    assert.equal(await b.blobs.store.get(ref), null);
    assert.equal(await b.blobs.store.isRetired(ref), true);
  }

  // The admins last known are kept, so a removal still shows offline and
  // after reopening, before any sync.
  b.room.close();
  const reopened = await openRoom(laptop, s);
  assert.deepEqual(reopened.room.admins, [s.admin.memberId]);
  assert.deepEqual(await texts(reopened), ["fixed", "removed-by-admin"]);
  assert.equal(reopened.room.retiredThrough, reopened.room.records.length, "replaced blobs aren't deleted again after reopening");
  // A change of admins looks at the retired list again, with no new event.
  const pages = reopened.engine.calls.page;
  await reopened.room.sync({ status: STATUS, devices: [{ ...phone.entry, householdAdmin: false }, laptop.entry] });
  assert.deepEqual(reopened.room.admins, []);
  assert.ok(reopened.engine.calls.page > pages);
});

test("a deletion the service refuses outright doesn't hold back later messages", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  // The partner's device wrongly believes the partner is an admin (demoted
  // meanwhile, say); the service, which keeps the record, refuses.
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, householdAdmin: true });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await a.room.send("mine");
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  const [mine] = b.room.page().messages;
  await b.room.remove(mine, { byAdmin: true });
  assert.deepEqual(await b.room.sync({ status: STATUS, devices }), { hasMore: false });
  assert.equal(b.room.retireRefusal?.code, "chat_blob_retire_forbidden", "reported");
  assert.equal(b.room.pending.size, 0, "sent anyway");
  await b.room.send("still sending");
  await b.room.sync({ status: STATUS, devices });
  assert.equal(b.room.pending.size, 0);
  // The admin's own content stays on the service.
  assert.ok((await a.blobs.client.download(mine.blobRef)).ciphertext);
});

test("sending while a pull is storing events loads every event exactly once", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  for (let index = 0; index < 3; index += 1) await a.room.send(`from phone ${index}`);
  await a.room.sync({ status: STATUS, devices });
  // Overlapping reads, sends and a pass, in one tab and a second tab.
  const other = await openRoom(laptop, s);
  await Promise.all([
    b.room.sync({ status: STATUS, devices }),
    b.room.send("from laptop 1"),
    b.room.refresh(),
    b.room.send("from laptop 2"),
    other.room.send("from the other tab"),
    b.room.refresh(),
  ]);
  await b.room.refresh();
  await b.room.sync({ status: STATUS, devices });
  await other.room.refresh();
  for (const { room } of [b, other]) {
    const ids = [...room.indexById.keys()];
    assert.equal(room.records.length, 6);
    assert.equal(new Set(ids).size, 6, "no event twice");
    assert.equal(room.loadedOrder, 6);
  }
  assert.equal(b.room.pending.size, 0, "the outbox isn't stuck");
  await a.room.sync({ status: STATUS, devices });
  assert.equal(a.room.records.length, 6);
});

test("pending events sealed under an older key epoch are sealed again before they leave", async () => {
  const householdId = "aa".repeat(16);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device({ memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, { householdId, epochs });
  const pushed = [];
  let relaySequence = 0;
  const request = async (path, options = {}) => {
    if (request.offline) throw Object.assign(new Error("offline"), { code: "connection_unavailable" });
    if (path === "/api/chat/status") return { deviceSequence: relaySequence };
    // A service error on the member list doesn't hold chat back (labels
    // wait for a later pass).
    if (path === "/api/household") throw Object.assign(new Error("Internal error"), { code: "internal_error" });
    if (path.startsWith("/api/chat/events") && options.method === "POST") {
      const batch = decodeEnvelopeBatch(options.body);
      pushed.push(...batch);
      relaySequence = batch.at(-1).deviceSequence;
      return { accepted: batch.length };
    }
    if (path.startsWith("/api/chat/events")) return encodeEventPage({ events: [], nextCursor: "AAAAAAAAAAA", hasMore: false });
    throw new Error(`unexpected ${path}`);
  };
  request.fetch = async () => new Response("{}", { status: 200 });
  const { room } = await openRoom(phone, { householdId, request });
  // A first message goes out under epoch 1, settling the sequence.
  await room.send("first");
  await room.sync({ status: STATUS, devices: [phone.entry] });
  assert.deepEqual(pushed.map((envelope) => [envelope.deviceSequence, envelope.keyEpoch]), [[1, 1]]);
  // Written offline under epoch 1; the household rotates to 2 meanwhile.
  request.offline = true;
  await room.send("before the rotation");
  request.offline = false;
  epochs.set(2, await generateHouseholdKey());
  // While the rotation is pending, nothing is pushed.
  assert.deepEqual(await room.sync({ status: { currentEpoch: 2, rotationPending: true }, devices: [phone.entry] }), { hasMore: false });
  assert.equal(pushed.length, 1);
  assert.equal(room.pending.size, 1);
  await room.sync({ status: { currentEpoch: 2, rotationPending: false }, devices: [phone.entry] });
  assert.deepEqual(pushed.map((envelope) => [envelope.deviceSequence, envelope.keyEpoch]), [[1, 1], [2, 2]]);
  assert.equal(room.pending.size, 0);
  // Reopened, the resealed event decrypts under its new epoch.
  room.close();
  const again = await openRoom(phone, { householdId, request });
  assert.equal(again.room.records.length, 2);
});

test("the chat log store keeps each event once and one sequence per send", async () => {
  const householdId = "aa".repeat(16);
  const indexedDB = fakeIndexedDB();
  const one = await ChatLogStore.open(householdId, { indexedDB, keyRange: fakeKeyRange });
  const two = await ChatLogStore.open(householdId, { indexedDB, keyRange: fakeKeyRange });
  const envelope = (eventId, deviceSequence) => ({ eventId, deviceSequence });
  assert.deepEqual(await one.state(), { key: "state", nextOrder: 1, cursor: "", deviceSequence: 0, provisional: true, admins: [], members: [], membersSignature: null, retiredThrough: 0, refused: [], hidden: [], hiddenRevision: 0, hiddenDirty: false, hiddenSealedFor: [] });
  await one.addLocal(envelope("01".repeat(16), 1), { blobRef: "ab".repeat(32) });
  // Another tab sending with the same sequence loses and retries.
  await assert.rejects(two.addLocal(envelope("02".repeat(16), 1)), (error) => error.code === "chat_sequence_taken");
  assert.equal(await two.addReceived([envelope("01".repeat(16), 1), envelope("03".repeat(16), 4), envelope("03".repeat(16), 4)], "AAAAAAAAAAE"), 1);
  assert.deepEqual((await one.eventsFrom(1)).map((row) => [row.order, row.eventId]), [[1, "01".repeat(16)], [2, "03".repeat(16)]]);
  assert.deepEqual((await one.eventsFrom(2)).map((row) => row.order), [2]);
  assert.deepEqual((await one.eventsFrom(1, 1)).map((row) => row.order), [1], "in chunks");
  assert.deepEqual((await one.outbox()).map((row) => [row.deviceSequence, row.blobRef]), [[1, "ab".repeat(32)]]);
  // Renumbering refuses when a send took a sequence meanwhile.
  await assert.rejects(one.replacePending([{ order: 1, previousSequence: 1, envelope: envelope("01".repeat(16), 5) }], { expectedDeviceSequence: 0, deviceSequence: 5 }),
    (error) => error.code === "chat_outbox_changed");
  await one.markSent([1]);
  assert.deepEqual(await one.outbox(), []);
  await assert.rejects(one.replacePending([{ order: 1, previousSequence: 1, envelope: envelope("01".repeat(16), 1) }], { expectedDeviceSequence: 1, deviceSequence: 1 }), (error) => error.code === "chat_outbox_changed");
  await one.addReceived([], "AAAAAAAAAAI", { refused: Array.from({ length: 120 }, (_, index) => ({ eventId: String(index) })) });
  const state = await one.state();
  assert.equal(state.cursor, "AAAAAAAAAAI");
  assert.equal(state.refused.length, 100, "bounded");
  assert.equal(state.refused.at(-1).eventId, "119");
  // Hiding only adds: a pass that settles what it wrote keeps what was
  // hidden meanwhile, due for the next write; compaction drops deleted ones.
  await one.addHidden(["01".repeat(16)]);
  await two.addHidden(["02".repeat(16)]);
  assert.deepEqual(await one.settleHidden({ ids: ["01".repeat(16)], revision: 1 }), { ids: ["01".repeat(16), "02".repeat(16)], revision: 1, dirty: true });
  assert.deepEqual(await one.settleHidden({ ids: ["01".repeat(16), "02".repeat(16)], revision: 2, dropped: ["01".repeat(16)] }), { ids: ["02".repeat(16)], revision: 2, dirty: false });
  assert.ok(indexedDB.databases.has(chatLogDatabaseName(householdId)));
  await assert.rejects(ChatLogStore.open("nope", { indexedDB, keyRange: fakeKeyRange }), (error) => error.code === "chat_log_unavailable");
});

test("members are labelled as Household access lists them", () => {
  const members = [
    { id: "a", kind: "adult", active: true },
    { id: "b", kind: "adult", active: false },
    { id: "c", kind: "limited", active: true },
    { id: "d", kind: "adult", active: true },
    { id: "e", kind: "temporary", active: false },
    { id: "f", kind: "temporary", active: true },
  ];
  assert.deepEqual([...memberLabels(members, "d")], [
    ["a", "Adult 1"], ["d", "You"], ["c", "Limited member 1"], ["e", "Temporary member 1"], ["f", "Temporary member 2"],
  ]);
});

test("a message must follow the engine's text rule before it is sent", async () => {
  assert.equal(chatTextProblem("Dinner at 6\nBring bread\t🍞"), null);
  assert.match(chatTextProblem("   \n"), /Write a message/);
  assert.match(chatTextProblem("bell \u0007"), /characters/);
  assert.match(chatTextProblem("lone \ud800"), /can't be sent/);
  assert.equal(chatTextProblem("😀".repeat(4_000)), null, "counted in characters, not bytes");
  assert.match(chatTextProblem("x".repeat(4_001)), /too long/);
  const householdId = "aa".repeat(16);
  const phone = await device({ memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, { householdId, epochs: new Map([[1, await generateHouseholdKey()]]) });
  const offline = async () => { throw Object.assign(new Error("offline"), { code: "connection_unavailable" }); };
  offline.fetch = offline;
  const { room } = await openRoom(phone, { householdId, request: offline });
  await assert.rejects(room.send(" "), (error) => error.code === "chat_text_invalid");
  assert.equal(room.records.length, 0, "nothing stored");
});

test("delete for me hides a message on all of my devices and nowhere else (#119)", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const tablet = await device(s.pairDevice(s.admin), { householdId: s.householdId, epochs, householdAdmin: true });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  let devices = [phone.entry, tablet.entry, laptop.entry];
  const a = await openRoom(phone, s), b = await openRoom(tablet, s), c = await openRoom(laptop, s);
  const syncAll = async () => { for (const { room } of [a, b, c]) await room.sync({ status: STATUS, devices }); };
  await c.room.send("about the surprise");
  await c.room.send("dinner?");
  await syncAll();
  await syncAll();
  const [surprise, dinner] = a.room.page().messages;

  await a.room.hide(surprise);
  assert.ok(a.room.isHidden(surprise.messageId), "hidden here at once");
  await syncAll();
  assert.ok(b.room.isHidden(surprise.messageId), "and on my other device");
  assert.ok(!c.room.isHidden(surprise.messageId), "nobody else sees any change");
  assert.equal(c.room.page().messages.length, 2);
  // The partner's own record is separate; mine is opaque on the service.
  assert.equal(s.app.chatRelayService.hidden(s.app.syncService.authorize(s.partner.sessionToken)).revision, 0);
  const stored = s.app.chatRelayService.hidden(s.app.syncService.authorize(s.admin.sessionToken));
  assert.equal(stored.revision, 1);
  assert.equal(JSON.stringify(stored.record).includes(surprise.messageId), false, "the service can't read which");
  assert.deepEqual(stored.record.recipients.map((entry) => entry.deviceId).sort(), [s.admin.deviceId, tablet.who.deviceId].sort(), "sealed to my devices only");
  // A pass with nothing new asks only for the revision.
  const before = a.request.paths.length;
  await a.room.sync({ status: STATUS, devices });
  assert.ok(!a.request.paths.slice(before).some((path) => path === "PUT /api/chat/hidden"));

  // Both of my devices hide something offline: the record ends with both.
  a.request.offline = true;
  b.request.offline = true;
  await a.room.hide(dinner);
  await b.room.hide({ messageId: "ab".repeat(16) });
  a.request.offline = false;
  b.request.offline = false;
  await syncAll();
  await syncAll();
  for (const { room } of [a, b]) assert.deepEqual([...room.hidden].sort(), [surprise.messageId, dinner.messageId, "ab".repeat(16)].sort());

  // Survives a lock: kept on the device.
  a.room.close();
  const reopened = await openRoom(phone, s);
  assert.ok(reopened.room.isHidden(dinner.messageId));

  // A device of mine added later reads the record once another of mine
  // writes it again (sealed to it too).
  const tv = await device(s.pairDevice(s.admin), { householdId: s.householdId, epochs, householdAdmin: true });
  const d = await openRoom(tv, s);
  devices = [phone.entry, tablet.entry, laptop.entry, tv.entry];
  await d.room.sync({ status: STATUS, devices });
  assert.equal(d.room.hiddenWaiting, true, "not sealed to it yet");
  assert.equal(d.room.isHidden(surprise.messageId), false);
  await b.room.sync({ status: STATUS, devices });
  await d.room.sync({ status: STATUS, devices });
  assert.equal(d.room.hiddenWaiting, false);
  assert.ok(d.room.isHidden(surprise.messageId) && d.room.isHidden(dinner.messageId));

  // The device that wrote last is revoked: my other devices write afresh
  // from what they hold, and keep syncing.
  const lastWriter = s.app.chatRelayService.hidden(s.app.syncService.authorize(s.admin.sessionToken)).record.senderDeviceId;
  const writerRoom = [reopened, b, d].find(({ room }) => room.identity.deviceId === lastWriter) ?? reopened;
  devices = devices.map((entry) => (entry.deviceId === lastWriter ? { ...entry, revokedAt: Date.now() } : entry));
  const others = [reopened, b, d].filter((room) => room !== writerRoom);
  await others[0].room.hide({ messageId: "cd".repeat(16) });
  for (const { room } of others) await room.sync({ status: STATUS, devices });
  for (const { room } of others) await room.sync({ status: STATUS, devices });
  for (const { room } of others) {
    assert.equal(room.hiddenError, null, String(room.hiddenError?.code));
    assert.ok(room.isHidden("cd".repeat(16)) && room.isHidden(surprise.messageId), "kept and still syncing");
  }
  const after = s.app.chatRelayService.hidden(s.app.syncService.authorize(s.admin.sessionToken)).record;
  assert.ok(!after.recipients.some((entry) => entry.deviceId === lastWriter), "the revoked device isn't sealed to");
});

test("delete for me keeps syncing when one of my devices changes its key, and refuses a rollback", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  const tablet = await device(s.pairDevice(s.admin), { householdId: s.householdId, epochs, householdAdmin: true });
  phone.entry.fingerprint = "phone-1";
  tablet.entry.fingerprint = "tablet-1";
  let devices = [phone.entry, tablet.entry];
  const a = await openRoom(phone, s), b = await openRoom(tablet, s);
  await a.room.hide({ messageId: "01".repeat(16) });
  await a.room.sync({ status: STATUS, devices });
  await b.room.sync({ status: STATUS, devices });
  assert.ok(b.room.isHidden("01".repeat(16)));
  // The tablet rekeys: its old key can't open what was sealed to it.
  const rekeyed = await device(tablet.who, { householdId: s.householdId, epochs, householdAdmin: true });
  rekeyed.entry.fingerprint = "tablet-2";
  rekeyed.indexedDB = tablet.indexedDB;
  devices = [phone.entry, rekeyed.entry];
  b.room.close();
  const b2 = await openRoom(rekeyed, s);
  await b2.room.hide({ messageId: "02".repeat(16) });
  await b2.room.sync({ status: STATUS, devices });
  assert.equal(b2.room.hiddenWaiting, true, "waits for the phone, which can read it");
  await a.room.sync({ status: STATUS, devices });
  await b2.room.sync({ status: STATUS, devices });
  await a.room.sync({ status: STATUS, devices });
  for (const { room } of [a, b2]) assert.deepEqual([...room.hidden].sort(), ["01".repeat(16), "02".repeat(16)]);
  // Every device of mine rekeyed or new: the record can't be read by any of
  // them, so one writes it afresh from what it holds.
  const fresh = await device(s.admin, { householdId: s.householdId, epochs, householdAdmin: true });
  fresh.entry.fingerprint = "phone-2";
  fresh.indexedDB = phone.indexedDB;
  devices = [fresh.entry];
  a.room.close();
  const a2 = await openRoom(fresh, s);
  await a2.room.sync({ status: STATUS, devices });
  assert.equal(a2.room.hiddenError, null);
  assert.equal(a2.room.hiddenWaiting, false);
  assert.ok(a2.room.isHidden("01".repeat(16)));
  // The service goes back to an older (here: empty) record, as after a
  // restored backup: the device writes back what it holds.
  const auth = s.app.syncService.authorize(s.admin.sessionToken);
  s.app.chatRelayService.storage.forgetHousehold(s.householdId);
  assert.equal(s.app.chatRelayService.hidden(auth).revision, 0);
  await a2.room.sync({ status: STATUS, devices });
  assert.equal(a2.room.hiddenError, null);
  assert.ok(a2.room.isHidden("01".repeat(16)) && a2.room.isHidden("02".repeat(16)));
  assert.equal(s.app.chatRelayService.hidden(auth).revision, 1, "written back");
});

test("the in-memory chat log grows in place and gives the engine views of it", () => {
  const records = new ChatRecords();
  const first = records.view();
  for (let index = 0; index < 2_000; index += 1) records.append(encoder.encode(`event ${index} `.repeat(10)));
  const view = records.view();
  assert.equal(view.arena, first.arena, "the same log, so the engine is sent only what's new");
  assert.equal(view.epoch, first.epoch);
  assert.equal(view.length, 2_000);
  assert.equal(decoder.decode(view.record(1_999)), "event 1999 ".repeat(10));
  const target = new Uint8Array(view.recordLength(3) + view.recordLength(4));
  view.copyRecordsTo(target, 0, 3, 5);
  assert.equal(decoder.decode(target), "event 3 ".repeat(10) + "event 4 ".repeat(10));
  records.clear();
  assert.notEqual(records.view().epoch, view.epoch);
  assert.throws(() => view.record(0), /changed/);
  assert.equal(MAX_CHAT_PULL, 200);
});

test("the coordinator runs a chat pass after each full pass and keeps chat trouble to chat", async () => {
  const reports = [];
  const room = { syncs: 0, closed: false, result: { hasMore: true }, failure: null,
    async sync(context) { this.syncs += 1; this.context = context; if (this.failure) throw this.failure; return this.result; },
    reportSync(error) { reports.push(error?.code ?? null); }, close() { this.closed = true; } };
  const opened = [], told = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16), memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, liveChannel: () => null,
    chatRoom: async (options) => { opened.push(options); return room; }, onChatRoom: (value) => told.push(value) });
  coordinator.deviceKeys = { keys: {} };
  coordinator.keyStore = { close() {} };
  const context = { status: STATUS, devices: [] };
  assert.deepEqual(await coordinator.syncChat(context), { hasMore: true });
  assert.equal(opened.length, 1);
  assert.equal(typeof opened[0].request, "function");
  assert.equal(opened[0].deviceKeys, coordinator.deviceKeys);
  await coordinator.syncChat(context);
  assert.equal(opened.length, 1, "opened once");
  assert.equal(room.context.deviceKeys, coordinator.deviceKeys);
  room.failure = Object.assign(new Error("Chat isn't available to you."), { code: "chat_unavailable" });
  assert.deepEqual(await coordinator.syncChat(context), { hasMore: false }, "household sync carries on");
  room.failure = Object.assign(new Error("Signed out"), { code: "authentication_required" });
  await assert.rejects(coordinator.syncChat(context), (error) => error.code === "authentication_required");
  assert.deepEqual(reports, [null, null, "chat_unavailable"]);
  assert.deepEqual(told, [room], "the view hears when the room opens");
  coordinator.stop();
  assert.equal(room.closed, true, "stopping (on lock) closes the room");
  assert.deepEqual(told, [room, null], "and when it closes");
  assert.equal(coordinator.chat, null);

  // A pass that leaves chat to read continues soon, like a household catch-up.
  const continuing = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16) }, liveChannel: () => null, chatRoom: async () => null });
  const continued = [];
  continuing.runOnce = async () => ({ hasMore: false, advanced: true, chatMore: true });
  continuing.scheduleContinuation = () => continued.push(true);
  continuing.updatePollInterval = () => {};
  await continuing.syncNow();
  assert.deepEqual(continued, [true]);
  continuing.runOnce = async () => ({ hasMore: false, advanced: true, chatMore: false });
  await continuing.syncNow();
  assert.deepEqual(continued, [true]);
  // Blob requests stop with sync.
  continuing.stop();
  await assert.rejects(continuing.blobFetch("/api/chat/blobs/x"), /stopped/);

  // A room that fails to open is remembered for the view and retried.
  let attempts = 0;
  const failing = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16) }, liveChannel: () => null,
    chatRoom: async () => { attempts += 1; throw Object.assign(new Error("missing key"), { code: "chat_key_missing" }); } });
  assert.deepEqual(await failing.syncChat(context), { hasMore: false });
  assert.equal(failing.chatOpenError.code, "chat_key_missing");
  await failing.syncChat(context);
  assert.equal(attempts, 2);

  // Where chat storage is missing, the coordinator stops trying.
  const none = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16) }, liveChannel: () => null, chatRoom: async () => null });
  assert.deepEqual(await none.syncChat(context), { hasMore: false });
  assert.equal(none.openChatRoom, null);
});

test("the room drives the real chat engine: send, edit, delete and page (#109, #111)", { skip: !existsSync(WASM) && "kin_engine.wasm is not built here" }, async () => {
  const engine = await loadKinEngine(`data:application/wasm;base64,${readFileSync(WASM).toString("base64")}`);
  const householdId = "aa".repeat(16);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device({ memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, { householdId, epochs });
  const offline = async () => { throw Object.assign(new Error("offline"), { code: "connection_unavailable" }); };
  offline.fetch = offline;
  const opened = await openRoom(phone, { householdId, engine, request: offline });
  await opened.room.send("Dinner at 6");
  await opened.room.send("Bring bread");
  const [first, second] = opened.room.page().messages;
  assert.deepEqual([first.status, second.status], ["live", "live"]);
  assert.equal(first.authorId, "bb".repeat(16));
  await opened.room.edit(first, "Dinner at 7");
  await opened.room.remove(second);
  const page = opened.room.page({ includeRetired: true });
  assert.deepEqual(page.messages.map((message) => message.status), ["edited", "deleted"]);
  assert.deepEqual(page.retired.sort(), [first.blobRef, second.blobRef].sort());
  assert.deepEqual(await texts(opened), ["Dinner at 7", "deleted"]);
  // Reopened from storage with the same engine instance, the mirror resets
  // to the new log and pages the same.
  opened.room.close();
  const again = await openRoom(phone, { householdId, engine, request: offline });
  assert.deepEqual(again.room.page().messages.map((message) => message.status), ["edited", "deleted"]);
  assert.equal(again.room.pending.size, 4, "all four wait to send");
});

test("photos and files go to the other device in parts, and deleting the message deletes every part", { timeout: 60_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const devices = [phone.entry, laptop.entry];
  // A stand-in for the browser's photo preparation: the photo is "drawn
  // again" as different bytes, with a thumbnail.
  const preparePhoto = async (photo) => ({
    blob: new Blob([new Uint8Array(3000).fill(7)], { type: photo.type }),
    thumbnail: new Blob([new Uint8Array(200).fill(9)], { type: "image/jpeg" }),
  });
  const a = await openRoom(phone, { ...s, preparePhoto }), b = await openRoom(laptop, s);
  const slip = new Uint8Array(2.5 * 1024 * 1024);
  for (let index = 0; index < slip.length; index += 1) slip[index] = (index * 31 + 7) & 0xff;
  const slipFile = new File([slip], "Permission slip.pdf", { type: "application/pdf" });
  const photoFile = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...new Array(36).fill(0)])], "IMG_2041.heic.jpg", { type: "image/jpeg" });

  await a.room.sendAttachments({ text: "Sign by Friday", files: [slipFile, photoFile] });
  await a.room.sync({ status: STATUS, devices });
  // Three parts of the slip, the photo and its thumbnail, then the manifest
  // (the last of them), all before the event that names them.
  const paths = a.request.paths;
  const uploads = paths.map((path, index) => (path.startsWith("PUT /api/chat/blobs/") ? index : -1)).filter((index) => index >= 0);
  assert.equal(uploads.length, 3 + 1 + 1 + 1, "parts, thumbnail, then manifest");
  assert.ok(uploads.at(-1) < paths.indexOf("POST /api/chat/events"), "the event goes after its content");
  await b.room.sync({ status: STATUS, devices });
  const message = b.room.page().messages.find((entry) => entry.contentKind === "attachment");
  assert.ok(message && message.text === null, "shown as an attachment, its content not in the engine");
  const opened = await b.room.openAttachment(message);
  assert.equal(opened.text, "Sign by Friday");
  assert.deepEqual(opened.files.map((file) => [file.name, file.size, file.photo]), [["Permission slip.pdf", slip.length, false], ["IMG_2041.heic.jpg", 3000, true]]);
  const back = new Uint8Array(await (await b.room.attachmentFile(message, 0)).arrayBuffer());
  assert.equal(back.length, slip.length);
  assert.ok(back.every((byte, index) => byte === slip[index]), "the file's bytes arrive whole");
  assert.equal(await b.room.attachmentThumbnail(message, 0), null, "a file has no thumbnail");
  assert.equal((await b.room.attachmentThumbnail(message, 1)).size, 200);
  assert.equal((await b.room.attachmentFile(message, 1)).size, 3000, "the photo is the drawn-again copy");

  // Deleting for everyone: the author's device names the parts; the service
  // deletes them, and the other device deletes its copies.
  const parts = (await b.room.manifestOf(message)).files.flatMap((file) => [...file.parts, file.thumbnail].filter(Boolean)).map((part) => part.ref);
  assert.equal(parts.length, 3 + 1 + 1 + 0, "the slip's parts, the photo part and the thumbnail");
  await a.room.remove(a.room.page().messages.find((entry) => entry.messageId === message.messageId));
  await a.room.sync({ status: STATUS, devices });
  for (const ref of parts) assert.deepEqual(await a.blobs.client.download(ref), { deleted: true }, "deleted on the service");
  await b.room.sync({ status: STATUS, devices });
  await assert.rejects(b.room.openAttachment(message), (error) => error.code === "chat_attachment_deleted");
  for (const ref of parts) assert.equal(await b.blobs.store.get(ref), null, "and on the other device");
});
