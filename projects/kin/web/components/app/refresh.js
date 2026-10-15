// Rebuilding the projection from the event log: peer refresh, catch-up and timed refresh.
// Moved verbatim from <kin-app>; state stays on the element (`this.app`).
import { projectionContext } from "../../browser-time.js";
import { captureFocus, restoreFocus } from "../shared/focus.js";

export class RefreshController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async refreshFromEvents() {
    if (!this.app.vault || this.app.vault.locked) return;
    if (!this.app.store || !this.app.engine || this.app.busy || this.app.refreshing) {
      this.app.pendingRefresh = true;
      return;
    }
    const session = this.ctx.session.captureSession();
    this.app.refreshing = true;
    // Captured before busy disables the focused control.
    const focus = this.captureRefreshFocus();
    this.ctx.status.setBusy(true);
    // A failed refresh must not replace the command awaiting recovery.
    const previousFailure = this.app.suspendedRetry ?? {
      action: this.app.retryAction !== this.app.retryRefresh ? this.app.retryAction : null,
      intent: this.app.retryIntent,
      message: this.app.alert.textContent,
    };
    const previousRetry = previousFailure.action;
    const previousRetryIntent = previousFailure.intent;
    const previousAlert = previousFailure.message;
    this.app.clearAlert();
    this.app.setStatus("Updating from another tab…");
    try {
      const snapshot = await session.store.getCatchUpState();
      this.ctx.session.assertCurrentSession(session);
      this.applyCatchUpSnapshot(snapshot);
      this.app.renderState();
      this.app.setStatus("");
      if (previousRetry) {
        const handoff = previousRetryIntent?.handoffId
          ? this.app.state.handoffs.find(
              (record) => record.handoffId === previousRetryIntent.handoffId,
            )
          : null;
        const talk = previousRetryIntent?.talkId
          ? this.app.state.talks.find(
              (record) => record.talkId === previousRetryIntent.talkId,
            )
          : null;
        const routine = previousRetryIntent?.routineId
          ? this.app.state.routines.find(
              (record) => record.routineId === previousRetryIntent.routineId,
            )
          : null;
        const item = previousRetryIntent?.routineId
          ? routine
          : previousRetryIntent?.talkId
            ? talk
            : previousRetryIntent?.handoffId
              ? handoff
              : previousRetryIntent
                ? this.app.state.items.find(
                    (stateItem) =>
                      stateItem.itemId === previousRetryIntent.itemId,
                  )
                : null;
        if (
          previousRetryIntent &&
          (!item ||
            item.status === "archived" ||
            (previousRetryIntent.occurrenceKey !== undefined &&
              item.occurrenceKey !== previousRetryIntent.occurrenceKey))
        ) {
          this.app.setStatus(
            previousRetryIntent.routineId
              ? "That period changed. Review the current routine."
              : previousRetryIntent.talkId
                ? "That topic changed. Review its current state."
                : previousRetryIntent.handoffId
                  ? "That handoff changed. Review its current state."
                  : "That item changed. Review its current state below.",
          );
        } else {
          this.ctx.status.showAlert(previousAlert, previousRetry, previousRetryIntent);
        }
      }
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(
        error.userMessage ??
          "Kin could not refresh from local household storage. Your saved information was not deleted.",
        this.app.retryRefresh,
      );
      this.app.suspendedRetry = previousRetry ? previousFailure : null;
      this.app.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.app.refreshing = false;
        this.ctx.status.setBusy(false);
        this.restoreRefreshFocus(focus);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // One snapshot of the focused control (shared/focus.js), taken before the
  // refresh rebuilds anything. A list or the routines view also describes
  // it, so it can find the equivalent control when that row was rebuilt; in a
  // composer (Quick capture, Handoffs, Talk) focus falls back to its input.
  captureRefreshFocus() {
    const focus = captureFocus(this.app);
    if (!focus) return null;
    const { today, needs, shopping, staples, routines, compose, handoffs, talks } = this.app;
    const owner = [today, needs, shopping, staples, routines].find((view) => view.contains(focus.control)) ?? null;
    const composer = [[compose, compose], [handoffs.lists, handoffs], [talks.lists, talks]]
      .find(([area]) => area.contains(focus.control))?.[1] ?? null;
    return { ...focus, owner, ownerFocus: owner?.captureFocus() ?? null, composer, inPulse: this.app.pulse.contains(focus.control) };
  }
  restoreRefreshFocus(focus) {
    if (!focus) return;
    const { owner, composer } = focus;
    if (composer) {
      // A list that did not change is not rebuilt, so the control may still be
      // there; otherwise the composer's input takes focus.
      if (!restoreFocus(focus)) composer.focusInput();
    } else if (owner) {
      owner.restoreFocus(focus.ownerFocus);
      if (owner !== this.app.routines && !this.app.contains(document.activeElement)) {
        if (owner.closest("[hidden]") || owner === this.app.today) this.app.compose.focusInput();
        else owner.focusInput?.();
      }
    } else if (!restoreFocus(focus) && focus.inPulse) {
      this.app.pulse.focusInput();
    }
  }
  applyCatchUpSnapshot(snapshot) {
    if (!this.app.vault || this.app.vault.locked || !this.app.engine)
      throw new Error("Kin is locked.");
    const { asOf, civilDate } = projectionContext();
    const state = this.app.engine.applyEvents(
      snapshot.events,
      asOf,
      snapshot.cursor.eventId,
      civilDate,
      snapshot.syncIdentity,
    );
    const throughEventId = state.summary.throughEventId;
    if (throughEventId !== (snapshot.through?.eventId ?? null)) {
      throw new Error(
        "Kin could not match its local catch-up snapshot boundary.",
      );
    }
    this.app.state = state;
    this.app.catchUpCursor = snapshot.cursor;
    this.app.snapshotBoundary = snapshot.through
      ? {
          eventId: snapshot.through.eventId,
          localSequence: snapshot.through.localSequence,
          snapshotThroughEventId: snapshot.through.eventId,
          snapshotThroughLocalSequence: snapshot.through.localSequence,
        }
      : null;
  }
  async handleCaughtUp() {
    if (this.app.busy || !this.app.store || !this.app.snapshotBoundary) return;
    const session = this.ctx.session.captureSession();
    const boundary = this.app.snapshotBoundary;
    const restoreCatchUpFocus = document.activeElement === this.app.catchUp.button;
    this.ctx.status.setBusy(true);
    this.app.clearAlert();
    this.app.setStatus("Saving catch-up state…");
    let committed = false;
    try {
      await session.store.markCaughtUpThrough(boundary);
      this.ctx.session.assertCurrentSession(session);
      committed = true;
      // Peers must learn about the commit even if this tab cannot reload it.
      this.app.broadcastViewStateChange();
      const snapshot = await session.store.getCatchUpState();
      this.ctx.session.assertCurrentSession(session);
      this.applyCatchUpSnapshot(snapshot);
      this.app.renderState();
      this.app.setStatus(
        this.app.state.summary.totalCount === 0
          ? "Caught up."
          : "Catch-up summary updated.",
      );
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(
        committed
          ? "Your catch-up position was saved, but Kin could not refresh the summary. Try again to reload it."
          : (error.userMessage ??
              "Kin could not update this browser's catch-up position. Your saved household information was not deleted."),
        committed ? this.app.retryRefresh : () => this.app.handleCaughtUp(),
      );
      this.app.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (restoreCatchUpFocus) {
          (this.app.catchUp.button.hidden
            ? this.app.catchUp.heading
            : this.app.catchUp.button
          ).focus();
        }
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // A fresh replay of the encrypted local log, without touching the rendered
  // projection, so undo checks the newest state including synced events.
  async readAuthoritativeState(session) {
    const snapshot = await session.store.getCatchUpState();
    this.ctx.session.assertCurrentSession(session);
    const { asOf, civilDate } = projectionContext();
    return session.engine.applyEvents(
      snapshot.events,
      asOf,
      snapshot.cursor.eventId,
      civilDate,
      snapshot.syncIdentity,
    );
  }
  schedulePulseRefresh() {
    clearTimeout(this.app.pulseTimer);
    if (
      !this.app.isConnected ||
      (!this.app.state.pulses.length &&
        !this.app.state.routines?.some((r) => r.status === "active"))
    )
      return;
    // Timers only request canonical replay. Rust alone decides expiry.
    const now = Date.now();
    const active = this.app.state.pulses.filter(
      (pulse) => pulse.status === "active",
    );
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const delay = Math.max(
      1,
      Math.min(
        60_000,
        midnight.getTime() - now,
        ...active.map((pulse) => pulse.expiresAt - now),
      ),
    );
    this.app.pulseTimer = setTimeout(this.app.onTimeWake, delay);
  }
  async untilIdle(limitMs = 10_000) {
    const deadline = Date.now() + limitMs;
    while (this.app.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return !this.app.busy;
  }
}
