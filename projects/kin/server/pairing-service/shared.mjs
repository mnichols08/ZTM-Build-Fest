// Pairing service constants, errors, member-kind rules and small helpers
// shared by its modules.
import { createHash, randomBytes } from "node:crypto";

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

export const id = () => randomBytes(16).toString("hex");

export const token = () => randomBytes(32).toString("base64url");

export const hash = (value) => createHash("sha256").update(value).digest("hex");

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

/** What a member may do in the household chat (#123): "write" (read and post),
 * "read", or "none". Adults always write; the admin sets the other two
 * classes. A household that never set a policy lets everyone read and post. */
export const CHAT_ACCESS = Object.freeze(["write", "read", "none"]);
export const DEFAULT_CHAT_POLICY = Object.freeze({ limited: "write", temporary: "write", revision: 0 });

export function chatPolicyOf(household) {
  const policy = household?.chatPolicy;
  return {
    limited: CHAT_ACCESS.includes(policy?.limited) ? policy.limited : "write",
    temporary: CHAT_ACCESS.includes(policy?.temporary) ? policy.temporary : "write",
    revision: Number.isSafeInteger(policy?.revision) && policy.revision >= 0 ? policy.revision : 0,
  };
}

/** Who may use the family fridge (#317, ADR 0011): "write" (draw and hang
 * magnets), "read" (look only) or "none", for Limited and Temporary members.
 * Adults always draw. A household that never set it lets everyone draw. */
export function boardPolicyOf(household) {
  const policy = household?.boardPolicy;
  return {
    limited: CHAT_ACCESS.includes(policy?.limited) ? policy.limited : "write",
    temporary: CHAT_ACCESS.includes(policy?.temporary) ? policy.temporary : "write",
    revision: Number.isSafeInteger(policy?.revision) && policy.revision >= 0 ? policy.revision : 0,
  };
}

export function boardAccess(member, household, now = Date.now()) {
  if (!canParticipate(member, now)) return "none";
  const kind = normalizeMemberKind(member.kind);
  if (kind === "adult") return "write";
  const policy = boardPolicyOf(household);
  return kind === "limited" ? policy.limited : policy.temporary;
}

/** Private storage for Limited members (ADR 0019): on unless a household
 * admin turned it off. Adults always have it; Temporary members never do. */
export function privatePolicyOf(household) {
  const policy = household?.privatePolicy;
  return {
    limited: policy?.limited !== false,
    revision: Number.isSafeInteger(policy?.revision) && policy.revision >= 0 ? policy.revision : 0,
  };
}

/** Whether a member may use their private stream: "write" or "none". The
 * stream is always the member's own; this only says whether they may have
 * one at all. */
export function privateAccess(member, household, now = Date.now()) {
  if (!canParticipate(member, now)) return "none";
  const kind = normalizeMemberKind(member.kind);
  if (kind === "adult") return "write";
  if (kind === "limited") return privatePolicyOf(household).limited ? "write" : "none";
  return "none";
}

export function chatAccess(member, household, now = Date.now()) {
  if (!canParticipate(member, now)) return "none";
  const kind = normalizeMemberKind(member.kind);
  if (kind === "adult") return "write";
  const policy = chatPolicyOf(household);
  return kind === "limited" ? policy.limited : policy.temporary;
}

export function requireTrustAuthority(member, action = "manage trust", now = Date.now()) {
  if (!canManageTrust(member, now))
    throw new PairingError(
      "adult_required",
      `Only adults can ${action}.`,
      403,
    );
}

// Household administration is a server-recorded flag on an active Adult.
// Clients never assert it; it is granted at bootstrap or by another admin.
export function isHouseholdAdmin(member, now = Date.now()) {
  return canManageTrust(member, now) && member.householdAdmin === true;
}

export function requireHouseholdAdmin(member, action = "manage the household", now = Date.now()) {
  requireTrustAuthority(member, action, now);
  if (!isHouseholdAdmin(member, now))
    throw new PairingError(
      "household_admin_required",
      `Only household admins can ${action}.`,
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

export function codeValue() {
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

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

// A device label is only ever an automatic name (device-label.mjs).
export { deviceLabel as cleanLabel } from "./device-label.mjs";

export function genericCodeError() {
  return new PairingError(
    "invalid_code",
    "That code is invalid, expired, or unavailable.",
    404,
  );
}

export function terminalPairingError(state) {
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
