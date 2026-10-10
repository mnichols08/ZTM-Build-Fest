// Browser-local, foreground reminders. These are intentionally ephemeral: the
// browser may suspend timers or terminate the page, so this is not a scheduler.
export class LocalReminders {
  constructor({ notification = globalThis.Notification, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    this.notification = notification;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.entries = new Map();
  }

  async schedule({ id, title, at, isCurrent = () => true }) {
    if (typeof id !== "string" || !id || !Number.isFinite(at) || at <= this.now()) throw new Error("Choose a future reminder time.");
    if (!this.notification) return "unsupported";
    let permission = this.notification.permission;
    if (permission === "default") permission = await this.notification.requestPermission();
    if (permission !== "granted") return permission === "denied" ? "denied" : "unsupported";
    this.cancel(id);
    const entry = { at, timer: null };
    const tick = () => {
      if (this.entries.get(id) !== entry) return;
      const remaining = at - this.now();
      if (remaining > 0) { entry.timer = this.setTimer(tick, Math.min(remaining, 2_147_000_000)); return; }
      this.entries.delete(id);
      try { if (isCurrent()) new this.notification(title, { body: "A household reminder you asked for.", tag: `kin-${id}` }); } catch { /* Permission or browser state may change before delivery. */ }
    };
    entry.timer = this.setTimer(tick, Math.min(at - this.now(), 2_147_000_000));
    this.entries.set(id, entry);
    return "granted";
  }

  cancel(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.clearTimer(entry.timer);
    this.entries.delete(id);
    return true;
  }

  cancelAll() { for (const id of this.entries.keys()) this.cancel(id); }
}
