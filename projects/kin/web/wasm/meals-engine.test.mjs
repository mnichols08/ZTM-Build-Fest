// Meals (#333) through the real engine: JavaScript's canonical payloads are
// what Rust accepts, the meals view and Shopping plan read back, and a retry
// adds nothing twice. Needs the built kin_engine.wasm.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadKinEngine } from "./kin-engine.js";

const wasm = await readFile(new URL("./kin_engine.wasm", import.meta.url));
const engine = await loadKinEngine(`data:application/wasm;base64,${wasm.toString("base64")}`);
const id = (byte) => byte.toString(16).padStart(2, "0").repeat(16);
const asOf = 1_791_475_200_000;
const civilDate = 20261003;

function household() {
  const records = [];
  let sequence = 0;
  const run = (command) => {
    sequence += 1;
    const result = engine.executeCommand(command, {
      eventId: id(sequence), householdId: id(0xaa), actorId: id(0xbb), deviceId: id(0xcc),
      timestamp: asOf + sequence, logicalTime: BigInt(sequence),
    }, records, asOf, null, civilDate);
    records.push(result.encodedEvent);
    return result;
  };
  return { records, run };
}

test("recipes, dinners and cooks round-trip through Rust", () => {
  const home = household();
  home.run({ type: "add", id: id(0x31), text: "Milk", classification: "staple" });
  home.run({ type: "save-recipe", recipeId: id(0x71), name: "  Rice  pudding ", notes: "Serves 4\r\nStir often  ",
    ingredients: [{ text: "Milk", stapleId: id(0x31) }, { text: "Short-grain   rice" }] });
  home.run({ type: "set-dinner", date: "2026-10-05", recipeId: id(0x71), name: "Rice pudding" });
  home.run({ type: "set-dinner-cook", date: "2026-10-05", memberId: id(0x22) });
  home.run({ type: "set-dinner", date: "2026-10-06", name: "Leftovers" });
  const meals = engine.meals(home.records, asOf, civilDate);
  assert.deepEqual(meals, {
    recipes: [{ recipeId: id(0x71), name: "Rice pudding", notes: "Serves 4\nStir often", ingredients: [
      { text: "Milk", stapleId: id(0x31), staple: "active" },
      { text: "Short-grain rice", stapleId: null, staple: "none" },
    ] }],
    dinners: [
      { date: "2026-10-05", recipeId: id(0x71), cookId: id(0x22), name: "Rice pudding" },
      { date: "2026-10-06", recipeId: null, cookId: null, name: "Leftovers" },
    ],
  });
  // Rust refuses what its rules forbid, as engine errors the host can show.
  assert.throws(() => home.run({ type: "set-dinner", date: "2026-10-05", recipeId: id(0x71), name: "Rice pudding" }), (error) => error.code !== undefined);
  assert.throws(() => home.run({ type: "set-dinner-cook", date: "2026-10-09", memberId: id(0x22) }), (error) => error.code !== undefined);
  assert.throws(() => home.run({ type: "save-recipe", recipeId: id(0x72), name: "x".repeat(81) }), /at most 80/);
});

test("the Shopping plan re-adds staples, skips what is listed, and a retry adds nothing twice", () => {
  const home = household();
  home.run({ type: "add", id: id(0x31), text: "Milk", classification: "staple" });
  home.run({ type: "add", id: id(0x32), text: "bread", classification: "shopping" });
  home.run({ type: "save-recipe", recipeId: id(0x71), name: "Breakfast", ingredients: [
    { text: "Milk", stapleId: id(0x31) }, { text: "Bread" }, { text: "Jam" }, { text: "jam" },
  ] });
  home.run({ type: "set-dinner", date: "2026-10-05", recipeId: id(0x71), name: "Breakfast" });
  const plan = engine.mealShoppingPlan({ date: "2026-10-05" }, home.records, asOf, civilDate);
  assert.deepEqual(plan, [
    { outcome: "readd-staple", text: "Milk", stapleId: id(0x31) },
    { outcome: "already", text: "Bread", stapleId: null },
    { outcome: "add", text: "Jam", stapleId: null },
  ]);
  // The first addition lands, then "a failure"; the retry plans only Jam.
  home.run({ type: "add", id: id(0x41), text: "Milk", classification: "shopping" });
  const retry = engine.mealShoppingPlan({ recipeId: id(0x71) }, home.records, asOf, civilDate);
  assert.deepEqual(retry.filter((line) => line.outcome !== "already").map((line) => line.text), ["Jam"]);
  assert.throws(() => engine.mealShoppingPlan({ date: "2026-10-09" }, home.records, asOf, civilDate));
});
