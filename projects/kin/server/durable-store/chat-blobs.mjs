// DurableStore chat content blobs (#110): encrypted message content by
// content hash, with tombstones for retired blobs. Callers have already
// authorized the device and checked the bytes against the reference.
import { DurableConflictError, MAX_HOUSEHOLD_CHAT_BLOB_BYTES, MAX_HOUSEHOLD_CHAT_BLOB_ROWS } from "./shared.mjs";

const blob = (row) => row ? {
  ref: row.blob_ref,
  ciphertext: row.ciphertext === null ? null : Buffer.from(row.ciphertext),
  size: row.size_bytes,
  uploaderMemberId: row.uploader_member_id,
  uploaderDeviceId: row.uploader_device_id,
  createdAt: row.created_at,
  retiredAt: row.retired_at,
} : null;

export const chatBlobMethods = {
  getChatBlob(householdId, ref) {
    this.assertAvailable();
    return blob(this.db.prepare("SELECT * FROM chat_blobs WHERE household_id = ? AND blob_ref = ?").get(householdId, ref));
  },

  /** Stores a new blob within the household's quota. Returns false when the
   * same reference is already stored (live or retired); the caller has
   * looked it up first, so that only happens in a race. */
  putChatBlob(householdId, ref, ciphertext, { memberId, deviceId, now }) {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM chat_blobs WHERE household_id = ? AND blob_ref = ?").get(householdId, ref)) return false;
      const usage = this.chatBlobUsage(householdId);
      if (usage.rows >= MAX_HOUSEHOLD_CHAT_BLOB_ROWS || usage.bytes + ciphertext.length > MAX_HOUSEHOLD_CHAT_BLOB_BYTES)
        throw new DurableConflictError("chat_storage_full", "This household's chat storage is full.");
      this.db.prepare(`INSERT INTO chat_blobs
        (household_id, blob_ref, ciphertext, size_bytes, uploader_member_id, uploader_device_id, created_at, retired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(householdId, ref, ciphertext, ciphertext.length, memberId, deviceId, now);
      return true;
    });
  },

  /** Drops a blob's bytes and keeps its row as a tombstone. */
  retireChatBlobs(householdId, refs, now) {
    return this.transaction(() => {
      const retire = this.db.prepare("UPDATE chat_blobs SET ciphertext = NULL, retired_at = ? WHERE household_id = ? AND blob_ref = ? AND retired_at IS NULL");
      return refs.reduce((count, ref) => count + retire.run(now, householdId, ref).changes, 0);
    });
  },

  /** Live bytes and all rows (live and retired). */
  chatBlobUsage(householdId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS rows,
      COALESCE(SUM(CASE WHEN retired_at IS NULL THEN size_bytes ELSE 0 END), 0) AS bytes
      FROM chat_blobs WHERE household_id = ?`).get(householdId);
    return { rows: row.rows, bytes: row.bytes };
  },
};
