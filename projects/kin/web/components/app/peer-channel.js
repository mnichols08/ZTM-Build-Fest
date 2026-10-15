// Same-origin peer-tab invalidation over BroadcastChannel (content-free messages).
// Moved verbatim from <kin-app>; state stays on the element (`this.app`).

export class PeerChannel {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  openPeerChannel() {
    if (
      !this.app.isConnected ||
      this.app.channel ||
      !("BroadcastChannel" in globalThis)
    ) {
      return;
    }
    try {
      this.app.channel = new BroadcastChannel("kin-household-events-v1");
      this.app.channel.addEventListener("message", this.app.onPeerMessage);
    } catch {
      this.app.channel = null;
    }
  }
  closePeerChannel() {
    this.app.channel?.removeEventListener("message", this.app.onPeerMessage);
    this.app.channel?.close();
    this.app.channel = null;
  }
  broadcastEventChange() {
    try {
      this.app.channel?.postMessage({ type: "events-changed" });
    } catch {
      // Cross-tab refresh is best-effort; IndexedDB remains authoritative.
    }
  }
  broadcastViewStateChange() {
    try {
      this.app.channel?.postMessage({ type: "view-state-changed" });
    } catch {
      // Cursor convergence is recovered from local IndexedDB on reload or focus.
    }
  }
  handlePeerMessage(event) {
    if (event.data?.type === "household-locked") {
      const peerEpoch = event.data.lockEpoch;
      // A lock notification may be delivered after this tab has already
      // re-unlocked at that durable epoch. Only a newer epoch revokes it.
      if (
        !Number.isSafeInteger(peerEpoch) ||
        peerEpoch < 0 ||
        !this.app.vault ||
        peerEpoch > (this.app.vault.securityEpoch ?? -1)
      )
        this.app.lockHousehold(false);
      return;
    }
    if (!this.app.vault || this.app.vault.locked) return;
    if (!["events-changed", "view-state-changed"].includes(event.data?.type)) {
      return;
    }
    if (this.app.busy || this.app.refreshing) {
      this.app.pendingRefresh = true;
      return;
    }
    this.app.refreshFromEvents();
  }
  flushPeerRefresh() {
    if (!this.app.vault || this.app.vault.locked) return;
    if (!this.app.pendingRefresh || this.app.busy || this.app.refreshing) {
      return;
    }
    this.app.pendingRefresh = false;
    const session = this.app.ctx.session.captureSession();
    queueMicrotask(() => {
      if (this.app.ctx.session.isCurrentSession(session)) this.app.refreshFromEvents();
    });
  }
}
