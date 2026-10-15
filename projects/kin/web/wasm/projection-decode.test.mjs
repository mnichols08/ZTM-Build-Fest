// The bridge decodes only protocol-24 projections and fails closed on any
// truncated, extended or inconsistent buffer (KinEngineError code 6).
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { decodeProjection, KinEngineError } from "./kin-engine.js";

const fixtures = new URL("../../rust/fixtures/golden/", import.meta.url);
const load = async (name) => new Uint8Array(await readFile(new URL(name, fixtures)));
const failsClosed = (bytes, message) =>
  assert.throws(() => decodeProjection(bytes), (error) => error instanceof KinEngineError && error.code === 6, message);

test("golden projections decode with counts that match their headers", async () => {
  for (const name of ["empty", "full", "distributed", "pulse-expiry", "bulk"]) {
    const bytes = await load(`${name}.kins`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const state = decodeProjection(bytes);
    assert.equal(state.items.length, view.getUint32(8, true), name);
    assert.equal(state.handoffs.length, view.getUint32(12, true), name);
    assert.equal(state.talks.length, view.getUint32(16, true), name);
    assert.equal(state.pulses.length, view.getUint32(20, true), name);
    assert.equal(state.routines.length, view.getUint32(52, true), name);
    assert.equal(state.summary.entries.length, view.getUint32(24, true), name);
  }
  const full = decodeProjection(await load("full.kins"));
  assert.equal(full.mode, "guests");
  assert.ok(full.routines.every((routine) => routine.status === "archived" ? routine.nextOn === null : routine.nextOn > 0));
  assert.ok(full.items.some((item) => item.steps.length && item.areaId && item.planningDate));
});

test("every truncation and any trailing byte fail closed", async () => {
  const bytes = await load("full.kins");
  for (let length = 0; length < bytes.length; length += 1) failsClosed(bytes.slice(0, length), `length ${length}`);
  failsClosed(Uint8Array.from([...bytes, 0]), "trailing byte");
});

test("other versions, reserved bytes, modes and summary flags fail closed", async () => {
  const bytes = await load("full.kins");
  const mutate = (offset, value) => {
    const copy = bytes.slice();
    copy[offset] = value;
    return copy;
  };
  for (const version of [0, 1, 23, 25, 255]) failsClosed(mutate(4, version), `version ${version}`);
  for (const offset of [6, 7, 33, 34, 35, 69, 70, 71]) failsClosed(mutate(offset, 1), `reserved ${offset}`);
  failsClosed(mutate(68, 4), "mode code");
  failsClosed(mutate(32, 2), "through flag");
  const empty = await load("empty.kins");
  const withThrough = empty.slice();
  withThrough[36] = 1; // through ID without the present flag
  failsClosed(withThrough, "through ID without flag");
  const counted = empty.slice();
  new DataView(counted.buffer).setUint32(8, 1, true); // an Item with no record
  failsClosed(counted, "declared Item without a record");
});
