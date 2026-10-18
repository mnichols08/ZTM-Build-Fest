// "Notifications on this device" (#85, #90). Push subscriptions belong to a
// browser, so the switch is per device. The browser's permission prompt
// appears only after "Turn on" is pressed. A push says only that something is
// new: never what, who added it, or how many. Nothing about delivery or
// reading is recorded.
import { currentPlatform } from "../platform.js";

/** Mute choices; the service computes the end on its own clock. */
export const MUTE_CHOICES = Object.freeze([
  ["hour", "Mute for 1 hour"],
  ["night", "Mute for 8 hours"],
  ["indefinite", "Mute until I turn them back on"],
]);

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

/** The service's short fingerprint of an endpoint (server/push-service.mjs). */
export async function endpointTag(endpoint) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
}

/** Whether a browser subscription was made for these server key bytes. */
export function sameServerKey(subscription, key) {
  const current = subscription?.options?.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
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
  async refresh({ identity = true } = {}) {
    if (!this.firstElementChild) this.build();
    const generation = (this.generation = (this.generation ?? 0) + 1);
    // Only a household device has anything to ask the service about.
    if (!identity) { this.hidden = true; return; }
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
    void this.repair(generation);
  }

  /** Keeps the service's copy in step with this browser's subscription,
   * without a prompt: a browser may replace its subscription while Kin is
   * closed (the service worker's own update can fail once the session has
   * expired), or lose it when site data is cleared. */
  async repair(generation) {
    const status = this.status;
    if (!status?.subscribed || this.support() !== "available" || Notification.permission !== "granted") return;
    try {
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      const { publicKey } = await api("/api/push/vapid-public-key");
      const key = applicationServerKey(publicKey);
      // A subscription made for other server keys would only be refused,
      // even when the service holds the same endpoint.
      if (subscription && !sameServerKey(subscription, key)) { await subscription.unsubscribe(); subscription = null; }
      if (subscription && (await endpointTag(subscription.endpoint)) === status.endpointTag) return;
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const { endpoint, keys } = subscription.toJSON();
      const updated = await api("/api/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint, keys }) });
      if (generation === this.generation) { this.status = updated; this.render(); }
    } catch {
      // Left as it is; the next refresh tries again.
    }
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
    if (status.available === false) {
      this.state.textContent = "Notifications aren't set up on this Kin server yet.";
      return;
    }
    if (support !== "available" && !status.subscribed) {
      this.state.textContent = messages[support];
      return;
    }
    if (!status.subscribed) {
      this.state.textContent = "Off.";
      this.actions.append(this.button("Turn on notifications", () => this.turnOn(), "primary-action"));
      return;
    }
    // A timed mute that has ended shows as On, and the page re-renders when
    // it ends rather than leaving "Muted until" on screen.
    clearTimeout(this.unmuteTimer);
    const remaining = status.mutedUntil ? status.mutedUntil - Date.now() : 0;
    if (remaining > 0 && remaining < 2 ** 31 - 1) this.unmuteTimer = setTimeout(function ended() {
      if (!this.isConnected) return;
      if (this.busy) this.unmuteTimer = setTimeout(ended.bind(this), 1000);
      else this.render();
    }.bind(this), remaining + 500);
    const muted = status.mutedIndefinitely || remaining > 0;
    this.state.textContent = !muted ? "On."
      : status.mutedIndefinitely ? "Muted until you turn them back on."
      : `Muted until ${new Date(status.mutedUntil).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`;
    // Separate buttons, not a select: each choice is one deliberate press.
    if (muted) this.actions.append(this.button("Unmute", () => this.mute(null)));
    else for (const [choice, text] of MUTE_CHOICES) this.actions.append(this.button(text, () => this.mute(choice)));
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
    for (const control of this.querySelectorAll("button")) control.disabled = true;
    this.error.textContent = "";
    try {
      await action();
    } catch (error) {
      this.render();
      this.error.textContent = error.message || "Kin couldn't change notifications.";
    } finally {
      this.busy = false;
      for (const control of this.querySelectorAll("button")) control.disabled = false;
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
    if (subscription && !sameServerKey(subscription, key)) { await subscription.unsubscribe(); subscription = null; }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const { endpoint, keys } = subscription.toJSON();
    try {
      this.status = await api("/api/push/subscription", { method: "PUT", body: JSON.stringify({ endpoint, keys }) });
    } catch (error) {
      // The service refused it: don't leave a browser subscription behind.
      await subscription.unsubscribe().catch(() => {});
      throw error;
    }
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

  async mute(choice) {
    this.status = await api("/api/push/mute", { method: "PUT", body: JSON.stringify({ choice }) });
    this.render();
    this.feedback.textContent = choice === null ? "Notifications are back on." : this.state.textContent;
    this.querySelector("button")?.focus();
  }
}

customElements.define("kin-notifications", KinNotifications);
