// Chat content blobs (#110): the encrypted text or attachment of one chat
// message, stored by the SHA-256 of its bytes.
//
// Each message's content is sealed on the device under its own random key,
// which travels only inside the encrypted chat event. The service stores
// ciphertext, checks that it hashes to its reference, and records which
// member and device uploaded it; it never sees a key or any content.
//
// Deleting or editing a message retires its old blob. The service can't read
// events, so the author's device (or an admin's, for a removal) names the
// blobs to retire once the event is stored. Only the member who uploaded a
// blob or a household admin may retire it. A retired blob keeps a tombstone
// row without bytes: it is never served or accepted again, and a read of it
// answers "deleted" (410) rather than "missing" (404), so clients can show a
// deleted message instead of an error. Household deletion removes every
// blob and tombstone.
import { createHash } from "node:crypto";
import { PairingError, canParticipate, isHouseholdAdmin } from "./pairing-service.mjs";
import {
  MAX_CHAT_BLOB_BYTES,
  MAX_HOUSEHOLD_CHAT_BLOB_BYTES,
  MAX_HOUSEHOLD_CHAT_BLOB_ROWS,
  MIN_CHAT_BLOB_BYTES,
} from "./durable-store.mjs";

/** Most references one retire request may name. */
export const MAX_RETIRE_REFS = 64;

const isRef = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new PairingError("chat_blob_invalid", "That chat content could not be verified.", 400);

/** Storage when the service has no durable store (tests, in-memory mode). */
class MemoryChatBlobStore {
  constructor() { this.rows = new Map(); }
  key(householdId, ref) { return `${householdId}:${ref}`; }
  getChatBlob(householdId, ref) {
    const row = this.rows.get(this.key(householdId, ref));
    return row ? { ...row, ciphertext: row.ciphertext && Buffer.from(row.ciphertext) } : null;
  }
  chatBlobUsage(householdId) {
    let rows = 0, bytes = 0;
    for (const [key, row] of this.rows) {
      if (!key.startsWith(`${householdId}:`)) continue;
      rows += 1;
      if (row.retiredAt === null) bytes += row.size;
    }
    return { rows, bytes };
  }
  putChatBlob(householdId, ref, ciphertext, { memberId, deviceId, now }) {
    if (this.rows.has(this.key(householdId, ref))) return false;
    const usage = this.chatBlobUsage(householdId);
    if (usage.rows >= MAX_HOUSEHOLD_CHAT_BLOB_ROWS || usage.bytes + ciphertext.length > MAX_HOUSEHOLD_CHAT_BLOB_BYTES)
      throw new PairingError("chat_storage_full", "This household's chat storage is full.", 409);
    this.rows.set(this.key(householdId, ref), {
      ref, ciphertext: Buffer.from(ciphertext), size: ciphertext.length,
      uploaderMemberId: memberId, uploaderDeviceId: deviceId, createdAt: now, retiredAt: null,
    });
    return true;
  }
  retireChatBlobs(householdId, refs, now) {
    let count = 0;
    for (const ref of refs) {
      const row = this.rows.get(this.key(householdId, ref));
      if (row && row.retiredAt === null) {
        row.ciphertext = null;
        row.retiredAt = now;
        count += 1;
      }
    }
    return count;
  }
  forgetHousehold(householdId) {
    for (const key of [...this.rows.keys()]) if (key.startsWith(`${householdId}:`)) this.rows.delete(key);
  }
}

export class ChatBlobService {
  constructor({ pairingService, store = null, now = () => Date.now() }) {
    this.pairingService = pairingService;
    this.storage = store ?? new MemoryChatBlobStore();
    this.now = now;
  }

  /** Chat is open to every member who may take part in the household; the
   * admin's chat policy (#123) narrows this later. */
  assertCanChat(auth) {
    if (!canParticipate(auth.member, this.now()))
      throw new PairingError("chat_unavailable", "Chat isn't available to you in this household.", 403);
  }

  /** Stores a blob. Uploading the same blob again is a no-op. */
  put(auth, ref, ciphertext) {
    this.assertCanChat(auth);
    if (!isRef(ref) || !Buffer.isBuffer(ciphertext) || ciphertext.length < MIN_CHAT_BLOB_BYTES ||
      ciphertext.length > MAX_CHAT_BLOB_BYTES || createHash("sha256").update(ciphertext).digest("hex") !== ref)
      throw invalid();
    const householdId = auth.household.id;
    const existing = this.storage.getChatBlob(householdId, ref);
    if (existing?.retiredAt != null) throw deleted();
    if (existing) return { accepted: false, size: existing.size };
    const accepted = this.storage.putChatBlob(householdId, ref, ciphertext, {
      memberId: auth.member.id, deviceId: auth.device.id, now: this.now(),
    });
    // A concurrent upload of the same bytes won the race: same content.
    if (!accepted && this.storage.getChatBlob(householdId, ref)?.retiredAt != null) throw deleted();
    return { accepted, size: ciphertext.length };
  }

  /** A blob's bytes, re-checked against its reference. */
  get(auth, ref) {
    this.assertCanChat(auth);
    if (!isRef(ref)) throw invalid();
    const row = this.storage.getChatBlob(auth.household.id, ref);
    if (!row) throw new PairingError("chat_blob_missing", "This chat content isn't on the server yet.", 404);
    if (row.retiredAt != null) throw deleted();
    if (row.ciphertext.length !== row.size || createHash("sha256").update(row.ciphertext).digest("hex") !== ref)
      throw new PairingError("chat_blob_corrupt", "This chat content could not be verified.", 410);
    return row.ciphertext;
  }

  /**
   * Retires blobs: all of them or none. Each must have been uploaded by this
   * member, unless the member is a household admin (removing someone else's
   * message). Unknown and already-retired references are skipped: a blob
   * whose upload never reached the service has nothing to delete.
   */
  retire(auth, refs) {
    this.assertCanChat(auth);
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_RETIRE_REFS || !refs.every(isRef) ||
      new Set(refs).size !== refs.length)
      throw invalid();
    const householdId = auth.household.id;
    const admin = isHouseholdAdmin(auth.member, this.now());
    let othersRetired = 0;
    for (const ref of refs) {
      const row = this.storage.getChatBlob(householdId, ref);
      if (!row || row.retiredAt != null || row.uploaderMemberId === auth.member.id) continue;
      if (!admin)
        throw new PairingError("chat_blob_retire_forbidden", "Only the person who sent a message or a household admin can delete its content.", 403);
      othersRetired += 1;
    }
    const retired = this.storage.retireChatBlobs(householdId, refs, this.now());
    // Admin removals are visible to everyone in the chat; the audit records
    // that one happened, never what it was.
    if (othersRetired) {
      this.pairingService.audit("chat_content_removed_by_admin", { householdId, memberId: auth.member.id, deviceId: auth.device.id, count: othersRetired });
      this.pairingService.persistHousehold(householdId);
    }
    return { retired };
  }

  /** In-memory mode only: the durable store purges with the household. */
  forgetHousehold(householdId) {
    this.storage.forgetHousehold?.(householdId);
  }
}

function deleted() {
  return new PairingError("chat_blob_deleted", "This message was deleted.", 410);
}
