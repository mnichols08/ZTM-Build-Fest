import { projectionContext } from "../browser-time.js";
import { LocalReminders } from "../reminders.js";
import { createCalendarExport } from "../calendar-export.js";
import { captureAttachment, loadLocalAttachmentRows, openAttachment, removeAttachment } from "../attachments/attachment-lifecycle.js";
import "./kin-routines.js";
import "./kin-areas.js";
import "./kin-notes.js";
import { loadKinEngine, randomId } from "../wasm/kin-engine.js";
import { EventStore } from "../storage/event-store.js";
import { SyncCoordinator } from "../sync/sync-coordinator.js";
import "./kin-compose.js";
import "./kin-item.js";
import "./kin-today.js";
import "./kin-handoff-list.js";
import "./kin-talk-list.js";
import "./kin-search.js";
import "./kin-pulse.js";
import "./kin-catch-up.js";
import "./kin-household.js";
import "./kin-security.js";
import { clearLegacyDrafts } from "./kin-security.js";
import {
  getActiveVault,
  setActiveVault,
  VaultError,
} from "../security/local-vault.js";

const START_ERROR =
  "Kin could not start its household engine or local storage. Your saved information was not intentionally deleted.";
const SAVE_ERROR =
  "Kin could not save that change locally. Your existing information was not intentionally deleted.";

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
    this.onOpenAttachment = (event) => this.handleOpenAttachment(event);
    this.onRemoveAttachment = (event) => this.handleRemoveAttachment(event);
    this.onRetryAttachments = () => { if (this.syncCoordinator) void this.syncCoordinator.syncNow(); else void this.configureSyncCoordinator(); };
    this.onChangeResponsibility = (event) => this.handleChangeResponsibility(event);
    this.onReplenishStaple = (event) => this.handleReplenishStaple(event);
    this.onOffline = () => {
      this.stateNotice.textContent =
        "Offline — saved changes stay on this device. Household sync needs a connection.";
      this.stateNotice.hidden = false;
    };
    this.onOnline = () => {
      this.stateNotice.hidden = true;
      if (!this.vault || this.vault.locked || !this.store) return;
      this.setStatus("Connection available.");
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
    this.onAreaIntent = (event) => this.saveArea(event.detail);
    this.onNoteIntent = (event) => this.saveNote(event.type.slice(4), event.detail);
    this.onReferenceIntent = (event) => this.saveReferenceRecord(event.type.slice(4), event.detail);
    this.onMaintenanceIntent = (event) => this.saveMaintenanceEvent(event.type.slice(4), event.detail);
    this.onItemAreaChange = (event) => this.saveArea({ ...event.detail, action: "assign-item-area" });
    this.onItemPlanningDateChange = (event) =>
      this.saveItemPlanningDate(event.detail, event.target.closest("kin-today"));
    this.onPinIntent = (event) => this.savePin(event.detail);
    this.onOpenPin = (event) => this.openPinnedItem(event.detail.itemId);
    this.onPlaybookIntent = (event) => this.handlePlaybookIntent(event);
    this.onLocalReminder = (event) => this.handleLocalReminder(event.detail);
    this.onCancelLocalReminder = (event) => { this.localReminders.cancel(event.detail.id); this.setStatus("Reminder canceled on this device."); };
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
      this.setStatus(event.detail?.message ?? "Household sync has stopped.");
    };
    this.onSyncState = (value) => this.handleSyncState(value);
    this.onHashChange = () => this.showPageFromLocation();
    this.onNavigationClick = (event) => {
      const link = event.target.closest?.("a[data-page]");
      if (
        !link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      ) return;
      event.preventDefault();
      history.pushState(null, "", link.hash);
      this.showPageFromLocation();
    };
    this.onHandoffTabClick = (event) => {
      const tab = event.target.closest?.('[role="tab"][data-panel]');
      if (tab) this.showHandoffPanel(tab.dataset.panel, true);
    };
    this.onHandoffTabKeydown = (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const tabs = [...this.handoffTabs.querySelectorAll('[role="tab"]')];
      const current = tabs.indexOf(event.target);
      if (current < 0) return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      tabs[(current + step + tabs.length) % tabs.length].focus();
      this.showHandoffPanel(tabs[(current + step + tabs.length) % tabs.length].dataset.panel);
    };
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
      void navigator.serviceWorker.register("/service-worker.js").then((registration) => {
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
    this.addEventListener("kin:open-attachment", this.onOpenAttachment);
    this.addEventListener("kin:remove-attachment", this.onRemoveAttachment);
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
    window.addEventListener("hashchange", this.onHashChange);
    window.addEventListener("popstate", this.onHashChange);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("pagehide", this.onPageHide);
    for (const action of [
      "create-routine",
      "complete-routine-occurrence",
      "reopen-routine-occurrence",
      "archive-routine",
    ]) {
      this.addEventListener(`kin:${action}`, this.onRoutineIntent);
    }
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
    const brand = document.createElement("div");
    brand.className = "brand";
    const title = document.createElement("span");
    title.textContent = "Kin";
    title.className = "brand-name";
    const mark = document.createElement("img");
    mark.className = "brand-mark";
    mark.src = "/icon.svg";
    mark.alt = "";
    const tagline = document.createElement("p");
    tagline.textContent = "A little more in step.";
    const brandCopy = document.createElement("div");
    brandCopy.className = "brand-copy";
    brandCopy.append(title, tagline);
    brand.append(mark, brandCopy);
    header.append(brand);

    this.header = header;

    const shell = document.createElement("div");
    shell.className = "application-shell";
    this.shell = shell;

    const nav = document.createElement("nav");
    nav.className = "primary-nav";
    nav.setAttribute("aria-label", "Household");
    nav.hidden = true;
    const destinations = [
      ["today", "Today", '<path d="M3 10.8 12 3l9 7.8"/><path d="M5.5 9.5V20h13V9.5M9.5 20v-6h5v6"/>'],
      ["lists", "Lists", '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>'],
      ["routines", "Routines", '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2"/>'],
      ["handoff", "Handoff", '<path d="M8 10h8M8 14h5"/><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4l-3 3-3-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>'],
      ["more", "More", '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'],
    ];
    this.navLinks = new Map();
    for (const [id, label, icon] of destinations) {
      const link = document.createElement("a");
      link.className = "nav-link";
      link.href = `#${id}`;
      link.dataset.page = id;
      link.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span>${label}</span>`;
      nav.append(link);
      this.navLinks.set(id, link);
    }
    this.nav = nav;
    nav.addEventListener("click", this.onNavigationClick);

    const main = document.createElement("main");
    main.id = "main";
    main.tabIndex = -1;
    main.setAttribute("aria-busy", "true");
    // The invitation route exposes only the enrollment surface until authorization.
    main.hidden = true;
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

    this.security = document.createElement("kin-security");
    this.security.onUnlocked = (vault) => this.openUnlockedHousehold(vault);
    this.security.onLockRequested = () => this.lockHousehold();
    this.replaceChildren(header, this.security, shell, feedback, this.routeAnnouncement);
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
      const hasDraft = this.compose?.input?.value.trim() || this.routines?.input?.value.trim() || this.routines?.playbookTitle?.value.trim() || this.routines?.playbookEntries?.value.trim() || this.notes?.editor?.title.trim() || this.notes?.editor?.body.trim();
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
    this.showPageFromLocation();
  }

  showUpdateNotice() {
    if (this.updateNotice) this.updateNotice.hidden = false;
  }

  buildViews(main) {
    const page = (id, title, description) => {
      const section = document.createElement("section");
      section.className = "app-view";
      section.id = id;
      section.setAttribute("aria-labelledby", `${id}-title`);
      const intro = document.createElement("header");
      intro.className = "page-intro";
      const heading = document.createElement("h1");
      heading.id = `${id}-title`;
      heading.textContent = title;
      intro.append(heading);
      if (description) {
        const supporting = document.createElement("p");
        supporting.textContent = description;
        intro.append(supporting);
      }
      section.append(intro);
      return section;
    };

    this.pages = new Map();
    const today = page("today", "A little less to carry.", "A place for what needs doing, remembering, or a little conversation.");
    this.catchUp.setAttribute("aria-label", "Catch up since you last looked");
    this.today.display = "today";
    today.append(this.catchUp, this.compose, this.today);

    const lists = page("lists", "Lists", "Capture first. Sort later.");
    this.calendarExportButton = document.createElement("button");
    this.calendarExportButton.type = "button";
    this.calendarExportButton.className = "calendar-export-button";
    this.calendarExportButton.textContent = "Download calendar (.ics)";
    this.calendarExportButton.setAttribute(
      "aria-label",
      "Download active planned Items as an all-day calendar",
    );
    this.calendarExportButton.disabled = true;
    this.calendarExportButton.addEventListener("click", () => this.downloadCalendar());
    const calendarExportNote = document.createElement("p");
    calendarExportNote.textContent =
      "The downloaded .ics file is unencrypted and contains planned Item text.";
    lists.querySelector(".page-intro").append(
      this.calendarExportButton,
      calendarExportNote,
    );
    this.needs.display = "need";
    this.shopping.display = "shopping";
    this.staples.display = "staple";
    lists.append(this.needs, this.shopping, this.staples);

    const search = page("search", "Search", "Find household context without sending your search outside this device.");
    search.append(this.search);

    const routines = page("routines", "Routines", "Small household rhythms, without streaks or pressure.");
    routines.append(this.routines);

    const handoff = page("handoff", "Handoff", "Pass along what will help someone pick things up.");
    const tablist = document.createElement("div");
    tablist.className = "section-tabs";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", "Handoff and Talk");
    this.handoffTabs = tablist;
    const handoffPanel = document.createElement("section");
    handoffPanel.id = "handoffs-panel";
    handoffPanel.setAttribute("role", "tabpanel");
    handoffPanel.setAttribute("aria-labelledby", "handoffs-tab");
    const talkPanel = document.createElement("section");
    talkPanel.id = "talk-panel";
    talkPanel.setAttribute("role", "tabpanel");
    talkPanel.setAttribute("aria-labelledby", "talk-tab");
    for (const [id, label, panel] of [
      ["handoffs", "Handoffs", handoffPanel],
      ["talk", "Talk", talkPanel],
    ]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.id = `${id}-tab`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panel.id);
      tab.dataset.panel = id;
      tab.textContent = label;
      tablist.append(tab);
    }
    handoffPanel.append(this.handoffs);
    talkPanel.append(this.talks);
    handoff.append(tablist, handoffPanel, talkPanel);
    tablist.addEventListener("click", this.onHandoffTabClick);
    tablist.addEventListener("keydown", this.onHandoffTabKeydown);

    const more = page("more", "More", "Household context, people, devices, and continuity.");
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
    more.append(this.installButton);
    const searchLink = document.createElement("a");
    searchLink.className = "more-search-link";
    searchLink.href = "#search";
    searchLink.textContent = "Search household";
    more.append(searchLink);
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
    modeHint.textContent = "Routine occurrences pause outside Normal; routine definitions stay unchanged.";
    modeSection.append(modeHeading, modeLabel, this.modeSelect, modeHint);
    more.append(modeSection);
    more.append(this.pulse);
    this.household = document.createElement("kin-household");
    this.moreSecurity = document.createElement("section");
    this.moreSecurity.className = "more-security";
    const securityHeading = document.createElement("h2");
    securityHeading.textContent = "Privacy & continuity";
    this.moreSecurity.append(securityHeading);
    more.append(this.moreSecurity);
    more.insertBefore(this.areas, this.moreSecurity);
    this.notes = document.createElement("kin-notes");
    more.insertBefore(this.notes, this.moreSecurity);

    for (const section of [today, lists, search, routines, handoff, more]) {
      this.pages.set(section.id, section);
      main.append(section);
    }
    this.showHandoffPanel("handoffs");
    this.showPageFromLocation();
  }

  showPageFromLocation() {
    if (!this.pages || !this.navLinks) return;
    const requested = location.hash.slice(1);
    const active = this.pages.has(requested) ? requested : "today";
    const labels = { today: "Today", lists: "Lists", search: "Search", routines: "Routines", handoff: "Handoff", more: "More" };
    const changed = this.activePage !== active;
    this.activePage = active;
    document.title = `${labels[active]} — Kin`;
    if (changed && this.routeAnnouncement) this.routeAnnouncement.textContent = `${labels[active]} view`;
    const currentDestination = active === "search" ? "more" : active;
    for (const [id, section] of this.pages) section.hidden = id !== active;
    for (const [id, link] of this.navLinks) {
      if (id === currentDestination) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  showHandoffPanel(id, focus = false) {
    if (!this.handoffTabs) return;
    const active = id === "talk" ? "talk" : "handoffs";
    for (const tab of this.handoffTabs.querySelectorAll('[role="tab"]')) {
      const selected = tab.dataset.panel === active;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (focus && selected) tab.focus();
    }
    this.pages?.get("handoff")?.querySelector("#handoffs-panel")?.toggleAttribute("hidden", active !== "handoffs");
    this.pages?.get("handoff")?.querySelector("#talk-panel")?.toggleAttribute("hidden", active !== "talk");
  }

  disconnectedCallback() {
    this.lockHousehold(false);
    window.removeEventListener("beforeinstallprompt", this.onBeforeInstallPrompt);
    window.removeEventListener("appinstalled", this.onAppInstalled);
    navigator.serviceWorker?.removeEventListener("message", this.onServiceWorkerMessage);
    navigator.serviceWorker?.removeEventListener("controllerchange", this.onControllerChange);
    this.removeEventListener("kin:lock", this.onLockRequest);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("hashchange", this.onHashChange);
    window.removeEventListener("popstate", this.onHashChange);
    window.removeEventListener("offline", this.onOffline);
    window.removeEventListener("online", this.onOnline);
    this.removeEventListener("kin:add-item", this.onAddItem);
    this.removeEventListener("kin:add-attachment", this.onAddAttachment);
    this.removeEventListener("kin:open-attachment", this.onOpenAttachment);
    this.removeEventListener("kin:remove-attachment", this.onRemoveAttachment);
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
      this.renderState();
      void this.refreshAttachmentRows();
      this.main.hidden = false;
      this.nav.hidden = false;
      this.moreSecurity.before(this.household);
      this.moreSecurity.append(this.security);
      this.showPageFromLocation();
      this.setStatus("Ready.");
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
    try {
      await coordinator.start();
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
    if (value.state === "paused") {
      const attention = value.code === "device_not_trusted"
        ? "This device is no longer trusted for household sync. Its saved information remains on this device."
        : value.code === "membership_removed"
          ? "This device no longer has access to household sync. Its saved information remains on this device."
          : value.message;
      if (attention) {
        this.stateNotice.textContent = attention;
        this.stateNotice.hidden = false;
      }
    } else if (["ready", "disabled"].includes(value.state)) {
      this.stateNotice.hidden = true;
    }
    if (value.projection) {
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
      this.attachmentRows = value.attachmentRows;
      this.renderState();
    }
    if (Array.isArray(value.memberIds)) {
      this.activeMemberIds = [...new Set(value.memberIds)];
      this.renderState();
      void this.reconcileResponsibilityMembers();
    }
    if (value.message && value.state !== "paused")
      this.setStatus(value.message);
  }

  async handleAddItem(event) {
    if (this.busy || !this.store || !this.engine) {
      return;
    }
    const session = this.captureSession();
    const submittedDraft = Object.freeze({
      text: event.detail.text,
      classification: event.detail.classification,
      ...(event.detail.sourceStapleId
        ? {
            sourceStapleId: event.detail.sourceStapleId,
            id: event.detail.id ?? randomId(),
          }
        : {}),
    });
    const sourceList = submittedDraft.sourceStapleId ? this.staples : null;
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    let restoreComposeFocus = false;
    try {
      const command = {
        type: "add",
        text: submittedDraft.text,
        classification: submittedDraft.classification,
        ...(submittedDraft.id ? { id: submittedDraft.id } : {}),
      };
      await this.appendCommand(command);
      this.assertCurrentSession(session);
      this.renderState();
      if (!sourceList) this.compose.clearIfMatches(submittedDraft);
      this.setStatus(sourceList ? "Added to Shopping." : "Added.");
      this.broadcastEventChange();
      restoreComposeFocus = !sourceList;
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? SAVE_ERROR, () =>
        this.handleAddItem({ detail: submittedDraft }),
      );
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
          this.compose.focusInput();
        }
        this.flushPeerRefresh();
      }
    }
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
      this.setStatus(
        submitted.type === "create-routine"
          ? "Routine added."
          : submitted.type === "archive-routine"
            ? "Routine archived."
            : submitted.type === "complete-routine-occurrence"
              ? "Occurrence completed."
              : "Occurrence reopened.",
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
        if (
          submitted.type === "create-routine" ||
          submitted.type === "archive-routine"
        )
          this.routines.focusInput();
        else this.routines.restoreFocus(focus);
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
      this.setStatus(action === "save-playbook" ? "Playbook saved." : "Playbook archived.");
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
      this.assertCurrentSession(session); this.renderState(); this.broadcastEventChange(); this.setStatus("Checklist created. It is now an ordinary household item.");
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
            .find((select) => select.dataset.itemId === detail.itemId)
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
      this.setStatus(detail.planningDate ? "Planned date saved." : "Planned date cleared.");
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      if (error.code === 4) this.pendingRefresh = true;
      this.renderState();
      this.showAlert(error.userMessage ?? SAVE_ERROR);
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        sourceList?.querySelector(
          `.item-planning-date-input[data-item-id="${detail.itemId}"]`,
        )?.focus();
        this.flushPeerRefresh();
      }
    }
  }

  async handleLocalReminder({ id, title, at }) {
    const itemId = id.startsWith("item:") ? id.slice(5) : null;
    const currentItem = () => !itemId || this.state?.items?.some((item) => item.itemId === itemId && item.status === "active");
    try {
      const result = await this.localReminders.schedule({ id, title, at, isCurrent: currentItem });
      this.setStatus(result === "granted" ? "Reminder set on this device while Kin is open." : result === "denied" ? "Notifications are blocked in browser settings. Kin still works normally." : "Reminders are unavailable in this browser. Kin still works normally.");
    } catch (error) {
      this.showAlert(error.message ?? "Choose a future reminder time.");
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

  async handleAddAttachment(event) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession();
    const { file, parentKind, parentId, status } = event.detail;
    this.setBusy(true); this.clearAlert();
    try {
      const saved = await captureAttachment({ file, parentKind, parentId, identity: this.syncCoordinator?.identity ?? this.household?.identity, store: session.store, keyStore: this.syncCoordinator?.keyStore, append: (command) => this.appendCommand(command) });
      this.assertCurrentSession(session);
      this.attachmentRows = [...this.attachmentRows.filter((row) => row.attachmentId !== saved.attachmentId), { ...saved, parentKind, parentId }];
      this.renderState(); this.broadcastEventChange();
      if (status) status.textContent = `${saved.name} is saved on this device. Waiting to sync.`;
      void this.syncCoordinator?.syncNow();
    } catch (error) {
      if (error.code === "locked" || !this.isCurrentSession(session)) return;
      this.showAlert(error.userMessage ?? error.message ?? "Kin could not save this attachment on this device.");
      if (status) status.textContent = "Kin couldn't save this attachment.";
    } finally { if (this.isCurrentSession(session)) this.setBusy(false); }
  }

  async handleOpenAttachment(event) {
    if (!this.store) { this.showAlert("This attachment is unavailable on this device."); return; }
    const session = this.captureSession();
    const detail = event.detail;
    const binding = this.state?.attachments?.find((item) => item.attachmentId === detail.attachmentId && !item.removed);
    if (!binding || binding.parentKind !== detail.parentKind || binding.parentId !== detail.parentId) { this.showAlert("This attachment is unavailable."); return; }
    const tab = detail.download ? null : window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const syncState = await session.store.getSyncState();
      const opened = await openAttachment({ attachmentId: detail.attachmentId, binding, identity: this.syncCoordinator?.identity ?? (syncState ? { householdId: syncState.householdId } : null), store: session.store, keyStore: this.syncCoordinator?.keyStore });
      this.assertCurrentSession(session);
      const url = URL.createObjectURL(opened.blob);
      if (detail.download) { const link = document.createElement("a"); link.href = url; link.download = opened.name; link.hidden = true; document.body.append(link); link.click(); link.remove(); }
      else if (tab) tab.location.href = url;
      else { const link = document.createElement("a"); link.href = url; link.target = "_blank"; link.rel = "noopener"; link.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { tab?.close(); if (error.code !== "locked") this.showAlert("This attachment is unavailable on this device."); }
  }

  async handleRemoveAttachment(event) {
    if (this.busy || !this.store || !this.engine) return;
    const session = this.captureSession(); this.setBusy(true); this.clearAlert();
    try {
      await removeAttachment({ attachmentId: event.detail.attachmentId, append: (command) => this.appendCommand(command), store: session.store });
      this.assertCurrentSession(session);
      this.attachmentRows = this.attachmentRows.filter((row) => row.attachmentId !== event.detail.attachmentId);
      this.renderState(); this.broadcastEventChange(); void this.syncCoordinator?.syncNow();
    } catch (error) { if (error.code !== "locked" && this.isCurrentSession(session)) this.showAlert(error.userMessage ?? SAVE_ERROR); }
    finally { if (this.isCurrentSession(session)) this.setBusy(false); }
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
    const stale = this.state.responsibilities.filter((entry) => entry.memberId && !active.has(entry.memberId));
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
        this.flushPeerRefresh();
      }
    }
  }

  openPinnedItem(itemId) {
    const item = this.state?.items.find((record) => record.itemId === itemId && record.status !== "archived");
    if (!item) return;
    const page = item.classification === "today" ? "today" : "lists";
    history.pushState(null, "", `#${page}`);
    this.showPageFromLocation();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const text = [...this.main.querySelectorAll(".item-text[data-item-id]")].find((node) => node.dataset.itemId === itemId);
      if (!text) return;
      text.scrollIntoView({ block: "center" });
      text.focus();
    }));
  }

  async handleReopenItem(event) {
    return this.handleItemAction("reopen", event.detail.itemId);
  }

  async handleArchiveItem(event) {
    this.localReminders.cancel(`item:${event.detail.itemId}`);
    return this.handleItemAction("archive", event.detail.itemId);
  }

  async handleItemAction(type, itemId) {
    if (this.busy || !this.store || !this.engine) {
      return;
    }
    const session = this.captureSession();
    const submittedItemId = itemId;
    const activeList = [this.needs, this.shopping, this.staples].find((list) =>
      list.contains(document.activeElement),
    );
    const restoreListFocus = Boolean(activeList);
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
        if (restoreComposeFocus && !restoreListFocus) {
          this.compose.focusInput();
        }
        this.flushPeerRefresh();
      }
    }
  }

  async handleItemStep(type, detail) {
    if (this.busy || !this.store || !this.engine) return;
    const list = this.today.contains(document.activeElement)
      ? this.today
      : this.needs.contains(document.activeElement)
        ? this.needs
        : this.shopping.contains(document.activeElement)
          ? this.shopping
          : null;
    if (list) list.rememberFocus();
    const session = this.captureSession();
    const command = Object.freeze({
      type,
      itemId: detail.itemId,
      ...(type === "add-item-step"
        ? { stepId: detail.stepId ?? randomId(), text: detail.text }
        : { stepId: detail.stepId }),
    });
    this.setBusy(true);
    this.clearAlert();
    this.setStatus("Saving…");
    try {
      await this.appendCommand(command);
      this.assertCurrentSession(session);
      this.renderState();
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
      this.showAlert(
        error.userMessage ?? SAVE_ERROR,
        () => this.handleItemStep(type, command),
        command,
      );
      this.setStatus("");
    } finally {
      if (this.isCurrentSession(session)) {
        this.setBusy(false);
        this.flushPeerRefresh();
      }
    }
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
    const restoreComposeFocus = this.today.contains(document.activeElement);
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
    const mode = this.state.mode ?? "normal";
    this.modeSelect.value = mode;
    this.routines.householdMode = mode;
    const memberId = this.syncCoordinator?.identity?.memberId ?? this.store?.actorId ?? null;
    const otherMemberId = this.activeMemberIds?.find((id) => id !== memberId) ?? null;
    const responsibilityContext = { responsibilities: this.state.responsibilities ?? [], memberId, otherMemberId };
    this.catchUp.summary = this.state.summary;
    this.catchUp.lastLookedAt = this.catchUpCursor?.lastLookedAt;
    this.today.items = this.state.items;
    this.today.responsibilityContext = responsibilityContext;
    this.today.areas = this.state.areas ?? [];
    this.today.pins = this.state.pins ?? [];
    this.today.attachments = this.attachmentRows;
    this.needs.items = this.state.items;
    this.needs.responsibilityContext = responsibilityContext;
    this.needs.areas = this.state.areas ?? [];
    this.needs.pins = this.state.pins ?? [];
    this.needs.attachments = this.attachmentRows;
    this.shopping.items = this.state.items;
    this.shopping.responsibilityContext = responsibilityContext;
    this.shopping.areas = this.state.areas ?? [];
    this.shopping.pins = this.state.pins ?? [];
    this.shopping.attachments = this.attachmentRows;
    this.staples.items = this.state.items;
    this.staples.responsibilityContext = responsibilityContext;
    this.staples.areas = this.state.areas ?? [];
    this.staples.pins = this.state.pins ?? [];
    this.staples.attachments = this.attachmentRows;
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
    this.today.disabled = isBusy || !this.store;
    this.needs.disabled = isBusy || !this.store;
    this.shopping.disabled = isBusy || !this.store;
    this.staples.disabled = isBusy || !this.store;
    this.search.disabled = isBusy || !this.store;
    this.handoffs.disabled = isBusy || !this.store;
    this.talks.disabled = isBusy || !this.store;
    this.pulse.disabled = isBusy || !this.store;
    this.catchUp.disabled = isBusy || !this.store;
    this.routines.disabled = isBusy || !this.store;
    this.areas.disabled = isBusy || !this.store;
    this.notes.disabled = isBusy || !this.store;
    if (this.modeSelect) this.modeSelect.disabled = isBusy || !this.store;
    this.household.disabled = isBusy || !this.store;
    for (const tab of this.handoffTabs?.querySelectorAll('[role="tab"]') ?? [])
      tab.disabled = isBusy;
    this.retryButton.disabled = isBusy;
  }

  setStatus(message) {
    this.status.textContent = message;
  }

  clearAlert() {
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
    vault.assertUnlocked();
    this.vault = vault;
    this.securityGeneration++;
    setActiveVault(vault);
    this.removeLockListener?.();
    this.removeLockListener = vault.onLock(() => this.lockHousehold(false));
    const generation = this.securityGeneration;
    await this.initialize();
    this.assertCurrentSession({ vault, generation });
    vault.assertUnlocked();
    if (!this.store)
      throw new Error("Kin could not verify the household store.");
    this.main.focus();
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
    this.removeLockListener?.();
    this.removeLockListener = null;
    const vault = this.vault ?? getActiveVault();
    this.vault = null;
    vault?.lock();
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
      ];
      for (const [field, name] of components)
        this[field] = document.createElement(name);
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
