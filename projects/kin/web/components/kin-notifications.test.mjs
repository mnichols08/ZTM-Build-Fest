// Per-device notification settings (#85): support detection and the VAPID
// key conversion, without a browser.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
const { applicationServerKey, endpointTag, MUTE_CHOICES, notificationSupport, sameServerKey } = await import("./kin-notifications.js");

test("a browser subscription made for other server keys is recognised", () => {
  const key = Uint8Array.from([4, 1, 2, 3]);
  assert.equal(sameServerKey({ options: { applicationServerKey: key.slice().buffer } }, key), true);
  assert.equal(sameServerKey({ options: { applicationServerKey: Uint8Array.from([4, 1, 2, 9]).buffer } }, key), false);
  assert.equal(sameServerKey({ options: { applicationServerKey: Uint8Array.from([4, 1, 2]).buffer } }, key), false);
  assert.equal(sameServerKey({ options: {} }, key), false);
});

test("each unsupported situation gets its own state", () => {
  const base = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: "default", platform: { ios: false, standalone: false } };
  assert.equal(notificationSupport(base), "available");
  assert.equal(notificationSupport({ ...base, hasPushManager: false }), "unsupported");
  assert.equal(notificationSupport({ ...base, permission: "denied" }), "blocked");
  assert.equal(notificationSupport({ ...base, platform: { ios: true, standalone: false } }), "ios-home-screen", "an iOS browser tab can't receive pushes");
  assert.equal(notificationSupport({ ...base, platform: { ios: true, standalone: true } }), "available", "the Home Screen app can");
});

test("the VAPID key becomes the subscribe() bytes", () => {
  const raw = new Uint8Array(65).map((_, index) => (index * 37) & 255);
  raw[0] = 4;
  const key = Buffer.from(raw).toString("base64url");
  assert.deepEqual(applicationServerKey(key), raw);
});

test("mute choices match the service's choices", async () => {
  const { PUSH_MUTES } = await import("../../server/push-service.mjs");
  assert.deepEqual(MUTE_CHOICES.map(([value]) => value), Object.keys(PUSH_MUTES));
});

test("the endpoint fingerprint matches the service's", async () => {
  const { endpointTag: serverTag } = await import("../../server/push-service.mjs");
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
  assert.equal(await endpointTag(endpoint), serverTag(endpoint));
});
