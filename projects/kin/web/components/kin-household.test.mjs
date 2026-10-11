import assert from "node:assert/strict";
import test from "node:test";

class ElementStub {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.isConnected = true;
    this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  toggleAttribute(name, enabled) {
    if (enabled) this.attributes[name] = "";
    else delete this.attributes[name];
    return enabled;
  }
  querySelector(selector) {
    return selector === ".household-message"
      ? this.children.find((child) => child.className === "household-message") ?? null
      : null;
  }
}

globalThis.HTMLElement = class extends ElementStub {};
globalThis.customElements = { define: (_name, component) => { globalThis.KinHouseholdUnderTest = component; } };
globalThis.document = {
  createElement: (tagName) => new ElementStub(tagName),
  createTextNode: (text) => ({ textContent: text }),
};
await import("./kin-household.js");
const KinHousehold = globalThis.KinHouseholdUnderTest;

test("Limited and Temporary members get a clearly named Leave household button", async () => {
  for (const kind of ["limited", "temporary"]) {
    const component = new KinHousehold();
    component.identity = { memberId: "current-member" };
    component.run = async (action) => action();
    component.api = async () => ({
      members: [{ id: "current-member", current: true, active: true, kind, expiresAt: Date.now() + 60_000 }],
    });
    await component.showHousehold();
    const buttons = component.children.filter((child) => child.tagName === "button");
    assert.ok(buttons.some((button) => button.textContent === "Leave household"));
    const leave = buttons.find((button) => button.textContent === "Leave household");
    assert.equal(leave.type, "button");
    assert.equal(buttons.some((button) => button.textContent === "Delete household"), false);
  }
});

test("only Adults can see Enable device sync while other members get participation guidance", () => {
  for (const kind of ["limited", "temporary"]) {
    const component = new KinHousehold();
    component.syncStatus = { memberKind: kind, enabled: false };
    component.renderMember();
    assert.equal(component.children.some((child) => child.textContent === "Enable device sync"), false);
    assert.ok(component.children.some((child) => child.textContent.includes("Ask a household Adult to enable it")));
  }
  const adult = new KinHousehold();
  adult.syncStatus = { memberKind: "adult", enabled: false };
  adult.renderMember();
  assert.ok(adult.children.some((child) => child.textContent === "Enable device sync"));
});

test("device revocation control names its target", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "adult", deviceId: "self" };
  component.syncKeyError = "skip sync-key access";
  component.run = async (action) => action();
  component.api = async () => ({ devices: [
    { id: "self", label: "Adult phone", revokedAt: null },
    { id: "other", label: "Kitchen tablet", revokedAt: null },
  ] });
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const revoke = descendants(component.children).find((child) => child.textContent?.startsWith("Revoke "));
  assert.equal(revoke.textContent, "Revoke Kitchen tablet");
});

test("self-leave requests a passkey and cancellation leaves local authority intact", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "limited-member" };
  component.assertConnection = () => {};
  let finishCalls = 0;
  component.api = async (path) => {
    assert.equal(path, "/api/household/membership/remove/options");
    return { flow: "flow", publicKey: { challenge: "YQ", allowCredentials: [] } };
  };
  globalThis.confirm = (copy) => {
    assert.match(copy, /Leave this household/);
    assert.doesNotMatch(copy, /adult/i);
    return true;
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { credentials: { get: async () => { throw new DOMException("Cancelled", "NotAllowedError"); } } },
  });
  const originalApi = component.api;
  component.api = async (...args) => {
    if (args[0] === "/api/household/membership/remove/finish") finishCalls += 1;
    return originalApi(...args);
  };
  await component.leave();
  assert.equal(finishCalls, 0);
  assert.equal(component.identity.memberId, "limited-member");
  assert.equal(component.children.some((child) => child.type === "button"), false);
  const status = component.children.find((child) => child.className === "household-message");
  assert.equal(status.attributes.role, "alert");
  assert.match(status.textContent, /request was cancelled\. No authorization change was made\./);
});

test("successful self-leave completes the passkey mutation before local lock and navigation", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "temporary-member" };
  component.assertConnection = () => {};
  const calls = [];
  component.api = async (path, options) => {
    calls.push(path);
    if (path.endsWith("/options"))
      return { flow: "flow", publicKey: { challenge: "YQ", allowCredentials: [{ id: "Yg" }] } };
    return { removed: true };
  };
  component.message = () => {};
  component.dispatchEvent = (event) => { calls.push(event.type); };
  component.identity.memberId = "temporary-member";
  globalThis.confirm = () => true;
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  globalThis.location = { href: "" };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      credentials: {
        get: async () => ({
          id: "credential-temporary",
          type: "public-key",
          response: { clientDataJSON: new Uint8Array([1]), getTransports: () => [] },
        }),
      },
    },
  });
  await component.leave();
  assert.deepEqual(calls, [
    "/api/household/membership/remove/options",
    "/api/household/membership/remove/finish",
    "kin:lock",
  ]);
  assert.equal(component.identity, null);
  assert.equal(globalThis.location.href, "/");
});
