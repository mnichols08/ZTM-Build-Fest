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
import { chatAdmins, ChatRoom, MAX_CHAT_PULL } from "./chat-room.js";
import { fakeIndexedDB, fakeKeyRange } from "./fake-indexeddb.test-support.mjs";
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
          messages.set(command.messageId, { messageId: command.messageId, authorId: actorId, deviceId, postedAt: timestamp, status: "live", blobRef: command.blobRef, blobKey: bytesOf(command.blobKey) });
        else if (message && message.status !== "deleted" && (actorId === message.authorId || (command.byAdmin && options.admins.includes(actorId)))) {
          retired.push(message.blobRef);
          if (command.type === "edit-chat-message") Object.assign(message, { status: "edited", blobRef: command.blobRef, blobKey: bytesOf(command.blobKey) });
          else Object.assign(message, { status: command.byAdmin ? "removed-by-admin" : "deleted", blobRef: null, blobKey: null });
        }
      }
      const list = [...messages.values()];
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
  return { app, base, admin, partner, householdId: admin.householdId };
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
async function device(who, { householdId, epochs, memberKind = "adult" }) {
  const keys = await generateDeviceKeys();
  const publicKeys = await exportDevicePublicKeys(keys);
  return {
    who,
    deviceKeys: { keys },
    entry: { deviceId: who.deviceId, memberId: who.memberId, publicKeys, verifiedKeyHistory: [{ publicKeys }], historyFromEpoch: 1, memberKind, memberActive: true },
    keyStore: {
      vault: { assertUnlocked() {} },
      getEpoch: async (household, keyEpoch) => (household === householdId && epochs.has(keyEpoch) ? { keyEpoch, householdKey: epochs.get(keyEpoch) } : null),
      listEpochs: async () => [...epochs].map(([keyEpoch, householdKey]) => ({ keyEpoch, householdKey })),
    },
    indexedDB: fakeIndexedDB(),
  };
}

async function openRoom(phone, { base, householdId, engine = fakeEngine(), request = requester(base, phone.who), indexedDB = phone.indexedDB, locks } = {}) {
  const blobs = new ChatBlobs({ store: await ChatBlobStore.open(householdId, { indexedDB }), client: new ChatBlobClient({ fetch: request.fetch }) });
  const room = await ChatRoom.open({
    identity: { householdId, memberId: phone.who.memberId, deviceId: phone.who.deviceId },
    keyStore: phone.keyStore, deviceKeys: phone.deviceKeys, engine, request, blobs,
    indexedDB, keyRange: fakeKeyRange, locks,
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
  assert.deepEqual(await texts(a), ["Dinner at 6 🍝", "Bring bread"], "the sender sees them at once");
  assert.ok(changes.length >= 2);
  await assert.rejects(a.room.sync({ status: STATUS, devices }), (error) => error.code === "connection_unavailable");
  assert.ok(a.room.isPending(first.eventId), "still waiting while offline");

  a.request.offline = false;
  assert.deepEqual(await a.room.sync({ status: STATUS, devices }), { hasMore: false });
  assert.equal(a.room.pending.size, 0, "sent");
  assert.ok(a.request.paths.includes("GET /api/chat/status"), "a new log asks the relay where it stands");
  assert.deepEqual(a.request.paths.filter((path) => path.startsWith("PUT /api/chat/blobs/")).length, 2, "content uploads before its event");

  await b.room.sync({ status: STATUS, devices });
  assert.deepEqual(await texts(b), ["Dinner at 6 🍝", "Bring bread"]);
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

test("only authenticated chat events from this household's trusted devices are stored", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs });
  const a = await openRoom(phone, s), b = await openRoom(laptop, s);
  await a.room.send("hello");
  await a.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });

  const refused = (error) => error.code === "chat_event_refused";
  // An unknown device; a device revoked before this epoch; history from
  // before the device's grant; a key that doesn't match its signature.
  await assert.rejects(b.room.sync({ status: STATUS, devices: [laptop.entry] }), refused);
  await assert.rejects(b.room.sync({ status: STATUS, devices: [{ ...phone.entry, revokedAt: 1 }, laptop.entry] }), refused);
  await assert.rejects(b.room.sync({ status: STATUS, devices: [{ ...phone.entry, historyFromEpoch: 2 }, laptop.entry] }), refused);
  await assert.rejects(b.room.sync({ status: STATUS, devices: [{ ...phone.entry, verifiedKeyHistory: laptop.entry.verifiedKeyHistory }, laptop.entry] }),
    (error) => error.code === "event_signature_invalid");
  // A member's device claiming another member as author.
  await assert.rejects(b.room.sync({ status: STATUS, devices: [{ ...phone.entry, memberId: s.partner.memberId }, laptop.entry] }), refused);
  assert.equal(b.room.records.length, 0, "nothing refused was kept");
  assert.equal((await b.room.store.state()).cursor, "", "nor read past");

  // A missing key epoch pauses chat rather than skipping the event.
  const forgetful = await device(s.partner, { householdId: s.householdId, epochs: new Map() });
  const c = await openRoom(forgetful, s);
  await assert.rejects(c.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] }), (error) => error.code === "chat_key_missing");

  await b.room.sync({ status: STATUS, devices: [phone.entry, laptop.entry] });
  assert.equal(b.room.records.length, 1);
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

test("editing and deleting delete the replaced content on the service and on every device", { timeout: 30_000 }, async (t) => {
  const s = await service(t);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device(s.admin, { householdId: s.householdId, epochs });
  const laptop = await device(s.partner, { householdId: s.householdId, epochs, memberKind: "limited" });
  const devices = [phone.entry, laptop.entry];
  assert.deepEqual(chatAdmins(devices), [s.admin.memberId], "admins are active adults");
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
});

test("pending events sealed under an older key epoch are sealed again before they leave", async () => {
  const householdId = "aa".repeat(16);
  const epochs = new Map([[1, await generateHouseholdKey()]]);
  const phone = await device({ memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, { householdId, epochs });
  const pushed = [];
  const request = async (path, options = {}) => {
    if (path === "/api/chat/status") return { deviceSequence: 0 };
    if (path.startsWith("/api/chat/events") && options.method === "POST") {
      pushed.push(...decodeEnvelopeBatch(options.body));
      return { accepted: 1 };
    }
    if (path.startsWith("/api/chat/events")) return encodeEventPage({ events: [], nextCursor: "", hasMore: false });
    throw new Error(`unexpected ${path}`);
  };
  request.fetch = async () => new Response("{}", { status: 200 });
  const { room } = await openRoom(phone, { householdId, request });
  room.request = async () => { throw Object.assign(new Error("offline"), { code: "connection_unavailable" }); };
  await room.send("before the rotation");
  await room.sync({ status: STATUS, devices: [phone.entry] }).catch(() => {});
  room.request = request;
  // Settle the provisional count first, still under epoch 1.
  await room.store.settleSequence(0);
  epochs.set(2, await generateHouseholdKey());
  await room.sync({ status: { currentEpoch: 2, rotationPending: false }, devices: [phone.entry] }).catch(() => {});
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].keyEpoch, 2);
  assert.equal(pushed[0].deviceSequence, 1);
  // While a rotation is pending, nothing is pushed.
  await room.send("during the rotation");
  await room.sync({ status: { currentEpoch: 2, rotationPending: true }, devices: [phone.entry] }).catch(() => {});
  assert.equal(pushed.length, 1);
});

test("the chat log store keeps each event once and one sequence per send", async () => {
  const householdId = "aa".repeat(16);
  const indexedDB = fakeIndexedDB();
  const one = await ChatLogStore.open(householdId, { indexedDB, keyRange: fakeKeyRange });
  const two = await ChatLogStore.open(householdId, { indexedDB, keyRange: fakeKeyRange });
  const envelope = (eventId, deviceSequence) => ({ eventId, deviceSequence });
  assert.deepEqual(await one.state(), { key: "state", nextOrder: 1, cursor: "", deviceSequence: 0, provisional: true });
  await one.addLocal(envelope("01".repeat(16), 1), { blobRef: "ab".repeat(32) });
  // Another tab sending with the same sequence loses and retries.
  await assert.rejects(two.addLocal(envelope("02".repeat(16), 1)), (error) => error.code === "chat_sequence_taken");
  assert.equal(await two.addReceived([envelope("01".repeat(16), 1), envelope("03".repeat(16), 4), envelope("03".repeat(16), 4)], "AAAAAAAAAAE"), 1);
  assert.deepEqual((await one.eventsFrom(1)).map((row) => [row.order, row.eventId]), [[1, "01".repeat(16)], [2, "03".repeat(16)]]);
  assert.deepEqual((await one.eventsFrom(2)).map((row) => row.order), [2]);
  assert.deepEqual((await one.outbox()).map((row) => [row.deviceSequence, row.blobRef]), [[1, "ab".repeat(32)]]);
  await one.markSent([1]);
  assert.deepEqual(await one.outbox(), []);
  await assert.rejects(one.replacePending([{ order: 1, previousSequence: 1, envelope: envelope("01".repeat(16), 1) }], { deviceSequence: 1 }), (error) => error.code === "chat_outbox_changed");
  assert.equal((await one.state()).cursor, "AAAAAAAAAAE");
  assert.ok(indexedDB.databases.has(chatLogDatabaseName(householdId)));
  await assert.rejects(ChatLogStore.open("nope", { indexedDB, keyRange: fakeKeyRange }), (error) => error.code === "chat_log_unavailable");
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
  const opened = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId: "aa".repeat(16), memberId: "bb".repeat(16), deviceId: "cc".repeat(16) }, liveChannel: () => null,
    chatRoom: async (options) => { opened.push(options); return room; } });
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
  coordinator.stop();
  assert.equal(room.closed, true, "stopping (on lock) closes the room");
  assert.equal(coordinator.chat, null);

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
