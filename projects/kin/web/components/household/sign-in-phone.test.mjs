// Sign in with your phone, the computer's side (#100): the request, its QR
// code and countdown, the code field, completion for a new and a returning
// computer, and every way the request ends. Without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { installDom } from "../qr-test-dom.mjs";
import { cleanLinkCode, isLinkCode, signInLink, signInRequest } from "../../device-link.js";

const defined = installDom();
const ORIGIN = "https://kin.test";
const where = { origin: ORIGIN, pathname: "/", href: `${ORIGIN}/` };
Object.defineProperty(globalThis, "location", { configurable: true, value: where });
const replaced = [];
globalThis.history = { replaceState: (_, __, url) => replaced.push(url) };
globalThis.requestAnimationFrame = (callback) => callback();
const released = [];
globalThis.fetch = async (url, init) => {
  released.push({ url, init });
  return { ok: true, json: async () => ({}) };
};
await import("../kin-qr.js");
const { HouseholdLink, MAX_SIGN_IN_REFRESHES, SIGN_IN_STEPS } = await import("./link.js");

const FRESH = { agreement: { kty: "EC", x: "fresh" }, signing: { kty: "EC", x: "fresh-s" } };
const BOUND = { agreement: { kty: "EC", x: "bound" }, signing: { kty: "EC", x: "bound-s" } };
const hex = (n, c) => c.repeat(n);
let serial = 0;
const created = (extra = {}) => {
  serial += 1;
  return {
    requestId: String(serial).padStart(32, "0"),
    secret: `S${String(serial).padStart(42, "x")}`,
    fingerprint: hex(64, "f"),
    expiresAt: Date.now() + 120_000,
    returning: false,
    ...extra,
  };
};

/** A household element stand-in around the link part, with a scripted API. */
function rig({ bound = null, routes = {} } = {}) {
  const calls = [];
  const bindings = [];
  const store = {
    latestBoundDevice: async () => bound,
    getOrCreatePendingDevice: async () => ({ publicKeys: FRESH }),
    bindPendingDevice: async (identity) => { bindings.push(identity); return identity; },
  };
  const host = document.createElement("div");
  host.isConnected = true;
  let busy = false;
  Object.assign(host, {
    intent: "phone",
    syncKeyStore: store,
    errors: [],
    loads: 0,
    get busy() { return busy; },
    async run(action) {
      if (busy) return;
      busy = true;
      try { await action(); } catch (error) { host.errors.push(error); } finally { busy = false; }
    },
    async api(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options.method ?? "GET", body });
      const route = Object.entries(routes).find(([pattern]) => path.endsWith(pattern));
      if (!route) throw new Error(`unexpected ${path}`);
      return route[1](body, path);
    },
    async load() { host.loads += 1; },
    text(content) { const p = document.createElement("p"); p.textContent = content; host.append(p); return p; },
    button(label, action, className) { const b = host.makeButton(label, action, className); host.append(b); return b; },
    makeButton(label, action) { const b = document.createElement("button"); b.textContent = label; b.addEventListener("click", () => action?.()); return b; },
    startIntent(kind) { host.intent = kind; host.render(); },
    render() { host.replaceChildren(); if (host.intent === "phone") link.render(); },
  });
  const ctx = { host, api: { openSyncKeyStore: async () => store } };
  const link = new HouseholdLink(ctx);
  ctx.link = link;
  return { host, link, calls, bindings };
}

const qrOf = (host) => host.find((node) => node.constructor === defined["kin-qr"]);
const texts = (host) => [...host.all()].map((node) => node._text).filter(Boolean);
const releases = () => released.filter((entry) => entry.init?.method === "DELETE");

test.afterEach(() => { released.length = 0; replaced.length = 0; });

test("the screen asks with fresh keys and shows the request as a QR code for its fragment link", async () => {
  const request = created();
  const { host, link, calls } = rig({ routes: { "/api/link/requests": () => request } });
  await link.begin();
  link.stop();
  const ask = calls.find((call) => call.path === "/api/link/requests");
  assert.deepEqual(ask.body.syncPublicKeys, FRESH);
  assert.equal(typeof ask.body.deviceLabel, "string", "the computer's automatic name");
  const qr = qrOf(host);
  assert.equal(qr.value, `${ORIGIN}/link#r=${request.requestId}&s=${request.secret}&f=${request.fingerprint}`);
  assert.equal(qr.value.includes("?"), false, "nothing in the query");
  assert.equal(qr.expiresAt, request.expiresAt);
  assert.equal(qr.code, "", "there's nothing to type on this screen");
  assert.equal(typeof qr.refresh, "function", "the code replaces itself when it expires");
  assert.ok(texts(host).includes(SIGN_IN_STEPS));
  assert.equal(SIGN_IN_STEPS, "On your phone, open Kin → People & devices → Add a computer → Scan.");
  const countdown = host.byClass("sign-in-countdown");
  assert.match(countdown.textContent, /^This code changes in 0[12]:\d\d$/);
  assert.equal(countdown.getAttribute("role"), null, "the countdown isn't a live region");
  assert.equal(host.byClass("sign-in-status").getAttribute("role"), "status");
  assert.ok(host.byText("Cancel"));
  assert.equal(document.activeElement, host.byClass("sign-in-heading"), "focus moves to the screen's heading");
  assert.equal(link.request.keys, "pending");
});

test("a returning computer offers its device's keys, and falls back to fresh keys when the service doesn't know it", async () => {
  const bound = { deviceId: hex(32, "d"), householdId: hex(32, "h"), memberId: hex(32, "m"), publicKeys: BOUND };
  const offered = [];
  const answers = [created({ returning: false }), created()];
  const { link } = rig({ bound, routes: { "/api/link/requests": (body) => { offered.push(body.syncPublicKeys); return answers.shift(); } } });
  await link.begin();
  link.stop();
  assert.deepEqual(offered, [BOUND, FRESH]);
  assert.equal(releases().length, 1, "the first request is ended");
  assert.equal(link.request.keys, "pending");

  const known = rig({ bound, routes: { "/api/link/requests": () => created({ returning: true }) } });
  await known.link.begin();
  known.link.stop();
  assert.equal(known.link.request.keys, "existing");
  assert.equal(known.link.request.deviceId, bound.deviceId);
});

test("once the phone approves, the screen asks for the 6-digit code with a numeric keypad", async () => {
  const request = created();
  const { host, link } = rig({ routes: {
    "/api/link/requests": () => request,
    "/status": () => ({ state: "approved", expiresAt: Date.now() + 120_000 }),
  } });
  await link.begin();
  await link.poll();
  link.stop();
  assert.equal(qrOf(host), null, "the QR code is gone once approved");
  const input = host.byClass("sign-in-code").find((node) => node.tagName === "INPUT");
  assert.equal(input.inputMode, "numeric");
  assert.equal(input.autocomplete, "one-time-code");
  assert.equal(document.activeElement, input, "focus moves to the field");
  assert.match(host.byClass("sign-in-status").textContent, /approved this computer/);
  assert.match(host.byClass("sign-in-countdown").textContent, /^The code works for/);
});

async function approvedRig(completion, { keys = "pending" } = {}) {
  const request = created({ returning: keys === "existing" });
  const bound = keys === "existing" ? { deviceId: hex(32, "d"), householdId: hex(32, "h"), memberId: hex(32, "m"), publicKeys: BOUND } : null;
  const r = rig({ bound, routes: {
    "/api/link/requests": () => request,
    "/status": () => ({ state: "approved", expiresAt: Date.now() + 120_000 }),
    "/complete": completion,
  } });
  await r.link.begin();
  await r.link.poll();
  r.link.stop();
  return { ...r, request, bound };
}

test("a wrong code clears the field and says so; the request stays open", async () => {
  const { host, link, request, calls } = await approvedRig(() => {
    throw Object.assign(new Error("That code didn't match. 2 tries left."), { code: "link_code_mismatch" });
  });
  link.field.value = "123 456";
  await link.complete(link.field.value);
  const sent = calls.find((call) => call.path.endsWith("/complete"));
  assert.deepEqual(sent.body, { secret: request.secret, code: "123456" }, "the secret and code go only in the body");
  assert.equal(sent.path.includes(request.secret), false);
  assert.equal(link.field.value, "");
  assert.equal(document.activeElement, link.field);
  assert.match(host.byClass("sign-in-status").textContent, /doesn't match/);
  assert.equal(link.request?.requestId, request.requestId);
});

test("a short code is caught before it is sent", async () => {
  const { link, calls } = await approvedRig(() => ({}));
  await link.complete("12 34");
  assert.equal(calls.some((call) => call.path.endsWith("/complete")), false);
  assert.match(link.status.textContent, /all 6 digits/);
});

test("a new computer keeps its fresh keys under the device the service made, then starts Kin afresh", async () => {
  const done = { householdId: hex(32, "a"), memberId: hex(32, "b"), deviceId: hex(32, "c"), newDevice: true };
  const { link, bindings } = await approvedRig(() => done);
  await link.complete("654321");
  assert.deepEqual(bindings, [{ deviceId: done.deviceId, householdId: done.householdId, memberId: done.memberId }]);
  assert.equal(where.href, "/");
  assert.equal(link.request, null);
  where.href = `${ORIGIN}/`;
});

test("a returning computer is simply signed back in", async () => {
  let r;
  r = await approvedRig(() => ({ householdId: r.bound.householdId, memberId: r.bound.memberId, deviceId: r.bound.deviceId, newDevice: false }), { keys: "existing" });
  await r.link.complete("654321");
  assert.deepEqual(r.bindings, [], "its keys are already its own");
  assert.equal(r.host.loads, 1);
  assert.deepEqual(replaced, ["/"]);
  assert.equal(r.host.intent, null);
});

test("an answer that doesn't fit the keys this computer offered is refused", async () => {
  const { link, host, bindings } = await approvedRig(() => ({ householdId: "h", memberId: "m", deviceId: "d", newDevice: false }));
  await link.complete("654321");
  assert.equal(bindings.length, 0);
  assert.match(host.errors[0]?.message ?? "", /couldn't match|could not match/);
  assert.equal(host.loads, 0);
});

for (const [code, wording] of [
  ["link_code_attempts", /wrong too many times/],
  ["link_unavailable", /ended\. Nothing was signed in/],
]) {
  test(`${code} ends the screen with a way to start again`, async () => {
    const { host, link } = await approvedRig(() => { throw Object.assign(new Error("x"), { code }); });
    await link.complete("111111");
    assert.equal(link.request, null);
    assert.ok(texts(host).some((value) => wording.test(value)));
    assert.ok(host.byText("Show a new code"));
    assert.equal(document.activeElement, host.byClass("sign-in-heading"));
  });
}

test("a request the phone cancelled ends the screen at the next poll", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => created(), "/status": () => ({ state: "ended" }) } });
  await link.begin();
  await link.poll();
  link.stop();
  assert.equal(link.request, null);
  assert.ok(host.byText("Show a new code"));
});

test("Cancel ends the request with the service, sending the secret only in the body", async () => {
  const request = created();
  const { host, link } = rig({ routes: { "/api/link/requests": () => request } });
  await link.begin();
  host.byText("Cancel").click();
  const [cancel] = releases();
  assert.equal(cancel.url, `/api/link/requests/${request.requestId}`);
  assert.deepEqual(JSON.parse(cancel.init.body), { secret: request.secret });
  assert.equal(cancel.init.keepalive, true);
  assert.equal(host.intent, null, "back to the choices");
  assert.equal(link.request, null);
});

test("Kin locking or the screen going away ends the request too", async () => {
  const request = created();
  const { link } = rig({ routes: { "/api/link/requests": () => request } });
  await link.begin();
  link.abandon();
  assert.equal(releases().length, 1);
  assert.equal(link.request, null);
});

test("an unscanned code replaces itself a few times, ending each old request, then stops", async () => {
  const { link } = rig({ routes: { "/api/link/requests": () => created() } });
  await link.begin();
  const seen = new Set([link.request.requestId]);
  for (let index = 0; index < MAX_SIGN_IN_REFRESHES; index += 1) {
    const next = await link.refresh();
    assert.ok(next?.value.startsWith(`${ORIGIN}/link#r=`));
    assert.equal(next.code, "");
    seen.add(link.request.requestId);
  }
  link.stop();
  assert.equal(seen.size, MAX_SIGN_IN_REFRESHES + 1, "each replacement is a new request");
  assert.equal(releases().length, MAX_SIGN_IN_REFRESHES, "and each old one is ended");
  assert.equal(await link.refresh(), null, "then the screen asks before making more");
});

test("a failed request leaves a way to try again", async () => {
  const { host, link } = rig({ routes: { "/api/link/requests": () => { throw new Error("Too many attempts."); } } });
  await link.begin();
  assert.equal(host.errors.length, 1);
  assert.ok(texts(host).includes("Kin couldn't get a sign-in code."));
  assert.ok(host.byText("Try again"));
});

// ---- Sign-in links ----------------------------------------------------------

const sample = { requestId: hex(32, "a"), secret: "A".repeat(20) + "b-_" + "9".repeat(20), fingerprint: hex(64, "e") };

test("a sign-in link reads back exactly, secret case and all", () => {
  const link = signInLink(ORIGIN, sample);
  assert.deepEqual(signInRequest(link, ORIGIN), sample);
});

test("anything but an exact sign-in link for this origin is refused", () => {
  const good = signInLink(ORIGIN, sample);
  for (const bad of [
    signInLink("https://evil.test", sample),
    good.replace("/link#", "/pair#"),
    good.replace("/link#", "/link?x=1#"),
    `${good}&x=1`,
    `${good}&r=${sample.requestId}`,
    good.replace(sample.secret, sample.secret.slice(1)),
    good.replace(sample.requestId, sample.requestId.toUpperCase()),
    good.replace(`&f=${sample.fingerprint}`, ""),
    good.replace("https://kin.test", "https://user@kin.test"),
    "not a url",
  ]) assert.equal(signInRequest(bad, ORIGIN), null, bad);
});

test("typed codes ignore spaces and dashes, and must be six digits", () => {
  assert.equal(cleanLinkCode(" 123-456 "), "123456");
  assert.equal(isLinkCode("123456"), true);
  assert.equal(isLinkCode("12345"), false);
  assert.equal(isLinkCode("12345a"), false);
});
