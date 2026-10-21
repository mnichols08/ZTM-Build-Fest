// The security panel's views: welcome, locked (unlock choices) and the
// settings shown once unlocked.
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import { getActiveVault } from "../../security/local-vault.js";
import { passkeyUnlockSupported } from "../../security/passkey-unlock.js";
import { EventStore } from "../../storage/event-store.js";
import { EXPORT_STORAGE_RULE, joinLabels, manifestRecoveryLabels } from "../../security/key-label.js";
import { currentPlatform, installHelp } from "../../platform.js";
import { installHelpCard } from "../shared/dom.js";
import { passwordManagerField } from "./protection.js";
import { entryHint, legacyEntryName, rememberedEntries, unlockEntryName } from "../../security/backup-key-entry.js";

export const AUTO_LOCK_OPTIONS = [
  [0, "Only when Kin closes"],
  [5, "After 5 minutes of inactivity"],
  [15, "After 15 minutes of inactivity"],
  [60, "After 1 hour of inactivity"],
];

export class SecurityViews {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  // "Include chat" for the export (#136): on by default, with the size shown
  // before anything is made. Only offered where this device can read chat.
  chatExportOption(parent) {
    const room = this.host.closest("kin-app")?.chat?.room;
    if (!room?.chatExportPlan) return;
    const row = document.createElement("div");
    row.className = "security-chat-option";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "archive-include-chat";
    box.checked = true;
    const label = document.createElement("label");
    label.htmlFor = box.id;
    label.textContent = "Include chat (messages, photos, files, voice)";
    const estimate = document.createElement("p");
    estimate.id = "archive-chat-estimate";
    estimate.className = "security-note";
    estimate.setAttribute("role", "status");
    box.setAttribute("aria-describedby", estimate.id);
    row.append(box, " ", label, estimate);
    // Shown (and counted) only once there is chat to include.
    void room.chatExportPlan().then((plan) => {
      if (!parent.isConnected || !plan.events) return;
      (parent.querySelector("h2, h3, h4") ?? { after: (node) => parent.prepend(node) }).after(row);
      this.host.chatOption = box;
      const megabytes = (plan.blobBytes + plan.events * 400) / (1024 * 1024);
      const size = megabytes < 0.1 ? "under 0.1 MB" : `about ${megabytes.toFixed(1)} MB`;
      estimate.textContent = `${plan.events.toLocaleString()} chat events and ${plan.blobs.length.toLocaleString()} photos, files and messages, ${size}. Messages deleted for everyone are included only as deleted placeholders, and your "delete for me" list is yours alone.`;
    }, () => {});
  }

  // frameOnly: just the heading and status lines, for a flow (backup-key
  // setup) that fills in the rest itself.
  render({ frameOnly = false } = {}) {
    this.host.replaceChildren();
    this.host.className = "security-panel";
    const heading = document.createElement("h2");
    heading.tabIndex = -1;
    heading.textContent = this.host.phase === "unlocked" ? "Household unlocked" : this.host.manifest ? "Welcome back" : "Welcome to Kin";
    this.host.heading = heading;
    this.host.append(heading);
    this.host.message = document.createElement("p");
    this.host.message.setAttribute("role", "status");
    this.host.message.setAttribute("aria-live", "polite");
    this.host.alert = document.createElement("p");
    this.host.alert.setAttribute("role", "alert");
    this.host.alert.className = "error-message";
    this.host.alert.id = "security-alert";
    this.host.append(this.host.message, this.host.alert);
    if (frameOnly) return;
    if (this.host.phase === "protecting") {
      this.host.message.textContent = "Protecting household… Keep this tab open.";
      this.host.button("Lock household", () => this.host.onLockRequested?.());
      return;
    }
    if (this.host.phase === "unlocked") return this.renderSettings();
    if (!this.host.manifest) return this.renderWelcome();
    this.renderLocked();
  }

  renderWelcome() {
    this.host.text("Kin keeps your household's lists, notes, and photos encrypted on this device. Passkey unlock is for everyday use; first, set up this device's encryption with a backup key for this device.");
    // On iPhone and iPad the Home Screen app has its own storage, so a
    // household set up in the browser wouldn't be in the installed app.
    const install = installHelp(currentPlatform());
    if (install) installHelpCard(install, { parent: this.host });
    const steps = document.createElement("ol");
    steps.className = "setup-steps";
    for (const step of [
      "Save a backup key for this device. Each device has its own.",
      "Create your household, or join one that already uses Kin.",
      "Turn on passkey unlock so your face, fingerprint, or screen lock opens Kin next time.",
    ]) {
      const item = document.createElement("li");
      item.textContent = step;
      steps.append(item);
    }
    this.host.append(steps);
    this.host.button("Set up protection", () => this.host.showSetup(), "primary-action");
    const note = this.host.text("Information already saved in this browser is kept and encrypted once setup is verified. Close other old Kin tabs first.");
    note.className = "security-note";
  }

  renderLocked() {
    const rotating = ["root-rotating", "root-cleanup"].includes(this.host.manifest.phase);
    const passkeys = rotating ? [] : this.host.passkeyWrappers;
    const supported = passkeyUnlockSupported();
    const offline = navigator.onLine === false;
    let expanded = true;
    if (rotating)
      this.host.text("Your backup key is being replaced. Enter the new backup key you saved to resume safely.");
    else if (this.host.manifest.phase !== "encrypted")
      this.host.text("Security setup is incomplete. Unlock to resume migration. Existing legacy data is not yet fully protected.");
    else if (passkeys.length && supported) {
      const lead = this.host.text("Unlock Kin");
      lead.className = "security-lead";
      this.host.text("Use your passkey to open your household on this device.");
      passkeys.forEach((wrapper, index) => {
        this.host.button(index === 0 ? "Unlock with passkey" : `Unlock with passkey ${index + 1}`,
          () => this.host.run(() => this.host.unlockPasskey(wrapper)), index === 0 ? "primary-action" : "");
      });
      if (offline) {
        const note = this.host.text("You're offline. Passkey unlock needs a connection to confirm your passkey, so use your backup key for now.");
        note.className = "security-note";
      }
      expanded = offline || this.host.recoveryExpanded;
      if (!expanded) {
        this.host.button("Use backup key", () => {
          this.host.recoveryExpanded = true;
          this.host.recoveryForm.hidden = false;
          this.host.recoveryToggle.hidden = true;
          this.host.recoveryInput.focus();
        });
        this.host.recoveryToggle = this.host.lastElementChild;
      }
    } else if (passkeys.length) {
      const lead = this.host.text("Unlock Kin");
      lead.className = "security-lead";
      this.host.text("This browser can't use the passkey saved for Kin. Use your backup key instead.");
    } else {
      const lead = this.host.text("Unlock Kin");
      lead.className = "security-lead";
      this.host.text(supported
        ? "Use your backup key for this device to unlock. Once you're in, turn on passkey unlock under More → Security so your face, fingerprint, or screen lock opens Kin next time."
        : "Use your backup key to unlock this device's copy of your household.");
    }
    const form = document.createElement("form");
    form.className = "recovery-form";
    form.hidden = !expanded;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "password";
    input.id = "recovery-unlock";
    input.autocomplete = "current-password";
    input.spellcheck = false;
    input.required = true;
    input.setAttribute("aria-describedby", "recovery-unlock-help recovery-unlock-entry security-alert");
    label.htmlFor = input.id;
    label.textContent = "Backup key for this device";
    const help = document.createElement("p");
    help.id = "recovery-unlock-help";
    help.className = "security-note";
    help.textContent = "The 64-character key you saved when you set up Kin on this device. Each device has its own.";
    // Which saved entry to pick, so a password manager's other devices' keys
    // aren't mistaken for this one (#579). Filled in once the label is known.
    const entry = document.createElement("p");
    entry.id = "recovery-unlock-entry";
    entry.className = "security-note";
    entry.hidden = true;
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Unlock with backup key";
    // Names the password-manager entry for this device's current key, so
    // autofill offers that key, not another device's or a replaced one: the
    // name this device saved ("Kin backup key — Chrome on Android (K-7F3A)"),
    // or the older "Kin recovery key K-7F3A" for keys saved before it.
    const account = passwordManagerField("text", "username", legacyEntryName());
    const unlockManifest = this.host.manifest?.phase === "root-rotating" ? this.host.manifest.rotation?.candidateManifest : this.host.manifest;
    if (unlockManifest) void manifestRecoveryLabels(unlockManifest).then((labels) => {
      if (!labels?.length) return;
      const keyLabel = labels.at(-1);
      account.value = unlockEntryName(keyLabel, rememberedEntries());
      entry.textContent = entryHint(keyLabel);
      entry.hidden = false;
    }, () => {});
    form.append(account, label, input, help, entry, button);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const secret = input.value;
      input.value = "";
      void this.host.run(() => this.host.unlockRecovery(secret));
    });
    this.host.recoveryForm = form;
    this.host.recoveryInput = input;
    this.host.append(form);
  }

  renderSettings() {
    const supported = passkeyUnlockSupported();
    const passkeys = this.host.passkeyWrappers;
    this.host.text("Your household is encrypted on this device. Drafts last only while unlocked.");
    this.host.button("Lock household", () => this.host.onLockRequested?.());

    const passkeySection = this.host.section("Passkey unlock");
    const passkeyStatus = document.createElement("p");
    passkeyStatus.className = "security-status";
    passkeyStatus.dataset.passkeyUnlock = !supported ? "unavailable" : passkeys.length ? "on" : "off";
    passkeyStatus.textContent = !supported
      ? "Passkeys aren't available in this browser. You unlock with your backup key."
      : passkeys.length
        ? `On — ${passkeys.length === 1 ? "a passkey" : `${passkeys.length} passkeys`} can unlock Kin on this device.`
        : "Off — you unlock with your backup key.";
    passkeySection.append(passkeyStatus);
    if (supported) {
      this.host.button(passkeys.length ? "Add another passkey" : "Turn on passkey unlock", () => this.host.run(() => this.host.addPasskey()),
        passkeys.length ? "" : "primary-action", passkeySection);
      if (!passkeys.length) {
        const hint = document.createElement("p");
        hint.className = "security-note";
        hint.textContent = "Uses the passkey for your household on this device, so create or join your household first.";
        passkeySection.append(hint);
      }
      passkeys.forEach((wrapper, index) => {
        this.host.button(passkeys.length === 1 ? "Remove passkey unlock" : `Remove passkey ${index + 1}`, () => this.host.run(async (operation) => {
          if (!confirm("Remove this passkey unlock? Your backup key will still work. Previously copied keys cannot be recalled.")) return;
          const vault = getActiveVault();
          const manifest = vault.removeWrapper(wrapper.id);
          await EventStore.updateSecurityManifest(manifest, vault);
          this.host.assertCurrentOperation(operation);
          const current = await EventStore.securityStatus();
          this.host.assertCurrentOperation(operation);
          this.host.manifest = current;
          this.host.onLockRequested?.();
        }), "", passkeySection);
      });
    }

    const lockSection = this.host.section("Automatic lock");
    const app = this.host.closest("kin-app");
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
      this.host.services?.setAutoLockMinutes(Number(lockSelect.value));
      this.host.message.textContent = Number(lockSelect.value)
        ? "Kin will lock after that much inactivity. Closing the tab always locks it."
        : "Kin locks whenever you close the tab.";
    });
    const lockHint = document.createElement("p");
    lockHint.className = "security-note";
    lockHint.textContent = "Closing the tab always locks Kin. If you switch away for longer than this setting, Kin locks before you continue.";
    lockLabel.append(lockSelect);
    // #351: a refresh of this tab can keep Kin unlocked (ADR 0010).
    const resumeRow = document.createElement("div");
    resumeRow.className = "security-chat-option";
    const resumeBox = document.createElement("input");
    resumeBox.type = "checkbox";
    resumeBox.id = "reload-resume";
    resumeBox.checked = this.host.services?.reloadResumeEnabled?.() ?? true;
    resumeBox.addEventListener("change", () => {
      this.host.services?.setReloadResume?.(resumeBox.checked);
      this.host.message.textContent = resumeBox.checked
        ? "Refreshing this tab keeps Kin unlocked."
        : "Refreshing locks Kin, like closing the tab.";
    });
    const resumeLabel = document.createElement("label");
    resumeLabel.htmlFor = resumeBox.id;
    resumeLabel.textContent = "Stay unlocked when I refresh this tab";
    resumeRow.append(resumeBox, resumeLabel);
    const resumeHint = document.createElement("p");
    resumeHint.className = "security-note";
    resumeHint.textContent = "Closing the tab, Lock, and automatic lock still lock Kin.";
    lockSection.append(lockLabel, lockHint, resumeRow, resumeHint);

    const recoverySection = this.host.section("Backup key for this device");
    const recoveryStatus = document.createElement("p");
    recoveryStatus.className = "security-status";
    recoveryStatus.textContent = "Your backup key unlocks Kin on this device when a passkey can't. Each device has its own, and Kin never stores it.";
    recoverySection.append(recoveryStatus);
    // The current key's label, which this device's exports name.
    const keyLabel = document.createElement("p");
    keyLabel.className = "recovery-key-label";
    keyLabel.hidden = true;
    recoverySection.append(keyLabel);
    void manifestRecoveryLabels(getActiveVault()?.manifest ?? this.host.manifest).then((labels) => {
      if (!labels.length) return;
      keyLabel.textContent = `This device's backup key is ${joinLabels(labels)}. Exports made now open with it.`;
      keyLabel.hidden = false;
    }, () => {});
    const guidance = document.createElement("details");
    guidance.className = "security-guidance";
    const summary = document.createElement("summary");
    summary.textContent = "Backup key guidance";
    guidance.append(summary);
    const list = document.createElement("ul");
    for (const line of [
      "Keep the key somewhere safe outside Kin, such as a password manager. Anyone with it can unlock this device's copy.",
      "The key only opens Kin on this device. Another device has its own key; a password manager may offer you both, so pick the entry the unlock screen names.",
      "If you lose the key but a passkey still works, unlock with the passkey and choose Replace backup key.",
      "If every unlock method is lost, this device's encrypted data cannot be recovered. Another trusted household device can re-approve a fresh device.",
      `To move Kin to another device, export the household. ${EXPORT_STORAGE_RULE}`,
      "Replacing the backup key doesn't change exports you already made: each still opens only with the key label it names.",
    ]) {
      const item = document.createElement("li");
      item.textContent = line;
      list.append(item);
    }
    guidance.append(list);
    recoverySection.append(guidance);
    this.host.button("Replace backup key", () => this.host.showReplacement(), "", recoverySection);

    const backupSection = this.host.section("Backup and move");
    this.host.chatOption = null;
    this.chatExportOption(backupSection);
    this.host.button("Export household", () => this.host.run(() => this.host.downloadArchive()), "", backupSection);
    this.host.button("Restore household", () => this.host.showRestore(), "", backupSection);
    if (navigator.storage?.persist) this.host.button("Request persistent storage", () => this.host.run(async (operation) => {
      const granted = await navigator.storage.persist();
      this.host.assertCurrentOperation(operation);
      this.host.message.textContent = granted ? "This browser granted persistent storage. Keep encrypted backups too." : "Persistent storage was not granted. Keep encrypted backups to protect against browser data loss.";
    }), "", backupSection);
    const backupNote = document.createElement("p");
    backupNote.className = "security-note";
    backupNote.textContent = `Use a Kin export to move or restore your household. ${EXPORT_STORAGE_RULE} Exports are manual, not automatic backups, and do not restore device trust.`;
    backupSection.append(backupNote);
  }
}
