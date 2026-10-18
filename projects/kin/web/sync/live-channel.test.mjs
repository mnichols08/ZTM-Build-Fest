// The client live channel (#108): records, reconnecting with backoff,
// losing access, one tab per device, and the real service end to end.
import assert from "node:assert/strict";
import test from "node:test";
import { DurableStore } from "../../server/durable-store.mjs";
import { PairingService } from "../../server/pairing-service.mjs";
import { createKinServer } from "../../server/server.mjs";
import { LIVE_CLOSE, LIVE_TYPE, LiveChannel, liveUrl, MAX_RECONNECT_MS, parseLiveRecord } from "./live-channel.js";
import { LIVE_POLL_MS, POLL_MS, SyncCoordinator } from "./sync-coordinator.js";

const record = (type, payload = new Uint8Array()) => {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes[0] = type;
  bytes.set(payload, 8);
  return bytes.buffer;
};

/** A scripted stand-in for the browser's WebSocket. */
function fakeSockets() {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.closed = null; sockets.push(this); }
    close(code, reason) { this.closed = { code, reason }; }
    receive(data) { this.onmessage?.({ data }); }
    end(code) { this.onclose?.({ code }); }
  }
  return { sockets, FakeSocket };
}

/** Timers run by hand: `fire()` runs the next one and says how long it was. */
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (callback, ms) => { const timer = { callback, ms }; pending.push(timer); return timer; },
    clearTimer: (timer) => { const index = pending.indexOf(timer); if (index >= 0) pending.splice(index, 1); },
    fire() { const timer = pending.shift(); timer.callback(); return timer.ms; },
  };
}

function channel(overrides = {}) {
  const { sockets, FakeSocket } = fakeSockets();
  const timers = fakeTimers();
  const calls = [];
  const events = new EventTarget();
  const live = new LiveChannel({
    url: "wss://kin.example/api/live",
    WebSocket: FakeSocket,
    locks: null,
    events,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random: () => 1,
    onHint: () => calls.push("hint"),
    onUp: () => calls.push("up"),
    onDown: () => calls.push("down"),
    onEnd: ({ code }) => calls.push(`end ${code}`),
    ...overrides,
  });
  return { live, sockets, timers, calls, events };
}

test("records are read strictly, and the URL follows the page's origin", () => {
  assert.deepEqual(parseLiveRecord(record(LIVE_TYPE.HELLO)), { type: 1, flags: 0, payload: new Uint8Array() });
  assert.equal(parseLiveRecord(record(9, Uint8Array.of(1, 2))).payload.length, 2);
  const reserved = new Uint8Array(record(2)); reserved[2] = 1;
  const long = new Uint8Array(record(2)); long[4] = 1;
  for (const bad of ["text", new Uint8Array(record(2)), new ArrayBuffer(7), reserved.buffer, long.buffer, new ArrayBuffer(256 * 1024 + 1)])
    assert.equal(parseLiveRecord(bad), null);
  assert.equal(liveUrl({ href: "https://kin.example/app?x=1" }), "wss://kin.example/api/live");
  assert.equal(liveUrl({ href: "http://127.0.0.1:8080/" }), "ws://127.0.0.1:8080/api/live");
});

test("HELLO brings the channel up and hints sync; a drop reconnects with doubling, jittered waits", () => {
  const { live, sockets, timers, calls } = channel();
  live.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].binaryType, "arraybuffer");
  sockets[0].receive(record(LIVE_TYPE.SYNC_HINT));
  assert.deepEqual(calls, [], "no hint before HELLO");
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  sockets[0].receive(record(LIVE_TYPE.SYNC_HINT));
  sockets[0].receive(record(LIVE_TYPE.SYNC_HINT));
  sockets[0].receive(record(77)); // a newer record type: ignored
  assert.deepEqual(calls, ["up", "hint", "hint"]);
  sockets[0].end(1006);
  assert.deepEqual(calls.slice(3), ["down"]);
  // Each failed attempt doubles the wait, up to 30 s.
  const waits = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    waits.push(timers.fire());
    sockets.at(-1).end(1006);
  }
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  // A HELLO resets the backoff.
  timers.fire();
  sockets.at(-1).receive(record(LIVE_TYPE.HELLO));
  sockets.at(-1).end(1011);
  assert.equal(timers.fire(), 1_000);
  // Jitter: between half and all of the ceiling.
  const low = channel({ random: () => 0 });
  low.live.start();
  low.sockets[0].end(1006);
  low.timers.fire();
  low.sockets[1].end(1006);
  assert.equal(low.timers.pending[0].ms, 1_000, "never below a second");
  low.timers.fire();
  low.sockets[2].end(1006);
  assert.equal(low.timers.pending[0].ms, 2_000);
});

test("losing access ends the channel; being replaced waits the longest", () => {
  for (const code of [LIVE_CLOSE.SESSION_ENDED, LIVE_CLOSE.ACCESS_LOST]) {
    const { live, sockets, timers, calls } = channel();
    live.start();
    sockets[0].receive(record(LIVE_TYPE.HELLO));
    sockets[0].end(code);
    assert.deepEqual(calls, ["up", `end ${code}`]);
    assert.equal(timers.pending.length, 0, "no reconnecting");
    live.online();
    assert.equal(sockets.length, 1);
  }
  const { live, sockets, timers } = channel();
  live.start();
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  sockets[0].end(LIVE_CLOSE.REPLACED);
  assert.equal(timers.pending[0].ms, MAX_RECONNECT_MS);
  // A slow consumer reconnects as usual and catches up over HTTP.
  timers.fire();
  sockets[1].end(LIVE_CLOSE.SLOW_CONSUMER);
  assert.ok(timers.pending.length === 1);
});

test("a malformed message gives up that socket; coming back online reconnects at once", () => {
  const { live, sockets, timers, events } = channel();
  live.start();
  sockets[0].receive(new ArrayBuffer(3));
  assert.deepEqual(sockets[0].closed, { code: 1002, reason: "" });
  sockets[0].end(1002);
  assert.equal(timers.pending.length, 1);
  events.dispatchEvent(new Event("online"));
  assert.equal(timers.pending.length, 0, "the wait is cancelled");
  assert.equal(sockets.length, 2);
  events.dispatchEvent(new Event("online"));
  assert.equal(sockets.length, 2, "not while a socket is open");
});

test("stopping closes the socket, releases the lock and never reconnects", () => {
  const { live, sockets, timers, calls, events } = channel();
  live.start();
  sockets[0].receive(record(LIVE_TYPE.HELLO));
  live.stop();
  assert.deepEqual(sockets[0].closed, { code: 1000, reason: "" });
  sockets[0].end(1000);
  events.dispatchEvent(new Event("online"));
  assert.deepEqual(calls, ["up"]);
  assert.equal(timers.pending.length, 0);
  assert.equal(sockets.length, 1);
  // Without a WebSocket (or a URL) there is no channel at all.
  const none = channel({ WebSocket: undefined });
  none.live.start();
  assert.equal(none.sockets.length, 0);
});

test("one tab per device holds the socket; the next takes over when it lets go", async () => {
  // A minimal Web Locks manager: one holder per name, others queue.
  const held = new Map();
  const locks = {
    request(name, callback) {
      const run = () => {
        held.set(name, true);
        return Promise.resolve(callback()).finally(() => {
          held.delete(name);
          queue.get(name)?.shift()?.();
        });
      };
      if (!held.has(name)) return run();
      return new Promise((resolve) => {
        if (!queue.has(name)) queue.set(name, []);
        queue.get(name).push(() => resolve(run()));
      });
    },
  };
  const queue = new Map();
  const { sockets, FakeSocket } = fakeSockets();
  const make = () => new LiveChannel({ url: "wss://kin.example/api/live", lockName: "kin-live:device", WebSocket: FakeSocket, locks, events: new EventTarget() });
  const first = make(), second = make();
  first.start();
  second.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 1, "only the lock holder connects");
  first.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2, "the waiting tab takes over");
  second.stop();
});

test("the coordinator polls less while the channel is up and syncs on hints", async () => {
  let made;
  const coordinator = new SyncCoordinator({
    store: {}, engine: {}, identity: { deviceId: "d1" },
    liveChannel: (options) => (made = { options, started: false, stopped: false, start() { this.started = true; }, stop() { this.stopped = true; } }),
  });
  let syncs = 0;
  coordinator.syncNow = () => { syncs += 1; return Promise.resolve(); };
  coordinator.timer = setInterval(() => {}, POLL_MS);
  try {
    coordinator.startLive();
    assert.equal(made.started, true);
    assert.equal(made.options.lockName, "kin-live:d1");
    made.options.onUp();
    assert.equal(coordinator.pollMs, LIVE_POLL_MS);
    made.options.onHint();
    assert.equal(syncs, 2, "a sync on coming up (catch up, drain the outbox) and one per hint");
    made.options.onDown();
    assert.equal(coordinator.pollMs, POLL_MS);
    made.options.onEnd({ code: LIVE_CLOSE.SESSION_ENDED });
    assert.equal(syncs, 3, "lost access: the HTTP sync reports the signed-out state");
    coordinator.stop();
    assert.equal(made.stopped, true);
  } finally {
    clearInterval(coordinator.timer);
  }
});

test("hints that arrive during a sync join it instead of starting another", async () => {
  let made;
  const coordinator = new SyncCoordinator({
    store: {}, engine: {}, identity: { deviceId: "d1" },
    liveChannel: (options) => (made = { options, start() {}, stop() {} }),
  });
  let runs = 0, finish;
  coordinator.runOnce = () => { runs += 1; return new Promise((resolve) => { finish = resolve; }); };
  coordinator.startLive();
  for (let index = 0; index < 5; index += 1) made.options.onHint();
  assert.equal(runs, 1);
  finish({ hasMore: false });
  await coordinator.running;
  made.options.onHint();
  assert.equal(runs, 2, "a hint after it finished syncs again");
  finish({ hasMore: false });
  coordinator.stop();
});

test("end to end: the real service's HELLO, hints and access loss reach the channel", { timeout: 30_000 }, async (t) => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: { id: "phone", publicKey: "key-phone", algorithm: -7 }, deviceLabel: "Phone" });
  const pairing = service.createDevicePairing(adult.sessionToken);
  const claim = service.claimPairing({ code: pairing.code, credential: { id: "laptop", publicKey: "key-laptop", algorithm: -7 }, deviceLabel: "Laptop" });
  service.approvePairing(adult.sessionToken, pairing.pairingId, claim.version);
  const laptop = service.activateClaim(claim.claimToken);
  const app = createKinServer({ store: new DurableStore(":memory:"), service, origin: "http://localhost" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)).finally(() => app.store.close()));
  const port = app.server.address().port;
  // Node's WebSocket, carrying what a browser would: the page's origin and
  // the session cookie.
  const socketFor = (who) => class extends WebSocket {
    constructor(url) { super(url, { headers: { origin: "http://localhost", cookie: `kin_session=${who.sessionToken}` } }); }
  };
  const seen = [];
  const live = new LiveChannel({
    url: `ws://127.0.0.1:${port}/api/live`, WebSocket: socketFor(adult), locks: null, events: new EventTarget(),
    onUp: () => seen.push("up"), onHint: () => seen.push("hint"), onEnd: ({ code }) => seen.push(`end ${code}`),
  });
  const until = async (condition) => { for (let index = 0; index < 200 && !condition(); index += 1) await new Promise((resolve) => setTimeout(resolve, 10)); };
  live.start();
  await until(() => seen.includes("up"));
  // The laptop's events were accepted: the phone hears about it.
  app.liveService.eventsAccepted(adult.householdId, laptop.deviceId);
  await until(() => seen.includes("hint"));
  // Signing out ends the session: the channel stops for good.
  await fetch(`http://127.0.0.1:${port}/api/logout`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `kin_session=${adult.sessionToken}` }, body: "{}" });
  await until(() => seen.some((entry) => entry.startsWith("end")));
  assert.deepEqual(seen, ["up", "hint", `end ${LIVE_CLOSE.SESSION_ENDED}`]);
  live.stop();
});
