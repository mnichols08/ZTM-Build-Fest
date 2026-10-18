// Durable store constants, errors and small helpers shared by its modules.
import { statSync } from "node:fs";
import { resolve } from "node:path";

export const SERVER_SCHEMA_VERSION = 13;

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024 + 4096;

export const MAX_HOUSEHOLD_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export const MAX_HOUSEHOLD_ATTACHMENTS = 64;

// Chat content blobs (#110): one message's encrypted text or attachment,
// addressed by the SHA-256 of its bytes. Format 1 is a version byte, a
// 12-byte AES-GCM nonce and the sealed content with its 16-byte tag.
export const MIN_CHAT_BLOB_BYTES = 29;
export const MAX_CHAT_BLOB_BYTES = 4 * 1024 * 1024 + 4096;
// Per household: live blob bytes and live blobs, which uploads must fit in;
// and retired tombstones and pre-upload claims, which never block anything:
// past their bound the oldest go. #125 revisits all four with measured chat
// volume.
export const MAX_HOUSEHOLD_CHAT_BLOB_BYTES = 256 * 1024 * 1024;
export const MAX_HOUSEHOLD_CHAT_BLOBS = 250_000;
export const MAX_HOUSEHOLD_CHAT_TOMBSTONES = 500_000;
// Claims are bounded per member, and pruning only ever drops the claiming
// member's own oldest claims, so nobody's flood pushes out another
// member's (or an admin's) claim.
export const MAX_MEMBER_CHAT_CLAIMS = 20_000;

// The chat relay (#111): at most this many chat events per household, the
// engine's chat log bound (rust/src/chat.rs MAX_CHAT_EVENT_COUNT).
export const MAX_HOUSEHOLD_CHAT_EVENTS = 250_000;

export const MAX_AUDIT_ROWS = 10_000;

export const BUSY_TIMEOUT_MS = 5_000;

export const HOUSEHOLD_DELETION_GRACE_MS = 30 * 24 * 60 * 60_000;

export function sqlitePragma(database, expression, { simple = false } = {}) {
  if (expression.includes("=") || expression.includes("(")) {
    database.exec(`PRAGMA ${expression}`);
    return undefined;
  }
  const rows = database.prepare(`PRAGMA ${expression}`).all();
  return simple ? Object.values(rows[0] ?? {})[0] : rows;
}

export class DurableStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DurableStoreError";
  }
}

export class DurableConflictError extends DurableStoreError {
  constructor(code, message) {
    super(message);
    this.name = "DurableConflictError";
    this.code = code;
  }
}

export function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new DurableStoreError("Kin server data is malformed.", {
      cause: error,
    });
  }
}

export function parseStoredJson(value) {
  try {
    return JSON.parse(value, (_key, entry) =>
      entry &&
      typeof entry === "object" &&
      Object.keys(entry).length === 1 &&
      typeof entry.$kinBuffer === "string"
        ? Buffer.from(entry.$kinBuffer, "base64")
        : entry,
    );
  } catch (error) {
    throw new DurableStoreError("Kin server data is malformed.", {
      cause: error,
    });
  }
}

export function stringifyStored(value) {
  return JSON.stringify(value, (_key, entry) =>
    entry?.type === "Buffer" && Array.isArray(entry.data)
      ? { $kinBuffer: Buffer.from(entry.data).toString("base64") }
      : entry,
  );
}

export function auditDetails(event) {
  const { type, at, persisted, ...details } = event;
  return details;
}

export function validAuditDetails(details) {
  // Audit details are a bounded metadata object, never arbitrary household
  // content. Permit optional fields without coupling validation to event types.
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const entries = Object.entries(details);
  return entries.length <= 32 && entries.every(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
    (value === null || typeof value === "boolean" ||
      (typeof value === "string" && value.length <= 1024) ||
      (typeof value === "number" && Number.isSafeInteger(value))),
  );
}

export function isId(value) {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isSqliteError(error) {
  return (
    typeof error?.code === "string" &&
    (error.code.startsWith("ERR_SQLITE_") ||
      error.code.startsWith("SQLITE_"))
  );
}

export function exists(path) {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
