// Unlocking with the backup (recovery) key or a passkey, and the shared steps that
// open the household once the vault is unlocked.
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { LocalVault, setActiveVault } from "../../security/local-vault.js";
import { authenticatePrf } from "../../security/passkey-unlock.js";
import { EventStore } from "../../storage/event-store.js";
import { commitRootRotationKeys, finalizeSyncKeyMigration, migrateSyncKeys, prepareRootRotationKeys } from "../../sync/key-store.js";
import { loadKinEngine } from "../../wasm/kin-engine.js";

export class SecurityUnlock {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  async unlockRecovery(secret) {
    const operation = this.host.operation;
    await this.host.closest("kin-app")?.lockBarrier;
    this.host.assertCurrentOperation(operation);
    const manifest = await EventStore.securityStatus();
    this.host.assertCurrentOperation(operation);
    const unlockManifest = manifest?.phase === "root-rotating" ? manifest.rotation.candidateManifest : manifest;
    const vault = await LocalVault.unlock(unlockManifest, secret);
    await this.finishUnlock(vault, operation);
  }

  async unlockPasskey(wrapper) {
    const operation = this.host.operation;
    const signal = this.host.operationAbort.signal;
    let secret;
    try {
      ({ secret } = await authenticatePrf(wrapper, { signal }));
    } catch (error) {
      // After a failed or unsupported passkey attempt the recovery form must be
      // directly reachable; the re-render after this error reads the flag.
      this.host.recoveryExpanded = true;
      throw error;
    }
    try {
      await this.host.closest("kin-app")?.lockBarrier;
      this.host.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      const vault = await LocalVault.unlock(manifest, secret, wrapper.id);
      await this.finishUnlock(vault, operation);
    } catch (error) {
      this.host.recoveryExpanded = true;
      throw error;
    } finally { secret.fill(0); }
  }

  /** Reopens the household after a refresh with the root a reload-resume
   * ticket returned (#351). A failure just leaves the ordinary lock screen. */
  async resumeAfterReload({ root, manifest }) {
    const operation = this.host.operation;
    let vault = null;
    try {
      await this.host.closest("kin-app")?.lockBarrier;
      this.host.assertCurrentOperation(operation);
      this.host.message.textContent = "Reopening your household…";
      vault = new LocalVault(manifest.vaultId, root, manifest);
    } catch {
      return;
    } finally { root.fill(0); }
    try { await this.finishUnlock(vault, operation); }
    catch {
      if (operation === this.host.operation) this.host.message.textContent = "";
    }
  }

  async finishUnlock(vault, operation) {
    try {
      await this.host.closest("kin-app")?.lockBarrier;
      this.host.assertCurrentOperation(operation);
      setActiveVault(vault);
      this.host.message.textContent = "Unlocking and verifying household data…";
      const status = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      vault.assertUnlocked();
      if (["root-rotating", "root-cleanup"].includes(status.phase)) {
        this.host.message.textContent = "Finishing the backup key replacement…";
        const engine = await loadKinEngine();
        try {
          this.host.assertCurrentOperation(operation);
          await EventStore.resumeRotation({ candidateVault: vault, engine,
            prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
            onPhase: () => this.host.assertCurrentOperation(operation),
          });
        } finally { engine.dispose(); }
      } else if (status.phase !== "encrypted") {
        this.host.message.textContent = "Encrypting and verifying saved information. Keep this tab open.";
        const engine = await loadKinEngine();
        try {
          this.host.assertCurrentOperation(operation);
          await EventStore.migrate({ vault, engine,
            prepareKeys: (current, options) => migrateSyncKeys(current, { ...options, prepareOnly: true }),
            finalizeKeys: (current) => finalizeSyncKeyMigration(current),
          });
        } finally { engine.dispose(); }
      }
      vault.assertUnlocked();
      this.host.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.host.assertCurrentOperation(operation);
      vault.assertUnlocked();
      this.host.manifest = manifest;
      this.host.phase = "unlocked";
      this.host.recoveryExpanded = false;
      this.host.render();
      await this.host.onUnlocked?.(vault);
      this.host.assertCurrentOperation(operation);
    } catch (error) {
      vault.lock();
      // Revoking this result is always required. Only its current operation may
      // update the panel; a later unlock can already own the visible household.
      if (operation === this.host.operation) {
        const manifest = await EventStore.securityStatus().catch(() => this.host.manifest);
        if (operation === this.host.operation) {
          this.host.manifest = manifest;
          this.host.phase = "locked";
          this.host.render();
        }
      }
      throw error;
    }
  }
}
