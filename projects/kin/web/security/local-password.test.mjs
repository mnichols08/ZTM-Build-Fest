// The local password wrapper and the "final verified unlock path" rule (#558).
import assert from "node:assert/strict";
import test from "node:test";
import { derivePasswordKeys, newPasswordSalt, PASSWORD_ITERATIONS } from "./account-vault.js";
import { hasVerifiedUnlockPath, LocalVault, localPasswordKek, toBase64Url, validateManifest } from "./local-vault.js";

async function passwordVault(password = "four unrelated words") {
  const salt = newPasswordSalt();
  const { authKey, passwordKey } = await derivePasswordKeys(password, salt);
  authKey.fill(0);
  const kek = await localPasswordKek(passwordKey);
  passwordKey.fill(0);
  const params = { salt: toBase64Url(salt), iterations: PASSWORD_ITERATIONS, username: "sam" };
  const created = await LocalVault.createWithPassword(kek, params);
  return { ...created, kek, params, salt };
}

test("a password-only root unlocks with the password, offline, and with nothing else", async () => {
  const { vault, manifest, kek, salt } = await passwordVault();
  const sealed = await vault.seal({ text: "milk" }, { store: "events", id: "one" });
  vault.lock();
  assert.equal(manifest.wrappers.length, 1);
  const [wrapper] = manifest.wrappers;
  assert.equal(wrapper.type, "password");
  assert.deepEqual({ kdf: wrapper.kdf, iterations: wrapper.iterations, username: wrapper.username },
    { kdf: "pbkdf2-sha256", iterations: PASSWORD_ITERATIONS, username: "sam" });
  assert.ok(!JSON.stringify(manifest).includes(toBase64Url(kek)), "the KEK is never stored");
  validateManifest(manifest);

  // The same password derives the same KEK again from the wrapper's salt.
  const again = await derivePasswordKeys("four unrelated words", salt);
  const reopened = await LocalVault.unlock(manifest, await localPasswordKek(again.passwordKey), wrapper.id);
  assert.deepEqual(await reopened.open(sealed, { store: "events", id: "one" }), { text: "milk" });
  reopened.lock();

  const wrong = await derivePasswordKeys("four unrelated wordz", salt);
  await assert.rejects(LocalVault.unlock(manifest, await localPasswordKek(wrong.passwordKey), wrapper.id), { code: "unlock_failed" });
  // The password KEK is not passwordKey itself: a distinct HKDF purpose.
  await assert.rejects(LocalVault.unlock(manifest, again.passwordKey, wrapper.id), { code: "unlock_failed" });
  // No recovery wrapper exists to fall back to.
  await assert.rejects(LocalVault.unlock(manifest, "00".repeat(32)), { code: "wrapper_unavailable" });
});

test("a password wrapper's KDF parameters are authenticated", async () => {
  const { manifest, kek } = await passwordVault();
  const [wrapper] = manifest.wrappers;
  const otherSalt = toBase64Url(newPasswordSalt());
  for (const changed of [{ salt: otherSalt }, { iterations: PASSWORD_ITERATIONS + 1 }]) {
    const tampered = { ...manifest, wrappers: [{ ...wrapper, ...changed }] };
    await assert.rejects(LocalVault.unlock(tampered, kek, wrapper.id), { code: "unlock_failed" });
  }
  // The username is only a password-manager hint and is not bound.
  const renamed = { ...manifest, wrappers: [{ ...wrapper, username: "sam.lee" }] };
  (await LocalVault.unlock(renamed, kek, wrapper.id)).lock();
});

test("password wrappers below the KDF floor or malformed are refused", async () => {
  const { manifest } = await passwordVault();
  const [wrapper] = manifest.wrappers;
  for (const changed of [{ iterations: 599_999 }, { kdf: "pbkdf2-sha1" }, { salt: "short" }, { username: "Sam Lee" }, { salt: undefined }])
    assert.throws(() => validateManifest({ ...manifest, wrappers: [{ ...wrapper, ...changed }] }), { message: /unlock metadata is invalid/ }, JSON.stringify(changed));
});

test("the final verified unlock path: a backup key, or a password for a password member", async () => {
  assert.equal(hasVerifiedUnlockPath([{ type: "recovery" }]), true);
  assert.equal(hasVerifiedUnlockPath([{ type: "password" }]), true);
  assert.equal(hasVerifiedUnlockPath([{ type: "prf" }]), false, "a passkey alone needs the service");
  assert.equal(hasVerifiedUnlockPath([]), false);
  assert.equal(hasVerifiedUnlockPath(undefined), false);

  // A password member who adds passkey unlock can remove the passkey again,
  // but never the password wrapper while it is the only independent path.
  const { vault, manifest } = await passwordVault();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const withPasskey = await vault.addCredentialWrapper(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  const passwordId = manifest.wrappers[0].id;
  const passkeyId = withPasskey.wrappers.find((entry) => entry.type === "prf").id;
  assert.throws(() => vault.removeWrapper(passwordId), { code: "last_wrapper" });
  assert.deepEqual(vault.removeWrapper(passkeyId).wrappers.map((entry) => entry.type), ["password"]);
  vault.lock();
});

test("households set up with a backup key keep the old rule exactly", async () => {
  const { vault, manifest } = await LocalVault.create();
  const recoveryId = manifest.wrappers[0].id;
  const secret = crypto.getRandomValues(new Uint8Array(32));
  await vault.addCredentialWrapper(secret, { credentialId: "credential-A", prfSalt: "salt-A" });
  assert.throws(() => vault.removeWrapper(recoveryId), { code: "last_wrapper" });
  vault.lock();
});
