import { LocalVault, getActiveVault, setActiveVault, randomRecoverySecret } from "../security/local-vault.js";
import { authenticatePrf, passkeyUnlockSupported } from "../security/passkey-unlock.js";
import { EventStore } from "../storage/event-store.js";
import { migrateSyncKeys, finalizeSyncKeyMigration, prepareRootRotationKeys, commitRootRotationKeys } from "../sync/key-store.js";
import { loadKinEngine } from "../wasm/kin-engine.js";
import { exportHouseholdArchive, validateHouseholdArchive, restoreValidatedHouseholdArchive, discardValidatedHouseholdArchive } from "../security/archive.js";
import { portableMembershipFromDirectory } from "../sync/sync-coordinator.js";

export const AUTO_LOCK_OPTIONS = [
  [0, "Only when Kin closes"],
  [5, "After 5 minutes of inactivity"],
  [15, "After 15 minutes of inactivity"],
  [60, "After 1 hour of inactivity"],
];

export function clearLegacyDrafts() {
  for (const key of ["kin.compose.draft", "kin.compose.classification", "kin.handoff.draft", "kin.talk.draft", "kin.routine.draft"]) {
    try { sessionStorage.removeItem(key); } catch { /* No fallback persistence. */ }
  }
}

class KinSecurity extends HTMLElement {
  constructor() {
    super();
    this.phase = "locked";
    this.manifest = null;
    this.busy = false;
    this.operation = 0;
    this.operationAbort = new AbortController();
    this.onUnlocked = null;
    this.onLockRequested = null;
    this.restoreStage = null;
    // Presentation only: whether the secondary recovery form is expanded on the lock screen.
    this.recoveryExpanded = false;
  }

  async initialize() {
    const operation = this.operation;
    clearLegacyDrafts();
    try {
      const manifest = await EventStore.securityStatus();
      if (operation !== this.operation) return;
      this.manifest = manifest;
      this.render();
    } catch (error) {
      if (operation === this.operation) { this.render(); this.error(error); }
    }
  }

  get passkeyWrappers() {
    return (this.manifest?.wrappers ?? []).filter((wrapper) => wrapper.type === "prf");
  }

  render() {
    this.replaceChildren();
    this.className = "security-panel";
    const heading = document.createElement("h2");
    heading.tabIndex = -1;
    heading.textContent = this.phase === "unlocked" ? "Household unlocked" : this.manifest ? "Welcome back" : "Welcome to Kin";
    this.heading = heading;
    this.append(heading);
    this.message = document.createElement("p");
    this.message.setAttribute("role", "status");
    this.message.setAttribute("aria-live", "polite");
    this.alert = document.createElement("p");
    this.alert.setAttribute("role", "alert");
    this.alert.className = "error-message";
    this.alert.id = "security-alert";
    this.append(this.message, this.alert);
    if (this.phase === "protecting") {
      this.message.textContent = "Protecting household… Keep this tab open.";
      this.button("Lock household", () => this.onLockRequested?.());
      return;
    }
    if (this.phase === "unlocked") return this.renderSettings();
    if (!this.manifest) return this.renderWelcome();
    this.renderLocked();
  }

  renderWelcome() {
    this.text("Kin keeps your household's lists, notes, and photos encrypted on this device. Passkey unlock is for everyday use; first, set up this device's encryption with a recovery key.");
    const steps = document.createElement("ol");
    steps.className = "setup-steps";
    for (const step of [
      "Save a recovery key. It is your backup way in.",
      "Create your household, or join one that already uses Kin.",
      "Turn on passkey unlock so your face, fingerprint, or screen lock opens Kin next time.",
    ]) {
      const item = document.createElement("li");
      item.textContent = step;
      steps.append(item);
    }
    this.append(steps);
    this.button("Set up protection", () => this.showSetup(), "primary-action");
    const note = this.text("Information already saved in this browser is kept and encrypted once setup is verified. Close other old Kin tabs first.");
    note.className = "security-note";
  }

  renderLocked() {
    const rotating = ["root-rotating", "root-cleanup"].includes(this.manifest.phase);
    const passkeys = rotating ? [] : this.passkeyWrappers;
    const supported = passkeyUnlockSupported();
    const offline = navigator.onLine === false;
    let expanded = true;
    if (rotating)
      this.text("Recovery protection is being replaced. Enter the new recovery key you saved to resume safely.");
    else if (this.manifest.phase !== "encrypted")
      this.text("Security setup is incomplete. Unlock to resume migration. Existing legacy data is not yet fully protected.");
    else if (passkeys.length && supported) {
      const lead = this.text("Unlock Kin");
      lead.className = "security-lead";
      this.text("Use your passkey to open your household on this device.");
      passkeys.forEach((wrapper, index) => {
        this.button(index === 0 ? "Unlock with passkey" : `Unlock with passkey ${index + 1}`,
          () => this.run(() => this.unlockPasskey(wrapper)), index === 0 ? "primary-action" : "");
      });
      if (offline) {
        const note = this.text("You're offline. Passkey unlock needs a connection to confirm your passkey, so use your recovery key for now.");
        note.className = "security-note";
      }
      expanded = offline || this.recoveryExpanded;
      if (!expanded) {
        this.button("Use recovery key", () => {
          this.recoveryExpanded = true;
          this.recoveryForm.hidden = false;
          this.recoveryToggle.hidden = true;
          this.recoveryInput.focus();
        });
        this.recoveryToggle = this.lastElementChild;
      }
    } else if (passkeys.length) {
      const lead = this.text("Unlock Kin");
      lead.className = "security-lead";
      this.text("This browser can't use the passkey saved for Kin. Use your recovery key instead.");
    } else {
      const lead = this.text("Unlock Kin");
      lead.className = "security-lead";
      this.text(supported
        ? "Use your recovery key to unlock. Once you're in, turn on passkey unlock under More → Security so your face, fingerprint, or screen lock opens Kin next time."
        : "Use your recovery key to unlock this device's copy of your household.");
    }
    const form = document.createElement("form");
    form.className = "recovery-form";
    form.hidden = !expanded;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "password";
    input.id = "recovery-unlock";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.required = true;
    input.setAttribute("aria-describedby", "recovery-unlock-help security-alert");
    label.htmlFor = input.id;
    label.textContent = "Recovery key";
    const help = document.createElement("p");
    help.id = "recovery-unlock-help";
    help.className = "security-note";
    help.textContent = "The 64-character key you saved when you set up Kin on this device.";
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Unlock with recovery key";
    form.append(label, input, help, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const secret = input.value;
      input.value = "";
      void this.run(() => this.unlockRecovery(secret));
    });
    this.recoveryForm = form;
    this.recoveryInput = input;
    this.append(form);
  }

  renderSettings() {
    const supported = passkeyUnlockSupported();
    const passkeys = this.passkeyWrappers;
    this.text("Your household is encrypted on this device. Drafts last only while unlocked.");
    this.button("Lock household", () => this.onLockRequested?.());

    const passkeySection = this.section("Passkey unlock");
    const passkeyStatus = document.createElement("p");
    passkeyStatus.className = "security-status";
    passkeyStatus.dataset.passkeyUnlock = !supported ? "unavailable" : passkeys.length ? "on" : "off";
    passkeyStatus.textContent = !supported
      ? "Passkeys aren't available in this browser. You unlock with your recovery key."
      : passkeys.length
        ? `On — ${passkeys.length === 1 ? "a passkey" : `${passkeys.length} passkeys`} can unlock Kin on this device.`
        : "Off — you unlock with your recovery key.";
    passkeySection.append(passkeyStatus);
    if (supported) {
      this.button(passkeys.length ? "Add another passkey" : "Turn on passkey unlock", () => this.run(() => this.addPasskey()),
        passkeys.length ? "" : "primary-action", passkeySection);
      if (!passkeys.length) {
        const hint = document.createElement("p");
        hint.className = "security-note";
        hint.textContent = "Uses the passkey for your household on this device, so create or join your household first.";
        passkeySection.append(hint);
      }
      passkeys.forEach((wrapper, index) => {
        this.button(passkeys.length === 1 ? "Remove passkey unlock" : `Remove passkey ${index + 1}`, () => this.run(async (operation) => {
          if (!confirm("Remove this passkey unlock? Your recovery key will still work. Previously copied keys cannot be recalled.")) return;
          const vault = getActiveVault();
          const manifest = vault.removeWrapper(wrapper.id);
          await EventStore.updateSecurityManifest(manifest, vault);
          this.assertCurrentOperation(operation);
          const current = await EventStore.securityStatus();
          this.assertCurrentOperation(operation);
          this.manifest = current;
          this.onLockRequested?.();
        }), "", passkeySection);
      });
    }

    const lockSection = this.section("Automatic lock");
    const app = this.closest("kin-app");
    const lockLabel = document.createElement("label");
    lockLabel.htmlFor = "auto-lock-minutes";
    lockLabel.textContent = "Lock Kin";
    const lockSelect = document.createElement("select");
    lockSelect.id = "auto-lock-minutes";
    for (const [minutes, text] of AUTO_LOCK_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(minutes);
      option.textContent = text;
      lockSelect.append(option);
    }
    lockSelect.value = String(app?.autoLockMinutes ?? 0);
    lockSelect.addEventListener("change", () => {
      app?.setAutoLockMinutes(Number(lockSelect.value));
      this.message.textContent = Number(lockSelect.value)
        ? "Kin will lock after that much inactivity. Closing or reloading always locks it."
        : "Kin locks whenever you close or reload.";
    });
    const lockHint = document.createElement("p");
    lockHint.className = "security-note";
    lockHint.textContent = "Closing or reloading always locks it. If you switch away for longer than this setting, Kin locks before you continue.";
    lockLabel.append(lockSelect);
    lockSection.append(lockLabel, lockHint);

    const recoverySection = this.section("Recovery key");
    const recoveryStatus = document.createElement("p");
    recoveryStatus.className = "security-status";
    recoveryStatus.textContent = "Your recovery key is the backup way to unlock this device. Kin never stores it.";
    recoverySection.append(recoveryStatus);
    const guidance = document.createElement("details");
    guidance.className = "security-guidance";
    const summary = document.createElement("summary");
    summary.textContent = "Recovery guidance";
    guidance.append(summary);
    const list = document.createElement("ul");
    for (const line of [
      "Keep the key somewhere safe outside Kin, such as a password manager. Anyone with it can unlock this device's copy.",
      "If you lose the key but a passkey still works, unlock with the passkey and choose Replace recovery key.",
      "If every unlock method is lost, this device's encrypted data cannot be recovered. Another trusted household device can re-approve a fresh device.",
      "To move Kin to another device, export the household and keep the export's recovery key with it.",
    ]) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    guidance.append(list);
    recoverySection.append(guidance);
    this.button("Replace recovery key", () => this.showReplacement(), "", recoverySection);

    const backupSection = this.section("Backup and move");
    this.button("Export household", () => this.run(() => this.downloadArchive()), "", backupSection);
    this.button("Restore household", () => this.showRestore(), "", backupSection);
    if (navigator.storage?.persist) this.button("Request persistent storage", () => this.run(async (operation) => {
      const granted = await navigator.storage.persist();
      this.assertCurrentOperation(operation);
      this.message.textContent = granted ? "This browser granted persistent storage. Keep encrypted backups too." : "Persistent storage was not granted. Keep encrypted backups to protect against browser data loss.";
    }), "", backupSection);
    const backupNote = document.createElement("p");
    backupNote.className = "security-note";
    backupNote.textContent = "Use a Kin export to move or restore your household. Keep its recovery key separately. Exports are manual, not automatic backups, and do not restore device trust.";
    backupSection.append(backupNote);
  }

  showSetup() {
    if (this.busy) return;
    const secret = randomRecoverySecret();
    this.render();
    this.heading.textContent = "Save your recovery key";
    this.text("This key is your backup way into Kin on this device if the passkey is ever lost. Save it somewhere safe outside Kin, such as a password manager.");
    const warning = this.text("Anyone with the key can unlock this device's copy of the household. If every unlock method is lost, Kin cannot recover the data.");
    warning.className = "security-note";
    const output = document.createElement("code");
    output.textContent = secret;
    output.className = "recovery-key";
    this.append(output);
    if (navigator.clipboard?.writeText) {
      this.button("Copy key", async () => {
        try {
          await navigator.clipboard.writeText(secret);
          this.message.textContent = "Recovery key copied. Paste it somewhere safe before continuing.";
        } catch {
          this.message.textContent = "Copy is unavailable. Select the key and copy it manually.";
        }
      });
    }
    const form = document.createElement("form");
    const label = document.createElement("label");
    const confirmation = document.createElement("input");
    confirmation.type = "password";
    confirmation.id = "confirm-recovery";
    confirmation.autocomplete = "off";
    confirmation.spellcheck = false;
    confirmation.required = true;
    label.htmlFor = confirmation.id;
    label.textContent = "Paste or type the saved key to confirm";
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "primary-action";
    button.textContent = "Encrypt and continue";
    form.append(label, confirmation, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (confirmation.value.trim() !== secret) return this.error(new Error("The recovery keys do not match. Save and re-enter the complete key."));
      confirmation.value = "";
      output.textContent = "";
      void this.run(() => this.establishProtection(secret));
    });
    this.append(form);
    confirmation.focus();
  }

  showReplacement() {
    if (this.busy || this.phase !== "unlocked") return;
    const secret = randomRecoverySecret();
    this.render();
    this.heading.textContent = "Replace recovery key";
    this.text("Save this new recovery key outside Kin. It replaces your current recovery key for this browser. Add passkey unlock again afterward. Old backups still need their original recovery keys.");
    const output = document.createElement("code");
    output.className = "recovery-key";
    output.textContent = secret;
    const form = document.createElement("form");
    const label = document.createElement("label");
    label.htmlFor = "confirm-replacement";
    label.textContent = "Re-enter the saved new recovery key";
    const confirmation = document.createElement("input");
    confirmation.id = label.htmlFor;
    confirmation.type = "password";
    confirmation.autocomplete = "off";
    confirmation.spellcheck = false;
    confirmation.required = true;
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Confirm saved key";
    form.append(label, confirmation, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (confirmation.value.trim() !== secret)
        return this.error(new Error("The recovery keys do not match. Save and re-enter the complete new key."));
      confirmation.value = "";
      output.textContent = "";
      void this.run(() => this.replaceProtection(secret));
    });
    this.append(output, form);
    this.button("Cancel", () => this.render());
    confirmation.focus();
  }

  async replaceProtection(secret) {
    const operation = this.operation;
    const signal = this.operationAbort.signal;
    const active = getActiveVault();
    await EventStore.checkSecurityEpoch(active);
    this.assertCurrentOperation(operation);
    // The operation owns these capabilities; clearing the application disposes
    // its event/sync adapters and projection before rotation fences peer tabs.
    const source = new LocalVault(active.vaultId, active.root, active.manifest);
    source.securityEpoch = active.securityEpoch;
    let candidate, engine;
    const cancel = () => { source.lock(); candidate?.lock(); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      ({ vault: candidate } = await LocalVault.createRotation(source, secret));
      this.assertCurrentOperation(operation);
      const app = this.closest("kin-app");
      app.notifyPeerLock(source.securityEpoch + 1);
      app.lockHousehold(false, { preserveSecurityOperation: true });
      this.phase = "protecting";
      this.render();
      engine = await loadKinEngine();
      this.assertCurrentOperation(operation);
      await EventStore.rotateProtection({ sourceVault: source, candidateVault: candidate, engine,
        prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
        onPhase: async (phase) => {
          this.assertCurrentOperation(operation);
          if (phase === "begun") {
            const status = await EventStore.securityStatus();
            this.assertCurrentOperation(operation);
            this.manifest = status;
            app.channel?.postMessage({ type: "household-locked", lockEpoch: status.lockEpoch });
          }
        },
      });
      this.assertCurrentOperation(operation);
      await this.finishUnlock(candidate, operation);
      this.message.textContent = "Recovery protection updated. Use your new recovery key and add passkey unlock again if needed.";
    } catch (error) {
      candidate?.lock();
      if (operation === this.operation) this.phase = "locked";
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      source.lock();
      engine?.dispose();
    }
  }

  async establishProtection(secret) {
    const operation = this.operation;
    const { vault, manifest } = await LocalVault.create(secret);
    try {
      this.assertCurrentOperation(operation);
      await EventStore.prepareSecurity(manifest);
      this.assertCurrentOperation(operation);
      const current = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      this.manifest = current;
      await this.finishUnlock(vault, operation);
    } catch (error) { vault.lock(); throw error; }
  }

  async unlockRecovery(secret) {
    const operation = this.operation;
    await this.closest("kin-app")?.lockBarrier;
    this.assertCurrentOperation(operation);
    const manifest = await EventStore.securityStatus();
    this.assertCurrentOperation(operation);
    const unlockManifest = manifest?.phase === "root-rotating" ? manifest.rotation.candidateManifest : manifest;
    const vault = await LocalVault.unlock(unlockManifest, secret);
    await this.finishUnlock(vault, operation);
  }

  async unlockPasskey(wrapper) {
    const operation = this.operation;
    const signal = this.operationAbort.signal;
    let secret;
    try {
      ({ secret } = await authenticatePrf(wrapper, { signal }));
    } catch (error) {
      // After a failed or unsupported passkey attempt the recovery form must be
      // directly reachable; the re-render after this error reads the flag.
      this.recoveryExpanded = true;
      throw error;
    }
    try {
      await this.closest("kin-app")?.lockBarrier;
      this.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      const vault = await LocalVault.unlock(manifest, secret, wrapper.id);
      await this.finishUnlock(vault, operation);
    } catch (error) {
      this.recoveryExpanded = true;
      throw error;
    } finally { secret.fill(0); }
  }

  async finishUnlock(vault, operation) {
    try {
      await this.closest("kin-app")?.lockBarrier;
      this.assertCurrentOperation(operation);
      setActiveVault(vault);
      this.message.textContent = "Unlocking and verifying household data…";
      const status = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      vault.assertUnlocked();
      if (["root-rotating", "root-cleanup"].includes(status.phase)) {
        this.message.textContent = "Resuming recovery protection…";
        const engine = await loadKinEngine();
        try {
          this.assertCurrentOperation(operation);
          await EventStore.resumeRotation({ candidateVault: vault, engine,
            prepareKeys: prepareRootRotationKeys, commitKeys: commitRootRotationKeys,
            onPhase: () => this.assertCurrentOperation(operation),
          });
        } finally { engine.dispose(); }
      } else if (status.phase !== "encrypted") {
        this.message.textContent = "Encrypting and verifying saved information. Keep this tab open.";
        const engine = await loadKinEngine();
        try {
          this.assertCurrentOperation(operation);
          await EventStore.migrate({ vault, engine,
            prepareKeys: (current, options) => migrateSyncKeys(current, { ...options, prepareOnly: true }),
            finalizeKeys: (current) => finalizeSyncKeyMigration(current),
          });
        } finally { engine.dispose(); }
      }
      vault.assertUnlocked();
      this.assertCurrentOperation(operation);
      const manifest = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      vault.assertUnlocked();
      this.manifest = manifest;
      this.phase = "unlocked";
      this.recoveryExpanded = false;
      this.render();
      await this.onUnlocked?.(vault);
      this.assertCurrentOperation(operation);
    } catch (error) {
      vault.lock();
      // Revoking this result is always required. Only its current operation may
      // update the panel; a later unlock can already own the visible household.
      if (operation === this.operation) {
        const manifest = await EventStore.securityStatus().catch(() => this.manifest);
        if (operation === this.operation) {
          this.manifest = manifest;
          this.phase = "locked";
          this.render();
        }
      }
      throw error;
    }
  }

  async addPasskey() {
    const operation = this.operation;
    const vault = getActiveVault();
    const { secret, credentialId, prfSalt } = await authenticatePrf(null, {
      signal: this.operationAbort.signal,
    });
    try {
      this.assertCurrentOperation(operation);
      const manifest = await vault.addCredentialWrapper(secret, { credentialId, prfSalt });
      this.assertCurrentOperation(operation);
      await EventStore.updateSecurityManifest(manifest, vault);
      this.assertCurrentOperation(operation);
      const current = await EventStore.securityStatus();
      this.assertCurrentOperation(operation);
      this.manifest = current;
      if (this.phase === "unlocked") this.render();
      this.message.textContent = "Passkey unlock is on for this device. Your recovery key still works as a backup.";
      this.dispatchEvent(new CustomEvent("kin:security-changed", { bubbles: true, composed: true }));
    } finally { secret.fill(0); }
  }

  async downloadArchive() {
    const operation = this.operation;
    const app = this.closest("kin-app");
    let portableMembership;
    if (app.syncCoordinator) portableMembership = await app.syncCoordinator.portableMembershipSnapshot();
    else if (app.household?.identity) {
      const response = await fetch("/api/sync/devices", { cache: "no-store" });
      if (!response.ok) throw new Error("Connect to your household before exporting its membership history.");
      portableMembership = portableMembershipFromDirectory((await response.json()).members);
    }
    this.assertCurrentOperation(operation);
    const bytes = await exportHouseholdArchive({ store: app.store, engine: app.engine, vault: getActiveVault(), portableMembership });
    this.assertCurrentOperation(operation);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "kin-household.kin";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.message.textContent = "Kin export prepared. Keep it and its recovery key safe.";
  }

  showRestore() {
    if (this.busy) return;
    this.render();
    this.heading.textContent = "Restore household";
    const form = document.createElement("form");
    const file = document.createElement("input");
    file.id = "archive-file"; file.type = "file"; file.accept = ".kin"; file.required = true;
    file.setAttribute("aria-describedby", "security-alert");
    const fileLabel = document.createElement("label"); fileLabel.htmlFor = file.id; fileLabel.textContent = "Kin export";
    const recovery = document.createElement("input");
    recovery.id = "archive-recovery"; recovery.type = "password"; recovery.autocomplete = "off"; recovery.required = true;
    recovery.setAttribute("aria-describedby", "security-alert");
    const recoveryLabel = document.createElement("label"); recoveryLabel.htmlFor = recovery.id; recoveryLabel.textContent = "Export recovery key";
    const button = document.createElement("button"); button.type = "submit"; button.textContent = "Check export";
    form.append(fileLabel, file, recoveryLabel, recovery, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = file.files[0]; const secret = recovery.value; recovery.value = "";
      void this.run(async (operation) => {
        if (!selected || selected.size > 160 * 1024 * 1024) throw new Error("Choose a Kin archive no larger than 160 MiB.");
        const app = this.closest("kin-app");
        const engine = app.engine, vault = getActiveVault();
        this.message.textContent = "Checking your Kin export…";
        const bytes = new Uint8Array(await selected.arrayBuffer());
        this.assertCurrentOperation(operation);
        const staged = await validateHouseholdArchive({ bytes, recoverySecret: secret, engine, vault });
        this.assertCurrentOperation(operation);
        this.restoreStage = staged.stage;
        form.remove();
        const summary = document.createElement("p");
        summary.textContent = `This export is ready to restore (${staged.eventCount} household changes, ${staged.attachmentCount} attachments). Restore works on an empty installation or as a no-duplicate check when this same household already contains the export. Device approval and sync access are not included.`;
        const confirm = document.createElement("button");
        confirm.id = "restore-confirm";
        confirm.type = "button";
        confirm.textContent = "Restore household";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        confirm.addEventListener("click", () => void this.run(async (confirmOperation) => {
          const restored = await restoreValidatedHouseholdArchive({ stage: staged.stage, engine, vault, store: app.store });
          this.restoreStage = null;
          this.assertCurrentOperation(confirmOperation);
          await app.refreshFromEvents();
          this.assertCurrentOperation(confirmOperation);
          // Restored history replaces what reminders pointed at; end them.
          app.clearReminders();
          app.broadcastEventChange();
          this.render();
          this.message.textContent = restored.alreadyPresent
            ? "This household already contains the export's history and attachments. Nothing was duplicated."
            : "Your household is restored on this device. This device still needs household approval before sync can resume.";
        }));
        cancel.addEventListener("click", () => {
          discardValidatedHouseholdArchive(staged.stage);
          this.restoreStage = null;
          summary.remove(); confirm.remove(); cancel.remove();
          this.showRestore();
        });
        this.append(summary, confirm, cancel);
        confirm.focus();
        this.message.textContent = "This export is ready to restore.";
      });
    });
    this.append(form);
    this.button("Cancel", () => this.render());
    file.focus();
  }

  locked() {
    if (this.restoreStage) discardValidatedHouseholdArchive(this.restoreStage);
    this.restoreStage = null;
    this.operation++;
    this.operationAbort.abort();
    this.operationAbort = new AbortController();
    this.phase = "locked";
    this.busy = false;
    this.recoveryExpanded = false;
    this.setAttribute("aria-busy", "false");
    clearLegacyDrafts();
    this.render();
    this.heading.focus();
  }

  async run(action) {
    if (this.busy) return;
    const operation = ++this.operation;
    this.busy = true;
    this.setAttribute("aria-busy", "true");
    this.alert.textContent = "";
    for (const element of this.querySelectorAll("button,input,select")) element.disabled = true;
    try { await action(operation); }
    catch (error) {
      if (operation !== this.operation) return;
      if (this.phase !== "unlocked") {
        const manifest = await EventStore.securityStatus().catch(() => this.manifest);
        if (operation !== this.operation) return;
        this.manifest = manifest;
        this.render();
      }
      this.error(error);
    } finally {
      if (operation === this.operation) {
        this.busy = false;
        this.setAttribute("aria-busy", "false");
        for (const element of this.querySelectorAll("button,input,select")) element.disabled = false;
      }
    }
  }

  assertCurrentOperation(operation) {
    if (operation !== this.operation) throw new Error("This security operation was cancelled.");
  }

  error(error) {
    this.alert.textContent = ["AbortError", "NotAllowedError"].includes(error.name)
      ? "Authentication was cancelled or the credential was unavailable. Your saved data was not changed."
      : error.userMessage ?? error.message ?? "Kin could not complete security setup.";
  }
  text(value, parent = this) { const p = document.createElement("p"); p.textContent = value; parent.append(p); return p; }
  section(title) {
    const section = document.createElement("section");
    section.className = "security-section";
    const heading = document.createElement("h3");
    heading.textContent = title;
    section.append(heading);
    this.append(section);
    return section;
  }
  button(label, action, className = "", parent = this) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label;
    if (className) button.className = className;
    button.addEventListener("click", action); parent.append(button);
    return button;
  }
}

customElements.define("kin-security", KinSecurity);
