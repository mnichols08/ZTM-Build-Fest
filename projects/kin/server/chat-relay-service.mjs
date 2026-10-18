// The chat relay (#111): encrypted chat events, kept apart from the
// household event relay.
//
// Chat events are canonical events like any other and travel in the same
// signed, encrypted envelopes (web/sync/crypto.js), but in their own stream:
// their own relay sequence and cursor, their own per-device sequence, their
// own logical clock bound and their own quota. So chat never counts against
// the household's event limits, and the service can tell chat traffic apart
// to enforce who may chat (#123) without reading anything: like every
// envelope, a chat envelope is opaque ciphertext to the service.
//
// Rules match the household relay: an envelope must come from the
// authenticated device of this household under a key epoch it holds; each
// device's chat sequence has no gaps; a repeated event ID is accepted only
// with identical bytes; a page only shows events from epochs the reading
// device may read. Pushes wait out a household key rotation.
import { PairingError, canParticipate } from "./pairing-service.mjs";
import { canonicalEventEnvelope, MAX_LOGICAL_TIME_ADVANCE } from "./sync-contract.mjs";
import { decodeCursor, encodeCursor, MAX_EVENTS_PER_BATCH, validateEventEnvelope } from "./sync-service.mjs";
import { DurableConflictError, MAX_CHAT_HIDDEN_RECORD_BYTES, MAX_CHAT_RECEIPT_BYTES, MAX_HOUSEHOLD_CHAT_EVENTS } from "./durable-store.mjs";
import { isSyncId } from "./sync-contract.mjs";

/** A device may replace its member's receipt slot this often at most: the
 * client sends one write per 2 seconds, so this leaves room for a busy minute
 * and stops a loop. */
export const RECEIPT_WRITES_PER_MINUTE = 40;
const RECEIPT_WINDOW_MS = 60_000;

const MAX_REQUEST_BYTES = 200_000;
/** Most chat events one pull returns. Chat is far busier than household
 * events, so its pages are larger than the household relay's (at most
 * about 1.6 MB of envelopes). */
export const MAX_CHAT_PULL = 200;

/** Storage when the service has no durable store (tests, in-memory mode),
 * with the same decisions as durable-store/chat-events.mjs. */
class MemoryChatRelayStore {
  constructor() { this.households = new Map(); }
  state(householdId) {
    if (!this.households.has(householdId))
      this.households.set(householdId, { records: [], byEventId: new Map(), deviceSequence: new Map(), maxLogicalTime: "0" });
    return this.households.get(householdId);
  }
  chatRelayState(householdId) {
    const state = this.state(householdId);
    return { nextSequence: state.records.length + 1, eventCount: state.records.length, maxLogicalTime: state.maxLogicalTime };
  }
  chatDeviceSequence(householdId, deviceId) { return this.state(householdId).deviceSequence.get(deviceId) ?? 0; }
  findChatEvent(householdId, eventId) { return this.state(householdId).byEventId.get(eventId) ?? null; }
  commitChatEvents(householdId, { expectedNextSequence, deviceId, expectedDeviceSequence, entries, maxLogicalTime }) {
    const state = this.state(householdId);
    if (state.records.length + 1 !== expectedNextSequence || (state.deviceSequence.get(deviceId) ?? 0) !== expectedDeviceSequence)
      throw new DurableConflictError("chat_relay_conflict", "Chat changed meanwhile; retry.");
    for (const entry of entries) {
      const record = { sequence: state.records.length + 1, canonical: entry.canonical, envelope: structuredClone(entry.envelope) };
      state.records.push(record);
      state.byEventId.set(entry.envelope.eventId, record);
    }
    if (entries.length) state.deviceSequence.set(deviceId, entries.at(-1).envelope.deviceSequence);
    state.maxLogicalTime = maxLogicalTime;
  }
  readChatEvents(householdId, cursor, limit, minimumEpoch) {
    const state = this.state(householdId);
    const scanned = state.records.slice(cursor, cursor + limit);
    const lastScanned = scanned.at(-1)?.sequence ?? cursor;
    return {
      events: scanned
        .filter((record) => record.envelope.keyEpoch >= minimumEpoch)
        .map((record) => ({ cursor: encodeCursor(record.sequence), envelope: structuredClone(record.envelope) })),
      nextCursor: encodeCursor(lastScanned),
      hasMore: lastScanned < state.records.length,
    };
  }
  chatHiddenRecord(householdId, memberId) {
    const row = this.state(householdId).hidden?.get(memberId);
    return row ? structuredClone(row) : null;
  }
  putChatHiddenRecord(householdId, memberId, { expectedRevision, record }) {
    const state = this.state(householdId);
    state.hidden ??= new Map();
    if ((state.hidden.get(memberId)?.revision ?? 0) !== expectedRevision)
      throw new DurableConflictError("chat_hidden_stale", "Changed on another device meanwhile.");
    state.hidden.set(memberId, { revision: expectedRevision + 1, record: structuredClone(record) });
    return expectedRevision + 1;
  }
  chatReceiptSlots(householdId) {
    return [...(this.state(householdId).receipts ?? new Map())].map(([memberId, row]) => ({ memberId, ...structuredClone(row) }))
      .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  }
  putChatReceiptSlot(householdId, memberId, { expectedRevision, record }) {
    const state = this.state(householdId);
    state.receipts ??= new Map();
    if ((state.receipts.get(memberId)?.revision ?? 0) !== expectedRevision)
      throw new DurableConflictError("chat_receipts_stale", "Changed on another device meanwhile.");
    state.receipts.set(memberId, { revision: expectedRevision + 1, record: structuredClone(record) });
    return expectedRevision + 1;
  }
  forgetHousehold(householdId) { this.households.delete(householdId); }
}

/** A sealed "delete for me" record's routing fields, which the service can
 * check without reading it (web/chat/chat-hidden.js has the format). */
export function isHiddenRecordValid(record, { householdId, memberId, deviceId, revision }) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_CHAT_HIDDEN_RECORD_BYTES) return false;
  return record.version === 1 && record.householdId === householdId && record.memberId === memberId &&
    record.senderDeviceId === deviceId && record.revision === revision &&
    typeof record.ciphertext === "string" && typeof record.nonce === "string" && typeof record.signature === "string" &&
    Array.isArray(record.recipients) && record.recipients.length >= 1 && record.recipients.length <= 64 &&
    record.recipients.every((entry) => entry && isSyncId(entry.deviceId) && typeof entry.wrappedKey === "string");
}

/** A read-receipt slot is a household-key envelope (web/chat/chat-presence.js)
 * sent by one of the member's own devices; its sequence is the slot revision
 * it replaces, so a stale writer is refused before anything is stored. */
export function isReceiptSlotValid(record, auth, currentEpoch, revision) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_CHAT_RECEIPT_BYTES) return false;
  try {
    validateEventEnvelope(record, auth, currentEpoch);
  } catch {
    return false;
  }
  return record.deviceSequence === revision;
}

export class ChatRelayService {
  constructor({ syncService, store = null }) {
    this.syncService = syncService;
    this.storage = store ?? new MemoryChatRelayStore();
    /** deviceId → recent receipt-write times, for the per-device limit. */
    this.receiptWrites = new Map();
  }

  /** Chat is open to every member who may take part in the household; the
   * admin's chat policy (#123) narrows this later. */
  assertCanChat(auth) {
    if (!canParticipate(auth.member, this.syncService.now()))
      throw new PairingError("chat_unavailable", "Chat isn't available to you in this household.", 403);
  }

  push(auth, envelopes) {
    this.assertCanChat(auth);
    const sync = this.syncService.state(auth.household.id);
    if (!sync.enabled)
      throw new PairingError("chat_sync_unavailable", "Chat is unavailable until household sync is set up.", 409);
    if (sync.rotationPending)
      throw new PairingError("sync_rotation_pending", "Chat is paused until key access is updated.", 409);
    if (!Array.isArray(envelopes) || envelopes.length < 1 || envelopes.length > MAX_EVENTS_PER_BATCH)
      throw new PairingError("sync_batch_invalid", "That chat batch is invalid.", 400);
    const householdId = auth.household.id;
    const relay = this.storage.chatRelayState(householdId);
    const expectedDeviceSequence = this.storage.chatDeviceSequence(householdId, auth.device.id);
    let deviceSequence = expectedDeviceSequence;
    let maxLogicalTime = BigInt(relay.maxLogicalTime);
    let requestBytes = 0;
    const staged = [], seen = new Map();
    for (const envelope of envelopes) {
      validateEventEnvelope(envelope, auth, sync.currentEpoch);
      const canonical = canonicalEventEnvelope(envelope);
      requestBytes += Buffer.byteLength(canonical);
      if (requestBytes > MAX_REQUEST_BYTES)
        throw new PairingError("sync_batch_too_large", "That chat batch is too large.", 413);
      const existing = this.storage.findChatEvent(householdId, envelope.eventId) ?? seen.get(envelope.eventId);
      if (existing) {
        if (existing.canonical !== canonical)
          throw new PairingError("event_duplicate_conflict", "A chat event conflicts with one already received.", 409);
        continue;
      }
      const logicalTime = BigInt(envelope.logicalTime);
      if (logicalTime - maxLogicalTime > MAX_LOGICAL_TIME_ADVANCE)
        throw new PairingError("logical_time_invalid", "That chat message is outside Kin's supported event-order range.", 400);
      if (logicalTime > maxLogicalTime) maxLogicalTime = logicalTime;
      if (envelope.deviceSequence !== deviceSequence + 1)
        throw new PairingError("sync_sequence_gap", "This device must send its earlier chat messages first.", 409);
      if (relay.eventCount + staged.length >= MAX_HOUSEHOLD_CHAT_EVENTS)
        throw new PairingError("chat_limit", "This household's chat is full.", 413);
      deviceSequence = envelope.deviceSequence;
      const entry = { canonical, envelope };
      staged.push(entry);
      seen.set(envelope.eventId, entry);
    }
    if (staged.length) {
      try {
        this.storage.commitChatEvents(householdId, {
          expectedNextSequence: relay.nextSequence, deviceId: auth.device.id, expectedDeviceSequence,
          entries: staged, maxLogicalTime: maxLogicalTime.toString(),
        });
      } catch (error) {
        if (error instanceof DurableConflictError)
          throw new PairingError("chat_relay_conflict", "Chat changed meanwhile; retry.", 409);
        throw error;
      }
      // After the commit, in the background: the household's other devices
      // hear about it at once (#107) and members get a push (#85).
      try { this.syncService.pushService?.eventsAccepted(householdId, auth.member.id); } catch { /* best effort */ }
      try { this.syncService.liveService?.eventsAccepted(householdId, auth.device.id); } catch { /* best effort */ }
    }
    const after = this.storage.chatRelayState(householdId);
    return { accepted: envelopes.length, latestCursor: encodeCursor(after.nextSequence - 1) };
  }

  /** Where this device stands in the chat relay: its last chat sequence
   * (so a device whose local chat log was lost can continue without a
   * gap) and the relay's latest cursor. */
  status(auth) {
    this.assertCanChat(auth);
    const householdId = auth.household.id;
    return {
      deviceSequence: this.storage.chatDeviceSequence(householdId, auth.device.id),
      latestCursor: encodeCursor(this.storage.chatRelayState(householdId).nextSequence - 1),
    };
  }

  pull(auth, cursorValue = "", limitValue = String(MAX_CHAT_PULL)) {
    this.assertCanChat(auth);
    const householdId = auth.household.id;
    const cursor = decodeCursor(cursorValue);
    const limit = Number(limitValue);
    const relay = this.storage.chatRelayState(householdId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHAT_PULL || cursor > relay.nextSequence - 1)
      throw new PairingError("sync_cursor_invalid", "Kin could not continue from that chat position.", 400);
    return this.storage.readChatEvents(householdId, cursor, limit, auth.device.syncHistoryFromEpoch ?? 1);
  }

  /**
   * This member's sealed "delete for me" record (#119), or a revision of 0
   * when there is none. Only the member's own devices can open it.
   */
  hidden(auth, since = null) {
    this.assertCanChat(auth);
    const row = this.storage.chatHiddenRecord(auth.household.id, auth.member.id);
    const revision = row?.revision ?? 0;
    // A device that already has this revision gets just the revision.
    if (since !== null && String(revision) === String(since)) return { revision, unchanged: true };
    return { revision, record: row?.record ?? null };
  }

  /** Replaces the record compare-and-set: `expectedRevision` must be the
   * stored one (409 with the current otherwise), the record names the next. */
  putHidden(auth, body) {
    this.assertCanChat(auth);
    const expectedRevision = body?.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !isHiddenRecordValid(body.record, { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id, revision: expectedRevision + 1 }))
      throw new PairingError("chat_hidden_invalid", "That chat change is invalid.", 400);
    try {
      return { revision: this.storage.putChatHiddenRecord(auth.household.id, auth.member.id, { expectedRevision, record: body.record }) };
    } catch (error) {
      if (!(error instanceof DurableConflictError)) throw error;
      throw new PairingError("chat_hidden_stale", "Changed on another device meanwhile; try again.", 409);
    }
  }

  /**
   * Every member's sealed read-receipt slot (#121), latest only. The service
   * can't read them and doesn't know who has chat receipts turned off.
   */
  receipts(auth) {
    this.assertCanChat(auth);
    return { slots: this.storage.chatReceiptSlots(auth.household.id) };
  }

  /** Replaces this member's slot compare-and-set, from one of their own
   * devices, at a bounded rate. */
  putReceipt(auth, body) {
    this.assertCanChat(auth);
    const expectedRevision = body?.expectedRevision;
    const sync = this.syncService.state(auth.household.id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !isReceiptSlotValid(body.record, auth, sync.currentEpoch, expectedRevision + 1))
      throw new PairingError("chat_receipts_invalid", "That chat change is invalid.", 400);
    const now = this.syncService.now();
    const recent = (this.receiptWrites.get(auth.device.id) ?? []).filter((time) => time > now - RECEIPT_WINDOW_MS);
    if (recent.length >= RECEIPT_WRITES_PER_MINUTE) {
      this.receiptWrites.set(auth.device.id, recent);
      throw new PairingError("chat_receipts_rate_limited", "Too many chat updates. Wait a moment.", 429);
    }
    recent.push(now);
    this.receiptWrites.set(auth.device.id, recent);
    let revision;
    try {
      revision = this.storage.putChatReceiptSlot(auth.household.id, auth.member.id, { expectedRevision, record: body.record });
    } catch (error) {
      if (!(error instanceof DurableConflictError)) throw error;
      throw new PairingError("chat_receipts_stale", "Changed on another device meanwhile; try again.", 409);
    }
    try { this.syncService.liveService?.receiptsChanged(auth.household.id, auth.device.id); } catch { /* best effort */ }
    return { revision };
  }

  /** In-memory mode only: the durable store purges with the household. */
  forgetHousehold(householdId) {
    this.storage.forgetHousehold?.(householdId);
  }
}
