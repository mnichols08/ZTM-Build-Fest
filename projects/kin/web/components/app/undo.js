// Undo and redo (#315): the session's history, the toast that offers it, and
// running a reversal through the ordinary append path.
// State stays on the element (`this.app`); app/context.js explains the controllers.
//
// Handlers record a change after it saved (`ctx.undo.record(entry)`, with an
// entry from web/undo.js). The toast then offers Undo; after an undo it
// offers Redo. It stays until the next action or until it is dismissed: it
// never times out (WCAG 2.2.1). Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z (or Ctrl+Y)
// do the same outside text fields (navigation.js). Nothing is persisted or
// synced; locking clears it.
import { describeReversal, inverseEntry, nextReversalStep, reversalStatus, UndoHistory } from "../../undo.js";
import { SAVE_ERROR } from "./constants.js";

// A reversal is a handful of commands; this only stops a runaway loop.
const MAX_STEPS = 64;

export class UndoController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
    this.history = new UndoHistory();
    this.running = false;
  }

  /** Builds the toast into the feedback area (shell.js). */
  buildToast(feedback) {
    const toast = document.createElement("div");
    toast.className = "undo-toast";
    toast.hidden = true;
    const text = document.createElement("p");
    text.className = "undo-toast-text";
    text.id = "undo-toast-text";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "undo-toast-action";
    action.setAttribute("aria-describedby", text.id);
    action.addEventListener("click", () => void this.run(action.dataset.direction === "redo" ? "redo" : "undo"));
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "undo-toast-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => this.hideToast({ restoreFocus: true }));
    toast.append(text, action, dismiss);
    feedback.prepend(toast);
    this.toast = toast;
    this.toastText = text;
    this.toastAction = action;
  }

  /** A change saved: it can be undone. The toast shows the status line's
   * confirmation beside Undo; the status line still announces it (politely)
   * and steps out of sight while the toast repeats it. */
  record(entry) {
    if (!entry) return;
    this.history.record(entry);
    this.showToast(this.app.status?.textContent || `${entry.label.charAt(0).toUpperCase()}${entry.label.slice(1)}.`, "undo");
  }

  showToast(message, direction) {
    if (!this.toast) return;
    this.toastText.textContent = message;
    this.toastAction.textContent = direction === "redo" ? "Redo" : "Undo";
    this.toastAction.dataset.direction = direction;
    this.toast.hidden = false;
    this.syncStatus();
  }

  /** The status line hides only while the toast says the same thing. */
  syncStatus() {
    const status = this.app.status;
    if (!status) return;
    status.classList.toggle("status-in-toast", Boolean(this.toast && !this.toast.hidden && status.textContent && status.textContent === this.toastText.textContent));
  }

  hideToast({ restoreFocus = false } = {}) {
    if (!this.toast || this.toast.hidden) return;
    const hadFocus = this.toast.contains(document.activeElement);
    this.toast.hidden = true;
    this.toastText.textContent = "";
    this.syncStatus();
    if (hadFocus && restoreFocus) this.app.main?.querySelector(".app-view:not([hidden]) h1")?.focus();
  }

  /** Locking, or leaving the household: nothing survives. */
  clear() {
    this.history.clear();
    this.hideToast();
  }

  async run(direction) {
    if (this.running || this.app.busy || !this.app.store || !this.app.engine) return;
    const entry = this.history.take(direction);
    if (!entry) {
      this.ctx.status.setStatus(describeReversal(null, direction, "empty"));
      return;
    }
    const outcome = reversalStatus(entry, this.app.state);
    if (outcome !== "ready") {
      // Refused, so it is dropped: trying again would meet the same change.
      this.hideToast();
      this.ctx.status.setStatus(describeReversal(entry, direction, outcome));
      return;
    }
    const session = this.ctx.session.captureSession();
    const before = this.app.state;
    const memberIds = this.ctx.detail.responsibilityContext?.()?.memberIds ?? null;
    let appended = 0;
    this.running = true;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus(direction === "redo" ? "Redoing…" : "Undoing…");
    try {
      for (let command; appended < MAX_STEPS && (command = nextReversalStep(entry, this.app.state, { memberIds })); appended++) {
        await this.ctx.append.appendCommand(command);
        this.ctx.session.assertCurrentSession(session);
      }
      // Undoing an add archives it: its reminder goes too, as on Archive.
      if (entry.kind === "item-added") this.app.localReminders?.cancel?.(`item:${entry.itemId}`);
      if (entry.kind === "routine-created") this.app.localReminders?.cancel?.(`routine:${entry.routineId}`);
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      const inverse = inverseEntry(entry, before, this.app.state);
      if (inverse) this.history.settle(direction, inverse);
      const message = `${describeReversal(entry, direction, "done")}${this.ctx.sync.offlineSyncSuffix?.() ?? ""}`;
      this.ctx.status.setStatus(message);
      if (inverse) this.showToast(message, direction === "redo" ? "undo" : "redo");
      else this.hideToast();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4) this.app.pendingRefresh = true;
      if (appended) { this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange(); }
      // Back on its stack: the steps resume where they stopped.
      this.history.restore(direction, entry);
      this.hideToast();
      this.ctx.status.showAlert(
        appended ? `Only partly ${direction === "redo" ? "redone" : "undone"}. Try again to finish.` : (error.userMessage ?? SAVE_ERROR),
        () => this.run(direction),
      );
      this.ctx.status.setStatus("");
    } finally {
      this.running = false;
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
}
