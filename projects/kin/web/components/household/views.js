// The household panel's main views: setup, create, join and member.
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { currentPlatform, householdDeviceName } from "../../platform.js";
import { invitationCode, invitationLink } from "../../pairing-link.js";
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
    if (location.pathname === "/pair" && !this.host.identity)
      return this.renderJoin();
    if (!this.host.identity) return this.renderSetup();
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
      ["Join an existing household", "Someone in your household sends you an invitation code and approves this device.", () => this.host.startIntent("join"), ""],
      ["Add this device to my existing membership", "You already use Kin on another device and want this one too.", () => this.host.startIntent("device"), ""],
    ]) {
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

  renderJoin() {
    if (this.host.claim?.state === "Claimed") {
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
      const activate = this.host.makeButton("Activate with passkey", () =>
        this.host.activateClaim(),
      );
      this.host.setControlDisabled(
        activate,
        !this.host.verifiedInviterFingerprint,
      );
      confirmation.addEventListener("change", () => {
        this.host.verifiedInviterFingerprint = confirmation.checked;
        this.host.setControlDisabled(activate, !confirmation.checked);
      });
      this.host.append(label, activate);
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
        "On a device where you're already in the household, open More → Household → Add another device. Enter the code it shows here, then approve this device from there after comparing the device keys.",
      );
    else if (this.host.intent === "join")
      this.host.text(
        "Ask an adult in the household to open Kin → More → Household access and add you as an Adult or Limited Member. Enter the code they get here. They approve this device after you both compare the device keys.",
      );
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
      this.host.register("claim", { code: code.value, deviceLabel: device.value() });
    });
    this.host.append(form);
    if (this.host.intent && location.pathname !== "/pair")
      this.host.button("Back", () => this.host.startIntent(null), "secondary");
    requestAnimationFrame(() => code.focus());
  }

  renderMember() {
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
          "Add another device",
          () => this.host.createDevicePairing(),
          "secondary",
        );
      }
      if (this.host.syncStatus?.memberKind === "adult")
        this.host.button("Trusted devices", () => this.host.showDevices(), "secondary");
      this.host.button("Household access", () => this.host.showHousehold(), "secondary");
      this.host.button("Log out", () => this.ctx.auth.logout(), "secondary");
      return;
    }
    // A pending invitation past its expiry is shown as ended at once, before
    // the next poll confirms it: never a stale code beside "ended" (#97).
    const lapsed = this.host.pairing.state === "Pending" &&
      Number.isFinite(this.host.pairing.expiresAt) && this.host.pairing.expiresAt <= Date.now();
    const pairingState = lapsed ? "Expired" : this.host.pairing.state;
    const state = document.createElement("p");
    state.className = "pairing-state";
    state.setAttribute("role", "status");
    state.textContent =
      pairingState === "Pending"
        ? "Waiting for another trusted adult to claim this code."
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
