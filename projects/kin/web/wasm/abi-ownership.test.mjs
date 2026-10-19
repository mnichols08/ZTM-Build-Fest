// Every kin_alloc input buffer must be released exactly once, whatever fails
// after the allocation: the copy into linear memory, the export itself, the
// result copy, or decoding the result.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createEngine, KinEngineError, loadKinEngine } from "./kin-engine.js";

const POINTER = 1024;

function substituteExports({ operation, result = null, allocPointer = POINTER } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const frees = [];
  const allocations = [];
  const output = result ?? new Uint8Array(0);
  new Uint8Array(memory.buffer).set(output, 32);
  const status = () => operation();
  return {
    frees,
    allocations,
    exports: {
      memory,
      kin_alloc(length) { allocations.push(length); return allocPointer; },
      kin_free(pointer, length) { frees.push([pointer, length]); return 0; },
      kin_history_reset: () => 0,
      kin_history_append: status,
      kin_history_truncate: () => 0,
      kin_project: status,
      kin_device_names: status,
      kin_event_metadata: status,
      kin_event_metadata_batch: status,
      kin_audio_peaks: status,
      kin_encode_command: status,
      kin_execute: status,
      kin_encode_archive: status,
      kin_decode_archive: status,
      kin_archive_header: status,
      kin_archive_layout: status,
      kin_plan_import: status,
      kin_chat_history_reset: () => 0,
      kin_chat_history_append: status,
      kin_chat_history_truncate: () => 0,
      kin_chat_execute: status,
      kin_chat_page: status,
      kin_chat_search: status,
      kin_chat_text: status,
      kin_chat_texts_clear: () => 0,
      kin_clear() {},
      kin_result_ptr: () => (output.length ? 32 : 0),
      kin_result_len: () => output.length,
      kin_error_ptr: () => 0,
      kin_error_len: () => 0,
    },
  };
}

const replay = (engine) => engine.applyEvents([], 1_760_000_000_000, null, 20261003);

test("a throwing export still frees its input allocation once", () => {
  const fake = substituteExports({ operation: () => { throw new Error("trap"); } });
  const engine = createEngine(fake.exports);
  assert.throws(() => replay(engine), (error) => error instanceof KinEngineError && error.code === 6);
  assert.deepEqual(fake.frees, [[POINTER, fake.allocations[0]]]);
});

test("an undecodable success result frees and reports an engine error", () => {
  const fake = substituteExports({ operation: () => 0, result: new TextEncoder().encode("XXXXjunkjunk") });
  const engine = createEngine(fake.exports);
  assert.throws(() => replay(engine), (error) => error instanceof KinEngineError);
  assert.deepEqual(fake.frees, [[POINTER, fake.allocations[0]]]);
});

test("a missing result buffer frees for every operation family", () => {
  const fake = substituteExports({ operation: () => 0 });
  const engine = createEngine(fake.exports);
  const calls = [
    () => replay(engine),
    () => engine.projectionBytes([], 1_760_000_000_000, null, 20261003),
    () => engine.deviceNames([], 1_760_000_000_000, 20261003),
    () => engine.eventMetadata(new Uint8Array(92)),
    () => engine.eventMetadataBatch([new Uint8Array(92)]),
    () => engine.planImport([], 1_760_000_000_000, null, 20261003),
    () => engine.decodeArchive(new Uint8Array(32)),
    () => engine.encodeArchive(new Uint8Array(8), new Uint8Array(16)),
    () => engine.executeCommand(
      { type: "add", text: "Milk", classification: "need" },
      {
        eventId: new Uint8Array(16).fill(1), householdId: new Uint8Array(16).fill(2),
        actorId: new Uint8Array(16).fill(3), deviceId: new Uint8Array(16).fill(4),
        entityId: new Uint8Array(16).fill(5), timestamp: 1, logicalTime: 1n,
      },
      [], 1_760_000_000_000, null, 20261003,
    ),
    () => engine.chatPage([], {}, 1_760_000_000_000, 20261003),
    () => engine.putChatTexts([{ blobRef: "ab".repeat(32), text: "hi" }]),
    () => engine.executeChatCommand(
      { type: "post-chat-message", messageId: "07".repeat(16), blobRef: "ab".repeat(32), blobKey: "cd".repeat(32) },
      {
        eventId: new Uint8Array(16).fill(1), householdId: new Uint8Array(16).fill(2),
        actorId: new Uint8Array(16).fill(3), deviceId: new Uint8Array(16).fill(4),
        timestamp: 1, logicalTime: 1n,
      },
      [], 1_760_000_000_000, 20261003,
    ),
  ];
  for (const call of calls) {
    const before = fake.frees.length;
    assert.throws(call, KinEngineError);
    assert.equal(fake.frees.length, before + 1, "each failed call frees exactly once");
    assert.deepEqual(fake.frees.at(-1), [POINTER, fake.allocations.at(-1)]);
  }
});

// KDEV v1 (docs/ABI.md): the device-name table kin_device_names publishes.
function kdev(devices) {
  const text = new TextEncoder();
  const parts = devices.map(({ deviceId, memberId, autoName, nickname }) => {
    const auto = text.encode(autoName), nick = text.encode(nickname ?? "");
    const bytes = new Uint8Array(36 + auto.length + nick.length);
    bytes.fill(deviceId, 0, 16); bytes.fill(memberId, 16, 32);
    new DataView(bytes.buffer).setUint16(32, auto.length, true);
    new DataView(bytes.buffer).setUint16(34, nick.length, true);
    bytes.set(auto, 36); bytes.set(nick, 36 + auto.length);
    return bytes;
  });
  const out = new Uint8Array(12 + parts.reduce((sum, part) => sum + part.length, 0));
  out.set(text.encode("KDEV")); out[4] = 1;
  new DataView(out.buffer).setUint32(8, devices.length, true);
  let offset = 12;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

test("device names decode from the KDEV table", () => {
  const table = kdev([
    { deviceId: 0x11, memberId: 0x01, autoName: "Chrome on iPhone", nickname: "Mikey’s phone 📱" },
    { deviceId: 0x21, memberId: 0x02, autoName: "Safari on Mac" },
    { deviceId: 0x31, memberId: 0x01, autoName: "", nickname: "Hall tablet" },
  ]);
  const engine = createEngine(substituteExports({ operation: () => 0, result: table }).exports);
  assert.deepEqual(engine.deviceNames([], 1_760_000_000_000, 20261003), [
    { deviceId: "11".repeat(16), memberId: "01".repeat(16), autoName: "Chrome on iPhone", nickname: "Mikey’s phone 📱" },
    { deviceId: "21".repeat(16), memberId: "02".repeat(16), autoName: "Safari on Mac", nickname: null },
    { deviceId: "31".repeat(16), memberId: "01".repeat(16), autoName: null, nickname: "Hall tablet" },
  ]);
  const nameless = kdev([{ deviceId: 0x11, memberId: 0x01, autoName: "" }]);
  for (const broken of [table.slice(0, -1), Uint8Array.of(...table, 0), (() => { const t = table.slice(); t[4] = 2; return t; })(), nameless]) {
    const fake = substituteExports({ operation: () => 0, result: broken });
    assert.throws(() => createEngine(fake.exports).deviceNames([], 1_760_000_000_000, 20261003),
      (error) => error instanceof KinEngineError && error.code === 6);
  }
});

test("a copy that overruns linear memory frees before rethrowing", () => {
  const fake = substituteExports({ operation: () => 0, allocPointer: 65_536 - 8 });
  const engine = createEngine(fake.exports);
  assert.throws(() => replay(engine));
  assert.deepEqual(fake.frees, [[65_536 - 8, fake.allocations[0]]]);
});

test("the real engine leaves no allocation behind after a rejected request", async () => {
  const bytes = await readFile(new URL("./kin_engine.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports;
  const frees = [];
  // Export properties are non-configurable, so wrap a copy rather than proxying.
  const tracked = {
    ...exports,
    kin_free: (pointer, length) => { frees.push(pointer); return exports.kin_free(pointer, length); },
  };
  const engine = createEngine(tracked);
  const malformed = new Uint8Array(88);
  new DataView(malformed.buffer).setUint16(0, 99, true);
  assert.throws(() => engine.applyEvents([malformed], 1_760_000_000_000, null, 20261003), (error) => error.code === 3);
  assert.equal(frees.length, 1);
  // A freed pointer is no longer tracked; freeing it again is refused safely.
  assert.equal(exports.kin_free(frees[0], 64 + 88), 1);
  await loadKinEngine(`data:application/wasm;base64,${bytes.toString("base64")}`);
});

// KCHP v1 (docs/ABI.md): the chat page kin_chat_page publishes, built by hand.
function kchp({ total, start, messages, retired = [] }) {
  const text = new TextEncoder();
  const texts = messages.map((message) => text.encode(message.text ?? ""));
  const textBytes = texts.reduce((sum, bytes) => sum + bytes.length, 0);
  const out = new Uint8Array(28 + messages.length * 160 + textBytes + retired.length * 32);
  const view = new DataView(out.buffer);
  out.set(text.encode("KCHP")); out[4] = 1;
  [total, start, messages.length, textBytes, retired.length].forEach((value, index) => view.setUint32(8 + index * 4, value, true));
  let textOffset = 0;
  messages.forEach((message, index) => {
    const at = 28 + index * 128;
    out.fill(message.id, at, at + 16); out.fill(message.author, at + 16, at + 32); out.fill(message.device, at + 32, at + 48);
    view.setBigInt64(at + 48, BigInt(message.postedAt), true);
    view.setBigInt64(at + 56, BigInt(message.editedAt ?? 0), true);
    view.setUint32(at + 64, start + index, true);
    out[at + 68] = message.status; out[at + 69] = message.kind ?? 1;
    if (message.blob) out.fill(message.blob, at + 72, at + 104);
    if (texts[index].length) { view.setUint32(at + 104, textOffset, true); view.setUint32(at + 108, texts[index].length, true); }
    textOffset += texts[index].length;
    if (message.blob) out.fill(message.key, 28 + messages.length * 128 + index * 32, 28 + messages.length * 128 + index * 32 + 32);
  });
  out.set(texts.reduce((all, bytes) => Uint8Array.of(...all, ...bytes), new Uint8Array()), 28 + messages.length * 160);
  retired.forEach((blob, index) => out.fill(blob, out.length - (retired.length - index) * 32, out.length - (retired.length - index - 1) * 32));
  return out;
}

test("a chat page carries reactions after its retired blobs (#127)", () => {
  const base = kchp({
    total: 1, start: 0,
    messages: [{ id: 0x01, author: 0x11, device: 0x21, postedAt: 1_791_475_200_001, status: 0, blob: 0xb1, key: 0xc1 }],
  });
  const thumbs = new TextEncoder().encode("\u{1F44D}");
  const section = (members) => Uint8Array.of(thumbs.length, ...thumbs, members.length, 0, 0, 0, ...members.flatMap((member) => new Array(16).fill(member)));
  const withGroups = (groups, ...sections) => {
    const bytes = Uint8Array.of(...base, ...sections.flatMap((part) => [...part]));
    new DataView(bytes.buffer).setUint32(28 + 112, groups, true);
    return bytes;
  };
  const decode = (bytes) => createEngine(substituteExports({ operation: () => 0, result: bytes }).exports).chatPage([], { includeReactions: true }, 1_760_000_000_000, 20261003);
  assert.deepEqual(decode(withGroups(1, section([0x11, 0x12]))).messages[0].reactions, [{ emoji: "\u{1F44D}", actors: ["11".repeat(16), "12".repeat(16)] }]);
  assert.equal(decode(withGroups(2, section([0x11]), section([0x12]))).messages[0].reactions.length, 2);
  for (const bytes of [
    withGroups(1),
    withGroups(1, section([])),
    withGroups(2, section([0x11])),
    withGroups(0, section([0x11])),
    withGroups(1, Uint8Array.of(0, 1, 0, 0, 0, ...new Array(16).fill(1))),
    withGroups(1, Uint8Array.of(33, ...new Array(33).fill(0x41), 1, 0, 0, 0, ...new Array(16).fill(1))),
    withGroups(1, Uint8Array.of(1, 0xff, 1, 0, 0, 0, ...new Array(16).fill(1))),
  ]) assert.throws(() => decode(bytes), (error) => error instanceof KinEngineError && error.code === 6);
});

test("a chat page carries the quote of a reply after its reactions (#129)", () => {
  const base = kchp({
    total: 2, start: 0,
    messages: [
      { id: 0x01, author: 0x11, device: 0x21, postedAt: 1_791_475_200_001, status: 0, blob: 0xb1, key: 0xc1 },
      { id: 0x02, author: 0x12, device: 0x22, postedAt: 1_791_475_200_002, status: 0, blob: 0xb2, key: 0xc2 },
    ],
  });
  const flag = (bytes, index = 1) => { bytes[28 + index * 128 + 70] = 1; return bytes; };
  const quote = ({ id = 0x01, state = 1, kind = 1, author = 0x11, ref = 0xb1, key = 0xc1, index = 0, text = "Dinner at 6" } = {}) => {
    const body = new TextEncoder().encode(text ?? "");
    const out = new Uint8Array(108 + body.length);
    out.fill(id, 0, 16); out[16] = state; out[17] = kind;
    out.fill(author, 20, 36); out.fill(ref, 36, 68); out.fill(key, 68, 100);
    const view = new DataView(out.buffer);
    view.setUint32(100, index, true); view.setUint32(104, body.length, true);
    out.set(body, 108);
    return out;
  };
  const withQuote = (entry, flagged = flag(base.slice())) => Uint8Array.of(...flagged, ...entry);
  const decode = (bytes) => createEngine(substituteExports({ operation: () => 0, result: bytes }).exports).chatPage([], {}, 1_760_000_000_000, 20261003);
  const page = decode(withQuote(quote()));
  assert.equal(page.messages[0].replyTo, null);
  assert.deepEqual(page.messages[1].replyTo, {
    messageId: "01".repeat(16), state: "live", contentKind: "text", authorId: "11".repeat(16), index: 0,
    blobRef: "b1".repeat(32), blobKey: new Uint8Array(32).fill(0xc1), text: "Dinner at 6",
  });
  // Deleted, unknown and not-yet-downloaded originals.
  assert.deepEqual(decode(withQuote(quote({ state: 3, ref: 0, key: 0, text: "" }))).messages[1].replyTo,
    { messageId: "01".repeat(16), state: "deleted", contentKind: "text", authorId: "11".repeat(16), index: 0, blobRef: null, blobKey: null, text: null });
  assert.equal(decode(withQuote(quote({ state: 0, kind: 0, author: 0, ref: 0, key: 0, index: 0xffff_ffff, text: "" }))).messages[1].replyTo.state, "unknown");
  assert.equal(decode(withQuote(quote({ text: "" }))).messages[1].replyTo.text, null);
  for (const bytes of [
    withQuote(Uint8Array.of()),
    withQuote(quote({ state: 9 })),
    withQuote(quote({ state: 3 })),
    withQuote(quote({ state: 0, kind: 1, author: 0, ref: 0, key: 0, index: 0xffff_ffff, text: "" })),
    withQuote(quote({ ref: 0 })),
    withQuote(quote({ kind: 2 })),
    withQuote(Uint8Array.of(...quote(), 0)),
    withQuote(quote().slice(0, -1)),
    // A quote with no flag, and a flag on a deleted message.
    Uint8Array.of(...base, ...quote()),
    (() => { const copy = withQuote(quote()); copy[28 + 128 + 68] = 2; return copy; })(),
  ]) assert.throws(() => decode(bytes), (error) => error instanceof KinEngineError && error.code === 6);
});

test("chat pages decode from KCHP and malformed pages are refused (#109)", () => {
  const page = kchp({
    total: 5,
    start: 3,
    messages: [
      { id: 0x01, author: 0x11, device: 0x21, postedAt: 1_791_475_200_001, editedAt: 1_791_475_200_009, status: 1, blob: 0xb1, key: 0xc1, text: "Dinner at 6 🍝" },
      { id: 0x02, author: 0x12, device: 0x22, postedAt: 1_791_475_200_002, status: 3 },
    ],
    retired: [0xd1, 0xd2],
  });
  const engine = createEngine(substituteExports({ operation: () => 0, result: page }).exports);
  const decoded = engine.chatPage([], { limit: 2, admins: ["33".repeat(16)] }, 1_760_000_000_000, 20261003);
  assert.equal(decoded.total, 5);
  assert.equal(decoded.start, 3);
  assert.deepEqual(decoded.retired, ["d1".repeat(32), "d2".repeat(32)]);
  assert.deepEqual(decoded.messages[0], {
    messageId: "01".repeat(16), authorId: "11".repeat(16), deviceId: "21".repeat(16),
    postedAt: 1_791_475_200_001, editedAt: 1_791_475_200_009, index: 3, status: "edited", contentKind: "text",
    blobRef: "b1".repeat(32), blobKey: new Uint8Array(32).fill(0xc1), text: "Dinner at 6 🍝", reactions: [], replyTo: null, mentions: { everyone: false, members: [] },
  });
  assert.deepEqual(decoded.messages[1], {
    messageId: "02".repeat(16), authorId: "12".repeat(16), deviceId: "22".repeat(16),
    postedAt: 1_791_475_200_002, editedAt: null, index: 4, status: "removed-by-admin", contentKind: "text",
    blobRef: null, blobKey: null, text: null, reactions: [], replyTo: null, mentions: { everyone: false, members: [] },
  });
  const broken = [
    page.slice(0, -1),
    Uint8Array.of(...page, 0),
    (() => { const copy = page.slice(); copy[4] = 2; return copy; })(),
    (() => { const copy = page.slice(); copy[28 + 68] = 4; return copy; })(),
    (() => { const copy = page.slice(); copy[28 + 69] = 0; return copy; })(),
    (() => { const copy = page.slice(); copy[28 + 64] = 9; return copy; })(),
    // A visible message without its blob, a removed one with a blob.
    (() => { const copy = page.slice(); copy.fill(0, 28 + 72, 28 + 104); return copy; })(),
    (() => { const copy = page.slice(); copy[28 + 128 + 72] = 1; return copy; })(),
    // start + count past the total.
    (() => { const copy = page.slice(); new DataView(copy.buffer).setUint32(8, 4, true); return copy; })(),
    // Reserved bytes, a text that doesn't start where the last one ended,
    // and an edited message without its edit time.
    (() => { const copy = page.slice(); copy[28 + 70] = 1; return copy; })(),
    (() => { const copy = page.slice(); copy[28 + 120] = 1; return copy; })(),
    (() => { const copy = page.slice(); copy[28 + 104] = 1; return copy; })(),
    (() => { const copy = page.slice(); copy.fill(0, 28 + 56, 28 + 64); return copy; })(),
  ];
  for (const bytes of broken) {
    const fake = substituteExports({ operation: () => 0, result: bytes });
    assert.throws(() => createEngine(fake.exports).chatPage([], {}, 1_760_000_000_000, 20261003),
      (error) => error instanceof KinEngineError && error.code === 6);
  }
  for (const options of [{ limit: 0 }, { limit: 501 }, { before: -1 }, { admins: ["zz"] }, { admins: Array(17).fill("33".repeat(16)) }]) {
    assert.throws(() => engine.chatPage([], options, 1_760_000_000_000, 20261003), KinEngineError);
  }
});

test("chat texts report one status per text (#109)", () => {
  const statuses = new Uint8Array([75, 67, 72, 83, 1, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  const fake = substituteExports({ operation: () => 0, result: statuses });
  const engine = createEngine(fake.exports);
  assert.deepEqual(engine.putChatTexts([{ blobRef: "ab".repeat(32), text: "ok" }, { blobRef: "cd".repeat(32), text: "\u0007" }]), [true, false]);
  for (const entries of [[], [{ blobRef: "00".repeat(32), text: "zero" }], [{ blobRef: "AB".repeat(32), text: "upper" }], [{ blobRef: "ab".repeat(32), text: 7 }], [{ blobRef: "ab".repeat(32), text: "lone \ud800" }]]) {
    assert.throws(() => engine.putChatTexts(entries), KinEngineError);
  }
  const wrong = createEngine(substituteExports({ operation: () => 0, result: statuses.slice(0, -1) }).exports);
  assert.throws(() => wrong.putChatTexts([{ blobRef: "ab".repeat(32), text: "ok" }, { blobRef: "cd".repeat(32), text: "x" }]),
    (error) => error.code === 6);
});

test("an engine without the chat exports is refused", () => {
  const fake = substituteExports({ operation: () => 0 });
  delete fake.exports.kin_chat_page;
  assert.throws(() => createEngine(fake.exports), (error) => error instanceof KinEngineError && error.code === 6);
});

// KCHR v1 (docs/ABI.md): the chat search result, built by hand.
function kchr({ total, results = [], unsearched = 0, missing = [] }) {
  const parts = [];
  const header = new DataView(new ArrayBuffer(24));
  new TextEncoder().encodeInto("KCHR", new Uint8Array(header.buffer));
  header.setUint16(4, 1, true);
  header.setUint32(8, total, true);
  header.setUint32(12, results.length, true);
  header.setUint32(16, unsearched, true);
  header.setUint32(20, missing.length, true);
  parts.push(new Uint8Array(header.buffer));
  for (const result of results) {
    const excerpt = new TextEncoder().encode(result.excerpt ?? "");
    const record = new Uint8Array(60 + result.ranges.length * 8 + excerpt.length);
    const view = new DataView(record.buffer);
    record.fill(result.id, 0, 16);
    view.setUint32(16, result.index, true);
    view.setUint32(20, result.ranges.length, true);
    record.fill(result.author ?? 0x11, 24, 40);
    view.setBigInt64(40, BigInt(result.postedAt ?? 1_791_475_200_001), true);
    view.setUint32(48, result.kind ?? 1, true);
    view.setUint32(52, result.offset ?? 0, true);
    view.setUint32(56, excerpt.length, true);
    result.ranges.forEach(([start, end], at) => {
      view.setUint32(60 + at * 8, start, true);
      view.setUint32(64 + at * 8, end, true);
    });
    record.set(excerpt, 60 + result.ranges.length * 8);
    parts.push(record);
  }
  for (const entry of missing) {
    const record = new Uint8Array(80);
    record.fill(entry.id, 0, 16);
    record.fill(entry.ref, 16, 48);
    record.fill(entry.key, 48, 80);
    parts.push(record);
  }
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

test("a chat search sends a KCHF request and decodes the KCHR result (#124)", () => {
  const result = kchr({
    total: 3,
    results: [
      { id: 0x01, index: 7, ranges: [[6, 12]], excerpt: "dinner needle", offset: 0 },
      { id: 0x02, index: 2, ranges: [[40, 46], [60, 66]], excerpt: "…é needle and needle", offset: 38, postedAt: 1_791_475_200_009, kind: 1 },
    ],
    unsearched: 2,
    missing: [{ id: 0x03, ref: 0xb3, key: 0xc3 }],
  });
  let request = null;
  const fake = substituteExports({ operation: () => 0, result });
  const exports = { ...fake.exports, kin_chat_search: () => {
    request = new Uint8Array(fake.exports.memory.buffer.slice(POINTER, POINTER + fake.allocations.at(-1)));
    return 0;
  } };
  const engine = createEngine(exports);
  const found = engine.chatSearch([], {
    query: "needle é", limit: 20, attachmentsOnly: false, from: 5, to: 9,
    authors: ["11".repeat(16)], excluded: ["22".repeat(16), "23".repeat(16)], admins: ["33".repeat(16)],
  }, 1_760_000_000_000, 20261003);
  const query = new TextEncoder().encode("needle é");
  const view = new DataView(request.buffer);
  assert.equal(new TextDecoder().decode(request.subarray(0, 4)), "KCHF");
  assert.deepEqual([request[4], request[6]], [1, 0]);
  assert.deepEqual(
    [view.getUint32(8, true), view.getUint32(12, true), Number(view.getBigInt64(16, true)), Number(view.getBigInt64(24, true)),
      view.getUint32(32, true), view.getUint32(36, true), view.getUint32(40, true), view.getUint32(44, true)],
    [20, 0, 5, 9, query.length, 1, 1, 2],
  );
  assert.deepEqual([...request.subarray(48, 48 + query.length)], [...query]);
  const ids = 48 + query.length;
  assert.deepEqual([request[ids], request[ids + 16], request[ids + 32], request[ids + 48]], [0x33, 0x11, 0x22, 0x23]);
  assert.equal(found.total, 3);
  assert.equal(found.unsearched, 2);
  assert.deepEqual(found.results[0], {
    messageId: "01".repeat(16), index: 7, authorId: "11".repeat(16), postedAt: 1_791_475_200_001,
    contentKind: "text", ranges: [[6, 12]], excerpt: "dinner needle", excerptOffset: 0,
  });
  assert.deepEqual(found.results[1].ranges, [[40, 46], [60, 66]]);
  assert.equal(found.results[1].excerptOffset, 38);
  assert.deepEqual(found.missing, [{ messageId: "03".repeat(16), blobRef: "b3".repeat(32), blobKey: new Uint8Array(32).fill(0xc3) }]);
});

test("chat search requests and results are checked (#124)", () => {
  const engine = (bytes) => createEngine(substituteExports({ operation: () => 0, result: bytes }).exports);
  const run = (bytes, options = { query: "a" }) => engine(bytes).chatSearch([], options, 1_760_000_000_000, 20261003);
  const good = kchr({ total: 1, results: [{ id: 1, index: 0, ranges: [[0, 1]], excerpt: "a" }] });
  assert.doesNotThrow(() => run(good));
  for (const options of [
    { query: "a", limit: 0 }, { query: "a", limit: 201 }, { query: "x".repeat(257) }, { query: 7 },
    { query: "a", from: -1 }, { query: "a", from: 9, to: 5 }, { query: "a", authors: new Array(17).fill("11".repeat(16)) },
    { query: "a", excluded: new Array(10_001).fill("11".repeat(16)) }, { query: "a", authors: ["zz"] },
  ]) assert.throws(() => run(good, options), /invalid chat search|invalid/i, JSON.stringify(options).slice(0, 40));
  const broken = [
    good.slice(0, -1),
    Uint8Array.of(...good, 0),
    (() => { const copy = good.slice(); copy[0] = 0x58; return copy; })(),
    (() => { const copy = good.slice(); copy[4] = 2; return copy; })(),
    // A result count above the total, an empty range, an unknown kind, a range count of five.
    (() => { const copy = good.slice(); new DataView(copy.buffer).setUint32(8, 0, true); return copy; })(),
    (() => { const copy = good.slice(); new DataView(copy.buffer).setUint32(24 + 60, 5, true); return copy; })(),
    (() => { const copy = good.slice(); new DataView(copy.buffer).setUint32(24 + 48, 3, true); return copy; })(),
    (() => { const copy = good.slice(); new DataView(copy.buffer).setUint32(24 + 20, 5, true); return copy; })(),
    // More listed than unsearched.
    kchr({ total: 0, unsearched: 0, missing: [{ id: 3, ref: 4, key: 5 }] }),
    // An excerpt that is not UTF-8.
    (() => { const copy = good.slice(); copy[copy.length - 1] = 0xff; return copy; })(),
  ];
  broken.forEach((bytes, index) => assert.throws(() => run(bytes), /invalid chat search result|invalid/i, `broken result ${index}`));
});
