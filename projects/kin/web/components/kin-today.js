import "./kin-compose.js";
import "./kin-item.js";
import { composeToday, ROUTINE_PERIOD_LABELS } from "../today-view.js";
import { CLASSIFICATION_LABELS } from "./kin-compose.js";
import { isBulkEligible, reconcileSelection } from "../bulk-actions.js";
import { describeNextOccurrence, describeRepeat } from "../recurrence.js";

// A list view over the Rust projection. `display` selects one list
// ("need" — To do, which also lists legacy `today` records — "shopping",
// "staple") or the Today composition ("today"). Lists own a quick-add fixed
// to their destination; Today's capture lives beside the page heading.

const LISTS = {
  need: {
    title: "To do",
    hint: "Things someone needs to handle. Plan a date from an item's details to see it on Today.",
    empty: "Nothing to handle right now. Add something above, or check Shopping and Staples.",
    includes: (record) => record.classification === "need" || record.classification === "today",
  },
  shopping: {
    title: "Shopping",
    hint: "Things to buy. Staples can be added here with one tap.",
    empty: "Nothing to buy right now.",
    includes: (record) => record.classification === "shopping",
  },
  staple: {
    title: "Staples",
    hint: "Household essentials you re-add to Shopping whenever they run low.",
    empty: "No staples yet. Add the things you buy again and again.",
    includes: (record) => record.classification === "staple",
  },
};

const MODE_LABELS = { normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" };

class KinToday extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.areaRecords = [];
    this.pinRecords = [];
    this.attachmentRecords = [];
    this.routineRecords = [];
    this.handoffRecords = [];
    this.householdMode = "normal";
    this.civilDate = null;
    this.selectedItemId = null;
    this.isDisabled = false;
    this.display = "need";
    this.previewProvider = null;
    this.composer = null;
    this.completedOpen = false;
    // Bulk selection (To do and Shopping only). Ids live only in this element
    // while unlocked; lock replaces the element, which drops them.
    this.selectionMode = false;
    this.selectedIds = new Set();
    this.bulkResult = null;
    this.bulkBar = null;
    this.onItemSelection = (event) => {
      if (!this.selectionMode) return;
      event.stopPropagation();
      const { itemId, checked } = event.detail ?? {};
      if (checked) this.selectedIds.add(itemId);
      else this.selectedIds.delete(itemId);
      this.updateBulkBar();
    };
  }

  connectedCallback() {
    this.addEventListener("kin:item-selection", this.onItemSelection);
    this.render();
  }

  disconnectedCallback() { this.removeEventListener("kin:item-selection", this.onItemSelection); }

  // Assigns several inputs and renders once; setters stay for single changes.
  update(props) {
    this.suspended = true;
    try { for (const [key, value] of Object.entries(props)) this[key] = value; }
    finally { this.suspended = false; }
    this.render();
  }

  set items(value) { this.records = Array.isArray(value) ? value : []; this.render(); }
  set areas(value) { this.areaRecords = Array.isArray(value) ? value : []; this.render(); }
  set pins(value) { this.pinRecords = Array.isArray(value) ? value : []; this.render(); }
  set attachments(value) { this.attachmentRecords = Array.isArray(value) ? value : []; this.render(); }
  set routines(value) { this.routineRecords = Array.isArray(value) ? value : []; this.render(); }
  set handoffs(value) { this.handoffRecords = Array.isArray(value) ? value : []; this.render(); }
  set mode(value) { this.householdMode = value ?? "normal"; this.render(); }
  set today(value) { this.civilDate = Number.isSafeInteger(value) ? value : null; this.render(); }
  set selected(value) { this.selectedItemId = value ?? null; this.render(); }
  set previews(provider) { this.previewProvider = typeof provider === "function" ? provider : null; this.render(); }
  set responsibilityContext(value) { this.ownerContext = value ?? {}; this.render(); }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const item of this.querySelectorAll("kin-item")) item.disabled = this.isDisabled;
    if (this.composer) this.composer.disabled = this.isDisabled;
    for (const control of this.querySelectorAll("button, input, select")) {
      if (control.closest("kin-compose, kin-item")) continue;
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
    if (!this.isDisabled && this.deferredFocus?.isConnected) {
      const target = this.deferredFocus;
      this.deferredFocus = null;
      target.focus();
    }
  }

  get quickAdd() { return Object.hasOwn(LISTS, this.display); }

  // Lists whose Items complete and reopen; Staples and Today do not select.
  get isBulkList() { return this.display === "need" || this.display === "shopping"; }

  get selectedItemIds() { return [...this.selectedIds]; }

  selectedWithStatus(status) {
    return this.listRecords().filter((record) => record.status === status && this.selectedIds.has(record.itemId)).map((record) => record.itemId);
  }

  listRecords() {
    const config = LISTS[this.display];
    return config ? this.records.filter((record) => config.includes(record) && record.status !== "archived") : [];
  }

  setSelectionMode(on) {
    this.selectionMode = Boolean(on) && this.isBulkList;
    if (!this.selectionMode) this.selectedIds.clear();
    this.render();
  }

  // Select all applies to eligible rows a person can see: open items, plus
  // completed ones only while the Completed disclosure is open.
  selectAllVisible() {
    const visible = this.listRecords().filter((record) => isBulkEligible(record) && (record.status === "active" || this.completedOpen));
    for (const record of visible) this.selectedIds.add(record.itemId);
    this.syncChecks();
    this.updateBulkBar();
  }

  clearSelection() {
    this.selectedIds.clear();
    this.syncChecks();
    this.updateBulkBar();
  }

  deselect(itemIds) {
    for (const itemId of itemIds) this.selectedIds.delete(itemId);
    this.syncChecks();
    this.updateBulkBar();
  }

  syncChecks() {
    for (const row of this.querySelectorAll("kin-item")) row.checked = this.selectedIds.has(row.record?.itemId);
  }

  // Outcome of the last bulk action or undo, from <kin-app>. The message is a
  // polite status; Undo and Retry are ordinary buttons outside the live text.
  setBulkResult(result) {
    this.bulkResult = result ?? null;
    this.updateBulkBar();
  }

  setBulkProgress(text) {
    if (!this.bulkBar) return;
    this.bulkBar.progress.textContent = text ?? "";
    this.bulkBar.progress.hidden = !text;
  }

  focusBulkResult() {
    const bar = this.bulkBar;
    if (!bar) return;
    const target = [bar.undo, bar.retry, bar.dismiss].find((button) => !button.hidden && button.isConnected) ??
      (this.selectionMode ? bar.selectMode : null);
    if (!target) return;
    if (target.disabled) this.deferredFocus = target;
    else target.focus();
  }

  bulkAction(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(`kin:${type}`, { detail, bubbles: true, composed: true }));
  }

  ensureBulkBar() {
    if (this.bulkBar) return this.bulkBar;
    const label = LISTS[this.display]?.title ?? "list";
    const button = (text, action, onClick) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = text;
      element.dataset.action = action;
      element.addEventListener("click", onClick);
      return element;
    };
    const container = document.createElement("div");
    container.className = "bulk-area";
    const selectMode = button("Select", "select-mode", () => {
      this.setSelectionMode(!this.selectionMode);
      this.bulkBar.selectMode.focus();
    });
    selectMode.className = "bulk-select-mode";
    const toolbar = document.createElement("div");
    toolbar.className = "bulk-toolbar";
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", `Selected ${label} items`);
    const count = document.createElement("p");
    count.className = "bulk-count";
    count.id = `bulk-count-${this.display}`;
    count.setAttribute("role", "status");
    count.setAttribute("aria-live", "polite");
    const actions = document.createElement("div");
    actions.className = "bulk-actions";
    const selectAll = button("Select all", "select-all", () => this.selectAllVisible());
    // Each action submits only the selected items it applies to as shown;
    // <kin-app> re-plans against the projection before writing anything.
    const complete = button("Complete", "bulk-complete", () => this.bulkAction("bulk-item-action", { action: "complete", itemIds: this.selectedWithStatus("active") }));
    const reopen = button("Reopen", "bulk-reopen", () => this.bulkAction("bulk-item-action", { action: "reopen", itemIds: this.selectedWithStatus("completed") }));
    const clear = button("Clear selection", "clear-selection", () => this.clearSelection());
    for (const control of [complete, reopen]) control.setAttribute("aria-describedby", count.id);
    actions.append(selectAll, complete, reopen, clear);
    const progress = document.createElement("p");
    progress.className = "bulk-progress";
    progress.hidden = true;
    toolbar.append(count, actions, progress);
    const result = document.createElement("div");
    result.className = "bulk-result";
    const message = document.createElement("p");
    message.className = "bulk-result-message";
    message.id = `bulk-result-${this.display}`;
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const resultActions = document.createElement("div");
    resultActions.className = "bulk-actions";
    const undo = button("Undo", "bulk-undo", () => this.bulkAction("bulk-undo"));
    const retry = button("Try failed items again", "bulk-retry", () => this.bulkAction("bulk-retry"));
    const dismiss = button("Dismiss", "bulk-dismiss", () => {
      this.setBulkResult(null);
      this.bulkAction("bulk-dismiss");
      this.bulkBar.selectMode.focus();
    });
    // Focus moves to Undo or Retry as the outcome arrives, which can cut off
    // the polite announcement; the focused button then reads it instead.
    for (const control of [undo, retry, dismiss]) control.setAttribute("aria-describedby", message.id);
    resultActions.append(undo, retry, dismiss);
    result.append(message, resultActions);
    container.append(selectMode, toolbar, result);
    this.bulkBar = { container, selectMode, toolbar, count, selectAll, complete, reopen, clear, progress, result, message, undo, retry, dismiss };
    return this.bulkBar;
  }

  // Updates only the bar's text and visibility; rows are left untouched.
  updateBulkBar() {
    const bar = this.bulkBar;
    if (!bar) return;
    // Read focus before any control hides: the browser drops focus from a
    // control the moment it is hidden.
    const controls = [bar.selectMode, bar.selectAll, bar.complete, bar.reopen, bar.clear, bar.undo, bar.retry, bar.dismiss];
    const focused = controls.find((control) => control === document.activeElement || control === this.deferredFocus);
    const records = this.listRecords();
    const selected = records.filter((record) => this.selectedIds.has(record.itemId));
    const open = selected.filter((record) => record.status === "active").length;
    const done = selected.filter((record) => record.status === "completed").length;
    const visible = records.filter((record) => isBulkEligible(record) && (record.status === "active" || this.completedOpen)).length;
    bar.selectMode.hidden = !records.length && !this.selectionMode;
    bar.selectMode.textContent = this.selectionMode ? "Done selecting" : "Select";
    bar.selectMode.setAttribute("aria-pressed", String(this.selectionMode));
    bar.toolbar.hidden = !this.selectionMode;
    const n = selected.length;
    bar.count.textContent = n ? `${n} ${n === 1 ? "item" : "items"} selected` : "No items selected";
    bar.selectAll.hidden = !visible;
    bar.selectAll.setAttribute("aria-label", `Select all ${visible} visible ${visible === 1 ? "item" : "items"}`);
    bar.complete.hidden = !open;
    bar.complete.textContent = `Complete ${open}`;
    bar.complete.setAttribute("aria-label", `Complete ${open} selected ${open === 1 ? "item" : "items"}`);
    bar.reopen.hidden = !done;
    bar.reopen.textContent = `Reopen ${done}`;
    bar.reopen.setAttribute("aria-label", `Reopen ${done} selected ${done === 1 ? "item" : "items"}`);
    bar.clear.hidden = !n;
    const result = this.bulkResult;
    bar.result.hidden = !result;
    bar.result.classList.toggle("bulk-result-error", Boolean(result?.error));
    bar.message.textContent = result?.message ?? "";
    bar.undo.hidden = !result?.canUndo;
    bar.undo.textContent = result?.undoLabel ?? "Undo";
    bar.retry.hidden = !result?.canRetry;
    for (const control of controls) control.disabled = this.isDisabled;
    // A focused control that just hid (Clear selection after clearing, Undo
    // after it ran) hands focus to the nearest control that is still shown.
    if (focused && (focused.hidden || focused.closest("[hidden]"))) {
      const fallback = [bar.selectAll, bar.selectMode].find((control) => !control.hidden && !control.closest("[hidden]"));
      if (fallback?.disabled) this.deferredFocus = fallback;
      else fallback?.focus();
    }
  }

  ensureComposer() {
    if (this.composer) return this.composer;
    const composer = document.createElement("kin-compose");
    composer.setAttribute("scope", this.display);
    composer.setAttribute("fixed-classification", this.display);
    composer.setAttribute("label", `Add to ${CLASSIFICATION_LABELS[this.display] ?? "list"}`);
    this.composer = composer;
    return composer;
  }

  focusInput() { this.composer?.focusInput(); }

  render() {
    if (this.suspended) return;
    const focus = this.pendingFocus ?? this.captureFocus();
    this.pendingFocus = null;
    this.completedOpen = this.querySelector(".completed-disclosure")?.open ?? this.completedOpen;
    const sections = this.display === "today" ? this.renderToday() : this.renderList();
    this.replaceChildren(...sections);
    this.restoreFocus(focus);
  }

  renderList() {
    const config = LISTS[this.display];
    if (!config) return [];
    const section = document.createElement("section");
    section.className = "list-view";
    section.dataset.classification = this.display;
    const heading = document.createElement("h2");
    heading.textContent = config.title;
    heading.tabIndex = -1;
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = config.hint;
    section.append(heading, hint);
    const composer = this.ensureComposer();
    composer.disabled = this.isDisabled;
    section.append(composer);
    const records = this.listRecords();
    if (this.isBulkList) {
      this.selectedIds = reconcileSelection(this.selectedIds, records, config.includes);
      section.append(this.ensureBulkBar().container);
      this.updateBulkBar();
    }
    const active = records.filter((record) => record.status === "active");
    const completed = records.filter((record) => record.status === "completed");
    if (active.length) section.append(this.createList(active));
    if (!records.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = config.empty;
      section.append(empty);
    } else if (!active.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Everything here is done. Completed items are below.";
      section.append(empty);
    }
    if (completed.length) section.append(this.disclosure("completed", `Completed (${completed.length})`, this.createList(completed)));
    return [section];
  }

  renderToday() {
    if (this.civilDate == null) {
      // Before the first local projection there is nothing to compose; say so
      // without implying anything was removed.
      const pending = document.createElement("section");
      pending.className = "today-list today-unavailable";
      pending.dataset.section = "today";
      const heading = document.createElement("h2");
      heading.textContent = "Today";
      heading.tabIndex = -1;
      const note = document.createElement("p");
      note.className = "empty-state";
      note.textContent = "Today's tasks aren't available yet. They appear as soon as Kin finishes opening this household on this device.";
      pending.append(heading, note);
      return [pending];
    }
    const view = composeToday({ items: this.records, routines: this.routineRecords, pins: this.pinRecords, handoffs: this.handoffRecords, mode: this.householdMode, civilDate: this.civilDate });
    const sections = [];
    if (view.hasItems) sections.push(this.createSummary(view.counts));

    // Most time-sensitive first: plans still open from earlier days, today's
    // plans, then later plans. The copy stays calm on purpose (no "overdue").
    if (view.earlier.length) {
      sections.push(this.createAgendaSection("earlier", "Earlier plans", view.earlier, "Still open from earlier. They stay in their lists too."));
    }

    const today = this.createAgendaSection("today", "Today", view.today);
    today.className = "today-list";
    if (!view.today.length) today.append(this.createTodayEmpty(view));
    sections.push(today);

    if (view.hasItems) {
      const upcoming = this.createAgendaSection("upcoming", "Coming up", view.upcoming, view.upcoming.length ? "Planned for the coming days, soonest first." : null);
      if (!view.upcoming.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "Nothing is planned for the coming days.";
        upcoming.append(empty);
      }
      sections.push(upcoming);
    }

    // Keep the shortcut area visible when it's empty so first-time users can
    // discover how pins work instead of having the whole feature disappear.
    sections.push(this.createQuickAccess(view.quickAccess));
    sections.push(this.createRoutines(view));
    if (view.waitingHandoffs) sections.push(this.createUpdatesContext(view.waitingHandoffs));
    if (view.completed.length || view.completedRoutines.length) {
      const body = document.createDocumentFragment();
      if (view.completed.length) body.append(this.createList(view.completed, { kindVisible: true }));
      if (view.completedRoutines.length) body.append(this.createRoutineList(view.completedRoutines, "done"));
      sections.push(this.disclosure("completed", `Completed (${view.completed.length + view.completedRoutines.length})`, body));
    }
    return sections;
  }

  disclosure(kind, summaryText, content) {
    const details = document.createElement("details");
    details.className = `${kind}-disclosure today-disclosure`;
    details.dataset.section = kind;
    details.open = this.completedOpen;
    details.addEventListener("toggle", () => { this.completedOpen = details.open; this.updateBulkBar(); });
    const summary = document.createElement("summary");
    summary.textContent = summaryText;
    details.append(summary, content);
    return details;
  }

  createAgendaSection(kind, title, records, hint = null) {
    const section = document.createElement("section");
    section.className = `today-agenda today-${kind}`;
    section.dataset.section = kind;
    const heading = document.createElement("h2");
    heading.textContent = title;
    heading.tabIndex = -1;
    section.append(heading);
    if (hint) {
      const note = document.createElement("p");
      note.className = "section-hint";
      note.textContent = hint;
      section.append(note);
    }
    if (records.length) section.append(this.createList(records, { kindVisible: true }));
    return section;
  }

  // Item counts (tasks and shopping items) from the same composition that renders the sections below,
  // so they can never drift from what is listed. Each non-zero count is a
  // native button that moves focus to its section; like every other control
  // here it is disabled while a change is saving.
  createSummary(counts) {
    const section = document.createElement("section");
    section.className = "today-summary";
    section.dataset.section = "summary";
    const heading = document.createElement("h2");
    heading.className = "visually-hidden";
    heading.textContent = "Item summary";
    const list = document.createElement("ul");
    list.className = "today-summary-list";
    const entries = [
      ["earlier", counts.earlier, "still open from earlier"],
      ["today", counts.today, "planned for today"],
      ["upcoming", counts.upcoming, "coming up"],
      ["completed", counts.completed, "completed from today's plans"],
    ].filter(([kind, count]) => kind !== "earlier" || count > 0);
    for (const [kind, count, label] of entries) {
      const entry = document.createElement("li");
      entry.dataset.count = kind;
      const content = count > 0 ? document.createElement("button") : document.createElement("span");
      content.className = "today-summary-entry";
      if (count > 0) {
        content.type = "button";
        content.dataset.summary = kind;
        content.disabled = this.isDisabled;
        content.addEventListener("click", () => this.revealSection(kind));
      }
      const number = document.createElement("span");
      number.className = "today-summary-count";
      number.textContent = String(count);
      content.append(number, document.createTextNode(` ${count === 1 ? "item" : "items"} ${label}`));
      entry.append(content);
      list.append(entry);
    }
    section.append(heading, list);
    return section;
  }

  revealSection(kind) {
    const section = this.querySelector(`[data-section="${kind}"]`);
    if (!section) return;
    if (section.tagName === "DETAILS") section.open = true;
    const target = section.tagName === "DETAILS" ? section.querySelector("summary") : section.querySelector("h2");
    target?.scrollIntoView?.({ block: "start" });
    target?.focus({ preventScroll: true });
  }

  createTodayEmpty(view) {
    const empty = document.createElement("div");
    empty.className = "empty-state today-empty";
    const message = document.createElement("p");
    if (view.allDone) {
      message.textContent = "Everything planned for today is done. Completed tasks are listed below.";
      empty.append(message);
      return empty;
    }
    if (!view.hasItems) {
      message.textContent = "No household tasks yet. Add the first thing that needs handling, and plan it for today or another day.";
    } else {
      message.append(document.createTextNode("Nothing planned for today. Browse "));
      const todoLink = document.createElement("a");
      todoLink.href = "#lists/todo";
      todoLink.textContent = "To do";
      const shoppingLink = document.createElement("a");
      shoppingLink.href = "#lists/shopping";
      shoppingLink.textContent = "Shopping";
      message.append(todoLink, document.createTextNode(" or "), shoppingLink, document.createTextNode(" to see what's there."));
    }
    // Reuses the universal Quick add (and its partial-capture recovery); this
    // button only asks <kin-app> to open it from here.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "today-quick-add";
    add.textContent = "Add a task for today";
    add.dataset.action = "open-quick-add";
    add.disabled = this.isDisabled;
    add.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:open-quick-add", { detail: { opener: add }, bubbles: true, composed: true })));
    empty.append(message, add);
    return empty;
  }

  createRoutines(view) {
    const section = document.createElement("section");
    section.className = "today-routines";
    section.dataset.section = "routines";
    const heading = document.createElement("h2");
    heading.textContent = "Routines";
    heading.tabIndex = -1;
    section.append(heading);
    if (view.routinesPaused) {
      const paused = document.createElement("p");
      paused.className = "section-hint";
      paused.textContent = `Routines are paused during ${MODE_LABELS[this.householdMode] ?? "this"} mode. Change the mode under Household › Areas & status.`;
      section.append(paused);
      return section;
    }
    if (!view.hasRoutines) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.append(document.createTextNode("No repeating tasks yet. Choose Repeat in Quick add, or set one up in "));
      const link = document.createElement("a");
      link.href = "#routines";
      link.textContent = "Routines";
      empty.append(link, document.createTextNode("."));
      section.append(empty);
      return section;
    }
    if (!view.routineGroups.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      // Done for now, or nothing due today (an every-weekday task at the weekend).
      empty.textContent = view.completedRoutines.length ? "Every routine for this period is done." : "Nothing repeating is due today.";
      section.append(empty);
      return section;
    }
    for (const group of view.routineGroups) {
      const label = document.createElement("h3");
      label.className = "routine-period";
      label.textContent = group.label;
      section.append(label, this.createRoutineList(group.routines, "open"));
    }
    return section;
  }

  createRoutineList(routines, state) {
    const list = document.createElement("ul");
    list.className = "item-list routine-list";
    for (const routine of routines) {
      const entry = document.createElement("li");
      const row = document.createElement("div");
      row.className = `item-row routine-row item-${state === "done" ? "completed" : "active"}`;
      row.dataset.routineId = routine.routineId;
      const control = document.createElement("div");
      control.className = "item-control";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = `complete-control ${state === "done" ? "reopen-button" : "complete-button"}`;
      toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 12.5 4 4 8-9"/></svg>';
      const period = ROUTINE_PERIOD_LABELS[routine.cadence] ?? "this period";
      toggle.setAttribute("aria-label", `${state === "done" ? "Reopen" : "Complete"} ${routine.text} (${period.toLowerCase()})`);
      toggle.setAttribute("aria-pressed", String(state === "done"));
      toggle.dataset.routineId = routine.routineId;
      toggle.dataset.action = state === "done" ? "reopen-routine-occurrence" : "complete-routine-occurrence";
      toggle.disabled = this.isDisabled;
      toggle.addEventListener("click", () => this.dispatchEvent(new CustomEvent(`kin:${toggle.dataset.action}`, {
        detail: { routineId: routine.routineId, occurrenceKey: routine.occurrenceKey }, bubbles: true, composed: true,
      })));
      control.append(toggle);
      const body = document.createElement("div");
      body.className = "item-body";
      const text = document.createElement("p");
      text.className = "item-text";
      text.textContent = routine.text;
      const meta = document.createElement("p");
      meta.className = "item-meta";
      // Rust supplies the next occurrence; only one row per task, never one
      // per future occurrence.
      const next = describeNextOccurrence(routine.nextOn, this.civilDate);
      meta.textContent = [state === "done" ? `Done ${period.toLowerCase()}` : describeRepeat(routine.cadence), next].filter(Boolean).join(" · ");
      body.append(text, meta);
      const actions = document.createElement("div");
      actions.className = "item-row-actions";
      const schedule = document.createElement("button");
      schedule.type = "button";
      schedule.className = "routine-schedule-button";
      schedule.textContent = "Schedule";
      schedule.setAttribute("aria-label", `Schedule for ${routine.text}`);
      schedule.dataset.routineId = routine.routineId;
      schedule.dataset.action = "open-routine-schedule";
      schedule.disabled = this.isDisabled;
      schedule.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:open-routine-schedule", {
        detail: { routineId: routine.routineId }, bubbles: true, composed: true,
      })));
      actions.append(schedule);
      row.append(control, body, actions);
      entry.append(row);
      list.append(entry);
    }
    return list;
  }

  createUpdatesContext(count) {
    const section = document.createElement("section");
    section.className = "today-updates";
    section.dataset.section = "updates";
    const line = document.createElement("p");
    const link = document.createElement("a");
    link.href = "#updates/handoffs";
    link.className = "today-updates-link";
    link.textContent = count === 1 ? "1 handoff is waiting for a Got it" : `${count} handoffs are waiting for a Got it`;
    line.append(link);
    section.append(line);
    return section;
  }

  createQuickAccess(targets) {
    const section = document.createElement("section");
    section.className = "quick-access";
    section.dataset.section = "quick-access";
    const heading = document.createElement("h2");
    heading.textContent = "Quick access";
    heading.tabIndex = -1;
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Pinned shortcuts. A pin is not a deadline.";
    section.append(heading, hint);
    const list = document.createElement("ul");
    list.className = "item-list quick-access-list";
    if (!targets.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state quick-access-empty";
      empty.textContent = "Pin a task from its details to keep it close.";
      section.append(empty);
    }
    for (const item of targets) {
      const row = document.createElement("li");
      const entry = document.createElement("div");
      entry.className = "quick-access-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "quick-access-open";
      open.textContent = item.text;
      open.setAttribute("aria-label", `Open ${item.text}`);
      open.dataset.itemId = item.itemId;
      open.dataset.itemAction = "open-pin";
      open.disabled = this.isDisabled;
      open.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:open-pin", { detail: { itemId: item.itemId, opener: open }, bubbles: true, composed: true })));
      const unpin = document.createElement("button");
      unpin.type = "button";
      unpin.textContent = "Unpin";
      unpin.setAttribute("aria-label", `Unpin ${item.text}`);
      unpin.dataset.itemId = item.itemId;
      unpin.dataset.itemAction = "unpin";
      unpin.disabled = this.isDisabled;
      unpin.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:pin-intent", {
        detail: { targetKind: "item", targetId: item.itemId, pinned: false }, bubbles: true, composed: true,
      })));
      entry.append(open, unpin);
      row.append(entry);
      list.append(row);
    }
    if (targets.length) section.append(list);
    return section;
  }

  captureFocus() {
    const control = this.contains(document.activeElement) ? document.activeElement : this.deferredFocus?.isConnected ? this.deferredFocus : null;
    if (!this.contains(control)) return null;
    const row = control.closest("kin-item");
    const section = control.closest("[data-section]");
    return {
      control,
      itemId: control.dataset.itemId ?? control.dataset.routineId,
      action: control.dataset.itemAction ?? control.dataset.action,
      summary: control.dataset.summary,
      index: row ? [...this.querySelectorAll("kin-item")].indexOf(row) : -1,
      section: section?.dataset.section ?? null,
      sectionIndex: row && section ? [...section.querySelectorAll("kin-item")].indexOf(row) : -1,
    };
  }

  // When a row leaves its Today section (an earlier or later plan that was
  // completed), keep the person where they were: the row that took its place,
  // else the previous one, else the section heading.
  sectionFallback(focus) {
    if (!focus.section || focus.sectionIndex < 0) return null;
    const section = this.querySelector(`[data-section="${focus.section}"]`);
    if (!section) return this.querySelector('[data-section="today"] h2');
    const rows = [...section.querySelectorAll("kin-item")];
    const row = rows[Math.min(focus.sectionIndex, rows.length - 1)];
    return row?.querySelector(".complete-control, .item-open") ?? section.querySelector("h2");
  }

  rememberFocus() { this.pendingFocus = this.captureFocus(); }

  restoreFocus(focus) {
    if (!focus) return;
    const reveal = (node) => { for (const details of ancestors(node, this)) if (!details.open) details.open = true; };
    if (focus.control.isConnected && !focus.control.closest("[hidden]")) {
      reveal(focus.control);
      focus.control.focus();
      return;
    }
    if (focus.summary) {
      const summary = this.querySelector(`[data-summary="${focus.summary}"]`);
      if (summary?.disabled) this.deferredFocus = summary;
      else (summary ?? this.querySelector('[data-section="today"] h2'))?.focus();
      return;
    }
    const controls = [...this.querySelectorAll("[data-item-id], [data-routine-id]")].filter((control) => !control.closest("[hidden]") && control.matches("button, input, select"));
    const sameItem = controls.filter((control) => (control.dataset.itemId ?? control.dataset.routineId) === focus.itemId);
    const replacementAction = {
      complete: "reopen",
      reopen: "complete",
      "complete-routine-occurrence": "reopen-routine-occurrence",
      "reopen-routine-occurrence": "complete-routine-occurrence",
      pin: "unpin",
      unpin: "pin",
    }[focus.action];
    const target = sameItem.find((control) => (control.dataset.itemAction ?? control.dataset.action) === focus.action)
      ?? (replacementAction ? sameItem.find((control) => (control.dataset.itemAction ?? control.dataset.action) === replacementAction) : null)
      ?? sameItem.find((control) => control.dataset.itemAction === "details")
      ?? sameItem[0]
      ?? this.sectionFallback(focus)
      ?? controls[Math.min(Math.max(0, focus.index), controls.length - 1)];
    const next = target ?? this.querySelector("h2");
    if (!next) return;
    reveal(next);
    if (next.disabled) this.deferredFocus = next;
    else next.focus();
  }

  // Focus a row's Details control by canonical id (used when details close).
  focusItem(itemId, { preventScroll = false } = {}) {
    const target = [...this.querySelectorAll(".item-details-button")].find((node) => node.dataset.itemId === itemId)
      ?? [...this.querySelectorAll(".item-open")].find((node) => node.dataset.itemId === itemId);
    if (!target) return false;
    for (const details of ancestors(target, this)) if (!details.open) details.open = true;
    if (!preventScroll) target.scrollIntoView?.({ block: "nearest" });
    target.focus({ preventScroll });
    return true;
  }

  createList(records, { kindVisible = false } = {}) {
    const list = document.createElement("ul");
    list.className = "item-list";
    for (const record of records) {
      const listItem = document.createElement("li");
      const item = document.createElement("kin-item");
      item.previews = this.previewProvider;
      item.today = this.civilDate;
      item.kindVisible = kindVisible;
      item.item = record;
      item.attachments = this.attachmentRecords;
      item.responsibilityContext = this.ownerContext;
      item.areaOptions = this.areaRecords;
      item.pinned = this.pinRecords.some((pin) => pin.targetKind === "item" && pin.targetId === record.itemId);
      item.selected = this.selectedItemId === record.itemId;
      if (this.selectionMode) {
        item.checked = this.selectedIds.has(record.itemId);
        item.selectable = true;
      }
      item.disabled = this.isDisabled;
      listItem.append(item);
      list.append(listItem);
    }
    return list;
  }
}

function* ancestors(node, root) {
  let current = node?.parentElement;
  while (current && current !== root) {
    if (current.tagName === "DETAILS") yield current;
    current = current.parentElement;
  }
}

customElements.define("kin-today", KinToday);
