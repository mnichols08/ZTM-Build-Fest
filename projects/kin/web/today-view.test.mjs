import assert from "node:assert/strict";
import test from "node:test";
import { composeToday, describePlanningDate, formatCivilDate, nextCivilDate, ROUTINE_PERIOD_LABELS } from "./today-view.js";

const TODAY = 20261013;
const item = (overrides) => ({ itemId: Math.random().toString(16).slice(2), text: "x", classification: "need", status: "active", planningDate: null, steps: [], ...overrides });
const routine = (overrides) => ({ routineId: Math.random().toString(16).slice(2), text: "r", cadence: "daily", status: "active", occurrenceStatus: "open", occurrenceKey: TODAY, ...overrides });

test("rule A: active items planned for today keep their identity and appear once", () => {
  const task = item({ text: "Call dentist", planningDate: TODAY });
  const shopping = item({ text: "Eggs", classification: "shopping", planningDate: TODAY });
  const staple = item({ text: "Milk", classification: "staple", planningDate: TODAY });
  const view = composeToday({ items: [task, shopping, staple], civilDate: TODAY });
  assert.deepEqual(view.today.map((entry) => entry.text), ["Call dentist", "Eggs"]);
  assert.equal(view.today[1].classification, "shopping", "a shopping item stays a shopping item on Today");
  assert.equal(view.isEmpty, false);
});

test("rule B: undated legacy Today items remain on Today; an explicit date takes precedence", () => {
  const legacy = item({ text: "Legacy", classification: "today" });
  const legacyTomorrow = item({ text: "Legacy later", classification: "today", planningDate: nextCivilDate(TODAY) });
  const legacyEarlier = item({ text: "Legacy earlier", classification: "today", planningDate: 20261001 });
  const view = composeToday({ items: [legacy, legacyTomorrow, legacyEarlier], civilDate: TODAY });
  assert.deepEqual(view.today.map((entry) => entry.text), ["Legacy"]);
  assert.deepEqual(view.earlier.map((entry) => entry.text), ["Legacy earlier"]);
});

test("rule C: earlier unfinished plans are grouped oldest first and future plans are not today's work", () => {
  const old = item({ text: "Old", planningDate: 20261001 });
  const older = item({ text: "Older", planningDate: 20260930 });
  const future = item({ text: "Future", planningDate: 20261020 });
  const completedOld = item({ text: "Done old", planningDate: 20261001, status: "completed" });
  const view = composeToday({ items: [old, older, future, completedOld], civilDate: TODAY });
  assert.deepEqual(view.earlier.map((entry) => entry.text), ["Older", "Old"]);
  assert.equal(view.today.length, 0);
  assert.equal(view.completed.length, 0, "a completed earlier plan is not today's completed work");
});

test("rule D: routines use the Rust occurrence state and are grouped by period", () => {
  const daily = routine({ text: "Dishes" });
  const weekly = routine({ text: "Bins", cadence: "weekly" });
  const monthly = routine({ text: "Filters", cadence: "monthly", occurrenceStatus: "completed" });
  const unavailable = routine({ text: "Odd", cadence: "biweekly", occurrenceStatus: "unavailable" });
  const archived = routine({ text: "Gone", status: "archived" });
  const view = composeToday({ items: [], routines: [daily, weekly, monthly, unavailable, archived], civilDate: TODAY });
  assert.deepEqual(view.routineGroups.map((group) => [group.label, group.routines.map((entry) => entry.text)]), [["Today", ["Dishes"]], ["This week", ["Bins"]]]);
  assert.deepEqual(view.completedRoutines.map((entry) => entry.text), ["Filters"]);
  assert.equal(view.routinesPaused, false);
  assert.equal(ROUTINE_PERIOD_LABELS.biweekly, "This two-week period");
});

test("rule D: a non-Normal mode pauses every occurrence without hiding that routines exist", () => {
  const view = composeToday({ items: [], routines: [routine()], mode: "vacation", civilDate: TODAY });
  assert.equal(view.routineGroups.length, 0);
  assert.equal(view.completedRoutines.length, 0);
  assert.equal(view.routinesPaused, true);
  assert.equal(view.hasRoutines, true);
  assert.equal(view.isEmpty, false);
});

test("rule E: quick access is separate and may repeat an item; waiting handoffs are counted", () => {
  const pinned = item({ text: "Pinned", planningDate: TODAY });
  const archivedPin = item({ text: "Archived", status: "archived" });
  const view = composeToday({
    items: [pinned, archivedPin],
    pins: [{ targetKind: "item", targetId: pinned.itemId }, { targetKind: "item", targetId: archivedPin.itemId }, { targetKind: "note", targetId: "n" }],
    handoffs: [{ status: "unacknowledged" }, { status: "acknowledged" }, { status: "archived" }, { status: "unacknowledged" }],
    civilDate: TODAY,
  });
  assert.deepEqual(view.quickAccess.map((entry) => entry.text), ["Pinned"]);
  assert.deepEqual(view.today.map((entry) => entry.text), ["Pinned"]);
  assert.equal(view.waitingHandoffs, 2);
});

test("completed content is collected separately and archived records never appear", () => {
  const doneToday = item({ text: "Done", planningDate: TODAY, status: "completed" });
  const doneLegacy = item({ text: "Done legacy", classification: "today", status: "completed" });
  const archived = item({ text: "Archived", planningDate: TODAY, status: "archived" });
  const view = composeToday({ items: [doneToday, doneLegacy, archived], civilDate: TODAY });
  assert.deepEqual(view.completed.map((entry) => entry.text), ["Done", "Done legacy"]);
  assert.equal(view.today.length, 0);
  assert.equal(view.isEmpty, true);
});

test("the composition requires an explicit civil date", () => {
  assert.throws(() => composeToday({ items: [] }), TypeError);
});

test("planning date descriptions are calm and relative", () => {
  assert.equal(describePlanningDate(null, TODAY), null);
  assert.equal(describePlanningDate(TODAY, TODAY), "Planned for today");
  assert.equal(describePlanningDate(nextCivilDate(TODAY), TODAY), "Planned for tomorrow");
  assert.match(describePlanningDate(20261001, TODAY), /^Planned for .*, still open$/);
  assert.match(describePlanningDate(20261120, TODAY), /^Planned for /);
  assert.doesNotMatch(describePlanningDate(20261001, TODAY), /overdue|late/i);
  assert.equal(nextCivilDate(20261231), 20270101);
  assert.equal(typeof formatCivilDate(TODAY), "string");
});
