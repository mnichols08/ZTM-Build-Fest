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
  querySelectorAll(selector) {
    const tags = new Set(selector.split(",").map((value) => value.trim()));
    const descendants = (children) =>
      children.flatMap((child) => [child, ...descendants(child.children ?? [])]);
    return descendants(this.children).filter((child) => tags.has(child.tagName));
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

test("busy-state changes preserve controls gated by a local prerequisite", () => {
  const component = new KinHousehold();
  const gated = document.createElement("button");
  const available = document.createElement("button");
  component.append(gated, available);

  component.setControlDisabled(gated, true);
  component.disabled = true;
  assert.equal(gated.disabled, true);
  assert.equal(available.disabled, true);

  component.disabled = false;
  assert.equal(gated.disabled, true, "the prerequisite still gates its control");
  assert.equal(available.disabled, false, "the busy-only control becomes available");

  component.setControlDisabled(gated, false);
  assert.equal(gated.disabled, false);
});

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
  component.api = async () => ({ canManageMembers: true, devices: [
    { id: "self", label: "Adult phone", revokedAt: null },
    { id: "other", label: "Kitchen tablet", revokedAt: null },
  ] });
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const revoke = descendants(component.children).find((child) => child.textContent?.startsWith("Revoke "));
  assert.equal(revoke.textContent, "Revoke Kitchen tablet");
});

test("device trust refuses a forced click until its displayed code is confirmed", async () => {
  const component = new KinHousehold();
  component.identity = {
    householdId: "household",
    memberId: "adult",
    deviceId: "current-device",
  };
  component.assertConnection = () => {};
  const expected = {
    householdId: "household",
    memberId: "partner",
    deviceId: "partner-device",
    publicKeys: { encryption: "key" },
    fingerprint: "a".repeat(64),
  };
  const pinned = [];
  component.syncKeyStore = {
    getPinnedDevice: async () => null,
    pinTrustedDevice: async (value) => pinned.push(value),
  };
  component.ctx.api.openSyncKeyStore = async () => {};
  component.ctx.api.requestSync = () => {};
  component.api = async (path) => {
    if (path === "/api/devices")
      return {
        canManageMembers: false,
        devices: [
          {
            id: "partner-device",
            memberId: "partner",
            label: "Partner phone",
            revokedAt: null,
          },
        ],
      };
    if (path === "/api/sync/devices")
      return {
        devices: [
          {
            memberId: expected.memberId,
            deviceId: expected.deviceId,
            publicKeys: expected.publicKeys,
            fingerprint: expected.fingerprint,
          },
        ],
      };
    throw new Error(`Unexpected API path: ${path}`);
  };

  await component.showDevices();
  const descendants = (items) =>
    items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const verify = descendants(component.children).find(
    (child) => child.textContent === "Verify device",
  );
  verify.listeners.click();
  const confirmation = descendants(component.children).find(
    (child) => child.tagName === "input" && child.type === "checkbox",
  );
  const trust = descendants(component.children).find(
    (child) => child.textContent === "Trust this device",
  );

  trust.disabled = false;
  await trust.listeners.click();
  assert.equal(pinned.length, 0);
  const refusal = component.children.find(
    (child) => child.className === "household-message",
  );
  assert.equal(refusal.attributes.role, "alert");
  assert.equal(
    refusal.textContent,
    "Compare the codes on both devices before trusting this device.",
  );

  confirmation.checked = true;
  await trust.listeners.click();
  assert.deepEqual(pinned, [expected]);
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

test("device revocation refreshes the trusted-device list after the passkey operation releases the busy guard", async () => {
  const component = new KinHousehold();
  component.identity = { memberId: "adult", deviceId: "self" };
  component.syncKeyError = "skip sync-key access";
  component.assertConnection = () => {};
  let revoked = false;
  const calls = [];
  component.api = async (path) => {
    calls.push(path);
    if (path === "/api/devices")
      return { canManageMembers: true, devices: [
        { id: "self", label: "Adult phone", revokedAt: null },
        { id: "other", label: "Kitchen tablet", revokedAt: revoked ? 1_700_000_000_000 : null },
      ] };
    if (path === "/api/devices/other/revocation/options")
      return { flow: "flow", publicKey: { challenge: "YQ", allowCredentials: [{ id: "Yg" }] } };
    if (path === "/api/devices/revocation/finish") { revoked = true; return { revoked: true }; }
    throw new Error("unexpected call " + path);
  };
  globalThis.confirm = () => true;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { credentials: { get: async () => ({
      id: "credential-adult", type: "public-key",
      response: { clientDataJSON: new Uint8Array([1]), getTransports: () => [] },
    }) } },
  });
  await component.showDevices();
  const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
  const revoke = descendants(component.children).find((child) => child.textContent === "Revoke Kitchen tablet");
  await revoke.listeners.click();
  assert.deepEqual(calls, [
    "/api/devices",
    "/api/devices/other/revocation/options",
    "/api/devices/revocation/finish",
    "/api/devices",
  ]);
  const labels = descendants(component.children).map((child) => child.textContent);
  assert.ok(labels.includes("Kitchen tablet — Revoked"), "list shows the revoked device after refresh");
  assert.equal(labels.some((label) => label === "Revoke Kitchen tablet"), false, "revoked device offers no further revoke control");
  assert.equal(component.busy, false);
});

test("household admins see admin, invitation, and removal controls; other Adults do not", async () => {
  const members = (currentAdmin) => [
    { id: "founder", current: currentAdmin, active: true, kind: "adult", admin: true },
    { id: "partner", current: !currentAdmin, active: true, kind: "adult", admin: false },
    { id: "child", current: false, active: true, kind: "limited", admin: false },
  ];
  const render = async (currentAdmin) => {
    const component = new KinHousehold();
    component.identity = { memberId: currentAdmin ? "founder" : "partner" };
    component.run = async (action) => action();
    component.api = async () => ({ adminRecorded: true, canManageMembers: currentAdmin, members: members(currentAdmin) });
    await component.showHousehold();
    const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
    return descendants(component.children).filter((child) => child.tagName === "button").map((button) => button.textContent);
  };

  const admin = await render(true);
  for (const label of ["Make Adult 2 a household admin", "Remove Adult 2 from household", "Remove Limited member 1 from household",
    "Add Adult", "Add Child or Limited Member", "Add Babysitter or Guest", "Delete household"])
    assert.ok(admin.includes(label), `admin sees ${label}`);
  assert.equal(admin.includes("Stop being a household admin"), true);

  const adult = await render(false);
  for (const label of ["Add Adult", "Add Child or Limited Member", "Add Babysitter or Guest", "Delete household", "Remove Limited member 1 from household"])
    assert.equal(adult.includes(label), false, `non-admin Adult does not see ${label}`);
  assert.equal(adult.some((label) => label.includes("household admin")), false);
  assert.equal(adult.some((label) => label.startsWith("Authorize recovery for Adult 1")), false, "non-admins cannot recover an admin");
  assert.ok(adult.includes("Authorize recovery for Limited member 1"));
  assert.ok(adult.includes("Leave household"));
});

test("another member's device revocation control fails closed unless the server grants management", async () => {
  const devices = [
    { id: "self", memberId: "adult", label: "Adult phone", revokedAt: null },
    { id: "own-laptop", memberId: "adult", label: "Adult laptop", revokedAt: null },
    { id: "partner-phone", memberId: "partner", label: "Partner phone", revokedAt: null },
  ];
  const cases = [
    ["true", { canManageMembers: true }, true],
    ["false", { canManageMembers: false }, false],
    ["undefined", { canManageMembers: undefined }, false],
    ["null", { canManageMembers: null }, false],
    ["missing", {}, false],
    ["truthy non-boolean", { canManageMembers: "true" }, false],
  ];
  for (const [name, permission, othersVisible] of cases) {
    const component = new KinHousehold();
    component.identity = { memberId: "adult", deviceId: "self" };
    component.syncKeyError = "skip sync-key access";
    component.run = async (action) => action();
    component.api = async () => ({ ...permission, devices });
    await component.showDevices();
    const descendants = (items) => items.flatMap((item) => [item, ...descendants(item.children ?? [])]);
    const labels = descendants(component.children).filter((child) => child.tagName === "button").map((button) => button.textContent);
    assert.equal(labels.includes("Revoke Adult laptop"), true, `${name}: own device stays manageable`);
    assert.equal(labels.includes("Revoke Partner phone"), othersVisible, `${name}: another member's device`);
    assert.equal(labels.includes("Revoke Adult phone"), false, `${name}: the current device is never offered`);
  }
});
