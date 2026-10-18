// The household chat room on this device (#111): sending, the chat relay
// stream, and the decrypted chat log the engine pages through.
//
// - The chat log (chat-log-store.js) keeps every chat event as the signed,
//   encrypted envelope it travels in. Opening the room decrypts it into
//   memory (chat-records.js); locking drops that copy.
// - Sending seals the message content into a blob (#110), has the engine
//   make and check the chat event against the chat log (#109), encrypts and
//   signs it under the household's current key epoch, and stores it with an
//   outbox entry. It shows at once as waiting to send.
// - sync() runs after each full household sync pass (sync-coordinator.js):
//   it uploads each pending event's blob, pushes the events to the chat
//   relay, retires the blobs an edit or deletion replaced, then pulls new
//   chat events, authenticates each against its author's device key,
//   checks its canonical identity, and stores it.
//
// Until the chat key exists (#123), chat events are encrypted under the
// household key epoch, like household events. The relay keeps them in their
// own stream (server/chat-relay-service.mjs).
import { decryptStoredEvent, decryptWithDeviceHistory, encryptEvent } from "../sync/crypto.js";
import { decodeEventPage, encodeEnvelopeBatch, ENVELOPE_CONTENT_TYPE } from "../sync/envelope-wire.js";
import { idToHex } from "../wasm/kin-engine.js";
import { projectionContext } from "../browser-time.js";
import { ChatBlobClient } from "./chat-blob-client.js";
import { refHex } from "./chat-blob-crypto.js";
import { ChatBlobStore } from "./chat-blob-store.js";
import { ChatBlobs } from "./chat-blobs.js";
import { ChatLogError, ChatLogStore } from "./chat-log-store.js";
import { ChatRecords } from "./chat-records.js";

/** Most events one push sends (the relay's batch bound). */
export const MAX_CHAT_PUSH = 20;
/** Most events one pull asks for (the relay's chat page bound). */
export const MAX_CHAT_PULL = 200;
/** Pull pages per sync pass; the coordinator continues when there are more. */
const MAX_CHAT_PULL_PAGES = 5;
/** Records decoded per metadata batch while opening the log. */
const METADATA_BATCH = 500;
const CHAT_KINDS = new Set(["CHAT_MESSAGE_POSTED", "CHAT_MESSAGE_EDITED", "CHAT_MESSAGE_DELETED"]);
const REF = /^[a-f0-9]{64}$/;

export class ChatRoomError extends Error {
  constructor(message, code = "chat_unavailable") {
    super(message);
    this.name = "ChatRoomError";
    this.code = code;
  }
}

const randomIdHex = () => [...crypto.getRandomValues(new Uint8Array(16))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Members whose removals count: active adults (ADR 0008's household admin
 * until the admin chat policy, #123, says otherwise). */
export function chatAdmins(devices, now = Date.now()) {
  return [...new Set(devices
    .filter((device) => device.memberKind === "adult" && device.memberActive !== false &&
      (device.memberExpiresAt === undefined || device.memberExpiresAt > now))
    .map((device) => device.memberId))].sort().slice(0, 16);
}

/** The chat room for a browser page, with its blob store and client, or
 * null where there is no IndexedDB (Node tests of the coordinator). */
export async function openBrowserChatRoom(options) {
  if (typeof globalThis.indexedDB === "undefined" || typeof globalThis.IDBKeyRange === "undefined") return null;
  const blobStore = await ChatBlobStore.open(options.identity.householdId);
  try {
    const room = await ChatRoom.open({ ...options, blobs: new ChatBlobs({ store: blobStore, client: new ChatBlobClient() }) });
    room.onClose = () => blobStore.close();
    return room;
  } catch (error) {
    blobStore.close();
    throw error;
  }
}

export class ChatRoom {
  /**
   * Opens the household's chat room on this device and decrypts its log.
   * `request(path, options)` is the coordinator's authenticated request;
   * `blobs` a ChatBlobs (#110). `locks` serializes sending across tabs.
   */
  static async open({ identity, keyStore, deviceKeys, engine, request, blobs, indexedDB, keyRange, locks = globalThis.navigator?.locks, now = () => Date.now(), onLocalChange = () => {} }) {
    const store = await ChatLogStore.open(identity.householdId, { indexedDB, keyRange });
    const room = new ChatRoom({ identity, keyStore, deviceKeys, engine, request, blobs, store, locks, now, onLocalChange });
    try {
      await room.refresh();
    } catch (error) {
      room.close();
      throw error;
    }
    return room;
  }

  constructor({ identity, keyStore, deviceKeys, engine, request, blobs, store, locks, now, onLocalChange }) {
    this.identity = identity;
    this.keyStore = keyStore;
    this.deviceKeys = deviceKeys;
    this.engine = engine;
    this.request = request;
    this.blobs = blobs;
    this.store = store;
    this.locks = locks;
    this.now = now;
    this.onLocalChange = onLocalChange;
    this.records = new ChatRecords();
    // eventId -> record index, for resealing pending events.
    this.indexById = new Map();
    this.loadedOrder = 0;
    this.maxLogicalTime = 0n;
    this.epochKeys = new Map();
    this.currentEpoch = null;
    this.admins = [];
    this.pending = new Set();
    this.retiredLocally = new Set();
    this.listeners = new Set();
    this.syncError = null;
    this.onClose = null;
    this.closed = false;
  }

  /** Records how the last chat pass went (null when it succeeded), for the
   * view to show; the coordinator calls it after each pass. */
  reportSync(error) {
    const changed = (this.syncError?.message ?? null) !== (error?.message ?? null);
    this.syncError = error;
    if (changed) this.notify();
  }

  /** Calls `listener()` whenever the chat log or its pending set changes.
   * Returns a function that stops it. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a view's failure isn't the room's */ }
    }
  }

  assertOpen() {
    if (this.closed) throw new ChatRoomError("Unlock Kin to use chat.", "chat_locked");
    this.keyStore.vault?.assertUnlocked?.();
  }

  async epochKey(keyEpoch) {
    if (this.epochKeys.has(keyEpoch)) return this.epochKeys.get(keyEpoch);
    const epoch = await this.keyStore.getEpoch(this.identity.householdId, keyEpoch);
    if (!epoch) throw new ChatRoomError(`This device is missing key epoch ${keyEpoch}; chat is paused.`, "chat_key_missing");
    this.epochKeys.set(keyEpoch, epoch.householdKey);
    return epoch.householdKey;
  }

  /** The household's current key epoch: the last sync's, else the newest
   * this device holds (an offline message before the first sync). */
  async sendingEpoch() {
    if (this.currentEpoch !== null) return this.currentEpoch;
    const epochs = await this.keyStore.listEpochs(this.identity.householdId);
    if (!epochs.length) throw new ChatRoomError("Chat is unavailable until household sync is set up.", "chat_sync_unavailable");
    return Math.max(...epochs.map((epoch) => epoch.keyEpoch));
  }

  /** Reads events stored since the last read (by this tab or another) into
   * memory, and the outbox. */
  async refresh() {
    this.assertOpen();
    const rows = await this.store.eventsFrom(this.loadedOrder + 1);
    let changed = false;
    for (let start = 0; start < rows.length; start += METADATA_BATCH) {
      const batch = rows.slice(start, start + METADATA_BATCH);
      const encoded = [];
      for (const row of batch) {
        if (row.order !== this.loadedOrder + 1 + encoded.length)
          throw new ChatLogError("This device's chat log is out of order.", "chat_log_damaged");
        encoded.push(await decryptStoredEvent({ envelope: row.envelope, householdKey: await this.epochKey(row.envelope.keyEpoch) }));
      }
      this.assertOpen();
      const metadata = this.engine.eventMetadataBatch(encoded);
      batch.forEach((row, index) => {
        this.indexById.set(row.eventId, this.records.length);
        this.records.append(encoded[index]);
        const logicalTime = BigInt(metadata[index].logicalTime);
        if (logicalTime > this.maxLogicalTime) this.maxLogicalTime = logicalTime;
        encoded[index].fill(0);
      });
      this.loadedOrder += batch.length;
      changed = true;
    }
    const pending = new Set((await this.store.outbox()).map((row) => row.eventId));
    if (pending.size !== this.pending.size || [...pending].some((id) => !this.pending.has(id))) changed = true;
    this.pending = pending;
    if (changed) this.notify();
    return changed;
  }

  /** Whether this device's event `eventId` is still waiting to send. */
  isPending(eventId) {
    return this.pending.has(eventId);
  }

  syncIdentity() {
    return { householdId: this.identity.householdId, bindings: [] };
  }

  /** A page of the chat room (wasm/kin-engine.js chatPage). */
  page(options = {}) {
    this.assertOpen();
    const { asOf, civilDate } = projectionContext(this.now());
    return this.engine.chatPage(this.records.view(), { ...options, admins: this.admins }, asOf, civilDate, this.syncIdentity());
  }

  /** Sends a text message. Resolves with { messageId, eventId } once it is
   * stored on this device; it reaches the relay on the next sync. */
  async send(text) {
    const messageId = randomIdHex();
    const sealed = await this.sealText(text);
    const eventId = await this.author({ type: "post-chat-message", messageId, blobRef: sealed.ref, blobKey: sealed.key }, { blobRef: sealed.ref });
    return { messageId, eventId };
  }

  /** Seals text into a kept blob; the key goes into the event as hex. */
  async sealText(text) {
    this.assertOpen();
    const { ref, key } = await this.blobs.seal(text);
    const hex = refHex(key);
    key.fill(0);
    return { ref, key: hex };
  }

  /** Replaces a message's text. `message` is the page entry being edited. */
  async edit(message, text) {
    const sealed = await this.sealText(text);
    return this.author({ type: "edit-chat-message", messageId: message.messageId, blobRef: sealed.ref, blobKey: sealed.key },
      { blobRef: sealed.ref, retireRef: message.blobRef });
  }

  /** Deletes a message for everyone: the author's own, or as an admin. */
  async remove(message, { byAdmin = false } = {}) {
    return this.author({ type: "delete-chat-message", messageId: message.messageId, byAdmin },
      { retireRef: message.blobRef });
  }

  async author(command, { blobRef = null, retireRef = null }) {
    this.assertOpen();
    if (retireRef !== null && !REF.test(retireRef)) retireRef = null;
    const write = async () => {
      // Another tab may have stored events (or sent) since this one read.
      await this.refresh();
      const state = await this.store.state();
      const { asOf, civilDate } = projectionContext(this.now());
      const eventId = randomIdHex();
      const logicalTime = this.maxLogicalTime + 1n;
      const result = this.engine.executeChatCommand(command, {
        eventId,
        householdId: this.identity.householdId,
        actorId: this.identity.memberId,
        deviceId: this.identity.deviceId,
        timestamp: asOf,
        logicalTime,
      }, this.records.view(), asOf, civilDate, this.syncIdentity(), this.admins);
      const keyEpoch = await this.sendingEpoch();
      const envelope = await encryptEvent({
        eventId,
        householdId: this.identity.householdId,
        deviceId: this.identity.deviceId,
        deviceSequence: state.deviceSequence + 1,
        logicalTime: logicalTime.toString(),
        keyEpoch,
        plaintext: result.encodedEvent,
        householdKey: await this.epochKey(keyEpoch),
        signingKey: this.signingKey(),
      });
      result.encodedEvent.fill(0);
      this.assertOpen();
      await this.store.addLocal(envelope, { blobRef, retireRef });
      await this.refresh();
      return eventId;
    };
    const eventId = await this.exclusive(write);
    try { this.onLocalChange(); } catch { /* sync starts on its own schedule */ }
    return eventId;
  }

  signingKey() {
    const key = this.deviceKeys?.keys?.signingPrivateKey;
    if (!key) throw new ChatRoomError("Chat is unavailable until this device's keys are ready.", "chat_keys_unavailable");
    return key;
  }

  /**
   * One chat pass, after a full household pass: push this device's pending
   * events, then pull. `status` and `devices` are that pass's sync status
   * and verified device directory. Resolves with { hasMore } when the relay
   * has more chat to read than one pass takes.
   */
  async sync({ status, devices, deviceKeys }) {
    this.assertOpen();
    if (deviceKeys) this.deviceKeys = deviceKeys;
    this.currentEpoch = status.currentEpoch;
    this.admins = chatAdmins(devices, this.now());
    await this.refresh();
    if (!status.rotationPending) await this.push();
    const hasMore = await this.pull(status, devices);
    await this.retireReplaced();
    return { hasMore };
  }

  async push() {
    const before = await this.store.state();
    if (!(await this.store.outbox()).length && !before.provisional) return;
    // Where the relay stands for this device: settles a provisional count,
    // and tells events accepted before a lost acknowledgement apart from
    // events still to send.
    const { deviceSequence: relaySequence } = await this.request("/api/chat/status");
    if (!Number.isSafeInteger(relaySequence) || relaySequence < 0)
      throw new ChatRoomError("Chat received an invalid relay position.", "chat_relay_invalid");
    if (!before.provisional) {
      const accepted = (await this.store.outbox()).filter((row) => row.deviceSequence <= relaySequence);
      if (accepted.length) await this.finishSent(accepted);
    }
    // Renumbering and resealing change this device's sequence, so they run
    // under the lock sending holds.
    await this.exclusive(async () => {
      const outbox = await this.store.outbox();
      const state = await this.store.state();
      if (state.provisional) {
        // Events made before this device first asked the relay: none of
        // them can be there, so they follow the relay's count.
        if (!outbox.length) await this.store.settleSequence(relaySequence);
        else await this.reseal(outbox, relaySequence + 1, { deviceSequence: relaySequence + outbox.length });
        return;
      }
      if (outbox.length && outbox[0].deviceSequence !== relaySequence + 1)
        throw new ChatRoomError("Chat on this device is out of step with the relay.", "chat_sequence_mismatch");
      // Anything sealed under an older key epoch than the current one is
      // sealed again (same sequence) before it leaves the device.
      const stale = [];
      for (const row of outbox)
        if ((await this.pendingEnvelope(row)).keyEpoch < this.currentEpoch) stale.push(row);
      if (stale.length) await this.reseal(stale, null, { deviceSequence: state.deviceSequence });
    });
    while (true) {
      const batch = (await this.store.outbox()).slice(0, MAX_CHAT_PUSH);
      if (!batch.length) break;
      const envelopes = [];
      for (const row of batch) {
        if (row.blobRef) await this.blobs.upload(row.blobRef);
        envelopes.push(await this.pendingEnvelope(row));
      }
      await this.request("/api/chat/events", {
        method: "POST",
        body: encodeEnvelopeBatch(envelopes),
        headers: { "Content-Type": ENVELOPE_CONTENT_TYPE },
      });
      await this.finishSent(batch);
    }
    await this.refresh();
  }

  /** Runs `work` while no tab of this household is sending. */
  exclusive(work) {
    return this.locks?.request ? this.locks.request(`kin-chat-send:${this.identity.householdId}`, work) : work();
  }

  /** After the relay accepted events: asks the service to delete the blobs
   * they replaced, then drops them from the outbox. A failed deletion keeps
   * the entry, so the next pass pushes it again (harmless) and retries. */
  async finishSent(rows) {
    const refs = rows.map((row) => row.retireRef).filter((ref) => ref);
    if (refs.length) {
      const { remoteError } = await this.blobs.retire(refs, { remote: refs });
      for (const ref of refs) this.retiredLocally.add(ref);
      if (remoteError) throw remoteError;
    }
    await this.store.markSent(rows.map((row) => row.deviceSequence));
  }

  /** The stored envelope of a pending event. Orders start at 1 and follow
   * the in-memory record order. */
  async pendingEnvelope(row) {
    const index = this.indexById.get(row.eventId);
    const stored = index === undefined ? null : await this.store.event(index + 1);
    if (stored?.eventId !== row.eventId || stored.envelope.deviceSequence !== row.deviceSequence)
      throw new ChatLogError("This device's chat log is missing a pending message.", "chat_log_damaged");
    return stored.envelope;
  }

  /** Re-encrypts pending events, renumbered from `firstSequence` (or kept
   * when null), under the current key epoch. */
  async reseal(rows, firstSequence, { deviceSequence }) {
    const keyEpoch = await this.sendingEpoch();
    const householdKey = await this.epochKey(keyEpoch);
    const view = this.records.view();
    const entries = [];
    for (const [position, row] of rows.entries()) {
      const index = this.indexById.get(row.eventId);
      if (index === undefined) throw new ChatLogError("This device's chat log is missing a pending message.", "chat_log_damaged");
      const plaintext = view.record(index).slice();
      const metadata = this.engine.eventMetadata(plaintext);
      const envelope = await encryptEvent({
        eventId: row.eventId,
        householdId: this.identity.householdId,
        deviceId: this.identity.deviceId,
        deviceSequence: firstSequence === null ? row.deviceSequence : firstSequence + position,
        logicalTime: metadata.logicalTime.toString(),
        keyEpoch,
        plaintext,
        householdKey,
        signingKey: this.signingKey(),
      });
      plaintext.fill(0);
      entries.push({ order: index + 1, previousSequence: row.deviceSequence, envelope, blobRef: row.blobRef ?? null, retireRef: row.retireRef ?? null });
    }
    await this.store.replacePending(entries, { deviceSequence });
  }

  async pull(status, devices) {
    for (let pages = 0; pages < MAX_CHAT_PULL_PAGES; pages += 1) {
      const { cursor } = await this.store.state();
      const page = decodeEventPage(await this.request(
        `/api/chat/events?cursor=${encodeURIComponent(cursor)}&limit=${MAX_CHAT_PULL}`,
        { binary: true },
      ));
      const verified = [];
      for (const { envelope } of page.events) {
        if (this.indexById.has(envelope.eventId)) {
          verified.push(envelope);
          continue;
        }
        await this.authenticate(envelope, status, devices);
        verified.push(envelope);
      }
      this.assertOpen();
      await this.store.addReceived(verified, page.nextCursor);
      await this.refresh();
      if (!page.hasMore) return false;
      if (page.nextCursor === cursor) return false;
    }
    return true;
  }

  /** Checks a relayed chat event as household sync checks its events: from
   * a trusted device of this household, signed by it, under a key epoch it
   * may use, and carrying the same identity inside as outside. */
  async authenticate(envelope, status, devices) {
    const refuse = (message) => { throw new ChatRoomError(message, "chat_event_refused"); };
    if (envelope.householdId !== this.identity.householdId) refuse("A chat message came from another household.");
    const signer = devices.find((device) => device.deviceId === envelope.deviceId);
    if (!signer?.publicKeys) refuse("A chat message came from an unknown trusted device.");
    if (signer.revokedAt && envelope.keyEpoch >= status.currentEpoch) refuse("A revoked device cannot send chat messages in the current key epoch.");
    if (envelope.keyEpoch < (signer.historyFromEpoch ?? 1)) refuse("A chat message came from before its device's history.");
    const encodedEvent = await decryptWithDeviceHistory({ device: signer, envelope, householdKey: await this.epochKey(envelope.keyEpoch) });
    try {
      const metadata = this.engine.eventMetadata(encodedEvent);
      if (!CHAT_KINDS.has(metadata.kind) ||
          idToHex(metadata.eventId) !== envelope.eventId ||
          idToHex(metadata.householdId) !== this.identity.householdId ||
          idToHex(metadata.actorId) !== signer.memberId ||
          idToHex(metadata.deviceId) !== envelope.deviceId ||
          metadata.logicalTime.toString() !== envelope.logicalTime)
        refuse("A chat message did not match its encrypted envelope.");
    } finally {
      encodedEvent.fill(0);
    }
  }

  /** Deletes on this device the blobs the chat log says are gone (edited
   * or deleted messages), as every device does once it syncs. */
  async retireReplaced() {
    if (!this.records.length) return;
    const { retired } = this.page({ limit: 1, includeText: false, includeRetired: true });
    const fresh = retired.filter((ref) => !this.retiredLocally.has(ref));
    if (!fresh.length) return;
    await this.blobs.retire(fresh);
    for (const ref of fresh) this.retiredLocally.add(ref);
    this.notify();
  }

  /** Drops the decrypted log (on lock or stop). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.records.clear();
    this.indexById.clear();
    this.epochKeys.clear();
    this.pending.clear();
    this.listeners.clear();
    this.deviceKeys = null;
    this.store.close();
    try { this.onClose?.(); } catch { /* already closed */ }
  }
}

