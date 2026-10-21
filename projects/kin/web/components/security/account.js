// A password account's security settings (ADR 0018, #560-#562, #571-#573):
// the passkey (add it, require password and passkey), the password (change
// it) and the backup code (make, print, replace). Shown in Security once the
// member's account summary is loaded; members without an account keep the
// older passkey-unlock and backup-key sections (views.js).
//
// One flow at a time opens inline under its section, asks for the current
// password (every account change does) and runs as the panel's operation.
// Nothing is required: each is offered calmly here and, at quiet moments,
// on Today (components/app/status.js).
// Part of <kin-security>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-security.js lists them).
import {
  accountSecurity,
  accountState,
  addAccountPasskey,
  changeAccountPassword,
  finishPasskeySetup,
  saveBackupCode,
  setRequireBoth,
} from "../../security/account-security.js";
import { PASSWORD_GUIDANCE } from "../../security/account-credentials.js";
import { generateBackupCode } from "../../security/backup-code.js";
import { getActiveVault } from "../../security/local-vault.js";
import { passkeyUnlockSupported } from "../../security/passkey-unlock.js";
import { EventStore } from "../../storage/event-store.js";
import { passwordManagerField } from "./protection.js";

export const LOST_PASSKEY_COPY = "If you lose your passkey (a lost phone, a reset password manager), your backup code gets you back in. Without the passkey, the backup code or another device of yours, Kin can't open your account.";
export const BACKUP_CODE_COPY = "Your backup code opens your account on a new device if you lose your password or passkey. Print it or write it down, and keep it somewhere safe at home. Anyone with it and your username can open your account.";

export class SecurityAccount {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.security = null;
    this.loading = null;
    // The open flow: null, or { kind, ... } (kind: "add-passkey",
    // "finish-passkey", "require-both", "change-password", "backup-code").
    this.flow = null;
  }

  app() { return this.host.closest("kin-app"); }

  identity() { return this.app()?.household?.identity ?? null; }

  /** The summary, when it is this signed-in member's and they have an account. */
  ready() {
    const identity = this.identity();
    return Boolean(identity && this.security && this.security.memberId === identity.memberId && accountState(this.security).account);
  }

  state() { return accountState(this.security); }

  /** Loads (or reloads) the account summary; re-renders the settings once it
   * arrives. Errors leave the older sections in place. */
  refresh({ render = true } = {}) {
    const identity = this.identity();
    if (!identity) return Promise.resolve(null);
    this.loading ??= this.holdsVaultKey(identity).then((holds) => holds
      // Only a device that keeps its member's vault key belongs to a
      // password account; households set up with a passkey and a backup
      // key never ask.
      ? accountSecurity()
      : { username: null, password: false, passkeys: [], memberSince: null, vault: null }).then((security) => {
      this.security = { ...security, memberId: identity.memberId };
      const app = this.app();
      if (app) app.accountSecurity = this.security;
      if (render && this.host.phase === "unlocked" && !this.host.busy && !this.flow) this.host.render();
      app?.ctx?.status?.renderOnboarding?.();
      return this.security;
    }, () => null).finally(() => { this.loading = null; });
    return this.loading;
  }

  async holdsVaultKey(identity) {
    const vaultKey = await this.app()?.household?.syncKeyStore?.accountVaultKey?.(identity.householdId).catch(() => null);
    vaultKey?.fill(0);
    return Boolean(vaultKey);
  }

  /** Opens a flow (from Today's cards or a settings button). */
  async start(kind) {
    if (!this.ready()) await this.refresh({ render: false });
    if (!this.ready()) return false;
    this.wipeFlow();
    this.flow = { kind };
    if (kind === "backup-code") Object.assign(this.flow, await generateBackupCode());
    this.host.render();
    queueMicrotask(() => {
      const target = this.host.querySelector(`[data-account-flow="${kind}"] input:not([tabindex="-1"]), [data-account-flow="${kind}"] button`);
      target?.focus();
      target?.scrollIntoView?.({ block: "center" });
    });
    return true;
  }

  close() {
    this.wipeFlow();
    this.host.render();
  }

  wipeFlow() {
    this.flow?.bytes?.fill(0);
    this.flow = null;
  }

  // ---- Sections ------------------------------------------------------------

  renderPasskeySection() {
    const state = this.state();
    const section = this.host.section("Passkey");
    section.dataset.accountSection = "passkey";
    const supported = passkeyUnlockSupported();
    const status = document.createElement("p");
    status.className = "security-status";
    status.dataset.passkeyUnlock = state.passkey ? "on" : "off";
    status.textContent = state.requireBoth
      ? "On — signing in on a new device asks for your password and your passkey."
      : state.passkey
        ? "On — your passkey signs you in on a new device by itself."
        : state.passkeyNeedsSetup
          ? "Your passkey doesn't open your account on a new device yet."
          : "Off — you sign in with your password.";
    section.append(status);
    if (!state.passkey && !state.passkeyNeedsSetup) {
      this.note(section, "Add a passkey and your face, fingerprint or screen lock signs you in, here and on a new device. Once it's added, your password alone no longer opens your account on a new device, so a stolen copy of Kin's service can't be used to guess it.");
      if (supported) this.flowButton(section, "add-passkey", "Add a passkey", "primary-action");
    } else if (state.passkeyNeedsSetup) {
      this.note(section, "Set it up again so it can sign you in on a new device.");
      if (supported) this.flowButton(section, "finish-passkey", "Set up my passkey");
    } else {
      const local = (this.host.manifest?.wrappers ?? []).some((wrapper) => wrapper.type === "prf");
      this.note(section, local ? "It also unlocks Kin on this device." : "It doesn't unlock Kin on this device yet.");
      if (!local && supported)
        this.host.button("Unlock this device with my passkey", () => this.host.run(() => this.host.addPasskey()), "", section);
      // Require password and passkey (#562): off by default.
      const row = document.createElement("div");
      row.className = "security-chat-option";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = "require-password-and-passkey";
      box.checked = state.requireBoth;
      box.setAttribute("aria-describedby", "require-both-hint");
      const label = document.createElement("label");
      label.htmlFor = box.id;
      label.textContent = "Require password and passkey";
      box.addEventListener("change", () => {
        const on = box.checked;
        box.checked = state.requireBoth;
        void this.start("require-both").then(() => { if (this.flow) this.flow.on = on; this.host.render(); });
      });
      row.append(box, label);
      const hint = this.note(section, state.requireBoth
        ? "Your passkey alone can't open your account. Turn this off to let it sign you in by itself again."
        : "Off: your passkey alone signs you in on a new device. On: it asks for your password too, so someone who gets into the account that syncs your passkey still can't open Kin.");
      hint.id = "require-both-hint";
      section.append(row, hint);
    }
    this.note(section, state.backupCode ? LOST_PASSKEY_COPY : `${LOST_PASSKEY_COPY} Make a backup code below.`);
    if (["add-passkey", "finish-passkey", "require-both"].includes(this.flow?.kind)) this.renderPasswordFlow(section);
  }

  renderPasswordActions(section) {
    if (this.flow?.kind === "change-password") return this.renderChangePassword(section);
    this.flowButton(section, "change-password", "Change password");
  }

  renderBackupCodeSection() {
    const state = this.state();
    const section = this.host.section("Backup code");
    section.dataset.accountSection = "backup-code";
    const status = document.createElement("p");
    status.className = "security-status";
    status.dataset.passkeyUnlock = state.backupCode ? "on" : "off";
    status.textContent = state.backupCode
      ? `You have a backup code${state.backupCodeMadeAt ? `, made ${new Date(state.backupCodeMadeAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}` : ""}.`
      : "You don't have a backup code yet.";
    section.append(status);
    this.note(section, BACKUP_CODE_COPY);
    if (state.backupCode) this.note(section, "It also opens the exports you make, so you no longer need a backup key for each device. A new code replaces this one: the old one stops working at once.");
    if (this.flow?.kind === "backup-code") return this.renderBackupCode(section);
    this.flowButton(section, "backup-code", state.backupCode ? "Make a new backup code" : "Make a backup code", state.backupCode ? "" : "primary-action");
  }

  // ---- Flows -----------------------------------------------------------------

  flowButton(section, kind, label, className = "") {
    return this.host.button(label, () => void this.start(kind), className, section);
  }

  note(parent, value) {
    const line = document.createElement("p");
    line.className = "security-note";
    line.textContent = value;
    parent.append(line);
    return line;
  }

  /** A form with the account's (hidden) username for password managers. */
  form(kind, onSubmit) {
    const form = document.createElement("form");
    form.className = "account-flow";
    form.dataset.accountFlow = kind;
    form.append(passwordManagerField("text", "username", this.security?.username ?? ""));
    form.addEventListener("submit", (event) => { event.preventDefault(); onSubmit(form); });
    return form;
  }

  passwordField(form, { id, label, autocomplete = "current-password", hint = "" }) {
    const caption = document.createElement("label");
    caption.htmlFor = id;
    caption.textContent = label;
    const input = document.createElement("input");
    Object.assign(input, { id, type: "password", autocomplete, required: true, spellcheck: false });
    const described = ["security-alert"];
    form.append(caption, input);
    if (hint) {
      const help = this.note(form, hint);
      help.id = `${id}-hint`;
      described.unshift(help.id);
    }
    input.setAttribute("aria-describedby", described.join(" "));
    return input;
  }

  actions(form, label) {
    const row = document.createElement("div");
    row.className = "first-run-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = label;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    row.append(submit, cancel);
    form.append(row);
  }

  /** Adding, finishing, or require-both on/off: the password, then the passkey. */
  renderPasswordFlow(section) {
    const { kind } = this.flow;
    const on = this.flow.on ?? !this.state().requireBoth;
    const form = this.form(kind, () => {
      const password = input.value;
      input.value = "";
      void this.runFlow(kind, (context) => {
        if (kind === "add-passkey") return this.addPasskey(password, context);
        if (kind === "finish-passkey") return finishPasskeySetup({ password, ...context });
        return setRequireBoth({ on, password, ...context });
      });
    });
    const lead = document.createElement("p");
    lead.textContent = kind === "add-passkey"
      ? "Enter your password, then follow your device's prompt to make the passkey."
      : kind === "finish-passkey"
        ? "Enter your password, then use your passkey."
        : on ? "To require both, enter your password, then use your passkey." : "To let your passkey sign you in by itself again, enter your password, then use your passkey.";
    form.prepend(lead);
    const input = this.passwordField(form, { id: `account-password-${kind}`, label: "Your password" });
    this.actions(form, kind === "add-passkey" ? "Add passkey" : kind === "finish-passkey" ? "Set up passkey" : on ? "Require both" : "Turn off");
    section.append(form);
  }

  renderChangePassword(section) {
    const form = this.form("change-password", () => {
      const current = currentInput.value;
      const next = nextInput.value;
      const again = againInput.value;
      if (next !== again) return this.host.error(new Error("The new passwords don't match. Type the same new password twice."));
      for (const input of [currentInput, nextInput, againInput]) input.value = "";
      void this.runFlow("change-password", (context) => this.changePassword(current, next, context));
    });
    const currentInput = this.passwordField(form, { id: "account-current-password", label: "Current password" });
    const nextInput = this.passwordField(form, { id: "account-new-password", label: "New password", autocomplete: "new-password", hint: PASSWORD_GUIDANCE });
    const againInput = this.passwordField(form, { id: "account-new-password-again", label: "New password again", autocomplete: "new-password" });
    if (this.state().requireBoth) this.note(form, "Your account asks for your password and your passkey, so you'll use your passkey too.");
    this.note(form, "Your other devices keep unlocking with your old password until Kin asks you to sign in there again; your new password takes over from then.");
    this.actions(form, "Change password");
    section.append(form);
  }

  /** The code, a print view and, once saved, the password to turn it on (#573). */
  renderBackupCode(section) {
    const { text } = this.flow;
    const card = document.createElement("div");
    card.className = "backup-code-card";
    card.id = "backup-code-print";
    const title = document.createElement("p");
    title.className = "backup-code-title";
    title.textContent = `Kin backup code${this.security?.username ? ` for ${this.security.username}` : ""}`;
    const code = document.createElement("p");
    code.className = "backup-code";
    code.setAttribute("translate", "no");
    code.setAttribute("aria-label", `Backup code: ${text.split("-").join(", ")}`);
    for (const group of text.split("-")) {
      const part = document.createElement("span");
      part.textContent = group;
      code.append(part, " ");
    }
    const keep = document.createElement("p");
    keep.className = "security-note";
    keep.textContent = "Keep this somewhere safe at home. With your username, it opens your Kin account on a new device and opens your exports. Kin can't show it again.";
    card.append(title, code, keep);
    section.append(card);
    const tools = document.createElement("div");
    tools.className = "first-run-actions";
    this.host.button("Print", () => this.print(), "", tools);
    if (navigator.clipboard?.writeText) this.host.button("Copy", async () => {
      try {
        await navigator.clipboard.writeText(text);
        this.host.message.textContent = "Backup code copied. Paste it somewhere safe, then clear your clipboard.";
      } catch { this.host.message.textContent = "Copy is unavailable. Print the code or write it down."; }
    }, "", tools);
    section.append(tools);
    const form = this.form("backup-code", () => {
      if (!saved.checked) return this.host.error(new Error("Print or save the code first, then tick the box."));
      const password = input.value;
      input.value = "";
      void this.runFlow("backup-code", (context) => this.saveCode(password, context));
    });
    const savedLabel = document.createElement("label");
    savedLabel.className = "recovery-saved";
    const saved = document.createElement("input");
    saved.type = "checkbox";
    saved.id = "backup-code-saved";
    savedLabel.append(saved, " I've printed this code or saved it somewhere safe.");
    form.append(savedLabel);
    const input = this.passwordField(form, { id: "account-password-backup-code", label: "Your password", hint: this.state().backupCode ? "Turning this code on stops your old code working." : "" });
    this.actions(form, "Turn on this code");
    section.append(form);
  }

  /** Prints only the code card (styles/app.css, @media print). */
  print() {
    document.documentElement.classList.add("printing-backup-code");
    const done = () => { document.documentElement.classList.remove("printing-backup-code"); globalThis.removeEventListener("afterprint", done); };
    globalThis.addEventListener("afterprint", done);
    try { globalThis.print(); } finally { setTimeout(done, 1000); }
  }

  /**
   * Runs one account change as the panel's operation, with this device's
   * VK and identity. Afterwards the summary reloads and the settings say
   * what changed; an error stays on the form (the panel's alert).
   */
  async runFlow(kind, change) {
    const app = this.app();
    const identity = this.identity();
    await this.host.run(async (operation) => {
      const store = app?.household?.syncKeyStore;
      const vaultKey = identity ? await store?.accountVaultKey(identity.householdId) : null;
      if (!vaultKey) throw new Error("This device doesn't hold your account's keys, so it can't change how your account opens. Use the device you set Kin up on.");
      try {
        this.host.message.textContent = kind === "change-password" ? "Changing your password…" : "Working…";
        await change({ security: this.security, identity, vaultKey, signal: this.host.operationAbort.signal });
      } finally {
        vaultKey.fill(0);
      }
      this.host.assertCurrentOperation(operation);
      this.wipeFlow();
      await this.refresh({ render: false });
      this.host.assertCurrentOperation(operation);
      this.host.render();
      this.host.message.textContent = {
        "add-passkey": "Passkey added. It signs you in on a new device, and your password alone no longer does.",
        "finish-passkey": "Your passkey signs you in on a new device again.",
        "require-both": this.state().requireBoth ? "Signing in on a new device now asks for your password and your passkey." : "Your passkey signs you in on a new device by itself again.",
        "change-password": "Password changed. Use the new one from now on.",
        "backup-code": "Your backup code is on. Keep it somewhere safe.",
      }[kind];
      this.host.dispatchEvent(new CustomEvent("kin:security-changed", { bubbles: true, composed: true }));
    });
  }

  async addPasskey(password, context) {
    const vault = getActiveVault();
    const { manifest } = await addAccountPasskey({ password, localVault: vault, ...context });
    if (manifest) await this.saveManifest(manifest, vault);
  }

  async changePassword(current, next, context) {
    const vault = getActiveVault();
    const manifest = await changeAccountPassword({ current, next, localVault: vault, ...context });
    if (manifest) await this.saveManifest(manifest, vault);
  }

  async saveCode(password, context) {
    await saveBackupCode({ password, codeBytes: this.flow.bytes, ...context });
  }

  async saveManifest(manifest, vault) {
    await EventStore.updateSecurityManifest(manifest, vault);
    this.host.manifest = await EventStore.securityStatus();
  }
}
