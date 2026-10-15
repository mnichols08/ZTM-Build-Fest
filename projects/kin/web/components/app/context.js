// The explicit dependency container shared by <kin-app>'s controllers.
// `app` is the element: it owns the state and DOM references the controllers
// read and write. Controllers reach each other through this object only.
import { AppearanceController } from "./appearance.js";
import { AppendCommands } from "./commands/append.js";
import { AttachmentController } from "./attachments.js";
import { BulkCommands } from "./commands/bulk.js";
import { ConversationCommands } from "./commands/conversations.js";
import { DetailController } from "./detail.js";
import { ItemCommands } from "./commands/items.js";
import { NavigationController } from "./navigation.js";
import { PeerChannel } from "./peer-channel.js";
import { RecordCommands } from "./commands/records.js";
import { RefreshController } from "./refresh.js";
import { RenderController } from "./render.js";
import { RoutineCommands } from "./commands/routines.js";
import { SessionController } from "./session.js";
import { ShellBuilder } from "./shell.js";
import { StatusController } from "./status.js";
import { SyncController } from "./sync.js";
import { ViewBuilder } from "./views.js";
import { LocalReminders } from "../../reminders.js";
import { EventStore } from "../../storage/event-store.js";
import { readAutoLockPreference } from "./constants.js";

export function createAppContext(app) {
  const ctx = { app };
  ctx.session = new SessionController(ctx);
  ctx.sync = new SyncController(ctx);
  ctx.peers = new PeerChannel(ctx);
  ctx.refresh = new RefreshController(ctx);
  ctx.append = new AppendCommands(ctx);
  ctx.items = new ItemCommands(ctx);
  ctx.bulk = new BulkCommands(ctx);
  ctx.conversations = new ConversationCommands(ctx);
  ctx.routines = new RoutineCommands(ctx);
  ctx.records = new RecordCommands(ctx);
  ctx.attachments = new AttachmentController(ctx);
  ctx.navigation = new NavigationController(ctx);
  ctx.detail = new DetailController(ctx);
  ctx.appearance = new AppearanceController(ctx);
  ctx.status = new StatusController(ctx);
  ctx.render = new RenderController(ctx);
  ctx.shell = new ShellBuilder(ctx);
  ctx.views = new ViewBuilder(ctx);
  return ctx;
}

// The element's initial state and its bound event handlers. Handlers are
// element properties so the lifecycle wiring can add and remove them.
export function initializeAppState(app) {
    app.engine = null;
    app.store = null;
    app.attachmentRows = [];
    app.syncCoordinator = null;
    app.state = null;
    app.localReminders = new LocalReminders();
    app.deferredInstallPrompt = null;
    app.vault = null;
    app.securityGeneration = 0;
    app.busy = false;
    app.starting = null;
    app.initialized = false;
    app.authorizationTimer = null;
    app.checkingAuthorization = false;
    app.channel = null;
    app.refreshing = false;
    app.pendingRefresh = false;
    app.retryAction = null;
    app.retryIntent = null;
    app.suspendedRetry = null;
    app.retryRefresh = () => app.refreshFromEvents();
    app.onAddItem = (event) => app.handleAddItem(event);
    app.onAddAttachment = (event) => app.ctx.attachments.handleAddAttachment(event);
    app.onPickAttachment = (event) => app.ctx.attachments.handlePickAttachment(event);
    // One file input for the whole app: it is never re-rendered, so a list
    // refresh while the native picker is open cannot lose the chosen file.
    app.attachmentInput = null;
    app.attachmentTarget = null;
    app.attachmentProgressTimers = new Map();
    app.onOpenAttachment = (event) => app.ctx.attachments.handleOpenAttachment(event);
    app.onViewAttachment = (event) => app.handleViewAttachment(event);
    app.onRemoveAttachment = (event) => app.ctx.attachments.handleRemoveAttachment(event);
    // Thumbnails are session-scoped object URLs; the cache is created on unlock
    // and emptied on lock so no decrypted preview outlives the vault.
    app.attachmentPreviews = null;
    app.previewProvider = (record, options) => app.ctx.attachments.provideAttachmentPreview(record, options);
    app.viewerUrl = null;
    app.viewerOpener = null;
    app.pendingCapture = null;
    app.pendingScheduleChange = null;
    app.householdStatus = null;
    app.passkeyPromptDismissed = false;
    app.onHouseholdStatus = (event) => { app.householdStatus = event.detail; app.ctx.status.renderOnboarding(); app.ctx.sync.updateSyncChip(); };
    app.onSecurityChanged = () => app.ctx.status.renderOnboarding();
    app.autoLockMinutes = readAutoLockPreference();
    app.autoLockTimer = null;
    app.lastActivityAt = null;
    app.onActivity = () => { if (app.autoLockTimer) app.ctx.session.scheduleAutoLock(); };
    app.onRetryAttachments = () => { if (app.syncCoordinator) void app.syncCoordinator.syncNow(); else void app.configureSyncCoordinator(); };
    app.onChangeResponsibility = (event) => app.ctx.items.handleChangeResponsibility(event);
    app.onReplenishStaple = (event) => app.ctx.items.handleReplenishStaple(event);
    app.syncState = null;
    // Follows the browser's own offline/online events, like the state notice.
    app.offline = typeof navigator !== "undefined" && navigator.onLine === false;
    app.onOffline = () => {
      app.offline = true;
      app.stateNotice.textContent = app.syncCoordinator || app.householdStatus?.identity
        ? "You're offline. Your changes are saved on this device and will sync when you're connected."
        : "You're offline. Your changes are saved on this device.";
      app.stateNotice.hidden = false;
      app.ctx.sync.updateSyncChip();
    };
    app.onOnline = () => {
      app.offline = false;
      app.stateNotice.hidden = true;
      app.ctx.sync.updateSyncChip();
      if (!app.vault || app.vault.locked || !app.store) return;
      app.setStatus(app.syncCoordinator ? "Back online. Syncing…" : "Back online.");
      if (app.syncCoordinator) void app.syncCoordinator.syncNow();
      else void app.configureSyncCoordinator();
    };
    app.onCompleteItem = (event) => app.ctx.items.handleCompleteItem(event);
    app.onReopenItem = (event) => app.ctx.items.handleReopenItem(event);
    app.onArchiveItem = (event) => app.ctx.items.handleArchiveItem(event);
    app.onAddItemStep = (event) => app.ctx.items.handleItemStep("add-item-step", event.detail);
    app.onCompleteItemStep = (event) => app.ctx.items.handleItemStep("complete-item-step", event.detail);
    app.onReopenItemStep = (event) => app.ctx.items.handleItemStep("reopen-item-step", event.detail);
    app.onArchiveItemStep = (event) => app.ctx.items.handleItemStep("archive-item-step", event.detail);
    app.onAddHandoff = (event) => app.handleAddHandoff(event);
    app.onAcknowledgeHandoff = (event) =>
      app.handleHandoffAction("acknowledge-handoff", event.detail.handoffId);
    app.onArchiveHandoff = (event) =>
      app.handleHandoffAction("archive-handoff", event.detail.handoffId);
    app.onAddTalk = (event) =>
      app.saveTalk({ type: "add-talk", text: event.detail.text });
    app.onResolveTalk = (event) =>
      app.saveTalk({ type: "resolve-talk", talkId: event.detail.talkId });
    app.onReopenTalk = (event) =>
      app.saveTalk({ type: "reopen-talk", talkId: event.detail.talkId });
    app.onArchiveTalk = (event) =>
      app.saveTalk({ type: "archive-talk", talkId: event.detail.talkId });
    app.onRoutineIntent = (event) => {
      if (event.type === "kin:archive-routine" || event.type === "kin:complete-routine-occurrence") app.localReminders.cancel(`routine:${event.detail.routineId}`);
      app.saveRoutine({ ...event.detail, type: event.type.slice(4) });
    };
    app.onChangeRoutineSchedule = (event) => app.changeRoutineSchedule(event.detail);
    app.onOpenRoutineSchedule = (event) => app.ctx.routines.openRoutineSchedule(event.detail.routineId);
    app.onAreaIntent = (event) => app.ctx.records.saveArea(event.detail);
    app.onNoteIntent = (event) => app.ctx.records.saveNote(event.type.slice(4), event.detail);
    app.onReferenceIntent = (event) => app.ctx.records.saveReferenceRecord(event.type.slice(4), event.detail);
    app.onMaintenanceIntent = (event) => app.ctx.records.saveMaintenanceEvent(event.type.slice(4), event.detail);
    app.onItemAreaChange = (event) => app.ctx.records.saveArea({ ...event.detail, action: "assign-item-area" });
    app.onItemPlanningDateChange = (event) =>
      app.ctx.items.saveItemPlanningDate(event.detail, event.target.closest("kin-today, kin-item-detail"));
    app.onPinIntent = (event) => app.ctx.items.savePin(event.detail);
    app.onOpenPin = (event) => app.ctx.items.openPinnedItem(event.detail.itemId, event.detail.opener);
    // Today's empty states reuse the universal Quick add; focus returns to the
    // button that opened it, or to the Today heading once that button is gone.
    app.onOpenQuickAdd = (event) => app.quickAdd.open({ opener: event.detail?.opener, fallback: () => app.today.querySelector('[data-section="today"] h2') });
    app.onOpenItem = (event) => app.openItemDetail(event.detail.itemId, { opener: event.detail.opener ?? event.target });
    app.onCloseItemDetail = () => app.closeItemDetail({ restoreFocus: true });
    app.onOpenSearchResult = (event) => app.handleOpenSearchResult(event.detail);
    app.onPlaybookIntent = (event) => app.ctx.routines.handlePlaybookIntent(event);
    app.onLocalReminder = (event) => app.handleLocalReminder(event.detail);
    app.onCancelLocalReminder = (event) => { app.localReminders.cancel(event.detail.id); app.ctx.records.renderReminders(); app.setStatus("Reminder canceled on this device."); };
    app.onModeChange = () => app.ctx.records.saveMode(app.modeSelect.value);
    app.pulseTimer = null;
    app.catchUpCursor = null;
    app.snapshotBoundary = null;
    app.onCaughtUp = () => app.handleCaughtUp();
    app.onSyncEnabled = (event) => app.ctx.sync.startSyncCoordinator(event.detail);
    app.onSyncNow = () => void app.syncCoordinator?.syncNow();
    app.onSyncStop = (event) => {
      app.syncCoordinator?.stop();
      app.syncCoordinator = null;
      app.syncState = null;
      app.ctx.sync.updateSyncChip();
      app.setStatus(event.detail?.message ?? "Household sync has stopped.");
    };
    app.onSyncState = (value) => app.handleSyncState(value);
    app.onHashChange = () => app.showPageFromLocation();
    app.onNavigationClick = (event) => {
      const link = event.target.closest?.("a[href^='#']");
      if (
        !link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      ) return;
      event.preventDefault();
      app.navigate(link.getAttribute("href"));
    };
    // Selection: one canonical item id plus where it was opened from. The
    // same <kin-item-detail> element is re-homed between the mobile sheet,
    // the inline column and the side column as the viewport changes.
    app.selection = null;
    app.detailMode = null;
    app.rehomingDetail = false;
    app.pageScroll = new Map();
    app.phoneQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 719px)") : null;
    app.wideQuery = typeof matchMedia === "function" ? matchMedia("(min-width: 1180px)") : null;
    app.onLayoutChange = () => app.ctx.detail.mountDetail();
    app.onDetailKeydown = (event) => {
      // Escape inside an open dialog (Quick add, the palette) closes that
      // dialog first; the side or inline details stay open beneath it.
      if (event.defaultPrevented || event.key !== "Escape" || app.viewer?.open || event.target.closest?.("dialog[open]")) return;
      if (app.selection && app.detailMode !== "sheet") {
        event.preventDefault();
        app.closeItemDetail({ restoreFocus: true });
      }
    };
    app.onShortcutKeydown = (event) => app.ctx.navigation.handleShortcutKeydown(event);
    // Bulk actions: the last outcome's undo and retry sets, in memory only.
    app.bulkRunning = false;
    app.bulkUndo = null;
    app.bulkRetry = null;
    app.bulkUndoTimer = null;
    app.onBulkItemAction = (event) => app.ctx.bulk.handleBulkItemAction(event);
    app.onBulkUndo = (event) => app.ctx.bulk.handleBulkUndo(event);
    app.onBulkRetry = (event) => app.ctx.bulk.handleBulkRetry(event);
    app.onBulkDismiss = () => app.clearBulkOutcome();
    const platform = typeof navigator === "undefined" ? "" : navigator.userAgentData?.platform ?? navigator.platform ?? "";
    app.macShortcuts = /mac|iphone|ipad|ipod/i.test(platform);
    app.commandGeneration = null;
    app.onSetPulse = (event) => {
      const timestamp = Date.now();
      const hours = event.detail.hours;
      if (![1, 4, 8].includes(hours)) return;
      app.savePulse({
        type: "set-pulse",
        value: event.detail.value,
        timestamp,
        expiresAt: timestamp + hours * 3_600_000,
      });
    };
    app.onWindowFocus = () => {
      // Let the interaction that activated the window finish before disabling controls.
      clearTimeout(app.focusTimer);
      app.focusTimer = setTimeout(app.onTimeWake, 150);
    };
    app.onClearPulse = () => app.savePulse({ type: "clear-pulse" });
    app.onTimeWake = async (event) => {
      if (event?.type === "focus" && event.target !== window) return;
      if (document.visibilityState === "hidden") return;
      const vault = app.vault;
      const generation = app.securityGeneration;
      if (app.autoLockMinutes && app.lastActivityAt !== null &&
        Date.now() - app.lastActivityAt >= app.autoLockMinutes * 60_000) {
        app.lockHousehold();
        app.setStatus("Kin locked after inactivity. Unlock to continue.");
        return;
      }
      // The vault becomes visible just before EventStore.open binds its durable
      // epoch. A focus/visibility event in that window must not compare an
      // unbound vault against storage and revoke an otherwise valid unlock.
      if (!vault || vault.locked || !app.store) return;
      try {
        await EventStore.checkSecurityEpoch(vault);
      } catch {
        if (vault === app.vault && generation === app.securityGeneration)
          app.lockHousehold(false);
        return;
      }
      if (vault !== app.vault || generation !== app.securityGeneration)
        return;
      app.refreshFromEvents();
      void app.ctx.sync.checkHouseholdAuthorization();
    };
    app.onPeerMessage = (event) => app.handlePeerMessage(event);
    // Logout and leaving the household end the session for good; a plain
    // lock request only suspends it.
    app.onLockRequest = (event) => app.lockHousehold(true, { endSession: event?.detail?.endSession === true });
    app.onAppearancePreview = (event) => app.applyAppearance(event.detail.value);
    app.onSaveAppearance = (event) => app.ctx.appearance.handleSaveAppearance(event);
    app.onUseHouseholdAppearance = (event) => app.ctx.appearance.handleUseHouseholdAppearance(event);
    app.onInheritAppearanceProperty = (event) => app.ctx.appearance.handleInheritAppearanceProperty(event);
    app.onHouseholdDefaultsPreview = (event) => { app.ctx.appearance.setHouseholdIdentity(event.detail.name); app.applyAppearance(event.detail.appearance); };
    app.onHouseholdDefaultsCancel = () => app.applyEffectiveAppearance();
    app.onSaveHouseholdDefaults = (event) => app.ctx.appearance.handleSaveHouseholdDefaults(event);
    app.systemAppearance = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    app.onSystemAppearance = () => { if (app.currentAppearance?.mode === "system") app.applyAppearance(app.currentAppearance); };
    app.onPageHide = () => app.lockHousehold(false);
    app.updateRegistration = null;
    app.updateRequested = false;
    app.onServiceWorkerMessage = (event) => {
      if (event.data?.type === "KIN_UPDATE_READY") app.ctx.status.showUpdateNotice();
    };
    app.onControllerChange = () => {
      if (app.updateRequested) window.location.reload();
    };
    app.onBeforeInstallPrompt = (event) => { event.preventDefault(); app.deferredInstallPrompt = event; if (app.installButton) app.installButton.hidden = false; };
    app.onAppInstalled = () => { app.deferredInstallPrompt = null; if (app.installButton) app.installButton.hidden = true; };
}
