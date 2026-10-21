// A member's private log on the browser side (#489, ADR 0019). Rust
// (rust/src/private.rs, journal.rs) owns the records and their replay; this
// module only names the kinds, builds well-formed private commands and reads
// the KPRV projection Rust returns.
//
// Kinds 100–199 are reserved for private records, a share per story: 100 the
// placeholder note (reserved; nothing writes it), 101–109 the journal
// (#496), 110–119 "Just for me" (#510), 120–139 reminders and settings
// (#520). KPRV sections are numbered after the first kind of each share.

export const FIRST_PRIVATE_KIND = 100;
export const LAST_PRIVATE_KIND = 199;
export const MAX_PRIVATE_EVENT_COUNT = 50_000;
export const MAX_PRIVATE_NOTE_BYTES = 2048;

/** Private event kinds by code (KMET `kind` names). */
export const PRIVATE_KINDS = Object.freeze({
  100: "PRIVATE_NOTE_SET",
  101: "JOURNAL_ENTRY_CREATED",
  102: "JOURNAL_ENTRY_EDITED",
  103: "JOURNAL_ENTRY_DELETED",
  104: "JOURNAL_ENTRY_RESTORED",
});
export const PRIVATE_EVENT_KINDS = Object.freeze(Object.values(PRIVATE_KINDS));

// The journal (#496, rust/src/journal.rs).
export const MAX_JOURNAL_TITLE_BYTES = 200;
export const MAX_JOURNAL_BODY_BYTES = 20_000;
export const MAX_JOURNAL_PHOTOS = 10;
export const MIN_JOURNAL_PHOTO_BYTES = 29;
export const MAX_JOURNAL_PHOTO_BYTES = 4 * 1024 * 1024 + 4096;
/** KCMD actions for the journal, with the kind each makes. */
export const JOURNAL_COMMANDS = Object.freeze({
  "create-journal-entry": 101,
  "edit-journal-entry": 102,
  "delete-journal-entry": 103,
  "restore-journal-entry": 104,
});
/** Photo types by their code in a journal record. */
export const JOURNAL_PHOTO_TYPES = Object.freeze(["", "image/jpeg", "image/png", "image/webp"]);
const PHOTO_BYTES = 136;

const SECTION_NOTES = 1;
const SECTION_JOURNAL = 101;
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

export class PrivateFormatError extends Error {
  constructor(message = "Kin received an invalid private projection.") {
    super(message);
    this.name = "PrivateFormatError";
  }
}

/** Whether a kind name (KMET `kind`) is a private kind. */
export function isPrivateKind(kind) {
  return PRIVATE_EVENT_KINDS.includes(kind);
}

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(value, length, what) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length * 2}}$`).test(value) || /^0+$/.test(value))
    throw new PrivateFormatError(`Kin received an invalid journal ${what}.`);
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

/** "YYYY-MM-DD" to the engine's YYYYMMDD number, or null. */
export function encodeCivilDate(value) {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return year * 10_000 + month * 100 + day;
}

function decodeCivilDate(value) {
  return `${String(Math.floor(value / 10_000)).padStart(4, "0")}-${String(Math.floor(value / 100) % 100).padStart(2, "0")}-${String(value % 100).padStart(2, "0")}`;
}

/**
 * A title as the journal keeps it: one line, white space collapsed, trimmed.
 * Never cut: a title that is too long is refused where it is typed.
 */
export function normalizeJournalTitle(value) {
  return String(value ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
}

/**
 * A body as the journal keeps it: plain text with line feeds, any other
 * line break made a line feed, tabs made spaces, other control characters
 * dropped, trimmed at both ends.
 */
export function normalizeJournalBody(value) {
  return String(value ?? "")
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[^\P{Cc}\n]/gu, "")
    .trim();
}

/** Why a title or body can't be saved, or null. */
export function journalTextProblem({ title = "", body = "", photos = [] } = {}) {
  if (encoder.encode(title).length > MAX_JOURNAL_TITLE_BYTES) return "That title is too long. Keep it under about 200 characters.";
  if (encoder.encode(body).length > MAX_JOURNAL_BODY_BYTES) return "That entry is too long to save as one. Split it into two entries.";
  if (!title && !body && !photos.length) return "Write something or add a photo first.";
  return null;
}

function photoBytes(photo) {
  const type = JOURNAL_PHOTO_TYPES.indexOf(photo?.type);
  if (type < 1 || !Number.isSafeInteger(photo.size) || photo.size < MIN_JOURNAL_PHOTO_BYTES || photo.size > MAX_JOURNAL_PHOTO_BYTES)
    throw new PrivateFormatError("Kin received an invalid journal photo.");
  const bytes = new Uint8Array(PHOTO_BYTES);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(4, photo.size, true);
  bytes.set(fromHex(photo.ref, 32, "photo"), 8);
  bytes.set(fromHex(photo.key, 32, "photo key"), 40);
  bytes.set(fromHex(photo.thumbnail, 32, "thumbnail"), 72);
  bytes.set(fromHex(photo.thumbnailKey, 32, "thumbnail key"), 104);
  return bytes;
}

/**
 * The exact payload of a journal command (journal.rs layouts). A create or
 * edit carries `{ entryId, date: "YYYY-MM-DD", title, body, photos }`, whose
 * text is already normalized (Rust refuses it otherwise); a delete or
 * restore carries `{ entryId }`.
 */
export function encodeJournalPayload(command) {
  const kind = JOURNAL_COMMANDS[command?.type];
  if (!kind) throw new PrivateFormatError("Kin received an invalid journal change.");
  const id = fromHex(command.entryId, 16, "entry");
  if (kind === 103 || kind === 104) return id;
  const date = encodeCivilDate(command.date);
  const title = typeof command.title === "string" && command.title.isWellFormed() ? encoder.encode(command.title) : null;
  const body = typeof command.body === "string" && command.body.isWellFormed() ? encoder.encode(command.body) : null;
  const photos = Array.isArray(command.photos) ? command.photos : null;
  if (date === null || !title || !body || !photos || title.length > MAX_JOURNAL_TITLE_BYTES ||
      body.length > MAX_JOURNAL_BODY_BYTES || photos.length > MAX_JOURNAL_PHOTOS)
    throw new PrivateFormatError("Kin received an invalid journal entry.");
  const payload = new Uint8Array(28 + title.length + body.length + PHOTO_BYTES * photos.length);
  const view = new DataView(payload.buffer);
  payload.set(id, 0);
  view.setUint32(16, date, true);
  view.setUint16(20, title.length, true);
  payload[22] = photos.length;
  view.setUint32(24, body.length, true);
  payload.set(title, 28);
  payload.set(body, 28 + title.length);
  photos.forEach((photo, index) => payload.set(photoBytes(photo), 28 + title.length + body.length + PHOTO_BYTES * index));
  return payload;
}

/** A KCMD packet for a private command: the 128-byte header (identity and
 * logical time as for every command) and the payload as its text. */
export function encodePrivateIntent(command, identity) {
  const kind = JOURNAL_COMMANDS[command?.type];
  if (!kind) throw new PrivateFormatError("Kin received an invalid private change.");
  const payload = encodeJournalPayload(command);
  const packet = new Uint8Array(128 + payload.length);
  const view = new DataView(packet.buffer);
  packet.set([75, 67, 77, 68, 1, 0, 0, 0]);
  view.setUint16(8, kind, true);
  packet.set(fromHex(identity.eventId, 16, "event"), 12);
  packet.set(fromHex(identity.householdId, 16, "household"), 28);
  packet.set(fromHex(identity.actorId, 16, "member"), 44);
  packet.set(fromHex(identity.deviceId, 16, "device"), 60);
  if (!Number.isSafeInteger(identity.timestamp)) throw new PrivateFormatError("Kin received an invalid time.");
  view.setBigInt64(76, BigInt(identity.timestamp), true);
  const logicalTime = BigInt(identity.logicalTime);
  if (logicalTime <= 0n) throw new PrivateFormatError("Kin received an invalid event order.");
  view.setBigUint64(84, logicalTime, true);
  view.setUint32(124, payload.length, true);
  packet.set(payload, 128);
  return packet;
}

/**
 * Reads KPRV v1 (private.rs `encode_private`): `{ memberId, recordCount,
 * notes: [{ id, logicalTime, deviceId, text }], journal: [entry] }`, the
 * journal newest first as Rust ordered it. `memberId` is null while the log
 * is empty. Sections this release doesn't know are skipped, so a later
 * engine's additions never break an older reader.
 */
export function decodePrivate(bytes) {
  const invalid = () => new PrivateFormatError();
  if (!(bytes instanceof Uint8Array) || bytes.length < 32) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "KPRV" || view.getUint16(4, true) !== 1 ||
      view.getUint16(6, true) !== 0 || view.getUint16(30, true) !== 0)
    throw invalid();
  const member = bytes.subarray(8, 24);
  const result = {
    memberId: member.every((byte) => byte === 0) ? null : toHex(member),
    recordCount: view.getUint32(24, true),
    notes: [],
    journal: [],
  };
  const sections = view.getUint16(28, true);
  let at = 32, previous = 0;
  for (let index = 0; index < sections; index += 1) {
    if (at + 8 > bytes.length) throw invalid();
    const code = view.getUint16(at, true);
    const length = view.getUint32(at + 4, true);
    if (code <= previous || view.getUint16(at + 2, true) !== 0 || at + 8 + length > bytes.length) throw invalid();
    previous = code;
    if (code === SECTION_NOTES) result.notes = decodeNotes(bytes.subarray(at + 8, at + 8 + length));
    else if (code === SECTION_JOURNAL) result.journal = decodeJournal(bytes.subarray(at + 8, at + 8 + length));
    at += 8 + length;
  }
  if (at !== bytes.length) throw invalid();
  return result;
}

function decodeNotes(bytes) {
  const invalid = () => new PrivateFormatError();
  if (bytes.length < 4) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > MAX_PRIVATE_EVENT_COUNT) throw invalid();
  const notes = [];
  let at = 4;
  for (let index = 0; index < count; index += 1) {
    if (at + 44 > bytes.length) throw invalid();
    const length = view.getUint32(at + 40, true);
    if (length > MAX_PRIVATE_NOTE_BYTES || at + 44 + length > bytes.length) throw invalid();
    let text;
    try { text = strictDecoder.decode(bytes.subarray(at + 44, at + 44 + length)); } catch { throw invalid(); }
    notes.push({
      id: toHex(bytes.subarray(at, at + 16)),
      logicalTime: view.getBigUint64(at + 16, true),
      deviceId: toHex(bytes.subarray(at + 24, at + 40)),
      text,
    });
    at += 44 + length;
  }
  if (at !== bytes.length) throw invalid();
  return notes;
}

/** Section 101 (journal.rs `encode_section`). */
function decodeJournal(bytes) {
  const invalid = () => new PrivateFormatError();
  if (bytes.length < 4) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > MAX_PRIVATE_EVENT_COUNT) throw invalid();
  const entries = [];
  let at = 4;
  const text = (from, length) => {
    try { return strictDecoder.decode(bytes.subarray(from, from + length)); } catch { throw invalid(); }
  };
  for (let index = 0; index < count; index += 1) {
    if (at + 60 > bytes.length) throw invalid();
    const date = view.getUint32(at + 48, true);
    const titleLength = view.getUint16(at + 52, true);
    const photoCount = bytes[at + 54];
    const bodyLength = view.getUint32(at + 56, true);
    const end = at + 60 + titleLength + bodyLength + PHOTO_BYTES * photoCount;
    if (bytes[at + 55] !== 0 || titleLength > MAX_JOURNAL_TITLE_BYTES || bodyLength > MAX_JOURNAL_BODY_BYTES ||
        photoCount > MAX_JOURNAL_PHOTOS || end > bytes.length || encodeCivilDate(decodeCivilDate(date)) !== date)
      throw invalid();
    const photos = [];
    for (let photo = 0; photo < photoCount; photo += 1) {
      const from = at + 60 + titleLength + bodyLength + PHOTO_BYTES * photo;
      const type = JOURNAL_PHOTO_TYPES[bytes[from]];
      if (!type) throw invalid();
      photos.push({
        type,
        size: view.getUint32(from + 4, true),
        ref: toHex(bytes.subarray(from + 8, from + 40)),
        key: toHex(bytes.subarray(from + 40, from + 72)),
        thumbnail: toHex(bytes.subarray(from + 72, from + 104)),
        thumbnailKey: toHex(bytes.subarray(from + 104, from + 136)),
      });
    }
    entries.push({
      id: toHex(bytes.subarray(at, at + 16)),
      created: view.getBigUint64(at + 16, true),
      updated: view.getBigUint64(at + 24, true),
      deviceId: toHex(bytes.subarray(at + 32, at + 48)),
      date: decodeCivilDate(date),
      title: text(at + 60, titleLength),
      body: text(at + 60 + titleLength, bodyLength),
      photos,
    });
    at = end;
  }
  if (at !== bytes.length) throw invalid();
  return entries;
}
