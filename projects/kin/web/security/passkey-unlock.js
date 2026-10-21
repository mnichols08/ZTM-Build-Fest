import { fromBase64Url, toBase64Url, VaultError } from "./local-vault.js";

export const PASSKEY_UNSUPPORTED_MESSAGE =
  "Secure passkey unlock is unavailable here. Use your backup key.";
export const PASSKEY_OFFLINE_MESSAGE =
  "Kin can't reach your household service to confirm the passkey. Use your backup key while offline; the passkey works again once you're connected.";
export const PASSKEY_NOT_ENROLLED_MESSAGE =
  "This device isn't signed in to a household yet, so it can't confirm a passkey. Use your backup key, then create or join your household.";

// Browser capability only. It never proves that a credential is enrolled or
// that the identity service will accept it.
export function passkeyUnlockSupported() {
  return Boolean(globalThis.PublicKeyCredential && navigator.credentials?.get);
}

async function loginRequest(path, body, signal) {
  try {
    return await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body, cache: "no-store", signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // A network failure is not a credential failure; recovery still works offline.
    throw new VaultError(PASSKEY_OFFLINE_MESSAGE, "connection_unavailable", error);
  }
}

export async function authenticatePrf(wrapper = null, { signal } = {}) {
  if (!passkeyUnlockSupported())
    throw new VaultError(PASSKEY_UNSUPPORTED_MESSAGE, "unsupported_unlock");
  const salt = wrapper ? fromBase64Url(wrapper.prfSalt) : crypto.getRandomValues(new Uint8Array(32));
  const response = await loginRequest("/api/login/options", "{}", signal);
  const started = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 401/403 mean this device holds no trusted-device credential for a household.
    const message = [401, 403].includes(response.status)
      ? PASSKEY_NOT_ENROLLED_MESSAGE
      : "Kin couldn't start passkey unlock right now. Use your backup key.";
    throw new VaultError(message, "credential_unavailable", new Error(started.message ?? `HTTP ${response.status}`));
  }
  const publicKey = {
    ...started.publicKey,
    challenge: fromBase64Url(started.publicKey.challenge),
    userVerification: "required",
    allowCredentials: started.publicKey.allowCredentials.map((credential) => ({ ...credential, id: fromBase64Url(credential.id) })),
    extensions: { prf: { eval: { first: salt } } },
  };
  if (wrapper) {
    publicKey.allowCredentials = publicKey.allowCredentials.filter((credential) => toBase64Url(credential.id) === wrapper.credentialId);
    if (!publicKey.allowCredentials.length)
      throw new VaultError("This passkey is no longer authorized on this device. Use your backup key.", "credential_unavailable");
  }
  const credential = await navigator.credentials.get({ publicKey, signal });
  if (!credential) throw new VaultError("Passkey authentication was cancelled.", "authentication_failed");
  const result = credential.getClientExtensionResults()?.prf?.results?.first;
  if (!result || result.byteLength !== 32)
    throw new VaultError("This passkey does not support secure PRF unlock. Your backup key remains available.", "unsupported_unlock");
  const secret = new Uint8Array(result).slice();
  try {
    // The server verifies RP/origin/challenge/signature/UV; PRF output never leaves the browser.
    const finished = await loginRequest("/api/login/finish", JSON.stringify({ flow: started.flow, credential: {
      id: credential.id, type: credential.type, response: {
        clientDataJSON: toBase64Url(new Uint8Array(credential.response.clientDataJSON)),
        authenticatorData: toBase64Url(new Uint8Array(credential.response.authenticatorData)),
        signature: toBase64Url(new Uint8Array(credential.response.signature)),
        userHandle: credential.response.userHandle ? toBase64Url(new Uint8Array(credential.response.userHandle)) : null,
      },
    } }), signal);
    if (!finished.ok) throw new VaultError("Kin could not verify the passkey. Household data remains locked.", "authentication_failed");
    return { secret, credentialId: credential.id, prfSalt: toBase64Url(salt) };
  } catch (error) {
    secret.fill(0);
    throw error;
  } finally {
    new Uint8Array(result).fill(0);
  }
}
