// Undo and redo (#315): the history, the checks before a reversal, the
// commands it appends, and the entry that reverses it again.
import assert from "node:assert/strict";
import test from "node:test";
import {
  describeReversal, inverseEntry, isOptionalStep, itemAddedEntry, itemArchivedEntry, itemDateEntry, itemStatusEntry,
  nextReversalStep, pinEntry, reversalStatus, routineArchivedEntry, routineCreatedEntry,
  routineOccurrenceEntry, UndoHistory,
} from "./undo.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const AREA = "c".repeat(32);
const ME = "d".repeat(32);
const R = "e".repeat(32);

const item = (fields = {}) => ({
  itemId: A, text: "Milk", classification: "shopping", status: "active", areaId: null,
  steps: [], planningDate: null, lastChangedAt: 100, ...fields,
});
const routine = (fields = {}) => ({
  routineId: R, text: "Walk the dog", cadence: "daily", status: "active",
  occurrenceKey: 20261020, occurrenceStatus: "open", nextOn: null, ...fields,
});
const state = ({ items = [], routines = [], pins = [], responsibilities, areas = [] } = {}) =>
  ({ items, routines, pins, areas, ...(responsibilities ? { responsibilities } : {}) });

// Applies commands to a toy projection, the way Rust would for these cases.
function apply(current, command, clock) {
  const next = structuredClone(current);
  const find = (id) => next.items.find((record) => record.itemId === id);
  const touch = (record) => { record.lastChangedAt = clock.now += 1; };
  switch (command.type) {
    case "add": next.items.push(item({ itemId: command.id, text: command.text, classification: command.classification, lastChangedAt: clock.now += 1 })); break;
    case "complete": find(command.itemId).status = "completed"; touch(find(command.itemId)); break;
    case "reopen": find(command.itemId).status = "active"; touch(find(command.itemId)); break;
    case "archive": find(command.itemId).status = "archived"; touch(find(command.itemId)); break;
    case "set-item-planning-date": find(command.itemId).planningDate = command.planningDate; touch(find(command.itemId)); break;
    case "change-item-area": find(command.itemId).areaId = command.areaId; touch(find(command.itemId)); break;
    case "add-item-step": find(command.itemId).steps.push({ stepId: command.stepId, text: command.text, completed: false, archived: false }); touch(find(command.itemId)); break;
    case "complete-item-step": find(command.itemId).steps.find((step) => step.stepId === command.stepId).completed = true; touch(find(command.itemId)); break;
    case "pin": next.pins.push({ targetKind: command.targetKind, targetId: command.targetId }); break;
    case "unpin": next.pins = next.pins.filter((pin) => pin.targetId !== command.targetId); break;
    case "change-responsibility":
      next.responsibilities = (next.responsibilities ?? []).filter((entry) => entry.targetId !== command.targetId)
        .concat([{ targetKind: command.targetKind, targetId: command.targetId, memberId: command.memberId }]);
      break;
    case "create-routine": next.routines.push(routine({ routineId: command.routineId, text: command.text, cadence: command.cadence })); break;
    case "archive-routine": Object.assign(next.routines.find((record) => record.routineId === command.routineId), { status: "archived", occurrenceKey: null, occurrenceStatus: "unavailable" }); break;
    case "complete-routine-occurrence": next.routines.find((record) => record.routineId === command.routineId).occurrenceStatus = "completed"; break;
    case "reopen-routine-occurrence": next.routines.find((record) => record.routineId === command.routineId).occurrenceStatus = "open"; break;
    default: throw new Error(`unexpected ${command.type}`);
  }
  return next;
}

/** Runs a reversal to the end; returns the new state and the commands. */
function reverse(entry, current, clock = { now: 1000 }, options = {}) {
  const commands = [];
  let next = current;
  for (let command; (command = nextReversalStep(entry, next, options));) {
    commands.push(command);
    next = apply(next, command, clock);
    assert.ok(commands.length < 30, "a reversal ends");
  }
  return { state: next, commands };
}

test("the history: record clears redo, undo and redo move between the stacks, and it is capped", () => {
  const history = new UndoHistory(3);
  for (const n of [1, 2, 3, 4]) history.record({ n });
  assert.deepEqual(history.undoStack.map((entry) => entry.n), [2, 3, 4], "the oldest falls off");
  const last = history.take("undo");
  assert.equal(last.n, 4);
  history.settle("undo", { n: -4 });
  assert.equal(history.canRedo, true);
  assert.equal(history.take("redo").n, -4);
  history.settle("redo", { n: 4 });
  assert.equal(history.undoStack.at(-1).n, 4);
  history.take("undo"); history.settle("undo", { n: -4 });
  history.record({ n: 5 });
  assert.equal(history.canRedo, false, "a new change ends redo");
  history.restore("undo", { n: 6 });
  assert.equal(history.take("undo").n, 6);
  history.clear();
  assert.equal(history.canUndo || history.canRedo, false);
  assert.equal(history.take("undo"), null);
});

test("complete ↔ reopen, refused when it changed since or is gone", () => {
  const after = state({ items: [item({ status: "completed", lastChangedAt: 200 })] });
  const entry = itemStatusEntry("complete", A, after);
  assert.equal(entry.label, "mark “Milk” done");
  assert.equal(reversalStatus(entry, after), "ready");
  const { state: undone, commands } = reverse(entry, after);
  assert.deepEqual(commands, [{ type: "reopen", itemId: A }]);
  const redo = inverseEntry(entry, after, undone);
  assert.equal(redo.label, entry.label, "redo names the same change");
  assert.deepEqual(reverse(redo, undone).commands, [{ type: "complete", itemId: A }]);
  // Someone else touched it after us.
  assert.equal(reversalStatus(entry, state({ items: [item({ status: "completed", lastChangedAt: 201 })] })), "conflict");
  assert.equal(reversalStatus(entry, state({ items: [item({ status: "active", lastChangedAt: 200 })] })), "conflict");
  assert.equal(reversalStatus(entry, state({ items: [item({ status: "archived" })] })), "gone");
  assert.equal(reversalStatus(entry, state()), "gone");
  assert.equal(itemStatusEntry("reopen", A, after).label, "reopen “Milk”");
});

test("archive is undone by creating it again with its details, and redone by archiving the new one", () => {
  const before = state({
    items: [item({ planningDate: 20261021, areaId: AREA, steps: [
      { stepId: "1".repeat(32), text: "Oat", completed: true, archived: false },
      { stepId: "2".repeat(32), text: "Gone", completed: false, archived: true },
      { stepId: "3".repeat(32), text: "Soy", completed: false, archived: false },
    ] })],
    pins: [{ targetKind: "item", targetId: A }],
    responsibilities: [{ targetKind: "item", targetId: A, memberId: ME }],
    areas: [{ areaId: AREA, name: "Kitchen", archived: false }],
  });
  const entry = itemArchivedEntry(A, before);
  assert.equal(entry.label, "archive “Milk”");
  assert.notEqual(entry.replacementId, A);
  const archived = apply(before, { type: "archive", itemId: A }, { now: 500 });
  assert.equal(reversalStatus(entry, archived), "ready");
  const { state: restored, commands } = reverse(entry, archived, { now: 600 }, { memberIds: [ME] });
  const id = entry.replacementId;
  assert.deepEqual(commands.map((command) => command.type),
    ["add", "set-item-planning-date", "change-item-area", "pin", "change-responsibility", "add-item-step", "complete-item-step", "add-item-step"]);
  const copy = restored.items.find((record) => record.itemId === id);
  assert.equal(copy.text, "Milk");
  assert.equal(copy.planningDate, 20261021);
  assert.deepEqual(copy.steps.map((step) => [step.text, step.completed]), [["Oat", true], ["Soy", false]], "archived steps stay gone");
  assert.equal(restored.items.find((record) => record.itemId === A).status, "archived", "the original stays in history");
  // A retry after a partial run resumes instead of adding a second copy.
  const partial = apply(archived, commands[0], { now: 700 });
  assert.equal(nextReversalStep(entry, partial).type, "set-item-planning-date");
  // Redo archives the new copy.
  const redo = inverseEntry(entry, archived, restored);
  assert.equal(redo.kind, "item-added");
  assert.deepEqual(reverse(redo, restored).commands, [{ type: "archive", itemId: id }]);
  // A removed member isn't made the owner again; an archived area is skipped.
  const gone = reverse(entry, { ...archived, areas: [{ areaId: AREA, name: "Kitchen", archived: true }] }, { now: 800 }, { memberIds: [] }).commands;
  assert.ok(!gone.some((command) => command.type === "change-responsibility" || command.type === "change-item-area"));
});

test("a completed item comes back completed", () => {
  const before = state({ items: [item({ status: "completed" })] });
  const entry = itemArchivedEntry(A, before);
  const { commands } = reverse(entry, apply(before, { type: "archive", itemId: A }, { now: 300 }));
  assert.deepEqual(commands.map((command) => command.type), ["add", "complete"]);
});

test("add is undone by archive, unless it changed since; redo creates it again", () => {
  const after = state({ items: [item({ lastChangedAt: 150 })] });
  const entry = itemAddedEntry(A, after);
  assert.equal(entry.label, "add “Milk”");
  assert.equal(reversalStatus(entry, after), "ready");
  const { state: undone, commands } = reverse(entry, after);
  assert.deepEqual(commands, [{ type: "archive", itemId: A }]);
  const redo = inverseEntry(entry, after, undone);
  assert.equal(redo.kind, "item-archived");
  assert.equal(reverse(redo, undone).commands[0].type, "add");
  assert.equal(reversalStatus(entry, state({ items: [item({ lastChangedAt: 151 })] })), "conflict");
});

test("a planned date goes back to the previous one, and a pin to the other state", () => {
  const before = state({ items: [item({ planningDate: 20261020 })] });
  const after = state({ items: [item({ planningDate: null, lastChangedAt: 300 })] });
  const entry = itemDateEntry(A, before, after);
  assert.equal(entry.label, "clear the date of “Milk”");
  const { state: undone, commands } = reverse(entry, after);
  assert.deepEqual(commands, [{ type: "set-item-planning-date", itemId: A, planningDate: 20261020 }]);
  assert.deepEqual(reverse(inverseEntry(entry, after, undone), undone).commands, [{ type: "set-item-planning-date", itemId: A, planningDate: null }]);
  assert.equal(reversalStatus(entry, state({ items: [item({ planningDate: 20261025, lastChangedAt: 301 })] })), "conflict");

  const pinned = state({ items: [item()], pins: [{ targetKind: "item", targetId: A }] });
  const pin = pinEntry(A, true, pinned);
  assert.equal(pin.label, "pin “Milk”");
  const { state: unpinned, commands: unpin } = reverse(pin, pinned);
  assert.deepEqual(unpin, [{ type: "unpin", targetKind: "item", targetId: A }]);
  assert.deepEqual(reverse(inverseEntry(pin, pinned, unpinned), unpinned).commands, [{ type: "pin", targetKind: "item", targetId: A }]);
  assert.equal(reversalStatus(pin, state({ items: [item()] })), "conflict", "unpinned elsewhere");
});

test("delete routine is undone by creating it again with its schedule, owner and today's completion", () => {
  const before = state({
    routines: [routine({ occurrenceStatus: "completed" })],
    responsibilities: [{ targetKind: "routine", targetId: R, memberId: ME }],
  });
  const entry = routineArchivedEntry(R, before);
  assert.equal(entry.label, "delete “Walk the dog”");
  const deleted = apply(before, { type: "archive-routine", routineId: R }, { now: 1 });
  assert.equal(reversalStatus(entry, deleted), "ready");
  const { state: restored, commands } = reverse(entry, deleted);
  assert.deepEqual(commands.map((command) => command.type), ["create-routine", "change-responsibility", "complete-routine-occurrence"]);
  assert.deepEqual(commands[0], { type: "create-routine", routineId: entry.replacementId, text: "Walk the dog", cadence: "daily" });
  assert.equal(commands[2].occurrenceKey, 20261020);
  const redo = inverseEntry(entry, deleted, restored);
  assert.equal(redo.kind, "routine-created");
  assert.equal(redo.routineId, entry.replacementId);
  assert.equal(redo.label, entry.label);
  assert.deepEqual(reverse(redo, restored).commands, [{ type: "archive-routine", routineId: entry.replacementId }]);
  // Deleted again elsewhere: nothing to bring back.
  const again = apply(restored, { type: "archive-routine", routineId: entry.replacementId }, { now: 2 });
  assert.equal(reversalStatus(entry, again), "gone");
});

test("a routine added or completed is reversed too", () => {
  const after = state({ routines: [routine()] });
  const created = routineCreatedEntry(R, after);
  assert.deepEqual(reverse(created, after).commands, [{ type: "archive-routine", routineId: R }]);
  const done = state({ routines: [routine({ occurrenceStatus: "completed" })] });
  const entry = routineOccurrenceEntry("complete-routine-occurrence", R, done);
  assert.equal(entry.label, "mark “Walk the dog” done");
  const { state: open, commands } = reverse(entry, done);
  assert.deepEqual(commands, [{ type: "reopen-routine-occurrence", routineId: R, occurrenceKey: 20261020 }]);
  assert.equal(reverse(inverseEntry(entry, done, open), open).commands[0].type, "complete-routine-occurrence");
  // A new period began: yesterday's completion is left alone.
  assert.equal(reversalStatus(entry, state({ routines: [routine({ occurrenceKey: 20261021 })] })), "conflict");
});

test("entries need the thing to exist; outcomes are described plainly", () => {
  assert.equal(itemStatusEntry("complete", B, state()), null);
  assert.equal(itemArchivedEntry(B, state()), null);
  assert.equal(routineArchivedEntry(B, state()), null);
  assert.equal(reversalStatus({ kind: "unknown" }, state()), "gone");
  const entry = { label: "mark “Milk” done" };
  assert.equal(describeReversal(entry, "undo", "done"), "Undone: mark “Milk” done.");
  assert.equal(describeReversal(entry, "redo", "done"), "Redone: mark “Milk” done.");
  assert.match(describeReversal(entry, "undo", "conflict"), /^Couldn't undo that \(mark “Milk” done\): it changed since/);
  assert.match(describeReversal(entry, "redo", "gone"), /^Couldn't redo that .*no longer here/);
  assert.equal(describeReversal(null, "undo", "empty"), "Nothing to undo.");
  assert.equal(describeReversal(null, "redo", "empty"), "Nothing to redo.");
});

test("a routine someone changed since isn't deleted by undo", () => {
  const after = state({ routines: [routine()] });
  const created = routineCreatedEntry(R, after);
  assert.equal(reversalStatus(created, after), "ready");
  assert.equal(reversalStatus(created, state({ routines: [routine({ occurrenceStatus: "completed" })] })), "conflict", "completed since");
  assert.equal(reversalStatus(created, state({ routines: [routine()], responsibilities: [{ targetKind: "routine", targetId: R, memberId: ME }] })), "conflict", "assigned since");
});

test("pin, owner and area are restored when they can be; skipped ones are passed over", () => {
  const before = state({
    items: [item({ areaId: AREA })],
    pins: [{ targetKind: "item", targetId: A }],
    responsibilities: [{ targetKind: "item", targetId: A, memberId: ME }],
    areas: [{ areaId: AREA, name: "Kitchen", archived: false }],
  });
  const entry = itemArchivedEntry(A, before);
  const archived = apply(before, { type: "archive", itemId: A }, { now: 500 });
  const skip = new Set(["pin", "change-item-area", "change-responsibility"]);
  const { commands } = reverse(entry, archived, { now: 600 }, { skip });
  assert.deepEqual(commands.map((command) => command.type), ["add"]);
  assert.equal(isOptionalStep(entry, { type: "pin" }), true);
  assert.equal(isOptionalStep(entry, { type: "add" }), false);
  assert.equal(isOptionalStep(itemStatusEntry("complete", A, state({ items: [item({ status: "completed" })] })), { type: "pin" }), false);
});
