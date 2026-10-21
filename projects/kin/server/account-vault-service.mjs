// Members' encrypted key vaults on the service (ADR 0018, #564/#566).
//
// A vault is ciphertext the member's own device made (web/security/
// account-vault.js); the service never holds the vault key, a password, a
// passkey's PRF output or a backup code. It keeps, per member, the sealed
// vault with a version that only grows, and up to eight wrappers that each
// hold the vault key under one way of opening it. It enforces who may read
// and write them, their sizes, compare-and-set on versions, and that a vault
// always keeps at least one wrapper.
//
// Who may: only the member themselves, from a signed-in session on one of
// their trusted devices (the same authorization as sync; a removed member,
// a revoked device or no session is refused). Every route addresses the
// session's own member, so no request can name another member's vault.
// Downloads are also rate-limited per member and per client address: a
// sign-in without a trusted device (#568) also downloads, behind a
// new-device capability (downloadWithCapability), and a download is what an
// offline guesser wants, so it's bounded.
//
// Failed unlocks are never reported to the service (it can't see them); a
// device counts its own.
import { DeviceWindow } from "./chat-limits.mjs";
import {
  ACCOUNT_VAULT_WRAPPED_KEY_BYTES,
  ACCOUNT_VAULT_WRAPPER_TYPES,
  DurableConflictError,
  MAX_ACCOUNT_VAULT_BYTES,
  MAX_ACCOUNT_VAULT_WRAPPERS,
  MAX_ACCOUNT_VAULT_WRAPPER_PARAMS_BYTES,
  MIN_ACCOUNT_PASSWORD_ITERATIONS,
  MIN_ACCOUNT_VAULT_BYTES,
} from "./durable-store.mjs";
import { PairingError } from "./pairing-service.mjs";

/** Vault downloads one member may make in a window. Every download is
 * behind a signed-in session or a new-device capability (which has its own
 * limits), so this bounds traffic, not guessing: a sign-up, a second device
 * signing in and both opening private storage use several (#520). */
export const VAULT_DOWNLOADS_PER_MEMBER = 60;
/** Vault downloads from one client address in a window, across members (a
 * household behind one router). */
export const VAULT_DOWNLOADS_PER_ADDRESS = 120;
/** Vault and wrapper writes one member may make in a window. A new epoch
 * writes once per trusted device that notices it; this stops a loop. */
export const VAULT_WRITES_PER_MEMBER = 60;
export const VAULT_WINDOW_MS = 15 * 60_000;

const VAULT_MAGIC = "KVLT";
const ID = /^[a-f0-9]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Storage when the service has no durable store (tests, in-memory mode),
 * with the same decisions as durable-store/account-vault.mjs. */
class MemoryAccountVaultStore {
  constructor() { this.vaults = new Map(); this.passwords = new Map(); }
  accountVault(householdId, memberId) {
    const row = this.vaults.get(memberId);
    if (!row || row.householdId !== householdId) return null;
    return { version: row.version, ciphertext: row.ciphertext.slice(), updatedAt: row.updatedAt,
      wrappers: [...row.wrappers.values()].sort((a, b) => (a.wrapperId < b.wrapperId ? -1 : 1)).map((wrapper) => structuredClone(wrapper)) };
  }
  putAccountVault(householdId, memberId, { expectedVersion, ciphertext, wrappers = [], now }) {
    const row = this.vaults.get(memberId);
    if (row && row.householdId !== householdId) throw new DurableConflictError("vault_version_conflict", "The vault changed on another device meanwhile.");
    if ((row?.version ?? 0) !== expectedVersion) throw new DurableConflictError("vault_version_conflict", "The vault changed on another device meanwhile.");
    const next = row ?? { householdId, wrappers: new Map() };
    next.version = expectedVersion + 1;
    next.ciphertext = ciphertext.slice();
    next.updatedAt = now;
    for (const wrapper of wrappers) next.wrappers.set(wrapper.wrapperId, { ...structuredClone(wrapper), updatedAt: now });
    this.vaults.set(memberId, next);
    return next.version;
  }
  putAccountVaultWrapper(householdId, memberId, wrapper, now) {
    const row = this.vaults.get(memberId);
    if (!row || row.householdId !== householdId) throw new DurableConflictError("vault_not_found", "There is no vault to add this to.");
    const existing = row.wrappers.get(wrapper.wrapperId);
    if (!existing) {
      if (row.wrappers.size >= MAX_ACCOUNT_VAULT_WRAPPERS) throw new DurableConflictError("vault_wrapper_limit", "This vault already has as many ways to open it as Kin allows.");
      if (wrapper.version !== 1) throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
    } else if (existing.type !== wrapper.type || wrapper.version !== existing.version + 1) {
      throw new DurableConflictError("vault_wrapper_conflict", "That way of opening the vault changed meanwhile.");
    }
    row.wrappers.set(wrapper.wrapperId, { ...structuredClone(wrapper), updatedAt: now });
    return { version: wrapper.version, added: !existing };
  }
  removeAccountVaultWrapper(householdId, memberId, wrapperId) {
    const row = this.vaults.get(memberId);
    if (!row || row.householdId !== householdId || !row.wrappers.has(wrapperId))
      throw new DurableConflictError("vault_wrapper_not_found", "That way of opening the vault was not found.");
    if (row.wrappers.size <= 1) throw new DurableConflictError("vault_last_wrapper", "Keep at least one way to open your vault.");
    row.wrappers.delete(wrapperId);
    return row.wrappers.size;
  }
  removeAccountKeys(householdId, memberId) {
    const vault = this.vaults.get(memberId);
    const password = this.passwords.get(memberId);
    let removed = false;
    if (vault?.householdId === householdId) { this.vaults.delete(memberId); removed = true; }
    if (password?.householdId === householdId) { this.passwords.delete(memberId); removed = true; }
    return removed;
  }
  accountPassword(householdId, memberId) {
    const row = this.passwords.get(memberId);
    return row && row.householdId === householdId ? structuredClone(row.value) : null;
  }
  putAccountPassword(householdId, memberId, { salt, iterations, verifier, now }) {
    const row = this.passwords.get(memberId);
    if (row && row.householdId !== householdId) return;
    this.passwords.set(memberId, { householdId, value: { salt: salt.slice(), iterations, verifier, updatedAt: now } });
  }
}

/** Errors whose meaning the client acts on, with their HTTP status. */
const CONFLICTS = {
  vault_version_conflict: 409,
  vault_not_found: 404,
  vault_wrapper_conflict: 409,
  vault_wrapper_limit: 409,
  vault_wrapper_not_found: 404,
  vault_last_wrapper: 409,
};

export class AccountVaultService {
  constructor({ store = null, now = () => Date.now() } = {}) {
    this.storage = store ?? new MemoryAccountVaultStore();
    this.now = now;
    this.memberDownloads = new DeviceWindow({ limit: VAULT_DOWNLOADS_PER_MEMBER, windowMs: VAULT_WINDOW_MS, now });
    this.addressDownloads = new DeviceWindow({ limit: VAULT_DOWNLOADS_PER_ADDRESS, windowMs: VAULT_WINDOW_MS, now });
    this.memberWrites = new DeviceWindow({ limit: VAULT_WRITES_PER_MEMBER, windowMs: VAULT_WINDOW_MS, now });
  }

  /**
   * The signed-in member's vault and wrappers: `{ vault, wrappers }`, with
   * `vault` null when the member has none. `auth` comes from a trusted
   * session (PairingService.authorize); `clientKey` is the request's address
   * key (server/client-key.mjs).
   */
  download(auth, clientKey) {
    // Both windows are checked before either is charged, so a refused
    // address doesn't spend the member's allowance (or the reverse).
    if (!this.addressDownloads.allows(`address:${clientKey}`) || !this.memberDownloads.allows(auth.member.id))
      throw rateLimited();
    this.addressDownloads.spend(`address:${clientKey}`);
    this.memberDownloads.spend(auth.member.id);
    return present(this.storage.accountVault(auth.household.id, auth.member.id));
  }

  /**
   * Download for a sign-in on a device with no cookie (ADR 0018 section 4,
   * #568). `capability` is what PairingService.spendNewDeviceDownload
   * returns for a checked, unexpired new-device capability:
   * `{ householdId, memberId, method, credentialId }`. Only the wrappers that
   * sign-in method opens are released (a password sign-in gets the password
   * wrapper; a passkey sign-in the wrapper for the passkey it asserted; both,
   * the password-and-passkey wrapper for that passkey), so a sign-in never
   * hands out more offline-guessing material than it needs. The same member
   * and address limits as `download` apply.
   */
  downloadWithCapability(capability, clientKey) {
    const { householdId, memberId, method, credentialId } = capability ?? {};
    if (!householdId || !memberId || !["password", "passkey", "password-passkey"].includes(method))
      throw new PairingError("new_device_expired", "This sign-in expired or was already used. Sign in again.", 401);
    if (!this.addressDownloads.allows(`address:${clientKey}`) || !this.memberDownloads.allows(memberId))
      throw rateLimited();
    this.addressDownloads.spend(`address:${clientKey}`);
    this.memberDownloads.spend(memberId);
    const row = this.storage.accountVault(householdId, memberId);
    const opens = (wrapper) => wrapper.type === method && (method === "password" || wrapper.params.credentialId === credentialId);
    const wrappers = row?.wrappers.filter(opens) ?? [];
    if (!row || !wrappers.length)
      throw new PairingError("vault_not_found", "Kin couldn't find a way to open your vault with that sign-in.", 404);
    return present({ ...row, wrappers });
  }

  /** The member's wrappers without their wrapped keys (`type`, `params`),
   * or null without a vault: what decides how they may sign in on a new
   * device (pairing-service/new-device.mjs). */
  wrapperSummary(householdId, memberId) {
    const row = this.storage.accountVault(householdId, memberId);
    return row ? row.wrappers.map(({ wrapperId, type, params }) => ({ wrapperId, type, params: structuredClone(params) })) : null;
  }

  /**
   * Stores a new vault version compare-and-set. `body`:
   * `{ expectedVersion, ciphertext, wrappers? }`; `expectedVersion` 0 creates
   * the vault and then needs `wrappers` (1 to 8, each version 1). Returns
   * `{ version }`; 409 `vault_version_conflict` when another device wrote
   * first.
   */
  upload(auth, body) {
    this.spendWrite(auth);
    const expectedVersion = body?.expectedVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw invalid();
    const ciphertext = decodeVault(body.ciphertext);
    let wrappers = [];
    if (expectedVersion === 0) {
      if (!Array.isArray(body.wrappers) || body.wrappers.length < 1 || body.wrappers.length > MAX_ACCOUNT_VAULT_WRAPPERS) throw invalid();
      wrappers = body.wrappers.map((wrapper) => parseWrapper(wrapper));
      if (new Set(wrappers.map((wrapper) => wrapper.wrapperId)).size !== wrappers.length || wrappers.some((wrapper) => wrapper.version !== 1))
        throw invalid();
    } else if (body.wrappers !== undefined) {
      throw invalid();
    }
    const version = this.guard(() => this.storage.putAccountVault(auth.household.id, auth.member.id,
      { expectedVersion, ciphertext, wrappers, now: this.now() }));
    return { version };
  }

  /** Adds (version 1) or replaces (its version plus one) one wrapper. */
  putWrapper(auth, wrapperId, body) {
    this.spendWrite(auth);
    const wrapper = parseWrapper({ ...body, wrapperId });
    return { wrapperId, ...this.guard(() => this.storage.putAccountVaultWrapper(auth.household.id, auth.member.id, wrapper, this.now())) };
  }

  /** Removes one wrapper; the last one can't be removed. */
  removeWrapper(auth, wrapperId) {
    this.spendWrite(auth);
    if (!ID.test(wrapperId ?? "")) throw invalid();
    return { remaining: this.guard(() => this.storage.removeAccountVaultWrapper(auth.household.id, auth.member.id, wrapperId)) };
  }

  /** A removed member's vault, wrappers and password verifier go (the
   * pairing service calls this through onAccountRemoved). */
  removeMember(householdId, memberId) {
    return this.storage.removeAccountKeys(householdId, memberId);
  }

  spendWrite(auth) {
    if (!this.memberWrites.spend(auth.member.id)) throw rateLimited();
  }

  guard(operation) {
    try {
      return operation();
    } catch (error) {
      if (error instanceof DurableConflictError && CONFLICTS[error.code])
        throw new PairingError(error.code, error.message, CONFLICTS[error.code]);
      throw error;
    }
  }
}

function present(row) {
  if (!row) return { vault: null, wrappers: [] };
  return {
    vault: { version: row.version, ciphertext: Buffer.from(row.ciphertext).toString("base64url"), updatedAt: row.updatedAt },
    wrappers: row.wrappers.map((wrapper) => ({
      wrapperId: wrapper.wrapperId, type: wrapper.type, version: wrapper.version, params: wrapper.params,
      wrapped: Buffer.from(wrapper.wrapped).toString("base64url"), updatedAt: wrapper.updatedAt,
    })),
  };
}

/** A sealed vault: canonical base64url of "KVLT" format-1 bytes in bounds.
 * The rest is ciphertext the service can't check. */
function decodeVault(value) {
  const bytes = decodeBase64Url(value, MAX_ACCOUNT_VAULT_BYTES);
  if (!bytes || bytes.length < MIN_ACCOUNT_VAULT_BYTES || bytes.subarray(0, 4).toString("latin1") !== VAULT_MAGIC || bytes[4] !== 1)
    throw invalid();
  return new Uint8Array(bytes);
}

function parseWrapper(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const { wrapperId, type, version, params, wrapped } = value;
  if (!ID.test(wrapperId ?? "") || !ACCOUNT_VAULT_WRAPPER_TYPES.includes(type) || !Number.isSafeInteger(version) || version < 1)
    throw invalid();
  const bytes = decodeBase64Url(wrapped, ACCOUNT_VAULT_WRAPPED_KEY_BYTES);
  if (!bytes || bytes.length !== ACCOUNT_VAULT_WRAPPED_KEY_BYTES || bytes[0] !== 1) throw invalid();
  const checked = parseParams(type, params);
  if (JSON.stringify(checked).length > MAX_ACCOUNT_VAULT_WRAPPER_PARAMS_BYTES) throw invalid();
  return { wrapperId, type, version, params: checked, wrapped: new Uint8Array(bytes) };
}

/**
 * The public parameters a device needs to rebuild a wrapper's KEK, by type:
 * a password wrapper's PBKDF2 salt and iterations; a passkey wrapper's
 * credential ID and PRF salt; both for password-and-passkey; nothing for a
 * backup code. Only these exact fields are kept.
 */
function parseParams(type, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw invalid();
  const result = {};
  const expected = [];
  if (type === "password" || type === "password-passkey") {
    if (params.kdf !== "pbkdf2-sha256" || !Number.isSafeInteger(params.iterations) ||
        params.iterations < MIN_ACCOUNT_PASSWORD_ITERATIONS || params.iterations > 10_000_000 ||
        decodeBase64Url(params.salt, 16)?.length !== 16)
      throw invalid();
    Object.assign(result, { kdf: params.kdf, iterations: params.iterations, salt: params.salt });
    expected.push("kdf", "iterations", "salt");
  }
  if (type === "passkey" || type === "password-passkey") {
    const credential = decodeBase64Url(params.credentialId, 1023);
    if (!credential || credential.length < 16 || decodeBase64Url(params.prfSalt, 32)?.length !== 32) throw invalid();
    Object.assign(result, { credentialId: params.credentialId, prfSalt: params.prfSalt });
    expected.push("credentialId", "prfSalt");
  }
  if (Object.keys(params).some((key) => !expected.includes(key))) throw invalid();
  return result;
}

/** Canonical unpadded base64url of at most `maximum` bytes, or null. */
function decodeBase64Url(value, maximum) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum * 4 / 3) || !BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value && bytes.length <= maximum ? bytes : null;
}

const invalid = () => new PairingError("vault_invalid", "That vault change is invalid.", 400);
const rateLimited = () => new PairingError("vault_rate_limited", "Too many vault requests. Wait a few minutes and try again.", 429);
