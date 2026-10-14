import "./kin-compose.js";
import "./kin-item.js";
import { composeToday, ROUTINE_PERIOD_LABELS } from "../today-view.js";
import { CLASSIFICATION_LABELS } from "./kin-compose.js";

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
    this.earlierOpen = false;
  }

  connectedCallback() { this.render(); }

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
    const open = { completed: this.querySelector(".completed-disclosure")?.open ?? this.completedOpen, earlier: this.querySelector(".earlier-disclosure")?.open ?? this.earlierOpen };
    this.completedOpen = open.completed;
    this.earlierOpen = open.earlier;
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
    const records = this.records.filter((record) => config.includes(record) && record.status !== "archived");
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
    if (this.civilDate == null) return [];
    const view = composeToday({ items: this.records, routines: this.routineRecords, pins: this.pinRecords, handoffs: this.handoffRecords, mode: this.householdMode, civilDate: this.civilDate });
    const sections = [];
    // Keep the shortcut area visible when it's empty so first-time users can
    // discover how pins work instead of having the whole feature disappear.
    sections.push(this.createQuickAccess(view.quickAccess));

    const today = document.createElement("section");
    today.className = "today-list";
    today.dataset.section = "today";
    const heading = document.createElement("h2");
    heading.textContent = "Today";
    heading.tabIndex = -1;
    today.append(heading);
    if (view.today.length) today.append(this.createList(view.today, { kindVisible: true }));
    else {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.append(document.createTextNode(view.isEmpty
        ? "Nothing planned for today. Start with "
        : "Nothing planned for today. Browse "));
      const todoLink = document.createElement("a");
      todoLink.href = "#lists/todo";
      todoLink.textContent = "To do";
      const separator = document.createTextNode(" or ");
      const shoppingLink = document.createElement("a");
      shoppingLink.href = "#lists/shopping";
      shoppingLink.textContent = "Shopping";
      empty.append(todoLink, separator, shoppingLink, document.createTextNode(" to see what's there."));
      today.append(empty);
    }
    sections.push(today);

    sections.push(this.createRoutines(view));
    if (view.waitingHandoffs) sections.push(this.createUpdatesContext(view.waitingHandoffs));
    if (view.earlier.length) {
      const earlier = this.disclosure("earlier", `Earlier plans (${view.earlier.length})`, this.createList(view.earlier, { kindVisible: true }), "Still open from earlier. They stay in their lists too.");
      sections.push(earlier);
    }
    if (view.completed.length || view.completedRoutines.length) {
      const body = document.createDocumentFragment();
      if (view.completed.length) body.append(this.createList(view.completed, { kindVisible: true }));
      if (view.completedRoutines.length) body.append(this.createRoutineList(view.completedRoutines, "done"));
      sections.push(this.disclosure("completed", `Completed (${view.completed.length + view.completedRoutines.length})`, body));
    }
    return sections;
  }

  disclosure(kind, summaryText, content, hint = null) {
    const details = document.createElement("details");
    details.className = `${kind}-disclosure today-disclosure`;
    details.dataset.section = kind;
    details.open = kind === "completed" ? this.completedOpen : this.earlierOpen;
    details.addEventListener("toggle", () => { if (kind === "completed") this.completedOpen = details.open; else this.earlierOpen = details.open; });
    const summary = document.createElement("summary");
    summary.textContent = summaryText;
    details.append(summary);
    if (hint) {
      const note = document.createElement("p");
      note.className = "section-hint";
      note.textContent = hint;
      details.append(note);
    }
    details.append(content);
    return details;
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
      empty.append(document.createTextNode("No routines yet. Set up a small household rhythm in "));
      const link = document.createElement("a");
      link.href = "#routines";
      link.textContent = "Routines";
      empty.append(link, document.createTextNode(" when one would help."));
      section.append(empty);
      return section;
    }
    if (!view.routineGroups.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Every routine for this period is done.";
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
      meta.textContent = `Routine · ${state === "done" ? `Done ${period.toLowerCase()}` : period}`;
      body.append(text, meta);
      row.append(control, body);
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
    return {
      control,
      itemId: control.dataset.itemId ?? control.dataset.routineId,
      action: control.dataset.itemAction ?? control.dataset.action,
      index: row ? [...this.querySelectorAll("kin-item")].indexOf(row) : -1,
    };
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
