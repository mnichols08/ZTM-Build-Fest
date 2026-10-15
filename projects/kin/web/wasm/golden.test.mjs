// The release WASM must reproduce the native protocol-24 golden projections
// byte for byte (see rust/src/golden_tests.rs).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

const fixtures = new URL("../../rust/fixtures/golden/", import.meta.url);
const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const abi = instance.exports;

function replay(request) {
  const pointer = abi.kin_alloc(request.length);
  assert.notEqual(pointer, 0);
  try {
    new Uint8Array(abi.memory.buffer, pointer, request.length).set(request);
    assert.equal(abi.kin_apply_events(pointer, request.length), 0);
    return new Uint8Array(abi.memory.buffer, abi.kin_result_ptr(), abi.kin_result_len()).slice();
  } finally {
    assert.equal(abi.kin_free(pointer, request.length), 0);
  }
}

const names = (await readdir(fixtures)).filter((name) => name.endsWith(".kine")).map((name) => name.slice(0, -5));

test("golden fixtures are present", () => {
  assert.deepEqual(names.sort(), ["bulk", "distributed", "empty", "full", "pulse-expiry"]);
});

for (const name of names) {
  test(`WASM reproduces the ${name} golden projection`, async () => {
    const request = new Uint8Array(await readFile(new URL(`${name}.kine`, fixtures)));
    const expected = new Uint8Array(await readFile(new URL(`${name}.kins`, fixtures)));
    assert.deepEqual(replay(request), expected);
  });
}
