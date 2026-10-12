import test from "node:test";
import assert from "node:assert/strict";
import { activeResponsibilityMemberIds, memberHasTrustAuthority, portableMembershipFromDirectory, SyncCoordinator } from "./sync-coordinator.js";
import { normalizeExpiredPortableMembers } from "../security/archive.js";

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

test("removed Temporary status survives export and later restore normalization", () => {
  const id = "88".repeat(16);
  const expiredId = "99".repeat(16);
  const membership = portableMembershipFromDirectory([
    { memberId: id, memberKind: "temporary", memberActive: false, memberStatus: "removed", memberExpiresAt: 1_000 },
    { memberId: expiredId, memberKind: "temporary", memberActive: false, memberStatus: "expired", memberExpiresAt: 1_000 },
  ]);
  const packageSnapshot = { local_context: [{ portable_membership: membership }] };

  normalizeExpiredPortableMembers(packageSnapshot, 2_000);

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

test("only Adult sessions attempt epoch rotation and key provisioning during sync", () => {
  assert.equal(memberHasTrustAuthority({ memberKind: "adult" }), true);
  assert.equal(memberHasTrustAuthority({ memberKind: "limited" }), false);
  assert.equal(memberHasTrustAuthority({ memberKind: "temporary", memberExpiresAt: 1 }), false);
  assert.equal(memberHasTrustAuthority({}), false);
  assert.equal(memberHasTrustAuthority(null), false);
});
