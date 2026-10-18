// Read receipts and typing indicators (#120, #121, #122).
//
// Two kinds of small, sealed messages that are not chat events:
//
// Receipt slot (#121). Each member has ONE slot on the service, replaced
// compare-and-set, never appended to the chat log, so storage stays constant
// however long the chat grows. It is an event envelope (web/sync/crypto.js):
// AES-256-GCM under the household key and signed by the writing device, so the
// service sees ciphertext only, and the other members can tell which device
// wrote it. Its sequence is the slot revision it replaces. The plaintext is
// JSON, format 1:
//
//   { "v": 1, "kind": "receipt",
//     "cursor": { "postedAt": ms, "messageId": 32 hex } | null,
//     "readAt": ms, "receipts": bool, "typing": bool, "settingsAt": ms }
//
// The cursor is "read up to this message": it only moves forward, two devices
// of one member converge on the later one, and a message counts as read by a
// member when it is at or before their cursor in (postedAt, messageId) order.
// `receipts` and `typing` are the member's two settings. They ride in the same
// slot so every device of that member sees them; the other members can see
// them too, which they would anyway (a member who sends no receipts has none
// to show). The settings that were written last win (`settingsAt`).
// With receipts off the cursor is null: the member's progress is cleared, not
// merely hidden.
//
// Typing frame (#122). Ephemeral: sent over the live channel only, sealed the
// same way (kind "typing", `on` true or false), relayed by the service to the
// household's other chat-allowed devices and never stored by it or by a
// device. A receiver shows it for TYPING_EXPIRE_MS unless refreshed.
import { decryptWithDeviceHistory, encryptEvent } from "../sync/crypto.js";

export const SLOT_VERSION = 1;
export const RECEIPT_WRITE_MS = 2_000;
export const RECEIPT_REFRESH_MS = 15_000;
export const TYPING_SEND_MS = 3_000;
export const TYPING_EXPIRE_MS = 6_000;
/** The service refuses a slot over this (server/durable-store/shared.mjs). */
export const MAX_SLOT_BYTES = 4_096;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MESSAGE_ID = /^[a-f0-9]{32}$/;

export class ChatPresenceError extends Error {
  constructor(message, code = "chat_presence_invalid") {
    super(message);
    this.name = "ChatPresenceError";
    this.code = code;
  }
}

/* ---------- Cursors: pure ---------- */

export function isCursor(value) {
  return Boolean(value) && typeof value === "object" && Number.isSafeInteger(value.postedAt) && value.postedAt >= 0 && MESSAGE_ID.test(value.messageId);
}

/** The cursor that means "read up to and including this message". */
export function cursorOf(message) {
  return { postedAt: message.postedAt, messageId: message.messageId };
}

/** Negative, zero or positive: a before, equal to or after b. A missing
 * cursor is before every message. */
export function compareCursors(a, b) {
  if (!a || !b) return (a ? 1 : 0) - (b ? 1 : 0);
  if (a.postedAt !== b.postedAt) return a.postedAt < b.postedAt ? -1 : 1;
  return a.messageId === b.messageId ? 0 : a.messageId < b.messageId ? -1 : 1;
}

/** The later of two cursors: how two devices of one member converge. Cursors
 * only move forward, so applying it in any order gives the same result. */
export function mergeCursors(a, b) {
  return compareCursors(a, b) >= 0 ? (a ?? null) : b;
}

/** Whether a member whose cursor is `cursor` has read `message`. A deleted
 * message still has a place in the order, so it counts toward the cursor. */
export function hasRead(cursor, message) {
  return Boolean(cursor) && compareCursors(cursorOf(message), cursor) <= 0;
}

/**
 * Who has read `message`: the members other than its author whose cursor is at
 * or past it, earliest first. `slots` is a Map of memberId → { cursor, readAt }.
 * Computed on demand for a message shown, never stored per message.
 */
export function readersOf(message, slots) {
  const readers = [];
  for (const [memberId, slot] of slots)
    if (memberId !== message.authorId && hasRead(slot.cursor, message)) readers.push({ memberId, readAt: slot.readAt });
  return readers.sort((a, b) => a.readAt - b.readAt || (a.memberId < b.memberId ? -1 : 1));
}

/** "Seen by Sam, Alex", or "Seen by everyone" when all of `audience` did. */
export function seenText(readerLabels, everyone) {
  if (!readerLabels.length) return "";
  return everyone ? "Seen by everyone" : `Seen by ${readerLabels.join(", ")}`;
}

/** "Sam is typing…", "Sam and Alex are typing…", "Sam, Alex and Jo are typing…". */
export function typingText(labels) {
  if (!labels.length) return "";
  if (labels.length === 1) return `${labels[0]} is typing…`;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]} are typing…`;
  if (labels.length === 3) return `${labels[0]}, ${labels[1]} and ${labels[2]} are typing…`;
  return "Several people are typing…";
}

/* ---------- Sealing ---------- */

const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function seal({ body, householdId, deviceId, sequence, keyEpoch, householdKey, signingKey, now }) {
  const plaintext = encoder.encode(JSON.stringify(body));
  try {
    return await encryptEvent({
      eventId: randomId(), householdId, deviceId, deviceSequence: sequence, logicalTime: String(Math.max(0, Math.trunc(now))),
      keyEpoch, plaintext, householdKey, signingKey,
    });
  } finally {
    plaintext.fill(0);
  }
}

async function open({ envelope, device, householdKey, householdId, kind }) {
  if (!envelope || typeof envelope !== "object" || envelope.householdId !== householdId || envelope.deviceId !== device?.deviceId)
    throw new ChatPresenceError("A chat update came from the wrong place.");
  if (device.revokedAt || envelope.keyEpoch < (device.historyFromEpoch ?? 1))
    throw new ChatPresenceError("A chat update came from a device that can't send one.");
  const plain = await decryptWithDeviceHistory({ device, envelope, householdKey });
  try {
    const value = JSON.parse(decoder.decode(plain));
    if (!value || typeof value !== "object" || value.v !== SLOT_VERSION || value.kind !== kind) throw new Error("shape");
    return value;
  } catch {
    throw new ChatPresenceError("A chat update couldn't be read.");
  } finally {
    plain.fill(0);
  }
}

/* ---------- Typing: who is typing now ---------- */

/** Tracks who is typing for a few seconds at a time. Nothing is kept past that. */
export class TypingTracker {
  constructor({ now = () => Date.now(), expireMs = TYPING_EXPIRE_MS } = {}) {
    this.now = now;
    this.expireMs = expireMs;
    this.until = new Map();
  }

  set(memberId, on) {
    if (on) this.until.set(memberId, this.now() + this.expireMs);
    else this.until.delete(memberId);
  }

  /** Members still typing; drops the ones whose time ran out. */
  active() {
    const now = this.now();
    for (const [memberId, until] of this.until) if (until <= now) this.until.delete(memberId);
    return [...this.until.keys()].sort();
  }

  /** Milliseconds until the next indicator expires, or null. */
  nextExpiry() {
    if (!this.until.size) return null;
    return Math.max(1, Math.min(...this.until.values()) - this.now());
  }

  clear() {
    this.until.clear();
  }
}

/* ---------- The room's presence ---------- */

/**
 * One device's presence: its own cursor and settings, everyone's slots, and
 * who is typing. The chat room supplies the household key, signing key,
 * device directory and requests; the coordinator supplies the live channel.
 *
 * `env` : { identity, request(path, options), epochKey(epoch), sendingEpoch(),
 *           signingKey(), devices() -> verified directory, sendLive(bytes) -> bool,
 *           store: { presence(), savePresence(value) }, now, setTimer, clearTimer,
 *           onChange() }
 */
export class ChatPresence {
  constructor(env) {
    this.env = env;
    this.now = env.now ?? (() => Date.now());
    this.setTimer = env.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = env.clearTimer ?? ((timer) => clearTimeout(timer));
    this.settings = { receipts: true, typing: true, settingsAt: 0 };
    this.cursor = null;
    this.readAt = 0;
    this.revision = 0;
    this.dirty = false;
    this.slots = new Map();
    this.typers = new TypingTracker({ now: this.now });
    this.watermarks = new Map();
    this.lastTypingSent = 0;
    this.typingOn = false;
    this.typingSequence = 0;
    this.typingChain = Promise.resolve();
    this.writeTimer = null;
    this.expiryTimer = null;
    this.lastWrite = 0;
    this.lastRefresh = 0;
    this.hinted = false;
    this.writing = null;
    this.closed = false;
  }

  /** Restores this device's cursor, settings and slot revision. */
  async load() {
    const saved = (await this.env.store.presence()) ?? {};
    if (typeof saved.receipts === "boolean") this.settings.receipts = saved.receipts;
    if (typeof saved.typing === "boolean") this.settings.typing = saved.typing;
    if (Number.isSafeInteger(saved.settingsAt)) this.settings.settingsAt = saved.settingsAt;
    if (isCursor(saved.cursor) && this.settings.receipts) this.cursor = saved.cursor;
    if (Number.isSafeInteger(saved.readAt)) this.readAt = saved.readAt;
    if (Number.isSafeInteger(saved.revision) && saved.revision >= 0) this.revision = saved.revision;
    this.dirty = saved.dirty === true;
  }

  async persist() {
    try {
      await this.env.store.savePresence({
        receipts: this.settings.receipts, typing: this.settings.typing, settingsAt: this.settings.settingsAt,
        cursor: this.cursor, readAt: this.readAt, revision: this.revision, dirty: this.dirty,
      });
    } catch { /* kept in memory; the next change saves it */ }
  }

  get sendsReceipts() { return this.settings.receipts; }
  get sendsTyping() { return this.settings.typing; }

  /** Reciprocity: someone who sends no receipts sees no one else's. */
  get showsReceipts() { return this.settings.receipts; }

  /* --- read cursor --- */

  /** A message was on screen in a visible, focused window: the cursor moves up
   * to it if that is later than where it was. Writes are throttled. */
  markRead(message) {
    if (this.closed || !this.settings.receipts || !message) return false;
    const cursor = cursorOf(message);
    if (!isCursor(cursor) || compareCursors(cursor, this.cursor) <= 0) return false;
    this.cursor = cursor;
    this.readAt = this.now();
    this.dirty = true;
    void this.persist();
    this.scheduleWrite();
    this.env.onChange?.();
    return true;
  }

  /** Who has read `message`, from the slots held: empty when this member
   * sends no receipts, or for a message's author alone. */
  readers(message) {
    if (!this.showsReceipts || !message) return [];
    return readersOf(message, this.slots);
  }

  scheduleWrite() {
    if (this.closed || this.writeTimer !== null) return;
    const wait = Math.max(0, this.lastWrite + RECEIPT_WRITE_MS - this.now());
    this.writeTimer = this.setTimer(() => {
      this.writeTimer = null;
      void this.flush().catch(() => {});
    }, wait);
  }

  /** The slot's plaintext for this member now. */
  body() {
    return {
      v: SLOT_VERSION, kind: "receipt", cursor: this.settings.receipts ? this.cursor : null, readAt: this.readAt,
      receipts: this.settings.receipts, typing: this.settings.typing, settingsAt: this.settings.settingsAt,
    };
  }

  /** Writes the slot if anything changed, compare-and-set on its revision;
   * another device having written meanwhile is merged and tried once more. */
  async flush({ retried = false } = {}) {
    if (this.closed || !this.dirty) return;
    if (this.writing) return this.writing;
    this.writing = this.write({ retried }).finally(() => { this.writing = null; });
    return this.writing;
  }

  async write({ retried }) {
    const { identity } = this.env;
    const me = this.env.devices().find((device) => device.deviceId === identity.deviceId);
    if (!me) return;
    const epoch = await this.env.sendingEpoch();
    const householdKey = await this.env.epochKey(epoch);
    const record = await seal({
      body: this.body(), householdId: identity.householdId, deviceId: identity.deviceId, sequence: this.revision + 1,
      keyEpoch: epoch, householdKey, signingKey: this.env.signingKey(), now: this.now(),
    });
    try {
      const result = await this.env.request("/api/chat/receipts", { method: "PUT", body: JSON.stringify({ expectedRevision: this.revision, record }) });
      this.revision = result.revision;
      this.dirty = false;
      this.lastWrite = this.now();
      await this.persist();
    } catch (error) {
      if (error?.code === "chat_receipts_stale" && !retried) {
        await this.refresh();
        return this.write({ retried: true });
      }
      if (error?.code === "chat_receipts_rate_limited") this.lastWrite = this.now() + RECEIPT_WRITE_MS * 4;
      throw error;
    }
  }

  /** Reads everyone's slots; merges this member's own (settings that were
   * written last win; the cursor is the later of the two). */
  async refresh() {
    if (this.closed) return false;
    this.lastRefresh = this.now();
    this.hinted = false;
    const { identity } = this.env;
    const response = await this.env.request("/api/chat/receipts");
    if (!Array.isArray(response?.slots)) throw new ChatPresenceError("Chat received invalid read receipts.");
    const devices = this.env.devices();
    const next = new Map();
    let changed = false;
    for (const row of response.slots) {
      if (!row || typeof row.memberId !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 1) continue;
      const device = devices.find((entry) => entry.deviceId === row.record?.deviceId);
      // A slot signed by a device that isn't that member's is not theirs.
      if (!device || device.memberId !== row.memberId) continue;
      let value;
      try {
        value = await open({
          envelope: row.record, device, householdKey: await this.env.epochKey(row.record.keyEpoch),
          householdId: identity.householdId, kind: "receipt",
        });
        if (row.record.deviceSequence !== row.revision) continue;
      } catch (error) {
        if (error?.code === "chat_locked") throw error;
        continue;
      }
      const cursor = isCursor(value.cursor) ? value.cursor : null;
      const slot = {
        revision: row.revision, cursor: value.receipts === false ? null : cursor,
        readAt: Number.isSafeInteger(value.readAt) ? value.readAt : 0,
        receipts: value.receipts !== false, typing: value.typing !== false,
        settingsAt: Number.isSafeInteger(value.settingsAt) ? value.settingsAt : 0,
      };
      if (row.memberId === identity.memberId) {
        changed = this.mergeOwn(slot) || changed;
      } else {
        const before = this.slots.get(row.memberId);
        // Never trust an older slot than one already seen.
        if (before && before.revision > slot.revision) { next.set(row.memberId, before); continue; }
        if (!before || compareCursors(before.cursor, slot.cursor) !== 0 || before.readAt !== slot.readAt) changed = true;
        next.set(row.memberId, slot);
      }
    }
    if (next.size !== this.slots.size) changed = true;
    this.slots = next;
    if (changed) this.env.onChange?.();
    if (this.dirty) this.scheduleWrite();
    return changed;
  }

  /** Merges the member's own slot, as written by one of their devices. */
  mergeOwn(slot) {
    let changed = false;
    this.revision = Math.max(this.revision, slot.revision);
    if (slot.settingsAt > this.settings.settingsAt) {
      this.settings = { receipts: slot.receipts, typing: slot.typing, settingsAt: slot.settingsAt };
      if (!slot.receipts) { this.cursor = null; this.readAt = 0; }
      changed = true;
    }
    if (this.settings.receipts) {
      const merged = mergeCursors(this.cursor, slot.cursor);
      if (compareCursors(merged, this.cursor) !== 0) {
        this.cursor = merged;
        this.readAt = Math.max(this.readAt, slot.readAt);
        changed = true;
      }
      // This device is ahead of (or differs from) the stored slot.
      if (compareCursors(this.cursor, slot.cursor) !== 0) this.dirty = true;
    }
    if (slot.settingsAt < this.settings.settingsAt) this.dirty = true;
    if (changed) void this.persist();
    return changed;
  }

  /** The chat pass: refresh now and then, write what is waiting. */
  async sync() {
    if (this.closed) return;
    if (this.hinted || this.now() - this.lastRefresh >= RECEIPT_REFRESH_MS) await this.refresh();
    if (this.dirty && this.writeTimer === null) await this.flush();
  }

  /** The service says a slot changed (live channel): refresh soon. */
  hint() {
    if (this.closed) return;
    this.hinted = true;
    void this.sync().catch(() => {});
  }

  /* --- settings --- */

  /** Turns sending receipts and typing on or off, on all this member's
   * devices. Off clears the stored cursor; typing off stops the indicator now. */
  async setSettings({ receipts = this.settings.receipts, typing = this.settings.typing }) {
    const now = this.now();
    const wasReceipts = this.settings.receipts;
    this.settings = { receipts: Boolean(receipts), typing: Boolean(typing), settingsAt: Math.max(now, this.settings.settingsAt + 1) };
    if (!this.settings.receipts) { this.cursor = null; this.readAt = 0; }
    else if (!wasReceipts) this.readAt = now;
    if (!this.settings.typing) this.stopTyping();
    this.dirty = true;
    await this.persist();
    this.env.onChange?.();
    try { await this.flush(); } catch { this.scheduleWrite(); }
  }

  /* --- typing --- */

  /** The composer has new input: tell the others, at most every 3 seconds. */
  typed() {
    if (this.closed || !this.settings.typing) return;
    if (this.typingOn && this.now() - this.lastTypingSent < TYPING_SEND_MS) return;
    void this.sendTyping(true);
  }

  /** The composer was sent, cleared, left, or the window hid or locked. */
  stopTyping() {
    if (!this.typingOn) return;
    void this.sendTyping(false);
  }

  sendTyping(on) {
    this.typingOn = on;
    this.lastTypingSent = this.now();
    const run = this.typingChain.then(async () => {
      const { identity } = this.env;
      const epoch = await this.env.sendingEpoch();
      const householdKey = await this.env.epochKey(epoch);
      // Strictly increasing across sessions, so a receiver can drop a replay.
      this.typingSequence = Math.max(this.now(), this.typingSequence + 1);
      const envelope = await seal({
        body: { v: SLOT_VERSION, kind: "typing", on }, householdId: identity.householdId, deviceId: identity.deviceId,
        sequence: this.typingSequence, keyEpoch: epoch, householdKey, signingKey: this.env.signingKey(), now: this.now(),
      });
      const sent = this.env.sendLive(encoder.encode(JSON.stringify(envelope)));
      // Not connected: nothing was sent, so nothing needs a "stopped".
      if (!sent) this.typingOn = false;
    });
    this.typingChain = run.catch(() => {});
    return run.catch(() => { this.typingOn = false; });
  }

  /** A typing frame relayed by the service. Unreadable, unsigned, replayed or
   * own frames are ignored; the rest show for TYPING_EXPIRE_MS. */
  async receiveTyping(bytes) {
    if (this.closed) return false;
    let envelope;
    try {
      envelope = JSON.parse(decoder.decode(bytes));
    } catch {
      return false;
    }
    const { identity } = this.env;
    const device = this.env.devices().find((entry) => entry.deviceId === envelope?.deviceId);
    if (!device || device.memberId === identity.memberId) return false;
    if ((this.watermarks.get(device.deviceId) ?? 0) >= envelope.deviceSequence) return false;
    let value;
    try {
      value = await open({ envelope, device, householdKey: await this.env.epochKey(envelope.keyEpoch), householdId: identity.householdId, kind: "typing" });
    } catch {
      return false;
    }
    if (this.closed || typeof value.on !== "boolean") return false;
    this.watermarks.set(device.deviceId, envelope.deviceSequence);
    this.typers.set(device.memberId, value.on);
    this.armExpiry();
    this.env.onChange?.();
    return true;
  }

  armExpiry() {
    this.clearTimer(this.expiryTimer);
    this.expiryTimer = null;
    const wait = this.typers.nextExpiry();
    if (wait === null || this.closed) return;
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = null;
      this.typers.active();
      this.armExpiry();
      this.env.onChange?.();
    }, wait);
  }

  /** Members typing now, other than this one. */
  typing() {
    return this.typers.active().filter((memberId) => memberId !== this.env.identity.memberId);
  }

  /** The live channel went down: nobody's "stopped" will arrive, so their
   * indicators run out on their own within the expiry time. */

  close() {
    if (this.closed) return;
    // Best effort while the keys are still here: tell the others we stopped.
    if (this.typingOn) void this.sendTyping(false);
    this.closed = true;
    this.clearTimer(this.writeTimer);
    this.clearTimer(this.expiryTimer);
    this.writeTimer = this.expiryTimer = null;
    this.typers.clear();
    this.slots = new Map();
    this.watermarks.clear();
    this.cursor = null;
  }
}
