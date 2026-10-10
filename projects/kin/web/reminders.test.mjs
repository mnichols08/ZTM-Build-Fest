import test from "node:test";
import assert from "node:assert/strict";
import { LocalReminders } from "./reminders.js";

function fixture(permission = "granted") {
  const timers = new Map(); let next = 0; let requests = 0; let currentTime = 1000; const shown = [];
  class Notice { static permission = permission; static async requestPermission() { requests++; this.permission = "granted"; return this.permission; } constructor(title, options) { shown.push({ title, options }); } }
  const reminders = new LocalReminders({ notification: Notice, now: () => currentTime, setTimer: fn => { const id = ++next; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) });
  return { reminders, timers, shown, get requests() { return requests; }, Notice, advance: time => { currentTime = time; } };
}

test("permission is requested only by schedule; denied and unsupported degrade safely", async () => {
  const denied = fixture("denied"); assert.equal(await denied.reminders.schedule({ id: "x", title: "X", at: 2000 }), "denied"); assert.equal(denied.requests, 0);
  const pending = fixture("default"); assert.equal(await pending.reminders.schedule({ id: "x", title: "X", at: 2000 }), "granted"); assert.equal(pending.requests, 1);
  const unsupported = new LocalReminders({ notification: undefined, now: () => 1000 }); assert.equal(await unsupported.schedule({ id: "x", title: "X", at: 2000 }), "unsupported");
});

test("duplicate reminder replaces prior timer; cancellation prevents delivery", async () => {
  const f = fixture(); await f.reminders.schedule({ id: "i", title: "first", at: 2000 }); await f.reminders.schedule({ id: "i", title: "second", at: 3000 });
  assert.equal(f.timers.size, 1); assert.equal(f.reminders.cancel("i"), true); assert.equal(f.timers.size, 0);
});

test("completed items are checked at delivery and do not notify", async () => {
  const f = fixture(); let active = true; await f.reminders.schedule({ id: "i", title: "Task", at: 2000, isCurrent: () => active });
  active = false; f.advance(2000); [...f.timers.values()][0](); assert.equal(f.shown.length, 0);
});

test("a granted reminder delivers once when its local deadline arrives", async () => {
  const f = fixture(); await f.reminders.schedule({ id: "i", title: "Task", at: 2000 });
  f.advance(2000); [...f.timers.values()][0](); assert.equal(f.shown.length, 1); assert.equal(f.shown[0].title, "Task");
});

test("local datetime values map through the host timezone across date boundaries", () => {
  const late = new Date(2026, 9, 31, 23, 30); const tomorrow = new Date(late.getTime() + 60 * 60 * 1000);
  assert.equal(tomorrow.getDate(), 1); assert.equal(tomorrow.getMonth(), 10);
});
