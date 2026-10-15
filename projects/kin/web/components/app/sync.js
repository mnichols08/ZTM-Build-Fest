// Encrypted sync coordinator setup, authorization checks and the sync status chip.
// Moved verbatim from <kin-app>; state stays on the element (`this.app`).
import { SyncCoordinator } from "../../sync/sync-coordinator.js";
import { SYNC_PAUSE_MESSAGES } from "./constants.js";

export class SyncController {
  constructor(ctx) {
    this.ctx = ctx;
    this.app = ctx.app;
  }

  async configureSyncCoordinator() {
    if (!this.app.vault || this.app.vault.locked || !this.app.store) return;
    const session = this.ctx.session.captureSession();
    try {
      const identityResponse = await fetch("/api/status");
      this.ctx.session.assertCurrentSession(session);
      if (!identityResponse.ok) return;
      const { identity } = await identityResponse.json();
      this.ctx.session.assertCurrentSession(session);
      if (!identity) return;
      const syncResponse = await fetch("/api/sync/status");
      this.ctx.session.assertCurrentSession(session);
      if (!syncResponse.ok) return;
      const syncStatus = await syncResponse.json();
      this.ctx.session.assertCurrentSession(session);
      if (syncStatus.enabled) await this.startSyncCoordinator(identity);
    } catch {
      // Local household use remains available while the service is unreachable.
    }
  }
  async checkHouseholdAuthorization() {
    if (!this.app.vault || this.app.vault.locked) return;
    const session = this.ctx.session.captureSession();
    const household = this.app.household;
    const identity = household?.identity;
    if (
      !identity ||
      this.app.checkingAuthorization ||
      document.visibilityState === "hidden"
    )
      return;
    this.app.checkingAuthorization = true;
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      this.ctx.session.assertCurrentSession(session);
      if (!response.ok) return;
      const status = await response.json();
      this.ctx.session.assertCurrentSession(session);
      if (
        this.app.household !== household ||
        household.identity !== identity ||
        status.identity
      )
        return;
      // The device no longer belongs to a household (removed, left, deleted).
      this.app.lockHousehold(true, { endSession: true });
    } catch {
      // Keep local household use available while the service is unreachable.
    } finally {
      if (this.ctx.session.isCurrentSession(session)) this.app.checkingAuthorization = false;
    }
  }
  async startSyncCoordinator(identity) {
    if (!this.app.vault || this.app.vault.locked || !this.app.store || !this.app.engine) return;
    const session = this.ctx.session.captureSession();
    if (this.app.syncCoordinator?.identity.deviceId === identity.deviceId)
      return this.app.syncCoordinator.syncNow();
    this.app.syncCoordinator?.stop();
    let coordinator;
    coordinator = new SyncCoordinator({
      store: session.store,
      engine: session.engine,
      identity,
      onState: (value) => {
        if (
          this.ctx.session.isCurrentSession(session) &&
          this.app.syncCoordinator === coordinator
        )
          this.app.handleSyncState(value);
      },
    });
    this.app.syncCoordinator = coordinator;
    this.updateSyncChip();
    try {
      await coordinator.start();
      if (this.ctx.session.isCurrentSession(session) && this.app.syncCoordinator === coordinator) await this.app.refreshHouseholdDefaults();
    } catch (error) {
      if (
        this.ctx.session.isCurrentSession(session) &&
        this.app.syncCoordinator === coordinator
      ) {
        this.app.handleSyncState({
          state: "paused",
          code: error.code,
          message: error.message || "Device sync is paused.",
        });
      }
    } finally {
      if (
        !this.ctx.session.isCurrentSession(session) ||
        this.app.syncCoordinator !== coordinator
      )
        coordinator.stop();
    }
  }
  handleSyncState(value) {
    if (!this.app.vault || this.app.vault.locked) return;
    if (value.state) { this.app.syncState = value; this.updateSyncChip(); }
    if (value.state === "paused") {
      const attention = SYNC_PAUSE_MESSAGES[value.code] ?? value.message;
      if (attention) {
        this.app.stateNotice.textContent = attention;
        this.app.stateNotice.hidden = false;
      }
    } else if (["ready", "disabled"].includes(value.state)) {
      this.app.stateNotice.hidden = true;
      if (value.state === "ready") void this.app.refreshHouseholdDefaults();
    }
    if (value.projection && value.added > 0) {
      if (this.app.busy) {
        this.app.pendingRefresh = true;
      } else {
        this.app.state = value.projection;
        this.app.snapshotBoundary = value.snapshotBoundary;
        this.app.renderState();
        if (value.snapshotBoundary) this.app.broadcastEventChange();
      }
    }
    if (Array.isArray(value.attachmentRows)) {
      const rows = this.ctx.attachments.mergeAttachmentRows(value.attachmentRows);
      const sameRows = rows.length === this.app.attachmentRows.length && rows.every((row, index) => {
        const current = this.app.attachmentRows[index];
        return current && ["attachmentId", "parentKind", "parentId", "name", "size", "type", "state"]
          .every((key) => row[key] === current[key]);
      });
      if (!sameRows) {
        this.app.attachmentRows = rows;
        this.app.renderState();
      }
    }
    if (Array.isArray(value.memberIds)) {
      const memberIds = [...new Set(value.memberIds)];
      const previousMembers = new Set(this.app.activeMemberIds ?? []);
      const membershipChanged = memberIds.length !== previousMembers.size || memberIds.some((id) => !previousMembers.has(id));
      // Keep the old array when nothing changed: responsibilityContext() and
      // the views it feeds skip work by identity, and this runs on every poll.
      if (membershipChanged) {
        this.app.activeMemberIds = memberIds;
        this.app.renderState();
      }
      void this.reconcileResponsibilityMembers();
    }
    // The sync chip already shows routine progress. Toast only meaningful
    // incoming changes or an unusual state, not every five-second idle poll.
    if (value.message && value.state !== "paused" &&
        (value.quarantined > 0 || !["syncing", "ready", "disabled"].includes(value.state)))
      this.app.setStatus(value.message);
  }
  updateSyncChip() {
    if (!this.app.syncChip) return;
    if (!this.app.vault || this.app.vault.locked || !this.app.store) { this.app.syncChip.state = null; return; }
    if (this.app.offline || navigator.onLine === false) { this.app.syncChip.state = this.app.syncCoordinator || this.app.householdStatus?.identity ? "offline-sync" : "offline"; return; }
    if (!this.app.syncCoordinator) { this.app.syncChip.state = "local"; return; }
    const state = this.app.syncState?.state;
    this.app.syncChip.state = state === "syncing" ? "syncing" : state === "paused" || state === "deleted" ? "paused" : state === "ready" ? "ready" : "syncing";
  }
  // Only promise a later sync when this device actually syncs; otherwise a
  // change is simply saved here.
  offlineSyncSuffix() {
    return navigator.onLine === false && this.app.syncCoordinator ? " It will sync when you're connected." : "";
  }
  async reconcileResponsibilityMembers() {
    if (this.app.reconcilingResponsibility || this.app.busy || !this.app.activeMemberIds || !this.app.state?.responsibilities?.length) return;
    const active = new Set(this.app.activeMemberIds);
    const stale = this.app.state.responsibilities.filter((entry) => {
      if (!entry.memberId || active.has(entry.memberId)) return false;
      return entry.targetKind === "item"
        ? this.app.state.items?.some((item) => item.itemId === entry.targetId && item.status !== "archived")
        : this.app.state.routines?.some((routine) => routine.routineId === entry.targetId && !routine.archived);
    });
    if (!stale.length) return;
    this.app.reconcilingResponsibility = true;
    try {
      for (const entry of stale) {
        if (!this.app.activeMemberIds.includes(this.app.syncCoordinator?.identity?.memberId)) break;
        await this.app.appendCommand({ type: "change-responsibility", targetKind: entry.targetKind, id: entry.targetId, memberId: null });
      }
      this.app.broadcastEventChange();
      void this.app.syncCoordinator?.syncNow();
    } catch { /* Another device may have cleared the same removed member concurrently. */ }
    finally { this.app.reconcilingResponsibility = false; }
  }
}
