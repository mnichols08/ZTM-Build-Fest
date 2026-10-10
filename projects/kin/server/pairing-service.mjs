import {
  createPublicKey,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { MAX_ACTIVE_MEMBERS, MAX_TRUSTED_DEVICES } from "./identity-limits.mjs";
import { HOUSEHOLD_DELETION_GRACE_MS } from "./durable-store.mjs";
export { MAX_ACTIVE_MEMBERS, MAX_TRUSTED_DEVICES } from "./identity-limits.mjs";

export const PAIRING_TTL_MS = 10 * 60_000;
export const CLAIM_TTL_MS = 15 * 60_000;
export const MAX_CODE_ATTEMPTS = 8;
export const RATE_WINDOW_MS = 60_000;
export const RATE_LIMIT = 12;
export const MAX_RATE_BUCKETS = 4096;
export const SESSION_TTL_MS = 12 * 60 * 60_000;
export const TERMINAL_PAIRING_RETENTION_MS = 24 * 60 * 60_000;
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export class PairingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "PairingError";
    this.code = code;
    this.status = status;
  }
}

const id = () => randomBytes(16).toString("hex");
const token = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");

export const MEMBER_KINDS = Object.freeze(["adult", "limited", "temporary"]);

export function normalizeMemberKind(kind, fallback = "adult") {
  if (kind === undefined) return fallback;
  if (kind === null) return "invalid";
  const value = String(kind).trim().toLowerCase();
  if (!value) return "invalid";
  if (value === "adult_member" || value === "trusted_adult" || value === "adult")
    return "adult";
  if (value === "limited_member" || value === "limited") return "limited";
  if (
    value === "temporary_member" ||
    value === "temporary" ||
    value === "guest" ||
    value === "caregiver"
  )
    return "temporary";
  return "invalid";
}

export function canManageTrust(member, now = Date.now()) {
  if (!member || member.active === false || member.revokedAt) return false;
  return normalizeMemberKind(member.kind) === "adult";
}

export function canParticipate(member, now = Date.now()) {
  if (!member || member.active === false || member.revokedAt) return false;
  const normalized = normalizeMemberKind(member.kind);
  if (normalized === "invalid") return false;
  if (normalized === "temporary") return isTemporaryMember(member, now);
  return normalized === "adult" || normalized === "limited";
}

export function requireTrustAuthority(member, action = "manage trust", now = Date.now()) {
  if (!canManageTrust(member, now))
    throw new PairingError(
      "adult_required",
      `Only adults can ${action}.`,
      403,
    );
}

export function isTemporaryMember(member, now = Date.now()) {
  if (!member || member.active === false || member.revokedAt) return false;
  const normalized = normalizeMemberKind(member.kind);
  if (normalized !== "temporary") return false;
  if (!Number.isFinite(member.expiresAt)) return false;
  return member.expiresAt > now;
}

function codeValue() {
  let value = "";
  while (value.length < 8) {
    for (const byte of randomBytes(16)) {
      // Reject unused slots in the 32-value mask to avoid modulo bias.
      const index = byte & 31;
      if (index < PAIRING_CODE_ALPHABET.length)
        value += PAIRING_CODE_ALPHABET[index];
      if (value.length === 8) break;
    }
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export function normalizeCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export class PairingService {
  constructor({
    now = () => Date.now(),
    secret = randomBytes(32),
    maxRateBuckets = MAX_RATE_BUCKETS,
    store,
  } = {}) {
    this.now = now;
    this.secret = secret;
    this.maxRateBuckets = maxRateBuckets;
    this.store = store;
    store?.finalizeExpiredDeletions(now());
    const identity = store?.loadIdentity();
    this.households = identity?.households ?? new Map();
    this.members = identity?.members ?? new Map();
    this.credentials = identity?.credentials ?? new Map();
    this.devices = identity?.devices ?? new Map();
    this.deviceTokens = new Map(
      [...this.devices.values()]
        .filter((device) => device.tokenHash)
        .map((device) => [device.tokenHash, device.id]),
    );
    // Restore durable authority only; restart cancels enrollment and sessions.
    this.pairings = new Map();
    this.codeIndex = new Map();
    this.sessions = new Map();
    this.claimTokens = new Map();
    this.rateBuckets = new Map();
    this.events = [];
  }

  verifier(code) {
    return createHmac("sha256", this.secret)
      .update(normalizeCode(code))
      .digest("hex");
  }

  audit(type, details = {}) {
    this.events.push({ type, at: this.now(), ...details, persisted: false });
    if (this.events.length > 10_000) this.events.shift();
  }

  persistHousehold(householdId) {
    this.store?.saveIdentityHousehold(householdId, this);
  }

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
  }

  bootstrap({ credential, deviceLabel = "This device", syncPublicKeys }) {
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
    });
    this.members.set(memberId, {
      id: memberId,
      householdId,
      active: true,
      kind: "adult",
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
    return {
      ...this.issueSession(memberId, deviceId),
      deviceToken,
      householdId,
      memberId,
      deviceId,
    };
  }

  issueSession(memberId, deviceId) {
    this.pruneSessions();
    const value = token();
    this.sessions.set(hash(value), {
      memberId,
      deviceId,
      expiresAt: this.now() + SESSION_TTL_MS,
    });
    return { sessionToken: value };
  }

  pruneSessions(now = this.now()) {
    for (const [sessionHash, session] of this.sessions)
      if (session.expiresAt <= now) this.sessions.delete(sessionHash);
  }

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
  }

  issueDeviceToken(device) {
    const value = token();
    if (device.tokenHash) this.deviceTokens.delete(device.tokenHash);
    device.tokenHash = hash(value);
    this.deviceTokens.set(device.tokenHash, device.id);
    return value;
  }

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
  }

  requestHouseholdDeletion(sessionToken, reauthenticatedMemberId) {
    const { member, household } = this.authorize(sessionToken);
    requireTrustAuthority(member, "delete the household");
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
  }

  cancelHouseholdDeletion(deviceToken, credentialId) {
    const { device, member } = this.trustedDevice(deviceToken, {
      allowDeletionPending: true,
    });
    requireTrustAuthority(member, "cancel household deletion");
    const household = this.households.get(member.householdId);
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
  }

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
  }

  expireHouseholdPairings(householdId) {
    for (const [pairingId, pairing] of this.pairings)
      if (pairing.householdId === householdId) {
        this.codeIndex.delete(pairing.verifier);
        for (const [claimHash, storedPairingId] of this.claimTokens)
          if (storedPairingId === pairingId) this.claimTokens.delete(claimHash);
        this.pairings.delete(pairingId);
      }
  }

  reauthenticationCredentialIds(deviceToken) {
    const { member } = this.trustedDevice(deviceToken);
    return [...member.credentials];
  }

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
  }

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
  }

  activeMemberCount(household) {
    return [...household.members].filter((memberId) => {
      const member = this.members.get(memberId);
      return member && canParticipate(member, this.now());
    }).length;
  }

  activeTrustedDeviceCount(household) {
    return [...this.devices.values()].filter(
      (device) =>
        device.householdId === household.id &&
        !device.revokedAt &&
        this.members.get(device.memberId) &&
        canParticipate(this.members.get(device.memberId), this.now()),
    ).length;
  }

  createPairing(sessionToken) {
    const { member, household, device } = this.authorize(sessionToken);
    requireTrustAuthority(member, "invite a new household member");
    this.prunePairingCapabilities();
    if (this.activeMemberCount(household) >= MAX_ACTIVE_MEMBERS)
      throw new PairingError(
        "household_full",
        "This household has reached its four-adult limit.",
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
    return {
      pairingId: pairing.id,
      code,
      state: pairing.state,
      expiresAt: pairing.expiresAt,
      version: pairing.version,
    };
  }

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
      version: pairing.version,
    };
  }

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
  }

  createMemberRecoveryPairing(sessionToken, targetMemberId) {
    const { member: approver, household, device: approverDevice } =
      this.authorize(sessionToken);
    requireTrustAuthority(approver, "approve member recovery");
    this.prunePairingCapabilities();
    const target = this.members.get(targetMemberId);
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
  }

  state(pairing) {
    if (
      ["Pending", "Claimed"].includes(pairing.state) &&
      pairing.expiresAt <= this.now()
    ) {
      pairing.state = "Expired";
      pairing.terminalAt = this.now();
      pairing.version += 1;
      this.codeIndex.delete(pairing.verifier);
      this.audit("pairing_expired", {
        householdId: pairing.householdId,
        pairingId: pairing.id,
      });
    }
    return pairing.state;
  }

  rateLimit(key) {
    const now = this.now();
    const cutoff = now - RATE_WINDOW_MS;
    for (const [rateKey, values] of this.rateBuckets) {
      const active = values.filter((at) => at > cutoff);
      if (active.length) this.rateBuckets.set(rateKey, active);
      else this.rateBuckets.delete(rateKey);
    }
    let bucket = this.rateBuckets.get(key);
    if (!bucket) {
      if (this.rateBuckets.size >= this.maxRateBuckets) {
        this.audit("pairing_rate_limited");
        throw new PairingError(
          "rate_limited",
          "Too many attempts. Wait a minute and try again.",
          429,
        );
      }
      bucket = [];
    }
    bucket.push(now);
    this.rateBuckets.set(key, bucket);
    if (bucket.length > RATE_LIMIT) {
      this.audit("pairing_rate_limited");
      throw new PairingError(
        "rate_limited",
        "Too many attempts. Wait a minute and try again.",
        429,
      );
    }
  }

  validatePairingCode(code, { rateKey = "unknown" } = {}) {
    this.rateLimit(rateKey);
    const pairing = this.pairings.get(this.codeIndex.get(this.verifier(code)));
    if (!pairing) {
      this.audit("pairing_failed_attempt");
      throw genericCodeError();
    }
    const state = this.state(pairing);
    if (state !== "Pending") throw terminalPairingError(state);
    return { valid: true, purpose: pairing.purpose ?? "adult" };
  }

  claimPairing({
    code,
    credential,
    deviceLabel,
    syncPublicKeys,
    rateKey = "unknown",
  }) {
    this.rateLimit(rateKey);
    const verifier = this.verifier(code);
    const pairing = this.pairings.get(this.codeIndex.get(verifier));
    if (!pairing) {
      this.audit("pairing_failed_attempt");
      throw genericCodeError();
    }
    const state = this.state(pairing);
    if (state !== "Pending") throw terminalPairingError(state);
    pairing.attempts += 1;
    if (pairing.attempts > MAX_CODE_ATTEMPTS) {
      pairing.state = "Revoked";
      pairing.terminalAt = this.now();
      pairing.version += 1;
      this.audit("pairing_revoked", {
        pairingId: pairing.id,
        reason: "attempt_limit",
      });
      throw genericCodeError();
    }
    const claimToken = token();
    const deviceToken = token();
    const claimedAt = this.now();
    pairing.expiresAt = claimedAt + CLAIM_TTL_MS;
    pairing.claimant = {
      credential,
      deviceLabel: cleanLabel(deviceLabel),
      memberId: pairing.memberId ?? id(),
      deviceId: id(),
      ...(syncPublicKeys ? validateSyncPublicKeys(syncPublicKeys) : {}),
      tokenHash: hash(claimToken),
      deviceToken,
      deviceTokenHash: hash(deviceToken),
      claimedAt,
    };
    pairing.state = "Claimed";
    pairing.version += 1;
    this.claimTokens.set(hash(claimToken), pairing.id);
    this.audit("pairing_claimed", {
      householdId: pairing.householdId,
      pairingId: pairing.id,
    });
    return {
      claimToken,
      pairingId: pairing.id,
      purpose: pairing.purpose ?? "adult",
      state: pairing.state,
      deviceToken,
      expiresAt: pairing.expiresAt,
      version: pairing.version,
    };
  }

  approvePairing(
    sessionToken,
    pairingId,
    expectedVersion,
    deviceAuthorizationCertificate,
  ) {
    const {
      member,
      household,
      device: approverDevice,
    } = this.authorize(sessionToken);
    requireTrustAuthority(member, "approve a pairing");
    const pairing = this.pairings.get(pairingId);
    if (
      !pairing ||
      pairing.householdId !== household.id ||
      pairing.inviterId !== member.id
    )
      throw new PairingError(
        "not_found",
        "That pairing request is unavailable.",
        404,
      );
    const state = this.state(pairing);
    if (state === "Confirmed") return this.pairingView(pairing);
    if (state !== "Claimed") throw terminalPairingError(state);
    if (pairing.version !== expectedVersion)
      throw new PairingError(
        "stale_pairing",
        "The pairing request changed. Review its latest status.",
        409,
      );
    if (pairing.claimant.syncPublicKeys)
      validateDeviceAuthorizationCertificate(deviceAuthorizationCertificate, {
        householdId: household.id,
        memberId: pairing.claimant.memberId,
        deviceId: pairing.claimant.deviceId,
        claimantPublicKeys: pairing.claimant.syncPublicKeys,
        claimantFingerprint: pairing.claimant.syncKeyFingerprint,
        approverDevice,
      });
    else if (deviceAuthorizationCertificate)
      throw new PairingError(
        "device_certificate_invalid",
        "Kin could not verify this device approval.",
        400,
      );
    if (["device", "replacement", "member-recovery"].includes(pairing.purpose)) {
      const existingMember = this.members.get(pairing.memberId);
      const activeDevices = this.activeTrustedDeviceCount(household);
      const targetActiveDevices = [...this.devices.values()].filter(
        (device) =>
          device.householdId === household.id &&
          device.memberId === pairing.memberId &&
          !device.revokedAt,
      ).length;
      const postRecoveryDevices =
        pairing.purpose === "device"
          ? activeDevices + 1
          : pairing.purpose === "replacement"
            ? activeDevices
            : activeDevices - targetActiveDevices + 1;
      if (postRecoveryDevices > MAX_TRUSTED_DEVICES)
        throw new PairingError(
          "device_limit",
          "This household reached its trusted-device limit.",
          409,
        );
      if (
        !existingMember?.active ||
        existingMember.householdId !== household.id
      )
        throw new PairingError(
          "membership_removed",
          "This household membership is no longer active.",
          403,
        );
      const deviceId = pairing.claimant.deviceId;
      if (pairing.purpose === "replacement") {
        const lostDevice = this.devices.get(pairing.lostDeviceId);
        if (
          !lostDevice ||
          lostDevice.householdId !== household.id ||
          lostDevice.memberId !== existingMember.id ||
          lostDevice.revokedAt
        )
          throw new PairingError(
            "replacement_stale",
            "The device replacement changed. Start recovery again.",
            409,
          );
        lostDevice.revokedAt = this.now();
        if (lostDevice.tokenHash)
          this.deviceTokens.delete(lostDevice.tokenHash);
        for (const [sessionHash, activeSession] of this.sessions)
          if (activeSession.deviceId === lostDevice.id)
            this.sessions.delete(sessionHash);
        this.audit("device_revoked", {
          householdId: household.id,
          memberId: existingMember.id,
          deviceId: lostDevice.id,
          reason: "replacement",
        });
      }
      if (pairing.purpose === "member-recovery") {
        for (const oldDevice of this.devices.values())
          if (oldDevice.memberId === existingMember.id && !oldDevice.revokedAt) {
            oldDevice.revokedAt = this.now();
            if (oldDevice.tokenHash)
              this.deviceTokens.delete(oldDevice.tokenHash);
            this.audit("device_revoked", {
              householdId: household.id,
              memberId: existingMember.id,
              deviceId: oldDevice.id,
              reason: "member_recovery",
            });
          }
        for (const [sessionHash, activeSession] of this.sessions)
          if (activeSession.memberId === existingMember.id)
            this.sessions.delete(sessionHash);
        for (const credentialId of existingMember.credentials)
          this.credentials.delete(credentialId);
        existingMember.credentials.clear();
      }
      this.addCredential(existingMember.id, pairing.claimant.credential);
      existingMember.credentials.add(pairing.claimant.credential.id);
      this.devices.set(deviceId, {
        id: deviceId,
        memberId: existingMember.id,
        householdId: household.id,
        label: pairing.claimant.deviceLabel,
        trustedAt: this.now(),
        revokedAt: null,
        tokenHash: pairing.claimant.deviceTokenHash,
        ...(pairing.claimant.syncPublicKeys
          ? {
              syncPublicKeys: pairing.claimant.syncPublicKeys,
              syncKeyFingerprint: pairing.claimant.syncKeyFingerprint,
              deviceAuthorizationCertificate,
            }
          : {}),
      });
      this.deviceTokens.set(pairing.claimant.deviceTokenHash, deviceId);
      household.version += 1;
      pairing.confirmedMemberId = existingMember.id;
      pairing.confirmedDeviceId = deviceId;
      pairing.state = "Confirmed";
      pairing.terminalAt = this.now();
      pairing.expiresAt = this.now() + CLAIM_TTL_MS;
      pairing.version += 1;
      this.codeIndex.delete(pairing.verifier);
      this.audit("device_pairing_confirmed", {
        householdId: household.id,
        pairingId,
        memberId: existingMember.id,
        deviceId,
      });
      this.audit("device_trusted", {
        householdId: household.id,
        memberId: existingMember.id,
        deviceId,
      });
      if (pairing.purpose === "replacement")
        this.audit("device_replacement_completed", {
          householdId: household.id,
          pairingId,
          memberId: existingMember.id,
          lostDeviceId: pairing.lostDeviceId,
          deviceId,
        });
      if (pairing.purpose === "member-recovery")
        this.audit("member_recovery_completed", {
          householdId: household.id,
          pairingId,
          approverMemberId: pairing.inviterId,
          memberId: existingMember.id,
          deviceId,
        });
      this.persistHousehold(household.id);
      return this.pairingView(pairing);
    }
    if (this.activeMemberCount(household) >= MAX_ACTIVE_MEMBERS)
      throw new PairingError(
        "household_full",
        "This household has reached its four-adult limit.",
        409,
      );
    if (this.activeTrustedDeviceCount(household) >= MAX_TRUSTED_DEVICES)
      throw new PairingError(
        "device_limit",
        "This household reached its trusted-device limit.",
        409,
      );
    const memberId = pairing.claimant.memberId;
    const deviceId = pairing.claimant.deviceId;
    this.addCredential(memberId, pairing.claimant.credential);
    this.members.set(memberId, {
      id: memberId,
      householdId: household.id,
      active: true,
      kind: "adult",
      credentials: new Set([pairing.claimant.credential.id]),
    });
    this.devices.set(deviceId, {
      id: deviceId,
      memberId,
      householdId: household.id,
      label: pairing.claimant.deviceLabel,
      trustedAt: this.now(),
      revokedAt: null,
      tokenHash: pairing.claimant.deviceTokenHash,
      ...(pairing.claimant.syncPublicKeys
        ? {
            syncPublicKeys: pairing.claimant.syncPublicKeys,
            syncKeyFingerprint: pairing.claimant.syncKeyFingerprint,
            deviceAuthorizationCertificate,
          }
        : {}),
    });
    this.deviceTokens.set(pairing.claimant.deviceTokenHash, deviceId);
    household.members.add(memberId);
    household.version += 1;
    pairing.confirmedMemberId = memberId;
    pairing.confirmedDeviceId = deviceId;
    pairing.state = "Confirmed";
    pairing.terminalAt = this.now();
    pairing.expiresAt = this.now() + CLAIM_TTL_MS;
    pairing.version += 1;
    this.codeIndex.delete(pairing.verifier);
    this.audit("pairing_confirmed", {
      householdId: household.id,
      pairingId,
      memberId,
      deviceId,
    });
    this.audit("device_trusted", {
      householdId: household.id,
      memberId,
      deviceId,
    });
    this.persistHousehold(household.id);
    return this.pairingView(pairing);
  }

  revokePairing(sessionToken, pairingId) {
    const { household } = this.authorize(sessionToken);
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.householdId !== household.id)
      throw new PairingError(
        "not_found",
        "That pairing request is unavailable.",
        404,
      );
    const state = this.state(pairing);
    if (state === "Revoked") return this.pairingView(pairing);
    if (!["Pending", "Claimed"].includes(state))
      throw terminalPairingError(state);
    pairing.state = "Revoked";
    pairing.terminalAt = this.now();
    pairing.version += 1;
    this.codeIndex.delete(pairing.verifier);
    this.audit("pairing_revoked", { householdId: household.id, pairingId });
    return this.pairingView(pairing);
  }

  pairingForAdult(sessionToken, pairingId) {
    const { household } = this.authorize(sessionToken);
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.householdId !== household.id)
      throw new PairingError(
        "not_found",
        "That pairing request is unavailable.",
        404,
      );
    return this.pairingView(pairing);
  }

  pairingForClaim(claimToken) {
    const claimHash = hash(String(claimToken ?? ""));
    const pairing = this.pairings.get(this.claimTokens.get(claimHash));
    if (!pairing)
      throw new PairingError(
        "claim_unavailable",
        "This pairing request is unavailable.",
        404,
      );
    if (pairing.state === "Confirmed" && pairing.expiresAt <= this.now()) {
      this.claimTokens.delete(claimHash);
      this.prunePairingCapabilities();
      throw new PairingError(
        "claim_unavailable",
        "This pairing request is unavailable.",
        404,
      );
    }
    const view = this.pairingView(pairing);
    if (["Expired", "Revoked"].includes(view.state))
      this.claimTokens.delete(claimHash);
    this.prunePairingCapabilities();
    return view;
  }

  clearClaim(claimToken) {
    this.claimTokens.delete(hash(String(claimToken ?? "")));
  }

  claimCredential(claimToken) {
    this.prunePairingCapabilities();
    const pairing = this.pairings.get(
      this.claimTokens.get(hash(String(claimToken ?? ""))),
    );
    if (!pairing || this.state(pairing) !== "Confirmed")
      throw new PairingError(
        "claim_not_confirmed",
        "Approval is still required.",
        409,
      );
    return this.credentials.get(pairing.claimant.credential.id);
  }

  activateClaim(claimToken) {
    this.prunePairingCapabilities();
    const pairing = this.pairings.get(
      this.claimTokens.get(hash(String(claimToken ?? ""))),
    );
    if (!pairing || this.state(pairing) !== "Confirmed")
      throw new PairingError(
        "claim_not_confirmed",
        "Approval is still required.",
        409,
      );
    this.claimTokens.delete(pairing.claimant.tokenHash);
    const device = this.devices.get(pairing.confirmedDeviceId);
    const result = {
      ...this.issueSession(
        pairing.confirmedMemberId,
        pairing.confirmedDeviceId,
      ),
      deviceToken: pairing.claimant.deviceToken,
      householdId: pairing.householdId,
      memberId: pairing.confirmedMemberId,
      deviceId: pairing.confirmedDeviceId,
    };
    this.persistHousehold(pairing.householdId);
    return result;
  }

  logout(sessionToken) {
    this.sessions.delete(hash(String(sessionToken ?? "")));
  }

  prunePairingCapabilities(now = this.now()) {
    for (const pairing of this.pairings.values()) this.state(pairing);
    for (const [claimHash, pairingId] of this.claimTokens) {
      const pairing = this.pairings.get(pairingId);
      if (
        !pairing ||
        ["Expired", "Revoked"].includes(this.state(pairing)) ||
        (pairing.state === "Confirmed" && pairing.expiresAt <= now)
      )
        this.claimTokens.delete(claimHash);
    }
    const claimedPairings = new Set(this.claimTokens.values());
    for (const [pairingId, pairing] of this.pairings)
      if (
        pairing.terminalAt != null &&
        pairing.terminalAt + TERMINAL_PAIRING_RETENTION_MS <= now &&
        !claimedPairings.has(pairingId)
      )
        this.pairings.delete(pairingId);
  }

  pairingView(pairing) {
    return {
      pairingId: pairing.id,
      purpose: pairing.purpose ?? "adult",
      inviterDeviceId: pairing.inviterDeviceId,
      inviterKeyFingerprint: pairing.inviterKeyFingerprint,
      state: this.state(pairing),
      expiresAt: pairing.expiresAt,
      version: pairing.version,
      deviceLabel:
        pairing.state === "Claimed" ? pairing.claimant.deviceLabel : undefined,
      syncKeyFingerprint:
        pairing.state === "Claimed" || pairing.state === "Confirmed"
          ? pairing.claimant?.syncKeyFingerprint
          : undefined,
      syncPublicKeys:
        pairing.state === "Claimed" || pairing.state === "Confirmed"
          ? pairing.claimant?.syncPublicKeys
          : undefined,
      memberId: pairing.claimant?.memberId,
      deviceId: pairing.claimant?.deviceId,
      confirmedMemberId: pairing.confirmedMemberId,
      confirmedDeviceId: pairing.confirmedDeviceId,
      lostDeviceId: pairing.lostDeviceId,
    };
  }

  listDevices(sessionToken) {
    const { household } = this.authorize(sessionToken);
    return [...this.devices.values()]
      .filter((device) => device.householdId === household.id)
      .map(
        ({
          id,
          memberId,
          label,
          trustedAt,
          revokedAt,
          syncKeyFingerprint,
        }) => ({
          id,
          memberId,
          label,
          trustedAt,
          revokedAt,
          syncKeyFingerprint,
        }),
      );
  }

  registerSyncPublicKeys(sessionToken, syncPublicKeys) {
    const { device } = this.authorize(sessionToken);
    const keyRecord = validateSyncPublicKeys(syncPublicKeys);
    if (device.syncPublicKeys) {
      if (device.syncKeyFingerprint !== keyRecord.syncKeyFingerprint)
        throw new PairingError(
          "sync_device_key_conflict",
          "This trusted device already has different sync keys.",
          409,
        );
      return { fingerprint: device.syncKeyFingerprint, registered: false };
    }
    Object.assign(device, keyRecord);
    this.persistHousehold(device.householdId);
    return { fingerprint: device.syncKeyFingerprint, registered: true };
  }

  transitionSyncPublicKeys(sessionToken, transition) {
    const { device, member, household } = this.authorize(sessionToken);
    const fail = () => { throw new PairingError("device_transition_invalid", "Kin could not verify this device key transition.", 409); };
    const t = transition;
    if (!t || t.version !== 1 || t.purpose !== "kin.sync.device-key-successor.v1" ||
        t.householdId !== household.id || t.memberId !== member.id || t.deviceId !== device.id ||
        !Number.isSafeInteger(t.generation) || t.generation < 1 || t.generation > 16 ||
        !/^[a-f0-9]{32}$/.test(t.transitionId) || !/^[A-Za-z0-9_-]{86}$/.test(t.signature) ||
        Buffer.from(t.signature, "base64url").toString("base64url") !== t.signature) fail();
    const transitions = device.syncKeyTransitions ?? [];
    const existing = transitions.find(value => value.transitionId === t.transitionId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(t)) fail();
      return { fingerprint: device.syncKeyFingerprint, generation: device.syncKeyGeneration, retried: true };
    }
    if (t.generation !== (device.syncKeyGeneration ?? 0) + 1 ||
        t.oldFingerprint !== device.syncKeyFingerprint || t.fingerprint === t.oldFingerprint) fail();
    const next = validateSyncPublicKeys(t.publicKeys);
    if (next.syncKeyFingerprint !== t.fingerprint) fail();
    const { signature, ...unsigned } = t;
    try {
      if (!verifySignature("sha256", Buffer.from(canonicalJson(unsigned)), {
        key: createPublicKey({ key: device.syncPublicKeys.signing, format: "jwk" }), dsaEncoding: "ieee-p1363",
      }, Buffer.from(signature, "base64url"))) fail();
    } catch { fail(); }
    device.syncKeyHistory ??= [{ publicKeys: structuredClone(device.syncPublicKeys), fingerprint: device.syncKeyFingerprint, generation: 0 }];
    device.syncKeyHistory.push({ publicKeys: structuredClone(t.publicKeys), fingerprint: t.fingerprint, generation: t.generation });
    device.syncKeyTransitions = [...transitions, structuredClone(t)];
    device.syncKeyGeneration = t.generation;
    Object.assign(device, next);
    this.persistHousehold(household.id);
    return { fingerprint: device.syncKeyFingerprint, generation: t.generation, retried: false };
  }

  householdView(sessionToken) {
    const { member, household } = this.authorize(sessionToken);
    return {
      householdId: household.id,
      currentMemberId: member.id,
      members: [...household.members].map((memberId) => ({
        id: memberId,
        current: memberId === member.id,
        active: canParticipate(this.members.get(memberId), this.now()),
      })),
    };
  }

  leaveHousehold(sessionToken, reauthenticatedMemberId) {
    const { member, household } = this.authorize(sessionToken);
    if (reauthenticatedMemberId !== member.id)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before leaving the household.",
        401,
      );
    if (!canParticipate(member))
      throw new PairingError(
        "membership_not_active",
        "This household member is no longer active.",
        403,
      );
    const hasTrustedAdult = [...household.members].some((memberId) => {
      if (memberId === member.id) return false;
      const other = this.members.get(memberId);
      return other?.active && canManageTrust(other, this.now());
    });
    if (!hasTrustedAdult)
      throw new PairingError(
        "last_adult",
        "The only active trusted adult cannot leave. Household deletion and recovery are not available.",
        409,
      );
    return this.removeMembership(household, member.id, member.id);
  }

  removalContext(sessionToken, memberId, { allowSelf = false } = {}) {
    const { member, household, device } = this.authorize(sessionToken);
    requireTrustAuthority(member, "remove a household member");
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
  }

  removeOtherAdult(sessionToken, memberId, reauthenticatedMemberId) {
    const context = this.removalContext(sessionToken, memberId);
    if (reauthenticatedMemberId !== context.memberId)
      throw new PairingError(
        "fresh_auth_required",
        "Authenticate with your passkey again before removing a household adult.",
        401,
      );
    const household = this.households.get(
      this.members.get(context.memberId).householdId,
    );
    return this.removeMembership(household, memberId, context.memberId);
  }

  removeMembership(household, memberId, actorId) {
    const target = this.members.get(memberId);
    // An invitation is bound to its author. Once that member loses authority,
    // pending claims must not remain stranded or become approvable later.
    for (const pairing of this.pairings.values()) {
      if (
        pairing.householdId !== household.id ||
        pairing.inviterId !== memberId ||
        !["Pending", "Claimed"].includes(this.state(pairing))
      ) continue;
      pairing.state = "Revoked";
      pairing.terminalAt = this.now();
      pairing.version += 1;
      this.codeIndex.delete(pairing.verifier);
      for (const [claimHash, storedPairingId] of this.claimTokens)
        if (storedPairingId === pairing.id) this.claimTokens.delete(claimHash);
      this.audit("pairing_revoked", {
        householdId: household.id,
        pairingId: pairing.id,
        reason: "inviter_removed",
      });
    }
    target.active = false;
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
  }

  revokeDevice(sessionToken, deviceId) {
    const { member, household, device: actingDevice } = this.authorize(sessionToken);
    requireTrustAuthority(member, "revoke a trusted device");
    const device = this.devices.get(deviceId);
    if (!device || device.householdId !== household.id)
      throw new PairingError("not_found", "That device is unavailable.", 404);
    if (device.id === actingDevice.id)
      throw new PairingError(
        "current_device",
        "Use another trusted device to revoke this device.",
        409,
      );
    if (!device.revokedAt) {
      device.revokedAt = this.now();
      this.audit("device_revoked", {
        householdId: household.id,
        memberId: device.memberId,
        deviceId,
      });
    }
    for (const [sessionHash, activeSession] of this.sessions)
      if (activeSession.deviceId === device.id)
        this.sessions.delete(sessionHash);
    this.persistHousehold(household.id);
    return { id: device.id, revokedAt: device.revokedAt };
  }
}

function validateSyncPublicKeys(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 2 ||
    !value.agreement ||
    !value.signing
  ) {
    throw new PairingError(
      "sync_device_key_invalid",
      "Kin could not verify this device's public keys.",
      400,
    );
  }
  try {
    for (const [name, key] of Object.entries(value)) {
      if (
        key.kty !== "EC" ||
        key.crv !== "P-256" ||
        typeof key.x !== "string" ||
        typeof key.y !== "string" ||
        "d" in key
      )
        throw new Error("invalid public key");
      if (createPublicKey({ key, format: "jwk" }).asymmetricKeyType !== "ec")
        throw new Error("invalid public key type");
      if (
        name === "signing" &&
        (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))
      )
        throw new Error("invalid signing usages");
    }
    const syncPublicKeys = structuredClone(value);
    return {
      syncPublicKeys,
      syncKeyFingerprint: createHash("sha256")
        .update(canonicalJson(syncPublicKeys))
        .digest("hex"),
    };
  } catch {
    throw new PairingError(
      "sync_device_key_invalid",
      "Kin could not verify this device's public keys.",
      400,
    );
  }
}

function validateDeviceAuthorizationCertificate(certificate, expected) {
  try {
    if (
      !certificate ||
      certificate.version !== 1 ||
      certificate.householdId !== expected.householdId ||
      certificate.memberId !== expected.memberId ||
      certificate.deviceId !== expected.deviceId ||
      certificate.issuerDeviceId !== expected.approverDevice.id ||
      certificate.issuerFingerprint !==
        expected.approverDevice.syncKeyFingerprint ||
      certificate.fingerprint !== expected.claimantFingerprint ||
      canonicalJson(certificate.publicKeys) !==
        canonicalJson(expected.claimantPublicKeys) ||
      !/^[A-Za-z0-9_-]{86}$/.test(certificate.signature)
    )
      throw new Error("certificate fields do not match the pending enrollment");
    const { signature, ...unsigned } = certificate;
    const valid = verifySignature(
      "sha256",
      Buffer.from(canonicalJson(unsigned)),
      {
        key: createPublicKey({
          key: expected.approverDevice.syncPublicKeys.signing,
          format: "jwk",
        }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    );
    if (!valid) throw new Error("certificate signature is invalid");
    return structuredClone(certificate);
  } catch {
    throw new PairingError(
      "device_certificate_invalid",
      "Kin could not verify this device approval.",
      400,
    );
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function cleanLabel(value) {
  const label = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!label || label.length > 48)
    throw new PairingError(
      "invalid_device_label",
      "Enter a device name of 1 to 48 characters.",
    );
  return label;
}

function genericCodeError() {
  return new PairingError(
    "invalid_code",
    "That code is invalid, expired, or unavailable.",
    404,
  );
}
function terminalPairingError(state) {
  const values = {
    Expired: [
      "pairing_expired",
      "This pairing code expired. Ask for a new code.",
      410,
    ],
    Revoked: ["pairing_revoked", "This pairing request was revoked.", 410],
    Confirmed: [
      "pairing_used",
      "This pairing code has already been used.",
      409,
    ],
    Claimed: [
      "pairing_claimed",
      "This pairing code has already been claimed.",
      409,
    ],
    Pending: [
      "pairing_not_claimed",
      "The invited adult has not claimed this request yet.",
      409,
    ],
  };
  return new PairingError(
    ...(values[state] ?? [
      "invalid_state",
      "That pairing request is unavailable.",
      409,
    ]),
  );
}
