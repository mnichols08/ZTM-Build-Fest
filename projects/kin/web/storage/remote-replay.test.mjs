import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine, encodeAddedRecord, encodeRoutineCreatedRecord, encodeRoutineActionRecord } from "../wasm/kin-engine.js";
import { reconcileRemoteEvents } from "./event-store.js";

const wasm = await readFile(new URL("../wasm/kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => new Uint8Array(16).fill(byte);
const context = (device, sequence, logicalTime) => ({
  eventId: id(device * 16 + sequence), householdId: id(0xaa),
  actorId: id(0xa0 + device), deviceId: id(device), timestamp: 1_791_475_200_000 + sequence,
  logicalTime: BigInt(logicalTime),
});

test("remote replay quarantines malformed and dependency-invalid events, advances to later valid history", () => {
  const offlineItem = encodeAddedRecord({ ...context(2, 1, 1), itemId: id(0x22), text: "Offline-only", classification: "need" });
  const poison = engine.executeCommand({
    type: "change-responsibility", targetKind: "item", targetId: [...id(0x22)].map((v) => v.toString(16).padStart(2, "0")).join(""), memberId: "ee".repeat(16),
  }, context(2, 2, 2), [offlineItem], 1_791_475_200_000, null, 20261009).encodedEvent;
  const valid = encodeAddedRecord({ ...context(3, 1, 1), itemId: id(0x33), text: "Buy milk", classification: "need" });
  const contextRow = { last_looked_event_id: null };
  const result = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: new Uint8Array([1, 2, 3]) }, { encodedEvent: poison }, { encodedEvent: valid }],
    engine, context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(result.quarantined, 2);
  assert.equal(result.additions.length, 1);
  assert.equal(engine.applyEvents(result.candidates, 1_791_475_200_000, null, 20261009).items[0].text, "Buy milk");
  const reordered = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: valid }, { encodedEvent: poison }, { encodedEvent: new Uint8Array([1, 2, 3]) }],
    engine, context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(reordered.quarantined, result.quarantined);
  assert.deepEqual(reordered.additions.map((row) => [...row.event_id]), result.additions.map((row) => [...row.event_id]));
  const duplicate = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: valid }, { encodedEvent: valid }], engine,
    context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(duplicate.quarantined, 0);
  assert.equal(duplicate.additions.length, 1);
});

test("an engine that cannot read a remote event stops the batch instead of quarantining it", () => {
  // A protocol mismatch (3) or an unreadable event (2) is not a household
  // conflict. Quarantining it would advance the sync cursor past history this
  // engine never applied; rethrowing leaves the cursor for an upgraded client.
  const valid = encodeAddedRecord({ ...context(3, 1, 1), itemId: id(0x33), text: "Buy milk", classification: "need" });
  for (const code of [2, 3]) {
    const refusing = { applyEvents() { throw Object.assign(new Error("needs a compatible household engine"), { code }); } };
    assert.throws(() => reconcileRemoteEvents({
      rows: [], received: [{ encodedEvent: valid }], engine: refusing,
      context: { last_looked_event_id: null }, asOf: 1_791_475_200_000, civilDate: 20261009,
    }), (error) => error.code === code);
  }
});

test("two devices changing one repeating task's schedule offline: equal clocks keep both replacements, later archive is quarantined", () => {
  // Known PR 53 limitation (docs/DAILY-UX-HARDENING.md): a schedule change is
  // create-replacement + archive-original, with no supersession record.
  const routine = (device, sequence, logicalTime, routineId, cadence) => encodeRoutineCreatedRecord({
    ...context(device, sequence, logicalTime), routineId: id(routineId), text: "Pack lunches", cadence, createdOn: 20261012 });
  const archive = (device, sequence, logicalTime) => encodeRoutineActionRecord({
    ...context(device, sequence, logicalTime), routineId: id(0x50), action: "archive", occurrenceKey: 20261012 });
  const original = routine(1, 1, 1, 0x50, "daily");
  const deviceA = [routine(1, 2, 2, 0x60, "weekly"), archive(1, 3, 3)];
  const replay = (received) => reconcileRemoteEvents({
    rows: [], received: received.map((encodedEvent) => ({ encodedEvent })), engine,
    context: { last_looked_event_id: null }, asOf: 1_791_475_200_000, civilDate: 20261014,
  });
  const active = (result) => engine.applyEvents(result.candidates, 1_791_475_200_000, null, 20261014)
    .routines.filter((record) => record.status !== "archived").map((record) => record.cadence).sort();

  const sameClock = [original, ...deviceA, routine(2, 2, 2, 0x70, "weekdays"), archive(2, 3, 3)];
  for (const order of [sameClock, [...sameClock].reverse()]) {
    const result = replay(order);
    assert.equal(result.quarantined, 0, "no encrypted history is dropped");
    assert.deepEqual(active(result), ["weekdays", "weekly"], "both replacements stay active, deterministically");
  }

  const laterClock = [original, ...deviceA, routine(2, 2, 4, 0x70, "weekdays"), archive(2, 3, 5)];
  for (const order of [laterClock, [...laterClock].reverse()]) {
    const result = replay(order);
    assert.equal(result.quarantined, 1, "the second archive of the same original is refused as a conflict");
    assert.deepEqual(active(result), ["weekdays", "weekly"], "both replacements still repeat after the conflict");
  }
});
