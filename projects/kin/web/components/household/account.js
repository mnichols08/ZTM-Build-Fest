// Username and password accounts on the household panel (ADR 0018, #558):
// creating a household or joining one with the password chosen at first
// run, finishing a password claim once it is approved, signing in again
// with the password, and keeping the member's account vault current.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { currentPlatform, householdDeviceName } from "../../platform.js";
import { createAccountVault, passwordUnlockKeys, passwordWrapper, signUpBody } from "../../security/account-setup.js";
import { vaultApi, VaultKeeper } from "../../security/account-vault-sync.js";
import { fromBase64Url, getActiveVault, toBase64Url } from "../../security/local-vault.js";
import { deviceKeyFingerprint } from "../../sync/crypto.js";
import { onEpochInstalled } from "../../sync/key-store.js";

export class HouseholdAccount {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.keeper = null;
    this.stopKeeper = null;
  }

  /** This device's password wrapper (the lock screen's), or null. */
  wrapper() {
    try { return passwordWrapper(getActiveVault()?.manifest); } catch { return null; }
  }

  /** Runs `action` as the panel's one operation and hands back its result
   * or its error (host.run reports errors on the panel and swallows them). */
  async guarded(action) {
    const outcome = { done: false, value: undefined, error: null };
    await this.host.run(async () => {
      try {
        outcome.value = await action();
        outcome.done = true;
      } catch (error) {
        outcome.error = error;
        throw error;
      }
    });
    if (outcome.error) throw outcome.error;
    if (!outcome.done) throw new Error("Kin is busy with another household step. Try again in a moment.");
    return outcome.value;
  }

  /**
   * Creates the household with this device as its first trusted device and
   * the new password as the founder's sign-in (`signUp` from
   * account-setup prepareSignUp), creates the account vault, keeps its key
   * here and turns on sync. Resolves to the identity.
   */
  createHousehold(signUp) {
    return this.guarded(async () => {
      await this.ctx.api.openSyncKeyStore();
      // Trying again after a later step failed never creates a second
      // household: a device that already has its identity goes on from there.
      let identity = this.host.identity;
      if (!identity) {
        const pending = await this.host.syncKeyStore.getOrCreatePendingDevice();
        this.host.localFingerprint = pending.fingerprint;
        identity = await this.host.api("/api/account/bootstrap", {
          method: "POST",
          body: JSON.stringify({ ...signUpBody(signUp), deviceLabel: householdDeviceName(currentPlatform()), syncPublicKeys: pending.publicKeys }),
        });
        this.host.localFingerprint = (await this.host.syncKeyStore.bindPendingDevice({
          deviceId: identity.deviceId, householdId: identity.householdId, memberId: identity.memberId,
        })).fingerprint;
      }
      await this.createVault(identity, signUp);
      history.replaceState(null, "", "/");
      await this.host.load();
      // The founder turns sync on for the household; its first key goes into
      // the vault as soon as it is installed (the keeper watches).
      if (!this.host.syncStatus?.enabled) {
        await this.host.api("/api/sync/enable", { method: "POST", body: "{}" });
        this.host.syncStatus = await this.host.api("/api/sync/status");
        this.host.render();
      }
      this.host.dispatchEvent(new CustomEvent("kin:sync-enabled", { bubbles: true, composed: true, detail: this.host.identity }));
      return this.host.identity;
    });
  }

  /**
   * Accepts an invitation with the new password: the claim the inviter
   * approves, as with a passkey. `signUp` is kept (in memory only) so
   * finishing after approval doesn't ask for the password again.
   */
  joinHousehold(signUp, code) {
    return this.guarded(async () => {
      await this.ctx.api.openSyncKeyStore();
      const pending = await this.host.syncKeyStore.getOrCreatePendingDevice();
      this.host.localFingerprint = pending.fingerprint;
      this.host.claimIntent = "join";
      this.host.acknowledgedPathConflict = false;
      // A claim already sent (a retry after a later step failed) stands.
      if (this.host.claim?.state === "Claimed") { this.pendingSignUp = signUp; return; }
      await this.host.api("/api/account/claim", {
        method: "POST",
        body: JSON.stringify({ ...signUpBody(signUp), code, deviceLabel: householdDeviceName(currentPlatform()), syncPublicKeys: pending.publicKeys }),
      });
      this.pendingSignUp = signUp;
      history.replaceState(null, "", "/pair");
      await this.host.load();
    });
  }

  /**
   * Finishes an approved password claim: checks the approving device's key
   * as the passkey activation does, activates with the password, creates
   * the account vault and keeps its key. Uses the sign-up kept from joining
   * when this page still has it; otherwise `password` (typed again).
   */
  activate(password = null) {
    return this.guarded(async () => {
      const claim = this.host.claim;
      if (!this.host.localFingerprint || claim?.syncKeyFingerprint !== this.host.localFingerprint)
        throw new Error("This device key changed. Restart pairing before activating it.");
      if (!this.host.verifiedInviterFingerprint || !claim?.inviterDeviceId || !claim?.inviterKeyFingerprint)
        throw new Error("Compare the approving device fingerprint on both devices before activation.");
      let keys = this.pendingSignUp;
      let derived = null;
      if (!keys) {
        // The joiner's local password wrapper and their account share the
        // salt chosen at sign-up, so the typed password derives both.
        const wrapper = this.wrapper();
        derived = await passwordUnlockKeys(wrapper, password);
        keys = { ...derived, salt: fromBase64Url(wrapper.salt), iterations: wrapper.iterations };
      }
      try {
        const authKey = toBase64Url(keys.authKey);
        const activated = await this.host.api("/api/claim/activate/password", { method: "POST", body: JSON.stringify({ authKey }) });
        await this.ctx.api.openSyncKeyStore();
        const bound = await this.host.syncKeyStore.bindPendingDevice({
          deviceId: activated.deviceId, householdId: activated.householdId, memberId: activated.memberId,
        });
        this.host.localFingerprint = bound.fingerprint;
        const { devices } = await this.host.api("/api/sync/devices");
        const inviter = devices.find((device) => device.deviceId === claim.inviterDeviceId);
        if (!inviter?.publicKeys || inviter.fingerprint !== claim.inviterKeyFingerprint ||
            (await deviceKeyFingerprint(inviter.publicKeys)) !== claim.inviterKeyFingerprint)
          throw new Error("The approving device key does not match the compared fingerprint.");
        await this.host.syncKeyStore.pinTrustedDevice({
          householdId: activated.householdId, memberId: inviter.memberId, deviceId: inviter.deviceId,
          publicKeys: inviter.publicKeys, fingerprint: inviter.fingerprint,
        });
        await this.createVault(activated, keys);
        if (this.pendingSignUp) for (const key of ["authKey", "passwordKey", "localKek"]) this.pendingSignUp[key]?.fill?.(0);
        this.pendingSignUp = null;
        this.host.claim = null;
        history.replaceState(null, "", "/");
        await this.host.load();
        if (this.host.syncStatus?.enabled)
          this.host.dispatchEvent(new CustomEvent("kin:sync-enabled", { bubbles: true, composed: true, detail: this.host.identity }));
        // Joined: on to Today (the router follows the address).
        location.hash = "today";
        return this.host.identity;
      } finally {
        if (derived) for (const key of ["authKey", "passwordKey", "localKek"]) derived[key]?.fill(0);
      }
    });
  }

  /** Signs this device in again with the password (a session ended while
   * Kin stayed unlocked). */
  signIn(password) {
    return this.guarded(async () => {
      const wrapper = this.wrapper();
      const keys = await passwordUnlockKeys(wrapper, password);
      try {
        await this.host.api("/api/login/password", { method: "POST",
          body: JSON.stringify({ username: wrapper.username, authKey: toBase64Url(keys.authKey) }) });
      } finally {
        for (const key of ["authKey", "passwordKey", "localKek"]) keys[key].fill(0);
      }
      history.replaceState(null, "", "/");
      await this.host.load();
    });
  }

  /** The member's first account vault, and its key kept on this device.
   * Done once: a device that keeps the key already has a vault. */
  async createVault(identity, keys) {
    const store = this.host.syncKeyStore;
    const existing = await store.accountVaultKey(identity.householdId);
    if (existing) {
      existing.fill(0);
      this.startKeeper(identity);
      return;
    }
    const api = vaultApi((path, options) => this.host.api(path, options));
    const epochs = await store.vaultEpochKeys(identity.householdId);
    let vaultKey;
    try {
      vaultKey = await createAccountVault({ api, householdId: identity.householdId, memberId: identity.memberId,
        passwordKey: keys.passwordKey, salt: keys.salt, iterations: keys.iterations, epochs });
      await store.setAccountVaultKey(identity.deviceId, vaultKey);
    } catch (error) {
      // The vault was made by an earlier try whose key this device didn't
      // keep: the account still works; opening that vault on a device is
      // the new-device story's (#568).
      if (error?.code !== "vault_version_conflict") throw error;
    } finally {
      vaultKey?.fill(0);
      for (const entry of epochs) entry.key.fill(0);
    }
    this.startKeeper(identity);
  }

  /**
   * Keeps the account vault current from this device (#567): when this
   * device holds the member's vault key, every new household or chat key it
   * installs is merged into the vault. Started once per unlocked panel.
   */
  startKeeper(identity = this.host.identity) {
    if (!identity || this.keeper?.householdId === identity.householdId || !this.host.syncKeyStore) return;
    this.stopKeeper?.();
    const store = this.host.syncKeyStore;
    this.keeper = new VaultKeeper({
      api: vaultApi((path, options) => this.host.api(path, options)),
      householdId: identity.householdId,
      memberId: identity.memberId,
      vaultKey: () => store.accountVaultKey(identity.householdId),
      localContents: async () => ({ epochs: await store.vaultEpochKeys(identity.householdId) }),
    });
    this.stopKeeper = this.keeper.watch(onEpochInstalled);
    // Keys installed while this device was offline or locked.
    void this.keeper.update().catch(() => {});
  }

  stop() {
    this.stopKeeper?.();
    this.stopKeeper = null;
    this.keeper = null;
    this.pendingSignUp = null;
  }
}
