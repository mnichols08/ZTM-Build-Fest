// A device whose very first sync finds a key rotation pending (an Adult was
// removed, a device revoked, or a Temporary member expired before this device
// finished joining) must set up its local sync state before it commits the
// rotation: the pending rotation is saved inside that state. Before the fix
// the rotation ran first and failed with "Kin has not initialized encrypted
// sync.", and because the relay pauses pushes until the rotation commits, the
// device could stay stuck. The relay and stores are fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { SyncCoordinator } from "./sync-coordinator.js";

const HOUSEHOLD = "a".repeat(32);
const ME = { householdId: HOUSEHOLD, memberId: "b".repeat(32), deviceId: "c".repeat(32) };

function freshDevice({ rotationPending = true, existingState = null } = {}) {
  const calls = [];
  let syncState = existingState;
  let committed = false;
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.identity = ME;
  coordinator.deviceKeys = { keys: {}, fingerprint: "f" };
  coordinator.abortController = new AbortController();
  coordinator.now = () => 0;
  coordinator.onState = () => {};
  coordinator.keyStore = {
    vault: { assertUnlocked() {} },
    async getEpoch(householdId, keyEpoch) { return keyEpoch === (committed ? 2 : 1) ? { keyEpoch, householdKey: {} } : null; },
  };
  coordinator.store = {
    async requeueAfterRelayReset() {},
    async updateSyncServerState() {},
    async getSyncState() { return syncState && structuredClone(syncState); },
    async getSyncBootstrap() { return { events: [], legacyIdentity: null, maxLogicalTime: 0n }; },
    async initializeSync({ serverStatus }) {
      calls.push("initializeSync");
      assert.equal(syncState, null, "sync state is created once");
      syncState = { key: "active", currentEpoch: serverStatus.currentEpoch };
    },
    async installIdentityBindings() { calls.push("installIdentityBindings"); },
  };
  coordinator.request = async (path) => {
    assert.equal(path, "/api/sync/status");
    return {
      enabled: true,
      memberKind: "adult",
      currentEpoch: committed ? 2 : 1,
      rotationPending: rotationPending && !committed,
      eventCount: 3,
      latestCursor: "",
    };
  };
  coordinator.loadDeviceDirectory = async () => [{ deviceId: ME.deviceId, historyFromEpoch: 1, publicKeys: {} }];
  coordinator.receiveProvisioning = async () => {};
  coordinator.fetchBindings = async () => [];
  // The real rotation saves its proposal inside the sync state.
  coordinator.commitRotation = async () => {
    calls.push("commitRotation");
    if (!syncState) throw new Error("Kin has not initialized encrypted sync.");
    committed = true;
  };
  coordinator.provisionMemberHistory = async () => { calls.push("provisionMemberHistory"); };
  coordinator.pushIdentityBindings = async () => { calls.push("pushIdentityBindings"); };
  coordinator.pullCatchUpPages = async () => { calls.push("pull"); return { hasMore: false }; };
  return { coordinator, calls };
}

test("a first sync with a rotation pending sets up sync state before rotating", async () => {
  const { coordinator, calls } = freshDevice();
  await coordinator.runOnce();
  assert.deepEqual(calls, ["initializeSync", "commitRotation", "provisionMemberHistory", "pushIdentityBindings", "pull"]);
});

test("a first sync with no rotation pending is unchanged", async () => {
  const { coordinator, calls } = freshDevice({ rotationPending: false });
  await coordinator.runOnce();
  assert.deepEqual(calls, ["initializeSync", "provisionMemberHistory", "pushIdentityBindings", "pull"]);
});

test("an initialized device still rotates and does not re-create its state", async () => {
  const { coordinator, calls } = freshDevice({ existingState: { key: "active", currentEpoch: 1 } });
  await coordinator.runOnce();
  assert.deepEqual(calls, ["commitRotation", "provisionMemberHistory", "pushIdentityBindings", "pull"]);
});
