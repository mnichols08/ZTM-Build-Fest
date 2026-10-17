// PairingService sessions: bootstrapping the first adult, credentials,
// sessions, device tokens and reauthentication.
import { validateSyncPublicKeys } from "./devices.mjs";
import {
  canParticipate,
  cleanLabel,
  hash,
  id,
  PairingError,
  SESSION_TTL_MS,
  token,
} from "./shared.mjs";

export const sessionMethods = {
  addCredential(memberId, credential) {
    if (!credential?.id || !credential.publicKey || !credential.algorithm) {
      throw new PairingError(
        "invalid_credential",
        "A valid passkey is required.",
      );
    }
    if (this.credentials.has(credential.id)) {
      throw new PairingError(
        "credential_in_use",
        "That passkey is already registered.",
        409,
      );
    }
    this.credentials.set(credential.id, {
      ...credential,
      memberId,
      signCount: credential.signCount ?? 0,
    });
  },

  bootstrap({ credential, deviceLabel = "Device", syncPublicKeys, rateKey }) {
    this.assertBootstrapAllowed(rateKey);
    const keyRecord = syncPublicKeys
      ? validateSyncPublicKeys(syncPublicKeys)
      : {};
    const householdId = id();
    const memberId = id();
    const deviceId = id();
    this.households.set(householdId, {
      id: householdId,
      members: new Set([memberId]),
      version: 1,
      lifecycleState: "active",
      deletionRequestedAt: null,
      deletionFinalizeAt: null,
      deletedAt: null,
      ownerMemberId: memberId,
    });
    this.members.set(memberId, {
      id: memberId,
      householdId,
      active: true,
      kind: "adult",
      householdAdmin: true,
      credentials: new Set([credential.id]),
    });
    this.addCredential(memberId, credential);
    const device = {
      id: deviceId,
      memberId,
      householdId,
      label: cleanLabel(deviceLabel),
      trustedAt: this.now(),
      revokedAt: null,
      tokenHash: null,
      ...keyRecord,
    };
    this.devices.set(deviceId, device);
    const deviceToken = this.issueDeviceToken(device);
    this.audit("device_trusted", { householdId, memberId, deviceId });
    this.persistHousehold(householdId);
    this.recordBootstrap(rateKey);
    return {
      ...this.issueSession(memberId, deviceId),
      deviceToken,
      householdId,
      memberId,
      deviceId,
    };
  },

  issueSession(memberId, deviceId) {
    this.pruneSessions();
    const value = token();
    this.sessions.set(hash(value), {
      memberId,
      deviceId,
      expiresAt: this.now() + SESSION_TTL_MS,
    });
    return { sessionToken: value };
  },

  pruneSessions(now = this.now()) {
    for (const [sessionHash, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(sessionHash);
  },

  authorize(sessionToken, { requireTrusted = true } = {}) {
    this.store?.assertAvailable();
    this.pruneSessions();
    const session = this.sessions.get(hash(String(sessionToken ?? "")));
    if (!session)
      throw new PairingError(
        "authentication_required",
        "Authenticate with your passkey to continue.",
        401,
      );
    const member = this.members.get(session.memberId);
    const device = this.devices.get(session.deviceId);
    const household = member && this.households.get(member.householdId);
    if (household?.lifecycleState === "deletion_pending")
      throw new PairingError(
        "household_deletion_pending",
        "This household is pending deletion and can no longer sync.",
        410,
      );
    if (household?.lifecycleState === "deleted")
      throw new PairingError(
        "household_deleted",
        "This household was deleted and can no longer sync.",
        410,
      );
    if (!member?.active || !canParticipate(member, this.now())) {
      throw new PairingError(
        "membership_removed",
        "This household membership is no longer active.",
        403,
      );
    }
    if (requireTrusted && (!device || device.revokedAt)) {
      throw new PairingError(
        "device_not_trusted",
        "This device is no longer trusted. Use another trusted device or recovery.",
        403,
      );
    }
    return {
      session,
      member,
      device,
      household,
    };
  },

  issueDeviceToken(device) {
    const value = token();
    if (device.tokenHash) this.deviceTokens.delete(device.tokenHash);
    device.tokenHash = hash(value);
    this.deviceTokens.set(device.tokenHash, device.id);
    return value;
  },

  trustedDevice(deviceToken, { allowDeletionPending = false } = {}) {
    this.store?.assertAvailable();
    const tokenHash = hash(String(deviceToken ?? ""));
    const device = this.devices.get(this.deviceTokens.get(tokenHash));
    if (!device)
      throw new PairingError(
        "device_not_trusted",
        "This browser is not a trusted device.",
        403,
      );
    const member = this.members.get(device.memberId);
    if (!member?.active || !canParticipate(member, this.now()))
      throw new PairingError(
        "membership_removed",
        "This household membership is no longer active.",
        403,
      );
    if (device.revokedAt)
      throw new PairingError(
        "device_not_trusted",
        "This browser is no longer trusted. Use an active trusted device.",
        403,
      );
    const household = this.households.get(device.householdId);
    if (household?.lifecycleState === "deleted")
      throw new PairingError(
        "household_deleted",
        "This household was deleted and can no longer sync.",
        410,
      );
    if (
      household?.lifecycleState === "deletion_pending" &&
      !allowDeletionPending
    )
      throw new PairingError(
        "household_deletion_pending",
        "This household is pending deletion and can no longer sync.",
        410,
      );
    return { device, member };
  },

  reauthenticationCredentialIds(deviceToken) {
    const { member } = this.trustedDevice(deviceToken);
    return [...member.credentials];
  },

  reauthenticate(deviceToken, credentialId) {
    const { device, member } = this.trustedDevice(deviceToken);
    const credential = this.credentials.get(credentialId);
    if (!credential || credential.memberId !== member.id)
      throw new PairingError(
        "invalid_passkey",
        "That passkey could not be verified.",
        401,
      );
    const result = {
      ...this.issueSession(member.id, device.id),
      deviceToken: this.issueDeviceToken(device),
      householdId: member.householdId,
      memberId: member.id,
      deviceId: device.id,
    };
    this.persistHousehold(member.householdId);
    return result;
  },

  credentialForAuthenticatedMember(sessionToken, credentialId) {
    const { member } = this.authorize(sessionToken);
    const credential = this.credentials.get(credentialId);
    if (!credential || credential.memberId !== member.id)
      throw new PairingError(
        "passkey_member_mismatch",
        "Use this member's passkey to continue.",
        401,
      );
    return credential;
  },

  logout(sessionToken) {
    this.sessions.delete(hash(String(sessionToken ?? "")));
  },
};
