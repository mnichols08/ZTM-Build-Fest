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
    const controlsDisabled = isBusy || !this.app.store;
    if (isBusy) {
      // The next action replaces the undo toast (#315); undo itself keeps it.
      if (!this.ctx.undo?.running) this.ctx.undo?.hideToast();
      this.app.detail?.deferFocusedControl?.();
      this.app.chat?.deferFocusedControl?.();
      this.app.meals?.deferFocusedControl?.();
      this.app.simpleToday?.deferFocusedControl?.();
    }
    this.app.controlFieldset.disabled = controlsDisabled;
    // Header controls and a phone detail sheet live outside the fieldset.
    this.app.quickAdd.disabled = isBusy || !this.app.store;
    if (this.app.detail?.closest(".detail-sheet")) this.app.detail.disabled = controlsDisabled;
    if (this.app.lockButton) this.app.lockButton.disabled = isBusy;
    this.app.retryButton.disabled = isBusy;
    if (!controlsDisabled) {
      for (const component of [this.app.today, this.app.needs, this.app.shopping, this.app.staples, this.app.areas, this.app.notes, this.app.detail, this.app.chat, this.app.meals, this.app.simpleToday])
        component?.settleDeferredFocus?.();
    }
  }
  setStatus(message) {
    this.app.status.textContent = message;
    clearTimeout(this.app.statusTimer);
    this.app.status.removeAttribute("data-stale");
    if (message) this.app.statusTimer = setTimeout(() => this.app.status.setAttribute("data-stale", "true"), 6_000);
    this.ctx.undo?.syncStatus();
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
  hasHouseholdContent() {
    const state = this.app.state;
    return Boolean(state && [
      "items", "handoffs", "talks", "pulses", "routines", "areas", "notes",
      "playbooks", "referenceRecords", "maintenanceEvents",
    ].some((field) => state[field]?.length));
  }
  updateOnboardingDensity() {
    const card = this.app.onboarding;
    const details = card?.querySelector(".onboarding-details");
    if (!details) return;
    const compact = this.hasHouseholdContent();
    const previous = details.dataset.compact;
    if (previous !== String(compact)) details.open = !compact;
    details.dataset.compact = String(compact);
    card.classList.toggle("onboarding-compact", compact);
    const page = this.app.pages?.get("today");
    page?.classList.toggle("compact-onboarding", compact);
    if (page && this.app.today?.parentElement === page) {
      if (compact && this.app.today.nextElementSibling !== card) this.app.today.after(card);
      else if (!compact && this.app.today.previousElementSibling !== card) this.app.today.before(card);
    }
  }
  renderOnboarding() {
    const card = this.app.onboarding;
    if (!card || !this.app.vault || this.app.vault.locked) return;
    card.replaceChildren();
    card.classList.remove("onboarding-compact");
    const todayPage = this.app.pages?.get("today");
    todayPage?.classList.remove("compact-onboarding");
    if (todayPage && this.app.today?.parentElement === todayPage) this.app.today.before(card);
    const status = this.app.householdStatus;
    const passkeys = this.app.security?.passkeyWrappers?.length ?? 0;
    const heading = document.createElement("h2");
    const goTo = (intent) => {
      this.ctx.navigation.navigate("#household/people");
      this.app.household?.startIntent?.(intent);
    };
    if (status && !status.identity && !status.claimState && status.lifecycle !== "deleted" && status.lifecycle !== "deletion_pending") {
      const details = document.createElement("details");
      details.className = "onboarding-details";
      const summary = document.createElement("summary");
      summary.textContent = "Join or set up your household";
      heading.textContent = "Get started";
      const intro = document.createElement("p");
      intro.textContent = "Kin is ready on this device. Join your family\u0027s existing household, or start a new one if nobody has set it up yet.";
      const choices = document.createElement("div");
      choices.className = "household-choices";
      for (const [label, intent, className] of [
        ["Start a new household", "create", "primary-action"],
        ["Join my household", "join", ""],
        ["Add my device", "device", ""],
        ["Sign in using my phone", "phone", ""],
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
      details.append(summary, heading, intro, choices, note);
      card.append(details);
      card.hidden = false;
      this.updateOnboardingDensity();
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
    // The connection and optional passkey prompts take priority. Once a new
    // household is ready, offer one real first action rather than a tutorial.
    // No sample household events or persisted activity-tracking flag is added.
    if (status?.identity && this.app.state && !this.hasHouseholdContent() && !this.app.firstActionWelcomeDismissed) {
      heading.textContent = "Welcome home";
      const intro = document.createElement("p");
      intro.textContent = "Kin helps your household keep track of tasks, shopping, and things to share. Start by adding one thing you'd like to remember.";
      const start = document.createElement("button");
      start.type = "button";
      start.className = "primary-action";
      start.textContent = "Add something";
      start.addEventListener("click", () => this.app.compose?.input?.focus());
      const later = document.createElement("button");
      later.type = "button";
      later.textContent = "Not now";
      later.addEventListener("click", () => {
        this.app.firstActionWelcomeDismissed = true;
        this.renderOnboarding();
      });
      card.append(heading, intro, start, later);
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
