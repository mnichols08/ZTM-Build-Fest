import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine, encodeAddedRecord } from "../wasm/kin-engine.js";
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
  assert.equal(engine.applyEvents(result.candidateRows.map((row) => row.encoded_event), 1_791_475_200_000, null, 20261009).items[0].text, "Buy milk");
  const reordered = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: valid }, { encodedEvent: poison }, { encodedEvent: new Uint8Array([1, 2, 3]) }],
    engine, context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(reordered.quarantined, result.quarantined);
  assert.deepEqual(reordered.candidateRows.map((row) => [...row.event_id]), result.candidateRows.map((row) => [...row.event_id]));
  const duplicate = reconcileRemoteEvents({
    rows: [], received: [{ encodedEvent: valid }, { encodedEvent: valid }], engine,
    context: contextRow, asOf: 1_791_475_200_000, civilDate: 20261009,
  });
  assert.equal(duplicate.quarantined, 0);
  assert.equal(duplicate.additions.length, 1);
});
