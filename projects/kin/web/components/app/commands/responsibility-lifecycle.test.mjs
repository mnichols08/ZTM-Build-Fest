import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
globalThis.document = { activeElement: null };

const { ItemCommands } = await import("./items.js");

function harness(appendCommand = async () => {}) {
  const order = [];
  const alerts = [];
  const app = {
    busy: false,
    pendingRefresh: false,
    store: {},
    engine: {},
    syncCoordinator: { syncNow() { order.push("sync"); } },
  };
  const ctx = {
    app,
    append: {
      async appendCommand(command) {
        order.push("append");
        await appendCommand(command, app);
      },
    },
    session: {
      captureSession: () => ({ generation: 1 }),
      assertCurrentSession() { order.push("assert"); },
      isCurrentSession: () => true,
    },
    status: {
      setBusy(value) { app.busy = value; order.push(`busy:${value}`); },
      clearAlert() {},
      showAlert(message) { alerts.push(message); },
    },
    render: { renderState() { order.push("render"); } },
    peers: {
      broadcastEventChange() { order.push("broadcast"); },
      flushPeerRefresh() { order.push(`flush:${app.pendingRefresh}`); app.pendingRefresh = false; },
    },
  };
  ctx.items = new ItemCommands(ctx);
  return { alerts, app, ctx, order };
}

function change(ctx) {
  return ctx.items.handleChangeResponsibility({
    detail: { targetKind: "item", targetId: "item-1", memberId: "member-1" },
  });
}

test("a responsibility change renders its committed projection and flushes deferred refresh", async () => {
  const { app, ctx, order } = harness(async (_command, currentApp) => {
    currentApp.pendingRefresh = true;
  });

  await change(ctx);

  assert.equal(app.busy, false);
  assert.equal(app.pendingRefresh, false);
  assert.deepEqual(order, [
    "busy:true", "append", "assert", "render", "broadcast", "sync", "busy:false", "flush:true",
  ]);
});

test("a stale responsibility command requests and flushes an authoritative refresh", async () => {
  const conflict = Object.assign(new Error("stale responsibility"), { code: 4, userMessage: "That responsibility changed." });
  const { alerts, app, ctx, order } = harness(async () => { throw conflict; });

  await change(ctx);

  assert.equal(app.busy, false);
  assert.equal(app.pendingRefresh, false);
  assert.deepEqual(alerts, ["That responsibility changed."]);
  assert.deepEqual(order, ["busy:true", "append", "busy:false", "flush:true"]);
});

test("an unavailable workspace refuses a responsibility command", async () => {
  const { app, ctx, order } = harness();
  app.busy = true;

  await change(ctx);

  assert.deepEqual(order, []);
});
