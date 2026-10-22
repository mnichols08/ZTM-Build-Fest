// Renewal, hot swap, status and the daily CT check (#727, ADR 0025 §5, §11).
//
// One CertificateManager per home server name. It:
//
//   - loads the stored certificate and puts it on the TLS server;
//   - renews once two thirds of the certificate's lifetime has passed (or at
//     once when there is none, it has expired, it doesn't match its key or
//     doesn't cover the name), with a new certificate key each time;
//   - on failure retries after 1 hour, doubling to at most 24 hours, or later
//     if the CA's Retry-After says so (rate limits);
//   - swaps the new certificate in with `setSecureContext` (no restart);
//   - runs the CT check once a day and keeps the result;
//   - reports all of it as a plain object for the control panel (#718).
//
// Time and timers are injected so tests drive the schedule without waiting.
// ACME Renewal Information (ARI, RFC 9773) is not followed yet; renewal is by
// fraction of lifetime only (see docs/HOME-CERTIFICATES.md).
import { X509Certificate, createPublicKey } from "node:crypto";
import { AcmeClient, obtainCertificate } from "./client.mjs";
import { checkTransparency, normalizeSerial } from "./ct-check.mjs";
import { generateP256Key, spkiSha256 } from "./keys.mjs";
import { applyCertificate } from "./tls-hook.mjs";
import { assertDnsName } from "./x509.mjs";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const RENEW_FRACTION = 2 / 3;
export const BACKOFF_FIRST_MS = HOUR;
export const BACKOFF_MAX_MS = 24 * HOUR;
export const RETRY_AFTER_MAX_MS = 7 * DAY;
export const EXPIRY_WARNING_MS = 14 * DAY;
export const TRANSPARENCY_INTERVAL_MS = DAY;
// setTimeout holds at most 2^31 - 1 ms; wake at least daily and re-plan.
const MAX_TIMER_MS = DAY;

/** When to renew a certificate valid from `notBefore` to `notAfter`. */
export const renewalTime = (notBefore, notAfter) => notBefore + Math.floor((notAfter - notBefore) * RENEW_FRACTION);

/** The wait after the `failures`-th failure in a row (1-based): 1 h, 2 h, 4 h
 * … 24 h, or the CA's Retry-After when that is longer (at most 7 days). */
export function backoffDelay(failures, retryAfterMs) {
  const backoff = Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
  return Number.isFinite(retryAfterMs) ? Math.max(backoff, Math.min(retryAfterMs, RETRY_AFTER_MAX_MS)) : backoff;
}

/** The CAA records that bind `name` to this ACME account (RFC 8657), as the
 * relay serves them for a free name and as a household publishes them for its
 * own domain. */
export function caaRecords(name, accountUrl, issuer = "letsencrypt.org") {
  return [
    `${name}. CAA 0 issue "${issuer}; accounturi=${accountUrl}; validationmethods=tls-alpn-01"`,
    `${name}. CAA 0 issuewild ";"`,
  ];
}

/** Facts about a PEM chain's leaf, or null when it can't be read. */
export function describeChain(chainPem) {
  try {
    const leaf = new X509Certificate(chainPem);
    return {
      leaf,
      notBefore: Date.parse(leaf.validFrom),
      notAfter: Date.parse(leaf.validTo),
      serial: normalizeSerial(leaf.serialNumber),
      issuer: leaf.issuer.split("\n").find((line) => line.startsWith("CN="))?.slice(3) ?? leaf.issuer,
    };
  } catch {
    return null;
  }
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export class CertificateManager {
  #timer = null;
  #ctTimer = null;
  #running = null;
  #current = null; // { key, chainPem, notBefore, notAfter, serial, issuer }
  #failures = 0;
  #nextAttemptAt = null;
  #lastError = null;
  #lastRenewedAt = null;
  #renewing = false;
  #accountUrl = null;
  #transparency = { state: "not-checked", checkedAt: null, unexpected: [], error: null };

  /**
   * @param {object} options
   * @param {string} options.name the home server's DNS name
   * @param {import("./keys.mjs").CertificateStore} options.store
   * @param {string} options.directoryUrl ACME directory (Let's Encrypt production by default in home mode)
   * @param {Function} options.transport outbound HTTP (transport.mjs)
   * @param {import("./tls-alpn.mjs").ChallengeResponder} options.responder
   * @param {import("node:tls").Server} [options.server] the TLS server to hot-swap
   * @param {boolean} [options.termsOfServiceAgreed] the admin agreed in setup
   * @param {string[]} [options.contact] e.g. ["mailto:…"]; optional
   * @param {{ now(): number, setTimeout: Function, clearTimeout: Function }} [options.clock]
   * @param {(ms: number) => Promise<void>} [options.sleep] between ACME polls
   * @param {Function} [options.ctTransport] for the CT search (defaults to `transport`)
   * @param {string} [options.ctBaseUrl]
   * @param {(event: { type: string }) => void} [options.onEvent] renewed, failed, expiring, transparency-alert
   * @param {(account: { accountUrl: string, caa: string[] }) => Promise<void>} [options.beforeOrder]
   *   runs after the account exists and before each order: where the tunnel
   *   (#733) publishes CAA through the relay. A failure stops the order.
   */
  constructor({ name, store, directoryUrl, transport, responder, server = null, termsOfServiceAgreed = false, contact, clock = { now: Date.now, setTimeout, clearTimeout }, sleep, ctTransport, ctBaseUrl, onEvent = () => {}, beforeOrder = async () => {} }) {
    this.name = assertDnsName(name);
    Object.assign(this, { store, directoryUrl, transport, responder, server, termsOfServiceAgreed, contact, clock, sleep, ctTransport: ctTransport ?? transport, ctBaseUrl, onEvent, beforeOrder });
  }

  /** Load what is stored, put it on the server, and plan the next renewal and
   * CT check. Doesn't wait for a renewal. */
  async start() {
    await this.#load();
    this.#plan();
    this.#planTransparency(this.#current ? TRANSPARENCY_INTERVAL_MS : HOUR);
    return this.status();
  }

  stop() {
    if (this.#timer) this.clock.clearTimeout(this.#timer);
    if (this.#ctTimer) this.clock.clearTimeout(this.#ctTimer);
    this.#timer = this.#ctTimer = null;
  }

  async #load() {
    const stored = await this.store.certificate();
    const account = await this.store.account();
    if (account?.directoryUrl === this.directoryUrl) this.#accountUrl = account.accountUrl;
    if (!stored) return;
    const facts = describeChain(stored.chainPem);
    if (!facts || !facts.leaf.publicKey.equals(createPublicKey(stored.key)) || !facts.leaf.checkHost(this.name)) return;
    this.#current = { key: stored.key, chainPem: stored.chainPem, ...facts };
    if (this.server) applyCertificate(this.server, stored);
  }

  /** When the next renewal attempt is due (ms since epoch). */
  dueAt() {
    if (this.#nextAttemptAt !== null) return this.#nextAttemptAt;
    if (!this.#current || this.clock.now() >= this.#current.notAfter) return this.clock.now();
    return renewalTime(this.#current.notBefore, this.#current.notAfter);
  }

  #plan() {
    if (this.#timer) this.clock.clearTimeout(this.#timer);
    const delay = Math.min(Math.max(0, this.dueAt() - this.clock.now()), MAX_TIMER_MS);
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null;
      if (this.clock.now() >= this.dueAt()) this.renew().catch(() => {}); // failures are recorded in status
      else this.#plan();
    }, delay);
    this.#timer?.unref?.();
    if (this.#current && this.#current.notAfter - this.clock.now() < EXPIRY_WARNING_MS) this.onEvent({ type: "expiring", notAfter: iso(this.#current.notAfter) });
  }

  #planTransparency(delay) {
    if (this.#ctTimer) this.clock.clearTimeout(this.#ctTimer);
    this.#ctTimer = this.clock.setTimeout(() => {
      this.#ctTimer = null;
      this.checkTransparency().catch(() => {}).finally(() => this.#planTransparency(TRANSPARENCY_INTERVAL_MS));
    }, delay);
    this.#ctTimer?.unref?.();
  }

  /** Get a new certificate now (one attempt; concurrent calls share it). */
  renew() {
    this.#running ??= this.#renewOnce().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #renewOnce() {
    this.#renewing = true;
    try {
      const accountKey = await this.store.accountKey();
      const client = new AcmeClient({ directoryUrl: this.directoryUrl, accountKey, transport: this.transport, accountUrl: this.#accountUrl, ...(this.sleep ? { sleep: this.sleep } : {}), now: () => this.clock.now() });
      await client.ensureAccount({ termsOfServiceAgreed: this.termsOfServiceAgreed, contact: this.contact });
      if (client.accountUrl !== this.#accountUrl) {
        this.#accountUrl = client.accountUrl;
        await this.store.saveAccount({ directoryUrl: this.directoryUrl, accountUrl: client.accountUrl });
      }
      // ADR 0025 §5: CAA must name this account before the first order
      // (relay CONTROL op 3 SET_CAA for a free name, #733).
      await this.beforeOrder({ accountUrl: this.#accountUrl, caa: caaRecords(this.name, this.#accountUrl) });
      const certificateKey = generateP256Key();
      const { chainPem } = await obtainCertificate(client, { names: [this.name], certificateKey, responder: this.responder });
      const facts = describeChain(chainPem);
      await this.store.saveCertificate({ key: certificateKey, chainPem });
      await this.store.remember({ spkiSha256: spkiSha256(certificateKey), serial: facts.serial, notAfter: iso(facts.notAfter) });
      this.#current = { key: certificateKey, chainPem, ...facts };
      if (this.server) applyCertificate(this.server, { key: certificateKey, chainPem });
      this.#failures = 0;
      this.#nextAttemptAt = null;
      this.#lastError = null;
      this.#lastRenewedAt = this.clock.now();
      this.onEvent({ type: "renewed", notAfter: iso(facts.notAfter) });
      return this.status();
    } catch (error) {
      this.#failures += 1;
      this.#nextAttemptAt = this.clock.now() + backoffDelay(this.#failures, error?.retryAfterMs);
      this.#lastError = { code: typeof error?.code === "string" && error.code.startsWith("acme-") ? error.code : "acme-error", detail: error?.detail ?? null, at: iso(this.clock.now()) };
      this.onEvent({ type: "failed", code: this.#lastError.code, nextAttemptAt: iso(this.#nextAttemptAt) });
      throw error;
    } finally {
      this.#renewing = false;
      this.#plan();
    }
  }

  /** Run the CT check now and keep the result. */
  async checkTransparency() {
    const history = await this.store.history();
    const serials = history.map((entry) => entry.serial);
    const spkiHashes = history.map((entry) => entry.spkiSha256);
    if (this.#current) { serials.push(this.#current.serial); spkiHashes.push(spkiSha256(this.#current.key)); }
    try {
      const { checked, unexpected } = await checkTransparency({ name: this.name, transport: this.ctTransport, known: { serials, spkiHashes }, ...(this.ctBaseUrl ? { baseUrl: this.ctBaseUrl } : {}) });
      this.#transparency = { state: unexpected.length ? "alert" : "ok", checkedAt: iso(this.clock.now()), checked, unexpected, error: null };
      if (unexpected.length) this.onEvent({ type: "transparency-alert", count: unexpected.length });
    } catch (error) {
      // An unreachable search service isn't an alert; the last result stays.
      this.#transparency = { ...this.#transparency, error: { code: error?.code ?? "ct-unavailable", at: iso(this.clock.now()) } };
      throw error;
    }
    return this.#transparency;
  }

  /** What the control panel shows. Dates are ISO strings; nothing secret. */
  status() {
    const now = this.clock.now();
    const current = this.#current;
    let state = "none";
    if (current) state = now >= current.notAfter ? "expired" : "valid";
    if (this.#renewing) state = "renewing";
    else if (this.#failures > 0) state = current && now < current.notAfter ? "valid-retrying" : "failed";
    const msLeft = current ? current.notAfter - now : null;
    return {
      name: this.name,
      state,
      certificate: current ? {
        notBefore: iso(current.notBefore),
        notAfter: iso(current.notAfter),
        serial: current.serial,
        issuer: current.issuer,
        daysLeft: Math.max(0, Math.floor(msLeft / DAY)),
      } : null,
      expiringSoon: current ? msLeft < EXPIRY_WARNING_MS : false,
      renewAt: current ? iso(renewalTime(current.notBefore, current.notAfter)) : null,
      nextAttemptAt: iso(this.#nextAttemptAt ?? (current ? null : now)),
      failures: this.#failures,
      lastError: this.#lastError,
      lastRenewedAt: iso(this.#lastRenewedAt),
      accountUrl: this.#accountUrl,
      caa: this.#accountUrl ? caaRecords(this.name, this.#accountUrl) : null,
      transparency: { ...this.#transparency, unexpected: [...this.#transparency.unexpected] },
    };
  }
}
