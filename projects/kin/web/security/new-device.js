// Signing in on a new device (ADR 0018 section 4, #568/#569): the steps
// between a typed username and password (or a passkey) and an opened account
// vault, with no UI and no local storage of their own. The security panel's
// sign-in screens (components/security/sign-in.js) call these; the household
// panel then provisions the device (components/household/account.js).
//
//   username --parameters--> salt, iterations --PBKDF2+HKDF--> authKey, passwordKey
//   authKey --/api/account/sign-in/password--> new-device capability (cookie)
//   [passkey --WebAuthn with PRF--> capability, or completes require-both]
//   capability --/api/account/sign-in/vault--> sealed vault + the one wrapper
//   wrapper + passwordKey / PRF output --> vault key VK --> vault contents
//
// Which wrapper opens the vault follows how the person signed in:
//   password          the "password" wrapper, KEK = passwordKey
//   passkey           the "passkey" wrapper for that passkey, KEK = HKDF(PRF)
//   password-passkey  the "password-passkey" wrapper, KEK = HKDF(PRF || passwordKey)
// The service releases only that wrapper (account-vault-service.mjs).
import {
  combinedKek,
  derivePasswordKeys,
  openVault,
  passkeyKek,
  unwrapVaultKey,
  wipeVaultContents,
} from "./account-vault.js";
import { normalizeUsername, usernameProblem } from "./account-credentials.js";
import { fromBase64Url, toBase64Url, VaultError } from "./local-vault.js";

export const SIGN_IN_METHODS = Object.freeze(["password", "passkey", "password-passkey"]);

/** Posts JSON; resolves the parsed body or throws an Error with `code`. */
export async function signInRequest(path, body = {}, { method = "POST", signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, cache: "no-store", signal, headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new VaultError("Kin can't reach your household service right now. Check your connection and try again.", "connection_unavailable", error);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.message ?? "Kin couldn't sign in. Try again.");
    error.code = value.error ?? "sign_in_failed";
    error.userMessage = error.message;
    throw error;
  }
  return value;
}

/**
 * Signs in with a username and password. Resolves to
 * `{ view, passwordKey, salt, iterations, username }`: the capability's view
 * (what the service sent), and the password's keys, which the caller zeroes.
 * When the view says `needsPasskey`, the passkey step follows.
 */
export async function signInWithPassword({ username, password, request = signInRequest }) {
  const name = normalizeUsername(username);
  if (!name) throw new VaultError(usernameProblem(username), "username_invalid");
  if (typeof password !== "string" || !password) throw new VaultError("Enter your password.", "password_rejected");
  const parameters = await request("/api/account/sign-in/parameters", { username: name });
  const salt = fromBase64Url(parameters.salt);
  const { authKey, passwordKey } = await derivePasswordKeys(password, salt, { iterations: parameters.iterations });
  try {
    const view = await request("/api/account/sign-in/password", { username: name, authKey: toBase64Url(authKey) });
    return { view, passwordKey, salt, iterations: parameters.iterations, username: name };
  } catch (error) {
    passwordKey.fill(0);
    throw error;
  } finally {
    authKey.fill(0);
  }
}

/**
 * The WebAuthn request for a passkey sign-in from the service's options:
 * the challenge and allowed credentials as bytes, user verification
 * required, and each credential's PRF input for its vault wrapper.
 */
export function passkeyRequestOptions(started) {
  const evalByCredential = {};
  for (const [id, salt] of Object.entries(started.prfSalts ?? {})) evalByCredential[id] = { first: fromBase64Url(salt) };
  return {
    ...started.publicKey,
    challenge: fromBase64Url(started.publicKey.challenge),
    userVerification: "required",
    allowCredentials: (started.publicKey.allowCredentials ?? []).map((credential) => ({ ...credential, type: "public-key", id: fromBase64Url(credential.id) })),
    extensions: { prf: { evalByCredential } },
  };
}

/**
 * Signs in with a passkey (alone, or as the second step after the password
 * when the member requires both). Resolves to `{ view, prfOutput,
 * credentialId }`; the caller zeroes prfOutput.
 */
export async function signInWithPasskey({ username = "", signal, request = signInRequest, credentials = globalThis.navigator?.credentials } = {}) {
  if (!globalThis.PublicKeyCredential || !credentials?.get)
    throw new VaultError("Passkeys aren't available in this browser. Sign in with your password.", "unsupported_unlock");
  const started = await request("/api/account/sign-in/passkey/options", { username: normalizeUsername(username) ?? "" });
  const credential = await credentials.get({ publicKey: passkeyRequestOptions(started), signal });
  if (!credential) throw new VaultError("Passkey sign-in was cancelled.", "authentication_failed");
  const result = credential.getClientExtensionResults?.()?.prf?.results?.first;
  if (!result || result.byteLength !== 32)
    throw new VaultError("This passkey can't open your account on a new device. Sign in with your password.", "unsupported_unlock");
  const prfOutput = new Uint8Array(result).slice();
  try {
    const view = await request("/api/account/sign-in/passkey/finish", { flow: started.flow, credential: {
      id: credential.id, type: credential.type, response: {
        clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
        authenticatorData: toBase64Url(new Uint8Array(credential.response.authenticatorData)),
        signature: toBase64Url(new Uint8Array(credential.response.signature)),
        userHandle: credential.response.userHandle ? toBase64Url(new Uint8Array(credential.response.userHandle)) : null,
      },
    } });
    return { view, prfOutput, credentialId: credential.id };
  } catch (error) {
    prfOutput.fill(0);
    throw error;
  } finally {
    new Uint8Array(result).fill(0);
  }
}

/** The vault and wrapper the capability releases, as bytes:
 * `{ vault: { version, ciphertext }, wrappers, certificationEndorsement }`. */
export async function downloadSignInVault({ request = signInRequest } = {}) {
  const value = await request("/api/account/sign-in/vault", {});
  if (!value.vault) throw new VaultError("Your account's vault wasn't found.", "vault_not_found");
  return {
    vault: { version: value.vault.version, ciphertext: fromBase64Url(value.vault.ciphertext) },
    wrappers: (value.wrappers ?? []).map((wrapper) => ({ ...wrapper, wrapped: fromBase64Url(wrapper.wrapped) })),
    certificationEndorsement: value.certificationEndorsement ?? null,
  };
}

/**
 * The wrapper a sign-in `method` opens among `wrappers`, or null: a password
 * wrapper for a password; for a passkey (or both), the wrapper of that type
 * whose passkey is `credentialId`.
 */
export function selectVaultWrapper(wrappers, { method, credentialId = null }) {
  if (!SIGN_IN_METHODS.includes(method)) return null;
  return (wrappers ?? []).find((wrapper) => wrapper?.type === method &&
    (method === "password" || wrapper.params?.credentialId === credentialId)) ?? null;
}

/** The KEK for `wrapper` from what the person gave: a fresh 32-byte array
 * the caller zeroes. */
export async function signInKek(wrapper, { passwordKey = null, prfOutput = null }) {
  if (wrapper?.type === "password") {
    if (!(passwordKey instanceof Uint8Array)) throw new VaultError("Enter your password.", "password_rejected");
    return passwordKey.slice();
  }
  if (wrapper?.type === "passkey") return passkeyKek(prfOutput);
  if (wrapper?.type === "password-passkey") return combinedKek(prfOutput, passwordKey);
  throw new VaultError("Kin couldn't find a way to open your vault with that sign-in.", "wrapper_unavailable");
}

/**
 * Opens the downloaded vault: picks the wrapper for `method`, unwraps VK,
 * opens the sealed contents. Resolves to `{ vaultKey, contents, version }`;
 * the caller keeps VK on the device and zeroes both when done. A wrong key
 * is `vault_unlock_failed`.
 */
export async function openSignInVault({ download, method, credentialId = null, passwordKey = null, prfOutput = null, householdId, memberId }) {
  const wrapper = selectVaultWrapper(download.wrappers, { method, credentialId });
  if (!wrapper) throw new VaultError("Kin couldn't find a way to open your vault with that sign-in.", "wrapper_unavailable");
  const kek = await signInKek(wrapper, { passwordKey, prfOutput });
  let vaultKey;
  try {
    vaultKey = await unwrapVaultKey(wrapper.wrapped, kek, { householdId, memberId, type: wrapper.type, wrapperId: wrapper.wrapperId, version: wrapper.version });
    const contents = await openVault(vaultKey, download.vault.ciphertext, { householdId, memberId, version: download.vault.version });
    return { vaultKey, contents, version: download.vault.version, wrapper };
  } catch (error) {
    vaultKey?.fill(0);
    throw error;
  } finally {
    kek.fill(0);
  }
}

/** Zeroes an opened sign-in's secrets. */
export function wipeSignIn(opened) {
  opened?.vaultKey?.fill?.(0);
  wipeVaultContents(opened?.contents);
  opened?.passwordKey?.fill?.(0);
  opened?.prfOutput?.fill?.(0);
}

/**
 * Whether the device choice can go ahead, in plain words, or null. `view`
 * is the capability's view; `replaceDeviceId` is null for a new device. A
 * new device needs room under the household's trusted-device limit; a
 * replacement frees its own place first (RECOVERY).
 */
export function deviceChoiceProblem(view, replaceDeviceId = null) {
  if (replaceDeviceId !== null) {
    return (view?.devices ?? []).some((device) => device.deviceId === replaceDeviceId)
      ? null : "Choose one of your devices, or add this as a new device.";
  }
  const { maximum, active } = view?.deviceLimit ?? {};
  return Number.isSafeInteger(maximum) && active >= maximum
    ? `Your household already has ${maximum} trusted devices. Choose a device this one replaces.`
    : null;
}

/** The household epochs the vault holds (what the device declares it took). */
export function vaultHouseholdEpochs(contents) {
  return (contents?.epochs ?? []).filter((entry) => entry.family === "household").map((entry) => entry.epoch);
}
