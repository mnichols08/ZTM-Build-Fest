import test from "node:test";
import assert from "node:assert/strict";
import { activeResponsibilityMemberIds, SyncCoordinator } from "./sync-coordinator.js";

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
