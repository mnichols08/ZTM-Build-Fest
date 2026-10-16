// PairingService membership: who may manage the household, leaving,
// removing another adult, the household admin, and Temporary expiry.
import {
  canManageTrust,
  canParticipate,
  isHouseholdAdmin,
  normalizeMemberKind,
  PairingError,
  requireHouseholdAdmin,
  requireTrustAuthority,
} from "./shared.mjs";

export const membershipMethods = {
  hasHouseholdAdmin(household) {
    return [...household.members].some((memberId) =>
      isHouseholdAdmin(this.members.get(memberId), this.now()),
    );
  },

  // Households that predate household admins keep Adult-level management
  // until an admin is recorded; Kin never infers one from existing members.
  canManageMembers(member, household) {
    return this.hasHouseholdAdmin(household)
      ? isHouseholdAdmin(member, this.now())
      : canManageTrust(member, this.now());
  },

  requireManagementAuthority(member, household, action) {
    if (this.hasHouseholdAdmin(household))
      requireHouseholdAdmin(member, action, this.now());
    else requireTrustAuthority(member, action, this.now());
  },

  expireTemporaryMemberships(now = this.now()) {
    const expired = [];
    for (const member of this.members.values()) {
      if (member.active !== true || normalizeMemberKind(member.kind) !== "temporary" ||
          !Number.isSafeInteger(member.expiresAt) || member.expiresAt > now) continue;
      const household = this.households.get(member.householdId);
      if (!household) continue;
      member.active = false;
      member.memberStatus = "expired";
      household.version += 1;
      const deviceIds = [];
      for (const device of this.devices.values())
        if (device.memberId === member.id && !device.revokedAt) {
          device.revokedAt = now;
          deviceIds.push(device.id);
        }
      for (const [sessionHash, session] of this.sessions)
        if (session.memberId === member.id) this.sessions.delete(sessionHash);
      this.audit("temporary_access_expired", { householdId: household.id, memberId: member.id });
      this.persistHousehold(household.id);
      expired.push({ householdId: household.id, memberId: member.id, deviceIds });
    }
    return expired;
  },

  householdView(sessionToken) {
    const { member, household } = this.authorize(sessionToken);
    return {
      householdId: household.id,
      currentMemberId: member.id,
      adminRecorded: this.hasHouseholdAdmin(household),
      canManageMembers: this.canManageMembers(member, household),
      members: [...household.members].map((memberId) => ({
        id: memberId,
        current: memberId === member.id,
        active: canParticipate(this.members.get(memberId), this.now()),
        kind: normalizeMemberKind(this.members.get(memberId)?.kind),
        admin: isHouseholdAdmin(this.members.get(memberId), this.now()),
        ...(this.members.get(memberId)?.expiresAt == null ? {} : { expiresAt: this.members.get(memberId).expiresAt }),
      })),
    };
  },

  leaveHousehold(sessionToken, reauthenticatedMemberId) {
    const { member, household } = this.authorize(sessionToken);
    if (reauthenticatedMemberId !== member.id)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before leaving the household.",
        401,
      );
    if (!canParticipate(member, this.now()))
      throw new PairingError(
        "membership_not_active",
        "This household member is no longer active.",
        403,
      );
    const hasTrustedAdult = this.hasOtherUsableTrustedAdult(household, member.id);
    if (!hasTrustedAdult)
      throw new PairingError(
        "last_adult",
        "The only active trusted adult cannot leave. Household deletion and recovery are not available.",
        409,
      );
    if (isHouseholdAdmin(member, this.now()) && !this.hasOtherUsableAdmin(household, member.id))
      throw new PairingError(
        "last_household_admin",
        "Make another Adult a household admin before leaving.",
        409,
      );
    return this.removeMembership(household, member.id, member.id);
  },

  removalContext(sessionToken, memberId, { allowSelf = false } = {}) {
    const { member, household, device } = this.authorize(sessionToken);
    if (memberId !== member.id)
      this.requireManagementAuthority(member, household, "remove a household member");
    if (memberId === member.id && !allowSelf)
      throw new PairingError(
        "use_leave",
        "Use Leave household to remove your own membership.",
        409,
      );
    if (!household.members.has(memberId) || !this.members.get(memberId)?.active)
      throw new PairingError(
        "not_found",
        "That household member is unavailable.",
        404,
      );
    return {
      memberId: member.id,
      deviceId: device.id,
      credentialIds: [...member.credentials],
    };
  },

  removeOtherAdult(sessionToken, memberId, reauthenticatedMemberId) {
    const context = this.removalContext(sessionToken, memberId);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before removing a household member.",
        401,
      );
    const household = this.households.get(
      this.members.get(context.memberId).householdId,
    );
    const target = this.members.get(memberId);
    if (canManageTrust(target, this.now()) && !this.hasOtherUsableTrustedAdult(household, memberId))
      throw new PairingError("last_adult", "Keep another Adult with a usable trusted device and passkey before removing this Adult.", 409);
    if (isHouseholdAdmin(target, this.now()) && !this.hasOtherUsableAdmin(household, memberId))
      throw new PairingError("last_household_admin", "Keep another household admin with a usable trusted device and passkey before removing this admin.", 409);
    return this.removeMembership(household, memberId, context.memberId);
  },

  householdAdminContext(sessionToken, memberId) {
    const { member, household, device } = this.authorize(sessionToken);
    requireHouseholdAdmin(member, "change household admins", this.now());
    const target = this.members.get(memberId);
    if (!target || target.householdId !== household.id || !canParticipate(target, this.now()))
      throw new PairingError("not_found", "That household member is unavailable.", 404);
    if (normalizeMemberKind(target.kind) !== "adult")
      throw new PairingError("household_admin_adult_required", "Only Adults can be household admins.", 409);
    return {
      memberId: member.id,
      deviceId: device.id,
      credentialIds: [...member.credentials],
    };
  },

  setHouseholdAdmin(sessionToken, memberId, admin, reauthenticatedMemberId) {
    if (typeof admin !== "boolean")
      throw new PairingError("household_admin_invalid", "Choose whether this Adult is a household admin.");
    const context = this.householdAdminContext(sessionToken, memberId);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before changing household admins.",
        401,
      );
    const target = this.members.get(memberId);
    const household = this.households.get(target.householdId);
    if (isHouseholdAdmin(target, this.now()) === admin)
      return { memberId, admin, changed: false };
    if (!admin && !this.hasOtherUsableAdmin(household, memberId))
      throw new PairingError(
        "last_household_admin",
        "Make another Adult a household admin before removing this admin.",
        409,
      );
    if (admin) target.householdAdmin = true;
    else {
      delete target.householdAdmin;
      // A demoted admin loses the invitations and member recoveries they
      // started; their own device pairings stay theirs.
      this.revokeInviterPairings(household, memberId, "admin_revoked",
        (pairing) => !pairing.purpose || pairing.purpose === "member-recovery");
    }
    household.version += 1;
    this.audit(admin ? "household_admin_granted" : "household_admin_revoked", {
      householdId: household.id,
      memberId,
      actorId: context.memberId,
    });
    this.persistHousehold(household.id);
    return { memberId, admin, changed: true };
  },

  hasUsableTrustedDevice(memberId) {
    return [...this.devices.values()].some((device) =>
      device.memberId === memberId && !device.revokedAt,
    );
  },

  hasOtherUsableAdmin(household, excludingMemberId) {
    return [...household.members].some((memberId) => {
      if (memberId === excludingMemberId) return false;
      const other = this.members.get(memberId);
      return isHouseholdAdmin(other, this.now()) &&
        other.credentials?.size > 0 && this.hasUsableTrustedDevice(other.id);
    });
  },

  // Usable admin access needs a recorded admin with a passkey and an
  // unrevoked trusted device; the admin flag alone is not enough.
  hasUsableAdminAccess(household, excludingDeviceIds = []) {
    return [...household.members].some((memberId) => {
      const admin = this.members.get(memberId);
      return isHouseholdAdmin(admin, this.now()) && admin.credentials?.size > 0 &&
        [...this.devices.values()].some((device) =>
          device.memberId === memberId && !device.revokedAt &&
          !excludingDeviceIds.includes(device.id));
    });
  },

  // A household that records admins must keep one who can still act.
  // Legacy households without an admin are unaffected.
  requireAdminAccessAfterRevocation(household, deviceId) {
    if (this.hasHouseholdAdmin(household) && !this.hasUsableAdminAccess(household, [deviceId]))
      throw new PairingError(
        "last_household_admin",
        "Keep a household admin with a usable trusted device and passkey before revoking this device.",
        409,
      );
  },

  hasOtherUsableTrustedAdult(household, excludingMemberId) {
    return [...household.members].some((memberId) => {
      if (memberId === excludingMemberId) return false;
      const other = this.members.get(memberId);
      return other?.active && canManageTrust(other, this.now()) &&
        other.credentials?.size > 0 && this.hasUsableTrustedDevice(other.id);
    });
  },

  removeMembership(household, memberId, actorId) {
    const target = this.members.get(memberId);
    this.revokeInviterPairings(household, memberId, "inviter_removed");
    target.active = false;
    target.memberStatus = "removed";
    household.version += 1;
    for (const device of this.devices.values())
      if (device.memberId === memberId && !device.revokedAt) {
        device.revokedAt = this.now();
        this.audit("device_revoked", {
          householdId: household.id,
          memberId,
          deviceId: device.id,
        });
      }
    for (const [sessionHash, session] of this.sessions)
      if (session.memberId === memberId) this.sessions.delete(sessionHash);
    this.audit("membership_removed", {
      householdId: household.id,
      memberId,
      actorId,
    });
    this.persistHousehold(household.id);
    return { memberId, removed: true };
  },
};
