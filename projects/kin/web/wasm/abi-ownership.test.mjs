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
      kin_encode_command: status,
      kin_execute: status,
      kin_encode_archive: status,
      kin_decode_archive: status,
      kin_archive_header: status,
      kin_archive_layout: status,
      kin_plan_import: status,
      kin_qr_encode: status,
      kin_qr_decode: status,
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
