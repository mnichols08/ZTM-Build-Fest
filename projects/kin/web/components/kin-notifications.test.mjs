// Per-device notification settings (#85): support detection and the VAPID
// key conversion, without a browser.
import assert from "node:assert/strict";
import test from "node:test";

globalThis.HTMLElement = class {};
globalThis.customElements = { define() {} };
const { applicationServerKey, MUTE_CHOICES, notificationSupport } = await import("./kin-notifications.js");

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

test("mute choices are 1 hour, 8 hours and until turned back on (within the service's one-year cap)", () => {
  assert.deepEqual(MUTE_CHOICES.map(([value]) => value), ["hour", "night", "indefinite"]);
  assert.ok(MUTE_CHOICES[2][2] < 365 * 24 * 60 * 60 * 1000);
});
