// Areas, Notes, Reference and Maintenance records, household mode, reminders and calendar export.
// State stays on the element (`this.app`); app/context.js explains the controllers.
import { createCalendarExport } from "../../../calendar-export.js";
import { SAVE_ERROR } from "../constants.js";

export class RecordCommands {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async saveArea(detail) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const action = detail.action;
    const types = {
      "create-area": "create-area",
      "rename-area": "rename-area",
      "archive-area": "archive-area",
      "assign-item-area": "change-item-area",
    };
    const type = types[action];
    if (!type) return;
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand({
        type,
        name: detail.name,
        areaId: detail.areaId,
        itemId: detail.itemId,
      });
      this.ctx.session.assertCurrentSession(session);
      this.app.areas.saved?.(action, detail);
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      this.ctx.status.setStatus(action === "create-area" ? "Area added."
        : action === "rename-area" ? "Area renamed."
        : action === "archive-area" ? "Area archived. Existing links are kept."
        : detail.areaId ? "Area updated." : "Area cleared.");
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR);
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        if (action === "archive-area") this.app.areas.focus();
        if (action === "assign-item-area") {
          [...this.app.querySelectorAll(".item-area-select")]
            .find((select) => select.dataset.itemId === detail.itemId && !select.closest("[hidden]"))
            ?.focus();
        }
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async saveNote(action, detail) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const type = { "create-note": "create-note", "update-note": "update-note", "archive-note": "archive-note" }[action];
    if (!type) return;
    const noteId = detail.noteId ?? crypto.randomUUID().replaceAll("-", "");
    this.ctx.status.setBusy(true); this.ctx.status.clearAlert(); this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand({ type, ...detail, noteId, id: noteId });
      this.ctx.session.assertCurrentSession(session);
      this.app.notes.clearEditor();
      this.app.notes.pendingFocus = action === "archive-note" ? this.app.notes.pendingFocus : "title";
      this.ctx.render.renderState();
      this.ctx.peers.broadcastEventChange();
      this.ctx.status.setStatus(action === "archive-note"
        ? "Note archived on this device."
        : navigator.onLine
          ? "Note saved on this device."
          : "Note saved on this device. Sync is unavailable while offline.");
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR);
      this.ctx.status.setStatus("");
      this.app.notes.pendingFocus = "title";
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async saveReferenceRecord(action, detail) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const recordId = detail.recordId ?? crypto.randomUUID().replaceAll("-", "");
    const type = action === "archive-reference-record" ? action : "save-reference-record";
    this.ctx.status.setBusy(true); this.ctx.status.clearAlert(); this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand({ type, ...detail, recordId, id: recordId });
      this.ctx.session.assertCurrentSession(session);
      if (action === "save-reference-record") this.app.notes.clearReferenceEditor();
      this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange();
      this.ctx.status.setStatus(action === "archive-reference-record" ? "Reference archived." : "Reference saved on this device.");
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR); this.ctx.status.setStatus("");
    } finally { if (this.ctx.session.isCurrentSession(session)) { this.ctx.status.setBusy(false); this.ctx.peers.flushPeerRefresh(); } }
  }
  async saveMaintenanceEvent(action, detail) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const type = action === "archive-maintenance-event" ? action : "save-maintenance-event";
    this.ctx.status.setBusy(true); this.ctx.status.clearAlert(); this.ctx.status.setStatus("Saving maintenance history…");
    try {
      await this.ctx.append.appendCommand({ ...detail, type, id: detail.maintenanceId });
      this.ctx.session.assertCurrentSession(session);
      if (action === "save-maintenance-event") this.app.notes.clearMaintenanceDraft(detail);
      this.ctx.render.renderState(); this.ctx.peers.broadcastEventChange();
      this.ctx.status.setStatus(action === "archive-maintenance-event" ? "Maintenance event archived." : "Maintenance saved on this device.");
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR); this.ctx.status.setStatus("");
    } finally { if (this.ctx.session.isCurrentSession(session)) { this.ctx.status.setBusy(false); this.ctx.peers.flushPeerRefresh(); } }
  }
  async saveMode(mode) {
    if (this.app.busy || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    const command = Object.freeze({ type: "set-household-mode", mode });
    this.ctx.status.setBusy(true);
    this.ctx.status.clearAlert();
    this.ctx.status.setStatus("Saving…");
    try {
      await this.ctx.append.appendCommand(command);
      this.ctx.session.assertCurrentSession(session);
      this.ctx.render.renderState();
      this.ctx.status.setStatus("Household mode updated.");
      this.ctx.peers.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) return;
      this.app.modeSelect.value = this.app.state?.mode ?? "normal";
      this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR, () => this.saveMode(mode));
      this.ctx.status.setStatus("");
    } finally {
      if (this.ctx.session.isCurrentSession(session)) {
        this.ctx.status.setBusy(false);
        this.ctx.peers.flushPeerRefresh();
      }
    }
  }
  async handleLocalReminder({ id, title, at }) {
    const itemId = id.startsWith("item:") ? id.slice(5) : null;
    // A reminder carries its decrypted title, so it may only notify while its
    // record is live in this unlocked session (lock suspends every timer).
    const session = this.ctx.session.captureSession();
    const target = this.reminderTarget(id, session);
    const token = Symbol(id);
    try {
      const result = await this.app.localReminders.schedule({ id, title, at, isCurrent: target?.isCurrent ?? (() => false), token });
      // The permission prompt can outlast the session; never keep a timer or
      // report success into a locked or different household. The token makes
      // sure only this attempt's reminder is cancelled, never a newer one.
      if (!this.ctx.session.isCurrentSession(session)) { this.app.localReminders.cancel(id, token); return; }
      this.renderReminders();
      for (const control of this.app.querySelectorAll("kin-reminder")) if (control.targetRecord?.id === id) control.saved(result === "granted" ? at : null);
      if (itemId) this.app.detail?.reminderDrafts?.delete(itemId);
      this.ctx.status.setStatus(result === "granted" ? "Reminder set on this device while Kin is open." : result === "denied" ? "Notifications are blocked in browser settings. Kin still works normally." :
        result === "stale" ? "That task changed before the reminder was set. Nothing was scheduled." : "Reminders are unavailable in this browser. Kin still works normally.");
    } catch (error) {
      if (this.ctx.session.isCurrentSession(session)) this.ctx.status.showAlert(error.message ?? "Choose a future reminder time.");
    }
  }
  // A reminder's live record in this session: its current title and a check
  // that it may still notify. Null once the record is gone or no longer live.
  reminderTarget(id, session) {
    const itemId = id.startsWith("item:") ? id.slice(5) : null;
    const routineId = id.startsWith("routine:") ? id.slice(8) : null;
    const record = () => itemId
      ? this.app.state?.items?.find((item) => item.itemId === itemId && item.status === "active")
      : this.app.state?.routines?.find((routine) => routine.routineId === routineId && routine.status !== "archived");
    const current = record();
    if (!current || !this.ctx.session.isCurrentSession(session)) return null;
    return { title: current.text, isCurrent: () => this.ctx.session.isCurrentSession(session) && Boolean(record()) };
  }
  // Logout, leaving or deleting the household, and restore end reminders.
  clearReminders() {
    this.app.localReminders.clearAll();
    this.renderReminders();
  }
  renderReminders() {
    const reminders = new Map([...this.app.localReminders.entries].map(([id, entry]) => [id, { at: entry.at }]));
    if (this.app.routines) this.app.routines.reminders = reminders;
    if (this.app.selection) this.app.detail.reminder = reminders.get(`item:${this.app.selection.itemId}`) ?? null;
  }
  downloadCalendar() {
    if (this.app.busy || !this.app.store || !this.app.state) return;
    const planned = this.app.state.items.filter(
      (item) => item.status === "active" && item.planningDate != null,
    );
    if (planned.length === 0) return;

    let url;
    try {
      const contents = createCalendarExport(planned);
      url = URL.createObjectURL(new Blob([contents], {
        type: "text/calendar;charset=utf-8",
      }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "kin-planned-items.ics";
      link.click();
      this.ctx.status.setStatus("Calendar file prepared for download.");
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      this.ctx.status.showAlert(error.message || "Kin could not prepare the calendar file.");
      this.ctx.status.setStatus("");
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
