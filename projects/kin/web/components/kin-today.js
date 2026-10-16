import "./kin-compose.js";
import "./kin-item.js";
import "./kin-bulk-bar.js";
import { CLASSIFICATION_LABELS } from "./kin-compose.js";
import { reconcileSelection } from "../bulk-actions.js";
import { asArray, asFunction, defineProps } from "./shared/props.js";
import { TodayFocus } from "./today/focus.js";
import { TodaySections } from "./today/sections.js";
import { TodaySelection } from "./today/selection.js";

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

// The list element's parts (./today/), built once per element with one shared
// context { host, ...parts }; each part reaches the element as `this.host`.
const PARTS = {
  sections: TodaySections,
  selection: TodaySelection,
  focus: TodayFocus,
};

class KinToday extends HTMLElement {
  constructor() {
    super();
    this.ctx = { host: this };
    for (const [key, Part] of Object.entries(PARTS)) this.ctx[key] = new Part(this.ctx);
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
    // Focus bookkeeping (today/focus.js explains both).
    this.pendingFocus = null;
    this.deferredFocus = null;
    this.bulkResult = null;
    this.bulkBar = null;
    this.onItemSelection = (event) => {
      if (!this.selectionMode) return;
      event.stopPropagation();
      const { itemId, checked } = event.detail ?? {};
      if (checked) this.selectedIds.add(itemId);
      else this.selectedIds.delete(itemId);
      this.ctx.selection.updateBulkBar();
    };
  }

  connectedCallback() {
    this.addEventListener("kin:item-selection", this.onItemSelection);
    this.render();
  }

  disconnectedCallback() { this.removeEventListener("kin:item-selection", this.onItemSelection); }

  // Assigns several inputs and renders at most once, now. Inputs identical to
  // the current ones (the projection reuses unchanged sections) render
  // nothing; a focus a command remembered for that render still lands. The
  // keys are the properties defined with defineProps below the class.
  update(props) {
    for (const [key, value] of Object.entries(props)) this[key] = value;
    if (!this.flushRender()) this.ctx.focus.settleFocus();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const item of this.querySelectorAll("kin-item")) item.disabled = this.isDisabled;
    if (this.composer) this.composer.disabled = this.isDisabled;
    if (this.bulkBar) this.bulkBar.disabled = this.isDisabled;
    for (const control of this.querySelectorAll("button, input, select")) {
      if (control.closest("kin-compose, kin-item, kin-bulk-bar")) continue;
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
    if (!this.isDisabled) this.settleDeferredFocus();
  }

  settleDeferredFocus() {
    if (this.deferredFocus?.isConnected) {
      const target = this.deferredFocus;
      this.deferredFocus = null;
      if (!target.matches(":disabled")) target.focus();
    }
    this.bulkBar?.settleDeferredFocus?.();
  }

  get quickAdd() { return Object.hasOwn(LISTS, this.display); }

  // The list's heading ("To do", "Shopping", "Staples"), or "list" for Today.
  get listTitle() { return LISTS[this.display]?.title ?? "list"; }

  // Lists whose Items complete and reopen; Staples and Today do not select.
  get isBulkList() { return this.display === "need" || this.display === "shopping"; }

  get selectedItemIds() { return [...this.selectedIds]; }

  listRecords() {
    const config = LISTS[this.display];
    return config ? this.records.filter((record) => config.includes(record) && record.status !== "archived") : [];
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
    const focus = this.pendingFocus ?? this.captureFocus();
    this.pendingFocus = null;
    this.completedOpen = this.querySelector(".completed-disclosure")?.open ?? this.completedOpen;
    const sections = this.display === "today" ? this.ctx.sections.renderToday() : this.renderList();
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
      section.append(this.ctx.selection.ensureBulkBar());
      this.ctx.selection.updateBulkBar();
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

  disclosure(kind, summaryText, content) {
    const details = document.createElement("details");
    details.className = `${kind}-disclosure today-disclosure`;
    details.dataset.section = kind;
    details.open = this.completedOpen;
    details.addEventListener("toggle", () => { this.completedOpen = details.open; this.ctx.selection.updateBulkBar(); });
    const summary = document.createElement("summary");
    summary.textContent = summaryText;
    details.append(summary, content);
    return details;
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

  // Called from outside the element (regression scripts, <kin-app>);
  // each delegates to its part.
  setSelectionMode(...args) { return this.ctx.selection.setSelectionMode(...args); }
  clearSelection(...args) { return this.ctx.selection.clearSelection(...args); }
  deselect(...args) { return this.ctx.selection.deselect(...args); }
  setBulkResult(...args) { return this.ctx.selection.setBulkResult(...args); }
  setBulkProgress(...args) { return this.ctx.selection.setBulkProgress(...args); }
  focusBulkResult(...args) { return this.ctx.selection.focusBulkResult(...args); }
  bulkAction(...args) { return this.ctx.selection.bulkAction(...args); }
  captureFocus(...args) { return this.ctx.focus.captureFocus(...args); }
  restoreFocus(...args) { return this.ctx.focus.restoreFocus(...args); }
  rememberFocus(...args) { return this.ctx.focus.rememberFocus(...args); }
  focusItem(...args) { return this.ctx.focus.focusItem(...args); }
}

// The list's inputs. Each assignment stores the coerced value and schedules
// one microtask render; an identical value does nothing (shared/props.js).
// update() above assigns several and renders at once.
const NO_CONTEXT = Object.freeze({});
defineProps(KinToday, {
  items: { field: "records", coerce: asArray },
  areas: { field: "areaRecords", coerce: asArray },
  pins: { field: "pinRecords", coerce: asArray },
  attachments: { field: "attachmentRecords", coerce: asArray },
  routines: { field: "routineRecords", coerce: asArray },
  handoffs: { field: "handoffRecords", coerce: asArray },
  mode: { field: "householdMode", coerce: (value) => value ?? "normal" },
  today: { field: "civilDate", coerce: (value) => (Number.isSafeInteger(value) ? value : null) },
  selected: { field: "selectedItemId", coerce: (value) => value ?? null },
  previews: { field: "previewProvider", coerce: asFunction },
  responsibilityContext: { field: "ownerContext", coerce: (value) => value ?? NO_CONTEXT },
});

customElements.define("kin-today", KinToday);
