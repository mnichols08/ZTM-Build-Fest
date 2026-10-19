// Onboarding entry points and first useful action, without a browser framework.
import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";

installDom();
const { StatusController } = await import("./status.js");

function rig({ connected = true, hasItems = false } = {}) {
  const card = document.createElement("section");
  card.classList = { remove() {}, toggle() {} };
  card.querySelector = () => null; // The fake DOM does not implement <details> selectors.
  let focused = false;
  const navigated = [];
  const intents = [];
  const app = {
    onboarding: card,
    vault: { locked: false },
    state: { items: hasItems ? [{ text: "Get milk" }] : [] },
    householdStatus: { identity: connected ? { deviceId: "trusted" } : null },
    security: { passkeyWrappers: [{}] },
    pages: new Map(),
    compose: { input: { focus() { focused = true; } } },
    household: { startIntent(intent) { intents.push(intent); } },
  };
  const ctx = { app, navigation: { navigate(path) { navigated.push(path); } } };
  const controller = new StatusController(ctx);
  controller.renderOnboarding();
  return { card, app, controller, navigated, intents, get focused() { return focused; } };
}

test("unconnected household offers the same four choices as member setup", () => {
  const r = rig({ connected: false });
  const choices = [
    ["Start a new household", "create"],
    ["Join my household", "join"],
    ["Sign in using my phone", "phone"],
    ["Use Kin on another device", "device"],
  ];
  for (const [label, intent] of choices) {
    const button = r.card.byText(label);
    assert.ok(button, `missing ${label}`);
    button.click();
    assert.equal(r.intents.at(-1), intent);
    assert.equal(r.navigated.at(-1), "#household/people");
  }
  assert.equal(r.card.hidden, false);
});

test("empty connected household guides one first action and can be dismissed", () => {
  const r = rig();
  assert.match(r.card.textContent, /Welcome home/);
  assert.match(r.card.textContent, /shopping/);
  r.card.byText("Add something").click();
  assert.equal(r.focused, true, "uses the existing capture input");
  r.card.byText("Not now").click();
  assert.equal(r.app.firstActionWelcomeDismissed, true);
  assert.equal(r.card.hidden, true, "skipping onboarding is allowed");
});

test("welcome is absent for a household that already has content", () => {
  const r = rig({ hasItems: true });
  assert.equal(r.card.hidden, true);
  assert.equal(r.card.byText("Add something"), null);
});
