import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.textContent = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
  }
  get firstElementChild() { return this.children.find((child) => child.tagName !== "#text") ?? null; }
  append(...children) {
    for (const value of children) {
      const child = typeof value === "string" ? Object.assign(new ElementStub("#text"), { textContent: value }) : value;
      child.parent = this; this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  dispatchEvent(event) { this.dispatched ??= []; this.dispatched.push(event); return true; }
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
globalThis.CustomEvent ??= class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
const components = {};
globalThis.customElements = { define: (name, component) => { components[name] = component; } };
globalThis.document = { activeElement: null, createElement: (tagName) => new ElementStub(tagName) };
await import("./kin-appearance.js");
const KinAppearance = components["kin-appearance"];

const initial = Object.freeze({
  version: 2, owner: null, mode: "system", colorSource: "default", seed: "#984D38", manual: null, image: null,
});

test("theme presets use one native radio group and preview the checked choice", () => {
  const appearance = new KinAppearance();
  appearance.connectedCallback();
  appearance.initialize(initial);

  const controls = [...appearance.presetControls.values()];
  assert.equal(controls.length, 8);
  assert.ok(controls.every((input) => input.type === "radio"));
  assert.equal(new Set(controls.map((input) => input.name)).size, 1, "all presets share one native radio group");
  assert.equal(appearance.swatches.getAttribute("role"), null, "the group needs no emulated radio role");
  assert.ok(appearance.swatches.children.every((label) => label.tagName === "label" && label.children[0].type === "radio"));
  assert.deepEqual(controls.filter((input) => input.checked).map((input) => input.value), ["default"]);

  const forest = appearance.presetControls.get("forest");
  forest.checked = true;
  forest.listeners.change();
  assert.deepEqual(controls.filter((input) => input.checked).map((input) => input.value), ["forest"]);
  assert.equal(appearance.draft.colorSource, "preset");
  assert.equal(appearance.draft.seed, "#397052");
  assert.equal(appearance.feedback.textContent, "Unsaved changes.");
});
