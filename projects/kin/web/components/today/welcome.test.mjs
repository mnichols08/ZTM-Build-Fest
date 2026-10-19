// #263: a first-use welcome that explains Kin, offers one action, and never
// shows again once dismissed here or once the household has anything.
import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
globalThis.document = { createElement: (tagName) => new ElementStub(tagName) };
const { WELCOME_DISMISSED_KEY, createWelcome, readWelcomeDismissed, welcomeVisible, writeWelcomeDismissed } = await import("./welcome.js");

test("the welcome shows only for an unused household that hasn't dismissed it", () => {
  assert.equal(welcomeVisible({}), true);
  assert.equal(welcomeVisible({ hasItems: true }), false);
  assert.equal(welcomeVisible({ hasRoutines: true }), false);
  assert.equal(welcomeVisible({ dismissed: true }), false);
});

test("dismissal is a device-local preference that tolerates unavailable storage", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readWelcomeDismissed(storage), false);
  writeWelcomeDismissed(storage);
  assert.equal(values.get(WELCOME_DISMISSED_KEY), "1");
  assert.equal(readWelcomeDismissed(storage), true);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readWelcomeDismissed(blocked), false);
  assert.doesNotThrow(() => writeWelcomeDismissed(blocked));
  assert.equal(readWelcomeDismissed(null), false);
});

test("the card explains Kin plainly and offers one start and one dismiss action", () => {
  const started = [], dismissed = [];
  const card = createWelcome({ onStart: (opener) => started.push(opener), onDismiss: () => dismissed.push(true) });
  const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
  const nodes = all(card);
  assert.equal(nodes.find((node) => node.tagName === "h2").textContent, "Welcome home");
  assert.equal(card.attributes["aria-labelledby"], "today-welcome-title");
  const text = nodes.map((node) => node.textContent).join(" ");
  assert.match(text, /private to your household/);
  assert.match(text, /To do:.*Shopping:.*Updates:/s);
  const buttons = nodes.filter((node) => node.tagName === "button");
  assert.deepEqual(buttons.map((button) => button.textContent), ["Add your first item", "Got it"]);
  buttons[0].listeners.click();
  buttons[1].listeners.click();
  assert.deepEqual(started, [buttons[0]], "the start action opens capture from its own button");
  assert.deepEqual(dismissed, [true]);
  assert.equal(createWelcome({ disabled: true }).children.at(-1).children[0].disabled, true, "locked or busy: no start");
});
