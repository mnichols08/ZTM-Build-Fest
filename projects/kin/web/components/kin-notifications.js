// "Notifications on this device" (#85, #90). Push subscriptions belong to a
// browser, so the switch is per device. The browser's permission prompt
// appears only after "Turn on" is pressed. A push says only that something is
// new: never what, who added it, or how many. Nothing about delivery or
// reading is recorded.
import { currentPlatform } from "../platform.js";

export const MUTE_CHOICES = Object.freeze([
  ["hour", "For 1 hour", 60 * 60 * 1000],
  ["night", "For 8 hours", 8 * 60 * 60 * 1000],
  // The service caps a mute at a year; a year reads as "until turned back on".
  ["indefinite", "Until I turn them back on", 365 * 24 * 60 * 60 * 1000 - 60 * 1000],
]);
const INDEFINITE_AFTER_MS = 300 * 24 * 60 * 60 * 1000;

const EXPLANATION = "Notifications say only that something is new. They never include what it is or who added it, and Kin doesn't record whether you saw them.";

/** What this browser can do, from plain values (testable without a DOM). */
export function notificationSupport({ hasServiceWorker, hasPushManager, hasNotification, permission, platform }) {
  if (platform?.ios && !platform.standalone) return "ios-home-screen";
  if (!hasServiceWorker || !hasPushManager || !hasNotification) return "unsupported";
  if (permission === "denied") return "blocked";
  return "available";
}

/** The base64url VAPID key as the bytes pushManager.subscribe wants. */
export function applicationServerKey(publicKey) {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (publicKey.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function api(path, init = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.message || "Kin couldn't change notifications."), { code: value.error, status: response.status });
  return value;
}

export class KinNotifications extends HTMLElement {
  connectedCallback() {
    if (!this.firstElementChild) this.build();
    void this.refresh();
  }

  build() {
    this.className = "notification-settings";
    this.setAttribute("role", "group");
    this.setAttribute("aria-labelledby", "notification-settings-heading");
    const heading = document.createElement("h2");
    heading.id = "notification-settings-heading";
    heading.textContent = "Notifications on this device";
    const explanation = document.createElement("p");
    explanation.className = "section-hint";
    explanation.textContent = EXPLANATION;
    this.state = document.createElement("p");
    this.state.className = "notification-state";
    this.actions = document.createElement("div");
    this.actions.className = "appearance-actions";
    this.feedback = document.createElement("p");
    this.feedback.className = "appearance-feedback";
    this.feedback.setAttribute("role", "status");
    this.feedback.setAttribute("aria-live", "polite");
    this.error = document.createElement("p");
    this.error.className = "field-error";
    this.error.setAttribute("role", "alert");
    this.append(heading, explanation, this.state, this.actions, this.error, this.feedback);
    this.hidden = true;
  }

  support() {
    return notificationSupport({
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager: typeof PushManager !== "undefined",
      hasNotification: typeof Notification !== "undefined",
      permission: typeof Notification !== "undefined" ? Notification.permission : "default",
      platform: currentPlatform(),
    });
  }

  /** Loads this device's state from the service. Hidden until this browser
   * is a trusted device of a household (the API refuses otherwise). */
  async refresh() {
    const generation = (this.generation = (this.generation ?? 0) + 1);
    let status;
    try {
      status = await api("/api/push/subscription");
    } catch {
      if (generation === this.generation) this.hidden = true;
      return;
    }
    if (generation !== this.generation) return;
    this.status = status;
    this.hidden = false;
    this.render();
  }

  render() {
    const support = this.support();
    const status = this.status ?? { subscribed: false, mutedUntil: null };
    this.actions.replaceChildren();
    this.error.textContent = "";
    const messages = {
      unsupported: "This browser can't show Kin notifications.",
      "ios-home-screen": "Add Kin to your Home Screen to get notifications. On iPhone and iPad, only the Home Screen app can receive them.",
      blocked: "Notifications are blocked for Kin in this browser's settings. Allow notifications for this site there, then come back to turn them on.",
    };
    if (support !== "available" && !status.subscribed) {
      this.state.textContent = messages[support];
      return;
    }
    if (!status.subscribed) {
      this.state.textContent = "Off.";
      this.actions.append(this.button("Turn on notifications", () => this.turnOn(), "primary-action"));
      return;
    }
    const muted = status.mutedUntil && status.mutedUntil > Date.now();
    this.state.textContent = !muted ? "On."
      : status.mutedUntil - Date.now() > INDEFINITE_AFTER_MS ? "Muted until you turn them back on."
      : `Muted until ${new Date(status.mutedUntil).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`;
    if (muted) this.actions.append(this.button("Unmute", () => this.mute(null)));
    else {
      const label = document.createElement("label");
      label.textContent = "Mute";
      const select = document.createElement("select");
      select.append(new Option("Choose how long", ""));
      for (const [value, text] of MUTE_CHOICES) select.append(new Option(text, value));
      select.addEventListener("change", () => {
        const choice = MUTE_CHOICES.find(([value]) => value === select.value);
        if (choice) void this.mute(Date.now() + choice[2]);
      });
      label.append(select);
      this.actions.append(label);
    }
    this.actions.append(this.button("Turn off notifications", () => this.turnOff()));
  }

  button(text, action, className = "") {
    const value = document.createElement("button");
    value.type = "button";
    value.textContent = text;
    value.className = className;
    value.addEventListener("click", () => void this.run(action));
    return value;
  }

  async run(action) {
    if (this.busy) return;
    this.busy = true;
    for (const control of this.querySelectorAll("button, select")) control.disabled = true;
    this.error.textContent = "";
    try {
      await action();
    } catch (error) {
      this.render();
      this.error.textContent = error.message || "Kin couldn't change notifications.";
    } finally {
      this.busy = false;
      for (const control of this.querySelectorAll("button, select")) control.disabled = false;
    }
  }

  async turnOn() {
    // The permission prompt comes only from this press.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      this.render();
      this.error.textContent = permission === "denied"
        ? "Notifications are blocked for Kin in this browser's settings. Allow them for this site, then try again."
        : "Notifications stay off. Press Turn on again when you're ready.";
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await api("/api/push/vapid-public-key");
    const key = applicationServerKey(publicKey);
    let subscription = await registration.pushManager.getSubscription();
    const sameKey = subscription?.options?.applicationServerKey &&
      new Uint8Array(subscription.options.applicationServerKey).every((byte, index) => byte === key[index]);
    if (subscription && !sameKey) { await subscription.unsubscribe(); subscription = null; }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const { endpoint, keys } = subscription.toJSON();
    this.status = await api("/api/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint, keys }) });
    this.render();
    this.feedback.textContent = "Notifications are on for this device.";
  }

  async turnOff() {
    const registration = await navigator.serviceWorker?.ready;
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
    this.status = await api("/api/push/subscription", { method: "DELETE", body: "{}" });
    this.render();
    this.feedback.textContent = "Notifications are off for this device.";
    this.querySelector("button")?.focus();
  }

  async mute(until) {
    this.status = await api("/api/push/mute", { method: "PUT", body: JSON.stringify({ until }) });
    this.render();
    this.feedback.textContent = until === null ? "Notifications are back on." : this.state.textContent;
    this.querySelector("button, select")?.focus();
  }
}

customElements.define("kin-notifications", KinNotifications);
