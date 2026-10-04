import assert from "node:assert/strict";
import test from "node:test";
import { PairingService } from "./pairing-service.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

function addSameMemberDevice(service, adult, suffix) {
  const request = service.createDevicePairing(adult.sessionToken);
  const claim = service.claimPairing({
    code: request.code,
    credential: credential(`credential-${suffix}`),
    deviceLabel: `Device ${suffix}`,
  });
  service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  return service.activateClaim(claim.claimToken);
}

test("replacement creates fresh device authority and revokes the lost device", () => {
  let now = 1_000;
  const service = new PairingService({ now: () => now });
  const adult = service.bootstrap({
    credential: credential("original"),
    deviceLabel: "Current phone",
  });
  const lost = addSameMemberDevice(service, adult, "lost");
  const lostSession = lost.sessionToken;

  now += 1;
  const request = service.createReplacementPairing(
    adult.sessionToken,
    lost.deviceId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("replacement"),
    deviceLabel: "Replacement phone",
  });
  const approved = service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  const activated = service.activateClaim(claim.claimToken);

  assert.equal(approved.purpose, "replacement");
  assert.equal(approved.lostDeviceId, lost.deviceId);
  assert.notEqual(activated.deviceId, lost.deviceId);
  assert.equal(activated.memberId, adult.memberId);
  assert.equal(service.devices.get(lost.deviceId).revokedAt, now);
  assert.throws(
    () => service.authorize(lostSession),
    (error) => error.code === "authentication_required",
  );
  assert.equal(service.devices.get(activated.deviceId).revokedAt, null);
  assert.ok(
    service.events.some(
      (event) =>
        event.type === "device_replacement_completed" &&
        event.lostDeviceId === lost.deviceId,
    ),
  );
});

test("replacement is same-member, device-bound, single-use, and stale-safe", () => {
  const service = new PairingService();
  const adult = service.bootstrap({ credential: credential("a") });
  const lost = addSameMemberDevice(service, adult, "old");
  assert.throws(
    () => service.createReplacementPairing(adult.sessionToken, adult.deviceId),
    (error) => error.code === "replacement_unavailable",
  );
  assert.throws(
    () => service.createReplacementPairing(adult.sessionToken, "f".repeat(32)),
    (error) => error.code === "replacement_unavailable",
  );

  const request = service.createReplacementPairing(
    adult.sessionToken,
    lost.deviceId,
  );
  const claim = service.claimPairing({
    code: request.code,
    credential: credential("new"),
    deviceLabel: "New device",
  });
  assert.throws(
    () =>
      service.approvePairing(
        adult.sessionToken,
        request.pairingId,
        request.version,
      ),
    (error) => error.code === "stale_pairing",
  );
  service.approvePairing(
    adult.sessionToken,
    request.pairingId,
    claim.version,
  );
  assert.equal(
    service.approvePairing(
      adult.sessionToken,
      request.pairingId,
      claim.version,
    ).state,
    "Confirmed",
  );
  service.activateClaim(claim.claimToken);
  assert.throws(
    () => service.activateClaim(claim.claimToken),
    (error) => error.code === "claim_not_confirmed",
  );
});

