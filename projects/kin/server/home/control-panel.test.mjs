// The control panel's HTTP rules (ADR 0025 §11, #718–#720): who reaches it
// on loopback and how, what the status holds (counts, never content), and
// that every change needs a fresh confirmation, a printed code on this
// computer or the admin's passkey through the household's address. The
// tunnel is not involved here; control-setup-e2e.test.mjs runs it for real.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import test from "node:test";
import { trustTunnelPeer } from "../client-key.mjs";
import { DurableStore } from "../durable-store.mjs";
import { PairingError } from "../pairing-service.mjs";
import { createKinServer } from "../server.mjs";
import { createControlPanel, loopbackProblem, writeProblem } from "./control-panel.mjs";
import { loadHomeSettings, resolveHomeSettings } from "./settings.mjs";

const TIMEOUT = { timeout: 30_000 };
const NAME = "fern.home.kin.journeytocode.io";
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function stubWebAuthn() {
  return {
    registrationOptions: (flow) => ({ challenge: flow }),
    authenticationOptions: (flow, credentialIds) => ({ challenge: flow, allowCredentials: credentialIds.map((id) => ({ id })) }),
    verifyRegistration: (response) => ({ id: response.id, publicKey: `key-${response.id}`, algorithm: -7, signCount: 0 }),
    verifyAuthentication(response, flow, registered) {
      if (!registered || response?.id !== registered.id) throw new PairingError("passkey_verification_failed", "Invalid passkey.", 401);
      return true;
    },
    discardFlow() {},
  };
}

/**
 * A home-mode Kin server on loopback with its control panel. Unconfigured
 * unless `configured`; `home` stands in for the running tunnel and
 * certificate manager. Codes the panel prints land in `printed`.
 */
async function startPanel(t, { configured = false, env = {}, home = null, trustedProxies, now = Date.now } = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "kin-control-"));
  const settings = resolveHomeSettings(configured ? { format: 1, name: NAME, acmeTermsAgreed: true } : null, env);
  const application = createKinServer({
    store: new DurableStore(":memory:"), mode: "home", webauthn: stubWebAuthn(),
    origin: configured ? `https://${NAME}` : "http://localhost:8000", host: "127.0.0.1",
  });
  if (home) application.home = home;
  const printed = [];
  const restarts = [];
  const panel = await createControlPanel({
    application, dataDirectory, settings, env, trustedProxies, now,
    log: (event) => { if (event.event === "home_control_code") printed.push(event); },
    restart: (reason) => restarts.push(reason),
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  panel.started();
  const port = application.server.address().port;
  t.after(async () => {
    await panel.close();
    application.server.closeAllConnections?.();
    await new Promise((resolve) => application.server.close(resolve));
    application.store.close();
    rmSync(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { application, panel, printed, restarts, port, dataDirectory, origin: `http://localhost:${port}` };
}

/** A request with full control of the headers (fetch sets Origin and Host
 * itself). Resolves with { status, headers, body (parsed JSON or text) }. */
function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const request = httpRequest({ host: "127.0.0.1", port, path, method, agent: false, headers: {
      host: `localhost:${port}`,
      ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      ...headers,
    } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

/** A loopback panel write from its own page. */
const post = (context, route, body = {}, { cookie, headers = {} } = {}) => call(context.port, `/control/api/${route}`, {
  method: "POST", body, headers: { origin: context.origin, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...headers },
});
const plain = (event) => event.code.replace("-", "");

async function signIn(context) {
  const code = context.printed.at(-1);
  const answer = await post(context, "sign-in", { code: code.code });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const cookie = answer.headers["set-cookie"][0].split(";")[0];
  return cookie;
}

test("first run: a setup code is printed, the app's API is closed, and / leads to the panel", TIMEOUT, async (t) => {
  const context = await startPanel(t);
  assert.equal(context.printed.length, 1);
  const [printed] = context.printed;
  assert.equal(printed.purpose, "setup");
  assert.match(printed.code, /^[2-9A-HJKMNP-TW-Z]{5}-[2-9A-HJKMNP-TW-Z]{5}$/);
  assert.equal(printed.url, `http://localhost:${context.port}/control/`);
  // A household made here would have passkeys for localhost.
  const bootstrap = await call(context.port, "/api/status");
  assert.equal(bootstrap.status, 503);
  assert.equal(bootstrap.body.error, "home_setup_required");
  const root = await call(context.port, "/");
  assert.equal(root.status, 303);
  assert.equal(root.headers.location, "/control/");
  const page = await call(context.port, "/control/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<kin-control-panel>/);
  assert.match(page.headers["content-type"], /^text\/html/);
  // Health stays open for the launcher.
  assert.equal((await call(context.port, "/health")).status, 200);
});

test("the loopback panel: a code opens it once, wrong codes are limited, the session is HttpOnly and scoped", TIMEOUT, async (t) => {
  let offset = 0;
  const context = await startPanel(t, { now: () => Date.now() + offset });
  const state = await call(context.port, "/control/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.body.signedIn, false);
  assert.equal(state.body.setup, undefined, "nothing about setup before the code");
  assert.equal(state.body.status, undefined);
  assert.equal((await post(context, "setup/check-name", { name: "fern" })).body.error, "control-sign-in-required");
  const wrong = await post(context, "sign-in", { code: "ABCDE-FGHJK" === context.printed[0].code ? "ABCDE-FGHJM" : "ABCDE-FGHJK" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, "control-code-wrong");
  assert.equal(wrong.body.attemptsLeft, 4);
  assert.equal((await post(context, "sign-in", { code: "nope" })).body.error, "control-code-malformed");
  const answer = await post(context, "sign-in", { code: plain(context.printed[0]).toLowerCase() });
  assert.equal(answer.status, 200);
  const setCookie = answer.headers["set-cookie"][0];
  assert.match(setCookie, /^kin_control=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/control; Max-Age=2592000$/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await post(context, "sign-in", { code: context.printed[0].code })).body.error, "control-code-none", "used once");
  const signedIn = await call(context.port, "/control/api/state", { headers: { cookie } });
  assert.equal(signedIn.body.signedIn, true);
  assert.equal(signedIn.body.setup.step, "name");
  // A new code is limited to one every 30 seconds.
  assert.equal((await post(context, "code")).status, 429, "the setup code was printed just now");
  offset += 30_000;
  assert.equal((await post(context, "code")).status, 200);
  assert.equal(context.printed.at(-1).purpose, "setup");
  const soon = await post(context, "code");
  assert.equal(soon.status, 429);
  assert.equal(soon.body.error, "control-code-too-soon");
  // Five wrong tries and the code is gone.
  for (let attempt = 0; attempt < 4; attempt += 1) await post(context, "sign-in", { code: "22222-22222" });
  assert.equal((await post(context, "sign-in", { code: "22222-22222" })).body.error, "control-code-locked");
  assert.equal((await post(context, "sign-in", { code: context.printed.at(-1).code })).body.error, "control-code-none");
  // Signing out ends the session.
  assert.equal((await post(context, "sign-out", {}, { cookie })).status, 200);
  assert.equal((await call(context.port, "/control/api/state", { headers: { cookie } })).body.signedIn, false);
});

test("the loopback panel refuses tunnel streams, other hosts, proxies and cross-site writes", TIMEOUT, async (t) => {
  const context = await startPanel(t);
  const cookie = await signIn(context);
  const state = (headers) => call(context.port, "/control/api/state", { headers: { cookie, ...headers } });
  // DNS rebinding: a page on evil.test resolving to 127.0.0.1 sends its own Host.
  const rebound = await state({ host: `evil.test:${context.port}` });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.reason, "host");
  assert.equal((await state({ host: "localhost:1" })).body.reason, "host", "another port");
  assert.equal((await state({ "x-forwarded-for": "203.0.113.9" })).body.reason, "proxied");
  assert.equal((await state({ forwarded: "for=203.0.113.9" })).body.reason, "proxied");
  for (const host of [`127.0.0.1:${context.port}`, `[::1]:${context.port}`]) assert.equal((await state({ host })).status, 200, host);
  // Writes: only from the panel's own origin, as JSON.
  const write = (headers, body = JSON.stringify({ name: "fern" })) => call(context.port, "/control/api/setup/check-name", { method: "POST", body, headers: { cookie, "content-type": "application/json", ...headers } });
  assert.equal((await write({})).body.error, "control-origin-rejected", "no Origin");
  assert.equal((await write({ origin: "https://evil.test" })).body.error, "control-origin-rejected");
  assert.equal((await write({ origin: context.origin, "sec-fetch-site": "cross-site" })).body.error, "control-origin-rejected");
  assert.equal((await write({ origin: context.origin, "content-type": "text/plain" })).body.error, "control-origin-rejected", "a form post can't send JSON");
  // GET can't change anything.
  assert.equal((await call(context.port, "/control/api/setup/connect", { headers: { cookie } })).status, 404);

  // The pure rules, including a tunnel stream that claims to be loopback.
  const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
  Object.defineProperties(socket, { remoteAddress: { value: "127.0.0.1" }, localPort: { value: 8000 } });
  const request = (headers, from = socket) => ({ socket: from, headers });
  assert.equal(loopbackProblem(request({ host: "localhost:8000" })), null);
  trustTunnelPeer(socket, "127.0.0.1");
  assert.equal(loopbackProblem(request({ host: "localhost:8000" })), "not-loopback", "a tunnel stream is never loopback");
  const lan = { remoteAddress: "192.168.1.20", localPort: 8000 };
  assert.equal(loopbackProblem(request({ host: "localhost:8000" }, lan)), "not-loopback");
  const local = { remoteAddress: "::ffff:127.0.0.1", localPort: 8000 };
  assert.equal(loopbackProblem(request({ host: "localhost:8000" }, local)), null);
  assert.equal(loopbackProblem(request({ host: "localhost:8000" }, local), { trustedProxies: new Set(["127.0.0.1"]) }), "proxied", "a proxy in front turns the loopback panel off");
  assert.equal(writeProblem({ headers: { host: "localhost:8000", origin: "http://localhost:8000", "content-type": "application/json; charset=utf-8" } }), null);
  assert.equal(writeProblem({ headers: { host: "localhost:8000", origin: "http://127.0.0.1:8000", "content-type": "application/json" } }), "origin");
});

test("with KIN_TRUSTED_PROXIES set, the loopback panel is off", TIMEOUT, async (t) => {
  const context = await startPanel(t, { trustedProxies: new Set(["127.0.0.1"]) });
  const state = await call(context.port, "/control/api/state");
  assert.equal(state.status, 403);
  assert.equal(state.body.reason, "proxied");
});

/** A running home server stand-in with a valid certificate. */
function setUpHome() {
  return {
    tunnel: { status: () => ({ state: "connected", connected: true, since: "2026-10-22T12:00:00.000Z", relay: "relay.kin.journeytocode.io", names: [NAME], routed: true, nameError: null, lastError: null, nextAttemptAt: null, streams: 2 }) },
    certificates: {
      status: () => ({
        name: NAME, state: "valid", certificate: { notBefore: "2026-10-22T00:00:00.000Z", notAfter: "2027-01-20T00:00:00.000Z", serial: "0a1b", issuer: "CN=Test CA", daysLeft: 89 },
        expiringSoon: false, renewAt: "2026-12-21T00:00:00.000Z", nextAttemptAt: null, failures: 0, lastError: null, lastRenewedAt: "2026-10-22T00:00:00.000Z",
        accountUrl: "https://acme.test/account/1", caa: [], transparency: { state: "ok", checkedAt: "2026-10-22T01:00:00.000Z", checked: 1, unexpected: [], error: null },
      }),
      renew: async () => {},
    },
    status() { return { tunnel: this.tunnel.status(), certificate: this.certificates.status() }; },
    stop: async () => {},
  };
}

function populate(service) {
  const admin = service.bootstrap({ credential: credential("panel-admin"), deviceLabel: "Synthetic admin phone" });
  const invitation = service.createPairing(admin.sessionToken, { kind: "adult" });
  const claim = service.claimPairing({ code: invitation.code, credential: credential("panel-adult"), deviceLabel: "Synthetic adult tablet" });
  service.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
  const adult = service.activateClaim(claim.claimToken);
  return { admin, adult };
}

test("status: relay, certificate, storage, version and counts, never household content", TIMEOUT, async (t) => {
  const context = await startPanel(t, { configured: true, home: setUpHome() });
  const service = context.application.service;
  const { admin, adult } = populate(service);
  // A second household, so the counts count.
  service.householdPolicy = { allowNew: true, maxHouseholds: null };
  service.bootstrap({ credential: credential("panel-other"), deviceLabel: "Synthetic other laptop" });
  const status = context.panel.status();
  assert.deepEqual(Object.keys(status).sort(), ["backups", "certificate", "checkedAt", "counts", "freeName", "limits", "name", "origin", "relay", "setupComplete", "storage", "updates", "version"]);
  assert.deepEqual(status.counts, { households: 2, devices: 3 });
  assert.equal(status.setupComplete, true);
  assert.equal(status.relay.connected, true);
  assert.equal(status.certificate.notAfter, "2027-01-20T00:00:00.000Z");
  assert.equal(status.certificate.renewAt, "2026-12-21T00:00:00.000Z");
  assert.equal(status.certificate.transparency.unexpected, 0);
  assert.deepEqual(status.backups, { state: "not-built" }, "the seam #721 fills");
  assert.equal(status.updates.state, "not-built", "the seam #722 fills");
  assert.match(status.version, /^\d+\.\d+\.\d+$/);
  const text = JSON.stringify(status);
  for (const secret of [admin.householdId, admin.memberId, adult.memberId, admin.sessionToken, "Synthetic", "panel-admin", "acme.test/account"])
    assert.ok(!text.includes(secret), `the status holds no ${secret}`);
  // The seams.
  context.panel.provide("backups", () => ({ state: "ok", lastBackupAt: "2026-10-22T03:00:00.000Z" }));
  assert.equal(context.panel.status().backups.lastBackupAt, "2026-10-22T03:00:00.000Z");
  context.panel.provide("updates", () => { throw new Error("broken provider"); });
  assert.deepEqual(context.panel.status().updates, { state: "error" }, "a failing section doesn't break the page");
  // Over loopback, with a session, the same status.
  context.panel.codes.access.issue({ force: true });
  const issued = context.panel.issueCode("access", { force: true });
  assert.ok(issued.expiresAt);
  const cookie = await signIn(context);
  const state = await call(context.port, "/control/api/state", { headers: { cookie } });
  assert.equal(state.body.status.counts.households, 2);
  assert.equal(state.body.setup.step, "done");
});

test("through the household's address: admins only, and a change needs a fresh passkey", TIMEOUT, async (t) => {
  const context = await startPanel(t, { configured: true, home: setUpHome() });
  const { service } = context.application;
  const { admin, adult } = populate(service);
  const app = (who, path, body, headers = {}) => call(context.port, path, {
    method: body === undefined ? "GET" : "POST", body,
    headers: { host: NAME, origin: `https://${NAME}`, ...(who ? { cookie: `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}` } : {}), ...headers },
  });
  assert.equal((await app(null, "/api/control/status")).status, 401, "signed in only");
  const notAdmin = await app(adult, "/api/control/status");
  assert.equal(notAdmin.status, 403);
  assert.equal(notAdmin.body.error, "household_admin_required");
  const status = await app(admin, "/api/control/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.counts.households, 1);
  // The loopback origin can't use the app's API, and the app's origin
  // can't use the loopback panel's.
  assert.equal((await app(admin, "/api/control/status", undefined, { origin: context.origin })).body.error, "origin_rejected");
  assert.equal((await call(context.port, "/control/api/state", { headers: { host: NAME } })).status, 403);
  // A change: options, then finish with this admin's own passkey.
  const change = { kind: "households-limit", maxHouseholds: 3 };
  assert.equal((await app(adult, "/api/control/change/options", { change })).status, 403);
  assert.equal((await app(admin, "/api/control/change/options", { change: { kind: "households-limit", maxHouseholds: 50 } })).body.error, "control-limit-invalid");
  assert.equal((await app(admin, "/api/control/change/options", { change: { kind: "nothing" } })).body.error, "control-change-unknown");
  const options = await app(admin, "/api/control/change/options", { change });
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.deepEqual(options.body.publicKey.allowCredentials, [{ id: "panel-admin" }]);
  const wrong = await app(admin, "/api/control/change/finish", { flow: options.body.flow, credential: { id: "panel-adult" } });
  assert.equal(wrong.status, 401, "another member's passkey");
  assert.equal(service.householdPolicy.maxHouseholds, 1, "nothing changed");
  const replay = await app(admin, "/api/control/change/finish", { flow: options.body.flow, credential: { id: "panel-admin" } });
  assert.equal(replay.status, 410, "a flow is used once");
  const again = await app(admin, "/api/control/change/options", { change });
  const done = await app(admin, "/api/control/change/finish", { flow: again.body.flow, credential: { id: "panel-admin" } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body, { kind: "households-limit", maxHouseholds: 3 });
  assert.equal(service.householdPolicy.maxHouseholds, 3);
  assert.equal((await loadHomeSettings(context.dataDirectory, {})).maxHouseholds, 3, "kept in home/settings.json");
});

test("on this computer a change needs a printed confirmation code; the environment's limit can't be changed", TIMEOUT, async (t) => {
  const context = await startPanel(t, { configured: true, home: setUpHome() });
  context.panel.issueCode("access", { force: true });
  const cookie = await signIn(context);
  const change = { kind: "households-limit", maxHouseholds: 2 };
  assert.equal((await post(context, "change", { change, code: "22222-22222" }, { cookie })).body.error, "control-confirm-none", "no confirmation code asked for yet");
  assert.equal((await post(context, "confirm-code", {}, { cookie })).status, 200);
  const printed = context.printed.at(-1);
  assert.equal(printed.purpose, "confirm");
  assert.equal((await post(context, "change", { change: { kind: "households-limit", maxHouseholds: 0 }, code: printed.code }, { cookie })).body.error, "control-limit-invalid", "a bad value doesn't spend the code");
  const wrongCode = printed.code.startsWith("2") ? `3${printed.code.slice(1)}` : `2${printed.code.slice(1)}`;
  const wrong = await post(context, "change", { change, code: wrongCode }, { cookie });
  assert.equal(wrong.body.error, "control-confirm-wrong");
  assert.equal(context.application.service.householdPolicy.maxHouseholds, 1);
  const done = await post(context, "change", { change, code: printed.code }, { cookie });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(context.application.service.householdPolicy.maxHouseholds, 2);
  assert.equal((await post(context, "change", { change, code: printed.code }, { cookie })).body.error, "control-confirm-none", "the code confirmed one change");
  assert.equal((await post(context, "change", { change, code: printed.code })).body.error, "control-sign-in-required", "and needs a session too");

  const fixed = await startPanel(t, { configured: true, home: setUpHome(), env: { KIN_MAX_HOUSEHOLDS: "4" } });
  assert.throws(() => fixed.panel.checkChange(change), (error) => error.code === "control-limit-from-environment");
  assert.equal(fixed.panel.status().limits.fromEnvironment, true);
});

test("hosted Kin has no control panel", TIMEOUT, async (t) => {
  const application = createKinServer({ store: false, origin: "http://localhost:8000", host: "127.0.0.1" });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => application.server.close(resolve)));
  const port = application.server.address().port;
  assert.equal((await call(port, "/control/")).status, 404);
  assert.equal((await call(port, "/control/kin-control-panel.js")).status, 404);
  assert.equal((await call(port, "/control/api/state")).status, 404);
  assert.equal((await call(port, "/api/control/status")).status, 404);
  assert.equal((await call(port, "/")).status, 200, "the app as before");
});
