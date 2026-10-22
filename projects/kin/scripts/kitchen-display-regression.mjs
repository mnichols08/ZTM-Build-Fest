// Kitchen display mode (#669: #670, #671, #672, ADR 0022 §4) in a real
// browser, through the real store and engine. Runs from Node over CDP (it
// changes the viewport to tablet sizes); each page step is serialized.
//
// With a household that has an event today, a child's chore, a dinner and
// something to buy: an Adult turns this device into a kitchen display from
// Household › Overview; the panels show (today, the week, meals, the chore
// chart, shopping, the fridge, recent messages) and nothing private or
// administrative does (the journal, Just for me, Search, Household
// settings, navigation); routes stay on the display and auto-lock doesn't
// apply; a household feature switched off takes its panel away; ticking the
// child's chore earns the child's point; shopping adds and ticks; the
// screen goes to the screensaver when quiet and dims at night, and a touch
// brings it back; offline says so; it lays out for portrait and landscape
// tablets with 64px targets; locking and unlocking opens the display again;
// and leaving needs the device's own secret (this household's backup key,
// as it has no password or passkey), refusing a wrong one.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";

/** In the page: the household's things and entering display mode. */
async function enterDisplay() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => { if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message, detail) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, `Timed out: ${message}`, typeof detail === "function" ? detail() : detail);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh, "the work settles");
  const me = app.ctx.detail.responsibilityContext().memberId;
  // Not the chore chart suite's child: this one starts the week at 0 points.
  const child = "ce".repeat(16);
  const tag = crypto.randomUUID().slice(0, 6);
  const simulate = () => {
    app.activeMemberIds = [me, child];
    app.activeMemberKinds = new Map([[me, "adult"], [child, "limited"]]);
  };
  window.__kitchen = { tag, child, saved: { ids: app.activeMemberIds, kinds: app.activeMemberKinds } };
  simulate();
  // Something on every panel.
  const today = app.ctx.calendar.today();
  const eventTitle = `Swim club ${tag}`;
  const saved = await app.ctx.calendar.save({ draft: { title: eventTitle, allDay: true, start: { date: today, minute: 0 }, end: { date: today, minute: 0 }, zone: "", attendees: [me], place: "", notes: "", repeat: null, countdown: false } });
  check(saved?.ok !== false, "the event is saved", saved);
  await idle();
  const dinner = `Kitchen pie ${tag}`;
  await app.ctx.meals.setDinner({ date: app.ctx.meals.today(), name: dinner });
  await idle();
  const chore = `Feed the fish ${tag}`;
  await app.ctx.routines.saveRoutine({ type: "create-routine", text: chore, cadence: "daily" });
  await idle();
  const routineId = app.state.routines.find((routine) => routine.text === chore).routineId;
  await app.ctx.append.appendCommand({ type: "change-responsibility", targetKind: "routine", id: routineId, memberId: child });
  const milk = `Oat milk ${tag}`;
  await app.ctx.append.appendCommand({ type: "add", id: crypto.randomUUID().replaceAll("-", ""), text: milk, classification: "shopping" });
  await idle();
  app.ctx.render.renderState();
  Object.assign(window.__kitchen, { eventTitle, dinner, chore, routineId, milk });

  // Household › Overview offers it to an Adult, and says what it hides.
  app.ctx.navigation.navigate("#household/hub");
  const setup = app.displaySetup;
  await until(() => setup?.isConnected && setup.getClientRects().length > 0, "the setup shows on Household › Overview");
  check(app.ctx.display.available(), "an Adult's device may be a kitchen display", { kind: app.ctx.chores.memberKind });
  check(/never shows your journal, Just for me, your reminders, Search, Household settings/.test(setup.textContent), "it says what the display never shows");
  check(/password or passkey/.test(setup.textContent), "and that leaving needs the password or passkey");
  setup.querySelector("#display-idle-minutes").value = "1";
  setup.querySelector(".display-setup-start").click();
  await until(() => document.documentElement.dataset.kinDisplay === "on" && app.kitchenDisplay?.isConnected, "display mode starts");
  simulate();
  app.ctx.render.renderState();
  await idle();
  return { eventTitle, dinner, chore, milk };
}

/** In the page: panels, private things, routes, auto-lock, features. */
async function checkPanels({ eventTitle, dinner, chore, milk }) {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => { if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message, detail) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, `Timed out: ${message}`, typeof detail === "function" ? detail() : detail);
  };
  const visible = (node) => Boolean(node) && node.isConnected && node.getClientRects().length > 0 && !node.closest("[hidden]");
  const display = app.kitchenDisplay;
  const panel = (id) => display.querySelector(`.display-panel[data-panel="${id}"]`);
  for (const id of ["today", "week", "meals", "chores", "shopping", "fridge", "chat"])
    await until(() => visible(panel(id)), `the ${id} panel shows`, () => [...display.querySelectorAll(".display-panel")].map((node) => node.dataset.panel));
  await until(() => panel("today").textContent.includes(eventTitle), "today's event shows", () => panel("today").textContent);
  await until(() => panel("week").textContent.includes(eventTitle) && panel("week").querySelectorAll(".cal-strip-day").length === 7, "the week strip shows it too", () => panel("week").textContent);
  check(!panel("week").querySelector(".cal-add") || !visible(panel("week").querySelector(".cal-add")), "the week can't add events");
  await until(() => panel("meals").textContent.includes(dinner), "tonight's dinner shows", () => panel("meals").textContent);
  const child = window.__kitchen.child;
  const card = () => panel("chores").querySelector(`.chore-card[data-member-id="${child}"]`);
  await until(() => card()?.textContent.includes(chore), "the child's chore shows on their card", () => panel("chores").textContent);
  check(card().style.getPropertyValue("--chore-colour").trim().startsWith("#"), "in the child's colour");
  check(!panel("chores").querySelector(".chore-reward-toggle"), "no reward editing on the display");
  await until(() => panel("shopping").textContent.includes(milk), "the shopping list shows", () => panel("shopping").textContent);
  check(!panel("chat").querySelector("form, textarea, input"), "recent messages are read-only");
  check(display.querySelector("h1")?.textContent.length > 0, "the display has a heading");

  // Nothing private or administrative, and no way out but Leave.
  for (const selector of ["kin-journal", "kin-just-for-me", "kin-search", "kin-household-features", "kin-household", "kin-security", "kin-chat-policy", ".site-header", ".primary-nav", "kin-quick-add", ".header-lock", "kin-chat .chat-input, #chat-text", ".report-button"])
    check(![...document.querySelectorAll(selector)].some(visible), `${selector} isn't on the display`);
  app.ctx.navigation.navigate("#journal");
  check(location.hash === "#today" && visible(display), "a route elsewhere stays on the display", location.hash);
  app.ctx.navigation.navigate("#household/features");
  check(location.hash === "#today" && visible(display), "Household settings can't be reached", location.hash);
  app.ctx.detail.openItemDetail(app.state.items.find((item) => item.text === milk).itemId);
  check(!app.selection, "item details don't open");
  // Auto-lock doesn't apply while it is a display.
  const minutes = app.autoLockMinutes;
  app.autoLockMinutes = 5;
  app.ctx.session.scheduleAutoLock();
  check(app.autoLockTimer === null && app.lastActivityAt === null, "auto-lock doesn't run on a kitchen display");
  app.autoLockMinutes = minutes;

  // A household feature switched off takes its panel away, and back.
  const features = app.ctx.features;
  const before = { off: features.off, revision: features.revision };
  const { withFeature } = await import("/features.js");
  features.changed({ off: withFeature(before.off, "meals", false), revision: before.revision + 1 });
  await until(() => !visible(panel("meals")), "Meals off: its panel goes");
  check(visible(panel("today")) && visible(panel("chores")), "the others stay");
  features.changed({ off: before.off, revision: before.revision + 2 });
  await until(() => visible(panel("meals")), "Meals on again: its panel is back");
  return true;
}

/** In the page: ticking, shopping, screensaver, night, offline. */
async function useDisplay() {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => { if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message, detail) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, `Timed out: ${message}`, typeof detail === "function" ? detail() : detail);
  };
  const idle = () => until(() => !app.busy && !app.refreshing && !app.pendingRefresh, "the work settles");
  const display = app.kitchenDisplay;
  const panel = (id) => display.querySelector(`.display-panel[data-panel="${id}"]`);
  const { child, routineId, milk, tag } = window.__kitchen;
  const card = () => panel("chores").querySelector(`.chore-card[data-member-id="${child}"]`);
  const row = () => [...(card()?.querySelectorAll(".chore-row") ?? [])].find((node) => node.dataset.key.startsWith(`routine:${routineId}:`));

  // Ticking the child's chore earns the child's point.
  check(card().querySelector(".chore-points").textContent === "0 points this week", "no points yet", card().querySelector(".chore-points").textContent);
  row().querySelector("input.chore-box").click();
  await idle();
  await until(() => card()?.querySelector(".chore-points")?.textContent === "1 point this week", "ticking on the display earns the child's point", () => card()?.textContent);
  check(row().classList.contains("is-done"), "the chore shows done");

  // Shopping: add with the big box, tick off with the big row.
  const shopping = panel("shopping");
  const bread = `Bread ${tag}`;
  shopping.querySelector(".display-shopping-add input").value = bread;
  shopping.querySelector(".display-shopping-add").requestSubmit();
  await idle();
  await until(() => shopping.textContent.includes(bread), "something added on the display is on the list", () => shopping.textContent);
  check(shopping.querySelector(".display-shopping-add input").value === "", "the box empties");
  const milkRow = () => [...shopping.querySelectorAll(".display-shopping-row")].find((node) => node.textContent === milk);
  milkRow().querySelector("input").click();
  await idle();
  await until(() => !milkRow(), "a ticked item leaves the list");
  check(app.state.items.find((item) => item.text === milk)?.status === "completed", "and is done");

  // Quiet: the screensaver; a touch brings the panels back without
  // touching what is beneath.
  check(app.ctx.display.settings.idleMinutes === 1, "the chosen quiet minutes are kept");
  app.ctx.display.idle.sleep();
  await until(() => display.screensaver && !display.querySelector(".display-screensaver").hidden, "the screensaver shows after the quiet minutes");
  const saver = display.querySelector(".display-screensaver");
  const kind = display.screensaver.tagName.toLowerCase();
  check(kind === "kin-photo-frame" || display.screensaver.classList.contains("display-clock"), "family photos, or a clock with no photos", kind);
  check(getComputedStyle(saver).position === "fixed", "it covers the screen");
  const breadBefore = app.state.items.find((item) => item.text === bread)?.status;
  saver.firstElementChild.click();
  await until(() => !display.screensaver && saver.hidden, "a touch brings the panels back");
  check(app.state.items.find((item) => item.text === bread)?.status === breadBefore, "the waking touch didn't tick anything");
  check(!app.ctx.display.idle.idle, "and the quiet timer starts again");

  // Night: dimmed on the schedule, a touch wakes it.
  app.ctx.display.applyNight(true);
  check(display.night && !display.querySelector(".display-dimmer").hidden && document.documentElement.dataset.kinDisplayNight === "on", "it dims at night");
  display.querySelector(".display-dimmer").click();
  await until(() => !display.night, "a touch wakes it");
  check(app.ctx.display.nightWoken === true || !app.ctx.display.dark, "and it stays awake until quiet again");
  app.ctx.display.followNight();

  // The screen is kept on where the browser allows.
  check(app.ctx.display.wake && app.ctx.display.wake.wanted === app.ctx.display.wake.supported, "the display asks to keep the screen on", { supported: app.ctx.display.wake?.supported });

  // Offline: the last known state, said plainly.
  window.dispatchEvent(new Event("offline"));
  app.ctx.render.renderState();
  await until(() => !display.querySelector(".display-notice").hidden, "offline is said");
  check(/last knew/.test(display.querySelector(".display-notice").textContent) && panel("shopping").textContent.includes(bread), "and the panels keep what they showed");
  window.dispatchEvent(new Event("online"));
  app.offline = false;
  app.ctx.render.renderState();
  await until(() => display.querySelector(".display-notice").hidden, "online again");
  window.__kitchen.bread = bread;
  return true;
}

/** In the page: the layout at the current viewport. */
function measureLayout() {
  const app = document.querySelector("kin-app");
  const display = app.kitchenDisplay;
  const box = (region) => display.querySelector(`.display-region[data-region="${region}"]`)?.getBoundingClientRect();
  const small = [];
  for (const node of display.querySelectorAll(".display-tools button, .display-shopping-add button, .display-shopping-add input, .display-shopping-row label, .chore-tick")) {
    const rect = node.getBoundingClientRect();
    if (rect.width && (rect.height < 63.5 || rect.width < 63.5)) small.push(`${node.className || node.tagName}:${Math.round(rect.width)}x${Math.round(rect.height)}`);
  }
  const now = box("now"), lists = box("lists"), chores = box("chores"), week = box("week");
  return {
    scroll: document.documentElement.scrollWidth <= innerWidth,
    small,
    nowLeftOfLists: now.right <= lists.left + 1,
    choresBelowNow: chores.top >= now.bottom - 1,
    choresBesideNow: Math.abs(chores.top - now.top) < 2,
    weekOnTop: week.bottom <= Math.min(now.top, chores.top) + 1,
    fontSize: parseFloat(getComputedStyle(display).fontSize),
    timeSize: parseFloat(getComputedStyle(display.querySelector(".display-time")).fontSize),
  };
}

/** In the page: leaving needs the secret; the display comes back after an
 * unlock while it is on, and not after leaving. */
async function leaveDisplay(recovery) {
  const app = document.querySelector("kin-app");
  const check = (condition, message, detail) => { if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const until = async (test, message, detail) => {
    for (let index = 0; index < 900; index++) { if (test()) return; await frame(); }
    check(false, `Timed out: ${message}`, typeof detail === "function" ? detail() : detail);
  };
  const ready = () => until(() => app.store && app.state && !app.busy && !app.security.busy, "Kin is unlocked again");

  // Locking and unlocking: still a kitchen display.
  app.ctx.session.lockHousehold();
  await until(() => document.documentElement.dataset.kinDisplay === undefined, "a lock puts the display away");
  await app.security.run(() => app.security.unlockRecovery(recovery));
  await ready();
  await until(() => document.documentElement.dataset.kinDisplay === "on" && app.kitchenDisplay?.isConnected, "unlocking opens the display again");

  // Leave: Cancel stays.
  const display = app.kitchenDisplay;
  const dialog = () => app.querySelector(".display-leave-dialog");
  display.querySelector(".display-leave").click();
  await until(() => dialog()?.open, "Leave asks who you are");
  check(/Only the adult this device belongs to can leave/.test(dialog().textContent) && /backup key/.test(dialog().textContent), "and says with what", dialog().textContent);
  dialog().querySelector(".display-leave-cancel").click();
  await until(() => !dialog(), "Stay in display mode closes it");
  check(document.documentElement.dataset.kinDisplay === "on", "still a display");

  // A wrong secret is refused.
  let reloaded = 0;
  app.ctx.display.reload = () => { reloaded += 1; };
  display.querySelector(".display-leave").click();
  await until(() => dialog()?.open, "Leave asks again");
  dialog().querySelector('[data-method="backup-key"]').click();
  const input = () => dialog().querySelector(".display-leave-form input");
  await until(() => !dialog().querySelector(".display-leave-form").hidden && document.activeElement === input(), "the secret box opens with the focus");
  input().value = "ab".repeat(32);
  dialog().querySelector(".display-leave-form").requestSubmit();
  await until(() => /didn't work/.test(dialog()?.querySelector(".display-leave-message")?.textContent ?? ""), "a wrong key is refused", () => dialog()?.textContent);
  check(reloaded === 0 && app.ctx.display.settings.on && document.documentElement.dataset.kinDisplay === "on", "and nothing changes");
  input().value = recovery;
  dialog().querySelector(".display-leave-form").requestSubmit();
  await until(() => reloaded === 1, "the right key leaves", () => dialog()?.textContent);
  check(!dialog() && app.ctx.display.settings.on === false, "the device isn't a display any more");
  delete app.ctx.display.reload;

  // The reload rebuilds the full layout; here, a lock and unlock do.
  app.ctx.session.lockHousehold();
  await app.security.run(() => app.security.unlockRecovery(recovery));
  await ready();
  check(document.documentElement.dataset.kinDisplay === undefined && !app.kitchenDisplay && app.pages.has("household"), "after leaving, Kin opens as usual");
  check(app.autoLockTimer !== null || !app.autoLockMinutes, "auto-lock applies again");

  // Tidy up what this suite added.
  const { routineId, milk, bread, saved } = window.__kitchen;
  for (const text of [milk, bread]) {
    const item = app.state.items.find((entry) => entry.text === text && entry.status !== "archived");
    if (item) { await app.ctx.items.handleItemAction("archive", item.itemId); await until(() => !app.busy, "archived"); }
  }
  await app.ctx.routines.saveRoutine({ type: "archive-routine", routineId });
  await until(() => !app.busy, "archived");
  app.activeMemberIds = saved.ids;
  app.activeMemberKinds = saved.kinds;
  app.ctx.undo.clear();
  app.ctx.render.renderState();
  app.ctx.navigation.navigate("#today");
  delete window.__kitchen;
  return true;
}

export async function kitchenDisplayRegressions(client, { until, recovery }) {
  const run = (fn, arg) => client.evaluate(`(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`);
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  try {
    const things = await run(enterDisplay);
    assert.equal(await run(checkPanels, things), true);
    assert.equal(await run(useDisplay), true);
    // A 10" tablet held sideways: the week on top, three columns.
    const landscape = await run(measureLayout);
    assert.deepEqual({ scroll: landscape.scroll, small: landscape.small, side: landscape.nowLeftOfLists, beside: landscape.choresBesideNow, week: landscape.weekOnTop },
      { scroll: true, small: [], side: true, beside: true, week: true }, `landscape tablet layout: ${JSON.stringify(landscape)}`);
    assert.ok(landscape.fontSize >= 18 && landscape.timeSize >= 40, `readable from across the kitchen: ${JSON.stringify(landscape)}`);
    // Upright: the chart below today and the lists.
    await setViewport(client, { width: 800, height: 1280, deviceScaleFactor: 1, mobile: false });
    await until(() => client.evaluate(`innerHeight > innerWidth`));
    const portrait = await run(measureLayout);
    assert.deepEqual({ scroll: portrait.scroll, small: portrait.small, side: portrait.nowLeftOfLists, below: portrait.choresBelowNow, week: portrait.weekOnTop },
      { scroll: true, small: [], side: true, below: true, week: true }, `portrait tablet layout: ${JSON.stringify(portrait)}`);
    assert.equal(await run(leaveDisplay, recovery), true);
  } finally {
    await client.send("Emulation.clearDeviceMetricsOverride");
  }
  return "PASS kitchen display: set up from Household by an Adult; today, the week, meals, the child's chores in colour, shopping, the fridge and read-only messages, with nothing private or admin; routes and auto-lock held; a switched-off feature hides its panel; ticking earns the child's point; shopping adds and ticks; screensaver and night dimming wake on touch; offline keeps the last state; portrait and landscape tablets with 64px targets; unlock reopens it; leaving needs the device's secret (#669)";
}
