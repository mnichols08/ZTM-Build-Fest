import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
  }
  get firstElementChild() { return this.children[0] ?? null; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  insertBefore(child) { this.append(child); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  contains() { return true; }
  querySelectorAll(selector) {
    const tags = selector.split(",");
    const walk = (node) => node.children.flatMap((child) => [
      ...(tags.includes(child.tagName) ? [child] : []),
      ...walk(child),
    ]);
    return walk(this);
  }
}

globalThis.HTMLElement = class extends ElementStub {};
const components = {};
globalThis.customElements = { define: (name, component) => { components[name] = component; } };
globalThis.document = {
  createElement: (tagName) => {
    const element = new ElementStub(tagName);
    if (tagName === "kin-appearance") element.initialize = () => {};
    return element;
  },
};
await import("./kin-household-defaults.js");
const KinHouseholdDefaults = components["kin-household-defaults"];

test("admin authority that arrives after a busy pass enables the household name", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  // The app applies busy state before the settings response establishes authority.
  panel.disabled = true;
  panel.disabled = false;
  assert.equal(panel.nameInput.disabled, true, "controls stay locked without admin authority");

  panel.initialize({ admin: true, adminRecorded: true, value: null });
  assert.equal(panel.hidden, false);
  assert.equal(panel.nameInput.disabled, false, "the household name is editable for an admin");
  assert.ok(panel.querySelectorAll("button").every((control) => !control.disabled));

  panel.disabled = true;
  assert.equal(panel.nameInput.disabled, true, "busy state still locks the controls");
});

test("household defaults stay hidden and locked for non-admins", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: false, adminRecorded: true, value: null });
  panel.disabled = false;
  assert.equal(panel.hidden, true);
  assert.equal(panel.nameInput.disabled, true);
});

test("withdrawn admin authority removes shared actions and locks the household name", () => {
  const panel = new KinHouseholdDefaults();
  panel.connectedCallback();
  panel.initialize({ admin: true, adminRecorded: true, value: null });
  assert.ok(panel.querySelectorAll("button").some((control) => control.textContent === "Save household settings"));

  for (const admin of [false, undefined, null, "true"]) {
    panel.initialize({ admin, adminRecorded: true, value: null });
    assert.equal(panel.hidden, true, `${admin}: panel hidden`);
    assert.equal(panel.nameInput.disabled, true, `${admin}: name locked`);
    assert.equal(panel.querySelectorAll("button").some((control) => control.textContent === "Save household settings"), false,
      `${admin}: no stale save action`);
    panel.disabled = false;
    assert.equal(panel.nameInput.disabled, true, `${admin}: a later idle pass keeps it locked`);
    panel.initialize({ admin: true, adminRecorded: true, value: null });
    assert.equal(panel.nameInput.disabled, false, "re-granted authority restores editing");
  }
});
