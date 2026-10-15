// Handoff, Talk and Pulse commands.
// Moved verbatim from <kin-app>; state stays on the element (`this.app`).
import { routeHash } from "../../../routes.js";
import { SAVE_ERROR } from "../constants.js";

export class ConversationCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async handleAddHandoff(event) {
    return this.saveHandoff({ type: "add-handoff", text: event.detail.text });
  }
  async handleHandoffAction(type, handoffId) {
    return this.saveHandoff({ type, handoffId });
  }
  async saveHandoff(command) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.app.ctx.session.captureSession();
    const submitted = Object.freeze({ ...command });
    this.app.ctx.status.setBusy(true);
    this.app.clearAlert();
    this.app.setStatus("Saving…");
    try {
      await this.app.appendCommand(submitted);
      this.app.ctx.session.assertCurrentSession(session);
      this.app.renderState();
      if (submitted.type === "add-handoff")
        this.app.handoffs.clearIfMatches(submitted);
      this.app.setStatus(
        submitted.type === "add-handoff"
          ? "Handoff added."
          : submitted.type === "acknowledge-handoff"
            ? "Acknowledged."
            : "Handoff archived.",
      );
      this.app.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.app.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4 && submitted.handoffId) this.app.pendingRefresh = true;
      this.app.ctx.status.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.saveHandoff(submitted),
        submitted.handoffId ? submitted : null,
      );
      this.app.setStatus("");
    } finally {
      if (this.app.ctx.session.isCurrentSession(session)) {
        this.app.ctx.status.setBusy(false);
        this.app.handoffs.focusInput();
        this.app.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async saveTalk(command) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.app.ctx.session.captureSession();
    const submitted = Object.freeze({ ...command });
    this.app.ctx.status.setBusy(true);
    this.app.clearAlert();
    this.app.setStatus("Saving…");
    try {
      await this.app.appendCommand(submitted);
      this.app.ctx.session.assertCurrentSession(session);
      this.app.renderState();
      if (submitted.type === "add-talk") this.app.talks.clearIfMatches(submitted);
      this.app.setStatus(
        submitted.type === "add-talk"
          ? "Talk added."
          : submitted.type === "resolve-talk"
            ? "Resolved."
            : submitted.type === "reopen-talk"
              ? "Reopened."
              : "Talk archived.",
      );
      this.app.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.app.ctx.session.isCurrentSession(session)) return;
      if (error.code === 4 && submitted.talkId) this.app.pendingRefresh = true;
      this.app.ctx.status.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.app.saveTalk(submitted),
        submitted.talkId ? submitted : null,
      );
      this.app.setStatus("");
    } finally {
      if (this.app.ctx.session.isCurrentSession(session)) {
        this.app.ctx.status.setBusy(false);
        this.app.talks.focusInput();
        this.app.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async savePulse(command) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.app.ctx.session.captureSession();
    const submitted = Object.freeze({ ...command });
    this.app.ctx.status.setBusy(true);
    this.app.clearAlert();
    this.app.setStatus("Saving…");
    try {
      await this.app.appendCommand(submitted);
      this.app.ctx.session.assertCurrentSession(session);
      this.app.renderState();
      this.app.pulse.saved();
      this.app.setStatus(
        submitted.type === "set-pulse" ? "Pulse set." : "Pulse cleared.",
      );
      this.app.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.app.ctx.session.isCurrentSession(session)) return;
      this.app.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () =>
        this.app.savePulse(submitted),
      );
      this.app.setStatus("");
    } finally {
      if (this.app.ctx.session.isCurrentSession(session)) {
        this.app.ctx.status.setBusy(false);
        this.app.pulse.focusInput();
        this.app.ctx.peers.flushPeerRefresh();
      }
    }
  }
  // Kept for callers that switched the former Handoff/Talk tabs directly.
  showHandoffPanel(id, focus = false) {
    const segment = id === "talk" ? "talk" : "handoffs";
    this.app.navigate(routeHash("updates", segment));
    if (focus) this.app.segmentNavs.get("updates")?.focusCurrent();
  }
}
