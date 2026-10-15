// Busy state, status and alert messages, onboarding prompts and app-update notices.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { passkeyUnlockSupported } from "../../security/passkey-unlock.js";

export class StatusController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  setBusy(isBusy) {
    this.app.busy = isBusy;
    if (!this.app.isConnected) return;
    this.ctx.render.updateCalendarExportButton();
    this.app.main.setAttribute("aria-busy", String(isBusy));
    this.app.compose.disabled = isBusy || !this.app.store;
    this.app.quickAdd.disabled = isBusy || !this.app.store;
    for (const button of this.app.onboarding?.querySelectorAll("button") ?? []) button.disabled = isBusy;
    this.app.today.disabled = isBusy || !this.app.store;
    this.app.needs.disabled = isBusy || !this.app.store;
    this.app.shopping.disabled = isBusy || !this.app.store;
    this.app.staples.disabled = isBusy || !this.app.store;
    this.app.search.disabled = isBusy || !this.app.store;
    this.app.handoffs.disabled = isBusy || !this.app.store;
    this.app.talks.disabled = isBusy || !this.app.store;
    this.app.pulse.disabled = isBusy || !this.app.store;
    this.app.catchUp.disabled = isBusy || !this.app.store;
    if (this.app.detail) this.app.detail.disabled = isBusy || !this.app.store;
    if (this.app.lockButton) this.app.lockButton.disabled = isBusy;
    this.app.routines.disabled = isBusy || !this.app.store;
    this.app.areas.disabled = isBusy || !this.app.store;
    this.app.notes.disabled = isBusy || !this.app.store;
    if (this.app.modeSelect) this.app.modeSelect.disabled = isBusy || !this.app.store;
    this.app.household.disabled = isBusy || !this.app.store;
    if (this.app.appearance) this.app.appearance.disabled = isBusy || !this.app.store;
    if (this.app.householdDefaults) this.app.householdDefaults.disabled = isBusy || !this.app.store;
    if (this.app.installButton) this.app.installButton.disabled = isBusy;
    for (const button of this.app.main.querySelectorAll("kin-responsibility button"))
      button.disabled = isBusy;
    this.app.retryButton.disabled = isBusy;
  }
  setStatus(message) {
    this.app.status.textContent = message;
    clearTimeout(this.app.statusTimer);
    this.app.status.removeAttribute("data-stale");
    if (message) this.app.statusTimer = setTimeout(() => this.app.status.setAttribute("data-stale", "true"), 6_000);
  }
  clearAlert() {
    this.app.feedback?.classList.remove("app-feedback-inline");
    this.app.alert.textContent = "";
    this.app.alert.hidden = true;
    this.app.retryButton.hidden = true;
    this.app.retryAction = null;
    this.app.retryIntent = null;
    this.app.suspendedRetry = null;
  }
  showAlert(message, retryAction = null, retryIntent = null) {
    if (!this.app.vault || this.app.vault.locked) return;
    this.app.alert.textContent = message;
    this.app.alert.hidden = false;
    this.app.retryAction = retryAction;
    this.app.retryIntent = retryIntent;
    this.app.retryButton.hidden = typeof retryAction !== "function";
  }
  showUpdateNotice() {
    if (this.app.updateNotice) this.app.updateNotice.hidden = false;
  }
  // The onboarding card on Today explains the next step until the device has a
  // household and a passkey; every action it offers is the ordinary flow.
  renderOnboarding() {
    const card = this.app.onboarding;
    if (!card || !this.app.vault || this.app.vault.locked) return;
    card.replaceChildren();
    const status = this.app.householdStatus;
    const passkeys = this.app.security?.passkeyWrappers?.length ?? 0;
    const heading = document.createElement("h2");
    const goTo = (intent) => {
      this.ctx.navigation.navigate("#household/people");
      this.app.household?.startIntent?.(intent);
    };
    if (status && !status.identity && !status.claimState && status.lifecycle !== "deleted" && status.lifecycle !== "deletion_pending") {
      heading.textContent = "Get started";
      const intro = document.createElement("p");
      intro.textContent = "This device is protected. Next, connect it to your household so it can sync with other people and devices.";
      const choices = document.createElement("div");
      choices.className = "household-choices";
      for (const [label, intent, className] of [
        ["Create a household", "create", "primary-action"],
        ["Join an existing household", "join", ""],
        ["Add this device to my existing membership", "device", ""],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (className) button.className = className;
        button.addEventListener("click", () => goTo(intent));
        choices.append(button);
      }
      const note = document.createElement("p");
      note.className = "section-hint";
      note.textContent = "You can keep using Kin on this device meanwhile; everything stays encrypted here.";
      card.append(heading, intro, choices, note);
      card.hidden = false;
      return;
    }
    if (status?.claimState === "Claimed" || status?.claimState === "Confirmed") {
      heading.textContent = status.claimState === "Confirmed" ? "Almost there" : "Waiting for approval";
      const intro = document.createElement("p");
      intro.textContent = status.claimState === "Confirmed"
        ? "Your device was approved. Open Household → People & devices to compare the device key and finish activating this device."
        : "This device needs approval from an existing household member. Keep Kin open on both devices and compare the device keys together.";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open People & devices";
      open.addEventListener("click", () => { this.ctx.navigation.navigate("#household/people"); this.app.household?.scrollIntoView?.({ block: "start" }); });
      card.append(heading, intro, open);
      card.hidden = false;
      return;
    }
    if (status?.identity && passkeys === 0 && passkeyUnlockSupported() && !this.app.passkeyPromptDismissed) {
      heading.textContent = "Unlock faster next time";
      const intro = document.createElement("p");
      intro.textContent = "Turn on passkey unlock so your face, fingerprint, or screen lock opens Kin on this device. Your recovery key stays as a backup.";
      const turnOn = document.createElement("button");
      turnOn.type = "button";
      turnOn.className = "primary-action";
      turnOn.textContent = "Turn on passkey unlock";
      turnOn.addEventListener("click", async () => {
        turnOn.disabled = true;
        try {
          await this.app.security.run(() => this.app.security.addPasskey());
          if (this.app.security.alert.textContent) this.showAlert(this.app.security.alert.textContent);
          else this.ctx.status.setStatus("Passkey unlock is on for this device.");
        } finally { this.renderOnboarding(); }
      });
      const later = document.createElement("button");
      later.type = "button";
      later.textContent = "Not now";
      later.addEventListener("click", () => { this.app.passkeyPromptDismissed = true; this.renderOnboarding(); });
      card.append(heading, intro, turnOn, later);
      card.hidden = false;
      return;
    }
    card.hidden = true;
  }

  // Registers the offline shell worker; an installed update shows a calm notice.
  registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", this.app.onServiceWorkerMessage);
    navigator.serviceWorker.addEventListener("controllerchange", this.app.onControllerChange);
    const release = document.querySelector('meta[name="kin-version"]')?.content;
    void navigator.serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(release ?? "")}`).then((registration) => {
      this.app.updateRegistration = registration;
      if (registration.waiting && navigator.serviceWorker.controller) this.showUpdateNotice();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) this.showUpdateNotice();
        });
      });
    }).catch(() => {
      // Online use still follows the same security boundary without offline cache.
    });
  }
}
