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
    this.value = "";
    this.hidden = false;
    this.isConnected = true;
  }
  append(...children) {
    for (const value of children) {
      const child = typeof value === "string" ? Object.assign(new ElementStub("#text"), { textContent: value }) : value;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  contains(node) { return node ? node === this || descendants(this).includes(node) : false; }
  focus() { globalThis.document.activeElement = this; }
  showModal() { this.open = true; }
  close(value) { this.open = false; this.returnValue = value; this.listeners.close?.(); }
  querySelectorAll(selector) {
    if (selector === "[data-focus-key]") return descendants(this).filter((node) => node.dataset.focusKey);
    const className = selector.slice(1);
    return descendants(this).filter((node) => String(node.className ?? "").split(" ").includes(className));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
globalThis.HTMLElement = class extends ElementStub {};
const components = {};
globalThis.customElements = { get: (name) => components[name], define: (name, component) => { components[name] = component; } };
globalThis.document = { activeElement: null, body: new ElementStub("body"), createElement: (tagName) => new ElementStub(tagName) };
await import("./kin-just-for-me.js");
const KinJustForMe = components["kin-just-for-me"];

/** A controller whose saves finish only when the test says so. */
function slowController() {
  const runs = [];
  return {
    runs,
    async run(command) {
      let finish;
      const saved = new Promise((done) => { finish = done; });
      runs.push({ command, finish });
      await saved;
    },
    shareAudience: () => "Sam",
    async share(item) { runs.push({ command: { type: "share", itemId: item.id } }); return { message: "Shared." }; },
  };
}

const settle = () => new Promise((done) => setImmediate(done));
const byKey = (element, key) => element.findByKey(key);

function justForMe(items) {
  const element = new KinJustForMe();
  element.controller = slowController();
  element.connectedCallback();
  element.update({ availability: { state: "ready" }, items, today: 20261026 });
  return element;
}

const items = () => [
  { id: "a", text: "Call the dentist", completed: false, addedAt: 1 },
  { id: "b", text: "Birthday card", completed: false, addedAt: 2 },
];

test("a tap made while a change is saving runs after it, not never (#792)", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const first = byKey(element, "a:done");
  first.checked = true;
  first.listeners.change();
  const second = byKey(element, "b:done");
  second.checked = true;
  second.listeners.change();
  await settle();
  assert.deepEqual(runs.map((run) => run.command), [{ type: "complete-private-item", itemId: "a" }], "one change at a time");

  runs[0].finish();
  await settle();
  assert.equal(element.feedbackText.textContent, "Done: “Call the dentist”.");
  assert.deepEqual(runs.map((run) => run.command.itemId), ["a", "b"], "the second tap runs once the first is saved");
  runs[1].finish();
  await settle();
  assert.equal(element.feedbackText.textContent, "Done: “Birthday card”.");
});

test("Enter twice while saving adds the item once, and a later add still goes through", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  element.input.value = "Gift for Sam";
  element.form.listeners.submit({ preventDefault() {} });
  element.form.listeners.submit({ preventDefault() {} });
  assert.equal(element.input.value, "", "the words move into the change straight away");
  element.input.value = "Book the vet";
  element.form.listeners.submit({ preventDefault() {} });
  await settle();
  runs[0].finish();
  await settle();
  runs[1].finish();
  await settle();
  assert.deepEqual(runs.map((run) => run.command.text), ["Gift for Sam", "Book the vet"]);
  assert.equal(element.feedbackText.textContent, "Added “Book the vet”. Only you can see it.");
});

test("an add that can't be saved gives its words back when the field is still empty", async () => {
  const element = justForMe(items());
  element.controller.run = async () => { throw Object.assign(new Error("no"), { userMessage: "Kin couldn't save that private change. Try again." }); };
  element.input.value = "Gift for Sam";
  element.dateInput.value = "2026-11-02";
  await element.add();
  assert.equal(element.input.value, "Gift for Sam");
  assert.equal(element.dateInput.value, "2026-11-02");
  assert.equal(element.feedbackText.textContent, "Kin couldn't save that private change. Try again.");
});

test("a delete offers Undo and focuses it, unless a change was tapped behind it", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const removing = element.remove(items()[0]);
  await settle();
  runs[0].finish();
  await removing;
  assert.equal(element.undoButton.hidden, false, "the delete offers Undo");
  assert.equal(document.activeElement, element.undoButton);

  const again = element.remove(items()[1]);
  const box = byKey(element, "a:done");
  box.focus();
  box.checked = false;
  box.listeners.change();
  await settle();
  runs[1].finish();
  await again;
  await settle();
  assert.deepEqual(runs.map((run) => run.command.type), ["delete-private-item", "delete-private-item", "reopen-private-item"]);
  assert.equal(element.undoButton.hidden, true, "the change tapped behind the delete ends its Undo");
  assert.equal(document.activeElement, box, "focus stays where the last tap was");
  runs[2].finish();
  await settle();
});

test("sharing confirmed while a change is saving shares after it", async () => {
  const element = justForMe(items());
  const runs = element.controller.runs;
  const box = byKey(element, "a:done");
  box.checked = true;
  box.listeners.change();
  element.openShare(items()[1], null);
  assert.equal(element.shareDialog.open, true, "Share opens while a change saves");
  element.shareDialog.close("share");
  await settle();
  assert.equal(runs.length, 1);
  runs[0].finish();
  await settle();
  assert.deepEqual(runs.map((run) => run.command.type), ["complete-private-item", "share"]);
  assert.equal(element.feedbackText.textContent, "Shared.");
});
