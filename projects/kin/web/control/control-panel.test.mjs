// The control panel's page (web/control/, #718–#720) without a browser:
// plain words for every code the home server can send, the API client's
// two ways in, and each component's rendering and actions on a small DOM
// stand-in (test-dom.mjs). scripts/control-panel-regression.mjs drives
// the real page in a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { ACME_ERROR_CODES } from "../../server/acme/client.mjs";
import { DOMAIN_PROBLEMS } from "../../server/home/domain-records.mjs";
import { TUNNEL_ERRORS } from "../../server/home/tunnel-client.mjs";
import { installDom, settle } from "./test-dom.mjs";

const document = installDom();
const { explain, explainCertificateState, explainTunnelState, isExplained, KNOWN } = await import("./explain.js");
const { countOf, displayCode, formatBytes } = await import("./format.js");
const { ControlApi, ControlApiError } = await import("./control-api.js");
const { KinControlPanel } = await import("./kin-control-panel.js");

const TIMEOUT = { timeout: 30_000 };

test("every code the home server sends has plain words of its own", TIMEOUT, () => {
  const codes = [
    ...TUNNEL_ERRORS, ...ACME_ERROR_CODES, ...DOMAIN_PROBLEMS,
    "tunnel-caa-name-taken", "tunnel-caa-name-not-allowed", "tunnel-caa-name-limit", "tunnel-caa-name-unknown", "tunnel-caa-suspended", "tunnel-caa-refused",
    "tunnel-not-ready", "tunnel-timeout", "tunnel-lost", "tunnel-stopped",
    "setup-name-empty", "setup-name-invalid", "setup-name-length", "setup-name-taken", "setup-name-not-allowed",
    "setup-name-limit", "setup-name-first", "setup-name-from-environment", "setup-finished", "setup-restarting", "setup-terms-required",
    "setup-records-not-needed", "setup-records-not-ready", "setup-not-connected",
    "control-code-wrong", "control-code-expired", "control-code-locked", "control-code-none", "control-code-malformed", "control-code-too-soon",
    "control-confirm-wrong", "control-confirm-expired", "control-confirm-locked", "control-confirm-none", "control-sign-in-required",
    "control-loopback-only", "control-origin-rejected", "control-limit-invalid", "control-limit-from-environment", "control-change-unknown",
    "control-bad-request", "control-failed", "control-not-found", "household_admin_required", "home_setup_required", "network",
  ];
  const missing = codes.filter((code) => !isExplained(code));
  assert.deepEqual(missing, [], "codes without their own sentence");
  for (const code of codes) assert.doesNotMatch(explain(code), /^[a-z-]+$/, `${code} reads as words`);
  for (const state of ["connected", "connecting", "waiting", "stopped"]) assert.ok(KNOWN.tunnelStates.includes(state), state);
  for (const state of ["none", "valid", "renewing", "valid-retrying", "failed", "expired"]) assert.ok(KNOWN.certificateStates.includes(state), state);
  assert.match(explain("acme-something-new"), /Let's Encrypt/, "an unknown code still gets its family's sentence");
  assert.match(explain("replaced"), /Only one copy of a home server can run at a time/);
  assert.match(explainTunnelState("connected"), /Phones can reach/);
  assert.match(explainCertificateState("valid-retrying"), /tries again/);
});

test("formatting: sizes, counts and codes", TIMEOUT, () => {
  assert.equal(formatBytes(512, "en"), "512 bytes");
  assert.equal(formatBytes(1_536_000, "en"), "1.5 MB");
  assert.equal(formatBytes(null, "en"), "Not known");
  assert.equal(countOf(1, "household", "households"), "1 household");
  assert.equal(countOf(3, "device", "devices"), "3 devices");
  assert.equal(displayCode("abcde23456"), "ABCDE-23456");
});

/** A fetch stand-in answering from `routes` ("METHOD path" → [status, body]). */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const answer = routes[`${init.method} ${path}`];
    if (!answer) return { ok: false, status: 404, json: async () => ({ error: "control-not-found" }) };
    const [status, body] = typeof answer === "function" ? answer(init) : answer;
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

test("the API client: the loopback panel's API here, the app's API with a fresh confirmation through the household's address", TIMEOUT, async () => {
  const local = fakeFetch({
    "GET /control/api/state": [200, { signedIn: false }],
    "POST /control/api/sign-in": [401, { error: "control-code-wrong", message: "no", attemptsLeft: 3 }],
    "POST /control/api/change": [200, { kind: "households-limit", maxHouseholds: 2 }],
  });
  const loopback = new ControlApi({ loopback: true, fetchImpl: local.fetchImpl });
  assert.deepEqual(await loopback.state(), { remote: false, signedIn: false });
  await assert.rejects(loopback.post("sign-in", { code: "x" }), (error) => error instanceof ControlApiError && error.code === "control-code-wrong" && error.attemptsLeft === 3);
  assert.equal(local.calls[1].headers["Content-Type"], "application/json");
  await loopback.change({ kind: "households-limit", maxHouseholds: 2 }, { code: "ABCDE-23456" });
  assert.deepEqual(local.calls.at(-1).body, { change: { kind: "households-limit", maxHouseholds: 2 }, code: "ABCDE-23456" });

  const confirmations = [];
  const remoteFetch = fakeFetch({
    "GET /api/control/status": [200, { version: "1.6.0" }],
    "POST /api/control/change/options": [200, { flow: "flow-1", publicKey: { challenge: "c" } }],
    "POST /api/control/change/finish": [200, { kind: "households-limit", maxHouseholds: 2 }],
  });
  const remote = new ControlApi({ loopback: false, fetchImpl: remoteFetch.fetchImpl, confirm: async (started) => { confirmations.push(started.flow); return { credential: { id: "passkey" } }; } });
  assert.deepEqual(await remote.state(), { remote: true, signedIn: true, admin: true, status: { version: "1.6.0" } });
  await assert.rejects(remote.post("sign-in", {}), (error) => error.code === "control-loopback-only");
  await remote.change({ kind: "households-limit", maxHouseholds: 2 });
  assert.deepEqual(confirmations, ["flow-1"]);
  assert.deepEqual(remoteFetch.calls.at(-1).body, { flow: "flow-1", credential: { id: "passkey" } });
  const signedOut = new ControlApi({ loopback: false, fetchImpl: fakeFetch({ "GET /api/control/status": [401, { error: "authentication_required" }] }).fetchImpl });
  assert.deepEqual(await signedOut.state(), { remote: true, signedIn: false, admin: false });
  const notAdmin = new ControlApi({ loopback: false, fetchImpl: fakeFetch({ "GET /api/control/status": [403, { error: "household_admin_required" }] }).fetchImpl });
  assert.deepEqual(await notAdmin.state(), { remote: true, signedIn: true, admin: false });
  const down = new ControlApi({ loopback: true, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(down.state(), (error) => error.code === "network");
});

const STATUS = Object.freeze({
  version: "1.6.0", checkedAt: "2026-10-22T12:00:00.000Z", name: "fern.home.kin.journeytocode.io", freeName: true,
  origin: "https://fern.home.kin.journeytocode.io", setupComplete: true,
  relay: { state: "connected", connected: true, since: "2026-10-22T11:00:00.000Z", relay: "relay.kin.journeytocode.io", names: ["fern.home.kin.journeytocode.io"], routed: true, nameError: null, lastError: null, nextAttemptAt: null },
  certificate: { state: "valid", notAfter: "2027-01-20T00:00:00.000Z", daysLeft: 89, issuer: "CN=Test CA", renewAt: "2026-12-21T00:00:00.000Z", expiringSoon: false, nextAttemptAt: null, lastError: null, lastRenewedAt: null, transparency: { state: "ok", checkedAt: null, unexpected: 0, error: null } },
  storage: { databaseBytes: 2_400_000, freeBytes: 52_000_000_000 },
  counts: { households: 1, devices: 3 },
  limits: { maxHouseholds: 1, allowNew: true, fromEnvironment: false, highest: 10 },
  backups: { state: "not-built" }, updates: { state: "not-built", current: "1.6.0" },
});

test("the status page: every section, plain-words states, and the seams for backups and updates", TIMEOUT, () => {
  const element = document.createElement("kin-control-status");
  element.status = STATUS;
  const sections = element.querySelectorAll("section").map((section) => section.dataset.section);
  assert.deepEqual(sections, ["relay", "name", "certificate", "backups", "storage", "counts", "updates"]);
  assert.equal(element.querySelector(".control-headline").textContent, "Everything is working.");
  const text = element.textContent;
  for (const expected of ["Connected to the relay", "relay.kin.journeytocode.io", "89 days left", "2.4 MB", "52 GB", "1 household", "3 devices", "1.6.0", "Counts only"])
    assert.ok(text.includes(expected), expected);
  assert.match(element.querySelector('[data-section="backups"]').textContent, /aren't part of this version yet/);
  assert.match(element.querySelector('[data-section="updates"]').textContent, /doesn't check for updates/);
  for (const section of element.querySelectorAll("section")) assert.ok(section.getAttribute("aria-labelledby"), "each section is named by its heading");

  element.status = {
    ...STATUS,
    relay: { ...STATUS.relay, state: "waiting", connected: false, routed: false, lastError: { code: "replaced", at: "2026-10-22T11:30:00.000Z" }, nextAttemptAt: "2026-10-22T11:35:00.000Z" },
    certificate: { ...STATUS.certificate, state: "valid-retrying", lastError: { code: "acme-rate-limited", at: "2026-10-22T11:00:00.000Z" } },
    backups: { state: "ok", lastBackupAt: "2026-10-22T03:00:00.000Z" },
  };
  assert.equal(element.querySelector(".control-headline").dataset.tone, "attention");
  assert.match(element.querySelector('[data-code="replaced"]').textContent, /Only one copy/);
  assert.match(element.querySelector('[data-code="acme-rate-limited"]').textContent, /limit/);
  assert.match(element.querySelector('[data-section="backups"]').textContent, /Last backup/, "a provided section renders its value");
  element.status = { ...STATUS, certificate: { ...STATUS.certificate, transparency: { state: "alert", unexpected: 1 } } };
  assert.equal(element.querySelector(".control-headline").dataset.tone, "alert");
  assert.equal(element.querySelector('[data-section="certificate"]').dataset.tone, "alert");
});

function fakeApi(answers = {}) {
  const calls = [];
  return {
    calls,
    loopback: true,
    async post(route, body) {
      calls.push([route, body]);
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(body) : answer ?? {};
    },
    async change(change, options) { calls.push(["change", change, options]); return answers.change ?? {}; },
  };
}

const VIEW = { step: "name", zone: "home.kin.journeytocode.io", relay: "relay.kin.journeytocode.io", name: null, freeName: null, configuredName: null, termsAgreed: false, nameFromEnvironment: false, expectedRecords: null, records: null, origin: null, progress: null };

test("setup: the name step checks as you type and chooses; errors are spoken in plain words", TIMEOUT, async () => {
  const api = fakeApi({
    "setup/check-name": (body) => ({ name: body.name, freeName: true, answer: body.name.startsWith("taken") ? "taken" : "available" }),
    "setup/name": new ControlApiError("setup-name-taken", "taken", 409),
  });
  const setup = document.createElement("kin-control-setup");
  setup.api = api;
  document.body.append(setup);
  setup.view = VIEW;
  assert.equal(setup.querySelector("h2").textContent, "Choose this home server's name");
  assert.equal(setup.querySelector('[aria-current="step"]').textContent, "Name");
  assert.equal(setup.querySelectorAll(".control-steps li").length, 5, "no DNS step for a free name");
  const input = setup.querySelector("#control-name");
  assert.ok(setup.querySelector('label[for="control-name"]'), "the field has a label");
  assert.equal(setup.querySelector("#control-name-suffix").textContent, ".home.kin.journeytocode.io");
  assert.match(input.getAttribute("aria-describedby"), /control-name-suffix/);
  input.value = "Taken";
  input.dispatchEvent({ type: "input" });
  await settle(700);
  assert.deepEqual(api.calls[0], ["setup/check-name", { name: "taken.home.kin.journeytocode.io" }]);
  assert.match(setup.querySelector(".control-availability").textContent, /Taken/);
  assert.equal(setup.querySelector(".control-availability").getAttribute("role"), "status");
  setup.querySelector("form").submit();
  await settle();
  assert.equal(setup.querySelector(".control-message").getAttribute("role"), "alert");
  assert.match(setup.querySelector(".control-message").textContent, /belongs to another home server/);
  // Choosing "our own domain" adds the DNS step and asks for the full name.
  const own = setup.querySelectorAll("input").find((input) => input.type === "radio" && input.value === "own");
  own.checked = true;
  own.dispatchEvent({ type: "change" });
  assert.equal(setup.querySelector('label[for="control-name"]').textContent, "Your domain");
  setup.remove();
});

test("setup: a chosen name moves on; the view the server answers is passed up", TIMEOUT, async () => {
  const next = { ...VIEW, step: "terms", name: "fern.home.kin.journeytocode.io", freeName: true };
  const api = fakeApi({ "setup/name": next, "setup/terms-url": { url: "https://ca.test/terms.pdf" } });
  const setup = document.createElement("kin-control-setup");
  setup.api = api;
  const host = document.createElement("div");
  document.body.append(host);
  host.append(setup);
  const views = [];
  host.addEventListener("view", (event) => { views.push(event.detail); setup.view = event.detail; });
  setup.view = VIEW;
  setup.querySelector("#control-name").value = "fern";
  setup.querySelector("form").submit();
  await settle();
  assert.deepEqual(views, [next]);
  assert.equal(setup.querySelector("h2").textContent, "Agree to Let's Encrypt's terms");
  assert.equal(document.activeElement, setup.querySelector("#control-step-title"), "focus moves to the new step");
  await settle();
  const link = setup.querySelector("a");
  assert.equal(link.href, "https://ca.test/terms.pdf", "the CA's own terms");
  assert.equal(link.rel, "noopener noreferrer");
  // Not ticked: refused here, nothing sent.
  setup.querySelector("form").submit();
  assert.match(setup.querySelector(".control-message").textContent, /agreement/);
  assert.ok(!api.calls.some(([route]) => route === "setup/terms"));
  setup.querySelector("#control-terms").checked = true;
  setup.querySelector("form").submit();
  await settle();
  assert.deepEqual(api.calls.at(-1), ["setup/terms", { agreed: true }]);
  host.remove();
});

test("setup: own-domain records, progress with a retry, and done", TIMEOUT, async () => {
  const api = fakeApi({ "setup/records": { ...VIEW, step: "records" } });
  const setup = document.createElement("kin-control-setup");
  setup.api = api;
  document.body.append(setup);
  const records = [
    { type: "A", name: "kin.smith.family", value: "192.0.2.10" },
    { type: "TXT", name: "_kin-relay.kin.smith.family", value: "abc" },
    { type: "CAA", name: "kin.smith.family", value: '0 issue "letsencrypt.org; accounturi=https://acme.test/a/1; validationmethods=tls-alpn-01"' },
  ];
  setup.view = { ...VIEW, step: "records", name: "kin.smith.family", freeName: false, termsAgreed: true, expectedRecords: records,
    records: { ok: false, records, checks: [{ id: "address", ok: true, problem: null }, { id: "caa", ok: false, problem: "dns-caa-missing" }], checkedAt: "2026-10-22T12:00:00.000Z" } };
  assert.equal(setup.querySelectorAll(".control-steps li").length, 6, "the DNS step is shown for an own domain");
  assert.equal(setup.querySelectorAll("tbody tr").length, 3);
  assert.equal(setup.querySelectorAll('th[scope="col"]').length, 3);
  assert.match(setup.querySelector('[data-ok="false"]').textContent, /CAA record that names this server's Let's Encrypt account/);
  setup.querySelectorAll("button").find((button) => button.textContent === "Check the records").click();
  await settle();
  assert.deepEqual(api.calls.at(-1), ["setup/records", undefined]);

  setup.view = { ...VIEW, step: "certificate", name: "fern.home.kin.journeytocode.io", freeName: true,
    progress: { tunnel: { state: "connected", routed: true, error: null, nameError: null }, certificate: { state: "failed", error: "acme-connection", nextAttemptAt: "2026-10-22T13:00:00.000Z", notAfter: null } } };
  assert.equal(setup.querySelector("h2").textContent, "Getting the certificate");
  assert.equal(setup.querySelector('[data-state="problem"]').textContent.startsWith("Certificate"), true);
  assert.match(setup.querySelector('[data-code="acme-connection"]').textContent, /couldn't connect/);
  setup.querySelectorAll("button").find((button) => button.textContent === "Try again now").click();
  await settle();
  assert.equal(api.calls.at(-1)[0], "setup/retry");

  setup.view = { ...VIEW, step: "done", name: "fern.home.kin.journeytocode.io", freeName: true, origin: "https://fern.home.kin.journeytocode.io",
    progress: { tunnel: { state: "connected", routed: true }, certificate: { state: "valid", notAfter: "2027-01-20T00:00:00.000Z" } } };
  assert.equal(setup.querySelector("h2").textContent, "Kin is ready");
  const open = setup.querySelector("a.control-button");
  assert.equal(open.href, "https://fern.home.kin.journeytocode.io");
  assert.match(setup.textContent, /Create the household there, not here/);
  setup.remove();
});

test("sign-in: a wrong code is announced with the tries left; a new code can be printed", TIMEOUT, async () => {
  const api = fakeApi({
    "sign-in": new ControlApiError("control-code-wrong", "no", 401, { attemptsLeft: 2 }),
    code: { expiresAt: "2026-10-22T13:00:00.000Z" },
  });
  const signIn = document.createElement("kin-control-sign-in");
  signIn.api = api;
  document.body.append(signIn);
  signIn.render();
  assert.equal(signIn.querySelector("h2").textContent, "Enter the setup code");
  const input = signIn.querySelector("#control-code");
  assert.equal(input.autocomplete, "one-time-code");
  assert.ok(signIn.querySelector('label[for="control-code"]'));
  signIn.querySelector("form").submit();
  assert.match(signIn.querySelector(".control-message").textContent, /Type the code first/);
  input.value = "ABCDE-23456";
  signIn.querySelector("form").submit();
  await settle();
  assert.equal(signIn.querySelector(".control-message").getAttribute("role"), "alert");
  assert.match(signIn.querySelector(".control-message").textContent, /isn't right.*2 more tries/);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  signIn.querySelectorAll("button").find((button) => button.textContent === "Print a new code").click();
  await settle();
  assert.match(signIn.querySelector(".control-message").textContent, /printed a new code/);
  signIn.remove();
});

test("settings: on this computer a change asks for a printed confirmation code", TIMEOUT, async () => {
  const api = fakeApi({ "confirm-code": { expiresAt: "2026-10-22T13:00:00.000Z" }, change: { kind: "households-limit", maxHouseholds: 3 } });
  const settings = document.createElement("kin-control-settings");
  settings.api = api;
  document.body.append(settings);
  let changed = 0;
  settings.addEventListener("changed", () => { changed += 1; });
  settings.status = STATUS;
  const select = settings.querySelector("#control-setting-households-limit");
  assert.equal(select.children.length, 10);
  assert.ok(settings.querySelector('label[for="control-setting-households-limit"]'));
  select.value = "3";
  settings.querySelector('[data-setting="households-limit"] form').submit();
  await settle();
  assert.deepEqual(api.calls[0], ["confirm-code", undefined]);
  const confirm = settings.querySelector(".control-confirm");
  assert.ok(confirm, "a confirmation form appears");
  assert.equal(document.activeElement, confirm.querySelector("input"));
  confirm.querySelector("input").value = "ABCDE-23456";
  confirm.submit();
  await settle();
  assert.deepEqual(api.calls.at(-1), ["change", { kind: "households-limit", maxHouseholds: 3 }, { code: "ABCDE-23456" }]);
  assert.equal(changed, 1);
  assert.equal(settings.querySelector(".control-confirm"), null);
  // A limit set in the environment is shown, not offered.
  settings.status = { ...STATUS, limits: { ...STATUS.limits, fromEnvironment: true } };
  assert.equal(settings.querySelector("#control-setting-households-limit"), null);
  assert.match(settings.textContent, /KIN_MAX_HOUSEHOLDS/);
  settings.remove();
});

test("the panel picks the screen from the state", TIMEOUT, () => {
  const panel = new KinControlPanel();
  assert.equal(panel.screen(null), "loading");
  assert.equal(panel.screen({ remote: false, signedIn: false }), "sign-in");
  assert.equal(panel.screen({ remote: false, signedIn: true, setup: { step: "terms" }, status: { setupComplete: false } }), "setup");
  assert.equal(panel.screen({ remote: false, signedIn: true, setup: { step: "done" }, status: { setupComplete: true } }), "status");
  assert.equal(panel.screen({ remote: true, signedIn: false }), "remote-sign-in");
  assert.equal(panel.screen({ remote: true, signedIn: true, admin: false }), "remote-not-admin");
  assert.equal(panel.screen({ remote: true, signedIn: true, admin: true, status: STATUS }), "status");
});

test("the panel shows a notice while Kin restarts and asks again", TIMEOUT, async () => {
  let fail = true;
  const panel = document.createElement("kin-control-panel");
  panel.api = {
    loopback: true,
    state: async () => { if (fail) throw new ControlApiError("network", "down", 0); return { remote: false, signedIn: false, configured: true }; },
    post: async () => ({}),
  };
  try {
    document.body.append(panel);
    await settle();
    assert.match(panel.querySelector(".control-notice").textContent, /Kin didn't answer/, "even the first request may fail");
    await panel.refresh();
    assert.match(panel.querySelector(".control-notice").textContent, /restarting/);
    fail = false;
    await panel.refresh();
    assert.equal(panel.querySelector(".control-notice").hidden, true);
    assert.equal(panel.querySelector("h2").textContent, "Open the control panel");
  } finally {
    panel.disconnectedCallback();
    panel.remove();
  }
});
