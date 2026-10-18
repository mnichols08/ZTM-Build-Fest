// Push notifications (#85): per-device subscriptions and content-free
// "something new" pushes to other members after a sync batch commits.
//
// The service only learns what the relay already shows: that a household
// accepted an encrypted event, and from which member. The payload is fixed
// ({"v":1,"kind":"new"}): no content, event type, author or count. Nothing
// about delivery or clicks is recorded.
import { PairingError, canParticipate } from "./pairing-service.mjs";
import { allowedPushEndpoint, b64url, fromB64url, generateVapidKeys, pushTopic, rawPublicKey, sendPush } from "./web-push.mjs";

export const PUSH_PAYLOAD = JSON.stringify({ v: 1, kind: "new" });
export const PUSH_COALESCE_MS = 2 * 60 * 1000;
export const MAX_PUSH_MUTE_MS = 365 * 24 * 60 * 60 * 1000;
export const PUSH_CONCURRENCY = 4;
const RETRY_DELAYS_MS = [5_000, 30_000];

const invalid = (message) => new PairingError("push_subscription_invalid", message, 400);

/** Storage when the service has no durable store (tests, in-memory mode). */
class MemoryPushStore {
  constructor() { this.rows = new Map(); this.keys = null; }
  vapidKeys(generate) { return (this.keys ??= generate()); }
  getPushSubscription(deviceId) { return this.rows.get(deviceId) ?? null; }
  householdPushSubscriptions(householdId) { return [...this.rows.values()].filter((row) => row.householdId === householdId); }
  putPushSubscription(value) { this.rows.set(value.deviceId, { ...value, mutedUntil: value.mutedUntil ?? null }); }
  setPushMute(deviceId, mutedUntil) { const row = this.rows.get(deviceId); if (row) row.mutedUntil = mutedUntil; return Boolean(row); }
  deletePushSubscriptions(deviceIds) { return deviceIds.filter((id) => this.rows.delete(id)).length; }
  deleteGonePushSubscription(deviceId, endpoint) { return this.rows.get(deviceId)?.endpoint === endpoint && this.rows.delete(deviceId); }
}

export class PushService {
  constructor({ pairingService, store = null, now = () => Date.now(), subject = process.env.KIN_PUSH_SUBJECT || "mailto:kin@localhost",
    send = sendPush, setTimer = setTimeout, clearTimer = clearTimeout, log = (event) => console.log(JSON.stringify(event)) }) {
    this.pairingService = pairingService;
    this.storage = store ?? new MemoryPushStore();
    this.now = now;
    this.subject = subject;
    this.send = send;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    // Coalescing: when each device was last sent to, and its trailing timer.
    this.lastSentAt = new Map();
    this.trailing = new Map();
    this.queue = [];
    this.inFlight = 0;
  }

  get vapidKeys() {
    return (this.keys ??= this.storage.vapidKeys(generateVapidKeys));
  }

  publicKey() {
    return b64url(rawPublicKey(this.vapidKeys.publicJwk));
  }

  /** This device's subscription state, without key material. */
  status(auth) {
    const row = this.storage.getPushSubscription(auth.device.id);
    const mutedUntil = row?.mutedUntil && row.mutedUntil > this.now() ? row.mutedUntil : null;
    return { subscribed: Boolean(row), mutedUntil, endpointHost: row ? new URL(row.endpoint).hostname : null };
  }

  subscribe(auth, value) {
    const endpoint = allowedPushEndpoint(value?.endpoint);
    if (!endpoint) throw invalid("Kin can send notifications only through a supported browser push service.");
    const p256dh = typeof value?.keys?.p256dh === "string" ? fromB64url(value.keys.p256dh) : null;
    const authSecret = typeof value?.keys?.auth === "string" ? fromB64url(value.keys.auth) : null;
    if (p256dh?.length !== 65 || p256dh[0] !== 4 || authSecret?.length !== 16)
      throw invalid("That notification subscription has invalid keys.");
    const existing = this.storage.getPushSubscription(auth.device.id);
    this.storage.putPushSubscription({
      deviceId: auth.device.id, householdId: auth.household.id, memberId: auth.member.id,
      endpoint: endpoint.href, p256dh, auth: authSecret, mutedUntil: existing?.mutedUntil ?? null, createdAt: this.now(),
    });
    return this.status(auth);
  }

  unsubscribe(auth) {
    this.storage.deletePushSubscriptions([auth.device.id]);
    this.forget([auth.device.id]);
    return this.status(auth);
  }

  mute(auth, until) {
    if (until !== null && (!Number.isSafeInteger(until) || until <= this.now() || until > this.now() + MAX_PUSH_MUTE_MS))
      throw invalid("Mute notifications for up to a year, or until you turn them back on.");
    if (!this.storage.setPushMute(auth.device.id, until))
      throw new PairingError("push_not_subscribed", "Turn notifications on for this device first.", 409);
    return this.status(auth);
  }

  /** Drops subscriptions of devices that lost access (revocation, removal,
   * expiry). Called from the sync service's access-change hook, inside the
   * same transaction as the change when there is one. */
  removeUntrusted(householdId, excludedDeviceIds = []) {
    const gone = this.storage.householdPushSubscriptions(householdId)
      .filter((row) => excludedDeviceIds.includes(row.deviceId) || !this.trusted(row))
      .map((row) => row.deviceId);
    this.storage.deletePushSubscriptions(gone);
    this.forget(gone);
    return gone.length;
  }

  forget(deviceIds) {
    for (const id of deviceIds) {
      this.lastSentAt.delete(id);
      const timer = this.trailing.get(id);
      if (timer) this.clearTimer(timer);
      this.trailing.delete(id);
    }
  }

  trusted(row) {
    const device = this.pairingService.devices.get(row.deviceId);
    const member = device && this.pairingService.members.get(device.memberId);
    const household = this.pairingService.households.get(row.householdId);
    return Boolean(device && !device.revokedAt && device.householdId === row.householdId &&
      member && member.id === row.memberId && canParticipate(member, this.now()) &&
      household?.lifecycleState === "active");
  }

  /** A sync batch from `authorMemberId` committed new events. Returns at
   * once; sending happens in the background and never affects sync. */
  eventsAccepted(householdId, authorMemberId) {
    const household = this.pairingService.households.get(householdId);
    if (household?.lifecycleState !== "active") return;
    for (const row of this.storage.householdPushSubscriptions(householdId)) {
      if (row.memberId === authorMemberId || !this.trusted(row)) continue;
      this.schedule(row.deviceId);
    }
  }

  /** At most one push per device per window; a change inside the window is
   * sent once when it ends, so the last change is never lost. */
  schedule(deviceId) {
    const last = this.lastSentAt.get(deviceId);
    const wait = last === undefined ? 0 : last + PUSH_COALESCE_MS - this.now();
    if (wait <= 0) { this.enqueue(deviceId); return; }
    if (this.trailing.has(deviceId)) return;
    const timer = this.setTimer(() => { this.trailing.delete(deviceId); this.enqueue(deviceId); }, wait);
    timer?.unref?.();
    this.trailing.set(deviceId, timer);
  }

  enqueue(deviceId) {
    this.lastSentAt.set(deviceId, this.now());
    this.queue.push({ deviceId, attempt: 0 });
    this.drain();
  }

  drain() {
    while (this.inFlight < PUSH_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.inFlight += 1;
      this.deliver(job).catch(() => {}).finally(() => { this.inFlight -= 1; this.drain(); });
    }
  }

  async deliver({ deviceId, attempt }) {
    // Re-read at send time: muted, unsubscribed or revoked since scheduling.
    const row = this.storage.getPushSubscription(deviceId);
    if (!row || !this.trusted(row) || (row.mutedUntil && row.mutedUntil > this.now())) return;
    let result;
    try {
      result = await this.send(row, { vapidKeys: this.vapidKeys, subject: this.subject, payload: PUSH_PAYLOAD, topic: pushTopic(row.householdId), now: this.now() });
    } catch {
      result = { status: 0 };
    }
    if (result.status === 404 || result.status === 410) {
      this.storage.deleteGonePushSubscription(deviceId, row.endpoint);
      this.forget([deviceId]);
      this.log({ event: "push_subscription_expired" });
    } else if ((result.status === 429 || result.status >= 500 || result.status === 0) && attempt < RETRY_DELAYS_MS.length) {
      // Bounded backoff, then the push is dropped: no unbounded queue.
      const timer = this.setTimer(() => { this.queue.push({ deviceId, attempt: attempt + 1 }); this.drain(); }, RETRY_DELAYS_MS[attempt]);
      timer?.unref?.();
    }
  }
}
