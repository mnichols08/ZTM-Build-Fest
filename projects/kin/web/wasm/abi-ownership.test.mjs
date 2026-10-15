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
      kin_event_metadata: status,
      kin_event_metadata_batch: status,
      kin_encode_command: status,
      kin_execute: status,
      kin_encode_archive: status,
      kin_decode_archive: status,
      kin_archive_header: status,
      kin_archive_layout: status,
      kin_plan_import: status,
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
