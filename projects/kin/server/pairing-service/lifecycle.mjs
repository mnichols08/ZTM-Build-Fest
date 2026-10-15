// PairingService household lifecycle: deletion requests, cancellation and
// finalization.
import { HOUSEHOLD_DELETION_GRACE_MS } from "../durable-store.mjs";
import { PairingError } from "./shared.mjs";

export const lifecycleMethods = {
  requestHouseholdDeletion(sessionToken, reauthenticatedMemberId) {
    const { member, household } = this.authorize(sessionToken);
    this.requireManagementAuthority(member, household, "delete the household");
    if (reauthenticatedMemberId !== member.id)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with this member's passkey again before deleting the household.",
        401,
      );
    const requestedAt = this.now();
    const finalizeAt = requestedAt + HOUSEHOLD_DELETION_GRACE_MS;
    const lifecycle = this.store
      ? this.store.requestHouseholdDeletion(
          household.id,
          requestedAt,
          finalizeAt,
        )
      : {
          state: "deletion_pending",
          requestedAt,
          finalizeAt,
          deletedAt: null,
        };
    Object.assign(household, {
      lifecycleState: lifecycle.state,
      deletionRequestedAt: lifecycle.requestedAt,
      deletionFinalizeAt: lifecycle.finalizeAt,
      deletedAt: lifecycle.deletedAt,
    });
    for (const [sessionHash, session] of this.sessions)
      if (this.members.get(session.memberId)?.householdId === household.id)
        this.sessions.delete(sessionHash);
    this.expireHouseholdPairings(household.id);
    return {
      state: lifecycle.state,
      requestedAt: lifecycle.requestedAt,
      finalizeAt: lifecycle.finalizeAt,
    };
  },

  cancelHouseholdDeletion(deviceToken, credentialId) {
    const { device, member } = this.trustedDevice(deviceToken, {
      allowDeletionPending: true,
    });
    const household = this.households.get(member.householdId);
    this.requireManagementAuthority(member, household, "cancel household deletion");
    const credential = this.credentials.get(credentialId);
    if (!credential || credential.memberId !== member.id)
      throw new PairingError(
        "invalid_passkey",
        "That passkey could not be verified.",
        401,
      );
    if (
      household?.lifecycleState !== "deletion_pending" ||
      household.deletionFinalizeAt <= this.now()
    )
      throw new PairingError(
        "household_deletion_final",
        "The household deletion can no longer be cancelled.",
        409,
      );
    const lifecycle = this.store
      ? this.store.cancelHouseholdDeletion(household.id, this.now())
      : {
          state: "active",
          requestedAt: null,
          finalizeAt: null,
          deletedAt: null,
        };
    Object.assign(household, {
      lifecycleState: lifecycle.state,
      deletionRequestedAt: lifecycle.requestedAt,
      deletionFinalizeAt: lifecycle.finalizeAt,
      deletedAt: lifecycle.deletedAt,
    });
    const sessionToken = this.issueSession(member.id, device.id).sessionToken;
    const refreshedDeviceToken = this.issueDeviceToken(device);
    this.persistHousehold(household.id);
    return {
      sessionToken,
      deviceToken: refreshedDeviceToken,
      householdId: household.id,
      memberId: member.id,
      deviceId: device.id,
    };
  },

  finalizeExpiredDeletions(now = this.now()) {
    const expired = this.store?.finalizeExpiredDeletions(now) ?? [];
    const householdIds = new Set(expired);
    if (!this.store)
      for (const household of this.households.values())
        if (
          household.lifecycleState === "deletion_pending" &&
          household.deletionFinalizeAt <= now
        )
          householdIds.add(household.id);
    for (const householdId of householdIds) {
      const household = this.households.get(householdId);
      if (!household) continue;
      for (const [sessionHash, session] of this.sessions)
        if (this.members.get(session.memberId)?.householdId === householdId)
          this.sessions.delete(sessionHash);
      for (const device of this.devices.values())
        if (device.householdId === householdId && device.tokenHash)
          this.deviceTokens.delete(device.tokenHash);
      for (const [deviceId, device] of this.devices)
        if (device.householdId === householdId) this.devices.delete(deviceId);
      for (const [memberId, member] of this.members)
        if (member.householdId === householdId) {
          for (const credentialId of member.credentials)
            this.credentials.delete(credentialId);
          this.members.delete(memberId);
        }
      household.members.clear();
      household.lifecycleState = "deleted";
      household.deletionRequestedAt = null;
      household.deletionFinalizeAt = null;
      household.deletedAt = now;
      this.expireHouseholdPairings(householdId);
    }
    return [...householdIds];
  },
};
