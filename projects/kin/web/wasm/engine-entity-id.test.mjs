// Issue #171, through the real engine: notes and references in an area, and
// maintenance linked to a routine, keep their own identities. Before the fix
// each took the area's or routine's ID, so the second save failed replay and
// an update could edit the wrong entity.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const hex = (n) => n.toString(16).padStart(2, "0").repeat(16);
const DAY = 20261009;
const AS_OF = 1_791_475_200_000;
const context = (n) => ({ eventId: hex(n), householdId: hex(1), actorId: hex(2), deviceId: hex(3), timestamp: AS_OF + n, logicalTime: BigInt(n) });

function household() {
  const records = [];
  let sequence = 100;
  const run = (command) => {
    const result = engine.executeCommand(command, context(++sequence), records, AS_OF + 1_000, null, DAY);
    records.push(result.encodedEvent);
    return result.state;
  };
  return run;
}

test("two notes in one area save as two notes, and an update edits only its own note", () => {
  const run = household();
  const area = hex(10), first = hex(11), second = hex(12);
  run({ type: "create-area", areaId: area, name: "Kitchen" });
  run({ type: "create-note", noteId: first, id: first, title: "Wi-Fi", body: "hall", areaId: area });
  run({ type: "create-note", noteId: second, id: second, title: "Spare key", body: "hook", areaId: area });
  const state = run({ type: "update-note", noteId: second, id: second, title: "Spare key", body: "drawer", areaId: area });
  const notes = Object.fromEntries(state.notes.map((note) => [note.noteId, note]));
  assert.deepEqual(Object.keys(notes).sort(), [first, second]);
  assert.equal(notes[first].body, "hall");
  assert.equal(notes[second].body, "drawer");
  assert.equal(notes[first].areaId, area);
  assert.equal(notes[second].areaId, area);
  assert.equal(state.notes.some((note) => note.noteId === area), false);
});

test("two reference records in one area stay distinct", () => {
  const run = household();
  const area = hex(20), furnace = hex(21), boiler = hex(22);
  run({ type: "create-area", areaId: area, name: "Basement" });
  run({ type: "save-reference-record", recordId: furnace, id: furnace, title: "Furnace", areaId: area, fields: [{ fieldId: hex(23), label: "Model", value: "A1" }] });
  const state = run({ type: "save-reference-record", recordId: boiler, id: boiler, title: "Boiler", areaId: area, fields: [{ fieldId: hex(24), label: "Model", value: "B2" }] });
  assert.deepEqual(state.referenceRecords.map(({ recordId, title, areaId }) => [recordId, title, areaId]).sort(), [
    [furnace, "Furnace", area],
    [boiler, "Boiler", area],
  ].sort());
});

test("two maintenance entries linked to one routine stay distinct", () => {
  const run = household();
  const routine = hex(30), record = hex(31), first = hex(32), second = hex(33);
  run({ type: "create-routine", routineId: routine, text: "Change filter", cadence: "daily" });
  run({ type: "save-reference-record", recordId: record, id: record, title: "Furnace", fields: [{ fieldId: hex(34), label: "Filter", value: "16x25" }] });
  run({ type: "save-maintenance-event", maintenanceId: first, id: first, recordId: record, performedOn: 20260901, summary: "Filter changed", nextOn: null, routineId: routine });
  const state = run({ type: "save-maintenance-event", maintenanceId: second, id: second, recordId: record, performedOn: 20261001, summary: "Filter changed again", nextOn: null, routineId: routine });
  assert.deepEqual(state.maintenanceEvents.map(({ maintenanceId, summary, routineId }) => [maintenanceId, summary, routineId]), [
    [first, "Filter changed", routine],
    [second, "Filter changed again", routine],
  ]);
});
