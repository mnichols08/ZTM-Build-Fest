// Issue #176: a key rotation whose recipient set shrinks between attempts
// must not reuse a key already wrapped for a device that left the set. A
// relay that kept the earlier package could otherwise hand the revoked device
// the new epoch's key. Real WebCrypto; the relay and stores are fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { deviceKeyFingerprint, exportDevicePublicKeys, generateDeviceKeys } from "./crypto.js";
import { rotationRecipientsShrank, SyncCoordinator } from "./sync-coordinator.js";

const HOUSEHOLD = "a".repeat(32);
const ME = "c".repeat(32);
const mine = await generateDeviceKeys();
const myFingerprint = await deviceKeyFingerprint(await exportDevicePublicKeys(mine));

async function device(id) {
  const publicKeys = await exportDevicePublicKeys(await generateDeviceKeys());
  return { deviceId: id, publicKeys, fingerprint: await deviceKeyFingerprint(publicKeys), revokedAt: null };
}
const x = await device("1".repeat(32));
const y = await device("2".repeat(32));
const z = await device("3".repeat(32));

/** A rotating coordinator whose relay loses the first epoch POST (it does not commit). */
function rotator() {
  const state = { pendingRotation: null };
  const posts = [];
  let devices = [];
  let committed = false;
  let failNext = true;
  const coordinator = Object.create(SyncCoordinator.prototype);
  coordinator.identity = { householdId: HOUSEHOLD, deviceId: ME };
  coordinator.deviceKeys = { keys: mine, fingerprint: myFingerprint };
  coordinator.keyStore = {
    async getEpoch(householdId, keyEpoch) { return keyEpoch === 1 ? { keyEpoch } : null; },
    async saveEpoch(record) { return record; },
  };
  coordinator.store = {
    async getSyncState() { return structuredClone(state); },
    async savePendingRotation(rotation) {
      assert.equal(state.pendingRotation, null, "a pending rotation is never silently replaced");
      state.pendingRotation = structuredClone(rotation);
      return structuredClone(rotation);
    },
    async replacePendingRotationPackages({ expected, packages, issuerFingerprint }) {
      assert.equal(state.pendingRotation.proposalId, expected.proposalId);
      state.pendingRotation = { ...state.pendingRotation, packages: structuredClone(packages), issuerFingerprint };
      return structuredClone(state.pendingRotation);
    },
    async clearPendingRotation(proposalId) {
      assert.equal(state.pendingRotation?.proposalId, proposalId);
      state.pendingRotation = null;
    },
    async commitPendingRotation() { committed = true; state.pendingRotation = null; },
  };
  coordinator.loadDeviceDirectory = async () => structuredClone(devices);
  coordinator.provisionMemberHistory = async () => {};
  coordinator.request = async (path, options) => {
    if (path === "/api/sync/status")
      return { currentEpoch: committed ? 2 : 1, rotationPending: !committed, lastRotationProposalId: null };
    if (path === "/api/sync/epochs") {
      const body = JSON.parse(options.body);
      posts.push({ ...body, fingerprint: state.pendingRotation.fingerprint });
      if (failNext) { failNext = false; throw new Error("The response was lost."); }
      return { currentEpoch: 2, proposalId: body.proposalId };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  return { coordinator, posts, setDevices(list) { devices = list; }, state };
}

const recipientsOf = (post) => post.packages.map((keyPackage) => keyPackage.recipientDeviceId).sort();

test("a revoked device between attempts gets a fresh key and proposal, never the first key", async () => {
  const { coordinator, posts, setDevices } = rotator();
  setDevices([x, y]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  setDevices([{ ...x, revokedAt: Date.now() }, y]);
  await coordinator.commitRotation();
  assert.equal(posts.length, 2);
  assert.deepEqual(recipientsOf(posts[0]), [x.deviceId, y.deviceId].sort());
  assert.deepEqual(recipientsOf(posts[1]), [y.deviceId]);
  assert.notEqual(posts[1].fingerprint, posts[0].fingerprint, "the committed key is not the one wrapped for revoked X");
  assert.notEqual(posts[1].proposalId, posts[0].proposalId);
});

test("a re-keyed device between attempts also gets a fresh key", async () => {
  const { coordinator, posts, setDevices } = rotator();
  setDevices([x, y]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  const rekeyed = await device(x.deviceId);
  setDevices([rekeyed, y]);
  await coordinator.commitRotation();
  assert.notEqual(posts[1].fingerprint, posts[0].fingerprint);
});

test("a growing recipient set keeps the pending key and proposal", async () => {
  const { coordinator, posts, setDevices } = rotator();
  setDevices([x]);
  await assert.rejects(coordinator.commitRotation(), /lost/);
  setDevices([x, z]);
  await coordinator.commitRotation();
  assert.deepEqual(recipientsOf(posts[1]), [x.deviceId, z.deviceId].sort());
  assert.equal(posts[1].fingerprint, posts[0].fingerprint, "no one left, so the key may be reused");
  assert.equal(posts[1].proposalId, posts[0].proposalId);
});

test("rotationRecipientsShrank matches recipients by device and fingerprint", () => {
  const packages = [{ recipientDeviceId: x.deviceId, recipientFingerprint: x.fingerprint }];
  assert.equal(rotationRecipientsShrank(packages, [x, y]), false);
  assert.equal(rotationRecipientsShrank(packages, [y]), true);
  assert.equal(rotationRecipientsShrank(packages, [{ ...x, fingerprint: y.fingerprint }]), true);
  assert.equal(rotationRecipientsShrank([], [x]), false);
});
