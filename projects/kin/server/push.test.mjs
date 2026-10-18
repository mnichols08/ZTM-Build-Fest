// Push notifications (#85): the dependency-free Web Push sender (VAPID,
// RFC 8291), subscriptions and their API, and content-free notifications to
// other members after a sync batch commits.
import assert from "node:assert/strict";
import { createECDH, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableStore } from "./durable-store.mjs";
import { PairingService } from "./pairing-service.mjs";
import { PUSH_COALESCE_MS, PUSH_PAYLOAD, PushService } from "./push-service.mjs";
import { createKinServer } from "./server.mjs";
import { EncryptedSyncService } from "./sync-service.mjs";
import {
  allowedPushEndpoint,
  decryptPushPayload,
  encryptPushPayload,
  fromB64url,
  generateVapidKeys,
  pushTopic,
  rawPublicKey,
  sendPush,
  vapidAuthorization,
} from "./web-push.mjs";

const NETWORK_TEST = { timeout: 30_000 };
const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

// RFC 8291 Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("payload encryption matches the RFC 8291 Appendix A vector byte for byte", () => {
  const message = encryptPushPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth },
    { ephemeralPrivateKey: fromB64url(RFC.asPrivate), salt: fromB64url(RFC.salt) });
  assert.equal(message.toString("base64url"), RFC.message);
  assert.equal(decryptPushPayload(fromB64url(RFC.message), { privateKey: fromB64url(RFC.uaPrivate), auth: fromB64url(RFC.auth) }).toString(), RFC.plaintext);
  assert.throws(() => encryptPushPayload("x", { p256dh: Buffer.alloc(65, 4), auth: Buffer.alloc(15) }), /Invalid push subscription keys/);
});

test("VAPID authorization is an ES256 JWT for the endpoint's origin, valid at most 12 hours", () => {
  const keys = generateVapidKeys();
  const now = 1_800_000_000_000;
  const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, { subject: "https://kin.example", now, lifetimeSeconds: 48 * 3600 });
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(key, rawPublicKey(keys.publicJwk).toString("base64url"));
  const [head, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(fromB64url(head)), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(fromB64url(claims)), { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://kin.example" });
  assert.equal(fromB64url(signature).length, 64, "raw r||s, not DER");
  assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: createPublicKey({ key: keys.publicJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, fromB64url(signature)));
});

test("only allowlisted push services on port 443 are contacted", () => {
  for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/QF", "https://wns2-bl2p.notify.windows.com/w/?token=x", "https://fcm.googleapis.com:443/x"])
    assert.ok(allowedPushEndpoint(ok), ok);
  for (const bad of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://evil.com/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.com/x", "https://push.services.mozilla.com/x", "https://127.0.0.1/x", "https://[::1]/x",
    "https://user:pw@fcm.googleapis.com/x", "https://localhost/x", "not a url", `https://fcm.googleapis.com/${"x".repeat(2100)}`])
    assert.equal(allowedPushEndpoint(bad), null, bad);
  assert.match(pushTopic("a".repeat(32)), /^[A-Za-z0-9_-]{32}$/);
});

test("sendPush posts the encrypted payload with VAPID, TTL, urgency and topic", async () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: ua.getPublicKey(), auth: Buffer.alloc(16, 9) };
  let seen;
  const transport = (url, options, onResponse) => {
    const listeners = {};
    return {
      on(name, listener) { listeners[name] = listener; return this; },
      destroy() {},
      end(body) {
        seen = { url: url.href, options, body };
        const response = { statusCode: 201, headers: {}, resume() {}, on(name, listener) { if (name === "end") setImmediate(listener); } };
        onResponse(response);
      },
    };
  };
  const result = await sendPush(subscription, { vapidKeys: generateVapidKeys(), subject: "https://kin.example", payload: PUSH_PAYLOAD, topic: "t", transport });
  assert.equal(result.status, 201);
  assert.equal(seen.options.headers["Content-Encoding"], "aes128gcm");
  assert.equal(seen.options.headers.TTL, "43200");
  assert.equal(seen.options.headers.Urgency, "normal");
  assert.equal(seen.options.headers.Topic, "t");
  assert.match(seen.options.headers.Authorization, /^vapid t=/);
  assert.equal(decryptPushPayload(seen.body, { privateKey: ua.getPrivateKey(), auth: subscription.auth }).toString(), PUSH_PAYLOAD);
  await assert.rejects(sendPush({ ...subscription, endpoint: "https://127.0.0.1/x" }, { vapidKeys: generateVapidKeys(), payload: "x", transport }), /push_endpoint_not_allowed/);
});

// ---- Subscriptions and notifications ---------------------------------------

function household({ store = null } = {}) {
  let now = 1_800_000_000_000;
  const timers = [];
  const pairing = new PairingService({ store, now: () => now });
  const sync = new EncryptedSyncService(pairing, { now: () => now, store });
  const sent = [];
  let respond = () => Promise.resolve({ status: 201 });
  const push = new PushService({
    pairingService: pairing, store, now: () => now, subject: "https://kin.example", log: () => {},
    send: (row, options) => { sent.push({ deviceId: row.deviceId, options }); return respond(row); },
    setTimer: (callback, ms) => { const timer = { at: now + ms, callback }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  sync.pushService = push;
  const adult = pairing.bootstrap({ credential: credential("adult") });
  const join = (id) => {
    now += 60_001;
    const invitation = pairing.createPairing(adult.sessionToken);
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(id), deviceLabel: "Edge on Windows" });
    pairing.approvePairing(adult.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const auth = (who) => pairing.authorize(who.sessionToken);
  const keys = () => { const ua = createECDH("prime256v1"); ua.generateKeys(); return { p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 5).toString("base64url") }; };
  const subscribe = (who, endpoint = `https://fcm.googleapis.com/fcm/send/${who.deviceId}`) => push.subscribe(auth(who), { endpoint, keys: keys() });
  const advance = async (ms) => {
    now += ms;
    for (const timer of timers.filter((entry) => !entry.cleared && !entry.fired && entry.at <= now)) { timer.fired = true; timer.callback(); }
    await new Promise((resolve) => setImmediate(resolve));
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { pairing, sync, push, sent, adult, join, auth, subscribe, advance, settle, setRespond: (value) => { respond = value; }, now: () => now };
}

test("a device manages only its own validated subscription and mute", () => {
  const h = household();
  const partner = h.join("partner");
  assert.deepEqual(h.push.status(h.auth(partner)), { subscribed: false, mutedUntil: null, endpointHost: null });
  for (const [value, pattern] of [
    [{ endpoint: "https://evil.example/x", keys: {} }, /supported browser push service/],
    [{ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: Buffer.alloc(64, 4).toString("base64url"), auth: Buffer.alloc(16).toString("base64url") } }, /invalid keys/],
    [{ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: Buffer.alloc(65, 3).toString("base64url"), auth: Buffer.alloc(16).toString("base64url") } }, /invalid keys/],
    [{ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(8).toString("base64url") } }, /invalid keys/],
  ])
    assert.throws(() => h.push.subscribe(h.auth(partner), value), (error) => error.code === "push_subscription_invalid" && pattern.test(error.message));
  assert.throws(() => h.push.mute(h.auth(partner), null), (error) => error.code === "push_not_subscribed");
  assert.deepEqual(h.subscribe(partner), { subscribed: true, mutedUntil: null, endpointHost: "fcm.googleapis.com" });
  h.subscribe(partner, "https://updates.push.services.mozilla.com/wpush/v2/new");
  assert.equal(h.push.storage.householdPushSubscriptions(h.adult.householdId).length, 1, "one subscription per device");
  const until = h.now() + 3_600_000;
  assert.equal(h.push.mute(h.auth(partner), until).mutedUntil, until);
  h.subscribe(partner);
  assert.equal(h.push.status(h.auth(partner)).mutedUntil, until, "re-subscribing keeps the mute");
  for (const bad of [h.now() - 1, h.now() + 366 * 24 * 3600_000, 1.5, "soon"])
    assert.throws(() => h.push.mute(h.auth(partner), bad), (error) => error.code === "push_subscription_invalid");
  assert.equal(h.push.mute(h.auth(partner), null).mutedUntil, null);
  assert.equal(h.push.unsubscribe(h.auth(partner)).subscribed, false);
  assert.equal(h.push.status(h.auth(h.adult)).subscribed, false, "another device's state is its own");
});

test("an accepted batch notifies other members' unmuted devices once, content-free", async () => {
  const h = household();
  const partner = h.join("partner");
  const third = h.join("third");
  h.subscribe(h.adult);
  h.subscribe(partner);
  h.subscribe(third);
  h.push.mute(h.auth(third), h.now() + 3_600_000);
  h.push.eventsAccepted(h.adult.householdId, h.adult.memberId);
  await h.settle();
  assert.deepEqual(h.sent.map((entry) => entry.deviceId), [partner.deviceId], "never the author's devices; never a muted one");
  assert.equal(h.sent[0].options.payload, '{"v":1,"kind":"new"}');
  assert.equal(h.sent[0].options.topic, pushTopic(h.adult.householdId));
});

test("notifications coalesce to one per device per two minutes, with one trailing send", async () => {
  const h = household();
  const partner = h.join("partner");
  h.subscribe(partner);
  const accepted = () => h.push.eventsAccepted(h.adult.householdId, h.adult.memberId);
  accepted();
  await h.settle();
  accepted(); accepted(); accepted();
  await h.settle();
  assert.equal(h.sent.length, 1, "inside the window nothing more is sent yet");
  await h.advance(PUSH_COALESCE_MS - 1);
  assert.equal(h.sent.length, 1);
  await h.advance(1);
  assert.equal(h.sent.length, 2, "the last change is sent once when the window ends");
  await h.advance(PUSH_COALESCE_MS * 3);
  assert.equal(h.sent.length, 2, "and nothing after that without new events");
});

test("revocation, removal and deletion stop notifications and delete subscriptions", async () => {
  const h = household();
  const partner = h.join("partner");
  const third = h.join("third");
  h.subscribe(partner);
  h.subscribe(third);
  h.pairing.revokeDevice(h.adult.sessionToken, partner.deviceId, h.adult.memberId);
  // Scheduled before the access change reached the push service: still skipped.
  h.push.eventsAccepted(h.adult.householdId, h.adult.memberId);
  await h.settle();
  assert.deepEqual(h.sent.map((entry) => entry.deviceId), [third.deviceId]);
  h.sync.onAccessChange(h.adult.householdId, [partner.deviceId]);
  assert.equal(h.push.storage.getPushSubscription(partner.deviceId), null);
  h.pairing.households.get(h.adult.householdId).lifecycleState = "deletion_pending";
  await h.advance(PUSH_COALESCE_MS);
  h.push.eventsAccepted(h.adult.householdId, h.adult.memberId);
  await h.settle();
  assert.equal(h.sent.length, 1, "a household pending deletion gets nothing");
});

test("gone subscriptions are deleted; failures retry a bounded number of times", async () => {
  const h = household();
  const partner = h.join("partner");
  h.subscribe(partner);
  h.setRespond(() => Promise.resolve({ status: 410 }));
  h.push.eventsAccepted(h.adult.householdId, h.adult.memberId);
  await h.settle();
  assert.equal(h.push.storage.getPushSubscription(partner.deviceId), null);
  h.subscribe(partner);
  h.setRespond(() => Promise.resolve({ status: 503 }));
  await h.advance(PUSH_COALESCE_MS);
  h.push.eventsAccepted(h.adult.householdId, h.adult.memberId);
  await h.settle();
  for (let i = 0; i < 5; i++) await h.advance(60_000);
  assert.equal(h.sent.length, 1 + 3, "the first attempt and two retries, then dropped");
  assert.ok(h.push.storage.getPushSubscription(partner.deviceId), "a failing push service keeps the subscription");
});

test("a hanging push service never delays the sync response", NETWORK_TEST, async () => {
  const h = household();
  const partner = h.join("partner");
  h.subscribe(partner);
  h.setRespond(() => new Promise(() => {}));
  h.sync.enable(h.adult.sessionToken);
  const started = Date.now();
  const result = h.sync.push(h.adult.sessionToken, [{
    protocolVersion: 1, envelopeVersion: 1, eventId: "e".repeat(32), householdId: h.adult.householdId, deviceId: h.adult.deviceId,
    deviceSequence: 1, logicalTime: "1", keyEpoch: 1, nonce: Buffer.alloc(12, 1).toString("base64url"),
    ciphertext: Buffer.alloc(32, 2).toString("base64url"), signature: Buffer.alloc(64, 3).toString("base64url"),
  }]);
  assert.equal(result.accepted, 1);
  assert.ok(Date.now() - started < 1_000);
  await h.settle();
  assert.equal(h.sent.length, 1, "the push was started in the background");
});

test("subscriptions persist, and household deletion purges them", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kin-push-"));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  store = new DurableStore(join(directory, "kin.sqlite"));
  const h = household({ store });
  const partner = h.join("partner");
  h.subscribe(partner);
  const keys = h.push.vapidKeys;
  store.close();
  store = new DurableStore(join(directory, "kin.sqlite"));
  assert.equal(store.getPushSubscription(partner.deviceId).memberId, partner.memberId);
  assert.deepEqual(store.vapidKeys(() => { throw new Error("must not regenerate"); }), keys, "the VAPID key pair is kept");
  assert.equal(store.householdPurgeStatus(h.adult.householdId).counts.pushSubscriptions, 1);
  store.forcePurgeHousehold(h.adult.householdId, h.now());
  assert.equal(store.getPushSubscription(partner.deviceId), null);
  assert.equal(store.validate(), true);
});

test("the push API requires a trusted session and serves the VAPID public key", NETWORK_TEST, async (t) => {
  const app = createKinServer({ store: false, origin: "http://localhost:8000" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${url}/api/push/vapid-public-key`)).status, 401);
  const adult = app.service.bootstrap({ credential: credential("adult") });
  const call = (path, init = {}) => fetch(url + path, { ...init, headers: { cookie: `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`, "content-type": "application/json" } });
  const { publicKey } = await (await call("/api/push/vapid-public-key")).json();
  assert.equal(fromB64url(publicKey).length, 65);
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const put = await call("/api/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } }) });
  assert.equal((await put.json()).subscribed, true);
  assert.equal((await call("/api/push/mute", { method: "PUT", body: JSON.stringify({ until: null }) })).status, 200);
  assert.equal((await (await call("/api/push/subscription", { method: "DELETE", body: "{}" })).json()).subscribed, false);
});
