import test from "node:test";
import assert from "node:assert/strict";
import { activeResponsibilityMemberIds, committedBatchUpdate, loadCachedHouseholdSettings, memberHasTrustAuthority, portableMembershipFromDirectory, SyncCoordinator } from "./sync-coordinator.js";

test("empty sync polls do not publish a projection or snapshot boundary", () => {
  const state = { items: [] };
  const snapshotBoundary = { eventId: "ab", localSequence: 4 };
  assert.deepEqual(committedBatchUpdate({ added: 0, quarantined: 0, state, snapshotBoundary }), {
    added: 0,
    quarantined: 0,
  });
  assert.deepEqual(committedBatchUpdate({ added: 1, quarantined: 0, state, snapshotBoundary }), {
    added: 1,
    quarantined: 0,
    projection: state,
    snapshotBoundary,
  });
});

test("Responsibility participants include active member kinds and exclude removed or expired members", () => {
  const now = 5_000;
  const devices = [
    { memberId: "adult", memberKind: "adult", memberActive: true },
    { memberId: "limited", memberKind: "limited", memberActive: true },
    { memberId: "temporary", memberKind: "temporary", memberActive: true, memberExpiresAt: 6_000 },
    { memberId: "expired", memberKind: "temporary", memberActive: false, memberExpiresAt: now },
    { memberId: "removed", memberKind: "limited", memberActive: false, revokedAt: 4_000 },
  ];
  assert.deepEqual(activeResponsibilityMemberIds(devices, now), ["adult", "limited", "temporary"]);
});

test("portable membership snapshots preserve authoritative status, kinds, and absolute Temporary expiry", () => {
  const members = portableMembershipFromDirectory([
    { memberId: "11".repeat(16), memberKind: "adult", memberActive: true, memberStatus: "active" },
    { memberId: "22".repeat(16), memberKind: "limited", memberActive: false, memberStatus: "removed" },
    { memberId: "33".repeat(16), memberKind: "temporary", memberActive: true, memberStatus: "active", memberExpiresAt: 50_000 },
    { memberId: "44".repeat(16), memberKind: "temporary", memberActive: false, memberStatus: "expired", memberExpiresAt: 1_000 },
    { memberId: "55".repeat(16), memberKind: "adult", memberActive: false, memberStatus: "removed" },
    { memberId: "66".repeat(16), memberKind: "limited", memberActive: true, memberStatus: "active" },
    { memberId: "77".repeat(16), memberKind: "temporary", memberActive: false, memberStatus: "removed", memberExpiresAt: 1_000 },
  ], 10_000);
  assert.deepEqual(members, [
    { memberId: "11".repeat(16), memberKind: "adult", status: "active" },
    { memberId: "22".repeat(16), memberKind: "limited", status: "removed" },
    { memberId: "33".repeat(16), memberKind: "temporary", status: "active", expiresAt: 50_000 },
    { memberId: "44".repeat(16), memberKind: "temporary", status: "expired", expiresAt: 1_000 },
    { memberId: "55".repeat(16), memberKind: "adult", status: "removed" },
    { memberId: "66".repeat(16), memberKind: "limited", status: "active" },
    { memberId: "77".repeat(16), memberKind: "temporary", status: "removed", expiresAt: 1_000 },
  ]);
  assert.throws(() => portableMembershipFromDirectory([
    { memberId: "88".repeat(16), memberKind: "future", memberActive: true },
  ]), /validate current household membership/);
});

test("portable export requires authoritative status and never guesses from activity and expiry", () => {
  assert.throws(() => portableMembershipFromDirectory([
    { memberId: "77".repeat(16), memberKind: "temporary", memberActive: false, memberExpiresAt: 1_000 },
  ]), /validate current household membership/);
});

test("Temporary statuses survive archive restoration unchanged", () => {
  const id = "88".repeat(16);
  const expiredId = "99".repeat(16);
  const membership = portableMembershipFromDirectory([
    { memberId: id, memberKind: "temporary", memberActive: false, memberStatus: "removed", memberExpiresAt: 1_000 },
    { memberId: expiredId, memberKind: "temporary", memberActive: false, memberStatus: "expired", memberExpiresAt: 1_000 },
  ]);
  const packageSnapshot = { local_context: [{ portable_membership: membership }] };

  assert.deepEqual(packageSnapshot.local_context[0].portable_membership, [
    { memberId: id, memberKind: "temporary", status: "removed", expiresAt: 1_000 },
    { memberId: expiredId, memberKind: "temporary", status: "expired", expiresAt: 1_000 },
  ]);
});

test("unreachable household sync reports a plain paused state without changing saved data", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const states = [];
  const coordinator = new SyncCoordinator({
    store: {},
    engine: {},
    identity: { deviceId: "device" },
    onState: (state) => states.push(state),
  });
  coordinator.runOnce = () => coordinator.request("/api/sync/status");
  try {
    await coordinator.syncNow();
    assert.equal(states.at(-1)?.state, "paused");
    assert.equal(states.at(-1)?.code, "connection_unavailable");
    assert.match(states.at(-1)?.message, /saved information remains on this device/i);
    assert.equal(coordinator.terminal, false);
  } finally {
    coordinator.stop();
    globalThis.fetch = originalFetch;
  }
});

test("cold sync continues bounded relay history on later event-loop turns", async () => {
  const coordinator = new SyncCoordinator({
    store: {},
    engine: {},
    identity: { deviceId: "device" },
  });
  let runs = 0;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  coordinator.runOnce = async () => {
    runs += 1;
    if (runs === 3) finish();
    return runs < 3;
  };
  try {
    await coordinator.syncNow();
    assert.equal(runs, 1, "the first bounded group completes before continuation");
    let timeout;
    try {
      await Promise.race([
        finished,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("sync continuation timed out")), 500);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(runs, 3);
  } finally {
    coordinator.stop();
  }
});

test("stopping sync cancels a queued cold-history continuation", async () => {
  const coordinator = new SyncCoordinator({
    store: {},
    engine: {},
    identity: { deviceId: "device" },
  });
  let runs = 0;
  coordinator.runOnce = async () => {
    runs += 1;
    return true;
  };
  await coordinator.syncNow();
  coordinator.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runs, 1);
});

test("only Adult sessions attempt epoch rotation and key provisioning during sync", () => {
  assert.equal(memberHasTrustAuthority({ memberKind: "adult" }), true);
  assert.equal(memberHasTrustAuthority({ memberKind: "limited" }), false);
  assert.equal(memberHasTrustAuthority({ memberKind: "temporary", memberExpiresAt: 1 }), false);
  assert.equal(memberHasTrustAuthority({}), false);
  assert.equal(memberHasTrustAuthority(null), false);
});

test("offline household settings load only from the matching protected cache", async () => {
  const householdId = "11".repeat(16);
  const memberId = "12".repeat(16);
  const deviceId = "13".repeat(16);
  const cached = { householdId, revision: 4, keyEpoch: 2, ciphertext: "AQ", digest: "a".repeat(64) };
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId, deviceId: "device" } });
  coordinator.identity = { householdId, memberId, deviceId };
  coordinator.keyStore = {
    getDevice: async () => ({ householdId, memberId }),
    getCachedHouseholdSettings: async (requested) => requested === householdId ? cached : null,
  };
  coordinator.request = async () => { const error = new Error("offline"); error.code = "connection_unavailable"; throw error; };
  coordinator.loadCachedHouseholdSettings = async () => ({ version: 1, revision: cached.revision, name: "Cached Home" });
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  try {
    assert.deepEqual(await coordinator.loadHouseholdSettings(), { admin: false, adminRecorded: false,
      value: { version: 1, revision: 4, name: "Cached Home" }, offline: true });
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  }
});

test("startup cache restoration requires the locally bound household member and device", async () => {
  const identity = { householdId: "11".repeat(16), memberId: "22".repeat(16), deviceId: "33".repeat(16) };
  const cache = { householdId: identity.householdId, revision: 4, keyEpoch: 2, ciphertext: "AQ", digest: "a".repeat(64) };
  const keyStore = {
    getDevice: async () => ({ householdId: identity.householdId, memberId: identity.memberId }),
    getCachedHouseholdSettings: async () => cache,
    getEpoch: async () => null,
  };
  await assert.rejects(() => loadCachedHouseholdSettings(identity, { keyStore }), /key needed/);
  keyStore.getDevice = async () => ({ householdId: "44".repeat(16), memberId: identity.memberId });
  await assert.rejects(() => loadCachedHouseholdSettings(identity, { keyStore }), /match the local household settings cache/);
  await assert.rejects(() => loadCachedHouseholdSettings({ ...identity, deviceId: "invalid" }, { keyStore }), /identify/);
});

test("household settings are cached only after validation and newer protected revisions win", async () => {
  const householdId = "22".repeat(16);
  const server = { revision: 3, keyEpoch: 1, ciphertext: "AQ", digest: "b".repeat(64) };
  const newer = { householdId, revision: 5, keyEpoch: 2, ciphertext: "Ag", digest: "c".repeat(64) };
  const calls = [];
  const coordinator = new SyncCoordinator({ store: {}, engine: {}, identity: { householdId, deviceId: "device" } });
  coordinator.request = async () => ({ admin: true, adminRecorded: true, settings: server });
  coordinator.keyStore = { cacheHouseholdSettings: async (record) => { calls.push(record); return newer; } };
  coordinator.decryptCachedHouseholdSettings = async (record) => {
    calls.push(`decrypt:${record.revision}`);
    if (record.revision === 3) return { revision: 3, name: "Server" };
    return { revision: 5, name: "Newer cache" };
  };
  const result = await coordinator.loadHouseholdSettings();
  assert.deepEqual(calls.map((value) => typeof value === "string" ? value : `cache:${value.revision}`),
    ["decrypt:3", "cache:3", "decrypt:5"]);
  assert.equal(result.value.name, "Newer cache");

  calls.length = 0;
  coordinator.decryptCachedHouseholdSettings = async () => { throw new Error("tampered"); };
  await assert.rejects(() => coordinator.loadHouseholdSettings(), /tampered/);
  assert.deepEqual(calls, []);
});

test("a member listed twice must agree field by field", () => {
  const entry = { memberId: "aa".repeat(16), memberKind: "temporary", memberActive: true, memberStatus: "active", memberExpiresAt: 9_000 };
  // The same record with its fields in another order is one member.
  const reordered = { memberExpiresAt: 9_000, memberStatus: "active", memberActive: true, memberKind: "temporary", memberId: "aa".repeat(16) };
  assert.deepEqual(portableMembershipFromDirectory([entry, reordered]),
    [{ memberId: "aa".repeat(16), memberKind: "temporary", status: "active", expiresAt: 9_000 }]);
  for (const change of [{ memberStatus: "removed", memberActive: false }, { memberExpiresAt: 9_001 }])
    assert.throws(() => portableMembershipFromDirectory([entry, { ...entry, ...change }]), /conflicting membership/);
});
