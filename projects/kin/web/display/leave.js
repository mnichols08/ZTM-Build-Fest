// Leaving kitchen display mode (#670, ADR 0022 §4) needs the adult whose
// device it is: their password or their passkey, checked on this device
// against the same unlock paths that open Kin here, so it works offline and
// for a household that doesn't sync. Proving it is opening this device's
// vault once more with that secret; the copy that opens is locked again at
// once and nothing is kept.
//
// A device set up before accounts unlocks with its backup key only; there
// the backup key is what leaving asks for, as unlocking does.
import { LocalVault } from "../security/local-vault.js";
import { authenticatePrf } from "../security/passkey-unlock.js";
import { passwordUnlockKeys, passwordWrapper } from "../security/account-setup.js";

/** The manifest that opens this device now (mid key replacement, the new
 * one, as unlocking uses). */
export function unlockManifest(manifest) {
  return manifest?.phase === "root-rotating" ? manifest.rotation?.candidateManifest ?? manifest : manifest;
}

/**
 * The ways this device's owner can confirm, in the order offered:
 * "passkey" (a passkey wrapper), "password" (a password wrapper), and
 * "backup-key" only when neither exists.
 */
export function leaveMethods(manifest) {
  const wrappers = unlockManifest(manifest)?.wrappers ?? [];
  const methods = [];
  if (wrappers.some((wrapper) => wrapper?.type === "prf")) methods.push("passkey");
  if (wrappers.some((wrapper) => wrapper?.type === "password")) methods.push("password");
  if (!methods.length && wrappers.some((wrapper) => wrapper?.type === "recovery")) methods.push("backup-key");
  return methods;
}

/** "your passkey or password", for the dialog's lead. */
export function methodsText(methods) {
  const words = { passkey: "your passkey", password: "your password", "backup-key": "this household's backup key" };
  const named = methods.map((method) => words[method]).filter(Boolean);
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} or ${named.at(-1)}` : named[0] ?? "";
}

/**
 * Checks the owner's secret against `manifest` (EventStore.securityStatus()).
 * `method` is one of leaveMethods; `secret` is the typed password or backup
 * key (the passkey asks the authenticator itself). Resolves true, or throws
 * a VaultError (wrong secret: code "unlock_failed"; a cancelled passkey:
 * NotAllowedError). `vaultId`, when given, must be the vault this device
 * has open.
 */
export async function confirmOwner({ manifest, method, secret = null, vaultId = null, signal } = {},
  { unlock = (...args) => LocalVault.unlock(...args), prf = authenticatePrf, passwordKeys = passwordUnlockKeys } = {}) {
  const opened = unlockManifest(manifest);
  if (!opened || (vaultId && opened.vaultId !== vaultId)) throw Object.assign(new Error("This isn't the household open on this device."), { code: "wrong_vault" });
  let vault = null;
  if (method === "password") {
    const wrapper = passwordWrapper(opened);
    const keys = await passwordKeys(wrapper, secret);
    try {
      vault = await unlock(opened, keys.localKek, wrapper.id);
    } finally {
      keys.localKek?.fill?.(0);
      keys.authKey?.fill?.(0);
      keys.passwordKey?.fill?.(0);
    }
  } else if (method === "passkey") {
    const wrappers = opened.wrappers.filter((wrapper) => wrapper?.type === "prf");
    let lastError = null;
    for (const wrapper of wrappers) {
      let result = null;
      try {
        result = await prf(wrapper, { signal });
        vault = await unlock(opened, result.secret, wrapper.id);
        break;
      } catch (error) {
        lastError = error;
        if (error?.name === "NotAllowedError" || error?.name === "AbortError") throw error;
      } finally {
        result?.secret?.fill?.(0);
      }
    }
    if (!vault) throw lastError ?? Object.assign(new Error("No passkey opens this device."), { code: "unlock_failed" });
  } else if (method === "backup-key") {
    vault = await unlock(opened, secret);
  } else {
    throw Object.assign(new Error("Choose how to confirm."), { code: "unlock_failed" });
  }
  // Only proof was wanted: the copy that opened is closed again.
  vault?.lock?.();
  return true;
}
