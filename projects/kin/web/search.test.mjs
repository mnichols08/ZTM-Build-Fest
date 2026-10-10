import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SEARCH_RESULTS, searchHouseholdRecords } from "./search.js";

const household = {
  items: [
    {
      itemId: "item-1",
      text: "Buy oat milk",
      classification: "need",
      status: "active",
      areaId: "area-kitchen",
      steps: [
        { stepId: "step-1", text: "Find oat milk", archived: false },
        { stepId: "step-2", text: "Archived milk note", archived: true },
      ],
    },
    {
      itemId: "item-2",
      text: "Oat milk stock",
      classification: "shopping",
      status: "completed",
      areaId: null,
      steps: [],
    },
    {
      itemId: "item-3",
      text: "Archived oat milk",
      classification: "shopping",
      status: "archived",
      steps: [],
    },
  ],
  handoffs: [
    { handoffId: "handoff-1", text: "Milk is in the fridge", status: "acknowledged" },
    { handoffId: "handoff-2", text: "Archived milk handoff", status: "archived" },
  ],
  talks: [
    { talkId: "talk-1", text: "Talk about oat milk", status: "open" },
    { talkId: "talk-2", text: "Resolved milk topic", status: "resolved" },
    { talkId: "talk-3", text: "Archived milk topic", status: "archived" },
  ],
  notes: [
    { noteId: "note-1", title: "Kitchen list", body: "We usually buy oat milk.", areaId: "area-kitchen", archived: false },
    { noteId: "note-2", title: "Archived milk note", body: "Old details", archived: true },
  ],
  areas: [{ areaId: "area-kitchen", name: "Kitchen", archived: false }],
};

test("search matches all active text collections case-insensitively", () => {
  const { results, totalCount } = searchHouseholdRecords({
    ...household,
    query: "  OAT MILK ",
  });

  assert.equal(totalCount, 5);
  assert.deepEqual(results.map((result) => result.kind), [
    "Item",
    "Checklist Step",
    "Item",
    "Talk",
    "Note",
  ]);
  assert.equal(results.at(-1).text, "Kitchen list");
  assert.match(results.at(-1).detail, /oat milk/i);
});

test("local search includes maintenance facts and active Reference Record fields", () => {
  const { results } = searchHouseholdRecords({
    ...household,
    query: "filter",
    referenceRecords: [{ recordId: "furnace", title: "Furnace", archived: false, fields: [{ label: "Model", value: "FilterMax" }] }],
    maintenanceEvents: [{ maintenanceId: "maint-1", recordId: "furnace", performedOn: 20260918, summary: "Filter changed", archived: false }, { maintenanceId: "old", recordId: "furnace", performedOn: 20250918, summary: "Archived filter", archived: true }],
  });
  assert.deepEqual(results.slice(-2).map(({ kind, text }) => [kind, text]), [["Reference Record", "Furnace"], ["Maintenance", "Filter changed"]]);
  assert.equal(results.at(-1).context, "Furnace · 09/18/2026");
});

test("search includes matching active checklist Steps and excludes archived records", () => {
  const { results, totalCount } = searchHouseholdRecords({
    ...household,
    query: "milk",
  });

  assert.equal(totalCount, 7);
  assert.deepEqual(
    results.filter((result) => result.kind === "Checklist Step").map((result) => result.text),
    ["Find oat milk"],
  );
  assert.equal(results.some((result) => result.text.startsWith("Archived")), false);
  assert.equal(results.some((result) => result.text === "Buy oat milk"), true);
  assert.equal(results.some((result) => result.text === "Oat milk stock"), true);
});

test("Item filters narrow Items and Steps without hiding matching other household text", () => {
  const { results, totalCount } = searchHouseholdRecords({
    ...household,
    items: [
      ...household.items,
      {
        itemId: "item-4",
        text: "Oat milk reminder",
        classification: "shopping",
        status: "active",
        areaId: "area-kitchen",
        steps: [{ stepId: "step-3", text: "Get oat milk", archived: false }],
      },
    ],
    query: "oat milk",
    classification: "shopping",
    status: "active",
    areaId: "area-kitchen",
  });

  assert.equal(totalCount, 4);
  assert.deepEqual(results.map((result) => result.kind), ["Item", "Checklist Step", "Talk", "Note"]);
  assert.equal(results[0].id, "item-4");
  assert.equal(results[1].id, "item-4:step-3");
});

test("area filter can select Items without an Area", () => {
  const { results } = searchHouseholdRecords({
    ...household,
    query: "oat milk",
    areaId: "unassigned",
  });

  assert.deepEqual(results.filter((result) => result.kind === "Item").map((result) => result.id), ["item-2"]);
});

test("empty queries do not return household text", () => {
  assert.deepEqual(searchHouseholdRecords({ ...household, query: " \t " }), {
    results: [],
    totalCount: 0,
  });
});

test("queries with no matches expose an empty result set", () => {
  assert.deepEqual(searchHouseholdRecords({ ...household, query: "not present" }), {
    results: [],
    totalCount: 0,
  });
});

test("results are bounded while the total match count remains accurate", () => {
  const items = Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, index) => ({
    itemId: `item-${index}`,
    text: `Milk ${index}`,
    classification: "need",
    status: "active",
    steps: [],
  }));
  const { results, totalCount } = searchHouseholdRecords({ items, query: "milk" });

  assert.equal(results.length, MAX_SEARCH_RESULTS);
  assert.equal(totalCount, MAX_SEARCH_RESULTS + 1);
});
