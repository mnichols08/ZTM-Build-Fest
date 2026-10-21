import test from "node:test";
import assert from "node:assert/strict";
import { decodePrivate, FIRST_PRIVATE_KIND, isPrivateKind, PRIVATE_EVENT_KINDS, PrivateFormatError } from "./kin-private.js";

const encoder = new TextEncoder();

/** KPRV as rust/src/private.rs writes it (private_tests.rs has the same layout). */
function kprv({ member = new Uint8Array(16), count = 0, notes = [], extra = [] } = {}) {
  const section = (code, body) => {
    const bytes = new Uint8Array(8 + body.length);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, code, true);
    view.setUint32(4, body.length, true);
    bytes.set(body, 8);
    return bytes;
  };
  const noteBytes = [];
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, notes.length, true);
  noteBytes.push(head);
  for (const note of notes) {
    const text = encoder.encode(note.text);
    const row = new Uint8Array(44 + text.length);
    const view = new DataView(row.buffer);
    row.fill(note.id, 0, 16);
    view.setBigUint64(16, note.logicalTime, true);
    row.fill(0x11, 24, 40);
    view.setUint32(40, text.length, true);
    row.set(text, 44);
    noteBytes.push(row);
  }
  const notesBody = new Uint8Array(noteBytes.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of noteBytes) { notesBody.set(part, offset); offset += part.length; }
  const sections = [section(1, notesBody), ...extra.map(([code, body]) => section(code, body))];
  const total = 32 + sections.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("KPRV"), 0);
  view.setUint16(4, 1, true);
  bytes.set(member, 8);
  view.setUint32(24, count, true);
  view.setUint16(28, sections.length, true);
  offset = 32;
  for (const part of sections) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

test("an empty private log reads as no member and no notes", () => {
  assert.deepEqual(decodePrivate(kprv()), { memberId: null, recordCount: 0, notes: [] });
});

test("notes read in the order Rust wrote them", () => {
  const value = decodePrivate(kprv({
    member: new Uint8Array(16).fill(1), count: 3,
    notes: [{ id: 1, logicalTime: 2n, text: "one" }, { id: 2, logicalTime: 5n, text: "two\nlines" }],
  }));
  assert.equal(value.memberId, "01".repeat(16));
  assert.equal(value.recordCount, 3);
  assert.deepEqual(value.notes.map((note) => [note.id, note.logicalTime, note.deviceId, note.text]), [
    ["01".repeat(16), 2n, "11".repeat(16), "one"],
    ["02".repeat(16), 5n, "11".repeat(16), "two\nlines"],
  ]);
});

test("a section a later engine adds is skipped, not refused", () => {
  const value = decodePrivate(kprv({ notes: [{ id: 3, logicalTime: 1n, text: "kept" }], extra: [[7, new Uint8Array([1, 2, 3])]] }));
  assert.equal(value.notes[0].text, "kept");
});

test("damaged projections are refused", () => {
  const good = kprv({ notes: [{ id: 1, logicalTime: 1n, text: "x" }] });
  assert.throws(() => decodePrivate(good.subarray(0, 31)), PrivateFormatError);
  const magic = good.slice(); magic[0] = 0x41;
  assert.throws(() => decodePrivate(magic), PrivateFormatError);
  const version = good.slice(); version[4] = 2;
  assert.throws(() => decodePrivate(version), PrivateFormatError);
  assert.throws(() => decodePrivate(new Uint8Array([...good, 0])), PrivateFormatError, "trailing bytes");
  const short = good.slice(); new DataView(short.buffer).setUint32(36, 999, true);
  assert.throws(() => decodePrivate(short), PrivateFormatError, "a section longer than the projection");
  const repeated = kprv({ extra: [[1, new Uint8Array([0, 0, 0, 0])]] });
  assert.throws(() => decodePrivate(repeated), PrivateFormatError, "sections ascend, each once");
});

test("private kinds start at 100", () => {
  assert.equal(FIRST_PRIVATE_KIND, 100);
  assert.deepEqual(PRIVATE_EVENT_KINDS, ["PRIVATE_NOTE_SET"]);
  assert.ok(isPrivateKind("PRIVATE_NOTE_SET"));
  assert.ok(!isPrivateKind("BOARD_STROKE_ADDED"));
});
