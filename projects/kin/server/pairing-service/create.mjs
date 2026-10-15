// PairingService, pairing stage 1: an adult creates a pairing (new member,
// new device, replacement device or member recovery) within household limits.
import {
  MAX_ACTIVE_ADULTS,
  MAX_ACTIVE_LIMITED_MEMBERS,
  MAX_ACTIVE_MEMBERS,
  MAX_TRUSTED_DEVICES,
} from "../identity-limits.mjs";
import {
  canParticipate,
  codeValue,
  id,
  isHouseholdAdmin,
  normalizeMemberKind,
  PAIRING_TTL_MS,
  PairingError,
  requireHouseholdAdmin,
  requireTrustAuthority,
} from "./shared.mjs";

export const createMethods = {
  activeMemberCount(household) {
    return [...household.members].filter((memberId) => {
      const member = this.members.get(memberId);
      return member && canParticipate(member, this.now());
    }).length;
  },

  activeTrustedDeviceCount(household) {
    return [...this.devices.values()].filter(
      (device) =>
        device.householdId === household.id &&
        !device.revokedAt &&
        this.members.get(device.memberId) &&
        canParticipate(this.members.get(device.memberId), this.now()),
    ).length;
  },

  activeKindCount(household, kind) {
    return [...household.members].filter((memberId) => {
      const candidate = this.members.get(memberId);
      return canParticipate(candidate, this.now()) && normalizeMemberKind(candidate.kind) === kind;
    }).length;
  },

  createPairing(sessionToken, { kind = "adult", expiresAt } = {}) {
    const { member, household, device } = this.authorize(sessionToken);
    this.requireManagementAuthority(member, household, "invite a new household member");
    if (! ["adult", "limited", "temporary"].includes(kind))
      throw new PairingError("member_kind_invalid", "Choose a supported member type.");
    if (kind === "temporary" && (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()))
      throw new PairingError("temporary_expiry_required", "Temporary access needs a valid future expiry.");
    if (kind !== "temporary" && expiresAt !== undefined)
      throw new PairingError("temporary_expiry_unexpected", "Only temporary access can have an expiry.");
    this.prunePairingCapabilities();
    if (this.activeMemberCount(household) >= MAX_ACTIVE_MEMBERS ||
        kind === "adult" && this.activeKindCount(household, "adult") >= MAX_ACTIVE_ADULTS ||
        kind === "limited" && this.activeKindCount(household, "limited") >= MAX_ACTIVE_LIMITED_MEMBERS)
      throw new PairingError(
        "household_full",
        "This household has reached its member limit.",
        409,
      );
    for (const pairing of this.pairings.values()) {
      if (
        pairing.householdId === household.id &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    }
    let code;
    let verifier;
    do {
      code = codeValue();
      verifier = this.verifier(code);
    } while (this.codeIndex.has(verifier));
    const pairing = {
      id: id(),
      householdId: household.id,
      inviterId: member.id,
      admissionKind: kind,
      ...(kind === "temporary" ? { admissionExpiresAt: expiresAt } : {}),
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("pairing_created", {
      householdId: household.id,
      pairingId: pairing.id,
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
    });
    // The inviting client checks this against its local key before showing
    // the code; it is the same value pairingView() returns to the inviter.
    return {
      pairingId: pairing.id,
      code,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      memberKind: pairing.admissionKind,
      inviterDeviceId: pairing.inviterDeviceId,
      inviterKeyFingerprint: pairing.inviterKeyFingerprint,
      version: pairing.version,
    };
  },

  createDevicePairing(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireTrustAuthority(member, "manage this device");
    this.prunePairingCapabilities();
    if (this.activeTrustedDeviceCount(household) >= MAX_TRUSTED_DEVICES)
      throw new PairingError(
        "device_limit",
        "This household reached its trusted-device limit.",
        409,
      );
    for (const pairing of this.pairings.values()) {
      if (
        pairing.householdId === household.id &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    }
    let code;
    let verifier;
    do {
      code = codeValue();
      verifier = this.verifier(code);
    } while (this.codeIndex.has(verifier));
    const pairing = {
      id: id(),
      purpose: "device",
      householdId: household.id,
      inviterId: member.id,
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
      memberId: member.id,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("device_pairing_created", {
      householdId: household.id,
      pairingId: pairing.id,
      inviterDeviceId: device.id,
      inviterKeyFingerprint: device.syncKeyFingerprint,
      memberId: member.id,
    });
    return {
      pairingId: pairing.id,
      code,
      purpose: pairing.purpose,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      inviterDeviceId: pairing.inviterDeviceId,
      inviterKeyFingerprint: pairing.inviterKeyFingerprint,
      version: pairing.version,
    };
  },

  createReplacementPairing(sessionToken, lostDeviceId) {
    const { member, household, device: approverDevice } =
      this.authorize(sessionToken);
    requireTrustAuthority(member, "replace a trusted device");
    this.prunePairingCapabilities();
    const lostDevice = this.devices.get(lostDeviceId);
    if (
      !lostDevice ||
      lostDevice.householdId !== household.id ||
      lostDevice.memberId !== member.id ||
      lostDevice.id === approverDevice.id ||
      lostDevice.revokedAt
    )
      throw new PairingError(
        "replacement_unavailable",
        "That device cannot be replaced from this trusted device.",
        404,
      );
    for (const pairing of this.pairings.values())
      if (
        pairing.householdId === household.id &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    let code;
    let verifier;
    do {
      code = codeValue();
      verifier = this.verifier(code);
    } while (this.codeIndex.has(verifier));
    const pairing = {
      id: id(),
      purpose: "replacement",
      householdId: household.id,
      inviterId: member.id,
      inviterDeviceId: approverDevice.id,
      inviterKeyFingerprint: approverDevice.syncKeyFingerprint,
      memberId: member.id,
      lostDeviceId,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("device_replacement_created", {
      householdId: household.id,
      pairingId: pairing.id,
      memberId: member.id,
      lostDeviceId,
      approverDeviceId: approverDevice.id,
    });
    return {
      pairingId: pairing.id,
      code,
      purpose: pairing.purpose,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      version: pairing.version,
    };
  },

  createMemberRecoveryPairing(sessionToken, targetMemberId) {
    const { member: approver, household, device: approverDevice } =
      this.authorize(sessionToken);
    requireTrustAuthority(approver, "approve member recovery");
    this.prunePairingCapabilities();
    const target = this.members.get(targetMemberId);
    // Recovery issues a device for the target member, so recovering an admin
    // must not let a non-admin Adult acquire admin authority.
    if (isHouseholdAdmin(target, this.now()))
      requireHouseholdAdmin(approver, "recover a household admin", this.now());
    if (
      !target ||
      target.householdId !== household.id ||
      !target.active ||
      target.id === approver.id
    )
      throw new PairingError(
        "recovery_unavailable",
        "That household member cannot use assisted recovery.",
        404,
      );
    for (const pairing of this.pairings.values())
      if (
        pairing.householdId === household.id &&
        ["Pending", "Claimed"].includes(this.state(pairing))
      )
        this.revokePairing(sessionToken, pairing.id);
    let code;
    let verifier;
    do {
      code = codeValue();
      verifier = this.verifier(code);
    } while (this.codeIndex.has(verifier));
    const pairing = {
      id: id(),
      purpose: "member-recovery",
      householdId: household.id,
      inviterId: approver.id,
      inviterDeviceId: approverDevice.id,
      inviterKeyFingerprint: approverDevice.syncKeyFingerprint,
      memberId: target.id,
      verifier,
      createdAt: this.now(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      state: "Pending",
      version: 1,
      attempts: 0,
      claimant: null,
      confirmedMemberId: null,
    };
    this.pairings.set(pairing.id, pairing);
    this.codeIndex.set(verifier, pairing.id);
    this.audit("member_recovery_created", {
      householdId: household.id,
      pairingId: pairing.id,
      approverMemberId: approver.id,
      targetMemberId: target.id,
      approverDeviceId: approverDevice.id,
    });
    return {
      pairingId: pairing.id,
      code,
      purpose: pairing.purpose,
      targetMemberId: target.id,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      version: pairing.version,
    };
  },

  expireHouseholdPairings(householdId) {
    for (const [pairingId, pairing] of this.pairings)
      if (pairing.householdId === householdId) {
        this.codeIndex.delete(pairing.verifier);
        for (const [claimHash, storedPairingId] of this.claimTokens)
          if (storedPairingId === pairingId) this.claimTokens.delete(claimHash);
        this.pairings.delete(pairingId);
      }
  },
};
