// A member's private log on the browser side (#489, ADR 0019). Rust
// (rust/src/private.rs) owns the records and their replay; this module only
// names the kinds and reads the KPRV projection Rust returns.
//
// Kinds 100–199 are reserved for private records: the placeholder
// PRIVATE_NOTE_SET (100), and reminders and settings (120, 121, 130;
// kin-prefs.js) with KPRV sections 12 and 13. The journal and "Just for me"
// stories add theirs, and their own KPRV sections.
import { decodeReminders, decodeSettings, PREFS_KIND_CODES, SECTION_REMINDERS, SECTION_SETTINGS } from "./kin-prefs.js";

export const FIRST_PRIVATE_KIND = 100;
export const LAST_PRIVATE_KIND = 199;
export const MAX_PRIVATE_EVENT_COUNT = 50_000;
export const MAX_PRIVATE_NOTE_BYTES = 2048;
/** Private event kinds by code (codes in 100–199 may be unassigned). */
export const PRIVATE_KIND_CODES = Object.freeze({ PRIVATE_NOTE_SET: 100, ...PREFS_KIND_CODES });
/** Private event kinds, in code order. */
export const PRIVATE_EVENT_KINDS = Object.freeze(Object.keys(PRIVATE_KIND_CODES)
  .sort((left, right) => PRIVATE_KIND_CODES[left] - PRIVATE_KIND_CODES[right]));

const SECTION_NOTES = 1;
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

/**
 * Reads KPRV v1 (private.rs `encode_private`): `{ memberId, recordCount,
 * notes: [{ id, logicalTime, deviceId, text }], reminders (section 12,
 * kin-prefs.js decodeReminders), settings (section 13, decodeSettings) }`.
 * `memberId` is null while
 * the log is empty. Sections this release doesn't know are skipped, so a
 * later engine's additions never break an older reader.
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
    reminders: [],
    settings: {},
  };
  const sections = view.getUint16(28, true);
  let at = 32, previous = 0;
  for (let index = 0; index < sections; index += 1) {
    if (at + 8 > bytes.length) throw invalid();
    const code = view.getUint16(at, true);
    const length = view.getUint32(at + 4, true);
    if (code <= previous || view.getUint16(at + 2, true) !== 0 || at + 8 + length > bytes.length) throw invalid();
    previous = code;
    const body = bytes.subarray(at + 8, at + 8 + length);
    try {
      if (code === SECTION_NOTES) result.notes = decodeNotes(body);
      else if (code === SECTION_REMINDERS) result.reminders = decodeReminders(body);
      else if (code === SECTION_SETTINGS) result.settings = decodeSettings(body);
    } catch { throw invalid(); }
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
