// A child's reward on the kitchen display asks for the adult's passkey or
// password (#705): saving or removing one, and Undo or Redo of one, wait for
// the display's check (app/display.js confirmAdult, the one leaving uses);
// cancelled or refused, nothing is written. The phone's chart doesn't ask.
import assert from "node:assert/strict";
import test from "node:test";

// display.js defines <kin-kitchen-display> on import; nothing here draws it.
globalThis.HTMLElement ??= class {};
globalThis.customElements ??= { define() {}, get() {} };

const { ChoresController } = await import("./chores.js");
const { UndoController } = await import("./undo.js");
const { DisplayController } = await import("./display.js");
const { choreRewardEntry } = await import("../../undo.js");

const ME = "a".repeat(32);
const CHILD = "c".repeat(32);
const MOVIE = { goal: 20, text: "Movie night" };

/** A workspace with just what the chores, undo and display controllers use.
 * `confirm` answers the display's check: true, false, or a function. */
function workspace({ display = false, confirm = true, reward = null } = {}) {
  const appended = [];
  const statuses = [];
  const asked = [];
  const focused = [];
  const rewards = new Map([[CHILD, reward]]);
  const app = {
    displayMode: display,
    householdStatus: { memberKind: "adult" },
    hasLocalSyncBinding: true,
    busy: false,
    store: {},
    engine: {},
    state: { items: [], routines: [] },
  };
  const view = { cards: [{ memberId: CHILD, name: "Sam" }], focusReward: (memberId) => focused.push(memberId) };
  const session = { id: 1 };
  const ctx = {
    app,
    session: { captureSession: () => session, assertCurrentSession() {}, isCurrentSession: () => true },
    status: { setBusy() {}, clearAlert() {}, setStatus: (text) => statuses.push(text), showAlert: (text) => statuses.push(`alert: ${text}`) },
    append: {
      appendCommand: async (command) => {
        appended.push(command);
        if (command.type === "set-chore-reward") rewards.set(command.memberId, command.goal ? { goal: command.goal, text: command.text.trim() } : null);
      },
    },
    refresh: { captureRefreshFocus: () => null, restoreRefreshFocus() {} },
    render: { renderState() {} },
    peers: { broadcastEventChange() {}, flushPeerRefresh() {} },
    detail: { responsibilityContext: () => ({ memberId: ME, memberIds: [ME, CHILD], names: new Map() }) },
    sync: { offlineSyncSuffix: () => "" },
    display: {
      confirmAdult: async (purpose) => {
        asked.push(purpose);
        return typeof confirm === "function" ? confirm(purpose) : confirm;
      },
    },
  };
  const chores = new ChoresController(ctx);
  app.choreChart = view; // the constructor starts with none
  chores.chart = { members: [{ memberId: CHILD, reward }] };
  // The chart's own read needs Rust; the stand-in keeps the rewards here.
  chores.refresh = async () => { chores.chart = { members: [{ memberId: CHILD, reward: rewards.get(CHILD) }] }; };
  chores.rewards = async () => new Map(rewards);
  ctx.chores = chores;
  const undo = new UndoController(ctx);
  ctx.undo = undo;
  return { app, ctx, chores, undo, appended, statuses, asked, focused, rewards };
}

test("on the kitchen display, saving a reward asks first and writes once confirmed", async () => {
  const { chores, appended, asked, undo } = workspace({ display: true, confirm: true });
  const result = await chores.setReward({ memberId: CHILD, goal: 20, text: " Movie night " });
  assert.equal(result.ok, true);
  assert.deepEqual(asked, ["reward"], "the display's adult check, at the moment of saving");
  assert.deepEqual(appended, [{ type: "set-chore-reward", memberId: CHILD, goal: 20, text: " Movie night " }]);
  assert.equal(undo.history.undoStack.at(-1)?.kind, "chore-reward", "and Undo is offered");
});

test("removing a reward on the display asks too", async () => {
  const { chores, appended, asked } = workspace({ display: true, confirm: true, reward: MOVIE });
  assert.equal((await chores.setReward({ memberId: CHILD, goal: 0, text: "" })).ok, true);
  assert.deepEqual(asked, ["reward"]);
  assert.deepEqual(appended, [{ type: "set-chore-reward", memberId: CHILD, goal: 0, text: "" }]);
});

test("cancelled or refused on the display, nothing is written and nothing is offered to undo", async () => {
  for (const confirm of [false, () => { throw Object.assign(new Error("no"), { code: "unlock_failed" }); }]) {
    const { chores, appended, asked, statuses, focused, undo } = workspace({ display: true, confirm, reward: MOVIE });
    const result = await chores.setReward({ memberId: CHILD, goal: 30, text: "Park trip" });
    assert.deepEqual({ ok: result.ok, canceled: result.canceled }, { ok: false, canceled: true });
    assert.deepEqual(asked, ["reward"]);
    assert.deepEqual(appended, [], "no kind 78 event");
    assert.equal(undo.history.undoStack.length, 0);
    assert.equal(statuses.at(-1), "The reward wasn't changed.", "said calmly, not as an error");
    assert.deepEqual(focused, [CHILD], "the focus goes back to the child's reward button");
  }
});

test("the phone's chart is unchanged: no question, the reward is saved", async () => {
  const { chores, appended, asked, undo } = workspace({ display: false, confirm: false });
  assert.equal((await chores.setReward({ memberId: CHILD, goal: 20, text: "Movie night" })).ok, true);
  assert.deepEqual(asked, [], "the phone never asks");
  assert.equal(appended.length, 1);
  assert.equal(undo.history.undoStack.length, 1);
});

test("a member who may not set rewards isn't asked for a secret first", async () => {
  const { app, chores, appended, asked, statuses } = workspace({ display: true, confirm: true });
  app.householdStatus = { memberKind: "limited" };
  assert.equal((await chores.setReward({ memberId: CHILD, goal: 20, text: "Movie night" })).ok, false);
  assert.deepEqual(asked, []);
  assert.deepEqual(appended, []);
  assert.match(statuses.at(-1), /^alert: /, "the usual refusal");
});

test("Undo and Redo of a reward on the display ask too; cancelled, nothing is written and Undo stays", async () => {
  let answer = false;
  const { undo, appended, asked, statuses, rewards } = workspace({ display: true, confirm: () => answer });
  rewards.set(CHILD, MOVIE);
  undo.record(choreRewardEntry({ memberId: CHILD, name: "Sam", from: null, to: MOVIE }));

  await undo.run("undo");
  assert.deepEqual(asked, ["reward"], "Undo asks");
  assert.deepEqual(appended, [], "cancelled: nothing written");
  assert.deepEqual(rewards.get(CHILD), MOVIE);
  assert.equal(statuses.at(-1), "Not undone: the reward wasn't changed.");
  assert.equal(undo.history.undoStack.length, 1, "Undo can be pressed again");
  assert.equal(undo.running, false);

  answer = true;
  await undo.run("undo");
  assert.deepEqual(asked, ["reward", "reward"]);
  assert.deepEqual(appended, [{ type: "set-chore-reward", memberId: CHILD, goal: 0, text: "" }], "confirmed: the reward is removed again");
  assert.equal(rewards.get(CHILD), null);
  assert.equal(undo.history.redoStack.length, 1, "Redo is offered");

  answer = false;
  await undo.run("redo");
  assert.equal(appended.length, 1, "Redo asks as well; cancelled, nothing written");
  assert.equal(undo.history.redoStack.length, 1);
  answer = true;
  await undo.run("redo");
  assert.deepEqual(appended.at(-1), { type: "set-chore-reward", memberId: CHILD, goal: 20, text: "Movie night" });
  assert.deepEqual(asked, ["reward", "reward", "reward", "reward"]);
});

test("Undo of a reward on the phone doesn't ask", async () => {
  const { undo, appended, asked, rewards } = workspace({ display: false, confirm: false });
  rewards.set(CHILD, MOVIE);
  undo.record(choreRewardEntry({ memberId: CHILD, name: "Sam", from: null, to: MOVIE }));
  await undo.run("undo");
  assert.deepEqual(asked, []);
  assert.deepEqual(appended, [{ type: "set-chore-reward", memberId: CHILD, goal: 0, text: "" }]);
});

test("the display's check is the one leaving uses: the device's methods, one dialog at a time", async () => {
  const vaultId = "ab".repeat(16);
  const app = { displayMode: false, vault: { vaultId } };
  const display = new DisplayController({ app });
  app.displayMode = true;
  const shown = [];
  let answer = true;
  display.adultCheck = {
    readManifest: async () => ({ vaultId, wrappers: [{ id: "r", type: "recovery" }] }),
    dialog: async (options) => { shown.push(options); return answer; },
  };
  assert.equal(await display.confirmAdult("reward"), true);
  assert.equal(shown[0].purpose, "reward");
  assert.deepEqual(shown[0].methods, ["backup-key"], "a device from before accounts uses the backup key, as for leaving");
  assert.equal(shown[0].title, "Change a reward");
  assert.equal(shown[0].host, app);
  answer = false;
  assert.equal(await display.confirmAdult("reward"), false, "cancelled");

  // A second check while one is open is refused.
  let release;
  display.adultCheck.dialog = () => new Promise((resolve) => { release = resolve; });
  const first = display.confirmAdult("reward");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await display.confirmAdult("leave"), false);
  release(true);
  assert.equal(await first, true);

  // Not a display: nothing is asked.
  app.displayMode = false;
  const before = shown.length;
  assert.equal(await display.confirmAdult("reward"), false);
  assert.equal(shown.length, before);
});
