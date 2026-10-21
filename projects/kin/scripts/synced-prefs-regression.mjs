// Reminders and settings that follow a member (#520, #521, #524), in a real
// browser against the production Kin server: one member, two browser
// contexts (a phone in New York and a laptop in Paris). The member signs up
// with a password on the phone (#557), so the phone keeps the account vault
// key and private storage is on. The laptop joins as the same member through
// the existing same-member path, "Add my device" (a device pairing with a
// passkey, approved on the phone with the password). Until a new device can
// sign in with the password and open the vault itself (#568), the laptop is
// handed the phone's vault key the way that story will give it one; nothing
// else is stood in for.
//
// Then: a reminder, a theme and a text size set on the phone arrive on the
// laptop (the reminder at the same instant, with the phone's time zone beside
// it); the reminder goes off on the laptop and is dismissed there, and it is
// gone from the phone; and a laptop that uses its own settings keeps them
// while the phone changes the theme again.
//
// browser-regression.mjs runs this (part 2) with its browser; it can also
// run alone: node scripts/synced-prefs-regression.mjs <browser executable>
import { BROWSER_STDIO, waitForDevTools } from "./browser-launch.mjs";
import { captureFailure, waitForOrigin } from "./cdp-page.mjs";
import { createHousehold, eventually, isolatedPage, pageClient } from "./first-run-regression.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createKinServer } from "../server/server.mjs";
import { DurableStore } from "../server/durable-store.mjs";

const MEMBER = { name: "Jordan", household: "The Okafors", username: "jordan.okafor", password: "copper willow lighthouse" };
// The reminder is due soon enough to go off during the run.
const REMINDER_IN_MS = 45_000;
// Lets a killed browser release its profile before the folder is removed.
const BROWSER_EXIT_MS = 300;

// ---- In-page steps (stringified and run in the browser) ---------------------

async function pageSetupProtection() {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 1200 && !(app?.security?.heading && !app.starting); i++) await new Promise((r) => setTimeout(r, step));
  app.security.showSetup();
  const recovery = app.security.querySelector(".recovery-key").textContent;
  const input = app.security.querySelector("#confirm-recovery");
  input.checked = true;
  input.form.requestSubmit();
  for (let i = 0; i < 400 && !(app.store && !app.security.busy && !app.busy); i++) await new Promise((r) => setTimeout(r, step));
  if (!app.store) throw new Error("Recovery setup did not unlock: " + app.security.alert.textContent);
  for (let i = 0; i < 400 && !(app.household && !app.household.busy && app.household.childElementCount > 0); i++) await new Promise((r) => setTimeout(r, step));
  return recovery;
}

async function pageCreateDevicePairing() {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 1200 && !(app.household?.identity && app.household.syncStatus?.enabled && !app.household.busy); i++)
    await new Promise((r) => setTimeout(r, step));
  await app.household.loaded;
  await app.household.createDevicePairing();
  if (!app.household.pairing?.code) throw new Error("No device pairing code: " + app.household.textContent.slice(0, 300));
  return app.household.pairing.code;
}

async function pageClaimDevice(code) {
  const app = document.querySelector("kin-app");
  await app.household.register("claim", { code, deviceLabel: "Laptop" });
  const claim = app.household.claim;
  if (!claim) throw new Error("The laptop's claim failed: " + (app.household.querySelector(".household-message")?.textContent ?? ""));
  return claim.state;
}

async function pageApproveDevice(member) {
  const step = 25; // ms between looks at the page's state
  const wait = async (condition, label, ms = 30_000) => {
    for (let i = 0, step = 25; i < ms / step; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, step)); }
    throw new Error(`Wait timed out: ${label}; household=${document.querySelector("kin-app")?.household?.textContent?.slice(0, 300)}`);
  };
  const household = document.querySelector("kin-app").household;
  for (let i = 0; i < 300 && household.pairing?.state !== "Claimed"; i++) {
    const latest = await household.api(`/api/pairings/${household.pairing.pairingId}`);
    if (latest.state === "Claimed") { household.pairing = { ...household.pairing, ...latest }; household.render(); break; }
    await new Promise((r) => setTimeout(r, step));
  }
  await wait(() => household.pairing?.state === "Claimed" && household.pairing.syncKeyFingerprint, "the laptop's claim reaches the phone");
  household.verifiedFingerprint = household.pairing.syncKeyFingerprint;
  // The member has no passkey yet: approving asks for the password (#557).
  const approving = household.ctx.pairing.approve();
  await wait(() => document.querySelector("dialog.password-confirmation input[type=password]"), "the password confirmation");
  const dialog = document.querySelector("dialog.password-confirmation");
  dialog.querySelector("input[type=password]").value = member.password;
  dialog.querySelector("form").requestSubmit();
  await approving;
  await wait(() => household.pairing?.state === "Confirmed", "the laptop approved");
  return household.pairing.confirmedMemberId;
}

async function pageActivateDevice() {
  const step = 25; // ms between looks at the page's state
  const household = document.querySelector("kin-app").household;
  for (let i = 0; i < 300 && household.claim?.state !== "Confirmed"; i++) {
    const latest = await household.api("/api/claim");
    if (latest.state === "Confirmed") { household.claim = latest; household.render(); break; }
    await new Promise((r) => setTimeout(r, step));
  }
  if (household.claim?.state !== "Confirmed") throw new Error("The laptop never saw its approval: " + JSON.stringify(household.claim));
  household.verifiedInviterFingerprint = true;
  // Activation may navigate: return first, then activate.
  setTimeout(() => void household.ctx.pairing.activateClaim(), 100);
  return true;
}

async function pageUnlockIfLocked(secret) {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  for (let i = 0; i < 1200 && !(app?.security?.heading && !app.starting && !app.security.busy); i++)
    await new Promise((r) => setTimeout(r, step));
  if (!app.store) await app.security.run(() => app.security.unlockRecovery(secret));
  for (let i = 0; i < 1200 && !(app.store && !app.busy && app.household?.identity); i++) await new Promise((r) => setTimeout(r, step));
  if (!app.household?.identity) throw new Error("The laptop didn't unlock as a household device: " + app.security.alert?.textContent);
  return "unlocked";
}

async function pageSync() {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  if (!app.syncCoordinator) await app.ctx.sync.configureSyncCoordinator();
  const coordinator = app.syncCoordinator;
  if (!coordinator) throw new Error("No sync on this device.");
  for (let i = 0; i < 1200 && (!coordinator.deviceKeys || coordinator.running); i++) await new Promise((r) => setTimeout(r, step));
  await coordinator.running;
  await coordinator.syncNow();
  await coordinator.running;
  for (let i = 0; i < 20; i++) await app.ctx.privatePrefs.work;
  return { state: app.syncState?.state ?? null, code: app.syncState?.code ?? null, privateLog: Boolean(coordinator.privateLog), scope: app.ctx.privatePrefs.scope };
}

async function pageIdentity() {
  const identity = document.querySelector("kin-app").household.identity;
  return { memberId: identity.memberId, deviceId: identity.deviceId, householdId: identity.householdId };
}

async function pageExportVaultKey() {
  const household = document.querySelector("kin-app").household;
  const key = await household.syncKeyStore.accountVaultKey(household.identity.householdId);
  if (!key) throw new Error("The phone keeps no vault key.");
  const text = btoa(String.fromCharCode(...key));
  key.fill(0);
  return text;
}

async function pageImportVaultKey(text) {
  const household = document.querySelector("kin-app").household;
  const key = Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  await household.syncKeyStore.setAccountVaultKey(household.identity.deviceId, key);
  key.fill(0);
  return true;
}

async function pageSetReminderAndTheme(inMs) {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  if (!prefs.active) throw new Error("Private storage isn't on: " + prefs.scope);
  const item = app.state.items.find((entry) => entry.text === "Milk" && entry.status === "active");
  const id = `item:${item.itemId}`;
  const at = Math.ceil((Date.now() + inMs) / 1000) * 1000;
  await app.ctx.records.handleLocalReminder({ id, title: item.text, at });
  // The theme through the appearance editor's own save.
  const { resolveAppearance } = await import("/appearance/household.js");
  const baseline = resolveAppearance(app.personalAppearance, app.householdSettings);
  await new Promise((resolve, reject) => app.ctx.appearance.handleSaveAppearance({ detail: {
    value: { ...baseline, mode: "dark" }, baseline, forceExplicit: false,
    complete: (value, error) => (error ? reject(error) : resolve(value)),
  } }));
  await prefs.setDisplaySetting("text-size", "large");
  for (let i = 0; i < 400; i++) {
    await prefs.refresh();
    const projection = prefs.projection;
    if (projection?.reminders.some((reminder) => reminder.reminderId === id && reminder.at === at) &&
        projection.settings["theme-mode"]?.value === "dark" && projection.settings["text-size"]?.value === "large") break;
    await new Promise((r) => setTimeout(r, step));
  }
  const reminder = prefs.projection.reminders.find((entry) => entry.reminderId === id);
  if (!reminder) throw new Error("The reminder isn't in the private log.");
  return {
    id, at, timeZone: reminder.timeZone, offset: reminder.utcOffsetMinutes,
    theme: prefs.projection.settings["theme-mode"]?.value, textSize: prefs.projection.settings["text-size"]?.value,
  };
}

async function pageArrived({ id, at }) {
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  const view = prefs.reminderView().get(id);
  return {
    reminder: view ? { at: view.at, scope: view.scope, where: view.where } : null,
    // Armed for that instant, or already gone off here.
    armed: app.localReminders.entries.get(id)?.at === at || prefs.fired.has(`${id}@${at}`),
    theme: app.personalAppearance?.mode ?? null,
    applied: document.documentElement.dataset.kinAppearance ?? null,
    textSize: document.documentElement.dataset.kinTextSize ?? null,
    scope: prefs.scope,
    settingsLine: app.personalSettings?.querySelector(".personal-settings-scope")?.textContent ?? "",
  };
}

async function pageDismissWhenItGoesOff({ id, at, ms }) {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  for (let i = 0; i < ms / step && !prefs.shown.has(id); i++) await new Promise((r) => setTimeout(r, step));
  const shown = prefs.shown.get(id);
  let how;
  if (shown?.at === at) {
    // The member clicks the notification, as on a real screen (a click is
    // a dismissal on every platform; a close event isn't reported on all).
    shown.notification.dispatchEvent(new Event("click"));
    how = "clicked the notification";
  } else {
    // A browser that can't construct a notification here: the same step
    // closing it takes.
    await prefs.endReminder(id, "dismissed", at);
    how = "dismissed without a notification";
  }
  const gone = () => !prefs.projection?.reminders.some((reminder) => reminder.reminderId === id);
  for (let i = 0; i < 400 && !gone(); i++) {
    await prefs.work;
    await new Promise((r) => setTimeout(r, step));
  }
  return { how, gone: gone() };
}

async function pageGone(id) {
  const app = document.querySelector("kin-app");
  const prefs = app.ctx.privatePrefs;
  return {
    inLog: Boolean(prefs.projection?.reminders.some((reminder) => reminder.reminderId === id)),
    shown: prefs.reminderView().has(id),
    armed: app.localReminders.entries.has(id),
    notificationOpen: Boolean(prefs.shown.get(id)),
  };
}

async function pageUseOwnSettings(on) {
  const app = document.querySelector("kin-app");
  app.ctx.privatePrefs.setDeviceOnly(on);
  for (let i = 0; i < 20; i++) await app.ctx.privatePrefs.work;
  return app.ctx.privatePrefs.scope;
}

async function pageSetTheme(mode) {
  const step = 25; // ms between looks at the page's state
  const app = document.querySelector("kin-app");
  const { resolveAppearance } = await import("/appearance/household.js");
  const baseline = resolveAppearance(app.personalAppearance, app.householdSettings);
  await new Promise((resolve, reject) => app.ctx.appearance.handleSaveAppearance({ detail: {
    value: { ...baseline, mode }, baseline, forceExplicit: false,
    complete: (value, error) => (error ? reject(error) : resolve(value)),
  } }));
  for (let i = 0; i < 400 && app.ctx.privatePrefs.projection?.settings["theme-mode"]?.value !== mode; i++) {
    await app.ctx.privatePrefs.refresh();
    await new Promise((r) => setTimeout(r, step));
  }
  return app.ctx.privatePrefs.projection?.settings["theme-mode"]?.value;
}

// ---- The suite -------------------------------------------------------------------

/**
 * Runs the synced reminders and settings checks with an existing browser.
 * `endpoint` is its DevTools HTTP address and `browserClient` a CDP client
 * for the browser target (for isolated contexts).
 */
export async function syncedPrefsRegressions({ endpoint, browserClient }) {
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const origin = `http://localhost:${port}`;
  const store = new DurableStore(":memory:");
  const kin = createKinServer({ port, host: "127.0.0.1", origin, store });
  await new Promise((done) => kin.server.listen(port, "127.0.0.1", done));
  const pages = [];
  let checks = 0;
  const check = (value, message) => { assert.ok(value, message); checks += 1; };
  const run = (client, fn, argument) => client.evaluate(`(${fn.toString()})(${argument === undefined ? "" : JSON.stringify(argument)})`)
    .catch((error) => { error.message = `${fn.name}: ${error.message}`; throw error; });
  const open = async (url, timezoneId) => {
    const page = await isolatedPage(endpoint, browserClient, url);
    pages.push(page);
    await page.client.send("Emulation.setTimezoneOverride", { timezoneId });
    await browserClient.send("Browser.grantPermissions", { origin, permissions: ["notifications"], browserContextId: page.browserContextId });
    await waitForOrigin(page.client.evaluate, origin, { navigate: () => page.client.send("Page.navigate", { url }) });
    return page.client;
  };
  try {
    // The phone, in New York: a password sign-up, so private storage is on.
    const phone = await open(origin, "America/New_York");
    const created = await run(phone, createHousehold, MEMBER);
    const phoneSync = await eventually(async () => {
      const result = await run(phone, pageSync);
      return result.scope === "synced" ? result : null;
    }, "private storage on the phone", 60_000);
    check(phoneSync.privateLog, "the phone opens the member's private log and makes the member key on first use");

    // The laptop, in Paris: the same member through "Add my device".
    const laptopPage = await isolatedPage(endpoint, browserClient, "about:blank");
    pages.push(laptopPage);
    const laptop = laptopPage.client;
    await laptop.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Paris" });
    await browserClient.send("Browser.grantPermissions", { origin, permissions: ["notifications"], browserContextId: laptopPage.browserContextId });
    await laptop.send("WebAuthn.enable", { enableUI: false });
    await laptop.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
    } });
    await laptop.send("Page.navigate", { url: origin });
    await waitForOrigin(laptop.evaluate, origin, { navigate: () => laptop.send("Page.navigate", { url: origin }) });
    const recovery = await run(laptop, pageSetupProtection);
    const code = await run(phone, pageCreateDevicePairing);
    check((await run(laptop, pageClaimDevice, code)) === "Claimed", "the laptop claims the phone's device pairing");
    const approvedMember = await run(phone, pageApproveDevice, MEMBER);
    check(approvedMember === created.identity.memberId, "the phone approves the laptop as the same member, with the password");
    await run(laptop, pageActivateDevice);
    // Activation reloads Kin into its lock screen; the laptop unlocks with
    // its own backup key.
    const laptopIdentity = await eventually(async () => {
      if ((await run(laptop, pageUnlockIfLocked, recovery).catch(() => null)) !== "unlocked") return null;
      const identity = await run(laptop, pageIdentity).catch(() => null);
      return identity?.memberId === created.identity.memberId ? identity : null;
    }, "the laptop is a household device", 90_000);
    check(laptopIdentity.memberId === created.identity.memberId && laptopIdentity.deviceId !== created.identity.deviceId,
      "one member, two devices");
    await run(phone, pageSync); // provisions the laptop's household keys
    await eventually(async () => (await run(laptop, pageSync)).state === "ready", "the laptop syncs the household", 60_000);
    // #568 stand-in: the laptop gets the member's vault key.
    await run(laptop, pageImportVaultKey, await run(phone, pageExportVaultKey));
    const laptopSync = await eventually(async () => {
      const result = await run(laptop, pageSync);
      return result.scope === "synced" ? result : null;
    }, "private storage on the laptop", 60_000);
    check(laptopSync.privateLog, "the laptop opens the same private log with the member key from the vault");

    // A reminder, a theme and a text size, set on the phone.
    const set = await run(phone, pageSetReminderAndTheme, REMINDER_IN_MS);
    check(set.timeZone === "America/New_York" && [-240, -300].includes(set.offset),
      `the reminder keeps its absolute instant and the phone's zone: ${JSON.stringify(set)}`);
    check(set.theme === "dark" && set.textSize === "large", "the theme and text size are in the private log");
    await run(phone, pageSync);
    const arrived = await eventually(async () => {
      await run(laptop, pageSync);
      const value = await run(laptop, pageArrived, { id: set.id, at: set.at });
      return value.reminder && value.theme === "dark" && value.textSize === "large" ? value : null;
    }, "the reminder and settings on the laptop", 60_000);
    check(arrived.reminder.at === set.at && arrived.reminder.scope === "devices", "the laptop has the reminder at the same instant");
    check(/in America\/New_York, where it was set$/.test(arrived.reminder.where),
      `in Paris the reminder also says the time where it was set: ${arrived.reminder.where}`);
    check(arrived.armed, "the laptop, which allows notifications, arms it");
    check(arrived.applied === "dark", "the laptop shows the dark theme");
    check(arrived.scope === "synced" && /follow you to your other devices/.test(arrived.settingsLine), "the laptop's settings say they follow the member");

    // It goes off; the member dismisses it on the laptop; it's gone from the phone.
    const dismissed = await run(laptop, pageDismissWhenItGoesOff, { id: set.id, at: set.at, ms: REMINDER_IN_MS + 30_000 });
    check(dismissed.gone, `dismissed on the laptop (${dismissed.how})`);
    await run(laptop, pageSync);
    const gone = await eventually(async () => {
      await run(phone, pageSync);
      const value = await run(phone, pageGone, set.id);
      return !value.inLog ? value : null;
    }, "the dismissal on the phone", 60_000);
    check(!gone.shown && !gone.armed && !gone.notificationOpen, "the phone no longer shows, arms or displays the reminder");

    // A laptop that keeps its own settings (a kitchen tablet, say).
    check((await run(laptop, pageUseOwnSettings, true)) === "device-only", "the laptop uses its own settings");
    check((await run(phone, pageSetTheme, "light")) === "light", "the phone switches to the light theme");
    await run(phone, pageSync);
    await run(laptop, pageSync);
    await run(laptop, pageSync);
    const kept = await run(laptop, pageArrived, { id: set.id, at: set.at });
    check(kept.theme === "dark" && kept.applied === "dark", "the laptop keeps its own dark theme");
    check((await run(laptop, pageUseOwnSettings, false)) === "synced", "following again");
    const followed = await eventually(async () => {
      const value = await run(laptop, pageArrived, { id: set.id, at: set.at });
      return value.theme === "light" ? value : null;
    }, "the laptop follows the member's light theme again", 30_000);
    check(followed.applied === "light", "the laptop shows the member's light theme again");
    return `PASS ${checks} synced reminder and settings checks across two devices of one member (${dismissed.how})`;
  } finally {
    for (const page of pages) {
      page.client.close();
      await browserClient.send("Target.disposeBrowserContext", { browserContextId: page.browserContextId }).catch(() => {});
    }
    kin.server.closeAllConnections?.();
    await new Promise((done) => kin.server.close(done));
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executable = process.argv[2];
  assert.ok(executable, "Usage: node scripts/synced-prefs-regression.mjs <browser executable>");
  const profile = await mkdtemp(join(tmpdir(), "kin-synced-prefs-"));
  const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run",
    "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], BROWSER_STDIO);
  let browserClient;
  try {
    const port = await waitForDevTools(browser, profile);
    const endpoint = `http://127.0.0.1:${port}`;
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    browserClient = await pageClient(version.webSocketDebuggerUrl);
    console.log(await syncedPrefsRegressions({ endpoint, browserClient }));
  } catch (error) {
    await captureFailure("synced reminders and settings regression");
    throw error;
  } finally {
    browserClient?.close();
    browser.kill();
    await delay(BROWSER_EXIT_MS);
    assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep), "Refuse cleanup outside the test-profile directory");
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  process.exit(0);
}
