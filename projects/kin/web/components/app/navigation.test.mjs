// Route changes are announced on window (ROUTE_CHANGE_EVENT), because in-app
// navigation uses history.pushState and hides views instead of removing them
// (#96: the QR scanner must stop when its view is left).
import assert from "node:assert/strict";
import test from "node:test";

const events = [];
const pushed = [];
let hash = "#today";
Object.defineProperty(globalThis, "location", { configurable: true, value: { get hash() { return hash; }, pathname: "/" } });
globalThis.history = { pushState: (_state, _title, url) => { pushed.push(url); hash = url; } };
globalThis.window = { scrollY: 0, scrollTo() {}, dispatchEvent: (event) => { events.push(event); return true; } };
globalThis.document = { title: "" };
globalThis.requestAnimationFrame = () => 0;
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };

const { NavigationController } = await import("./navigation.js");
const { ROUTE_CHANGE_EVENT } = await import("../../routes.js");

function controller() {
  const section = () => ({ hidden: false });
  const app = {
    pages: new Map([["today", section()], ["routines", section()], ["lists", section()]]),
    navLinks: new Map(),
    segmentNavs: new Map(),
    segmentPanels: new Map(),
    pageScroll: { set() {}, get: () => 0 },
    dataset: {},
    routines: {},
    search: {},
  };
  const ctx = { app, detail: { closeItemDetail() {}, mountDetail() {} } };
  ctx.navigation = new NavigationController(ctx);
  return { app, navigation: ctx.navigation };
}

test("navigating to another page announces the route change once", () => {
  events.length = 0;
  hash = "#today";
  const { app, navigation } = controller();
  navigation.showPageFromLocation(); // the first page shown is not a change
  assert.equal(events.length, 0);
  navigation.navigate("#routines");
  assert.deepEqual(pushed.at(-1), "#routines", "in-app navigation uses pushState");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, ROUTE_CHANGE_EVENT);
  assert.deepEqual(events[0].detail, { from: "today", to: "routines/all" });
  assert.equal(app.pages.get("today").hidden, true, "the view left is hidden, not removed");
});

test("showing the same route again announces nothing", () => {
  events.length = 0;
  hash = "#today";
  const { navigation } = controller();
  navigation.showPageFromLocation();
  navigation.showPageFromLocation();
  navigation.navigate("#today");
  assert.equal(events.length, 0);
});

test("a segment change within a page is a route change too", () => {
  events.length = 0;
  hash = "#lists/todo";
  const { navigation } = controller();
  navigation.showPageFromLocation();
  navigation.navigate("#lists/shopping");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail, { from: "lists/todo", to: "lists/shopping" });
});
