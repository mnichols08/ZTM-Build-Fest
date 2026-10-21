// PairingService, a signed-in member's own account security (ADR 0018,
// #560/#571): adding a passkey to a password account, changing the
// password, and what the security settings show. The vault wrappers that go
// with each change live in account-vault-service.mjs; the routes
// (server.mjs) apply both in one transaction where they belong together.
//
// Every change here needs the member's current password, fresh (the
// password limits apply, passwords.mjs): a session alone, say from a
// browser left signed in, can't add a passkey or change the password.
import { hashAuthKey } from "../account-password.mjs";
import { decodeAuthKey, PASSWORD_ITERATIONS_MIN } from "./passwords.mjs";
import { PairingError } from "./shared.mjs";

const PASSWORD_ITERATIONS_MAX = 10_000_000;
const passwordFailed = () => new PairingError("password_incorrect", "That password didn't match. Check it and try again.", 401);

export const accountMethods = {
  /**
   * The new password parameters from a request body (`{ salt, iterations,
   * authKey }`, base64url), hashed: `{ salt, iterations, verifier,
   * updatedAt }`. Async (Argon2id). The username doesn't change.
   */
  async preparePasswordChange(body) {
    const authKey = decodeAuthKey(body?.authKey);
    const salt = typeof body?.salt === "string" && /^[A-Za-z0-9_-]{22}$/.test(body.salt) ? Buffer.from(body.salt, "base64url") : null;
    const iterations = body?.iterations;
    if (!authKey || salt?.length !== 16 || salt.toString("base64url") !== body.salt ||
        !Number.isSafeInteger(iterations) || iterations < PASSWORD_ITERATIONS_MIN || iterations > PASSWORD_ITERATIONS_MAX)
      throw new PairingError("password_invalid", "Kin could not read that password. Try again.", 400);
    try {
      return { salt: new Uint8Array(salt), iterations, verifier: await hashAuthKey(authKey), updatedAt: this.now() };
    } finally {
      authKey.fill(0);
    }
  },

  /** The session's member, who must have a password, and their current
   * password checked fresh (`currentAuthKey`). */
  async confirmAccountPassword(sessionToken, currentAuthKey, rateKey = "unknown") {
    const auth = this.authorize(sessionToken);
    if (!auth.member.password)
      throw new PairingError("password_required", "This account doesn't sign in with a password.", 409);
    if (!(await this.checkPassword(auth.member, currentAuthKey, [`member:${auth.member.id}`, `address:${rateKey}`]))) {
      this.audit("password_confirmation_failed", { householdId: auth.household.id, memberId: auth.member.id });
      throw passwordFailed();
    }
    // The session may have ended during the check.
    return this.authorize(sessionToken);
  },

  /** Replaces the session's member's password with `prepared`
   * (preparePasswordChange). The caller checked the current one. */
  setAccountPassword(auth, prepared) {
    auth.member.password = { ...prepared, username: auth.member.username };
    this.audit("password_changed", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id });
    this.persistHousehold(auth.household.id);
    return { username: auth.member.username, salt: Buffer.from(prepared.salt).toString("base64url"), iterations: prepared.iterations };
  },

  /** Adds a verified passkey `credential` (webauthn.verifyRegistration) to
   * the session's member. From now on their admin-only actions ask for a
   * passkey instead of the password (confirmsWithPassword). */
  addAccountPasskey(auth, credential) {
    this.addCredential(auth.member.id, credential);
    auth.member.credentials.add(credential.id);
    this.audit("passkey_added", { householdId: auth.household.id, memberId: auth.member.id, deviceId: auth.device.id });
    this.persistHousehold(auth.household.id);
    return { credentialId: credential.id };
  },

  /**
   * What the security settings show about the session's member's account:
   * their username, whether they have a password, their passkeys' IDs, and
   * since when they've had a device here (for the calm offers, ADR 0018
   * section 7). `vaultWrappers` is account-vault-service summary(auth).
   */
  accountSecurityView(auth, vaultWrappers) {
    let memberSince = null;
    for (const device of this.devices.values())
      if (device.memberId === auth.member.id && (memberSince === null || device.trustedAt < memberSince)) memberSince = device.trustedAt;
    return {
      username: auth.member.username ?? null,
      password: Boolean(auth.member.password),
      // The current password's public parameters, so a device whose own
      // copy is older (the password changed elsewhere) derives the right keys.
      passwordParameters: this.passwordParameters(auth.member),
      passkeys: [...auth.member.credentials],
      memberSince,
      vault: vaultWrappers ? { wrappers: vaultWrappers } : null,
    };
  },
};
