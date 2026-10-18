// Signing in on a computer with a phone (#98): the computer's side (#100).
//
// The computer makes its device keys here, asks the service for a sign-in
// request and shows it as a QR code. A member scans it with Kin on a phone
// that is already signed in and approves with a passkey; the phone then
// shows a 6-digit code, and typing it here finishes the sign-in. The code
// only reaches the computer in front of the person, so a QR code shown
// somewhere else can't be completed.
//
// - A computer that already has a device in a household offers that
//   device's keys, so a returning computer keeps its device and its history.
//   The service says whether its device cookie names that device; if not,
//   the computer starts again with fresh keys and joins as a new device.
// - The QR code replaces itself when the request expires, a few times, then
//   stops. Its countdown is plain text: nothing is announced every second.
// - Cancel, leaving the screen, or Kin locking ends the request.
//
// Part of <kin-household>: state stays on the element (`this.host`), and
// `this.ctx.<part>` reaches the other parts (kin-household.js lists them).
import { currentPlatform, householdDeviceName } from "../../platform.js";
import { cleanLinkCode, isLinkCode, LINK_CODE_LENGTH, signInLink } from "../../device-link.js";

/** How often the computer asks whether the phone has approved. */
export const SIGN_IN_POLL_MS = 2_000;
/** Replacement QR codes shown before the screen stops and asks. */
export const MAX_SIGN_IN_REFRESHES = 4;

export const SIGN_IN_STEPS = "On your phone, open Kin → People & devices → Add a computer → Scan.";

const ENDED_NOTICE = "This sign-in request ended. Nothing was signed in.";

function remaining(expiresAt) {
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export class HouseholdLink {
  constructor(ctx) {
    this.ctx = ctx;
    this.host = ctx.host;
    /** The request on screen: { requestId, secret, fingerprint, expiresAt,
     * state, keys: "existing" | "pending", deviceId, refreshes }. */
    this.request = null;
    this.ended = null;
    this.starting = false;
    this.countdown = null;
    this.ticker = null;
    this.poller = null;
    this.focusNext = null;
  }

  /** Opens the screen and starts a request. */
  async begin() {
    this.stop();
    this.request = null;
    this.ended = null;
    this.starting = true;
    this.focusNext = "heading";
    this.host.render();
    await this.host.run(async () => {
      try {
        this.request = await this.create();
      } finally {
        // Shown before any failure's message, which render() would clear.
        this.starting = false;
        this.focusNext = this.request ? "heading" : null;
        this.host.render();
      }
    });
    this.starting = false;
  }

  /** A new request for this computer, with the keys it should offer. */
  async create({ refreshes = 0 } = {}) {
    const store = await this.ctx.api.openSyncKeyStore();
    const returning = await store.latestBoundDevice();
    const pending = async () => (await store.getOrCreatePendingDevice()).publicKeys;
    const ask = (syncPublicKeys) => this.host.api("/api/link/requests", {
      method: "POST",
      body: JSON.stringify({ syncPublicKeys, deviceLabel: householdDeviceName(currentPlatform()) }),
    });
    let created = await ask(returning?.publicKeys ?? (await pending()));
    let keys = returning ? "existing" : "pending";
    if (returning && !created.returning) {
      // Its device cookie doesn't name that device (signed out elsewhere,
      // removed, or cookies cleared): join as a new device with fresh keys.
      this.release(created);
      created = await ask(await pending());
      keys = "pending";
    }
    return {
      requestId: created.requestId,
      secret: created.secret,
      fingerprint: created.fingerprint,
      expiresAt: created.expiresAt,
      state: "pending",
      keys,
      deviceId: keys === "existing" ? returning.deviceId : null,
      refreshes,
    };
  }

  /** The QR code's replacement once a request expires unscanned. */
  async refresh() {
    const current = this.request;
    if (!current || current.state !== "pending" || current.refreshes >= MAX_SIGN_IN_REFRESHES) return null;
    // Ended first, so the service's per-client cap never counts it.
    await this.release(current);
    const next = await this.create({ refreshes: current.refreshes + 1 });
    if (this.request !== current) {
      this.release(next);
      return null;
    }
    this.request = next;
    this.schedulePoll();
    return { value: this.link(next), code: "", expiresAt: next.expiresAt };
  }

  link(request) {
    return signInLink(location.origin, request);
  }

  /** Ends a request with the service, best effort (keepalive survives the
   * page going away). */
  release(request) {
    if (!request?.requestId || !request.secret) return Promise.resolve();
    return fetch(`/api/link/requests/${request.requestId}`, {
      method: "DELETE",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: request.secret }),
    }).catch(() => {});
  }

  /** Cancel: ends the request and returns to the choices. */
  cancel() {
    this.release(this.request);
    this.stop();
    this.request = null;
    this.ended = null;
    this.host.startIntent(null);
  }

  /** Kin locked or the element left the page. */
  abandon() {
    this.release(this.request);
    this.stop();
    this.request = null;
  }

  stop() {
    clearInterval(this.ticker);
    clearTimeout(this.poller);
    this.ticker = null;
    this.poller = null;
  }

  end(notice = ENDED_NOTICE) {
    this.release(this.request);
    this.stop();
    this.request = null;
    this.ended = notice;
    this.focusNext = "heading";
    this.host.render();
  }

  schedulePoll() {
    clearTimeout(this.poller);
    this.poller = setTimeout(() => this.poll(), SIGN_IN_POLL_MS);
  }

  async poll() {
    const request = this.request;
    if (!request || !this.host.isConnected) return;
    let status;
    try {
      status = await this.host.api(`/api/link/requests/${request.requestId}/status`, {
        method: "POST",
        body: JSON.stringify({ secret: request.secret }),
      });
    } catch (error) {
      if (this.request !== request) return;
      if (error.code === "link_unavailable") {
        // An unscanned request that ran out is the QR code's to replace.
        if (request.state === "pending" && request.expiresAt <= Date.now()) return this.schedulePoll();
        return this.end();
      }
      return this.schedulePoll();
    }
    if (this.request !== request) return;
    if (status.state === "approved" && request.state === "pending") {
      request.state = "approved";
      request.expiresAt = status.expiresAt;
      this.focusNext = "code";
      this.host.render();
      this.announce("Your phone approved this computer. Type the 6-digit code it shows.");
    } else if (status.state === "ended") {
      if (request.state === "pending" && request.expiresAt <= Date.now()) return this.schedulePoll();
      return this.end();
    } else if (status.state === "done") {
      return;
    }
    this.schedulePoll();
  }

  announce(text) {
    if (this.status) this.status.textContent = text;
  }

  async complete(code) {
    const request = this.request;
    if (!request || request.state !== "approved") return;
    const digits = cleanLinkCode(code);
    if (!isLinkCode(digits)) {
      this.announce(`Type all ${LINK_CODE_LENGTH} digits from your phone.`);
      this.field?.focus();
      return;
    }
    await this.host.run(async () => {
      let result;
      try {
        result = await this.host.api(`/api/link/requests/${request.requestId}/complete`, {
          method: "POST",
          body: JSON.stringify({ secret: request.secret, code: digits }),
        });
      } catch (error) {
        if (this.request !== request) return;
        if (error.code === "link_code_mismatch") {
          if (this.field) { this.field.value = ""; this.field.focus(); }
          this.announce("That code doesn't match. Check the code on your phone and type it again.");
          return;
        }
        if (["link_unavailable", "link_code_attempts"].includes(error.code))
          return this.end(error.code === "link_code_attempts"
            ? "That code was wrong too many times, so the sign-in request ended. Nothing was signed in."
            : ENDED_NOTICE);
        throw error;
      }
      this.stop();
      this.request = null;
      if (result.newDevice) {
        if (request.keys !== "pending") throw new Error("Kin could not match this computer's keys to the sign-in. Start again.");
        await this.host.syncKeyStore.bindPendingDevice({
          deviceId: result.deviceId, householdId: result.householdId, memberId: result.memberId,
        });
        // A new device starts Kin afresh, as after joining with a code.
        location.href = "/";
        return;
      }
      if (request.keys !== "existing" || result.deviceId !== request.deviceId)
        throw new Error("Kin could not match this computer's keys to the sign-in. Start again.");
      this.host.intent = null;
      history.replaceState(null, "", "/");
      await this.host.load();
    });
  }

  /** The screen, for whichever step the request is at. */
  render() {
    clearInterval(this.ticker);
    this.ticker = null;
    const heading = document.createElement("h3");
    heading.className = "sign-in-heading";
    heading.tabIndex = -1;
    heading.textContent = "Sign in with your phone";
    const status = document.createElement("p");
    status.className = "sign-in-status";
    status.setAttribute("role", "status");
    this.status = status;
    this.field = null;
    this.host.append(heading);
    const request = this.request;
    if (!request) {
      if (this.ended) {
        this.host.text(this.ended);
        this.host.append(status);
        this.host.button("Show a new code", () => this.begin());
      } else {
        this.host.text(this.starting ? "Getting a sign-in code…" : "Kin couldn't get a sign-in code.");
        this.host.append(status);
        if (!this.starting) this.host.button("Try again", () => this.begin());
      }
      this.host.button("Back", () => this.cancel(), "secondary");
      this.applyFocus(heading);
      return;
    }
    if (request.state === "approved") {
      this.host.text("Your phone approved this computer. Type the 6-digit code shown on your phone.");
      const form = document.createElement("form");
      form.className = "sign-in-code";
      const label = document.createElement("label");
      label.textContent = "6-digit code";
      const input = document.createElement("input");
      input.name = "code";
      input.inputMode = "numeric";
      input.autocomplete = "one-time-code";
      input.pattern = "[0-9 ]*";
      input.maxLength = LINK_CODE_LENGTH + 1;
      input.required = true;
      label.append(input);
      this.field = input;
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "primary-action";
      submit.textContent = "Sign in";
      form.append(label, submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        this.complete(input.value);
      });
      this.host.append(form);
      this.countdown = this.host.text("");
      this.countdown.className = "sign-in-countdown";
      this.host.append(status);
      this.host.button("Cancel", () => this.cancel(), "secondary");
      this.tick();
      this.applyFocus(heading, input);
      this.schedulePoll();
      return;
    }
    this.host.text(SIGN_IN_STEPS);
    this.host.text("Then approve on your phone and type the 6-digit code it shows here. Only a phone where you're already signed in can approve.");
    const qr = document.createElement("kin-qr");
    qr.className = "sign-in-qr";
    qr.label = "QR code to sign in on this computer. Scan it with Kin on your phone.";
    qr.expiredMessage = "This sign-in code expired.";
    qr.code = "";
    qr.refresh = () => this.refresh();
    qr.value = this.link(request);
    qr.expiresAt = request.expiresAt;
    qr.addEventListener("kin-qr-expired", () => {
      if (this.request?.state === "pending") this.end("The sign-in code expired. Nothing was signed in.");
    });
    this.host.append(qr);
    this.countdown = this.host.text("");
    this.countdown.className = "sign-in-countdown";
    this.host.append(status);
    this.host.button("Cancel", () => this.cancel(), "secondary");
    this.tick();
    this.applyFocus(heading);
    this.schedulePoll();
  }

  /** The visible countdown, updated every second without announcing. */
  tick() {
    const update = () => {
      if (!this.request || !this.countdown) return this.stopTicker();
      this.countdown.textContent = this.request.state === "approved"
        ? `The code works for ${remaining(this.request.expiresAt)}`
        : `This code changes in ${remaining(this.request.expiresAt)}`;
    };
    update();
    this.ticker = setInterval(update, 1000);
  }

  stopTicker() {
    clearInterval(this.ticker);
    this.ticker = null;
  }

  applyFocus(heading, field) {
    const target = this.focusNext === "code" ? field : this.focusNext === "heading" ? heading : null;
    this.focusNext = null;
    if (target) requestAnimationFrame(() => target.focus());
  }
}
