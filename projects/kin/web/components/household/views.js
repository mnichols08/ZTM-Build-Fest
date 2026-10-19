// The household panel's main views: setup, create, join and member.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { currentPlatform, householdDeviceName } from "../../platform.js";
import { invitationCode, invitationLink } from "../../pairing-link.js";
import { consumeOpenedSignInLink } from "../../device-link.js";
import { CODE_ARRIVAL_COPY, intentConflict, inviterPathCopy, joinerPathCopy } from "./pairing-path.js";
import "../kin-qr.js";
import "../kin-qr-scanner.js";

/** Invitation states that mean the code no longer works. */
const ENDED = {
  Expired: "This invitation ended: it expired.",
  Revoked: "This invitation ended: it was revoked.",
};

export class HouseholdViews {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
  }

  /** States which pairing path is in progress and whose identity the device
   * will carry, before anyone confirms anything (#223). */
  showPath({ title, detail }) {
    const heading = document.createElement("h3");
    heading.className = "pairing-path";
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.className = "pairing-path-detail";
    paragraph.textContent = detail;
    this.host.append(heading, paragraph);
  }

  /** The path chosen before the code was entered, when it contradicts the
   * code's real purpose; null otherwise. */
  claimConflict() {
    return intentConflict(this.host.claimIntent, this.host.claim?.purpose);
  }

  // The device's automatic name ("Chrome on iPhone"), shown so people know
  // how it will appear. Nobody types a name here: it is the only name the
  // server learns, and a nickname is set later in Trusted devices, where it
  // stays encrypted (#71).
  deviceNameField() {
    const automatic = householdDeviceName(currentPlatform());
    const note = document.createElement("p");
    note.className = "device-name";
    note.textContent = `This device will show as “${automatic}”. You can give it a nickname later.`;
    return { element: note, value: () => automatic };
  }

  render() {
    clearInterval(this.host.timer);
    this.host.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent =
      location.pathname === "/pair" ? "Join a household" : "Household";
    this.host.append(heading);
    if (this.host.householdLifecycle?.state === "deletion_pending")
      return this.ctx.lifecycle.renderDeletionPending();
    if (this.host.householdLifecycle?.state === "deleted")
      return this.ctx.lifecycle.renderDeleted();
    if (!window.PublicKeyCredential)
      return this.host.message(
        "Passkeys are unavailable in this browser. Use a current browser with a configured screen lock.",
        true,
      );
    if (this.host.intent === "phone" && !this.host.identity && !this.host.claim)
      return this.ctx.link.render();
    if (location.pathname === "/pair" && !this.host.identity)
      return this.renderJoin();
    if (!this.host.identity) return this.renderSetup();
    if (consumeOpenedSignInLink())
      this.host.message("That was a computer's sign-in code. To approve it, choose Add a computer below and scan it there.");
    if (this.host.prefilledCode) {
      // An invitation opened on a device that is already a member: say so,
      // and don't keep the code (#97).
      this.host.prefilledCode = "";
      this.host.message("This device is already in a household, so the invitation code was not used.");
    }
    this.host.renderMember();
    this.host.disabled = this.host.disabled;
  }

  renderSetup() {
    if (this.host.intent === "create") return this.renderCreate();
    if (this.host.intent === "join" || this.host.intent === "device") return this.renderJoin();
    this.host.text(
      "Your recovery key and passkey protect this device's copy of Kin. Household membership is separate: an existing member approves this device, and then it syncs with theirs.",
    );
    const prompt = this.host.text("How would you like to get started?");
    prompt.className = "household-prompt";
    const choices = document.createElement("div");
    choices.className = "household-choices";
    for (const [label, description, action, className] of [
      ["Create a household", "Start a brand-new household on this device. Only one person in a household does this.", () => this.host.startIntent("create"), "primary-action"],
      ["Join an existing household", "Someone in the household invited you. You'll get your own member identity, with access set by your role, and approve this device.", () => this.host.startIntent("join"), ""],
      ["Add my device", "You already use Kin on another device, such as a phone. This stays under your member identity, so you won't be notified about your own changes.", () => this.host.startIntent("device"), ""],
      ["Sign in with your phone", "You're already signed in to Kin on a phone. Scan this computer's code with it, then type the 6-digit code it shows.", () => this.host.startIntent("phone"), ""],
    ].filter(([label]) => label !== "Sign in with your phone" || !this.host.claim)) {
      const choice = document.createElement("div");
      choice.className = "household-choice";
      const button = this.host.makeButton(label, action, className);
      const text = document.createElement("p");
      text.className = "household-choice-hint";
      text.textContent = description;
      choice.append(button, text);
      choices.append(choice);
    }
    this.host.append(choices);
    const note = this.host.text("Already a member on this device but logged out?");
    note.className = "household-choice-hint";
    this.host.button("Log in with passkey", () => this.host.login(), "secondary");
  }

  renderCreate() {
    this.host.text(
      "This starts a brand-new household with you as its first adult. If someone in your household already uses Kin, go back and join theirs instead; a phone that joins never creates a second household.",
    );
    this.host.text(
      "Kin creates a passkey for this household on this device. Your face, fingerprint, or screen lock then confirms household actions and can unlock Kin.",
    );
    const form = document.createElement("form");
    const device = this.deviceNameField();
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "primary-action";
    submit.textContent = "Create household with passkey";
    form.append(device.element, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.host.register("bootstrap", { deviceLabel: device.value() });
    });
    this.host.append(form);
    this.host.button("Back", () => this.host.startIntent(null), "secondary");
  }

  /** Opens the camera scanner in place of the Scan button. A scanned
   * invitation fills the code field; the person still checks it and creates
   * a passkey, and an adult still approves (#97). */
  openInvitationScanner(area, trigger, field, status) {
    const scanner = document.createElement("kin-qr-scanner");
    const close = () => {
      scanner.remove();
      trigger.hidden = false;
    };
    scanner.addEventListener("kin-qr-scan", (event) => {
      const scanned = invitationCode(event.detail.url);
      close();
      if (scanned) {
        field.value = scanned;
        status.textContent = "Code filled in from the invitation. Check it, then continue.";
      } else {
        status.textContent = "That Kin code isn't an invitation. Scan the invitation's code, or type it.";
      }
      field.focus();
    });
    for (const type of ["kin-qr-manual", "kin-qr-cancel"]) {
      scanner.addEventListener(type, () => {
        close();
        status.textContent = "";
        field.focus();
      });
    }
    trigger.hidden = true;
    status.textContent = "";
    area.append(scanner);
    // The button that had focus is hidden; the scanner's own start takes it.
    scanner.querySelector?.("button.primary-action")?.focus();
  }

  /** Activation needs the fingerprint comparison and, when the code's path
   * contradicts the chosen one, an explicit acknowledgement. */
  activationReady() {
    return Boolean(this.host.verifiedInviterFingerprint) &&
      (!this.claimConflict() || Boolean(this.host.acknowledgedPathConflict));
  }

  renderJoin() {
    if (this.host.claim?.state === "Claimed") {
      const path = joinerPathCopy(this.host.claim.purpose);
      this.showPath(path);
      const conflict = this.claimConflict();
      if (conflict) this.host.message(conflict, true);
      const next = this.host.text(path.next);
      if (next) next.className = "pairing-next-step";
      this.host.message(
        ["device", "replacement"].includes(this.host.claim.purpose)
          ? "This device is ready. Your existing trusted device must approve it before access is restored."
          : this.host.claim.purpose === "member-recovery"
            ? "Your fresh passkey and device are ready. The other household adult must authorize recovery before access is restored. Your old devices will stop working."
            : "Your identity is ready. The existing adult must approve this device before you can join.",
      );
      this.host.showFingerprint(
        "Compare this device key with the approving adult",
        this.host.localFingerprint,
      );
      this.host.showFingerprint(
        "Compare the approving device key",
        this.host.claim.inviterKeyFingerprint,
      );
      if (
        !this.host.localFingerprint ||
        this.host.claim.syncKeyFingerprint !== this.host.localFingerprint ||
        !this.host.claim.inviterKeyFingerprint
      )
        this.host.message(
          "This device key does not match the approval request. Cancel this request and try again.",
          true,
        );
      return;
    }
    if (this.host.claim?.state === "Confirmed") {
      if (!this.host.localFingerprint || this.host.claim.syncKeyFingerprint !== this.host.localFingerprint) {
        this.host.message("This device key changed during security migration. Cancel this pairing and request a new invitation before activation.", true);
        return;
      }
      this.showPath(joinerPathCopy(this.host.claim.purpose));
      this.host.message(
        "Approval succeeded. Use your passkey once more to activate this device.",
      );
      this.host.showFingerprint(
        "Compare the approving device key",
        this.host.claim.inviterKeyFingerprint,
      );
      const confirmation = document.createElement("input");
      confirmation.type = "checkbox";
      confirmation.checked = this.host.verifiedInviterFingerprint;
      const label = document.createElement("label");
      label.append(
        confirmation,
        document.createTextNode(
          " I compared this fingerprint on both devices.",
        ),
      );
      // A code on a different path than the one chosen is never activated
      // silently: the person must acknowledge the switch first (#223).
      const conflict = this.claimConflict();
      let acknowledgement = null;
      if (conflict) {
        this.host.message(conflict, true);
        const accepted = document.createElement("input");
        accepted.type = "checkbox";
        accepted.name = "path-acknowledged";
        accepted.checked = Boolean(this.host.acknowledgedPathConflict);
        acknowledgement = document.createElement("label");
        acknowledgement.append(
          accepted,
          document.createTextNode(` I understand: ${joinerPathCopy(this.host.claim.purpose).title.toLowerCase()}.`),
        );
        accepted.addEventListener("change", () => {
          this.host.acknowledgedPathConflict = accepted.checked;
          this.host.setControlDisabled(activate, !this.activationReady());
        });
      }
      const activate = this.host.makeButton("Activate with passkey", () =>
        this.host.activateClaim(),
      );
      this.host.setControlDisabled(activate, !this.activationReady());
      confirmation.addEventListener("change", () => {
        this.host.verifiedInviterFingerprint = confirmation.checked;
        this.host.setControlDisabled(activate, !this.activationReady());
      });
      this.host.append(label, ...(acknowledgement ? [acknowledgement] : []), activate);
      return;
    }
    if (this.host.claim) {
      const messages = {
        Expired: "This pairing request expired. Enter a new code to continue.",
        Revoked:
          "This pairing request was revoked. Enter a new code to continue.",
        Rejected:
          "This pairing request was rejected. Enter a new code to continue.",
      };
      this.host.message(
        messages[this.host.claim.state] ??
          "This pairing request is no longer available. Enter a new code to continue.",
        true,
      );
      this.host.claim = null;
      this.host.prefilledCode = "";
    }
    if (this.host.intent === "device")
      this.host.text(
        "On a device where you're already in the household, open People & devices → Add my device. Enter the code it shows here, then approve this device from there after comparing the device keys.",
      );
    else if (this.host.intent === "join")
      this.host.text(
        "Ask an adult in the household to open Kin → More → Household access and add you as an Adult or Limited Member. Enter the code they get here. They approve this device after you both compare the device keys.",
      );
    else if (location.pathname === "/pair")
      // Arrived from a code link without choosing a path first (#264).
      this.host.text(CODE_ARRIVAL_COPY);
    this.host.text(
      "A code starts a short-lived invitation or recovery request. You must create a fresh passkey, and an existing trusted adult must still approve this device. No household details or encryption keys are shown before approval. Entering a code never creates a second household.",
    );
    const form = document.createElement("form");
    const codeLabel = document.createElement("label");
    codeLabel.textContent = "Pairing code";
    const code = document.createElement("input");
    code.name = "code";
    code.required = true;
    code.autocomplete = "one-time-code";
    code.inputMode = "text";
    code.maxLength = 9;
    code.placeholder = "F7KM-Q2DX";
    code.value = this.host.prefilledCode;
    this.host.prefilledCode = "";
    code.setAttribute("aria-describedby", "pair-help");
    const help = document.createElement("p");
    help.id = "pair-help";
    help.className = "hint";
    help.textContent = "Codes ignore case and punctuation.";
    const device = this.deviceNameField();
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Create passkey and request approval";
    codeLabel.append(code);
    const scanArea = document.createElement("div");
    scanArea.className = "pairing-scan";
    const scanStatus = document.createElement("p");
    scanStatus.className = "hint";
    scanStatus.setAttribute("role", "status");
    const scan = this.host.makeButton("Scan invitation", () => this.openInvitationScanner(scanArea, scan, code, scanStatus), "secondary");
    scan.type = "button";
    scanArea.append(scan, scanStatus);
    form.append(codeLabel, help, scanArea, device.element, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      // Remember the path chosen before the code was entered, so a code on a
      // different path can be flagged instead of silently switching (#223).
      this.host.claimIntent = this.host.intent;
      this.host.acknowledgedPathConflict = false;
      this.host.register("claim", { code: code.value, deviceLabel: device.value() });
    });
    this.host.append(form);
    // Someone already in the household can sign this computer in with
    // their phone instead of a code (#100).
    const phone = this.host.text("Already signed in to Kin on your phone?");
    phone.className = "household-choice-hint";
    this.host.button("Sign in with your phone", () => this.host.startIntent("phone"), "secondary");
    if (this.host.intent && location.pathname !== "/pair")
      this.host.button("Back", () => this.host.startIntent(null), "secondary");
    requestAnimationFrame(() => code.focus());
  }

  /** Puts the name editor in `slot` once this member's current name is
   * known. A failed read still offers it (as "Set my name"); a slot the
   * panel has since replaced is left alone. */
  async fillNameSlot(slot) {
    let current = null;
    try {
      const names = (await this.host.memberNames.load()) ?? [];
      current = names.find((entry) => entry?.memberId === this.host.identity?.memberId)?.preferredName ?? null;
    } catch { /* Offer the editor without the current name. */ }
    if (slot.isConnected === false) return;
    slot.replaceChildren(this.ctx.membership.nameControl(current, { onSaved: () => this.host.render() }));
  }

  renderMember() {
    // Add a computer (#101) takes the panel while it is open.
    if (this.ctx.linkApproval?.open) return this.ctx.linkApproval.render();
    this.host.text("This device belongs to an authenticated household member.");
    if (this.host.syncStatus?.memberKind === "temporary" && this.host.syncStatus.memberExpiresAt)
      this.host.text(`Temporary household access · ends ${new Date(this.host.syncStatus.memberExpiresAt).toLocaleString()}`);
    if (this.host.syncKeyError) {
      this.host.message(this.host.syncKeyError, true);
    } else if (this.host.syncStatus?.enabled) {
      this.host.text(
        this.host.syncStatus.rotationPending
          ? "Device sync is paused while trusted-device access updates."
          : "Device sync is on for this household.",
      );
      this.host.button("Check sync", () => this.ctx.api.requestSync(), "secondary");
    } else {
      if (this.host.syncStatus?.memberKind === "adult")
        this.host.button("Enable device sync", () => this.host.enableSync());
      else
        this.host.text("Device sync is off. Ask a household Adult to enable it.");
    }
    if (!this.host.pairing) {
      if (this.host.syncStatus?.memberKind === "adult" && !this.host.syncKeyError) {
        this.host.button(
          "Add my device",
          () => this.host.createDevicePairing(),
          "secondary",
        );
        // Sign in a computer by scanning its code (#101).
        this.host.button("Add a computer", () => this.ctx.linkApproval.start(), "secondary");
      }
      if (this.host.syncStatus?.memberKind === "adult")
        this.host.button("Trusted devices", () => this.host.showDevices(), "secondary");
      // Any member can choose the name their household sees (#225), here on
      // the panel every member reaches: the trusted-device list is Adults
      // only. Names are read back from synced history, so this needs sync.
      if (this.host.memberNames?.rename && this.host.syncStatus?.enabled) {
        const hint = this.host.text("Choose the name your household sees. It changes no access.");
        if (hint) hint.className = "household-choice-hint";
        const slot = document.createElement("div");
        slot.className = "member-name-slot";
        this.host.append(slot);
        void this.fillNameSlot(slot);
      }
      this.host.button("Household access", () => this.host.showHousehold(), "secondary");
      this.host.button("Log out", () => this.ctx.auth.logout(), "secondary");
      return;
    }
    // A pending invitation past its expiry is shown as ended at once, before
    // the next poll confirms it: never a stale code beside "ended" (#97).
    const lapsed = this.host.pairing.state === "Pending" &&
      Number.isFinite(this.host.pairing.expiresAt) && this.host.pairing.expiresAt <= Date.now();
    const pairingState = lapsed ? "Expired" : this.host.pairing.state;
    const path = inviterPathCopy(this.host.pairing.purpose, this.host.pairing.memberKind);
    if (["Pending", "Claimed"].includes(pairingState)) this.showPath(path);
    const state = document.createElement("p");
    state.className = "pairing-state";
    state.setAttribute("role", "status");
    state.textContent =
      pairingState === "Pending"
        ? path.waiting
        : this.host.pairing.state === "Claimed"
          ? ["device", "replacement"].includes(this.host.pairing.purpose)
            ? `${this.host.pairing.deviceLabel || "This device"} is awaiting approval for your account.`
            : this.host.pairing.purpose === "member-recovery"
              ? `${this.host.pairing.deviceLabel || "The recovery device"} is awaiting authorization. Approval revokes that adult's old credentials and devices.`
              : `${this.host.pairing.deviceLabel || "The other device"} is awaiting your approval.`
          : ENDED[pairingState]
            ? ENDED[pairingState]
            : typeof this.host.pairing.state === "string"
              ? `Pairing ${this.host.pairing.state.toLowerCase()}.`
              : "Kin could not read the pairing status. Revoke this request or reload before continuing.";
    this.host.append(state);
    if (["Pending", "Claimed"].includes(pairingState)) {
      if (pairingState === "Pending")
        this.host.showFingerprint(
          "Compare this household device key",
          this.host.localFingerprint,
        );
      // While the invitation waits, a QR code carries it, beside the code
      // that can always be typed (#97). It is never shown once the code has
      // been claimed or has ended.
      if (pairingState === "Pending" && this.host.pairing.code) {
        const qr = document.createElement("kin-qr");
        qr.className = "pairing-qr";
        qr.label = "QR code for this invitation. Scan it with the joining device's camera.";
        qr.expiredMessage = "This invitation ended.";
        qr.code = "";
        qr.value = invitationLink(location.origin, this.host.pairing.code);
        qr.expiresAt = this.host.pairing.expiresAt;
        this.host.append(qr);
      }
      if (this.host.pairing.code) {
        const code = document.createElement("output");
        code.className = "pairing-code";
        code.textContent = this.host.pairing.code;
        code.setAttribute(
          "aria-label",
          `Pairing code ${[...this.host.pairing.code].join(" ")}`,
        );
        this.host.append(code);
      }
      this.host.countdown = document.createElement("p");
      this.host.countdown.className = "pairing-countdown";
      this.host.append(this.host.countdown);
      this.ctx.pairing.updateCountdown();
      this.host.timer = setInterval(() => this.ctx.pairing.updateCountdown(), 1000);
      const actions = document.createElement("div");
      actions.className = "pairing-actions";
      if (this.host.pairing.code) {
        actions.append(
          this.host.makeButton("Copy code", () => this.ctx.pairing.copyCode()),
          this.host.makeButton("Share invitation", () => this.ctx.pairing.share(), "secondary"),
        );
      }
      if (this.host.pairing.state === "Claimed") {
        const fingerprint = this.host.pairing.syncKeyFingerprint;
        this.host.showFingerprint(
          "Confirm this matches the joining device",
          fingerprint,
        );
        const approve = this.host.makeButton("Approve with passkey", () =>
          this.ctx.pairing.approve(),
        );
        this.host.setControlDisabled(
          approve,
          !fingerprint || this.host.verifiedFingerprint !== fingerprint,
        );
        if (fingerprint) {
          const label = document.createElement("label");
          const confirmation = document.createElement("input");
          confirmation.type = "checkbox";
          confirmation.checked = this.host.verifiedFingerprint === fingerprint;
          confirmation.addEventListener("change", () => {
            this.host.verifiedFingerprint = confirmation.checked
              ? fingerprint
              : null;
            this.host.setControlDisabled(approve, !confirmation.checked);
          });
          label.append(
            confirmation,
            document.createTextNode(
              " I compared this fingerprint on both devices.",
            ),
          );
          actions.append(label);
        } else {
          this.host.message(
            "This device has no verifiable sync key. Cancel this request and pair again with an updated Kin device.",
            true,
          );
        }
        actions.append(approve);
      }
      actions.append(this.host.makeButton("Revoke", () => this.ctx.pairing.revoke(), "danger"));
      this.host.append(actions);
      this.ctx.pairing.pollPairing();
    } else {
      this.host.button(
        "Back to household",
        () => {
          this.host.pairing = null;
          this.host.render();
        },
        "secondary",
      );
    }
  }
}
