import "./kin-routines.js";
import "./kin-areas.js";
import "./kin-notes.js";
import "./kin-compose.js";
import "./kin-quick-add.js";
import "./kin-command-palette.js";
import "./kin-item.js";
import "./kin-item-detail.js";
import "./kin-today.js";
import "./kin-handoff-list.js";
import "./kin-talk-list.js";
import "./kin-search.js";
import "./kin-segment-nav.js";
import "./kin-sync-status.js";
import "./kin-pulse.js";
import "./kin-catch-up.js";
import "./kin-household.js";
import "./kin-security.js";
import "./kin-appearance.js";
import "./kin-household-defaults.js";
import { projectionContext } from "../browser-time.js";
import { LocalReminders } from "../reminders.js";
import { attachmentFileProblem, captureAttachment, loadLocalAttachmentRows, openAttachment, removeAttachment } from "../attachments/attachment-lifecycle.js";
import { clearAttachmentProgress, setAttachmentProgress } from "../attachments/attachment-progress.js";
import { isImageAttachment } from "../attachments/attachment-preview.js";
import { listSegmentForClassification, resolveRoute, routeHash } from "../routes.js";
import { EventStore } from "../storage/event-store.js";
import { loadCachedHouseholdSettings } from "../sync/sync-coordinator.js";
import { isTypingContext, shortcutForKey } from "../keyboard-commands.js";
import { paletteCss, paletteForSeed } from "../appearance/palette.js";
import { saveAppearance } from "../appearance/store.js";
import { DEFAULT_HOUSEHOLD_NAME, resolveAppearance } from "../appearance/household.js";
import { ATTACHMENT_OPEN_ERROR, SAVE_ERROR, readAutoLockPreference } from "./app/constants.js";
import { createAppContext } from "./app/context.js";

class KinApp extends HTMLElement {
  constructor() {
    super();
    this.ctx = createAppContext(this);
    this.engine = null;
    this.store = null;
    this.attachmentRows = [];
    this.syncCoordinator = null;
    this.state = null;
    this.localReminders = new LocalReminders();
    this.deferredInstallPrompt = null;
    this.vault = null;
    this.securityGeneration = 0;
    this.busy = false;
    this.starting = null;
    this.initialized = false;
    this.authorizationTimer = null;
    this.checkingAuthorization = false;
    this.channel = null;
    this.refreshing = false;
    this.pendingRefresh = false;
    this.retryAction = null;
    this.retryIntent = null;
    this.suspendedRetry = null;
    this.retryRefresh = () => this.refreshFromEvents();
    this.onAddItem = (event) => this.handleAddItem(event);
    this.onAddAttachment = (event) => this.handleAddAttachment(event);
    this.onPickAttachment = (event) => this.handlePickAttachment(event);
    // One file input for the whole app: it is never re-rendered, so a list
    // refresh while the native picker is open cannot lose the chosen file.
    this.attachmentInput = null;
    this.attachmentTarget = null;
    this.attachmentProgressTimers = new Map();
    this.onOpenAttachment = (event) => this.handleOpenAttachment(event);
    this.onViewAttachment = (event) => this.handleViewAttachment(event);
    this.onRemoveAttachment = (event) => this.handleRemoveAttachment(event);
    // Thumbnails are session-scoped object URLs; the cache is created on unlock
    // and emptied on lock so no decrypted preview outlives the vault.
    this.attachmentPreviews = null;
    this.previewProvider = (record, options) => this.provideAttachmentPreview(record, options);
    this.viewerUrl = null;
    this.viewerOpener = null;
    this.pendingCapture = null;
    this.pendingScheduleChange = null;
    this.householdStatus = null;
    this.passkeyPromptDismissed = false;
    this.onHouseholdStatus = (event) => { this.householdStatus = event.detail; this.ctx.status.renderOnboarding(); this.ctx.sync.updateSyncChip(); };
    this.onSecurityChanged = () => this.ctx.status.renderOnboarding();
    this.autoLockMinutes = readAutoLockPreference();
    this.autoLockTimer = null;
    this.lastActivityAt = null;
    this.onActivity = () => { if (this.autoLockTimer) this.ctx.session.scheduleAutoLock(); };
    this.onRetryAttachments = () => { if (this.syncCoordinator) void this.syncCoordinator.syncNow(); else void this.configureSyncCoordinator(); };
    this.onChangeResponsibility = (event) => this.ctx.items.handleChangeResponsibility(event);
    this.onReplenishStaple = (event) => this.ctx.items.handleReplenishStaple(event);
    this.syncState = null;
    // Follows the browser's own offline/online events, like the state notice.
    this.offline = typeof navigator !== "undefined" && navigator.onLine === false;
    this.onOffline = () => {
      this.offline = true;
      this.stateNotice.textContent = this.syncCoordinator || this.householdStatus?.identity
        ? "You're offline. Your changes are saved on this device and will sync when you're connected."
        : "You're offline. Your changes are saved on this device.";
      this.stateNotice.hidden = false;
      this.ctx.sync.updateSyncChip();
    };
    this.onOnline = () => {
      this.offline = false;
      this.stateNotice.hidden = true;
      this.ctx.sync.updateSyncChip();
      if (!this.vault || this.vault.locked || !this.store) return;
      this.setStatus(this.syncCoordinator ? "Back online. Syncing…" : "Back online.");
      if (this.syncCoordinator) void this.syncCoordinator.syncNow();
      else void this.configureSyncCoordinator();
    };
    this.onCompleteItem = (event) => this.ctx.items.handleCompleteItem(event);
    this.onReopenItem = (event) => this.ctx.items.handleReopenItem(event);
    this.onArchiveItem = (event) => this.ctx.items.handleArchiveItem(event);
    this.onAddItemStep = (event) => this.ctx.items.handleItemStep("add-item-step", event.detail);
    this.onCompleteItemStep = (event) => this.ctx.items.handleItemStep("complete-item-step", event.detail);
    this.onReopenItemStep = (event) => this.ctx.items.handleItemStep("reopen-item-step", event.detail);
    this.onArchiveItemStep = (event) => this.ctx.items.handleItemStep("archive-item-step", event.detail);
    this.onAddHandoff = (event) => this.handleAddHandoff(event);
    this.onAcknowledgeHandoff = (event) =>
      this.handleHandoffAction("acknowledge-handoff", event.detail.handoffId);
    this.onArchiveHandoff = (event) =>
      this.handleHandoffAction("archive-handoff", event.detail.handoffId);
    this.onAddTalk = (event) =>
      this.saveTalk({ type: "add-talk", text: event.detail.text });
    this.onResolveTalk = (event) =>
      this.saveTalk({ type: "resolve-talk", talkId: event.detail.talkId });
    this.onReopenTalk = (event) =>
      this.saveTalk({ type: "reopen-talk", talkId: event.detail.talkId });
    this.onArchiveTalk = (event) =>
      this.saveTalk({ type: "archive-talk", talkId: event.detail.talkId });
    this.onRoutineIntent = (event) => {
      if (event.type === "kin:archive-routine" || event.type === "kin:complete-routine-occurrence") this.localReminders.cancel(`routine:${event.detail.routineId}`);
      this.saveRoutine({ ...event.detail, type: event.type.slice(4) });
    };
    this.onChangeRoutineSchedule = (event) => this.changeRoutineSchedule(event.detail);
    this.onOpenRoutineSchedule = (event) => this.ctx.routines.openRoutineSchedule(event.detail.routineId);
    this.onAreaIntent = (event) => this.ctx.records.saveArea(event.detail);
    this.onNoteIntent = (event) => this.ctx.records.saveNote(event.type.slice(4), event.detail);
    this.onReferenceIntent = (event) => this.ctx.records.saveReferenceRecord(event.type.slice(4), event.detail);
    this.onMaintenanceIntent = (event) => this.ctx.records.saveMaintenanceEvent(event.type.slice(4), event.detail);
    this.onItemAreaChange = (event) => this.ctx.records.saveArea({ ...event.detail, action: "assign-item-area" });
    this.onItemPlanningDateChange = (event) =>
      this.ctx.items.saveItemPlanningDate(event.detail, event.target.closest("kin-today, kin-item-detail"));
    this.onPinIntent = (event) => this.ctx.items.savePin(event.detail);
    this.onOpenPin = (event) => this.ctx.items.openPinnedItem(event.detail.itemId, event.detail.opener);
    // Today's empty states reuse the universal Quick add; focus returns to the
    // button that opened it, or to the Today heading once that button is gone.
    this.onOpenQuickAdd = (event) => this.quickAdd.open({ opener: event.detail?.opener, fallback: () => this.today.querySelector('[data-section="today"] h2') });
    this.onOpenItem = (event) => this.openItemDetail(event.detail.itemId, { opener: event.detail.opener ?? event.target });
    this.onCloseItemDetail = () => this.closeItemDetail({ restoreFocus: true });
    this.onOpenSearchResult = (event) => this.handleOpenSearchResult(event.detail);
    this.onPlaybookIntent = (event) => this.ctx.routines.handlePlaybookIntent(event);
    this.onLocalReminder = (event) => this.handleLocalReminder(event.detail);
    this.onCancelLocalReminder = (event) => { this.localReminders.cancel(event.detail.id); this.ctx.records.renderReminders(); this.setStatus("Reminder canceled on this device."); };
    this.onModeChange = () => this.ctx.records.saveMode(this.modeSelect.value);
    this.pulseTimer = null;
    this.catchUpCursor = null;
    this.snapshotBoundary = null;
    this.onCaughtUp = () => this.handleCaughtUp();
    this.onSyncEnabled = (event) => this.ctx.sync.startSyncCoordinator(event.detail);
    this.onSyncNow = () => void this.syncCoordinator?.syncNow();
    this.onSyncStop = (event) => {
      this.syncCoordinator?.stop();
      this.syncCoordinator = null;
      this.syncState = null;
      this.ctx.sync.updateSyncChip();
      this.setStatus(event.detail?.message ?? "Household sync has stopped.");
    };
    this.onSyncState = (value) => this.handleSyncState(value);
    this.onHashChange = () => this.showPageFromLocation();
    this.onNavigationClick = (event) => {
      const link = event.target.closest?.("a[href^='#']");
      if (
        !link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      ) return;
      event.preventDefault();
      this.navigate(link.getAttribute("href"));
    };
    // Selection: one canonical item id plus where it was opened from. The
    // same <kin-item-detail> element is re-homed between the mobile sheet,
    // the inline column and the side column as the viewport changes.
    this.selection = null;
    this.detailMode = null;
    this.rehomingDetail = false;
    this.pageScroll = new Map();
    this.phoneQuery = typeof matchMedia === "function" ? matchMedia("(max-width: 719px)") : null;
    this.wideQuery = typeof matchMedia === "function" ? matchMedia("(min-width: 1180px)") : null;
    this.onLayoutChange = () => this.mountDetail();
    this.onDetailKeydown = (event) => {
      // Escape inside an open dialog (Quick add, the palette) closes that
      // dialog first; the side or inline details stay open beneath it.
      if (event.defaultPrevented || event.key !== "Escape" || this.viewer?.open || event.target.closest?.("dialog[open]")) return;
      if (this.selection && this.detailMode !== "sheet") {
        event.preventDefault();
        this.closeItemDetail({ restoreFocus: true });
      }
    };
    this.onShortcutKeydown = (event) => this.handleShortcutKeydown(event);
    // Bulk actions: the last outcome's undo and retry sets, in memory only.
    this.bulkRunning = false;
    this.bulkUndo = null;
    this.bulkRetry = null;
    this.bulkUndoTimer = null;
    this.onBulkItemAction = (event) => this.ctx.bulk.handleBulkItemAction(event);
    this.onBulkUndo = (event) => this.ctx.bulk.handleBulkUndo(event);
    this.onBulkRetry = (event) => this.ctx.bulk.handleBulkRetry(event);
    this.onBulkDismiss = () => this.clearBulkOutcome();
    const platform = typeof navigator === "undefined" ? "" : navigator.userAgentData?.platform ?? navigator.platform ?? "";
    this.macShortcuts = /mac|iphone|ipad|ipod/i.test(platform);
    this.commandGeneration = null;
    this.onSetPulse = (event) => {
      const timestamp = Date.now();
      const hours = event.detail.hours;
      if (![1, 4, 8].includes(hours)) return;
      this.savePulse({
        type: "set-pulse",
        value: event.detail.value,
        timestamp,
        expiresAt: timestamp + hours * 3_600_000,
      });
    };
    this.onWindowFocus = () => {
      // Let the interaction that activated the window finish before disabling controls.
      clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(this.onTimeWake, 150);
    };
    this.onClearPulse = () => this.savePulse({ type: "clear-pulse" });
    this.onTimeWake = async (event) => {
      if (event?.type === "focus" && event.target !== window) return;
      if (document.visibilityState === "hidden") return;
      const vault = this.vault;
      const generation = this.securityGeneration;
      if (this.autoLockMinutes && this.lastActivityAt !== null &&
        Date.now() - this.lastActivityAt >= this.autoLockMinutes * 60_000) {
        this.lockHousehold();
        this.setStatus("Kin locked after inactivity. Unlock to continue.");
        return;
      }
      // The vault becomes visible just before EventStore.open binds its durable
      // epoch. A focus/visibility event in that window must not compare an
      // unbound vault against storage and revoke an otherwise valid unlock.
      if (!vault || vault.locked || !this.store) return;
      try {
        await EventStore.checkSecurityEpoch(vault);
      } catch {
        if (vault === this.vault && generation === this.securityGeneration)
          this.lockHousehold(false);
        return;
      }
      if (vault !== this.vault || generation !== this.securityGeneration)
        return;
      this.refreshFromEvents();
      void this.ctx.sync.checkHouseholdAuthorization();
    };
    this.onPeerMessage = (event) => this.handlePeerMessage(event);
    // Logout and leaving the household end the session for good; a plain
    // lock request only suspends it.
    this.onLockRequest = (event) => this.lockHousehold(true, { endSession: event?.detail?.endSession === true });
    this.onAppearancePreview = (event) => this.applyAppearance(event.detail.value);
    this.onSaveAppearance = (event) => this.handleSaveAppearance(event);
    this.onUseHouseholdAppearance = (event) => this.handleUseHouseholdAppearance(event);
    this.onInheritAppearanceProperty = (event) => this.handleInheritAppearanceProperty(event);
    this.onHouseholdDefaultsPreview = (event) => { this.setHouseholdIdentity(event.detail.name); this.applyAppearance(event.detail.appearance); };
    this.onHouseholdDefaultsCancel = () => this.applyEffectiveAppearance();
    this.onSaveHouseholdDefaults = (event) => this.handleSaveHouseholdDefaults(event);
    this.systemAppearance = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    this.onSystemAppearance = () => { if (this.currentAppearance?.mode === "system") this.applyAppearance(this.currentAppearance); };
    this.onPageHide = () => this.lockHousehold(false);
    this.updateRegistration = null;
    this.updateRequested = false;
    this.onServiceWorkerMessage = (event) => {
      if (event.data?.type === "KIN_UPDATE_READY") this.ctx.status.showUpdateNotice();
    };
    this.onControllerChange = () => {
      if (this.updateRequested) window.location.reload();
    };
    this.onBeforeInstallPrompt = (event) => { event.preventDefault(); this.deferredInstallPrompt = event; if (this.installButton) this.installButton.hidden = false; };
    this.onAppInstalled = () => { this.deferredInstallPrompt = null; if (this.installButton) this.installButton.hidden = true; };
  }
  connectedCallback() {
    window.addEventListener("beforeinstallprompt", this.onBeforeInstallPrompt);
    window.addEventListener("appinstalled", this.onAppInstalled);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", this.onServiceWorkerMessage);
      navigator.serviceWorker.addEventListener("controllerchange", this.onControllerChange);
      const release = document.querySelector('meta[name="kin-version"]')?.content;
      void navigator.serviceWorker.register(`/service-worker.js?v=${encodeURIComponent(release ?? "")}`).then((registration) => {
        this.updateRegistration = registration;
        if (registration.waiting && navigator.serviceWorker.controller) this.ctx.status.showUpdateNotice();
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) this.ctx.status.showUpdateNotice();
          });
        });
      }).catch(() => {
        // Online use still follows the same security boundary without offline cache.
      });
    }
    if (!this.initialized) {
      this.ctx.shell.initializeElements();
      this.initialized = true;
    }
    this.addEventListener("kin:add-item", this.onAddItem);
    this.addEventListener("kin:add-attachment", this.onAddAttachment);
    this.addEventListener("kin:pick-attachment", this.onPickAttachment);
    this.addEventListener("kin:open-attachment", this.onOpenAttachment);
    this.addEventListener("kin:view-attachment", this.onViewAttachment);
    this.addEventListener("kin:remove-attachment", this.onRemoveAttachment);
    this.addEventListener("kin:household-status", this.onHouseholdStatus);
    this.addEventListener("kin:security-changed", this.onSecurityChanged);
    document.addEventListener("pointerdown", this.onActivity, { passive: true });
    document.addEventListener("keydown", this.onActivity, { passive: true });
    document.addEventListener("scroll", this.onActivity, { passive: true, capture: true });
    document.addEventListener("wheel", this.onActivity, { passive: true });
    this.addEventListener("kin:retry-attachments", this.onRetryAttachments);
    this.addEventListener("kin:change-responsibility", this.onChangeResponsibility);
    this.addEventListener("kin:replenish-staple", this.onReplenishStaple);
    this.addEventListener("kin:complete-item", this.onCompleteItem);
    this.addEventListener("kin:reopen-item", this.onReopenItem);
    this.addEventListener("kin:archive-item", this.onArchiveItem);
    this.addEventListener("kin:add-item-step", this.onAddItemStep);
    this.addEventListener("kin:complete-item-step", this.onCompleteItemStep);
    this.addEventListener("kin:reopen-item-step", this.onReopenItemStep);
    this.addEventListener("kin:archive-item-step", this.onArchiveItemStep);
    this.addEventListener("kin:change-item-area", this.onItemAreaChange);
    this.addEventListener("kin:set-item-planning-date", this.onItemPlanningDateChange);
    this.addEventListener("kin:set-local-reminder", this.onLocalReminder);
    this.addEventListener("kin:cancel-local-reminder", this.onCancelLocalReminder);
    this.addEventListener("kin:pin-intent", this.onPinIntent);
    this.addEventListener("kin:open-pin", this.onOpenPin);
    this.addEventListener("kin:open-quick-add", this.onOpenQuickAdd);
    this.addEventListener("kin:bulk-item-action", this.onBulkItemAction);
    this.addEventListener("kin:bulk-undo", this.onBulkUndo);
    this.addEventListener("kin:bulk-retry", this.onBulkRetry);
    this.addEventListener("kin:bulk-dismiss", this.onBulkDismiss);
    this.addEventListener("kin:open-item", this.onOpenItem);
    this.addEventListener("kin:close-item-detail", this.onCloseItemDetail);
    this.addEventListener("kin:open-search-result", this.onOpenSearchResult);
    this.addEventListener("kin:area-intent", this.onAreaIntent);
    for (const action of ["create-note", "update-note", "archive-note"]) this.addEventListener(`kin:${action}`, this.onNoteIntent);
    for (const action of ["save-reference-record", "archive-reference-record"]) this.addEventListener(`kin:${action}`, this.onReferenceIntent);
    for (const action of ["save-maintenance-event", "archive-maintenance-event"]) this.addEventListener(`kin:${action}`, this.onMaintenanceIntent);
    this.addEventListener("kin:add-handoff", this.onAddHandoff);
    this.addEventListener("kin:acknowledge-handoff", this.onAcknowledgeHandoff);
    this.addEventListener("kin:archive-handoff", this.onArchiveHandoff);
    this.addEventListener("kin:add-talk", this.onAddTalk);
    this.addEventListener("kin:resolve-talk", this.onResolveTalk);
    this.addEventListener("kin:reopen-talk", this.onReopenTalk);
    this.addEventListener("kin:archive-talk", this.onArchiveTalk);
    this.addEventListener("kin:set-pulse", this.onSetPulse);
    this.addEventListener("kin:clear-pulse", this.onClearPulse);
    this.addEventListener("kin:caught-up", this.onCaughtUp);
    this.addEventListener("kin:sync-enabled", this.onSyncEnabled);
    this.addEventListener("kin:sync-now", this.onSyncNow);
    this.addEventListener("kin:sync-stop", this.onSyncStop);
    this.addEventListener("kin:lock", this.onLockRequest);
    this.addEventListener("kin:appearance-preview", this.onAppearancePreview);
    this.addEventListener("kin:save-appearance", this.onSaveAppearance);
    this.addEventListener("kin:use-household-appearance", this.onUseHouseholdAppearance);
    this.addEventListener("kin:inherit-appearance-property", this.onInheritAppearanceProperty);
    this.addEventListener("kin:household-defaults-preview", this.onHouseholdDefaultsPreview);
    this.addEventListener("kin:household-defaults-cancel", this.onHouseholdDefaultsCancel);
    this.addEventListener("kin:save-household-defaults", this.onSaveHouseholdDefaults);
    this.addEventListener("keydown", this.onDetailKeydown);
    document.addEventListener("keydown", this.onShortcutKeydown);
    window.addEventListener("hashchange", this.onHashChange);
    window.addEventListener("popstate", this.onHashChange);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("pagehide", this.onPageHide);
    this.phoneQuery?.addEventListener("change", this.onLayoutChange);
    this.wideQuery?.addEventListener("change", this.onLayoutChange);
    this.systemAppearance?.addEventListener("change", this.onSystemAppearance);
    window.addEventListener("resize", this.onLayoutChange);
    for (const action of [
      "create-routine",
      "complete-routine-occurrence",
      "reopen-routine-occurrence",
      "archive-routine",
    ]) {
      this.addEventListener(`kin:${action}`, this.onRoutineIntent);
    }
    this.addEventListener("kin:change-routine-schedule", this.onChangeRoutineSchedule);
    this.addEventListener("kin:open-routine-schedule", this.onOpenRoutineSchedule);
    for (const action of ["save-playbook", "archive-playbook", "instantiate-playbook"]) this.addEventListener(`kin:${action}`, this.onPlaybookIntent);
    document.addEventListener("visibilitychange", this.onTimeWake);
    window.addEventListener("focus", this.onWindowFocus);
    this.authorizationTimer = setInterval(
      () => void this.ctx.sync.checkHouseholdAuthorization(),
      30_000,
    );
    this.openPeerChannel();
    if (this.store) {
      // Reconnecting must not restart the engine or unlock an in-flight save.
      this.pendingRefresh = true;
      this.ctx.peers.flushPeerRefresh();
      void this.configureSyncCoordinator();
    } else {
      this.initialize();
    }
  }
  buildAttachmentInput() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/webp,application/pdf";
    input.className = "attachment-input";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.hidden = true;
    input.addEventListener("change", () => this.handleAttachmentChosen());
    input.addEventListener("cancel", () => { this.attachmentTarget = null; });
    return input;
  }
  // Runs synchronously inside the tap on an Add photo button, which is what
  // lets the browser open its native picker.
  handlePickAttachment(event) {
    const { parentKind, parentId, label } = event.detail ?? {};
    if (!parentKind || !parentId || !this.attachmentInput) return;
    if (!this.vault || this.vault.locked || !this.store) { this.ctx.status.showAlert("Unlock Kin before attaching a file."); return; }
    this.clearAlert();
    this.attachmentTarget = { parentKind, parentId, label: label ?? "" };
    this.attachmentInput.value = "";
    this.attachmentInput.click();
  }
  handleAttachmentChosen() {
    const target = this.attachmentTarget;
    this.attachmentTarget = null;
    const file = this.attachmentInput?.files?.[0] ?? null;
    if (this.attachmentInput) this.attachmentInput.value = "";
    if (!target || !file) return;
    void this.saveChosenAttachment(file, target);
  }
  buildAttachmentViewer() {
    const dialog = document.createElement("dialog");
    dialog.className = "attachment-viewer";
    dialog.setAttribute("aria-labelledby", "attachment-viewer-title");
    const bar = document.createElement("div");
    bar.className = "attachment-viewer-bar";
    const title = document.createElement("h2");
    title.id = "attachment-viewer-title";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "attachment-viewer-close";
    close.textContent = "Close";
    close.addEventListener("click", () => dialog.close());
    bar.append(title, close);
    const figure = document.createElement("div");
    figure.className = "attachment-viewer-figure";
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    figure.append(image);
    const actions = document.createElement("div");
    actions.className = "attachment-viewer-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save file";
    save.addEventListener("click", () => {
      if (!this.viewerDetail) return;
      void this.handleOpenAttachment({ detail: { ...this.viewerDetail, download: true } });
    });
    actions.append(save);
    dialog.append(bar, figure, actions);
    dialog.addEventListener("close", () => this.releaseViewer());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    dialog.viewerTitle = title;
    dialog.viewerImage = image;
    return dialog;
  }
  // The mobile presentation of item details: a full-height modal sheet that
  // hosts the same <kin-item-detail> element the other layouts use.
  buildDetailSheet() {
    const dialog = document.createElement("dialog");
    dialog.className = "detail-sheet";
    dialog.setAttribute("aria-label", "Item details");
    dialog.addEventListener("close", () => {
      // close() delivers this event asynchronously, so a re-home or an app-
      // initiated close leaves a flag that outlives the synchronous call.
      if (this.sheetClosingProgrammatically) { this.sheetClosingProgrammatically = false; return; }
      this.closeItemDetail({ restoreFocus: true, fromDialog: true });
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); if (!this.rehomingDetail) this.closeItemDetail({ restoreFocus: true }); });
    return dialog;
  }
  releaseViewer() {
    if (this.viewerUrl) URL.revokeObjectURL(this.viewerUrl);
    this.viewerUrl = null;
    this.viewerDetail = null;
    if (this.viewer) {
      this.viewer.viewerImage.removeAttribute("src");
      this.viewer.viewerTitle.textContent = "";
    }
    const opener = this.viewerOpener;
    this.viewerOpener = null;
    if (opener?.isConnected) { opener.focus(); return; }
    // The row that opened the viewer may have been rebuilt meanwhile (a sync
    // tick, a progress update); return focus to the equivalent control.
    const { attachmentId, action } = opener?.dataset ?? {};
    if (!attachmentId) return;
    const matches = (root) => [...(root?.querySelectorAll?.("[data-attachment-id]") ?? [])]
      .find((node) => node.dataset.attachmentId === attachmentId && node.dataset.action === action &&
        !node.closest("[hidden]") && node.getClientRects().length > 0);
    const next = matches(this.detail) ?? matches(this);
    next?.focus();
  }
  closeViewer() {
    if (this.viewer?.open) this.viewer.close();
    else this.releaseViewer();
  }
  // Synchronous on purpose: a peek must return the cached entry itself, not a
  // promise, so tiles can paint immediately after a re-render.
  provideAttachmentPreview(record, { peek = false } = {}) {
    if (!this.attachmentPreviews || !isImageAttachment(record)) return null;
    if (peek) return this.attachmentPreviews.peek(record.attachmentId);
    return this.attachmentPreviews.get(record);
  }
  async loadAttachmentForView(detail, session) {
    const binding = this.state?.attachments?.find((item) => item.attachmentId === detail.attachmentId && !item.removed);
    if (!binding || binding.parentKind !== detail.parentKind || binding.parentId !== detail.parentId) throw new Error(ATTACHMENT_OPEN_ERROR);
    const syncState = await session.store.getSyncState();
    const opened = await openAttachment({ attachmentId: detail.attachmentId, binding, identity: this.syncCoordinator?.identity ?? (syncState ? { householdId: syncState.householdId } : null), store: session.store, keyStore: this.syncCoordinator?.keyStore });
    this.ctx.session.assertCurrentSession(session);
    return opened;
  }
  async handleViewAttachment(event) {
    if (!this.store || !this.viewer) { this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const session = this.ctx.session.captureSession();
    const detail = event.detail;
    try {
      const opened = await this.loadAttachmentForView(detail, session);
      if (!isImageAttachment({ type: opened.type, name: opened.name })) {
        return this.handleOpenAttachment({ detail });
      }
      this.closeViewer();
      this.viewerUrl = URL.createObjectURL(opened.blob);
      this.viewerDetail = { attachmentId: detail.attachmentId, parentKind: detail.parentKind, parentId: detail.parentId };
      this.viewerOpener = detail.opener ?? (this.contains(document.activeElement) ? document.activeElement : null);
      this.viewer.viewerTitle.textContent = opened.name;
      this.viewer.viewerImage.alt = opened.name;
      this.viewer.viewerImage.src = this.viewerUrl;
      this.viewer.showModal();
      this.viewer.querySelector(".attachment-viewer-close")?.focus();
    } catch (error) {
      if (error.code !== "locked" && this.ctx.session.isCurrentSession(session)) this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR);
    }
  }
  navigate(hash) {
    const route = resolveRoute({ hash, pathname: location.pathname });
    if (location.hash !== route.hash) history.pushState(null, "", route.hash);
    this.showPageFromLocation();
  }
  showPageFromLocation() {
    if (!this.pages || !this.navLinks) return;
    const route = resolveRoute({ hash: location.hash, pathname: location.pathname });
    const previous = this.route ?? null;
    const changed = previous?.canonical !== route.canonical;
    if (previous && changed) this.pageScroll.set(previous.canonical, window.scrollY);
    this.route = route;
    this.activePage = route.page;
    this.dataset.route = route.canonical;
    document.title = this.vault && !this.vault.locked && this.householdName ? `${this.householdName} — Kin` : `${route.title} — Kin`;
    if (changed && this.routeAnnouncement) this.routeAnnouncement.textContent = `${route.title} view`;
    for (const [id, section] of this.pages) section.hidden = id !== route.page;
    for (const [id, link] of this.navLinks) {
      if (id === route.destination) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    for (const [pageId, nav] of this.segmentNavs) if (pageId === route.page) nav.current = route.segment;
    for (const [pageId, panels] of this.segmentPanels) {
      if (pageId !== route.page) continue;
      for (const [segment, panel] of panels) panel.hidden = segment !== route.segment;
    }
    if (route.page === "routines") this.routines.view = route.segment;
    // Details stay open only within the page that opened them.
    if (this.selection && this.selection.page !== route.page) this.closeItemDetail({ restoreFocus: false });
    this.mountDetail();
    if (changed && previous) {
      const remembered = this.pageScroll.get(route.canonical) ?? 0;
      requestAnimationFrame(() => window.scrollTo({ top: remembered, behavior: "auto" }));
      if (route.page === "search") this.search.focusInput?.();
    }
  }
  // Shortcuts and palette commands act only on an unlocked, rendered
  // workspace; the security screen and its fields never see them.
  workspaceReady() {
    return Boolean(this.vault && !this.vault.locked && this.store && this.main && !this.main.hidden &&
      this.siteTools && !this.siteTools.hidden && this.commandPalette?.isConnected);
  }
  handleShortcutKeydown(event) {
    if (event.defaultPrevented || !this.workspaceReady()) return;
    const shortcut = shortcutForKey(event, { mac: this.macShortcuts });
    if (!shortcut) return;
    const openDialogs = [...this.querySelectorAll("dialog[open]")];
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const opener = active && active !== document.body && active !== document.documentElement ? active : null;
    if (shortcut === "palette") {
      // Another app dialog (Quick add, item details, the photo viewer) keeps
      // its keyboard; the browser keeps Ctrl/Cmd+K there too.
      if (openDialogs.some((dialog) => !this.commandPalette.contains(dialog))) return;
      event.preventDefault();
      if (!this.commandPalette.isOpen) this.commandGeneration = this.securityGeneration;
      this.commandPalette.openPalette({ opener });
      return;
    }
    if (openDialogs.length || isTypingContext(event, active)) return;
    event.preventDefault();
    this.runWorkspaceCommand(shortcut, { opener });
  }
  currentCivilDate() { return projectionContext().civilDate; }
  layoutMode() {
    if (this.phoneQuery?.matches) return "sheet";
    if (this.wideQuery?.matches) return "side";
    return "inline";
  }
  openItemDetail(itemId, { opener = null, stepId = null, origin = null } = {}) {
    if (!this.state || !this.vault || this.vault.locked) return;
    const record = this.state.items.find((item) => item.itemId === itemId) ?? null;
    const page = this.route?.page ?? "today";
    const sameItem = this.selection?.itemId === itemId;
    this.selection = {
      itemId,
      page,
      opener: sameItem ? this.selection.opener : (opener?.isConnected ? opener : this.selection?.opener ?? null),
      origin: origin ?? (sameItem ? this.selection?.origin : null),
      // The inline presentation hides the list; remember where it was scrolled.
      scrollY: sameItem ? this.selection.scrollY : window.scrollY,
    };
    this.detail.itemId = itemId;
    this.detail.closeLabel = this.selection.origin === "search" ? "Back to search" : this.layoutMode() === "inline" ? "Back to list" : "Close";
    this.feedDetail(record);
    this.mountDetail();
    this.renderSelection();
    if (stepId) this.detail.revealStep(stepId);
    else if (!sameItem) this.detail.focusHeading();
  }
  feedDetail(record = null) {
    const detail = this.detail;
    if (!detail || !this.selection) return;
    const item = record ?? this.state?.items.find((candidate) => candidate.itemId === this.selection.itemId) ?? null;
    detail.update({
      today: this.currentCivilDate(),
      previews: this.previewProvider,
      areaOptions: this.state?.areas ?? [],
      pinned: (this.state?.pins ?? []).some((pin) => pin.targetKind === "item" && pin.targetId === this.selection.itemId),
      pinLimitReached: (this.state?.pins ?? []).length >= 10,
      attachments: this.attachmentRows,
      responsibilityContext: this.responsibilityContext(),
      reminder: this.localReminders.entries.get(`item:${this.selection.itemId}`) ?? null,
      item,
    });
    detail.disabled = this.busy || !this.store;
  }
  responsibilityContext() {
    const memberId = this.syncCoordinator?.identity?.memberId ?? this.store?.actorId ?? null;
    return { responsibilities: this.state?.responsibilities ?? [], memberId, memberIds: this.activeMemberIds ?? (memberId ? [memberId] : []) };
  }
  // Places the single detail element according to the current layout.
  mountDetail() {
    if (!this.detail || !this.detailPanel || !this.detailSheet) return;
    const open = Boolean(this.selection && this.vault && !this.vault.locked);
    const mode = open ? this.layoutMode() : null;
    const previousMode = this.detailMode;
    if (mode === previousMode && open && this.detail.parentElement) return;
    this.rehomingDetail = true;
    try {
      if (previousMode === "sheet" && mode !== "sheet" && this.detailSheet.open) { this.sheetClosingProgrammatically = true; this.detailSheet.close(); }
      if (!open) {
        this.detail.remove();
        this.detailPanel.hidden = true;
        this.detailPanel.classList.remove("detail-panel-inline", "detail-panel-side");
        this.main?.classList.remove("has-detail-side", "has-detail-inline");
        this.detailMode = null;
        return;
      }
      this.detail.mode = mode;
      if (mode === "sheet") {
        this.detailPanel.hidden = true;
        this.detailPanel.classList.remove("detail-panel-inline", "detail-panel-side");
        this.main?.classList.remove("has-detail-side", "has-detail-inline");
        this.detailSheet.append(this.detail);
        if (!this.detailSheet.open) this.detailSheet.showModal();
      } else {
        this.detailPanel.append(this.detail);
        this.detailPanel.hidden = false;
        this.detailPanel.classList.toggle("detail-panel-inline", mode === "inline");
        this.detailPanel.classList.toggle("detail-panel-side", mode === "side");
        this.main?.classList.toggle("has-detail-side", mode === "side");
        this.main?.classList.toggle("has-detail-inline", mode === "inline");
      }
      this.detail.closeLabel = this.selection.origin === "search" ? "Back to search" : mode === "inline" ? "Back to list" : "Close";
      this.detailMode = mode;
    } finally {
      this.rehomingDetail = false;
    }
  }
  closeItemDetail({ restoreFocus = true, fromDialog = false } = {}) {
    const selection = this.selection;
    if (!selection) return;
    this.selection = null;
    this.detail.itemId = null;
    if (this.detailSheet?.open) { this.sheetClosingProgrammatically = true; this.detailSheet.close(); }
    this.mountDetail();
    this.renderSelection();
    // The list keeps the position it had when the item was opened; focus
    // returns to the originating row without scrolling it somewhere else.
    const keepScroll = Number.isFinite(selection.scrollY) && selection.page === this.route?.page;
    const restoreScroll = () => { if (keepScroll) window.scrollTo({ top: selection.scrollY, behavior: "auto" }); };
    restoreScroll();
    if (!restoreFocus) return;
    if (selection.origin === "search" && this.route?.page !== "search") {
      this.navigate("#search");
      requestAnimationFrame(() => {
        ([...this.search.querySelectorAll("[data-result-id]")].find((node) => node.dataset.resultId === selection.originId) ?? this.search.queryInput)?.focus();
      });
      return;
    }
    const restored = [this.today, this.needs, this.shopping, this.staples]
      .filter((list) => !list.closest("[hidden]"))
      .some((list) => list.focusItem(selection.itemId, { preventScroll: keepScroll }));
    if (!restored) {
      if (selection.opener?.isConnected && !selection.opener.closest("[hidden]")) selection.opener.focus({ preventScroll: keepScroll });
      else this.main.querySelector(".app-view:not([hidden]) h2, .app-view:not([hidden]) h1")?.focus({ preventScroll: keepScroll });
    }
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  }
  renderSelection() {
    const selected = this.selection?.itemId ?? null;
    for (const list of [this.today, this.needs, this.shopping, this.staples]) if (list) list.selected = selected;
  }
  // Search results open the real record by canonical id.
  handleOpenSearchResult(detail) {
    if (!this.state) return;
    const unavailable = () => this.setStatus("That record is no longer available. It may have been archived or removed.");
    const reveal = (hash, selector) => {
      this.navigate(hash);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const target = this.main.querySelector(selector);
        if (!target) { unavailable(); return; }
        target.scrollIntoView({ block: "center" });
        target.classList.add("record-highlight");
        setTimeout(() => target.classList.remove("record-highlight"), 2_500);
        (target.matches("button, input, select, textarea, [tabindex]") ? target : target.querySelector("button, [tabindex]") ?? target).focus();
      }));
    };
    switch (detail.kind) {
      case "item":
      case "step": {
        const itemId = detail.kind === "step" ? detail.itemId : detail.id;
        const item = this.state.items.find((record) => record.itemId === itemId && record.status !== "archived");
        if (!item) { unavailable(); return; }
        this.navigate(routeHash("lists", listSegmentForClassification(item.classification)));
        this.openItemDetail(itemId, { opener: detail.opener, stepId: detail.kind === "step" ? detail.stepId : null, origin: "search" });
        this.selection.originId = detail.id;
        return;
      }
      case "handoff":
        if (!this.state.handoffs.some((record) => record.handoffId === detail.id && record.status !== "archived")) { unavailable(); return; }
        reveal(routeHash("updates", "handoffs"), `[data-handoff-id="${detail.id}"]`);
        return;
      case "talk":
        if (!this.state.talks.some((record) => record.talkId === detail.id && record.status !== "archived")) { unavailable(); return; }
        reveal(routeHash("updates", "talk"), `[data-talk-id="${detail.id}"]`);
        return;
      case "note":
        if (!(this.state.notes ?? []).some((record) => record.noteId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-note-id="${detail.id}"]`);
        return;
      case "reference-record":
        if (!(this.state.referenceRecords ?? []).some((record) => record.recordId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-record-id="${detail.id}"]`);
        return;
      case "maintenance":
        if (!(this.state.maintenanceEvents ?? []).some((record) => record.maintenanceId === detail.id && !record.archived)) { unavailable(); return; }
        reveal(routeHash("household", "notes"), `[data-maintenance-id="${detail.id}"]`);
        return;
      default:
        unavailable();
    }
  }
  disconnectedCallback() {
    this.lockHousehold(false, { endSession: true });
    window.removeEventListener("beforeinstallprompt", this.onBeforeInstallPrompt);
    window.removeEventListener("appinstalled", this.onAppInstalled);
    navigator.serviceWorker?.removeEventListener("message", this.onServiceWorkerMessage);
    navigator.serviceWorker?.removeEventListener("controllerchange", this.onControllerChange);
    this.removeEventListener("kin:lock", this.onLockRequest);
    this.removeEventListener("kin:appearance-preview", this.onAppearancePreview);
    this.removeEventListener("kin:save-appearance", this.onSaveAppearance);
    this.removeEventListener("kin:use-household-appearance", this.onUseHouseholdAppearance);
    this.removeEventListener("kin:inherit-appearance-property", this.onInheritAppearanceProperty);
    this.removeEventListener("kin:household-defaults-preview", this.onHouseholdDefaultsPreview);
    this.removeEventListener("kin:household-defaults-cancel", this.onHouseholdDefaultsCancel);
    this.removeEventListener("kin:save-household-defaults", this.onSaveHouseholdDefaults);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("hashchange", this.onHashChange);
    window.removeEventListener("popstate", this.onHashChange);
    window.removeEventListener("offline", this.onOffline);
    window.removeEventListener("online", this.onOnline);
    this.removeEventListener("kin:add-item", this.onAddItem);
    this.removeEventListener("kin:add-attachment", this.onAddAttachment);
    this.removeEventListener("kin:pick-attachment", this.onPickAttachment);
    this.removeEventListener("kin:open-attachment", this.onOpenAttachment);
    this.removeEventListener("kin:view-attachment", this.onViewAttachment);
    this.removeEventListener("kin:remove-attachment", this.onRemoveAttachment);
    this.removeEventListener("kin:household-status", this.onHouseholdStatus);
    this.removeEventListener("kin:security-changed", this.onSecurityChanged);
    document.removeEventListener("pointerdown", this.onActivity);
    document.removeEventListener("keydown", this.onActivity);
    document.removeEventListener("scroll", this.onActivity, true);
    document.removeEventListener("wheel", this.onActivity);
    this.removeEventListener("kin:retry-attachments", this.onRetryAttachments);
    this.removeEventListener("kin:change-responsibility", this.onChangeResponsibility);
    this.removeEventListener("kin:replenish-staple", this.onReplenishStaple);
    this.removeEventListener("kin:complete-item", this.onCompleteItem);
    this.removeEventListener("kin:reopen-item", this.onReopenItem);
    this.removeEventListener("kin:archive-item", this.onArchiveItem);
    this.removeEventListener("kin:add-item-step", this.onAddItemStep);
    this.removeEventListener("kin:complete-item-step", this.onCompleteItemStep);
    this.removeEventListener("kin:reopen-item-step", this.onReopenItemStep);
    this.removeEventListener("kin:archive-item-step", this.onArchiveItemStep);
    this.removeEventListener("kin:change-item-area", this.onItemAreaChange);
    this.removeEventListener("kin:set-item-planning-date", this.onItemPlanningDateChange);
    this.removeEventListener("kin:set-local-reminder", this.onLocalReminder);
    this.removeEventListener("kin:cancel-local-reminder", this.onCancelLocalReminder);
    this.removeEventListener("kin:pin-intent", this.onPinIntent);
    this.removeEventListener("kin:open-pin", this.onOpenPin);
    this.removeEventListener("kin:open-quick-add", this.onOpenQuickAdd);
    this.removeEventListener("kin:bulk-item-action", this.onBulkItemAction);
    this.removeEventListener("kin:bulk-undo", this.onBulkUndo);
    this.removeEventListener("kin:bulk-retry", this.onBulkRetry);
    this.removeEventListener("kin:bulk-dismiss", this.onBulkDismiss);
    this.removeEventListener("kin:open-item", this.onOpenItem);
    this.removeEventListener("kin:close-item-detail", this.onCloseItemDetail);
    this.removeEventListener("kin:open-search-result", this.onOpenSearchResult);
    this.removeEventListener("keydown", this.onDetailKeydown);
    document.removeEventListener("keydown", this.onShortcutKeydown);
    this.phoneQuery?.removeEventListener("change", this.onLayoutChange);
    this.wideQuery?.removeEventListener("change", this.onLayoutChange);
    this.systemAppearance?.removeEventListener("change", this.onSystemAppearance);
    window.removeEventListener("resize", this.onLayoutChange);
    this.removeEventListener("kin:area-intent", this.onAreaIntent);
    for (const action of ["create-note", "update-note", "archive-note"]) this.removeEventListener(`kin:${action}`, this.onNoteIntent);
    for (const action of ["save-reference-record", "archive-reference-record"]) this.removeEventListener(`kin:${action}`, this.onReferenceIntent);
    for (const action of ["save-maintenance-event", "archive-maintenance-event"]) this.removeEventListener(`kin:${action}`, this.onMaintenanceIntent);
    this.removeEventListener("kin:add-handoff", this.onAddHandoff);
    this.removeEventListener(
      "kin:acknowledge-handoff",
      this.onAcknowledgeHandoff,
    );
    this.removeEventListener("kin:archive-handoff", this.onArchiveHandoff);
    this.removeEventListener("kin:add-talk", this.onAddTalk);
    this.removeEventListener("kin:resolve-talk", this.onResolveTalk);
    this.removeEventListener("kin:reopen-talk", this.onReopenTalk);
    this.removeEventListener("kin:archive-talk", this.onArchiveTalk);
    this.removeEventListener("kin:set-pulse", this.onSetPulse);
    this.removeEventListener("kin:clear-pulse", this.onClearPulse);
    this.removeEventListener("kin:caught-up", this.onCaughtUp);
    this.removeEventListener("kin:sync-enabled", this.onSyncEnabled);
    this.removeEventListener("kin:sync-now", this.onSyncNow);
    this.removeEventListener("kin:sync-stop", this.onSyncStop);
    for (const action of [
      "create-routine",
      "complete-routine-occurrence",
      "reopen-routine-occurrence",
      "archive-routine",
    ]) {
      this.removeEventListener(`kin:${action}`, this.onRoutineIntent);
    }
    this.removeEventListener("kin:change-routine-schedule", this.onChangeRoutineSchedule);
    this.removeEventListener("kin:open-routine-schedule", this.onOpenRoutineSchedule);
    for (const action of ["save-playbook", "archive-playbook", "instantiate-playbook"]) this.removeEventListener(`kin:${action}`, this.onPlaybookIntent);
    document.removeEventListener("visibilitychange", this.onTimeWake);
    window.removeEventListener("focus", this.onWindowFocus);
    clearInterval(this.authorizationTimer);
    this.authorizationTimer = null;
    clearTimeout(this.pulseTimer);
    clearTimeout(this.focusTimer);
    this.closePeerChannel();
    this.syncCoordinator?.stop();
    this.syncCoordinator = null;
  }
  // Programmatic entry (tests, future callers) that goes through the same
  // feedback and persistence path as a file chosen in the picker.
  handleAddAttachment(event) {
    const { file, parentKind, parentId } = event.detail ?? {};
    if (!file || !parentKind || !parentId) return;
    return this.saveChosenAttachment(file, { parentKind, parentId });
  }
  reportAttachmentProgress(target, phase, message) {
    const key = `${target.parentKind}:${target.parentId}`;
    clearTimeout(this.attachmentProgressTimers.get(key));
    this.attachmentProgressTimers.delete(key);
    setAttachmentProgress(target.parentKind, target.parentId, { phase, message });
    if (phase === "saved") {
      // Success text stays long enough to read; the tile itself carries the state.
      this.attachmentProgressTimers.set(key, setTimeout(() => {
        this.attachmentProgressTimers.delete(key);
        clearAttachmentProgress(target.parentKind, target.parentId);
      }, 8_000));
    }
  }
  async saveChosenAttachment(file, target) {
    const kind = isImageAttachment({ type: file?.type, name: file?.name }) ? "photo" : "file";
    const problem = attachmentFileProblem(file);
    if (problem) { this.reportAttachmentProgress(target, "error", problem); this.ctx.status.showAlert(problem); return; }
    const lockedMessage = `Unlock Kin before attaching a ${kind}.`;
    if (!this.vault || this.vault.locked || !this.store || !this.engine) {
      this.reportAttachmentProgress(target, "error", lockedMessage); this.ctx.status.showAlert(lockedMessage); return;
    }
    this.reportAttachmentProgress(target, "preparing", `Preparing ${kind}…`);
    if (!(await this.ctx.refresh.untilIdle())) {
      const message = `Kin is still saving another change. Try adding the ${kind} again in a moment.`;
      this.reportAttachmentProgress(target, "error", message); this.ctx.status.showAlert(message); return;
    }
    if (!this.vault || this.vault.locked || !this.store || !this.engine) {
      this.reportAttachmentProgress(target, "error", lockedMessage); return;
    }
    const session = this.ctx.session.captureSession();
    const { parentKind, parentId } = target;
    this.ctx.status.setBusy(true); this.clearAlert();
    this.reportAttachmentProgress(target, "saving", "Saving securely…");
    try {
      const saved = await captureAttachment({ file, parentKind, parentId, identity: this.syncCoordinator?.identity ?? this.household?.identity, store: session.store, keyStore: this.syncCoordinator?.keyStore, append: (command) => this.appendCommand(command) });
      this.ctx.session.assertCurrentSession(session);
      this.attachmentRows = [...this.attachmentRows.filter((row) => row.attachmentId !== saved.attachmentId), { ...saved, parentKind, parentId }];
      this.renderState(); this.broadcastEventChange();
      this.reportAttachmentProgress(target, "saved", this.syncCoordinator
        ? `${saved.name} is saved on this device and waiting to sync to your household.`
        : `${saved.name} is saved on this device.`);
      void this.syncCoordinator?.syncNow();
    } catch (error) {
      if (error.code === "locked" || !this.ctx.session.isCurrentSession(session)) {
        clearAttachmentProgress(parentKind, parentId);
        return;
      }
      const message = error.stage === "binding"
        ? `The ${kind} was protected but couldn't be linked to this record. Nothing else was changed; try again.`
        : error.stage === "validation"
        ? error.message
        : error.userMessage ?? (error.stage === "storage"
          ? `Kin couldn't save this ${kind} on this device. Check free storage space and try again.`
          : error.message || `Kin couldn't save this ${kind} on this device.`);
      this.reportAttachmentProgress(target, "error", message);
      this.ctx.status.showAlert(message);
    } finally { if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setBusy(false); }
  }
  async handleOpenAttachment(event) {
    if (!this.store) { this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const session = this.ctx.session.captureSession();
    const detail = event.detail;
    const binding = this.state?.attachments?.find((item) => item.attachmentId === detail.attachmentId && !item.removed);
    if (!binding || binding.parentKind !== detail.parentKind || binding.parentId !== detail.parentId) { this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const tab = detail.download ? null : window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const opened = await this.loadAttachmentForView(detail, session);
      const url = URL.createObjectURL(opened.blob);
      if (detail.download) { const link = document.createElement("a"); link.href = url; link.download = opened.name; link.hidden = true; document.body.append(link); link.click(); link.remove(); }
      else if (tab) tab.location.href = url;
      else { const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener"; link.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { tab?.close(); if (error.code !== "locked") this.ctx.status.showAlert(ATTACHMENT_OPEN_ERROR); }
  }
  async handleRemoveAttachment(event) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.ctx.session.captureSession(); this.ctx.status.setBusy(true); this.clearAlert();
    try {
      await removeAttachment({ attachmentId: event.detail.attachmentId, append: (command) => this.appendCommand(command), store: session.store });
      this.ctx.session.assertCurrentSession(session);
      this.attachmentPreviews?.forget(event.detail.attachmentId);
      if (this.viewerDetail?.attachmentId === event.detail.attachmentId) this.closeViewer();
      this.attachmentRows = this.attachmentRows.filter((row) => row.attachmentId !== event.detail.attachmentId);
      this.renderState(); this.broadcastEventChange(); void this.syncCoordinator?.syncNow();
    } catch (error) { if (error.code !== "locked" && this.ctx.session.isCurrentSession(session)) this.ctx.status.showAlert(error.userMessage ?? SAVE_ERROR); }
    finally { if (this.ctx.session.isCurrentSession(session)) this.ctx.status.setBusy(false); }
  }
  // A sync pass describes attachments from the projection it started with. A
  // photo attached while that pass ran is missing from its rows, and one
  // removed meanwhile is still present; neither may override the newer local
  // state, so rows are reconciled against the current bindings.
  mergeAttachmentRows(incoming) {
    const bindings = this.state?.attachments ?? [];
    const bound = new Map(bindings.map((binding) => [binding.attachmentId, binding]));
    const rows = incoming.filter((row) => !bound.get(row.attachmentId)?.removed);
    const seen = new Set(rows.map((row) => row.attachmentId));
    for (const row of this.attachmentRows) {
      const binding = bound.get(row.attachmentId);
      if (!seen.has(row.attachmentId) && binding && !binding.removed) rows.push(row);
    }
    return rows;
  }
  async refreshAttachmentRows() {
    if (!this.store || !this.state || !this.vault || this.vault.locked) return;
    const session = this.ctx.session.captureSession();
    try {
      const rows = await loadLocalAttachmentRows({ store: session.store, state: this.state });
      if (!this.ctx.session.isCurrentSession(session)) return;
      this.attachmentRows = rows; this.renderState();
    } catch { /* A later sync retries attachment indexing. */ }
  }
  resolvedAppearanceMode(mode) {
    return mode === "system" ? (this.systemAppearance?.matches ? "dark" : "light") : mode;
  }
  applyAppearance(value) {
    if (!value || !this.vault || this.vault.locked) return;
    this.currentAppearance = structuredClone(value);
    const resolvedMode = this.resolvedAppearanceMode(value.mode);
    const tokens = paletteForSeed(value.seed, resolvedMode);
    if (!this.appearanceSheet && typeof CSSStyleSheet === "function") {
      this.appearanceSheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.appearanceSheet];
    }
    const rules = value.mode === "system"
      ? `${paletteCss(paletteForSeed(value.seed, "light"))}@media (prefers-color-scheme:dark){${paletteCss(paletteForSeed(value.seed, "dark"))}}`
      : paletteCss(tokens);
    this.appearanceSheet?.replaceSync(rules);
    document.documentElement.dataset.kinAppearance = value.mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tokens["header-bg"]);
    const imageUnchanged = value.image && this.appearanceImageBytes && value.image.type === this.appearanceImageType &&
      value.image.bytes.length === this.appearanceImageBytes.length && value.image.bytes.every((byte, index) => byte === this.appearanceImageBytes[index]);
    if (!imageUnchanged && (value.image || this.appearanceImageBytes)) {
      if (this.appearanceObjectUrl) URL.revokeObjectURL(this.appearanceObjectUrl);
      this.appearanceObjectUrl = value.image ? URL.createObjectURL(new Blob([value.image.bytes], { type: value.image.type })) : null;
      this.appearanceImageBytes = value.image ? value.image.bytes.slice() : null;
      this.appearanceImageType = value.image?.type ?? null;
      this.appearanceBackground.src = this.appearanceObjectUrl ?? "";
      this.appearanceBackground.hidden = !this.appearanceObjectUrl;
      this.toggleAttribute("data-personal-background", Boolean(this.appearanceObjectUrl));
    }
  }
  async handleSaveAppearance(event) {
    const { value, complete } = event.detail;
    const session = this.ctx.session.captureSession();
    try {
      const saved = await saveAppearance(session.store, session.vault, value);
      this.ctx.session.assertCurrentSession(session);
      this.personalAppearance = structuredClone(saved);
      this.applyEffectiveAppearance();
      complete(saved, null);
    } catch (error) {
      if (this.ctx.session.isCurrentSession(session)) complete(null, new Error("Kin couldn't save your appearance. Your previous saved appearance is unchanged."));
    }
  }
  async handleUseHouseholdAppearance(event) {
    const session = this.ctx.session.captureSession();
    try {
      this.personalAppearance = await saveAppearance(session.store, session.vault, event.detail.value);
      this.ctx.session.assertCurrentSession(session);
      const effective = resolveAppearance(this.personalAppearance, this.householdSettings);
      this.appearance.initialize(effective);
      this.applyAppearance(effective);
      this.setStatus("Now following the household appearance on this device.");
    } catch { if (this.ctx.session.isCurrentSession(session)) this.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
  }
  async handleInheritAppearanceProperty(event) {
    const session = this.ctx.session.captureSession();
    const next = { ...this.personalAppearance, version: 2 };
    if (event.detail.property === "mode") delete next.mode;
    if (event.detail.property === "color") { delete next.colorSource; delete next.seed; delete next.manual; }
    if (event.detail.property === "background") {
      delete next.image;
      if (next.colorSource === "background") { delete next.colorSource; delete next.seed; delete next.manual; }
    }
    try {
      this.personalAppearance = await saveAppearance(session.store, session.vault, next);
      this.ctx.session.assertCurrentSession(session);
      const effective = resolveAppearance(this.personalAppearance, this.householdSettings);
      this.appearance.initialize(effective);
      this.applyAppearance(effective);
      this.setStatus(`Now following the household ${event.detail.property} on this device.`);
    } catch { if (this.ctx.session.isCurrentSession(session)) this.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
  }
  applyEffectiveAppearance() {
    const effective = resolveAppearance(this.personalAppearance, this.householdSettings);
    this.applyAppearance(effective);
    this.setHouseholdIdentity(this.householdSettings?.name ?? DEFAULT_HOUSEHOLD_NAME);
  }
  setHouseholdIdentity(name) {
    this.householdName = name;
    if (this.brandTitle) this.brandTitle.textContent = name;
    if (this.vault && !this.vault.locked) document.title = `${name} — Kin`;
  }
  async refreshHouseholdDefaults() {
    if (!this.syncCoordinator || !this.vault || this.vault.locked) return;
    // The load spans the network and IndexedDB; a lock or re-open meanwhile
    // must not write the household name or a status into the next session.
    const session = this.ctx.session.captureSession();
    try {
      const result = await this.syncCoordinator.loadHouseholdSettings();
      this.ctx.session.assertCurrentSession(session);
      if (result.value && (this.householdSettings?.revision ?? -1) <= result.value.revision) this.householdSettings = result.value;
      this.householdDefaults.initialize({ ...result, value: this.householdSettings });
      this.applyEffectiveAppearance();
    } catch { if (this.ctx.session.isCurrentSession(session)) this.setStatus("Kin kept the last verified household appearance because the latest shared settings could not be loaded."); }
  }
  async restoreCachedHouseholdDefaults(identity, session = this.ctx.session.captureSession()) {
    if (!identity) return;
    try {
      const value = await loadCachedHouseholdSettings(identity);
      this.ctx.session.assertCurrentSession(session);
      if (value && (this.householdSettings?.revision ?? -1) <= value.revision) this.householdSettings = value;
      this.householdDefaults.initialize({ admin: false, adminRecorded: false, value: this.householdSettings });
      this.applyEffectiveAppearance();
    } catch {
      if (this.ctx.session.isCurrentSession(session)) this.setStatus("Kin couldn't restore the last shared appearance. Local household information is still available.");
    }
  }
  async handleSaveHouseholdDefaults(event) {
    const { value, complete } = event.detail;
    if (!this.syncCoordinator) { complete(null, new Error("Connect household sync before changing shared settings.")); return; }
    const session = this.ctx.session.captureSession();
    try {
      const saved = await this.syncCoordinator.saveHouseholdSettings(value);
      this.ctx.session.assertCurrentSession(session);
      this.householdSettings = saved;
      this.applyEffectiveAppearance();
      complete(saved, null);
    } catch (error) {
      // A save settling after lock or a household re-open (including the
      // stale-session assert above) reports nothing: a re-open keeps the same
      // editor for the new session. A committed server write is unaffected.
      if (this.ctx.session.isCurrentSession(session)) complete(null, error);
    }
  }
  clearAppliedAppearance() {
    this.currentAppearance = null;
    this.personalAppearance = null;
    this.householdSettings = null;
    this.householdName = null;
    if (this.brandTitle) this.brandTitle.textContent = "Kin";
    document.title = "Kin";
    delete document.documentElement.dataset.kinAppearance;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#684033");
    if (this.appearanceSheet) this.appearanceSheet.replaceSync("");
    if (this.appearanceObjectUrl) URL.revokeObjectURL(this.appearanceObjectUrl);
    this.appearanceObjectUrl = null;
    this.appearanceImageBytes = null;
    this.appearanceImageType = null;
    if (this.appearanceBackground) { this.appearanceBackground.removeAttribute("src"); this.appearanceBackground.hidden = true; }
    this.removeAttribute("data-personal-background");
    this.appearance?.clear();
  }
  async loadPreviewBlob(record) {
    const session = this.ctx.session.captureSession();
    this.ctx.session.assertCurrentSession(session);
    const opened = await this.loadAttachmentForView(record, session);
    return opened.blob;
  }

  // Regression scripts call or replace these; each delegates to its controller.
  setAutoLockMinutes(...args) { return this.ctx.session.setAutoLockMinutes(...args); }
  runWorkspaceCommand(...args) { return this.ctx.append.runWorkspaceCommand(...args); }
  clearReminders(...args) { return this.ctx.records.clearReminders(...args); }
  initialize(...args) { return this.ctx.session.initialize(...args); }
  configureSyncCoordinator(...args) { return this.ctx.sync.configureSyncCoordinator(...args); }
  handleSyncState(...args) { return this.ctx.sync.handleSyncState(...args); }
  handleAddItem(...args) { return this.ctx.items.handleAddItem(...args); }
  handleAddHandoff(...args) { return this.ctx.conversations.handleAddHandoff(...args); }
  handleHandoffAction(...args) { return this.ctx.conversations.handleHandoffAction(...args); }
  saveTalk(...args) { return this.ctx.conversations.saveTalk(...args); }
  savePulse(...args) { return this.ctx.conversations.savePulse(...args); }
  saveRoutine(...args) { return this.ctx.routines.saveRoutine(...args); }
  changeRoutineSchedule(...args) { return this.ctx.routines.changeRoutineSchedule(...args); }
  instantiatePlaybook(...args) { return this.ctx.routines.instantiatePlaybook(...args); }
  handleLocalReminder(...args) { return this.ctx.records.handleLocalReminder(...args); }
  schedulePulseRefresh(...args) { return this.ctx.refresh.schedulePulseRefresh(...args); }
  clearBulkOutcome(...args) { return this.ctx.bulk.clearBulkOutcome(...args); }
  readAuthoritativeState(...args) { return this.ctx.refresh.readAuthoritativeState(...args); }
  handleItemAction(...args) { return this.ctx.items.handleItemAction(...args); }
  openPeerChannel(...args) { return this.ctx.peers.openPeerChannel(...args); }
  appendCommand(...args) { return this.ctx.append.appendCommand(...args); }
  handleCaughtUp(...args) { return this.ctx.refresh.handleCaughtUp(...args); }
  closePeerChannel(...args) { return this.ctx.peers.closePeerChannel(...args); }
  broadcastEventChange(...args) { return this.ctx.peers.broadcastEventChange(...args); }
  broadcastViewStateChange(...args) { return this.ctx.peers.broadcastViewStateChange(...args); }
  handlePeerMessage(...args) { return this.ctx.peers.handlePeerMessage(...args); }
  refreshFromEvents(...args) { return this.ctx.refresh.refreshFromEvents(...args); }
  renderState(...args) { return this.ctx.render.renderState(...args); }
  setStatus(...args) { return this.ctx.status.setStatus(...args); }
  clearAlert(...args) { return this.ctx.status.clearAlert(...args); }
  openUnlockedHousehold(...args) { return this.ctx.session.openUnlockedHousehold(...args); }
  lockHousehold(...args) { return this.ctx.session.lockHousehold(...args); }
  notifyPeerLock(...args) { return this.ctx.session.notifyPeerLock(...args); }
}

customElements.define("kin-app", KinApp);
