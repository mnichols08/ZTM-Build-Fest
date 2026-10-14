import { projectionContext } from "../browser-time.js";
import { LocalReminders } from "../reminders.js";
import { createCalendarExport } from "../calendar-export.js";
import { attachmentFileProblem, captureAttachment, loadLocalAttachmentRows, openAttachment, removeAttachment } from "../attachments/attachment-lifecycle.js";
import { clearAttachmentProgress, setAttachmentProgress } from "../attachments/attachment-progress.js";
import { AttachmentPreviewCache, isImageAttachment } from "../attachments/attachment-preview.js";
import { CLASSIFICATION_LABELS } from "./kin-compose.js";
import { passkeyUnlockSupported } from "../security/passkey-unlock.js";
import { listSegmentForClassification, PRIMARY_DESTINATIONS, resolveRoute, routeHash, SEGMENTS } from "../routes.js";
import { formatCivilDate } from "../today-view.js";
import { describePartialCapture, remainingCaptureSteps } from "../capture-plan.js";
import { describeNextOccurrence, describeRecurringCapture, describeScheduleChanged, isCadence, planScheduleChange, remainingRecurringSteps, SCHEDULE_MESSAGES } from "../recurrence.js";
import "./kin-routines.js";
import "./kin-areas.js";
import "./kin-notes.js";
import { loadKinEngine, randomId } from "../wasm/kin-engine.js";
import { EventStore } from "../storage/event-store.js";
import { loadCachedHouseholdSettings, SyncCoordinator } from "../sync/sync-coordinator.js";
import "./kin-compose.js";
import "./kin-quick-add.js";
import "./kin-command-palette.js";
import { isTypingContext, shortcutForKey } from "../keyboard-commands.js";
import { BULK_ACTIONS, describeBulkOutcome, planBulk, undoCommand, undoStatus } from "../bulk-actions.js";
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
import { clearLegacyDrafts } from "./kin-security.js";
import { paletteCss, paletteForSeed } from "../appearance/palette.js";
import { DEFAULT_APPEARANCE, loadAppearance, saveAppearance } from "../appearance/store.js";
import { DEFAULT_HOUSEHOLD_NAME, resolveAppearance } from "../appearance/household.js";
import {
  getActiveVault,
  setActiveVault,
  VaultError,
} from "../security/local-vault.js";

const START_ERROR =
  "Kin could not start its household engine or local storage. Your saved information was not intentionally deleted.";
const SAVE_ERROR =
  "Kin could not save that change locally. Your existing information was not intentionally deleted.";
const ATTACHMENT_OPEN_ERROR =
  "We couldn't open this attachment. Your existing household information hasn't been deleted.";
const AUTO_LOCK_KEY = "kin.auto-lock-minutes";
const INLINE_SAVE_FAILED = "Couldn't save. Your text is still here.";

// Plain-language explanations for sync pauses. The code is kept on the state
// object for debugging and tests; only the wording changes here.
const SYNC_PAUSE_MESSAGES = {
  device_not_trusted: "This device no longer has access to household updates. Everything already saved here stays on this device.",
  membership_removed: "This device no longer has access to household updates. Everything already saved here stays on this device.",
  authentication_required: "Sign in to your household again to keep syncing. Your changes are saved on this device until then.",
  connection_unavailable: "Your changes are saved on this device and will sync when you're connected.",
};

const NAV_ICONS = {
  today: '<path d="M3 10.8 12 3l9 7.8"/><path d="M5.5 9.5V20h13V9.5M9.5 20v-6h5v6"/>',
  lists: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  routines: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"/>',
  updates: '<path d="M8 10h8M8 14h5"/><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4l-3 3-3-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>',
  household: '<path d="M4 20V9l8-6 8 6v11"/><path d="M9 20v-5h6v5"/><circle cx="12" cy="10.5" r="1.6"/>',
};
const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>';
const LOCK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>';

function readAutoLockPreference() {
  try {
    const value = Number(localStorage.getItem(AUTO_LOCK_KEY));
    return [0, 5, 15, 60].includes(value) ? value : 0;
  } catch { return 0; }
}

const BULK_UNDO_WINDOW_MS = 10 * 60_000;
const BULK_UNDO_UNVERIFIED = "Unable to verify the latest item state. No changes were undone. Try again.";

class KinApp extends HTMLElement {
  constructor() {
    super();
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
    this.onHouseholdStatus = (event) => { this.householdStatus = event.detail; this.renderOnboarding(); this.updateSyncChip(); };
    this.onSecurityChanged = () => this.renderOnboarding();
    this.autoLockMinutes = readAutoLockPreference();
    this.autoLockTimer = null;
    this.lastActivityAt = null;
    this.onActivity = () => { if (this.autoLockTimer) this.scheduleAutoLock(); };
    this.onRetryAttachments = () => { if (this.syncCoordinator) void this.syncCoordinator.syncNow(); else void this.configureSyncCoordinator(); };
    this.onChangeResponsibility = (event) => this.handleChangeResponsibility(event);
    this.onReplenishStaple = (event) => this.handleReplenishStaple(event);
    this.syncState = null;
    // Follows the browser's own offline/online events, like the state notice.
    this.offline = typeof navigator !== "undefined" && navigator.onLine === false;
    this.onOffline = () => {
      this.offline = true;
      this.stateNotice.textContent = this.syncCoordinator || this.householdStatus?.identity
        ? "You're offline. Your changes are saved on this device and will sync when you're connected."
        : "You're offline. Your changes are saved on this device.";
      this.stateNotice.hidden = false;
      this.updateSyncChip();
    };
    this.onOnline = () => {
      this.offline = false;
      this.stateNotice.hidden = true;
      this.updateSyncChip();
      if (!this.vault || this.vault.locked || !this.store) return;
      this.setStatus(this.syncCoordinator ? "Back online. Syncing…" : "Back online.");
      if (this.syncCoordinator) void this.syncCoordinator.syncNow();
      else void this.configureSyncCoordinator();
    };
    this.onCompleteItem = (event) => this.handleCompleteItem(event);
    this.onReopenItem = (event) => this.handleReopenItem(event);
    this.onArchiveItem = (event) => this.handleArchiveItem(event);
    this.onAddItemStep = (event) => this.handleItemStep("add-item-step", event.detail);
    this.onCompleteItemStep = (event) => this.handleItemStep("complete-item-step", event.detail);
    this.onReopenItemStep = (event) => this.handleItemStep("reopen-item-step", event.detail);
    this.onArchiveItemStep = (event) => this.handleItemStep("archive-item-step", event.detail);
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
    this.onOpenRoutineSchedule = (event) => this.openRoutineSchedule(event.detail.routineId);
    this.onAreaIntent = (event) => this.saveArea(event.detail);
    this.onNoteIntent = (event) => this.saveNote(event.type.slice(4), event.detail);
    this.onReferenceIntent = (event) => this.saveReferenceRecord(event.type.slice(4), event.detail);
    this.onMaintenanceIntent = (event) => this.saveMaintenanceEvent(event.type.slice(4), event.detail);
    this.onItemAreaChange = (event) => this.saveArea({ ...event.detail, action: "assign-item-area" });
    this.onItemPlanningDateChange = (event) =>
      this.saveItemPlanningDate(event.detail, event.target.closest("kin-today, kin-item-detail"));
    this.onPinIntent = (event) => this.savePin(event.detail);
    this.onOpenPin = (event) => this.openPinnedItem(event.detail.itemId, event.detail.opener);
    // Today's empty states reuse the universal Quick add; focus returns to the
    // button that opened it, or to the Today heading once that button is gone.
    this.onOpenQuickAdd = (event) => this.quickAdd.open({ opener: event.detail?.opener, fallback: () => this.today.querySelector('[data-section="today"] h2') });
    this.onOpenItem = (event) => this.openItemDetail(event.detail.itemId, { opener: event.detail.opener ?? event.target });
    this.onCloseItemDetail = () => this.closeItemDetail({ restoreFocus: true });
    this.onOpenSearchResult = (event) => this.handleOpenSearchResult(event.detail);
    this.onPlaybookIntent = (event) => this.handlePlaybookIntent(event);
    this.onLocalReminder = (event) => this.handleLocalReminder(event.detail);
    this.onCancelLocalReminder = (event) => { this.localReminders.cancel(event.detail.id); this.renderReminders(); this.setStatus("Reminder canceled on this device."); };
    this.onModeChange = () => this.saveMode(this.modeSelect.value);
    this.pulseTimer = null;
    this.catchUpCursor = null;
    this.snapshotBoundary = null;
    this.onCaughtUp = () => this.handleCaughtUp();
    this.onSyncEnabled = (event) => this.startSyncCoordinator(event.detail);
    this.onSyncNow = () => void this.syncCoordinator?.syncNow();
    this.onSyncStop = (event) => {
      this.syncCoordinator?.stop();
      this.syncCoordinator = null;
      this.syncState = null;
      this.updateSyncChip();
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
    this.onBulkItemAction = (event) => this.handleBulkItemAction(event);
    this.onBulkUndo = (event) => this.handleBulkUndo(event);
    this.onBulkRetry = (event) => this.handleBulkRetry(event);
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
      void this.checkHouseholdAuthorization();
    };
    this.onPeerMessage = (event) => this.handlePeerMessage(event);
    this.onLockRequest = () => this.lockHousehold();
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
      if (event.data?.type === "KIN_UPDATE_READY") this.showUpdateNotice();
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
        if (registration.waiting && navigator.serviceWorker.controller) this.showUpdateNotice();
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) this.showUpdateNotice();
          });
        });
      }).catch(() => {
        // Online use still follows the same security boundary without offline cache.
      });
    }
    if (!this.initialized) {
      this.initializeElements();
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
      () => void this.checkHouseholdAuthorization(),
      30_000,
    );
    this.openPeerChannel();
    if (this.store) {
      // Reconnecting must not restart the engine or unlock an in-flight save.
      this.pendingRefresh = true;
      this.flushPeerRefresh();
      void this.configureSyncCoordinator();
    } else {
      this.initialize();
    }
  }

  async handleReplenishStaple(event) {
    const staple = this.state?.items.find(
      (item) =>
        item.itemId === event.detail.itemId &&
        item.classification === "staple" &&
        item.status === "active",
    );
    if (!staple) {
      this.pendingRefresh = true;
      this.flushPeerRefresh();
      this.setStatus("That staple is no longer available. Updating the list.");
      return;
    }
    return this.handleAddItem({
      detail: {
        text: staple.text,
        classification: "shopping",
        sourceStapleId: staple.itemId,
      },
    });
  }

  initializeElements() {
    clearLegacyDrafts();
    const header = document.createElement("header");
    header.className = "site-header";
    const brand = document.createElement("a");
    brand.className = "brand";
    brand.href = "#today";
    brand.setAttribute("aria-label", "Kin — Today");
    const mark = document.createElement("img");
    mark.className = "brand-mark";
    mark.src = "/icon.svg";
    mark.alt = "";
    const title = document.createElement("span");
    title.textContent = "Kin";
    title.className = "brand-name";
    this.brandTitle = title;
    brand.append(mark, title);
    brand.addEventListener("click", this.onNavigationClick);
    // Header tools exist only while unlocked: search entry, truthful sync
    // state, and a lock action that is always one tap away.
    const tools = document.createElement("div");
    tools.className = "site-tools";
    tools.hidden = true;
    this.searchLink = document.createElement("a");
    this.searchLink.className = "header-search";
    this.searchLink.href = "#search";
    this.searchLink.innerHTML = `${SEARCH_ICON}<span>Search</span>`;
    this.searchLink.setAttribute("aria-label", "Search household");
    this.searchLink.setAttribute("aria-keyshortcuts", "/");
    this.searchLink.addEventListener("click", this.onNavigationClick);
    this.syncChip = document.createElement("kin-sync-status");
    this.quickAdd = document.createElement("kin-quick-add");
    this.lockButton = document.createElement("button");
    this.lockButton.type = "button";
    this.lockButton.className = "header-lock";
    this.lockButton.innerHTML = `${LOCK_ICON}<span>Lock</span>`;
    this.lockButton.setAttribute("aria-label", "Lock Kin");
    this.lockButton.addEventListener("click", () => this.lockHousehold());
    tools.append(this.quickAdd, this.searchLink, this.syncChip, this.lockButton);
    this.siteTools = tools;
    header.append(brand, tools);
    this.header = header;

    this.appearanceBackground = document.createElement("img");
    this.appearanceBackground.className = "personal-background";
    this.appearanceBackground.alt = "";
    this.appearanceBackground.setAttribute("aria-hidden", "true");

    const shell = document.createElement("div");
    shell.className = "application-shell";
    this.shell = shell;

    const nav = document.createElement("nav");
    nav.className = "primary-nav";
    nav.setAttribute("aria-label", "Main");
    nav.hidden = true;
    this.navLinks = new Map();
    for (const { id, label } of PRIMARY_DESTINATIONS) {
      const link = document.createElement("a");
      link.className = "nav-link";
      link.href = routeHash(id);
      link.dataset.page = id;
      link.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[id]}</svg><span>${label}</span>`;
      nav.append(link);
      this.navLinks.set(id, link);
    }
    this.nav = nav;
    nav.addEventListener("click", this.onNavigationClick);

    const main = document.createElement("main");
    main.id = "main";
    main.tabIndex = -1;
    main.setAttribute("aria-busy", "true");
    main.hidden = true;
    main.addEventListener("click", this.onNavigationClick);
    this.main = main;
    this.catchUp = document.createElement("kin-catch-up");
    this.today = document.createElement("kin-today");
    this.needs = document.createElement("kin-today");
    this.shopping = document.createElement("kin-today");
    this.staples = document.createElement("kin-today");
    this.compose = document.createElement("kin-compose");
    this.handoffs = document.createElement("kin-handoff-list");
    this.talks = document.createElement("kin-talk-list");
    this.search = document.createElement("kin-search");
    this.pulse = document.createElement("kin-pulse");
    this.routines = document.createElement("kin-routines");
    this.areas = document.createElement("kin-areas");
    this.detail = document.createElement("kin-item-detail");
    this.buildViews(main);
    shell.append(nav, main);

    const feedback = document.createElement("div");
    feedback.className = "app-feedback";
    this.status = document.createElement("p");
    this.status.className = "status-message";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.alert = document.createElement("p");
    this.alert.className = "error-message";
    this.alert.setAttribute("role", "alert");
    this.alert.hidden = true;
    this.stateNotice = document.createElement("p");
    this.stateNotice.className = "state-notice";
    this.stateNotice.setAttribute("role", "status");
    this.stateNotice.setAttribute("aria-live", "polite");
    this.stateNotice.hidden = true;
    main.prepend(this.stateNotice);
    this.routeAnnouncement = document.createElement("p");
    this.routeAnnouncement.className = "visually-hidden";
    this.routeAnnouncement.setAttribute("role", "status");
    this.routeAnnouncement.setAttribute("aria-live", "polite");
    this.routeAnnouncement.setAttribute("aria-atomic", "true");
    this.retryButton = document.createElement("button");
    this.retryButton.type = "button";
    this.retryButton.className = "retry-button";
    this.retryButton.textContent = "Try again";
    this.retryButton.hidden = true;
    feedback.append(this.status, this.alert, this.retryButton);
    this.feedback = feedback;

    this.security = document.createElement("kin-security");
    this.security.onUnlocked = (vault) => this.openUnlockedHousehold(vault);
    this.security.onLockRequested = () => this.lockHousehold();
    this.replaceChildren(this.appearanceBackground, header, this.security, shell, feedback, this.routeAnnouncement);
    this.updateNotice = document.createElement("section");
    this.updateNotice.className = "update-notice";
    this.updateNotice.setAttribute("aria-label", "Application update");
    this.updateNotice.setAttribute("role", "status");
    const updateMessage = document.createElement("span");
    updateMessage.textContent = "A new Kin version is ready.";
    const updateNow = document.createElement("button");
    updateNow.type = "button";
    updateNow.textContent = "Update now";
    updateNow.addEventListener("click", () => {
      const focusedEditor = document.activeElement?.matches?.("input, textarea, select, [contenteditable='true']");
      const hasDraft = this.compose?.input?.value.trim() || this.routines?.hasDraft || this.detail?.hasDraft || this.notes?.editor?.title.trim() || this.notes?.editor?.body.trim() ||
        [this.needs, this.shopping, this.staples].some((list) => list.composer?.input?.value.trim());
      if (this.busy || focusedEditor || hasDraft) {
        this.setStatus("Finish or save your current edit before updating Kin.");
        return;
      }
      this.updateRequested = true;
      this.updateRegistration?.waiting?.postMessage({ type: "KIN_SKIP_WAITING" });
    });
    const updateLater = document.createElement("button");
    updateLater.type = "button";
    updateLater.textContent = "Later";
    updateLater.addEventListener("click", () => { this.updateNotice.hidden = true; });
    this.updateNotice.append(updateMessage, updateNow, updateLater);
    this.updateNotice.hidden = true;
    this.prepend(this.updateNotice);
    this.retryButton.addEventListener("click", () => this.retryAction?.());
    this.viewer = this.buildAttachmentViewer();
    this.append(this.viewer);
    this.detailSheet = this.buildDetailSheet();
    this.append(this.detailSheet);
    this.commandPalette = document.createElement("kin-command-palette");
    this.commandPalette.onCommand = (id, { opener }) => {
      if (this.commandGeneration === this.securityGeneration) this.runWorkspaceCommand(id, { opener });
    };
    this.commandPalette.onDismiss = ({ opener }) => this.restoreCommandFocus(opener);
    this.append(this.commandPalette);
    this.attachmentInput = this.buildAttachmentInput();
    this.append(this.attachmentInput);
    this.showPageFromLocation();
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
    if (!this.vault || this.vault.locked || !this.store) { this.showAlert("Unlock Kin before attaching a file."); return; }
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

  showUpdateNotice() {
    if (this.updateNotice) this.updateNotice.hidden = false;
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

  // The onboarding card on Today explains the next step until the device has a
  // household and a passkey; every action it offers is the ordinary flow.
  renderOnboarding() {
    const card = this.onboarding;
    if (!card || !this.vault || this.vault.locked) return;
    card.replaceChildren();
    const status = this.householdStatus;
    const passkeys = this.security?.passkeyWrappers?.length ?? 0;
    const heading = document.createElement("h2");
    const goTo = (intent) => {
      this.navigate("#household/people");
      this.household?.startIntent?.(intent);
    };
    if (status && !status.identity && !status.claimState && status.lifecycle !== "deleted" && status.lifecycle !== "deletion_pending") {
      heading.textContent = "Get started";
      const intro = document.createElement("p");
      intro.textContent = "This device is protected. Next, connect it to your household so it can sync with other people and devices.";
      const choices = document.createElement("div");
      choices.className = "household-choices";
      for (const [label, intent, className] of [
        ["Create a household", "create", "primary-action"],
        ["Join an existing household", "join", ""],
        ["Add this device to my existing membership", "device", ""],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (className) button.className = className;
        button.addEventListener("click", () => goTo(intent));
        choices.append(button);
      }
      const note = document.createElement("p");
      note.className = "section-hint";
      note.textContent = "You can keep using Kin on this device meanwhile; everything stays encrypted here.";
      card.append(heading, intro, choices, note);
      card.hidden = false;
      return;
    }
    if (status?.claimState === "Claimed" || status?.claimState === "Confirmed") {
      heading.textContent = status.claimState === "Confirmed" ? "Almost there" : "Waiting for approval";
      const intro = document.createElement("p");
      intro.textContent = status.claimState === "Confirmed"
        ? "Your device was approved. Open Household → People & devices to compare the device key and finish activating this device."
        : "This device needs approval from an existing household member. Keep Kin open on both devices and compare the device keys together.";
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Open People & devices";
      open.addEventListener("click", () => { this.navigate("#household/people"); this.household?.scrollIntoView?.({ block: "start" }); });
      card.append(heading, intro, open);
      card.hidden = false;
      return;
    }
    if (status?.identity && passkeys === 0 && passkeyUnlockSupported() && !this.passkeyPromptDismissed) {
      heading.textContent = "Unlock faster next time";
      const intro = document.createElement("p");
      intro.textContent = "Turn on passkey unlock so your face, fingerprint, or screen lock opens Kin on this device. Your recovery key stays as a backup.";
      const turnOn = document.createElement("button");
      turnOn.type = "button";
      turnOn.className = "primary-action";
      turnOn.textContent = "Turn on passkey unlock";
      turnOn.addEventListener("click", async () => {
        turnOn.disabled = true;
        try {
          await this.security.run(() => this.security.addPasskey());
          if (this.security.alert.textContent) this.showAlert(this.security.alert.textContent);
          else this.setStatus("Passkey unlock is on for this device.");
        } finally { this.renderOnboarding(); }
      });
      const later = document.createElement("button");
      later.type = "button";
      later.textContent = "Not now";
      later.addEventListener("click", () => { this.passkeyPromptDismissed = true; this.renderOnboarding(); });
      card.append(heading, intro, turnOn, later);
      card.hidden = false;
      return;
    }
    card.hidden = true;
  }

  setAutoLockMinutes(minutes) {
    this.autoLockMinutes = [0, 5, 15, 60].includes(minutes) ? minutes : 0;
    try { localStorage.setItem(AUTO_LOCK_KEY, String(this.autoLockMinutes)); } catch { /* Preference only; lock-on-close still applies. */ }
    this.scheduleAutoLock();
  }

  scheduleAutoLock() {
    clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
    if (!this.vault || this.vault.locked || !this.autoLockMinutes) {
      this.lastActivityAt = null;
      return;
    }
    this.lastActivityAt = Date.now();
    const vault = this.vault;
    const generation = this.securityGeneration;
    this.autoLockTimer = setTimeout(() => {
      this.autoLockTimer = null;
      if (vault !== this.vault || generation !== this.securityGeneration || vault.locked) return;
      this.lockHousehold();
      this.setStatus("Kin locked after inactivity. Unlock to continue.");
    }, this.autoLockMinutes * 60_000);
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
    this.assertCurrentSession(session);
    return opened;
  }

  async handleViewAttachment(event) {
    if (!this.store || !this.viewer) { this.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const session = this.captureSession();
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
      if (error.code !== "locked" && this.isCurrentSession(session)) this.showAlert(ATTACHMENT_OPEN_ERROR);
    }
  }

  buildViews(main) {
    const page = (id, title, description = null) => {
      const section = document.createElement("section");
      section.className = "app-view";
      section.id = id;
      section.dataset.page = id;
      section.setAttribute("aria-labelledby", `${id}-title`);
      const intro = document.createElement("header");
      intro.className = "page-intro";
      const heading = document.createElement("h1");
      heading.id = `${id}-title`;
      heading.tabIndex = -1;
      heading.textContent = title;
      intro.append(heading);
      if (description) {
        const supporting = document.createElement("p");
        supporting.className = "page-lead";
        supporting.textContent = description;
        intro.append(supporting);
      }
      section.append(intro);
      return section;
    };
    const segmentNav = (pageId, label) => {
      const nav = document.createElement("kin-segment-nav");
      nav.setAttribute("label", label);
      nav.segments = SEGMENTS[pageId].map((entry) => ({ id: entry.id, label: entry.id === "hub" ? "Overview" : entry.label, hash: routeHash(pageId, entry.id) }));
      return nav;
    };
    this.pages = new Map();
    this.segmentNavs = new Map();
    this.segmentPanels = new Map();

    // Today: a practical heading (the date), the capture field, catch-up, the
    // onboarding card while it applies, and the composition.
    const today = page("today", "Today");
    this.todayDate = document.createElement("p");
    this.todayDate.className = "page-lead today-date";
    today.querySelector(".page-intro").append(this.todayDate);
    this.compose.setAttribute("mode", "today");
    this.compose.setAttribute("scope", "today");
    this.catchUp.setAttribute("aria-label", "Catch up since you last looked");
    this.today.display = "today";
    this.today.previews = this.previewProvider;
    this.onboarding = document.createElement("section");
    this.onboarding.className = "today-section onboarding-card";
    this.onboarding.hidden = true;
    today.append(this.compose, this.catchUp, this.onboarding, this.today);

    // Lists: one list at a time, each with its own quick-add; export lives in
    // the list actions with its warning at the point of use.
    const lists = page("lists", "Lists");
    const listsNav = segmentNav("lists", "Lists");
    this.segmentNavs.set("lists", listsNav);
    lists.append(listsNav);
    const listActions = document.createElement("details");
    listActions.className = "list-actions";
    const listActionsSummary = document.createElement("summary");
    listActionsSummary.textContent = "List actions";
    this.calendarExportButton = document.createElement("button");
    this.calendarExportButton.type = "button";
    this.calendarExportButton.className = "calendar-export-button";
    this.calendarExportButton.textContent = "Download calendar (.ics)";
    this.calendarExportButton.setAttribute("aria-label", "Download active planned Items as an all-day calendar");
    this.calendarExportButton.disabled = true;
    this.calendarExportButton.addEventListener("click", () => this.downloadCalendar());
    const calendarExportNote = document.createElement("p");
    calendarExportNote.className = "section-hint";
    calendarExportNote.textContent = "Exports every open item that has a planned date, from all lists. The downloaded .ics file is not encrypted and contains the item text.";
    listActions.append(listActionsSummary, this.calendarExportButton, calendarExportNote);
    lists.append(listActions);
    this.needs.display = "need";
    this.shopping.display = "shopping";
    this.staples.display = "staple";
    const listPanels = new Map([["todo", this.needs], ["shopping", this.shopping], ["staples", this.staples]]);
    for (const [segment, list] of listPanels) {
      list.previews = this.previewProvider;
      list.dataset.segment = segment;
      lists.append(list);
    }
    this.segmentPanels.set("lists", listPanels);

    const search = page("search", "Search");
    search.append(this.search);

    const routines = page("routines", "Routines");
    const routinesNav = segmentNav("routines", "Routines");
    this.segmentNavs.set("routines", routinesNav);
    routines.append(routinesNav, this.routines);

    const updates = page("updates", "Updates", "Handoffs pass context to someone; Talk keeps topics for a calm moment.");
    const updatesNav = segmentNav("updates", "Updates");
    this.segmentNavs.set("updates", updatesNav);
    const handoffPanel = document.createElement("section");
    handoffPanel.id = "handoffs-panel";
    handoffPanel.setAttribute("aria-label", "Handoffs");
    const talkPanel = document.createElement("section");
    talkPanel.id = "talk-panel";
    talkPanel.setAttribute("aria-label", "Talk");
    handoffPanel.append(this.handoffs);
    talkPanel.append(this.talks);
    updates.append(updatesNav, handoffPanel, talkPanel);
    this.segmentPanels.set("updates", new Map([["handoffs", handoffPanel], ["talk", talkPanel]]));

    // Household: an overview plus secondary destinations. Appearance remains
    // personal while the five primary destinations stay unchanged.
    const household = page("household", "Household");
    const householdNav = segmentNav("household", "Household");
    this.segmentNavs.set("household", householdNav);
    household.append(householdNav);
    const hub = document.createElement("section");
    hub.className = "household-hub";
    hub.setAttribute("aria-label", "Household overview");
    this.householdGlance = document.createElement("p");
    this.householdGlance.className = "household-glance";
    const hubLinks = document.createElement("ul");
    hubLinks.className = "hub-links";
    for (const [segment, description] of [
      ["notes", "Notes, reference details, and maintenance history."],
      ["areas", "Areas, household mode, and Pulse."],
      ["people", "Members, pairing, trusted devices, and access."],
      ["privacy", "Lock, passkeys, recovery key, export, and restore."],
      ["appearance", "Your colors and optional background on this device."],
    ]) {
      const entry = SEGMENTS.household.find((candidate) => candidate.id === segment);
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "hub-link";
      link.href = routeHash("household", segment);
      const name = document.createElement("span");
      name.className = "hub-link-name";
      name.textContent = entry.label;
      const text = document.createElement("span");
      text.className = "hub-link-text";
      text.textContent = description;
      link.append(name, text);
      item.append(link);
      hubLinks.append(item);
    }
    hub.append(this.householdGlance, hubLinks);
    const hubTools = document.createElement("div");
    hubTools.className = "hub-tools";
    this.installButton = document.createElement("button");
    this.installButton.type = "button";
    this.installButton.textContent = "Install Kin";
    this.installButton.hidden = true;
    this.installButton.addEventListener("click", async () => {
      const prompt = this.deferredInstallPrompt;
      if (!prompt) return;
      this.deferredInstallPrompt = null;
      this.installButton.hidden = true;
      await prompt.prompt();
      await prompt.userChoice;
    });
    if (this.deferredInstallPrompt) this.installButton.hidden = false;
    const searchLink = document.createElement("a");
    searchLink.className = "more-search-link";
    searchLink.href = "#search";
    searchLink.textContent = "Search household";
    hubTools.append(searchLink, this.installButton);
    hub.append(hubTools);

    const notesPage = document.createElement("section");
    notesPage.className = "household-subpage";
    notesPage.setAttribute("aria-label", "Notes & reference");
    this.notes = document.createElement("kin-notes");
    this.notes.previews = this.previewProvider;
    notesPage.append(this.notes);

    const areasPage = document.createElement("section");
    areasPage.className = "household-subpage";
    areasPage.setAttribute("aria-label", "Areas & status");
    const modeSection = document.createElement("section");
    modeSection.className = "today-section household-mode";
    const modeHeading = document.createElement("h2");
    modeHeading.textContent = "Household mode";
    const modeLabel = document.createElement("label");
    modeLabel.htmlFor = "household-mode";
    modeLabel.textContent = "Current mode";
    this.modeSelect = document.createElement("select");
    this.modeSelect.id = "household-mode";
    for (const [value, label] of [
      ["normal", "Normal"],
      ["vacation", "Vacation"],
      ["guests", "Guests"],
      ["rest", "Rest"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.modeSelect.append(option);
    }
    this.modeSelect.addEventListener("change", this.onModeChange);
    const modeHint = document.createElement("p");
    modeHint.className = "section-hint";
    modeHint.textContent = "Routines pause while the household is in Vacation, Guests, or Rest; their definitions stay as they are. Nothing else changes: lists, handoffs, and access are unaffected, and Guests does not add a member.";
    modeSection.append(modeHeading, modeLabel, this.modeSelect, modeHint);
    areasPage.append(this.areas, modeSection, this.pulse);

    const peoplePage = document.createElement("section");
    peoplePage.className = "household-subpage";
    peoplePage.setAttribute("aria-label", "People & devices");
    this.household = document.createElement("kin-household");
    this.peoplePage = peoplePage;

    const privacyPage = document.createElement("section");
    privacyPage.className = "household-subpage";
    privacyPage.setAttribute("aria-label", "Privacy & recovery");
    const privacyLead = document.createElement("p");
    privacyLead.className = "section-hint";
    privacyLead.textContent = "Your household is encrypted on this device. Lock Kin whenever you step away; closing or reloading always locks it.";
    privacyPage.append(privacyLead);
    this.privacyPage = privacyPage;
    // Kept for callers that still address the former More security block.
    this.moreSecurity = privacyPage;

    const appearancePage = document.createElement("section");
    appearancePage.className = "household-subpage appearance-page";
    appearancePage.setAttribute("aria-label", "Personal appearance");
    this.appearance = document.createElement("kin-appearance");
    this.householdDefaults = document.createElement("kin-household-defaults");
    this.householdDefaults.hidden = true;
    appearancePage.append(this.householdDefaults, this.appearance);

    household.append(hub, notesPage, areasPage, peoplePage, privacyPage, appearancePage);
    this.segmentPanels.set("household", new Map([["hub", hub], ["notes", notesPage], ["areas", areasPage], ["people", peoplePage], ["privacy", privacyPage], ["appearance", appearancePage]]));

    for (const section of [today, lists, search, routines, updates, household]) {
      this.pages.set(section.id, section);
      main.append(section);
    }
    // The conditional side/inline column for item details.
    this.detailPanel = document.createElement("aside");
    this.detailPanel.className = "detail-panel";
    this.detailPanel.setAttribute("aria-label", "Item details");
    this.detailPanel.hidden = true;
    main.append(this.detailPanel);
    this.showPageFromLocation();
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

  // --- Keyboard commands --------------------------------------------------

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

  // The allowlisted command ids map onto the same methods the visible
  // navigation, Search link, and Quick add button use.
  runWorkspaceCommand(id, { opener = null } = {}) {
    if (!this.workspaceReady()) return;
    switch (id) {
      case "today":
        this.navigate("#today");
        this.pages.get("today")?.querySelector("h1")?.focus();
        return;
      case "todo":
      case "shopping":
        this.navigate(routeHash("lists", id));
        this.segmentNavs.get("lists")?.focusCurrent();
        return;
      case "search":
        this.navigate("#search");
        this.search.focusInput?.();
        return;
      case "quick-add":
        if (this.quickAdd.isDisabled) {
          this.setStatus("Quick add is available again once Kin finishes saving.");
          this.restoreCommandFocus(opener);
          return;
        }
        this.quickAdd.open({ opener, fallback: () => this.main.querySelector(".app-view:not([hidden]) h1") });
        return;
      case "shortcuts":
        this.commandGeneration = this.securityGeneration;
        this.commandPalette.openHelp({ opener });
        return;
    }
  }

  restoreCommandFocus(opener) {
    if (!this.workspaceReady()) return;
    if (opener?.isConnected && !opener.closest("[hidden], [inert]") && opener.getClientRects().length) opener.focus();
    else this.main.querySelector(".app-view:not([hidden]) h1")?.focus();
  }

  // Kept for callers that switched the former Handoff/Talk tabs directly.
  showHandoffPanel(id, focus = false) {
    const segment = id === "talk" ? "talk" : "handoffs";
    this.navigate(routeHash("updates", segment));
    if (focus) this.segmentNavs.get("updates")?.focusCurrent();
  }

  // --- Item details -------------------------------------------------------

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

  renderReminders() {
    const reminders = new Map([...this.localReminders.entries].map(([id, entry]) => [id, { at: entry.at }]));
    if (this.routines) this.routines.reminders = reminders;
    if (this.selection) this.detail.reminder = reminders.get(`item:${this.selection.itemId}`) ?? null;
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

  updateSyncChip() {
    if (!this.syncChip) return;
    if (!this.vault || this.vault.locked || !this.store) { this.syncChip.state = null; return; }
    if (this.offline || navigator.onLine === false) { this.syncChip.state = this.syncCoordinator || this.householdStatus?.identity ? "offline-sync" : "offline"; return; }
    if (!this.syncCoordinator) { this.syncChip.state = "local"; return; }
    const state = this.syncState?.state;
    this.syncChip.state = state === "syncing" ? "syncing" : state === "paused" || state === "deleted" ? "paused" : state === "ready" ? "ready" : "syncing";
  }

  disconnectedCallback() {
    this.lockHousehold(false);
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

  captureSession() {
    return {
      generation: this.securityGeneration,
      vault: this.vault,
      store: this.store,
      engine: this.engine,
    };
  }

  isCurrentSession(session) {
    return (
      session.generation === this.securityGeneration &&
      session.vault === this.vault &&
      Boolean(session.vault) &&
      !session.vault.locked &&
      (!Object.hasOwn(session, "store") || session.store === this.store) &&
      (!Object.hasOwn(session, "engine") || session.engine === this.engine)
    );
  }

  assertCurrentSession(session) {
    if (!this.isCurrentSession(session))
      throw new VaultError(
        "Kin was locked or reopened during the operation.",
        "locked",
      );
  }

  async initialize() {
    if (this.starting && this.startingGeneration === this.securityGeneration)
      return this.starting;
    const starting = this.loadApplication();
    this.starting = starting;
    this.startingGeneration = this.securityGeneration;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  async loadApplication() {
    const session = { generation: this.securityGeneration, vault: this.vault };
    if (!session.vault || session.vault.locked) {
      await this.security.initialize();
      if (session.generation !== this.securityGeneration || this.vault) return;
      this.setBusy(false);
      this.setStatus("Household locked.");
      return;
    }
    const retrying = !this.retryButton.hidden;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Starting Kin…");
    try {
      this.syncCoordinator?.stop();
      this.syncCoordinator = null;
      this.store?.close();
      this.store = null;
      this.engine?.dispose?.();
      this.engine = null;
      const engine = await loadKinEngine();
      if (!this.isCurrentSession(session)) {
        engine.dispose();
        this.assertCurrentSession(session);
      }
      this.engine = engine;
      session.engine = engine;
      const store = await EventStore.open({ vault: session.vault, engine });
      if (!this.isCurrentSession(session)) {
        store.close();
        this.assertCurrentSession(session);
      }
      this.store = store;
      session.store = store;
      this.openPeerChannel();
      const snapshot = await store.getCatchUpState();
      this.assertCurrentSession(session);
      this.applyCatchUpSnapshot(snapshot);
      await this.restoreCachedHouseholdDefaults(snapshot.syncIdentity, session);
      this.renderState();
      void this.refreshAttachmentRows();
      this.main.hidden = false;
      this.nav.hidden = false;
      this.siteTools.hidden = false;
      this.peoplePage.append(this.household);
      this.privacyPage.append(this.security);
      this.showPageFromLocation();
      this.setStatus("Ready.");
      this.updateSyncChip();
      if (navigator.onLine === false) this.onOffline();
      this.retryButton.hidden = true;
      void this.configureSyncCoordinator();
    } catch (error) {
      if (this.isCurrentSession(session)) {
        this.lockHousehold();
        this.security.error(error.userMessage ? error : new Error(START_ERROR));
      }
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (retrying && this.store) this.compose.focusInput();
        this.flushPeerRefresh();
      }
    }
  }

  async configureSyncCoordinator() {
    if (!this.vault || this.vault.locked || !this.store) return;
    const session = this.captureSession();
    try {
      const identityResponse = await fetch("/api/status");
      this.assertCurrentSession(session);
      if (!identityResponse.ok) return;
      const { identity } = await identityResponse.json();
      this.assertCurrentSession(session);
      if (!identity) return;
      const syncResponse = await fetch("/api/sync/status");
      this.assertCurrentSession(session);
      if (!syncResponse.ok) return;
      const syncStatus = await syncResponse.json();
      this.assertCurrentSession(session);
      if (syncStatus.enabled) await this.startSyncCoordinator(identity);
    } catch {
      // Local household use remains available while the service is unreachable.
    }
  }

  async checkHouseholdAuthorization() {
    if (!this.vault || this.vault.locked) return;
    const session = this.captureSession();
    const household = this.household;
    const identity = household?.identity;
    if (
      !identity ||
      this.checkingAuthorization ||
      document.visibilityState === "hidden"
    )
      return;
    this.checkingAuthorization = true;
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      this.assertCurrentSession(session);
      if (!response.ok) return;
      const status = await response.json();
      this.assertCurrentSession(session);
      if (
        this.household !== household ||
        household.identity !== identity ||
        status.identity
      )
        return;
      this.lockHousehold();
    } catch {
      // Keep local household use available while the service is unreachable.
    } finally {
      if (this.isCurrentSession(session)) this.checkingAuthorization = false;
    }
  }

  async startSyncCoordinator(identity) {
    if (!this.vault || this.vault.locked || !this.store || !this.engine) return;
    const session = this.captureSession();
    if (this.syncCoordinator?.identity.deviceId === identity.deviceId)
      return this.syncCoordinator.syncNow();
    this.syncCoordinator?.stop();
    let coordinator;
    coordinator = new SyncCoordinator({
      store: session.store,
      engine: session.engine,
      identity,
      onState: (value) => {
        if (
          this.isCurrentSession(session) &&
          this.syncCoordinator === coordinator
        )
          this.handleSyncState(value);
      },
    });
    this.syncCoordinator = coordinator;
    this.updateSyncChip();
    try {
      await coordinator.start();
      if (this.isCurrentSession(session) && this.syncCoordinator === coordinator) await this.refreshHouseholdDefaults();
    } catch (error) {
      if (
        this.isCurrentSession(session) &&
        this.syncCoordinator === coordinator
      ) {
        this.handleSyncState({
          state: "paused",
          code: error.code,
          message: error.message || "Device sync is paused.",
        });
      }
    } finally {
      if (
        !this.isCurrentSession(session) ||
        this.syncCoordinator !== coordinator
      )
        coordinator.stop();
    }
  }

  handleSyncState(value) {
    if (!this.vault || this.vault.locked) return;
    if (value.state) { this.syncState = value; this.updateSyncChip(); }
    if (value.state === "paused") {
      const attention = SYNC_PAUSE_MESSAGES[value.code] ?? value.message;
      if (attention) {
        this.stateNotice.textContent = attention;
        this.stateNotice.hidden = false;
      }
    } else if (["ready", "disabled"].includes(value.state)) {
      this.stateNotice.hidden = true;
      if (value.state === "ready") void this.refreshHouseholdDefaults();
    }
    if (value.projection && value.added > 0) {
      if (this.busy) {
        this.pendingRefresh = true;
      } else {
        this.state = value.projection;
        this.snapshotBoundary = value.snapshotBoundary;
        this.renderState();
        if (value.snapshotBoundary) this.broadcastEventChange();
      }
    }
    if (Array.isArray(value.attachmentRows)) {
      const rows = this.mergeAttachmentRows(value.attachmentRows);
      const sameRows = rows.length === this.attachmentRows.length && rows.every((row, index) => {
        const current = this.attachmentRows[index];
        return current && ["attachmentId", "parentKind", "parentId", "name", "size", "type", "state"]
          .every((key) => row[key] === current[key]);
      });
      if (!sameRows) {
        this.attachmentRows = rows;
        this.renderState();
      }
    }
    if (Array.isArray(value.memberIds)) {
      const memberIds = [...new Set(value.memberIds)];
      const previousMembers = new Set(this.activeMemberIds ?? []);
      const membershipChanged = memberIds.length !== previousMembers.size || memberIds.some((id) => !previousMembers.has(id));
      this.activeMemberIds = memberIds;
      if (membershipChanged) this.renderState();
      void this.reconcileResponsibilityMembers();
    }
    // The sync chip already shows routine progress. Toast only meaningful
    // incoming changes or an unusual state, not every five-second idle poll.
    if (value.message && value.state !== "paused" &&
        (value.quarantined > 0 || !["syncing", "ready", "disabled"].includes(value.state)))
      this.setStatus(value.message);
  }

  async handleAddItem(event) {
    if (this.busy || !this.store || !this.engine) {
      return;
    }
    const session = this.captureSession();
    // Every capture carries a client-generated id (hex, like projection ids)
    // so a retry after a partial success resumes against the same record
    // instead of creating another.
    const composer = event.detail.composer?.isConnected ? event.detail.composer : this.compose;
    const incoming = {
      text: event.detail.text,
      classification: event.detail.classification,
      planningDate: Number.isSafeInteger(event.detail.planningDate) ? event.detail.planningDate : null,
      pinned: Boolean(event.detail.pinned),
      cadence: isCadence(event.detail.cadence) ? event.detail.cadence : null,
      revision: event.detail.revision ?? 0,
      ...(event.detail.sourceStapleId ? { sourceStapleId: event.detail.sourceStapleId } : {}),
    };
    let pending = this.pendingCapture;
    const matches = (draft) => draft && draft.text === incoming.text && draft.classification === incoming.classification &&
      draft.planningDate === incoming.planningDate && draft.pinned === incoming.pinned && draft.sourceStapleId === incoming.sourceStapleId && draft.cadence === incoming.cadence && draft.revision === incoming.revision;
    if (pending && pending.composer !== composer) pending = null;
    if (pending && !matches(pending.draft)) {
      composer.showPendingCapture?.({
        finish: pending.retry,
        startNew: () => { this.pendingCapture = null; composer.clearResult?.(); this.handleAddItem(event); },
      });
      this.setStatus("An earlier item is partly saved. Finish it or choose Start a new item.");
      return;
    }
    const submittedDraft = Object.freeze({
      ...incoming,
      id: pending?.draft.id ?? event.detail.id ?? crypto.randomUUID().replaceAll("-", ""),
      revision: incoming.revision,
    });
    const sourceList = submittedDraft.sourceStapleId ? this.staples : null;
    // The capture form that submitted owns clearing and focus; the Today form
    // is the default for retries that carry no composer.
    const destination = CLASSIFICATION_LABELS[submittedDraft.classification] ?? "your lists";
    const retry = () => this.handleAddItem({ detail: { ...submittedDraft, composer } });
    if (pending) pending.retry = retry;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    let restoreComposeFocus = false;
    let step = null;
    try {
      // A repeating task is a Routine: one create command, nothing partial.
      const steps = submittedDraft.cadence ? remainingRecurringSteps(this.state, submittedDraft) : remainingCaptureSteps(this.state, submittedDraft);
      for (step of steps) {
        await this.appendCommand(step);
        this.assertCurrentSession(session);
      }
      step = null;
      this.renderState();
      if (!sourceList) composer.clearIfMatches(submittedDraft);
      const where = submittedDraft.planningDate === this.currentCivilDate() ? `${destination} and Today` : destination;
      const recurring = submittedDraft.cadence ? this.state.routines?.find((routine) => routine.routineId === submittedDraft.id) : null;
      this.setStatus(`${recurring ? describeRecurringCapture(recurring, this.currentCivilDate()) : `Added to ${where}.`}${this.offlineSyncSuffix()}`);
      if (!sourceList) composer.showResult?.(this.syncCoordinator ? "Saved here. Waiting to sync." : "Saved on this device.");
      if (this.pendingCapture?.draft.id === submittedDraft.id) this.pendingCapture = null;
      this.broadcastEventChange();
      restoreComposeFocus = !sourceList;
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4) this.pendingRefresh = true;
      this.renderState();
      const partial = step && step.type !== "add" && step.type !== "create-routine";
      const inline = step ? describePartialCapture(step, destination) : INLINE_SAVE_FAILED;
      if (!sourceList) this.pendingCapture = { draft: submittedDraft, composer, retry };
      this.showAlert(partial ? inline : (error.userMessage ?? SAVE_ERROR), retry);
      if (!sourceList && composer.showResult) { composer.showResult(inline, { kind: "error", retry }); this.feedback.classList.add("app-feedback-inline"); }
      this.setStatus("");
      restoreComposeFocus = !sourceList;
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (sourceList) {
          const focusTarget = sourceList.querySelector(
            `[data-item-id="${submittedDraft.sourceStapleId}"][data-item-action="replenish"]`,
          );
          (focusTarget ?? sourceList.querySelector(".today-section h2"))?.focus();
        } else if (restoreComposeFocus) {
          composer.focusInput();
        }
        this.flushPeerRefresh();
      }
    }
  }

  // Only promise a later sync when this device actually syncs; otherwise a
  // change is simply saved here.
  offlineSyncSuffix() {
    return navigator.onLine === false && this.syncCoordinator ? " It will sync when you're connected." : "";
  }

  async handleAddHandoff(event) {
    return this.saveHandoff({ type: "add-handoff", text: event.detail.text });
  }

  async handleHandoffAction(type, handoffId) {
    return this.saveHandoff({ type, handoffId });
  }

  async saveHandoff(command) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const submitted = Object.freeze({ ...command });
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(submitted);
      this.assertCurrentSession(session);
      this.renderState();
      if (submitted.type === "add-handoff")
        this.handoffs.clearIfMatches(submitted);
      this.setStatus(
        submitted.type === "add-handoff"
          ? "Handoff added."
          : submitted.type === "acknowledge-handoff"
            ? "Acknowledged."
            : "Handoff archived.",
      );
      this.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4 && submitted.handoffId) this.pendingRefresh = true;
      this.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.saveHandoff(submitted),
        submitted.handoffId ? submitted : null,
      );
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        this.handoffs.focusInput();
        this.flushPeerRefresh();
      }
    }
  }

  async saveTalk(command) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const submitted = Object.freeze({ ...command });
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(submitted);
      this.assertCurrentSession(session);
      this.renderState();
      if (submitted.type === "add-talk") this.talks.clearIfMatches(submitted);
      this.setStatus(
        submitted.type === "add-talk"
          ? "Talk added."
          : submitted.type === "resolve-talk"
            ? "Resolved."
            : submitted.type === "reopen-talk"
              ? "Reopened."
              : "Talk archived.",
      );
      this.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4 && submitted.talkId) this.pendingRefresh = true;
      this.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.saveTalk(submitted),
        submitted.talkId ? submitted : null,
      );
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        this.talks.focusInput();
        this.flushPeerRefresh();
      }
    }
  }

  async savePulse(command) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const submitted = Object.freeze({ ...command });
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(submitted);
      this.assertCurrentSession(session);
      this.renderState();
      this.pulse.saved();
      this.setStatus(
        submitted.type === "set-pulse" ? "Pulse set." : "Pulse cleared.",
      );
      this.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR, () =>
        this.savePulse(submitted),
      );
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        this.pulse.focusInput();
        this.flushPeerRefresh();
      }
    }
  }

  async saveMode(mode) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const command = Object.freeze({ type: "set-household-mode", mode });
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(command);
      this.assertCurrentSession(session);
      this.renderState();
      this.setStatus("Household mode updated.");
      this.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.modeSelect.value = this.state?.mode ?? "normal";
      this.showAlert(error.userMessage ?? SAVE_ERROR, () => this.saveMode(mode));
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        this.flushPeerRefresh();
      }
    }
  }

  async saveRoutine(command) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const submitted = Object.freeze({ ...command });
    const todayFocused = this.today.contains(document.activeElement);
    if (todayFocused) this.today.rememberFocus();
    const focus = this.routines.captureFocus();
    let committed = false;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(submitted);
      this.assertCurrentSession(session);
      committed = true;
      this.broadcastEventChange();
      this.renderState();
      if (submitted.type === "create-routine")
        this.routines.clearIfMatches(submitted);
      if (submitted.type === "archive-routine") this.routines.closeSchedule(submitted.routineId);
      // Feedback reads the Rust projection after the save, never a guess.
      const saved = submitted.routineId
        ? this.state.routines?.find((routine) => routine.routineId === submitted.routineId)
        : this.state.routines?.at(-1);
      const next = describeNextOccurrence(saved?.nextOn ?? null, this.currentCivilDate());
      this.setStatus(
        submitted.type === "create-routine"
          ? describeRecurringCapture(saved, this.currentCivilDate())
          : submitted.type === "archive-routine"
            ? "Stopped repeating. Past completions are kept."
            : submitted.type === "complete-routine-occurrence"
              ? `Done for this period.${next ? ` ${next}.` : ""}`
              : "Reopened for this period.",
      );
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4 && submitted.routineId) this.pendingRefresh = true;
      this.showAlert(
        committed
          ? "Your routine was saved. Try again to refresh the view."
          : (error.userMessage ?? SAVE_ERROR),
        committed ? this.retryRefresh : () => this.saveRoutine(submitted),
        committed || !submitted.routineId ? null : submitted,
      );
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (todayFocused) { /* kin-today restored its own focus on render */ }
        else if (
          submitted.type === "create-routine" ||
          submitted.type === "archive-routine"
        )
          this.routines.focusInput();
        else this.routines.restoreFocus(focus);
        this.flushPeerRefresh();
      }
    }
  }

  // From Today: show the task's schedule editor on the Routines page.
  openRoutineSchedule(routineId) {
    if (!this.workspaceReady()) return;
    this.navigate("#routines");
    if (!this.routines.openSchedule(routineId)) this.setStatus(SCHEDULE_MESSAGES.gone);
  }

  // A schedule change is a new Routine starting today plus stopping the old
  // one, each an ordinary Rust-validated command (see planScheduleChange).
  // The replacement id is kept until the change finishes, so a retry after a
  // partial save resumes instead of creating a second repeating task.
  async changeRoutineSchedule(detail) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const vaultId = this.vault?.vaultId ?? null;
    const pending = this.pendingScheduleChange?.vaultId === vaultId ? this.pendingScheduleChange : null;
    const resume = pending?.routineId === detail.routineId && pending.cadence === detail.cadence;
    const change = Object.freeze({
      vaultId,
      routineId: detail.routineId,
      cadence: detail.cadence,
      replacementId: resume ? pending.replacementId : crypto.randomUUID().replaceAll("-", ""),
    });
    const plan = planScheduleChange(this.state, change, pending);
    if (plan.status !== "ready") {
      if (resume) this.pendingScheduleChange = null;
      this.setStatus(SCHEDULE_MESSAGES[plan.status]);
      return;
    }
    this.pendingScheduleChange = change;
    let step = null;
    let appended = 0;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      for (step of plan.steps) {
        await this.appendCommand(step);
        this.assertCurrentSession(session);
        appended++;
      }
      step = null;
      this.pendingScheduleChange = null;
      this.localReminders.cancel(`routine:${change.routineId}`);
      this.routines.closeSchedule(change.routineId);
      this.broadcastEventChange();
      this.renderState();
      this.setStatus(describeScheduleChanged(change.cadence));
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4) this.pendingRefresh = true;
      if (appended) this.broadcastEventChange();
      this.renderState();
      this.showAlert(
        step && step.type !== "create-routine" ? SCHEDULE_MESSAGES.partial : (error.userMessage ?? SAVE_ERROR),
        () => this.changeRoutineSchedule(change),
      );
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (!this.pendingScheduleChange) this.routines.focusRoutine(change.replacementId);
        this.flushPeerRefresh();
      }
    }
  }

  async handlePlaybookIntent(event) {
    const action = event.type.slice(4);
    const detail = event.detail;
    if (action === "instantiate-playbook") {
      const playbook = this.state?.playbooks?.find(record => record.playbookId === detail.playbookId && !record.archived);
      if (!playbook) return;
      const batch = { itemId: crypto.randomUUID().replaceAll("-", ""), title: playbook.title, steps: playbook.entries.map(text => ({ stepId: crypto.randomUUID().replaceAll("-", ""), text })) };
      return this.instantiatePlaybook(batch);
    }
    const session = this.captureSession();
    const command = action === "save-playbook"
      ? { type: action, id: detail.playbookId ?? crypto.randomUUID().replaceAll("-", ""), title: detail.title, entries: detail.entries }
      : { type: action, playbookId: detail.playbookId };
    if (action === "save-playbook") detail.playbookId = command.id;
    this.setBusy(true); this.clearAlert(); this.setStatus("Saving…");
    try {
      await this.appendCommand(command); this.assertCurrentSession(session); this.routines.clearPlaybookEditor(); this.renderState(); this.broadcastEventChange();
      this.setStatus(action === "save-playbook" ? "Reusable checklist saved." : "Reusable checklist archived.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR, () => this.handlePlaybookIntent(event), command); this.setStatus("");
    } finally { if (this.isCurrentSession(session)) { this.setBusy(false); this.flushPeerRefresh(); } }
  }

  async instantiatePlaybook(batch) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession(); this.setBusy(true); this.clearAlert(); this.setStatus("Creating checklist…");
    try {
      let item = this.state?.items.find(record => record.itemId === batch.itemId);
      if (!item) { await this.appendCommand({ type: "add", id: batch.itemId, text: batch.title, classification: "need" }); item = this.state?.items.find(record => record.itemId === batch.itemId); }
      for (const step of batch.steps) {
        if (item?.steps?.some(record => record.stepId === step.stepId)) continue;
        await this.appendCommand({ type: "add-item-step", itemId: batch.itemId, stepId: step.stepId, text: step.text });
        item = this.state?.items.find(record => record.itemId === batch.itemId);
      }
      this.assertCurrentSession(session); this.renderState(); this.broadcastEventChange(); this.setStatus("Checklist created under To do. It is now an ordinary household item.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR, () => this.instantiatePlaybook(batch)); this.setStatus("");
    } finally { if (this.isCurrentSession(session)) { this.setBusy(false); this.flushPeerRefresh(); } }
  }

  async saveArea(detail) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const action = detail.action;
    const types = {
      "create-area": "create-area",
      "rename-area": "rename-area",
      "archive-area": "archive-area",
      "assign-item-area": "change-item-area",
    };
    const type = types[action];
    if (!type) return;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand({
        type,
        name: detail.name,
        areaId: detail.areaId,
        itemId: detail.itemId,
      });
      this.assertCurrentSession(session);
      this.renderState();
      this.broadcastEventChange();
      this.setStatus(action === "create-area" ? "Area added."
        : action === "rename-area" ? "Area renamed."
        : action === "archive-area" ? "Area archived. Existing links are kept."
        : detail.areaId ? "Area updated." : "Area cleared.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR);
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (action === "archive-area") this.areas.focus();
        if (action === "assign-item-area") {
          [...this.querySelectorAll(".item-area-select")]
            .find((select) => select.dataset.itemId === detail.itemId && !select.closest("[hidden]"))
            ?.focus();
        }
        this.flushPeerRefresh();
      }
    }
  }

  async saveItemPlanningDate(detail, sourceList) {
    this.localReminders.cancel(`item:${detail.itemId}`);
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand({
        type: "set-item-planning-date",
        itemId: detail.itemId,
        planningDate: detail.planningDate,
      });
      this.assertCurrentSession(session);
      this.renderState();
      this.broadcastEventChange();
      this.detail.clearFeedback(detail.itemId);
      this.feedDetail();
      this.setStatus(detail.planningDate ? "Planned date saved." : "Planned date cleared.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4) this.pendingRefresh = true;
      this.renderState();
      this.showDetailActionError(detail.itemId, error.userMessage ?? SAVE_ERROR,
        () => this.saveItemPlanningDate(detail, sourceList));
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        (sourceList ?? this.detail)?.querySelector?.(
          `.item-planning-date-input[data-item-id="${detail.itemId}"]`,
        )?.focus();
        this.flushPeerRefresh();
      }
    }
  }

  async handleLocalReminder({ id, title, at }) {
    const itemId = id.startsWith("item:") ? id.slice(5) : null;
    const routineId = id.startsWith("routine:") ? id.slice(8) : null;
    // A reminder carries its decrypted title, so it may only notify while its
    // record is live in this unlocked session (lock also cancels every timer).
    const session = this.captureSession();
    const currentItem = () => this.isCurrentSession(session) && (itemId
      ? this.state?.items?.some((item) => item.itemId === itemId && item.status === "active")
      : !routineId || this.state?.routines?.some((routine) => routine.routineId === routineId && routine.status !== "archived"));
    try {
      const result = await this.localReminders.schedule({ id, title, at, isCurrent: currentItem });
      // The permission prompt can outlast the session; never register a timer
      // or report success into a locked or different household.
      if (!this.isCurrentSession(session)) { this.localReminders.cancel(id); return; }
      this.renderReminders();
      for (const control of this.querySelectorAll("kin-reminder")) if (control.targetRecord?.id === id) control.saved(result === "granted" ? at : null);
      if (itemId) this.detail?.reminderDrafts?.delete(itemId);
      this.setStatus(result === "granted" ? "Reminder set on this device while Kin is open." : result === "denied" ? "Notifications are blocked in browser settings. Kin still works normally." : "Reminders are unavailable in this browser. Kin still works normally.");
    } catch (error) {
      if (this.isCurrentSession(session)) this.showAlert(error.message ?? "Choose a future reminder time.");
    }
  }

  downloadCalendar() {
    if (this.busy || !this.store || !this.state) return;
    const planned = this.state.items.filter(
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
      this.setStatus("Calendar file prepared for download.");
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      this.showAlert(error.message || "Kin could not prepare the calendar file.");
      this.setStatus("");
      return;
    }
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async saveNote(action, detail) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const type = { "create-note": "create-note", "update-note": "update-note", "archive-note": "archive-note" }[action];
    if (!type) return;
    const noteId = detail.noteId ?? crypto.randomUUID().replaceAll("-", "");
    this.setBusy(true); this.clearAlert(); this.setStatus("Saving…");
    try {
      await this.appendCommand({ type, ...detail, noteId, id: noteId });
      this.assertCurrentSession(session);
      this.notes.clearEditor();
      this.notes.pendingFocus = action === "archive-note" ? this.notes.pendingFocus : "title";
      this.renderState();
      this.broadcastEventChange();
      this.setStatus(action === "archive-note"
        ? "Note archived on this device."
        : navigator.onLine
          ? "Note saved on this device."
          : "Note saved on this device. Sync is unavailable while offline.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR);
      this.setStatus("");
      this.notes.pendingFocus = "title";
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        this.flushPeerRefresh();
      }
    }
  }

  async saveReferenceRecord(action, detail) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const recordId = detail.recordId ?? crypto.randomUUID().replaceAll("-", "");
    const type = action === "archive-reference-record" ? action : "save-reference-record";
    this.setBusy(true); this.clearAlert(); this.setStatus("Saving…");
    try {
      await this.appendCommand({ type, ...detail, recordId, id: recordId });
      this.assertCurrentSession(session);
      if (action === "save-reference-record") this.notes.clearReferenceEditor();
      this.renderState(); this.broadcastEventChange();
      this.setStatus(action === "archive-reference-record" ? "Reference archived." : "Reference saved on this device.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR); this.setStatus("");
    } finally { if (this.isCurrentSession(session)) { this.setBusy(false); this.flushPeerRefresh(); } }
  }

  async saveMaintenanceEvent(action, detail) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const type = action === "archive-maintenance-event" ? action : "save-maintenance-event";
    this.setBusy(true); this.clearAlert(); this.setStatus("Saving maintenance history…");
    try {
      await this.appendCommand({ ...detail, type, id: detail.maintenanceId });
      this.assertCurrentSession(session); this.renderState(); this.broadcastEventChange();
      this.setStatus(action === "archive-maintenance-event" ? "Maintenance event archived." : "Maintenance saved on this device.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR); this.setStatus("");
    } finally { if (this.isCurrentSession(session)) { this.setBusy(false); this.flushPeerRefresh(); } }
  }

  schedulePulseRefresh() {
    clearTimeout(this.pulseTimer);
    if (
      !this.isConnected ||
      (!this.state.pulses.length &&
        !this.state.routines?.some((r) => r.status === "active"))
    )
      return;
    // Timers only request canonical replay. Rust alone decides expiry.
    const now = Date.now();
    const active = this.state.pulses.filter(
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
    this.pulseTimer = setTimeout(this.onTimeWake, delay);
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

  async untilIdle(limitMs = 10_000) {
    const deadline = Date.now() + limitMs;
    while (this.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return !this.busy;
  }

  async saveChosenAttachment(file, target) {
    const kind = isImageAttachment({ type: file?.type, name: file?.name }) ? "photo" : "file";
    const problem = attachmentFileProblem(file);
    if (problem) { this.reportAttachmentProgress(target, "error", problem); this.showAlert(problem); return; }
    const lockedMessage = `Unlock Kin before attaching a ${kind}.`;
    if (!this.vault || this.vault.locked || !this.store || !this.engine) {
      this.reportAttachmentProgress(target, "error", lockedMessage); this.showAlert(lockedMessage); return;
    }
    this.reportAttachmentProgress(target, "preparing", `Preparing ${kind}…`);
    if (!(await this.untilIdle())) {
      const message = `Kin is still saving another change. Try adding the ${kind} again in a moment.`;
      this.reportAttachmentProgress(target, "error", message); this.showAlert(message); return;
    }
    if (!this.vault || this.vault.locked || !this.store || !this.engine) {
      this.reportAttachmentProgress(target, "error", lockedMessage); return;
    }
    const session = this.captureSession();
    const { parentKind, parentId } = target;
    this.setBusy(true); this.clearAlert();
    this.reportAttachmentProgress(target, "saving", "Saving securely…");
    try {
      const saved = await captureAttachment({ file, parentKind, parentId, identity: this.syncCoordinator?.identity ?? this.household?.identity, store: session.store, keyStore: this.syncCoordinator?.keyStore, append: (command) => this.appendCommand(command) });
      this.assertCurrentSession(session);
      this.attachmentRows = [...this.attachmentRows.filter((row) => row.attachmentId !== saved.attachmentId), { ...saved, parentKind, parentId }];
      this.renderState(); this.broadcastEventChange();
      this.reportAttachmentProgress(target, "saved", this.syncCoordinator
        ? `${saved.name} is saved on this device and waiting to sync to your household.`
        : `${saved.name} is saved on this device.`);
      void this.syncCoordinator?.syncNow();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) {
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
      this.showAlert(message);
    } finally { if (this.isCurrentSession(session)) this.setBusy(false); }
  }

  async handleOpenAttachment(event) {
    if (!this.store) { this.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const session = this.captureSession();
    const detail = event.detail;
    const binding = this.state?.attachments?.find((item) => item.attachmentId === detail.attachmentId && !item.removed);
    if (!binding || binding.parentKind !== detail.parentKind || binding.parentId !== detail.parentId) { this.showAlert(ATTACHMENT_OPEN_ERROR); return; }
    const tab = detail.download ? null : window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const opened = await this.loadAttachmentForView(detail, session);
      const url = URL.createObjectURL(opened.blob);
      if (detail.download) { const link = document.createElement("a"); link.href = url; link.download = opened.name; link.hidden = true; document.body.append(link); link.click(); link.remove(); }
      else if (tab) tab.location.href = url;
      else { const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener"; link.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { tab?.close(); if (error.code !== "locked") this.showAlert(ATTACHMENT_OPEN_ERROR); }
  }

  async handleRemoveAttachment(event) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession(); this.setBusy(true); this.clearAlert();
    try {
      await removeAttachment({ attachmentId: event.detail.attachmentId, append: (command) => this.appendCommand(command), store: session.store });
      this.assertCurrentSession(session);
      this.attachmentPreviews?.forget(event.detail.attachmentId);
      if (this.viewerDetail?.attachmentId === event.detail.attachmentId) this.closeViewer();
      this.attachmentRows = this.attachmentRows.filter((row) => row.attachmentId !== event.detail.attachmentId);
      this.renderState(); this.broadcastEventChange(); void this.syncCoordinator?.syncNow();
    } catch (error) { if (error.code !== "locked" && this.isCurrentSession(session)) this.showAlert(error.userMessage ?? SAVE_ERROR); }
    finally { if (this.isCurrentSession(session)) this.setBusy(false); }
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
    const session = this.captureSession();
    try {
      const rows = await loadLocalAttachmentRows({ store: session.store, state: this.state });
      if (!this.isCurrentSession(session)) return;
      this.attachmentRows = rows; this.renderState();
    } catch { /* A later sync retries attachment indexing. */ }
  }

  async handleChangeResponsibility(event) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession(); this.setBusy(true); this.clearAlert();
    try {
      const { targetKind, targetId, memberId } = event.detail;
      await this.appendCommand({ type: "change-responsibility", targetKind, id: targetId, memberId });
      this.assertCurrentSession(session); this.broadcastEventChange(); void this.syncCoordinator?.syncNow();
    } catch (error) { if (error.code !== "locked" && this.isCurrentSession(session)) this.showAlert(error.userMessage ?? SAVE_ERROR); }
    finally { if (this.isCurrentSession(session)) this.setBusy(false); }
  }

  async reconcileResponsibilityMembers() {
    if (this.reconcilingResponsibility || this.busy || !this.activeMemberIds || !this.state?.responsibilities?.length) return;
    const active = new Set(this.activeMemberIds);
    const stale = this.state.responsibilities.filter((entry) => {
      if (!entry.memberId || active.has(entry.memberId)) return false;
      return entry.targetKind === "item"
        ? this.state.items?.some((item) => item.itemId === entry.targetId && item.status !== "archived")
        : this.state.routines?.some((routine) => routine.routineId === entry.targetId && !routine.archived);
    });
    if (!stale.length) return;
    this.reconcilingResponsibility = true;
    try {
      for (const entry of stale) {
        if (!this.activeMemberIds.includes(this.syncCoordinator?.identity?.memberId)) break;
        await this.appendCommand({ type: "change-responsibility", targetKind: entry.targetKind, id: entry.targetId, memberId: null });
      }
      this.broadcastEventChange();
      void this.syncCoordinator?.syncNow();
    } catch { /* Another device may have cleared the same removed member concurrently. */ }
    finally { this.reconcilingResponsibility = false; }
  }

  async handleCompleteItem(event) {
    this.localReminders.cancel(`item:${event.detail.itemId}`);
    return this.handleItemAction("complete", event.detail.itemId);
  }

  async savePin(detail) {
    if (this.busy || !this.store || !this.engine || detail.targetKind !== "item") return;
    const session = this.captureSession();
    const command = { type: detail.pinned ? "pin" : "unpin", targetKind: "item", targetId: detail.targetId };
    const list = [this.today, this.needs, this.shopping, this.staples].find((candidate) => candidate.contains(document.activeElement));
    list?.rememberFocus();
    const detailFocused = this.detail?.contains(document.activeElement);
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(command);
      this.assertCurrentSession(session);
      this.renderState();
      this.setStatus(detail.pinned ? "Pinned for quick access." : "Unpinned.");
      this.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4) this.pendingRefresh = true;
      this.showAlert(error.userMessage ?? SAVE_ERROR, () => this.savePin(detail), command);
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (detailFocused && !this.detail.contains(document.activeElement)) this.detail.querySelector(".pin-button")?.focus();
        this.flushPeerRefresh();
      }
    }
  }

  openPinnedItem(itemId, opener = null) {
    const item = this.state?.items.find((record) => record.itemId === itemId && record.status !== "archived");
    if (!item) { this.setStatus("That item is no longer available."); return; }
    this.openItemDetail(itemId, { opener });
  }

  async handleReopenItem(event) {
    return this.handleItemAction("reopen", event.detail.itemId);
  }

  async handleArchiveItem(event) {
    this.localReminders.cancel(`item:${event.detail.itemId}`);
    return this.handleItemAction("archive", event.detail.itemId);
  }

  // --- Bulk complete / reopen and undo ------------------------------------
  //
  // A batch is a sequence of ordinary complete-item / reopen-item commands,
  // one IndexedDB transaction each, so Rust validates every Item against the
  // full local history (including synced remote events) at the moment it is
  // written. Batches are not atomic: each committed change stays committed,
  // and the outcome reports successes, failures, and skips separately.

  bulkListFrom(event) {
    const list = event.target?.closest?.("kin-today");
    return list && [this.needs, this.shopping].includes(list) && list.isBulkList ? list : null;
  }

  clearBulkOutcome() {
    clearTimeout(this.bulkUndoTimer);
    this.bulkUndoTimer = null;
    this.bulkUndo = null;
    this.bulkRetry = null;
  }

  // Undo is offered for ten minutes, until it runs, until the next bulk action
  // or Dismiss, or until lock, logout, or a household change ends the session.
  armBulkUndo(record) {
    clearTimeout(this.bulkUndoTimer);
    this.bulkUndo = record;
    this.bulkUndoTimer = setTimeout(() => {
      if (this.bulkUndo !== record) return;
      this.bulkUndo = null;
      if (record.list.isConnected && record.list.bulkResult) record.list.setBulkResult({ ...record.list.bulkResult, canUndo: false });
    }, BULK_UNDO_WINDOW_MS);
  }

  async handleBulkItemAction(event) {
    const list = this.bulkListFrom(event);
    const { action, itemIds } = event.detail ?? {};
    if (!list || !BULK_ACTIONS[action] || !Array.isArray(itemIds)) return;
    if (this.busy || this.bulkRunning || !this.store || !this.engine || !this.state) return;
    this.clearBulkOutcome();
    const plan = planBulk(action, itemIds, this.state.items);
    await this.runBulk({ list, action, targets: plan.targets, skipped: plan.skipped.length });
  }

  async handleBulkRetry(event) {
    const list = this.bulkListFrom(event);
    const record = this.bulkRetry;
    if (!list || !record || record.list !== list || record.generation !== this.securityGeneration) return;
    if (this.busy || this.bulkRunning || !this.store || !this.state) return;
    this.bulkRetry = null;
    const plan = planBulk(record.action, record.itemIds, this.state.items);
    // Earlier successes of the same action stay undoable alongside the retry.
    const carried = this.bulkUndo?.list === list && this.bulkUndo.action === record.action ? this.bulkUndo.changes : [];
    await this.runBulk({ list, action: record.action, targets: plan.targets, skipped: plan.skipped.length, carried });
  }

  async runBulk({ list, action, targets, skipped, carried = [] }) {
    const spec = BULK_ACTIONS[action];
    const session = this.captureSession();
    const succeeded = [];
    const failed = [];
    const started = performance.now();
    this.bulkRunning = true;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("");
    list.setBulkResult(null);
    try {
      for (const [index, itemId] of targets.entries()) {
        list.setBulkProgress(`${action === "complete" ? "Completing" : "Reopening"} ${index + 1} of ${targets.length}…`);
        try {
          await this.appendCommand({ type: spec.command, itemId });
          const record = this.state.items.find((item) => item.itemId === itemId);
          succeeded.push({ itemId, to: spec.to, changedAt: record?.lastChangedAt ?? null });
          if (action === "complete") this.localReminders.cancel(`item:${itemId}`);
        } catch (error) {
          // Changes committed before a lock stay committed; nothing from the
          // old session may touch the new interface.
          if (error.code === "locked" || !this.isCurrentSession(session)) return;
          if (error.code === 4) this.pendingRefresh = true;
          failed.push(itemId);
        }
      }
    } finally {
      this.bulkRunning = false;
      if (this.isCurrentSession(session)) {
        this.lastBulkMetric = { action, count: targets.length, ms: performance.now() - started };
        list.setBulkProgress("");
        if (succeeded.length) { this.renderState(); this.broadcastEventChange(); }
        list.deselect(succeeded.map((change) => change.itemId));
        const changes = [...carried, ...succeeded];
        if (changes.length) this.armBulkUndo({ list, action, changes, generation: session.generation });
        if (failed.length) this.bulkRetry = { list, action, itemIds: failed, generation: session.generation };
        list.setBulkResult({
          message: describeBulkOutcome(action, { succeeded: succeeded.length, failed: failed.length, skipped }),
          error: failed.length > 0,
          canUndo: changes.length > 0,
          undoLabel: action === "complete" ? "Undo: reopen these" : "Undo: complete these",
          canRetry: failed.length > 0,
        });
        this.setBusy(false);
        list.focusBulkResult();
        this.flushPeerRefresh();
      }
    }
  }

  // Undo is a new, authorized compensating command per Item, never a rewrite
  // of history. Before each one the Item must still be in the status this
  // device left it in and carry the same Rust-derived lastChangedAt; Rust then
  // re-checks the status atomically inside the append. The remaining gap: a
  // change authored elsewhere that has not reached this device yet cannot be
  // seen, and is reconciled by normal sync ordering afterwards.
  async handleBulkUndo(event) {
    const list = this.bulkListFrom(event);
    const record = this.bulkUndo;
    if (!list || !record || record.list !== list || record.generation !== this.securityGeneration) return;
    if (this.busy || this.bulkRunning || !this.store || !this.engine) return;
    this.clearBulkOutcome();
    const session = this.captureSession();
    const undone = [];
    const conflicts = [];
    const failed = [];
    let unverified = false;
    this.bulkRunning = true;
    this.setBusy(true);
    this.clearAlert();
    list.setBulkResult(null);
    try {
      let items;
      try {
        items = (await this.readAuthoritativeState(session)).items;
      } catch (error) {
        if (error.code === "locked" || !this.isCurrentSession(session)) return;
        // Fail closed: the rendered projection may be stale, so checking
        // against it could overwrite a newer change. Nothing is undone and
        // the whole undo set stays available to try again.
        unverified = true;
        return;
      }
      for (const [index, change] of record.changes.entries()) {
        list.setBulkProgress(`Undoing ${index + 1} of ${record.changes.length}…`);
        if (undoStatus(change, items) !== "ready") { conflicts.push(change); continue; }
        try {
          await this.appendCommand({ type: undoCommand(change), itemId: change.itemId });
          items = this.state.items;
          undone.push(change);
        } catch (error) {
          if (error.code === "locked" || !this.isCurrentSession(session)) return;
          // Rust rejected the status precondition: the Item changed in between.
          if (error.code === 4) { this.pendingRefresh = true; conflicts.push(change); }
          else failed.push(change);
        }
      }
    } finally {
      this.bulkRunning = false;
      if (this.isCurrentSession(session)) {
        list.setBulkProgress("");
        if (undone.length) { this.renderState(); this.broadcastEventChange(); }
        // Items failed for a local reason (not a conflict) can be undone again.
        const retryable = unverified ? record.changes : failed;
        if (retryable.length) this.armBulkUndo({ ...record, changes: retryable, generation: session.generation });
        list.setBulkResult({
          message: unverified
            ? BULK_UNDO_UNVERIFIED
            : describeBulkOutcome(record.action, { succeeded: undone.length, conflicts: conflicts.length, failed: failed.length, undo: true }),
          error: unverified || failed.length > 0 || conflicts.length > 0,
          canUndo: retryable.length > 0,
          undoLabel: "Try undo again",
          canRetry: false,
        });
        this.setBusy(false);
        list.focusBulkResult();
        this.flushPeerRefresh();
      }
    }
  }

  // A fresh replay of the encrypted local log, without touching the rendered
  // projection, so undo checks the newest state including synced events.
  async readAuthoritativeState(session) {
    const snapshot = await session.store.getCatchUpState();
    this.assertCurrentSession(session);
    const { asOf, civilDate } = projectionContext();
    return session.engine.applyEvents(
      snapshot.events.map((event) => event.encoded_event),
      asOf,
      snapshot.cursor.eventId,
      civilDate,
      snapshot.syncIdentity,
    );
  }

  async handleItemAction(type, itemId) {
    if (this.busy || !this.store || !this.engine) {
      return;
    }
    const session = this.captureSession();
    const submittedItemId = itemId;
    const activeList = [this.today, this.needs, this.shopping, this.staples].find((list) =>
      list.contains(document.activeElement),
    );
    const detailFocused = this.detail?.contains(document.activeElement);
    const restoreListFocus = Boolean(activeList) || detailFocused;
    activeList?.rememberFocus();
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    let restoreComposeFocus = false;
    try {
      await this.appendCommand({ type, itemId: submittedItemId });
      this.assertCurrentSession(session);
      this.renderState();
      this.setStatus(
        type === "complete"
          ? "Marked complete."
          : type === "reopen"
            ? "Reopened."
            : "Archived.",
      );
      this.broadcastEventChange();
      restoreComposeFocus = true;
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4) {
        this.pendingRefresh = true;
      }
      this.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.handleItemAction(type, submittedItemId),
        { type, itemId: submittedItemId },
      );
      this.setStatus("");
      restoreComposeFocus = true;
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (detailFocused) {
          const next = this.detail.querySelector('[data-focus-id="primary"]') ?? this.detail.querySelector(".item-detail-close");
          next?.focus();
        } else if (restoreComposeFocus && !restoreListFocus) {
          this.compose.focusInput();
        }
        this.flushPeerRefresh();
      }
    }
  }

  async handleItemStep(type, detail) {
    if (this.busy || !this.store || !this.engine) return;
    const list = [this.today, this.needs, this.shopping, this.staples].find((candidate) => candidate.contains(document.activeElement)) ?? null;
    if (list) list.rememberFocus();
    const stepFocus = this.detail?.contains(document.activeElement) ? (document.activeElement.dataset.focusId ?? "add-step") : null;
    const session = this.captureSession();
    const command = Object.freeze({
      type,
      itemId: detail.itemId,
      ...(type === "add-item-step"
        ? { stepId: detail.stepId ?? randomId(), text: detail.text }
        : { stepId: detail.stepId }),
    });
    const submittedStep = command.type === "add-item-step" ? command.text : null;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(command);
      this.assertCurrentSession(session);
      this.renderState();
      if (submittedStep != null) this.detail.clearStepDraft(command.itemId, submittedStep);
      this.detail.clearFeedback(command.itemId);
      this.feedDetail();
      this.setStatus(
        type === "add-item-step"
          ? "Step added."
          : type === "complete-item-step"
            ? "Step completed."
            : type === "reopen-item-step"
              ? "Step reopened."
              : "Step archived.",
      );
      this.broadcastEventChange();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4) this.pendingRefresh = true;
      this.renderState();
      this.showDetailActionError(command.itemId, error.userMessage ?? SAVE_ERROR,
        () => this.handleItemStep(type, command), command);
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (stepFocus && !this.detail.contains(document.activeElement)) {
          const target = type === "add-item-step" ? this.detail.stepInput : [...this.detail.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === stepFocus);
          (target && !target.disabled ? target : this.detail.stepInput)?.focus();
        }
        this.flushPeerRefresh();
      }
    }
  }

  showDetailActionError(itemId, message, retry, intent = null) {
    if (!this.detail) { this.showAlert(message, retry, intent); return; }
    this.detail.setFeedback(itemId, { itemId, message, retry, intent });
    if (this.selection) this.feedDetail();
  }

  openPeerChannel() {
    if (
      !this.isConnected ||
      this.channel ||
      !("BroadcastChannel" in globalThis)
    ) {
      return;
    }
    try {
      this.channel = new BroadcastChannel("kin-household-events-v1");
      this.channel.addEventListener("message", this.onPeerMessage);
    } catch {
      this.channel = null;
    }
  }

  async appendCommand(command) {
    const session = this.captureSession();
    this.assertCurrentSession(session);
    const result = await session.store.append(command, session.engine);
    this.assertCurrentSession(session);
    this.state = result.state;
    this.snapshotBoundary = result.snapshotBoundary;
    void this.syncCoordinator?.syncNow();
  }

  applyCatchUpSnapshot(snapshot) {
    if (!this.vault || this.vault.locked || !this.engine)
      throw new Error("Kin is locked.");
    const { asOf, civilDate } = projectionContext();
    const state = this.engine.applyEvents(
      snapshot.events.map((event) => event.encoded_event),
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
    this.state = state;
    this.catchUpCursor = snapshot.cursor;
    this.snapshotBoundary = snapshot.through
      ? {
          eventId: snapshot.through.eventId,
          localSequence: snapshot.through.localSequence,
          snapshotThroughEventId: snapshot.through.eventId,
          snapshotThroughLocalSequence: snapshot.through.localSequence,
        }
      : null;
  }

  async handleCaughtUp() {
    if (this.busy || !this.store || !this.snapshotBoundary) return;
    const session = this.captureSession();
    const boundary = this.snapshotBoundary;
    const restoreCatchUpFocus = document.activeElement === this.catchUp.button;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving catch-up state…");
    let committed = false;
    try {
      await session.store.markCaughtUpThrough(boundary);
      this.assertCurrentSession(session);
      committed = true;
      // Peers must learn about the commit even if this tab cannot reload it.
      this.broadcastViewStateChange();
      const snapshot = await session.store.getCatchUpState();
      this.assertCurrentSession(session);
      this.applyCatchUpSnapshot(snapshot);
      this.renderState();
      this.setStatus(
        this.state.summary.totalCount === 0
          ? "Caught up."
          : "Catch-up summary updated.",
      );
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(
        committed
          ? "Your catch-up position was saved, but Kin could not refresh the summary. Try again to reload it."
          : (error.userMessage ??
              "Kin could not update this browser's catch-up position. Your saved household information was not deleted."),
        committed ? this.retryRefresh : () => this.handleCaughtUp(),
      );
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        if (restoreCatchUpFocus) {
          (this.catchUp.button.hidden
            ? this.catchUp.heading
            : this.catchUp.button
          ).focus();
        }
        this.flushPeerRefresh();
      }
    }
  }

  closePeerChannel() {
    this.channel?.removeEventListener("message", this.onPeerMessage);
    this.channel?.close();
    this.channel = null;
  }

  broadcastEventChange() {
    try {
      this.channel?.postMessage({ type: "events-changed" });
    } catch {
      // Cross-tab refresh is best-effort; IndexedDB remains authoritative.
    }
  }

  broadcastViewStateChange() {
    try {
      this.channel?.postMessage({ type: "view-state-changed" });
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
        !this.vault ||
        peerEpoch > (this.vault.securityEpoch ?? -1)
      )
        this.lockHousehold(false);
      return;
    }
    if (!this.vault || this.vault.locked) return;
    if (!["events-changed", "view-state-changed"].includes(event.data?.type)) {
      return;
    }
    if (this.busy || this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshFromEvents();
  }

  async refreshFromEvents() {
    if (!this.vault || this.vault.locked) return;
    if (!this.store || !this.engine || this.busy || this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    const session = this.captureSession();
    this.refreshing = true;
    const focusedControl = this.contains(document.activeElement)
      ? document.activeElement
      : null;
    this.setBusy(true);
    // A failed refresh must not replace the command awaiting recovery.
    const previousFailure = this.suspendedRetry ?? {
      action: this.retryAction !== this.retryRefresh ? this.retryAction : null,
      intent: this.retryIntent,
      message: this.alert.textContent,
    };
    const previousRetry = previousFailure.action;
    const previousRetryIntent = previousFailure.intent;
    const previousAlert = previousFailure.message;
    const restoreComposeFocus = this.compose.contains(document.activeElement);
    // A focused list row is rebuilt by the refresh; the list restores focus
    // to the equivalent control, or the capture field takes it as a fallback.
    const focusedList = [this.today, this.needs, this.shopping, this.staples].find((list) => list.contains(document.activeElement)) ?? null;
    focusedList?.rememberFocus();
    const restoreHandoffFocus = this.handoffs.lists.contains(
      document.activeElement,
    );
    const routineFocus = this.routines.captureFocus();
    const restoreTalkFocus = this.talks.lists.contains(document.activeElement);
    this.clearAlert();
    this.setStatus("Updating from another tab…");
    try {
      const snapshot = await session.store.getCatchUpState();
      this.assertCurrentSession(session);
      this.applyCatchUpSnapshot(snapshot);
      this.renderState();
      this.setStatus("");
      if (previousRetry) {
        const handoff = previousRetryIntent?.handoffId
          ? this.state.handoffs.find(
              (record) => record.handoffId === previousRetryIntent.handoffId,
            )
          : null;
        const talk = previousRetryIntent?.talkId
          ? this.state.talks.find(
              (record) => record.talkId === previousRetryIntent.talkId,
            )
          : null;
        const routine = previousRetryIntent?.routineId
          ? this.state.routines.find(
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
                ? this.state.items.find(
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
          this.setStatus(
            previousRetryIntent.routineId
              ? "That period changed. Review the current routine."
              : previousRetryIntent.talkId
                ? "That topic changed. Review its current state."
                : previousRetryIntent.handoffId
                  ? "That handoff changed. Review its current state."
                  : "That item changed. Review its current state below.",
          );
        } else {
          this.showAlert(previousAlert, previousRetry, previousRetryIntent);
        }
      }
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(
        error.userMessage ??
          "Kin could not refresh from local household storage. Your saved information was not deleted.",
        this.retryRefresh,
      );
      this.suspendedRetry = previousRetry ? previousFailure : null;
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.refreshing = false;
        this.setBusy(false);
        if (focusedControl?.isConnected && !focusedControl.closest("[hidden]"))
          focusedControl.focus();
        else if (focusedControl && this.pulse.contains(focusedControl))
          this.pulse.focusInput();
        if (restoreHandoffFocus) this.handoffs.focusInput();
        this.routines.restoreFocus(routineFocus);
        if (restoreTalkFocus) this.talks.focusInput();
        if (restoreComposeFocus) {
          this.compose.focusInput();
        } else if (focusedList && !this.contains(document.activeElement)) {
          if (focusedList.closest("[hidden]") || focusedList === this.today) this.compose.focusInput();
          else focusedList.focusInput?.();
        }
        this.flushPeerRefresh();
      }
    }
  }

  flushPeerRefresh() {
    if (!this.vault || this.vault.locked) return;
    if (!this.pendingRefresh || this.busy || this.refreshing) {
      return;
    }
    this.pendingRefresh = false;
    const session = this.captureSession();
    queueMicrotask(() => {
      if (this.isCurrentSession(session)) this.refreshFromEvents();
    });
  }

  renderState() {
    if (!this.vault || this.vault.locked || !this.state) return;
    // Rendering reconciles the whole unlocked workspace and is also used for
    // background sync. Suppress motion during that pass; navigation and
    // explicitly opened detail sheets keep their separate entrance effects.
    const renderToken = (this.quietRenderToken ?? 0) + 1;
    this.quietRenderToken = renderToken;
    this.setAttribute("data-quiet-render", "");
    try {
      this.renderStateContents();
    } finally {
      const clearQuietRender = () => {
        if (this.quietRenderToken === renderToken) this.removeAttribute("data-quiet-render");
      };
      if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(clearQuietRender);
      else setTimeout(clearQuietRender, 0);
    }
  }

  renderStateContents() {
    const mode = this.state.mode ?? "normal";
    this.modeSelect.value = mode;
    this.routines.householdMode = mode;
    const civilDate = this.currentCivilDate();
    const responsibilityContext = this.responsibilityContext();
    this.catchUp.summary = this.state.summary;
    this.catchUp.lastLookedAt = this.catchUpCursor?.lastLookedAt;
    this.todayDate.textContent = formatCivilDate(civilDate);
    const selected = this.selection?.itemId ?? null;
    for (const list of [this.needs, this.shopping, this.staples]) {
      list.update({
        today: civilDate,
        items: this.state.items,
        responsibilityContext,
        areas: this.state.areas ?? [],
        pins: this.state.pins ?? [],
        attachments: this.attachmentRows,
        selected,
      });
    }
    this.today.update({
      today: civilDate,
      items: this.state.items,
      responsibilityContext,
      areas: this.state.areas ?? [],
      pins: this.state.pins ?? [],
      attachments: this.attachmentRows,
      selected,
      routines: this.state.routines ?? [],
      handoffs: this.state.handoffs ?? [],
      mode,
    });
    const waiting = (this.state.handoffs ?? []).filter((record) => record.status === "unacknowledged").length;
    const updatesNav = this.segmentNavs?.get("updates");
    if (updatesNav) updatesNav.segments = SEGMENTS.updates.map((entry) => ({ id: entry.id, label: entry.label, hash: routeHash("updates", entry.id), count: entry.id === "handoffs" ? waiting : 0, countLabel: "waiting" }));
    if (updatesNav && this.route?.page === "updates") updatesNav.current = this.route.segment;
    const activePulse = this.state.pulses.find((pulse) => pulse.actorId === this.store?.actorId && pulse.status === "active");
    if (this.householdGlance) this.householdGlance.textContent = `Household mode: ${{ normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" }[mode] ?? mode}${mode !== "normal" ? " (routines paused)" : ""}. Your pulse: ${activePulse ? activePulse.value.replace("-", " ") : "not set"}.`;
    if (this.selection) {
      const current = this.state.items.find((item) => item.itemId === this.selection.itemId) ?? null;
      this.feedDetail(current);
    }
    this.renderReminders();
    this.handoffs.handoffs = this.state.handoffs;
    this.talks.talks = this.state.talks;
    this.search.household = {
      items: this.state.items,
      handoffs: this.state.handoffs,
      talks: this.state.talks,
      notes: this.state.notes ?? [],
      referenceRecords: this.state.referenceRecords ?? [],
      maintenanceEvents: this.state.maintenanceEvents ?? [],
      areas: this.state.areas ?? [],
    };
    this.pulse.pulse = this.state.pulses.find(
      (pulse) => pulse.actorId === this.store?.actorId,
    );
    this.routines.today = civilDate;
    this.routines.routines = this.state.routines ?? [];
    this.routines.responsibilityContext = responsibilityContext;
    this.routines.playbooks = this.state.playbooks ?? [];
    this.areas.areas = this.state.areas ?? [];
    this.notes.notes = this.state.notes ?? [];
    this.notes.references = this.state.referenceRecords ?? [];
    this.notes.maintenance = this.state.maintenanceEvents ?? [];
    this.notes.attachments = this.attachmentRows;
    this.notes.routines = this.state.routines ?? [];
    this.notes.areas = this.state.areas ?? [];
    this.updateCalendarExportButton();
    this.schedulePulseRefresh();
  }

  updateCalendarExportButton() {
    if (!this.calendarExportButton) return;
    this.calendarExportButton.disabled = this.busy || !this.state?.items?.some(
      (item) => item.status === "active" && item.planningDate != null,
    );
  }

  setBusy(isBusy) {
    this.busy = isBusy;
    if (!this.isConnected) return;
    this.updateCalendarExportButton();
    this.main.setAttribute("aria-busy", String(isBusy));
    this.compose.disabled = isBusy || !this.store;
    this.quickAdd.disabled = isBusy || !this.store;
    for (const button of this.onboarding?.querySelectorAll("button") ?? []) button.disabled = isBusy;
    this.today.disabled = isBusy || !this.store;
    this.needs.disabled = isBusy || !this.store;
    this.shopping.disabled = isBusy || !this.store;
    this.staples.disabled = isBusy || !this.store;
    this.search.disabled = isBusy || !this.store;
    this.handoffs.disabled = isBusy || !this.store;
    this.talks.disabled = isBusy || !this.store;
    this.pulse.disabled = isBusy || !this.store;
    this.catchUp.disabled = isBusy || !this.store;
    if (this.detail) this.detail.disabled = isBusy || !this.store;
    if (this.lockButton) this.lockButton.disabled = isBusy;
    this.routines.disabled = isBusy || !this.store;
    this.areas.disabled = isBusy || !this.store;
    this.notes.disabled = isBusy || !this.store;
    if (this.modeSelect) this.modeSelect.disabled = isBusy || !this.store;
    this.household.disabled = isBusy || !this.store;
    if (this.appearance) this.appearance.disabled = isBusy || !this.store;
    if (this.householdDefaults) this.householdDefaults.disabled = isBusy || !this.store;
    if (this.installButton) this.installButton.disabled = isBusy;
    for (const button of this.main.querySelectorAll("kin-responsibility button"))
      button.disabled = isBusy;
    this.retryButton.disabled = isBusy;
  }

  setStatus(message) {
    this.status.textContent = message;
    clearTimeout(this.statusTimer);
    this.status.removeAttribute("data-stale");
    if (message) this.statusTimer = setTimeout(() => this.status.setAttribute("data-stale", "true"), 6_000);
  }

  clearAlert() {
    this.feedback?.classList.remove("app-feedback-inline");
    this.alert.textContent = "";
    this.alert.hidden = true;
    this.retryButton.hidden = true;
    this.retryAction = null;
    this.retryIntent = null;
    this.suspendedRetry = null;
  }

  showAlert(message, retryAction = null, retryIntent = null) {
    if (!this.vault || this.vault.locked) return;
    this.alert.textContent = message;
    this.alert.hidden = false;
    this.retryAction = retryAction;
    this.retryIntent = retryIntent;
    this.retryButton.hidden = typeof retryAction !== "function";
  }

  async openUnlockedHousehold(vault) {
    this.clearAppliedAppearance();
    vault.assertUnlocked();
    this.vault = vault;
    this.securityGeneration++;
    setActiveVault(vault);
    this.removeLockListener?.();
    this.removeLockListener = vault.onLock(() => this.lockHousehold(false));
    const generation = this.securityGeneration;
    this.attachmentPreviews?.clear();
    this.attachmentPreviews = new AttachmentPreviewCache((record) => this.loadPreviewBlob(record));
    await this.initialize();
    this.assertCurrentSession({ vault, generation });
    vault.assertUnlocked();
    if (!this.store)
      throw new Error("Kin could not verify the household store.");
    const session = this.captureSession();
    try {
      const appearance = await loadAppearance(this.store, vault);
      this.assertCurrentSession(session);
      this.personalAppearance = appearance;
      const editorValue = appearance.version === 2 ? { ...DEFAULT_APPEARANCE, owner: appearance.owner } : appearance;
      this.appearance.initialize(editorValue);
      this.applyEffectiveAppearance();
    } catch (error) {
      this.assertCurrentSession(session);
      this.appearance.initialize({ version: 1, owner: null, mode: "system", colorSource: "default", seed: "#984D38", manual: null, image: null });
      this.setStatus("Kin couldn't load your saved appearance, so the default is in use.");
    }
    this.scheduleAutoLock();
    this.renderOnboarding();
    this.main.focus();
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
    const session = this.captureSession();
    try {
      const saved = await saveAppearance(session.store, session.vault, value);
      this.assertCurrentSession(session);
      this.personalAppearance = structuredClone(saved);
      this.applyEffectiveAppearance();
      complete(saved, null);
    } catch (error) {
      if (this.isCurrentSession(session)) complete(null, new Error("Kin couldn't save your appearance. Your previous saved appearance is unchanged."));
    }
  }

  async handleUseHouseholdAppearance(event) {
    const session = this.captureSession();
    try {
      this.personalAppearance = await saveAppearance(session.store, session.vault, event.detail.value);
      this.assertCurrentSession(session);
      const effective = resolveAppearance(this.personalAppearance, this.householdSettings);
      this.appearance.initialize(effective);
      this.applyAppearance(effective);
      this.setStatus("Now following the household appearance on this device.");
    } catch { if (this.isCurrentSession(session)) this.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
  }

  async handleInheritAppearanceProperty(event) {
    const session = this.captureSession();
    const next = { ...this.personalAppearance, version: 2 };
    if (event.detail.property === "mode") delete next.mode;
    if (event.detail.property === "color") { delete next.colorSource; delete next.seed; delete next.manual; }
    if (event.detail.property === "background") {
      delete next.image;
      if (next.colorSource === "background") { delete next.colorSource; delete next.seed; delete next.manual; }
    }
    try {
      this.personalAppearance = await saveAppearance(session.store, session.vault, next);
      this.assertCurrentSession(session);
      const effective = resolveAppearance(this.personalAppearance, this.householdSettings);
      this.appearance.initialize(effective);
      this.applyAppearance(effective);
      this.setStatus(`Now following the household ${event.detail.property} on this device.`);
    } catch { if (this.isCurrentSession(session)) this.setStatus("Kin couldn't update your appearance. Your previous choice is unchanged."); }
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
    const session = this.captureSession();
    try {
      const result = await this.syncCoordinator.loadHouseholdSettings();
      this.assertCurrentSession(session);
      if (result.value && (this.householdSettings?.revision ?? -1) <= result.value.revision) this.householdSettings = result.value;
      this.householdDefaults.initialize({ ...result, value: this.householdSettings });
      this.applyEffectiveAppearance();
    } catch { if (this.isCurrentSession(session)) this.setStatus("Kin kept the last verified household appearance because the latest shared settings could not be loaded."); }
  }

  async restoreCachedHouseholdDefaults(identity, session = this.captureSession()) {
    if (!identity) return;
    try {
      const value = await loadCachedHouseholdSettings(identity);
      this.assertCurrentSession(session);
      if (value && (this.householdSettings?.revision ?? -1) <= value.revision) this.householdSettings = value;
      this.householdDefaults.initialize({ admin: false, adminRecorded: false, value: this.householdSettings });
      this.applyEffectiveAppearance();
    } catch {
      if (this.isCurrentSession(session)) this.setStatus("Kin couldn't restore the last shared appearance. Local household information is still available.");
    }
  }

  async handleSaveHouseholdDefaults(event) {
    const { value, complete } = event.detail;
    if (!this.syncCoordinator) { complete(null, new Error("Connect household sync before changing shared settings.")); return; }
    const session = this.captureSession();
    try {
      const saved = await this.syncCoordinator.saveHouseholdSettings(value);
      this.assertCurrentSession(session);
      this.householdSettings = saved;
      this.applyEffectiveAppearance();
      complete(saved, null);
    } catch (error) { complete(null, error); }
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
    const session = this.captureSession();
    this.assertCurrentSession(session);
    const opened = await this.loadAttachmentForView(record, session);
    return opened.blob;
  }

  lockHousehold(broadcast = true, { preserveSecurityOperation = false } = {}) {
    if (broadcast) {
      // A protected read holds a native transaction while crypto runs. Notify
      // peers before the epoch write queues behind that read, so they abort it
      // promptly. The later committed epoch remains authoritative if delivery
      // is missed. Numbered intent also cannot revoke a newer unlock epoch.
      this.notifyPeerLock((this.vault?.securityEpoch ?? this.security?.manifest?.lockEpoch ?? -1) + 1);
      this.lockBarrier = Promise.resolve(this.lockBarrier)
        .then(() => EventStore.lockAll())
        .then((lockEpoch) => {
          try {
            this.channel?.postMessage({ type: "household-locked", lockEpoch });
          } catch {
            // Durable epoch guards still reject stale capabilities.
          }
          return lockEpoch;
        })
        .catch((error) => {
          this.security?.error(error);
        });
    }
    this.securityGeneration++;
    this.clearAppliedAppearance();
    this.removeLockListener?.();
    this.removeLockListener = null;
    const vault = this.vault ?? getActiveVault();
    this.vault = null;
    vault?.lock();
    clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
    this.closeViewer();
    this.closeItemDetail({ restoreFocus: false });
    this.commandPalette?.dismiss();
    this.commandGeneration = null;
    this.clearBulkOutcome();
    this.pendingCapture = null;
    // Reminder timers hold decrypted titles; none may fire once locked.
    this.localReminders.cancelAll();
    // pendingScheduleChange holds only random ids and a cadence. It survives
    // a lock so that unlocking the same vault can finish a half-saved change
    // instead of starting a second replacement; other vaults never see it.
    this.attachmentPreviews?.clear();
    this.attachmentPreviews = null;
    this.attachmentTarget = null;
    this.syncState = null;
    this.pageScroll.clear();
    if (this.siteTools) this.siteTools.hidden = true;
    if (this.syncChip) this.syncChip.state = null;
    for (const timer of this.attachmentProgressTimers.values()) clearTimeout(timer);
    this.attachmentProgressTimers.clear();
    clearAttachmentProgress();
    this.householdStatus = null;
    this.passkeyPromptDismissed = false;
    if (this.onboarding) { this.onboarding.hidden = true; this.onboarding.replaceChildren(); }
    this.syncCoordinator?.stop();
    this.syncCoordinator = null;
    this.store?.close();
    this.store = null;
    this.engine?.dispose?.();
    this.engine = null;
    this.state = null;
    this.attachmentRows = [];
    this.snapshotBoundary = null;
    this.catchUpCursor = null;
    this.pendingRefresh = false;
    this.refreshing = false;
    this.checkingAuthorization = false;
    this.starting = null;
    this.startingGeneration = null;
    clearTimeout(this.pulseTimer);
    clearTimeout(this.focusTimer);
    this.clearAlert();
    clearLegacyDrafts();
    this.quickAdd?.reset();
    if (this.main) {
      this.nav.hidden = true;
      this.shell.before(this.security);
      this.main.hidden = true;
      this.main.replaceChildren();
      // Replacing every component drops private arrays, drafts and DOM nodes.
      const components = [
        ["catchUp", "kin-catch-up"],
        ["today", "kin-today"],
        ["needs", "kin-today"],
        ["shopping", "kin-today"],
        ["staples", "kin-today"],
        ["compose", "kin-compose"],
        ["handoffs", "kin-handoff-list"],
        ["talks", "kin-talk-list"],
        ["search", "kin-search"],
        ["pulse", "kin-pulse"],
        ["routines", "kin-routines"],
        ["detail", "kin-item-detail"],
      ];
      for (const [field, name] of components)
        this[field] = document.createElement(name);
      this.detailMode = null;
      this.household.syncKeyStore?.close();
      this.household.remove();
      this.buildViews(this.main);
      if (!this.stateNotice.isConnected) this.main.prepend(this.stateNotice);
      this.setBusy(false);
      this.setStatus("Household locked.");
      if (!preserveSecurityOperation) this.security.locked();
    }
  }

  notifyPeerLock(lockEpoch) {
    if (!Number.isSafeInteger(lockEpoch) || lockEpoch < 1) return;
    try { this.channel?.postMessage({ type: "household-locked", lockEpoch }); }
    catch { /* The durable epoch still fences subsequent operations. */ }
  }
}

customElements.define("kin-app", KinApp);
