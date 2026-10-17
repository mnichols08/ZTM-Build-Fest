// Live household authority and recovery drill across independent browser
// profiles. Each client is a separate Chromium process with its own
// --user-data-dir, cookies, IndexedDB, device keys and virtual authenticator,
// talking to one real in-process Kin server and relay over loopback HTTP.
// The server clock is injectable so Temporary expiry is deterministic.
//
// Evidence limits: pairing operates the real fingerprint checkboxes and
// passkey buttons, but the "comparison" is automated equality between strings
// rendered in two profiles. It does not count as a human verification
// ceremony, and separate profiles on one machine are not separate devices.
//
// Usage: node scripts/household-authority-regression.mjs <browser executable>
import { waitForOrigin } from "./cdp-page.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Page-side helpers. Each function is serialized with toString() and evaluated
// inside a browser profile, so it must be self-contained.
// ---------------------------------------------------------------------------

async function pageWaitReady() {
  // 30 s: a fresh profile's first start can take longer than 10 s (#164).
  for (let i = 0; i < 1200; i++) {
    const app = document.querySelector("kin-app");
    if (app?.security?.heading && !app.starting) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Kin shell did not become ready: " + document.body.innerText.slice(0, 400));
}

async function pageSetupProtection() {
  const app = document.querySelector("kin-app");
  if (app.state !== null || app.vault !== null) throw new Error("Fresh profile must start locked and empty.");
  app.security.showSetup();
  const recovery = app.security.querySelector(".recovery-key").textContent;
  const input = app.security.querySelector("#confirm-recovery");
  input.value = recovery;
  input.form.requestSubmit();
  for (let i = 0; i < 400 && !(app.store && !app.security.busy && !app.busy); i++)
    await new Promise((r) => setTimeout(r, 25));
  if (!app.store) throw new Error("Recovery setup did not unlock: " + app.security.alert.textContent);
  return recovery;
}

async function pageUnlock(secret) {
  const app = document.querySelector("kin-app");
  if (app.store && !app.busy) return "already-unlocked";
  await app.security.run(() => app.security.unlockRecovery(secret));
  for (let i = 0; i < 400 && !(app.store && !app.busy && !app.security.busy); i++)
    await new Promise((r) => setTimeout(r, 25));
  if (!app.store) throw new Error("Recovery unlock failed: " + app.security.alert.textContent);
  for (let i = 0; i < 400 && !app.household; i++) await new Promise((r) => setTimeout(r, 25));
  return "unlocked";
}

async function pageIsLocked() {
  const app = document.querySelector("kin-app");
  return Boolean(app?.security?.heading) && !app.starting && app.store === null;
}

async function pageWaitHousehold() {
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 400; i++) {
    const h = app.household;
    if (h && !h.busy && (h.identity !== undefined)) {
      // load() has completed when either identity or claim has been assigned
      // and the component rendered its first content.
      if (h.childElementCount > 0) return { identity: h.identity, claim: h.claim };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Household component did not load: " + document.body.innerText.slice(0, 400));
}

async function pageBootstrap(deviceLabel) {
  const app = document.querySelector("kin-app");
  await app.household.register("bootstrap", { deviceLabel });
  if (!app.household.identity)
    throw new Error("Bootstrap registration failed: " + (app.household.querySelector(".household-message")?.textContent ?? ""));
  await app.security.run(() => app.security.addPasskey());
  const wrapper = app.security.manifest.wrappers.find((value) => value.type === "prf");
  return { identity: app.household.identity, prf: Boolean(wrapper) };
}

// Fingerprint verification. The helpers below read the fingerprint each
// profile renders, compare it with what the *other* profile renders (the
// drill passes those strings between processes), and only then operate the
// product's real "I compared this fingerprint" checkbox and passkey button.
// That proves the rendered values agree across independent clients and that
// approval/activation stay gated until confirmation. It is still automated
// string equality, not a person comparing two screens: it is protocol and UI
// gating evidence, not a completed human verification ceremony.

async function pageShownFingerprint(prompt) {
  const household = document.querySelector("kin-app").household;
  const paragraph = [...household.querySelectorAll(".pairing-fingerprint")]
    .find((element) => element.textContent.startsWith(`${prompt}: `));
  return paragraph?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
}

async function pageClaim({ code, deviceLabel }) {
  const app = document.querySelector("kin-app");
  await app.household.register("claim", { code, deviceLabel });
  const claim = app.household.claim;
  if (!claim)
    throw new Error("Claim registration failed: " + (app.household.querySelector(".household-message")?.textContent ?? ""));
  const shown = (prompt) => [...app.household.querySelectorAll(".pairing-fingerprint")]
    .find((element) => element.textContent.startsWith(`${prompt}: `))
    ?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
  return {
    state: claim.state,
    fingerprint: app.household.localFingerprint,
    shownOwnKey: shown("Compare this device key with the approving adult"),
    shownApprovingKey: shown("Compare the approving device key"),
  };
}

async function pageCreatePairing({ kind, expiresAt }) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  await h.createPairing(kind, expiresAt);
  // Require the code the user would read, not merely component state.
  const shownCode = h.querySelector(".pairing-code")?.textContent;
  const alert = h.querySelector('.household-message[role="alert"]');
  if (!h.pairing?.code || alert || shownCode !== h.pairing.code)
    throw new Error(`Could not create ${kind} invitation: ` + (alert?.textContent ?? "the code was not displayed"));
  return { code: shownCode, pairingId: h.pairing.pairingId, state: h.pairing.state };
}

async function pageApprove({ joiningKey }) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  let latest;
  for (let i = 0; i < 200; i++) {
    latest = await h.api(`/api/pairings/${h.pairing.pairingId}`);
    if (latest.state === "Claimed") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (latest.state !== "Claimed") throw new Error("Invitation was not claimed: " + latest.state);
  h.pairing = { ...h.pairing, ...latest };
  const controls = () => {
    h.render();
    const shownKey = [...h.querySelectorAll(".pairing-fingerprint")]
      .find((element) => element.textContent.startsWith("Confirm this matches the joining device: "))
      ?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
    const approve = [...h.querySelectorAll("button")].find((button) => button.textContent === "Approve with passkey");
    const confirmation = [...h.querySelectorAll("label")]
      .find((label) => label.textContent.includes("I compared this fingerprint on both devices."))
      ?.querySelector('input[type="checkbox"]');
    if (!approve || !confirmation) throw new Error("Approval verification controls are missing");
    return { shownKey, approve, confirmation };
  };
  const idle = async () => {
    for (let i = 0; i < 400 && h.busy; i++) await new Promise((r) => setTimeout(r, 25));
  };
  let { shownKey, approve, confirmation } = controls();
  if (!shownKey || shownKey !== joiningKey)
    throw new Error("The approver's displayed fingerprint differs from the joining device's own display");
  const visuallyGated = approve.disabled;
  h.disabled = true;
  h.disabled = false;
  const gateSurvivedBusyCycle = approve.disabled;
  if (confirmation.checked) throw new Error("Approval fingerprint confirmation started checked");
  const versionBefore = h.pairing.version;
  approve.disabled = false;
  approve.click();
  await idle();
  const refusal = h.querySelector('.household-message[role="alert"]')?.textContent ?? "";
  const refusedBeforeConfirmation = /Compare the device fingerprint on both devices before approving/.test(refusal) &&
    h.pairing.state === "Claimed" && h.pairing.version === versionBefore &&
    (await h.api(`/api/pairings/${h.pairing.pairingId}`)).state === "Claimed";
  ({ approve, confirmation } = controls());
  confirmation.click();
  if (approve.disabled) throw new Error("Approval stayed disabled after fingerprint confirmation");
  approve.click();
  for (let i = 0; i < 400 && (h.busy || h.pairing.state !== "Confirmed"); i++) {
    const alert = h.querySelector(".household-message");
    if (alert?.getAttribute("role") === "alert") throw new Error("Approval failed: " + alert.textContent);
    await new Promise((r) => setTimeout(r, 25));
  }
  if (h.pairing.state !== "Confirmed")
    throw new Error("Approval did not confirm: " + (h.querySelector(".household-message")?.textContent ?? h.pairing.state));
  return { memberId: h.pairing.confirmedMemberId, deviceId: h.pairing.confirmedDeviceId,
    refusedBeforeConfirmation, visuallyGated, gateSurvivedBusyCycle, shownKey };
}

async function pageActivate({ approvingKey }) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  await h.load();
  if (h.claim?.state !== "Confirmed") throw new Error("Claim is not confirmed: " + JSON.stringify(h.claim));
  const shownKey = [...h.querySelectorAll(".pairing-fingerprint")]
    .find((element) => element.textContent.startsWith("Compare the approving device key: "))
    ?.querySelector("code")?.textContent.replaceAll(" ", "") ?? null;
  if (!shownKey || shownKey !== approvingKey)
    throw new Error("The joining device's displayed approver fingerprint differs from the approver's own display");
  const activate = [...h.querySelectorAll("button")].find((button) => button.textContent === "Activate with passkey");
  const confirmation = [...h.querySelectorAll("label")]
    .find((label) => label.textContent.includes("I compared this fingerprint on both devices."))
    ?.querySelector('input[type="checkbox"]');
  if (!activate || !confirmation) throw new Error("Activation verification controls are missing");
  const visuallyGated = activate.disabled;
  h.disabled = true;
  h.disabled = false;
  const gateSurvivedBusyCycle = activate.disabled;
  if (!visuallyGated || !gateSurvivedBusyCycle || confirmation.checked)
    throw new Error("Activation was available before fingerprint confirmation");
  confirmation.click();
  if (activate.disabled) throw new Error("Activation stayed disabled after fingerprint confirmation");
  // Return the gate evidence before activation navigates and destroys this
  // execution context. The caller then waits for the real navigation.
  setTimeout(() => activate.click(), 100);
  return { visuallyGated, gateSurvivedBusyCycle };
}

async function pageTrustDevice(deviceLabel) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const listed = await h.api("/api/devices");
  const device = listed.devices.find((entry) => entry.label === deviceLabel);
  if (!device) throw new Error(`Trusted-device list is missing ${deviceLabel}`);
  await h.showDevices();
  const item = [...h.querySelectorAll("li")].find((entry) =>
    entry.textContent.includes(`${deviceLabel} — Trusted`),
  );
  const verify = [...(item?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Verify device",
  );
  if (!verify) throw new Error(`Verify device is unavailable for ${deviceLabel}`);
  verify.click();
  const trust = [...item.querySelectorAll("button")].find(
    (button) => button.textContent === "Trust this device",
  );
  const confirmation = [...item.querySelectorAll("label")]
    .find((label) => label.textContent.includes("The codes match."))
    ?.querySelector('input[type="checkbox"]');
  if (!trust || !confirmation)
    throw new Error(`Device trust confirmation controls are missing for ${deviceLabel}`);
  const visuallyGated = trust.disabled;
  h.disabled = true;
  h.disabled = false;
  const gateSurvivedBusyCycle = trust.disabled;

  trust.disabled = false;
  trust.click();
  for (let i = 0; i < 400 && h.busy; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const refusal = h.querySelector('.household-message[role="alert"]')?.textContent ?? "";
  const refusedBeforeConfirmation =
    refusal === "Compare the codes on both devices before trusting this device.";
  const unpinnedBeforeConfirmation = !(await h.syncKeyStore.getPinnedDevice(
    h.identity.householdId,
    device.id,
  ));

  confirmation.click();
  if (trust.disabled)
    throw new Error("Device trust stayed disabled after code confirmation");
  trust.click();
  for (let i = 0; i < 400 && h.busy; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const pinnedAfterConfirmation = Boolean(
    await h.syncKeyStore.getPinnedDevice(h.identity.householdId, device.id),
  );
  return {
    visuallyGated,
    gateSurvivedBusyCycle,
    refusedBeforeConfirmation,
    unpinnedBeforeConfirmation,
    pinnedAfterConfirmation,
  };
}

async function pageHousehold() {
  const app = document.querySelector("kin-app");
  return app.household.api("/api/household");
}

// `bytes` (an array of byte values) sends a binary body, as sync event
// batches are (web/sync/envelope-wire.js).
async function pageFetch({ path, method = "GET", body, bytes }) {
  const response = await fetch(path, {
    method,
    cache: "no-store",
    headers: bytes ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {},
    body: bytes ? new Uint8Array(bytes) : body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function pagePauseAutomaticSync() {
  const app = document.querySelector("kin-app");
  app.syncCoordinator?.stop();
  app.syncCoordinator = null;
  app.ctx.sync.configureSyncCoordinator = async () => {};
}

async function pageResumeAutomaticSync() {
  const app = document.querySelector("kin-app");
  delete app.ctx.sync.configureSyncCoordinator;
}

async function pageShiftClock(offsetMs) {
  const original = Date.now.bind(Date);
  window.__kinOriginalDateNow = original;
  Date.now = () => original() + offsetMs;
}

async function pageRestoreClock() {
  if (!window.__kinOriginalDateNow) return;
  Date.now = window.__kinOriginalDateNow;
  delete window.__kinOriginalDateNow;
}

async function pageEnableSync() {
  const app = document.querySelector("kin-app");
  await app.household.enableSync();
  if (!app.household.syncStatus?.enabled)
    throw new Error("Sync enable failed: " + (app.household.querySelector(".household-message")?.textContent ?? ""));
  return app.household.syncStatus;
}

async function pageSync() {
  const app = document.querySelector("kin-app");
  if (!app.store) throw new Error("Cannot sync a locked profile.");
  if (!app.syncCoordinator) await app.ctx.sync.configureSyncCoordinator();
  const coordinator = app.syncCoordinator;
  if (!coordinator) return { started: false, items: app.state?.items.map((item) => item.text) ?? [] };
  // start() binds device keys and runs its own first sync; wait for that run
  // to settle so this call observes a complete, freshly started sync.
  for (let i = 0; i < 1200 && (!coordinator.deviceKeys || coordinator.running); i++)
    await new Promise((r) => setTimeout(r, 25));
  if (!coordinator.deviceKeys) throw new Error("Sync coordinator did not finish starting: " + app.stateNotice.textContent);
  const states = [];
  const original = coordinator.onState;
  coordinator.onState = (value) => {
    states.push({ state: value.state, code: value.code ?? null, message: value.message ?? null });
    original(value);
  };
  try {
    await coordinator.syncNow();
  } finally {
    coordinator.onState = original;
  }
  for (let i = 0; i < 200 && app.busy; i++) await new Promise((r) => setTimeout(r, 25));
  return {
    started: true,
    states,
    last: states.at(-1) ?? null,
    items: app.state?.items.map((item) => item.text) ?? [],
    notice: app.stateNotice.hidden ? "" : app.stateNotice.textContent,
  };
}

async function pageAddItem(text) {
  const app = document.querySelector("kin-app");
  app.compose.input.value = text;
  // The drill counts one relay envelope per item: capture without a date.
  app.compose.plan.value = "none";
  app.compose.form.requestSubmit();
  for (let i = 0; i < 400; i++) {
    if (!app.busy && app.state?.items.some((item) => item.text === text)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!app.state?.items.some((item) => item.text === text))
    throw new Error("Item was not added locally: " + text);
  return app.state.items.map((item) => item.text);
}

async function pageLocal() {
  const app = document.querySelector("kin-app");
  const events = await app.store.loadEvents();
  const outbox = await app.store.getPendingOutbox(100);
  return {
    events: events.length,
    eventIds: events.map((row) => Array.from(row.event_id, (b) => b.toString(16).padStart(2, "0")).join("")).sort(),
    pendingOutbox: outbox.length,
    items: app.state?.items.map((item) => item.text) ?? null,
    syncState: Boolean(await app.store.getSyncState()),
  };
}

async function pageRevokeDeviceButton(label) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await h.showDevices();
    const button = [...h.querySelectorAll("button")].find((b) => b.textContent === `Revoke ${label}`);
    if (!button) throw new Error("No revoke control for " + label + ": " + h.textContent);
    button.click();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (!h.busy && h.textContent.includes(`${label} — Revoked`)) break;
      const alert = h.querySelector(".household-message");
      if (!h.busy && alert?.getAttribute("role") === "alert") throw new Error("Revocation failed: " + alert.textContent);
    }
    if (!h.textContent.includes(`${label} — Revoked`)) throw new Error("Device not shown revoked: " + h.textContent);
    return h.textContent;
  } finally {
    globalThis.confirm = originalConfirm;
  }
}

async function pageRemoveMemberButton(buttonText) {
  const app = document.querySelector("kin-app");
  const h = app.household;
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await h.showHousehold();
    const button = [...h.querySelectorAll("button")].find((b) => b.textContent === buttonText);
    if (!button) throw new Error("No control '" + buttonText + "': " + h.textContent);
    button.click();
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (!h.busy && ![...h.querySelectorAll("button")].some((b) => b.textContent === buttonText)) break;
      const alert = h.querySelector(".household-message");
      if (!h.busy && alert?.getAttribute("role") === "alert") throw new Error("Removal failed: " + alert.textContent);
    }
    return h.textContent;
  } finally {
    globalThis.confirm = originalConfirm;
  }
}

async function pageHouseholdText() {
  const app = document.querySelector("kin-app");
  await app.household.showHousehold();
  return app.household.textContent;
}

async function pageExportArchive({ clockOffset = 0 } = {}) {
  const app = document.querySelector("kin-app");
  let blob = null;
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalCreate = URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function () {};
  URL.createObjectURL = (value) => { blob = value; return originalCreate.call(URL, value); };
  const systemNow = Date.now;
  Date.now = () => systemNow() + clockOffset;
  try {
    await app.security.run(() => app.security.downloadArchive());
  } finally {
    Date.now = systemNow;
    HTMLAnchorElement.prototype.click = originalClick;
    URL.createObjectURL = originalCreate;
  }
  if (!blob) throw new Error("Export produced no download: " + app.security.alert.textContent);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const snapshot = await app.store.snapshotForArchive();
  const membership = app.syncCoordinator ? await app.syncCoordinator.portableMembershipSnapshot() : null;
  return { base64: btoa(binary), bytes: bytes.length, events: snapshot.events.length,
    membership, message: app.security.message.textContent };
}

async function pageRestoreArchive({ base64, secret, clockOffset = 0 }) {
  const app = document.querySelector("kin-app");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  location.hash = "#household/privacy";
  app.ctx.navigation.showPageFromLocation();
  app.security.showRestore();
  const file = app.security.querySelector("#archive-file");
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], "kin-household.kin", { type: "application/octet-stream" }));
  file.files = transfer.files;
  app.security.querySelector("#archive-recovery").value = secret;
  const systemNow = Date.now;
  Date.now = () => systemNow() + clockOffset;
  file.form.requestSubmit();
  for (let i = 0; i < 800 && !(!app.security.busy && app.security.querySelector("#restore-confirm")); i++)
    await new Promise((r) => setTimeout(r, 25));
  const confirmation = app.security.querySelector("#restore-confirm");
  Date.now = systemNow;
  if (!confirmation) throw new Error("Archive validation failed: " + app.security.alert.textContent);
  const stagedEvents = (await app.store.loadEvents()).length;
  confirmation.click();
  for (let i = 0; i < 800 && (app.security.busy || app.busy); i++) await new Promise((r) => setTimeout(r, 25));
  if (!app.security.message.textContent.includes("restored on this device"))
    throw new Error("Restore did not complete: " + app.security.alert.textContent + " " + app.security.message.textContent);
  for (let i = 0; i < 400 && (app.busy || !app.household || app.household.busy); i++) await new Promise((r) => setTimeout(r, 25));
  const snapshot = await app.store.snapshotForArchive();
  return {
    stagedEvents,
    events: (await app.store.loadEvents()).length,
    items: app.state?.items.map((item) => item.text) ?? [],
    message: app.security.message.textContent,
    membership: snapshot.local_context[0]?.portable_membership ?? null,
    identity: app.household?.identity ?? null,
    syncState: Boolean(await app.store.getSyncState()),
    coordinator: Boolean(app.syncCoordinator),
  };
}

// ---------------------------------------------------------------------------
// Node-side browser profile management.
// ---------------------------------------------------------------------------

async function launchProfile(executable, label, origin) {
  const profile = await mkdtemp(join(tmpdir(), `kin-authority-${label}-`));
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--edge-skip-compat-layer-relaunch",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  browser.on("error", (error) => console.error(`Browser ${label} failed to launch`, error));
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
    try {
      port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
    } catch {
      await delay(50);
    }
  }
  assert.ok(port, `Browser ${label} did not start`);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin)}`, { method: "PUT" })
    .then((response) => response.json());
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (!task) return;
      message.error ? task.reject(Error(JSON.stringify(message.error))) : task.resolve(message.result);
    }
  };
  socket.onclose = () => {
    for (const task of pending.values()) task.reject(new Error("CDP socket closed"));
    pending.clear();
  };
  const send = (method, params) =>
    new Promise((resolveSend, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {
        pending.delete(next);
        reject(new Error(`CDP timeout: ${method}`));
      }, 60_000);
      pending.set(next, {
        resolve: (value) => { clearTimeout(timer); resolveSend(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails)
      throw new Error(`[${label}] ${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  // A failure names the page function, so a CI log says which step broke.
  const call = (fn, argument) => evaluate(`(${fn.toString()})(${argument === undefined ? "" : JSON.stringify(argument)})`)
    .catch((error) => {
      if (!error.message.startsWith(`[${label}]`)) error.message = `[${label}] ${fn.name || "inline page function"}: ${error.message}`;
      throw error;
    });
  // For page functions that only wait or read: a navigation can tear down
  // the page's context mid-call (#164), so retry those a few times. Never
  // used for a step that changes anything, which must not run twice.
  const contextLost = (error) => /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated/.test(error?.message ?? "");
  const callStable = async (fn, argument) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call(fn, argument);
      } catch (error) {
        if (!contextLost(error) || attempt >= 5) throw error;
        await delay(200);
      }
    }
  };
  await send("Network.enable");
  await waitForOrigin(evaluate, origin, { navigate: () => send("Page.navigate", { url: origin }) });
  await send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  const client = {
    label,
    profile,
    send,
    evaluate,
    call,
    callStable,
    authenticatorId,
    recovery: null,
    async ready() { await callStable(pageWaitReady); },
    async setOffline(offline) {
      await send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },
    // Wait through a navigation until the locked shell is present, then unlock.
    async waitForReloadAndUnlock() {
      let locked = false;
      for (let attempt = 0; attempt < 400 && !locked; attempt += 1) {
        locked = await call(pageIsLocked).catch(() => false);
        if (!locked) await delay(25);
      }
      assert.ok(locked, `[${label}] page did not return to the locked shell after activation`);
      await call(pageUnlock, client.recovery);
      return callStable(pageWaitHousehold);
    },
    async close() {
      try {
        await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
        await send("WebAuthn.disable").catch(() => {});
      } finally {
        const closed = new Promise((resolveClose) => socket.addEventListener("close", resolveClose, { once: true }));
        socket.close();
        await Promise.race([closed, delay(1_000)]);
        if (process.platform === "win32" && browser.pid) {
          const killer = spawn("powershell.exe", ["-NoProfile", "-Command",
            "for ($attempt = 0; $attempt -lt 10; $attempt++) { $targets = Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe' OR Name = 'chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$env:KIN_TEST_PROFILE*\" }; if (-not $targets) { break }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }"],
          { windowsHide: true, stdio: "ignore", env: { ...process.env, KIN_TEST_PROFILE: profile } });
          const [code] = await once(killer, "exit");
          if (code !== 0) console.warn(`Could not terminate browser processes for profile ${label} (PowerShell ${code}).`);
        } else browser.kill();
        if (browser.exitCode === null) await Promise.race([once(browser, "exit"), delay(2_000)]);
        browser.unref();
        await delay(200);
        assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
        await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch((error) => {
          if (error.code !== "EBUSY") throw error;
          console.warn(`Temporary profile ${label} remained busy; the OS may remove it later.`);
        });
      }
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// The drill.
// ---------------------------------------------------------------------------

export async function householdAuthorityDrill({ executable, origin, service, syncService, clock }) {
  let checks = 0;
  const check = (condition, message) => {
    assert.ok(condition, message);
    checks += 1;
  };
  const pass = (message) => console.log(`PASS ${message}`);
  const open = [];
  const launch = async (label) => {
    const client = await launchProfile(executable, label, origin);
    open.push(client);
    await client.ready();
    client.recovery = await client.call(pageSetupProtection);
    await client.callStable(pageWaitHousehold);
    return client;
  };
  const retire = async (client) => {
    open.splice(open.indexOf(client), 1);
    await client.close();
  };
  const relaySession = (memberId, deviceId) => service.issueSession(memberId, deviceId).sessionToken;
  const relayEvents = (token) => {
    const rows = [];
    let cursor = "";
    for (;;) {
      const page = syncService.pull(token, cursor, "20");
      rows.push(...page.events);
      if (!page.events.length || !page.nextCursor || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
      if (rows.length > 500) break;
    }
    return rows;
  };
  // Drives the real fingerprint controls on both sides of a pairing; see the
  // evidence note above pageShownFingerprint().
  const verifyAndApprove = async ({ inviter, invitee, invitation, deviceLabel }) => {
    const approverKey = await inviter.call(pageShownFingerprint, "Compare this household device key");
    const claimed = await invitee.call(pageClaim, { code: invitation.code, deviceLabel });
    check(claimed.state === "Claimed" && claimed.fingerprint, `${deviceLabel} claim is recorded with its local device fingerprint`);
    check(/^[a-f0-9]{64}$/.test(approverKey ?? "") && claimed.shownApprovingKey === approverKey &&
      claimed.shownOwnKey === claimed.fingerprint,
    `${deviceLabel} and its approver render matching fingerprints for both device keys`);
    const approved = await inviter.call(pageApprove, { joiningKey: claimed.shownOwnKey });
    check(approved.visuallyGated && approved.gateSurvivedBusyCycle &&
      approved.refusedBeforeConfirmation && approved.shownKey === claimed.fingerprint,
      `${deviceLabel} approval stays visibly and functionally gated until the approver confirms the compared fingerprint`);
    return { approved, approverKey };
  };
  const join = async ({ inviter, invitee, kind, expiresAt, deviceLabel }) => {
    const invitation = await inviter.call(pageCreatePairing, { kind, expiresAt });
    const { approved, approverKey } = await verifyAndApprove({ inviter, invitee, invitation, deviceLabel });
    check(/^[a-f0-9]{32}$/.test(approved.memberId) && /^[a-f0-9]{32}$/.test(approved.deviceId), `${deviceLabel} approval confirms member and device identities`);
    // pageActivate also refuses to continue unless activation is gated until
    // the joining device confirms the approver fingerprint.
    const activation = await invitee.call(pageActivate, { approvingKey: approverKey });
    check(activation.visuallyGated && activation.gateSurvivedBusyCycle,
      `${deviceLabel} activation stays disabled through a busy cycle until the approver fingerprint is confirmed`);
    const loaded = await invitee.waitForReloadAndUnlock();
    check(loaded.identity?.memberId === approved.memberId && loaded.identity?.deviceId === approved.deviceId,
      `${deviceLabel} holds the approved identity after reload and local unlock`);
    return approved;
  };

  try {
    // ---- Profile A: first Adult, household creator -----------------------
    const a = await launch("adult-a");
    const aBoot = await a.call(pageBootstrap, "Client A");
    check(aBoot.identity && aBoot.prf, "Adult A registers with a real virtual passkey and PRF wrapper");
    await a.call(pageAddItem, "A1 before anyone joins");
    const aSync = await a.call(pageEnableSync);
    check(aSync.enabled, "Adult A enables household sync");
    let result = await a.call(pageSync);
    check(result.last?.state !== "paused", "Adult A completes the first relay sync: " + JSON.stringify(result.last));
    const aRelay = relaySession(aBoot.identity.memberId, aBoot.identity.deviceId);
    check(relayEvents(aRelay).length === 1, "relay holds A1 as one opaque envelope");
    pass(`${checks} household creation assertions (profile A)`);

    // ---- Profile B: second Adult -----------------------------------------
    const b = await launch("adult-b");
    const bIdentity = await join({ inviter: a, invitee: b, kind: "adult", deviceLabel: "Client B" });
    let household = await b.callStable(pageHousehold);
    const bMember = household.members.find((member) => member.current);
    check(bMember?.kind === "adult" && bMember.active, "Adult B is an active Adult in the server household view");
    check(household.adminRecorded && !bMember.admin && !household.canManageMembers &&
      household.members.some((member) => !member.current && member.kind === "adult" && member.admin),
      "the founding Adult A is the household admin and Adult B is not");
    const bPairing = await b.call(pageFetch, { path: "/api/pairings", method: "POST", body: { kind: "limited" } });
    check(bPairing.status === 403 && bPairing.body?.error === "household_admin_required",
      "non-admin Adult B cannot create invitations: " + JSON.stringify(bPairing));
    result = await a.call(pageSync); // A commits the rotation and provisions B's epoch keys.
    check(result.last?.state !== "paused", "Adult A rotates and provisions after B joins: " + JSON.stringify(result.last));
    await a.call(pageAddItem, "A2 after B joined");
    result = await a.call(pageSync);
    result = await b.call(pageSync);
    check(result.started && result.items.includes("A2 after B joined"), "Adult B receives A2 through the relay: " + JSON.stringify(result));
    check(!result.items.includes("A1 before anyone joins"),
      "new Adult B receives current and later epochs only; pre-join A1 is not provisioned (PAIRING contract)");
    pass(`${checks} Adult admission assertions (profiles A and B)`);

    // ---- Profile C: Limited member ---------------------------------------
    let c = await launch("limited-c");
    await join({ inviter: a, invitee: c, kind: "limited", deviceLabel: "Client C" });
    household = await c.callStable(pageHousehold);
    const cMember = household.members.find((member) => member.current);
    check(cMember?.kind === "limited" && cMember.active, "Limited C is an active Limited member");
    for (const probe of [
      { path: "/api/pairings", method: "POST", body: { kind: "adult" } },
      { path: "/api/devices/pairings", method: "POST", body: {} },
      { path: "/api/sync/enable", method: "POST", body: {} },
      { path: "/api/devices", method: "GET" },
      { path: "/api/household/membership/remove/options", method: "POST", body: { memberId: bIdentity.memberId } },
      { path: "/api/sync/provisioning/grants", method: "POST", body: { recipientDeviceId: bIdentity.deviceId, keyEpoch: 1, requestId: "a".repeat(32) } },
      { path: "/api/sync/epochs", method: "POST", body: { expectedEpoch: 1, packages: [], proposalId: "b".repeat(32) } },
    ]) {
      const denied = await c.call(pageFetch, probe);
      check(denied.status === 403 && denied.body?.error === "adult_required",
        `Limited C is denied ${probe.method} ${probe.path} (${denied.status} ${denied.body?.error})`);
    }
    result = await a.call(pageSync);
    result = await c.call(pageSync);
    check(result.started && result.last?.state !== "paused", "Limited C syncs after Adult A provisions it: " + JSON.stringify(result.last));
    const bTrustsC = await b.call(pageTrustDevice, "Client C");
    check(bTrustsC.visuallyGated && bTrustsC.gateSurvivedBusyCycle,
      "Adult B's Trust this device control stays disabled through a busy cycle until code confirmation");
    check(bTrustsC.refusedBeforeConfirmation && bTrustsC.unpinnedBeforeConfirmation,
      "Adult B's forced unconfirmed device-trust click is refused without pinning Client C");
    check(bTrustsC.pinnedAfterConfirmation,
      "Adult B pins Client C exactly after confirming the displayed device code");
    await c.call(pageAddItem, "C1 limited member item");
    result = await c.call(pageSync);
    result = await a.call(pageSync);
    check(result.items.includes("C1 limited member item"), "Adult A receives Limited C's event");
    pass(`${checks} Limited admission and restriction assertions (profile C)`);

    // ---- Remove Limited C while C is offline --------------------------------
    const cDevice = [...service.devices.values()].find((device) => device.memberId === cMember.id);
    await c.setOffline(true);
    await c.call(pageAddItem, "C2 written offline before removal");
    const cBefore = await c.callStable(pageLocal);
    check(cBefore.pendingOutbox >= 1, "Limited C holds an unsent outbox entry while offline");
    await a.call(pageRemoveMemberButton, "Remove Limited member 1 from household");
    check(service.members.get(cMember.id).active === false && service.members.get(cMember.id).memberStatus === "removed",
      "server marks Limited C removed through the Adult UI control");
    check(Boolean(service.devices.get(cDevice.id).revokedAt), "removal revokes Limited C's device");
    await c.setOffline(false);
    result = await c.call(pageSync);
    check(result.last?.state === "paused" && ["authentication_required", "membership_removed", "device_not_trusted"].includes(result.last.code),
      "removed Limited C's reconnect sync is refused: " + JSON.stringify(result.last));
    const cStatus = await c.call(pageFetch, { path: "/api/sync/status" });
    check([401, 403].includes(cStatus.status), `removed Limited C's stale session cannot read sync status (${cStatus.status})`);
    // An empty event batch: "KSEV", version 1, count 0.
    const cPush = await c.call(pageFetch, { path: "/api/sync/events", method: "POST", bytes: [75, 83, 69, 86, 1, 0, 0, 0] });
    check([401, 403].includes(cPush.status), `removed Limited C's stale session cannot push (${cPush.status})`);
    let cAfter = await c.callStable(pageLocal).catch(() => null);
    if (!cAfter) {
      await c.call(pageUnlock, c.recovery);
      cAfter = await c.callStable(pageLocal);
    }
    check(cAfter.events === cBefore.events && cAfter.pendingOutbox === cBefore.pendingOutbox,
      "removal leaves Limited C's local history and unsent outbox intact");
    result = await a.call(pageSync);
    check(result.items.includes("C1 limited member item") && !result.items.includes("C2 written offline before removal"),
      "Adult A keeps C1 history and never receives C's post-removal offline event");
    check(relayEvents(aRelay).filter((row) => row.envelope.deviceId === cDevice.id).length === 1,
      "relay holds exactly C's single pre-removal envelope from C's device");
    pass(`${checks} member removal during disconnection assertions (profile C)`);
    await retire(c);

    // ---- Profile C2: Temporary member with deterministic expiry -------------
    const c2 = await launch("temporary-c2");
    // Short real expiry: the server clock is advanced for instant enforcement.
    const temporaryExpiry = clock.now() + 20_000;
    const c2Identity = await join({ inviter: a, invitee: c2, kind: "temporary", expiresAt: temporaryExpiry, deviceLabel: "Client C2" });
    household = await c2.callStable(pageHousehold);
    const c2Member = household.members.find((member) => member.current);
    check(c2Member?.kind === "temporary" && c2Member.active && c2Member.expiresAt === temporaryExpiry,
      "Temporary C2 carries the inviter-chosen absolute expiry");
    const aheadClockExport = await a.call(pageExportArchive, { clockOffset: 10 * MINUTE });
    check(aheadClockExport.bytes > 0 && aheadClockExport.membership?.some((member) =>
      member.memberId === c2Identity.memberId && member.status === "active"),
      "export preserves active Temporary status when the browser clock is ahead of the server");
    const c2Denied = await c2.call(pageFetch, { path: "/api/pairings", method: "POST", body: { kind: "adult" } });
    check(c2Denied.status === 403 && c2Denied.body?.error === "adult_required", "Temporary C2 cannot manage trust");
    result = await a.call(pageSync);
    result = await c2.call(pageSync);
    check(result.started && result.last?.state !== "paused", "Temporary C2 syncs while unexpired: " + JSON.stringify(result.last));
    await c2.call(pageAddItem, "T1 temporary member item");
    result = await c2.call(pageSync);
    result = await a.call(pageSync);
    check(result.items.includes("T1 temporary member item"), "Adult A receives Temporary C2's event");
    const c2Local = await c2.callStable(pageLocal);
    result = await b.call(pageSync);
    check(result.last?.state !== "paused", "Adult B holds the current epoch before the expiry race: " + JSON.stringify(result.last));
    const epochBeforeExpiry = syncService.status(
      relaySession(bIdentity.memberId, bIdentity.deviceId),
    ).currentEpoch;
    await a.call(pagePauseAutomaticSync);
    await a.setOffline(true);
    clock.offset += 4 * MINUTE; // Server time passes the expiry; browsers keep real time.
    household = await b.callStable(pageHousehold);
    const expiredView = household.members.find((member) => member.id === c2Identity.memberId);
    check(expiredView && expiredView.active === false, "Adult B's household view shows Temporary C2 ended after expiry");
    check(service.members.get(c2Identity.memberId).memberStatus === "expired", "server records natural expiry, not removal");
    const c2Status = await c2.call(pageFetch, { path: "/api/sync/status" });
    check([401, 403].includes(c2Status.status), `expired Temporary C2 cannot read sync status (${c2Status.status})`);
    result = await c2.call(pageSync).catch(() => ({ last: { state: "paused", code: "locked" } }));
    check(result.last?.state === "paused", "expired Temporary C2's sync pauses: " + JSON.stringify(result.last));
    let c2After = await c2.callStable(pageLocal).catch(() => null);
    if (!c2After) {
      await c2.call(pageUnlock, c2.recovery);
      c2After = await c2.callStable(pageLocal);
    }
    check(c2After.events === c2Local.events, "expiry leaves Temporary C2's local history intact");
    result = await b.call(pageSync);
    check(result.last?.state !== "paused", "Adult B commits the expiry rotation while Adult A is offline: " + JSON.stringify(result.last));
    const committedEpoch = syncService.status(
      relaySession(bIdentity.memberId, bIdentity.deviceId),
    ).currentEpoch;
    check(committedEpoch === epochBeforeExpiry + 1, "Adult B commits exactly the epoch reserved by Temporary expiry");
    const waitingForA = [...syncService.state(aBoot.identity.householdId).grants.values()]
      .find((grant) => grant.recipientDeviceId === aBoot.identity.deviceId && grant.keyEpoch === committedEpoch);
    check(waitingForA?.committedRotation === true, "the committed epoch package remains queued for offline Adult A");
    pass(`${checks} Temporary expiry and committed-rotation race assertions (profiles A, B, C2)`);
    await retire(c2);

    // ---- Revoke the rotation sender before A receives its package ----------
    await b.setOffline(true);
    await b.call(pageAddItem, "B1 written offline before revocation");
    const bBefore = await b.callStable(pageLocal);
    check(bBefore.pendingOutbox >= 1, "Adult B holds an unsent outbox entry while offline");
    await a.setOffline(false);
    await a.call(pageRevokeDeviceButton, "Client B");
    check(Boolean(service.devices.get(bIdentity.deviceId).revokedAt), "Adult A revokes B's device with a fresh passkey through the UI");
    check(service.members.get(bIdentity.memberId).active === true, "device revocation keeps B's membership (device ≠ member)");
    check(syncService.state(aBoot.identity.householdId).grants.has(waitingForA.grantId),
      "revoking the rotation sender preserves the package for still-trusted Adult A");
    clock.offset += 7 * MINUTE;
    await a.call(pageResumeAutomaticSync);
    await a.call(pageShiftClock, 11 * MINUTE);
    result = await a.call(pageSync);
    await a.call(pageRestoreClock);
    clock.offset -= 7 * MINUTE;
    check(result.last?.state !== "paused", "Adult A recovers the expired committed package and rotates after revocation: " + JSON.stringify(result.last));
    check(syncService.status(relaySession(aBoot.identity.memberId, aBoot.identity.deviceId)).currentEpoch === committedEpoch + 1,
      "Adult A obtains the committed epoch before completing the required post-revocation rotation");
    await b.setOffline(false);
    result = await b.call(pageSync);
    check(result.last?.state === "paused" && ["authentication_required", "device_not_trusted"].includes(result.last.code),
      "revoked B's reconnect sync is refused: " + JSON.stringify(result.last));
    const bPush = await b.call(pageFetch, { path: "/api/sync/events", method: "POST", bytes: [75, 83, 69, 86, 1, 0, 0, 0] });
    check([401, 403].includes(bPush.status), `revoked B cannot push its stale outbox (${bPush.status})`);
    const bLogin = await b.call(pageFetch, { path: "/api/login/options", method: "POST", body: {} });
    check(bLogin.status !== 200, `revoked B's device cookie cannot start a fresh login (${bLogin.status} ${bLogin.body?.error ?? ""})`);
    let bAfter = await b.callStable(pageLocal).catch(() => null);
    if (!bAfter) {
      await b.call(pageUnlock, b.recovery);
      bAfter = await b.callStable(pageLocal);
    }
    check(bAfter.events === bBefore.events && bAfter.pendingOutbox === bBefore.pendingOutbox,
      "revocation leaves B's local history and unsent outbox intact");
    result = await a.call(pageSync);
    check(!result.items.includes("B1 written offline before revocation"), "Adult A never receives B's post-revocation offline event");
    check(!relayEvents(aRelay).some((row) => row.envelope.deviceId === bIdentity.deviceId),
      "relay holds no envelope from B's device");
    pass(`${checks} device revocation during disconnection assertions (profile B)`);
    await retire(b);

    // ---- Export from A ------------------------------------------------------
    while (Date.now() <= temporaryExpiry + 1_000) await delay(250);
    const exported = await a.call(pageExportArchive, { clockOffset: -10 * MINUTE });
    check(exported.bytes > 0 && exported.message.includes("export prepared"), "Adult A exports a household archive through the product control");
    const statuses = Object.fromEntries((exported.membership ?? []).map((member) => [member.memberId, `${member.memberKind}:${member.status}`]));
    check(statuses[aBoot.identity.memberId] === "adult:active" && statuses[bIdentity.memberId] === "adult:active" &&
      statuses[cMember.id] === "limited:removed" && statuses[c2Identity.memberId] === "temporary:expired",
      "archive membership snapshot records active, removed, and expired statuses: " + JSON.stringify(statuses));
    const aLocalAtExport = await a.callStable(pageLocal);
    check(exported.events === aLocalAtExport.events, "archive event count equals Adult A's local history");
    await a.call(pageAddItem, "A3 after export");
    result = await a.call(pageSync);
    const relayTotal = relayEvents(aRelay).length;
    pass(`${checks} export assertions (profile A)`);

    // ---- Profile D: clean browser, restore, then re-authorize ---------------
    const d = await launch("restore-d");
    const restored = await d.call(pageRestoreArchive, {
      base64: exported.base64, secret: a.recovery, clockOffset: 10 * MINUTE,
    });
    check(restored.stagedEvents === 0, "validation stages the archive without touching the empty target");
    check(restored.events === exported.events, `restore imports the exact archive history (${restored.events} events)`);
    check(restored.items.includes("A1 before anyone joins") && restored.items.includes("C1 limited member item") &&
      restored.items.includes("T1 temporary member item") && !restored.items.includes("A3 after export"),
      "restored history includes removed and expired members' events and nothing after the export");
    check(JSON.stringify(restored.membership) === JSON.stringify(exported.membership),
      "restored membership snapshot preserves removed and expired statuses");
    check(restored.identity === null && !restored.syncState && !restored.coordinator,
      "restore grants no identity, sync state, or coordinator");
    const dStatus = await d.call(pageFetch, { path: "/api/sync/status" });
    check(dStatus.status === 401, `restored clean profile has no sync authority (${dStatus.status})`);
    check(restored.message.includes("needs household approval"), "restore notice states that approval is still required");
    // Same-member device pairing is the documented path to re-authorize a restored device.
    const invitation = await a.call(async () => {
      const app = document.querySelector("kin-app");
      await app.household.createDevicePairing();
      const shownCode = app.household.querySelector(".pairing-code")?.textContent;
      const alert = app.household.querySelector('.household-message[role="alert"]');
      if (!app.household.pairing?.code || alert || shownCode !== app.household.pairing.code)
        throw new Error("Device pairing failed: " + (alert?.textContent ?? "the code was not displayed"));
      return { code: shownCode };
    });
    await d.callStable(pageWaitHousehold);
    const { approved: dApproved, approverKey: dApproverKey } =
      await verifyAndApprove({ inviter: a, invitee: d, invitation, deviceLabel: "Client D" });
    check(dApproved.memberId === aBoot.identity.memberId, "device pairing binds D to Adult A's membership");
    const dActivation = await d.call(pageActivate, { approvingKey: dApproverKey });
    check(dActivation.visuallyGated && dActivation.gateSurvivedBusyCycle,
      "D activation stays disabled through a busy cycle until the approver fingerprint is confirmed");
    const dLoaded = await d.waitForReloadAndUnlock();
    check(dLoaded.identity?.deviceId === dApproved.deviceId, "D holds the approved same-member device identity");
    result = await a.call(pageSync); // rotation + provisioning for D (all epochs for a same-member device)
    check(result.last?.state !== "paused", "Adult A provisions D's device: " + JSON.stringify(result.last));
    result = await d.call(pageSync);
    if (result.last?.state === "paused") result = await d.call(pageSync);
    check(result.last?.state !== "paused", "restored D syncs after approval: " + JSON.stringify(result.last));
    const dLocal = await d.callStable(pageLocal);
    const aLocal = await a.callStable(pageLocal);
    check(dLocal.items.includes("A3 after export"), "D catches up with history created after the export");
    check(dLocal.events === aLocal.events && JSON.stringify(dLocal.eventIds) === JSON.stringify(aLocal.eventIds),
      `D and A hold identical event sets without duplication (${dLocal.events} events)`);
    check(relayEvents(aRelay).length === relayTotal, "re-authorizing a restored device adds no duplicate relay events");
    pass(`${checks} clean-profile restore and re-authorization assertions (profile D)`);

    // ---- Two authorized clients reconnect after concurrent offline edits ------
    await a.setOffline(true);
    await d.setOffline(true);
    await a.call(pageAddItem, "A4 offline concurrent");
    await d.call(pageAddItem, "D1 offline concurrent");
    await a.setOffline(false);
    await d.setOffline(false);
    for (const client of [a, d, a, d]) {
      result = await client.call(pageSync);
      check(result.last?.state !== "paused", `${client.label} reconnect sync completes: ` + JSON.stringify(result.last));
    }
    const aFinal = await a.callStable(pageLocal);
    const dFinal = await d.callStable(pageLocal);
    check(aFinal.items.includes("A4 offline concurrent") && aFinal.items.includes("D1 offline concurrent") &&
      dFinal.items.includes("A4 offline concurrent") && dFinal.items.includes("D1 offline concurrent"),
      "both clients converge on both offline items");
    check(aFinal.events === dFinal.events && JSON.stringify(aFinal.eventIds) === JSON.stringify(dFinal.eventIds),
      `both clients hold identical event sets (${aFinal.events} events)`);
    check(aFinal.pendingOutbox === 0 && dFinal.pendingOutbox === 0, "no outbox entries remain after reconciliation");
    check(aFinal.items.filter((text) => text === "A4 offline concurrent").length === 1 &&
      dFinal.items.filter((text) => text === "D1 offline concurrent").length === 1,
      "repeated syncs do not duplicate items");
    check(relayEvents(aRelay).length === relayTotal + 2, "relay gained exactly the two concurrent events");
    pass(`${checks} two-client reconciliation assertions (profiles A and D)`);
    console.log(`PASS ${checks} live household authority and recovery assertions across independent browser profiles`);
    return checks;
  } finally {
    for (const client of [...open]) await client.close().catch((error) => console.warn(error.message));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/household-authority-regression.mjs <browser executable>");
  const reservation = createServer();
  await new Promise((resolveListen) => reservation.listen(0, "127.0.0.1", resolveListen));
  const applicationPort = reservation.address().port;
  await new Promise((resolveClose) => reservation.close(resolveClose));
  const origin = `http://localhost:${applicationPort}`;
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const { server, store, service, syncService } = createKinServer({
    port: applicationPort,
    host: "127.0.0.1",
    origin,
    store: new DurableStore(":memory:"),
    now: () => clock.now(),
  });
  await new Promise((resolveListen) => server.listen(applicationPort, "127.0.0.1", resolveListen));
  try {
    await householdAuthorityDrill({ executable, origin, service, syncService, clock });
  } finally {
    server.closeAllConnections();
    try {
      await new Promise((resolveClose) => server.close(resolveClose));
    } finally {
      store.close();
    }
  }
  process.exit(0);
}
