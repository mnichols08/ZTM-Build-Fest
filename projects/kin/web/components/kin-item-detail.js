import { localCivilDateOffset } from "../browser-time.js";
import { describePlanningDate, KIND_LABELS } from "../today-view.js";
import "./kin-attachments.js";
import "./kin-reminder.js";
import "./kin-responsibility.js";
import { button } from "./shared/dom.js";

// The one shared detail view for an item. <kin-app> owns a single instance
// and re-homes it between the mobile sheet, the inline column and the side
// column, so there is never a second copy of these editors. It renders from
// the canonical record it is given and re-applies in-progress drafts (an
// unsent step, reminder inputs) across background refreshes.

const STEP_RULE = "Keep each step short: up to 80 characters, no line breaks.";

class KinItemDetail extends HTMLElement {
  constructor() {
    super();
    this.record = null;
    this.requestedId = null;
    this.isDisabled = false;
    this.isPinned = false;
    this.pinLimitReached = false;
    this.attachmentRecords = [];
    this.previewProvider = null;
    this.areas = [];
    this.civilDate = null;
    this.reminderRecord = null;
    this.presentation = "side";
    this.backLabel = "Close";
    this.stepDraft = "";
    this.stepDrafts = new Map();
    this.reminderDrafts = new Map();
    this.detailFeedbacks = new Map();
    this.highlightStepId = null;
    this.addEventListener("kin:reminder-draft-cleared", (event) => {
      const itemId = event.detail?.id?.startsWith("item:") ? event.detail.id.slice(5) : null;
      if (itemId) this.reminderDrafts.delete(itemId);
    });
  }

  set item(value) { this.record = value ?? null; this.render(); }
  set itemId(value) {
    const previousId = this.record?.itemId ?? this.requestedId;
    if (previousId && this.stepInput) this.stepDrafts.set(previousId, this.stepInput.value);
    if (previousId && this.reminderControl?.editing) this.reminderDrafts.set(previousId, this.reminderControl.getDraftState());
    this.requestedId = value ?? null;
    if (value == null) {
      this.record = null; this.requestedId = null; this.highlightStepId = null;
      this.stepInput = null; this.reminderControl = null;
    } else if (value !== previousId) {
      this.record = null;
      this.stepInput = null;
      this.reminderControl = null;
    }
    if (value != null) this.stepDraft = this.stepDrafts.get(value) ?? "";
  }
  // Assigns several inputs and renders once; setters stay for single changes.
  update(props) {
    this.suspended = true;
    try { for (const [key, value] of Object.entries(props)) this[key] = value; }
    finally { this.suspended = false; }
    this.render();
  }
  get itemId() { return this.record?.itemId ?? this.requestedId; }
  set areaOptions(value) { this.areas = Array.isArray(value) ? value : []; this.render(); }
  set pinned(value) { this.isPinned = Boolean(value); this.render(); }
  set attachments(value) { this.attachmentRecords = Array.isArray(value) ? value : []; this.render(); }
  set previews(provider) { this.previewProvider = typeof provider === "function" ? provider : null; this.render(); }
  set responsibilityContext(value) { this.responsibilities = value?.responsibilities ?? []; this.memberId = value?.memberId ?? null; this.memberIds = value?.memberIds ?? []; this.render(); }
  set today(value) { this.civilDate = Number.isSafeInteger(value) ? value : null; this.render(); }
  set reminder(value) { this.reminderRecord = value?.at ? { at: value.at } : null; if (this.reminderControl) this.reminderControl.reminder = this.reminderRecord; }
  set mode(value) { this.presentation = value; this.render(); }
  set closeLabel(value) { this.backLabel = value || "Close"; this.render(); }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input, select")) {
      if (control.closest("kin-reminder")) continue;
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
    if (this.reminderControl) this.reminderControl.disabled = this.isDisabled;
    // A control that could not take focus while the app was busy takes it now.
    if (!this.isDisabled && this.deferredFocusId) {
      const target = [...this.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === this.deferredFocusId);
      this.deferredFocusId = null;
      if (target && !target.disabled && !this.contains(document.activeElement)) target.focus();
    }
  }

  get hasDraft() {
    return [...this.stepDrafts.values()].some((value) => value.trim()) || this.reminderDrafts.size > 0 || this.detailFeedbacks.size > 0 || Boolean(this.reminderControl?.hasDraft);
  }

  connectedCallback() { this.render(); }

  focusHeading() { this.querySelector(".item-detail-title")?.focus(); }
  focusClose() { this.querySelector(".item-detail-close")?.focus(); }

  // Search results for a checklist step open the parent with that step exposed.
  revealStep(stepId) {
    this.highlightStepId = stepId;
    this.render();
    const checkbox = this.querySelector(`[data-step-id="${stepId}"][type="checkbox"]`);
    checkbox?.scrollIntoView?.({ block: "center" });
    checkbox?.focus();
  }

  captureDrafts() {
    this.captureStepDraft();
    return { step: this.stepDrafts.get(this.itemId) ?? "", focusId: this.contains(document.activeElement) ? document.activeElement.dataset.focusId ?? null : null };
  }

  captureStepDraft() {
    const id = this.record?.itemId ?? this.requestedId;
    if (id && this.stepInput) this.stepDrafts.set(id, this.stepInput.value);
  }

  clearStepDraft(itemId, submitted) {
    if (this.stepDrafts.get(itemId) === submitted) this.stepDrafts.delete(itemId);
    if (this.itemId === itemId && this.stepInput?.value === submitted) {
      this.stepInput.value = "";
      this.stepDraft = "";
    }
  }

  setFeedback(itemId, feedback) { this.detailFeedbacks.set(itemId, feedback); }
  clearFeedback(itemId) { this.detailFeedbacks.delete(itemId); }

  render() {
    if (this.suspended) return;
    const drafts = this.captureDrafts();
    this.stepDraft = drafts.step;
    const section = document.createElement("section");
    section.className = `item-detail item-detail-${this.presentation}`;
    section.setAttribute("aria-labelledby", "item-detail-title");
    const header = document.createElement("div");
    header.className = "item-detail-bar";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "item-detail-close";
    close.textContent = this.backLabel;
    close.dataset.focusId = "close";
    close.setAttribute("aria-label", this.backLabel === "Close" ? "Close details" : this.backLabel);
    close.addEventListener("click", () => this.dispatch("close-item-detail", {}));
    header.append(close);
    section.append(header);

    const title = document.createElement("h2");
    title.id = "item-detail-title";
    title.className = "item-detail-title";
    title.tabIndex = -1;
    const record = this.record;
    if (!record || record.status === "archived") {
      title.textContent = record ? record.text : "This item isn't available";
      const explain = document.createElement("p");
      explain.className = "item-detail-note";
      explain.textContent = record
        ? "This item was archived. Its history stays in the household record, and nothing else here can be changed."
        : "It may have been archived or removed on another device, or it is no longer in this household's records.";
      section.append(title, explain);
      if (record?.lastChangedAt) section.append(this.lastChanged(record));
      this.replaceChildren(section);
      this.stepInput = null;
      this.reminderControl = null;
      return;
    }

    title.textContent = record.text;
    const kind = document.createElement("p");
    kind.className = "item-detail-kind";
    const planned = this.civilDate != null ? describePlanningDate(record.planningDate, this.civilDate) : null;
    kind.textContent = [KIND_LABELS[record.classification] ?? "Item", record.status === "completed" ? "Completed" : "Open", planned].filter(Boolean).join(" · ");
    section.append(title, kind);
    const detailFeedback = this.detailFeedbacks.get(record.itemId);
    if (detailFeedback) {
      const feedback = document.createElement("div");
      feedback.className = "item-detail-feedback";
      const message = document.createElement("p");
      message.className = "error-message";
      message.setAttribute("role", "alert");
      message.textContent = detailFeedback.message;
      feedback.append(message);
      if (typeof detailFeedback.retry === "function") {
        const retry = this.button("Try again", detailFeedback.retry, "retry-button");
        retry.dataset.detailRetry = "true";
        feedback.append(retry);
      }
      section.append(feedback);
    }

    const primary = document.createElement("div");
    primary.className = "item-detail-primary";
    if (record.classification === "staple") {
      const replenish = this.button("Add to Shopping", () => this.dispatch("replenish-staple", { itemId: record.itemId }), "primary-action replenish-button");
      replenish.setAttribute("aria-label", `Add ${record.text} to Shopping`);
      replenish.dataset.itemAction = "replenish";
      replenish.dataset.focusId = "primary";
      primary.append(replenish);
    } else {
      const completed = record.status === "completed";
      const action = this.button(completed ? "Reopen" : "Mark complete", () => this.dispatch(`${completed ? "reopen" : "complete"}-item`, { itemId: record.itemId }), completed ? "reopen-button" : "primary-action complete-button");
      action.setAttribute("aria-label", `${completed ? "Reopen" : "Complete"} ${record.text}`);
      action.dataset.itemAction = completed ? "reopen" : "complete";
      action.dataset.focusId = "primary";
      primary.append(action);
    }
    section.append(primary);

    if (record.classification !== "staple") section.append(this.createChecklist(record, drafts));
    section.append(this.createAttachments(record));
    section.append(this.createPlanning(record));
    section.append(this.createResponsibility(record));
    section.append(this.createArea(record));
    section.append(this.createReminder(record));
    section.append(this.createQuickAccess(record));
    section.append(this.createArchive(record));
    this.replaceChildren(section);
    this.disabled = this.isDisabled;
    if (drafts.focusId) {
      const target = [...this.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === drafts.focusId);
      if (target && !target.disabled) target.focus();
      else if (target) this.deferredFocusId = drafts.focusId;
    }
  }

  group(titleText, hint = null) {
    const group = document.createElement("section");
    group.className = "item-detail-group";
    const heading = document.createElement("h3");
    heading.textContent = titleText;
    group.append(heading);
    if (hint) {
      const note = document.createElement("p");
      note.className = "item-detail-note";
      note.textContent = hint;
      group.append(note);
    }
    return group;
  }

  createChecklist(record, drafts) {
    const steps = Array.isArray(record.steps) ? record.steps : [];
    const live = steps.filter((step) => !step.archived);
    const done = live.filter((step) => step.completed).length;
    const group = this.group("Checklist", live.length ? `${done} of ${live.length} steps done.` : null);
    group.id = `checklist-${record.itemId}`;
    const list = document.createElement("ul");
    list.className = "step-list";
    for (const step of live) {
      const entry = document.createElement("li");
      entry.className = `step-row${this.highlightStepId === step.stepId ? " step-row-highlight" : ""}`;
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = step.completed;
      checkbox.id = `step-${record.itemId}-${step.stepId}`;
      checkbox.dataset.itemId = record.itemId;
      checkbox.dataset.stepId = step.stepId;
      checkbox.dataset.itemAction = "toggle-step";
      checkbox.dataset.focusId = `step-${step.stepId}`;
      checkbox.dataset.domainDisabled = String(record.status !== "active");
      checkbox.disabled = this.isDisabled || record.status !== "active";
      checkbox.addEventListener("change", () => this.dispatch(`${checkbox.checked ? "complete" : "reopen"}-item-step`, { itemId: record.itemId, stepId: step.stepId }));
      const text = document.createElement("span");
      text.textContent = step.text;
      label.htmlFor = checkbox.id;
      label.append(checkbox, text);
      const archive = this.button("Archive step", () => this.dispatch("archive-item-step", { itemId: record.itemId, stepId: step.stepId }), "step-archive-button");
      archive.setAttribute("aria-label", `Archive step ${step.text}`);
      archive.dataset.itemId = record.itemId;
      archive.dataset.stepId = step.stepId;
      archive.dataset.itemAction = "archive-item-step";
      archive.dataset.domainDisabled = String(record.status !== "active");
      archive.disabled = this.isDisabled || record.status !== "active";
      entry.append(label, archive);
      list.append(entry);
    }
    if (live.length) group.append(list);
    if (record.status !== "active") {
      const hint = document.createElement("p");
      hint.className = "step-parent-hint";
      hint.textContent = "Reopen this item before changing its steps.";
      group.append(hint);
    }
    const form = document.createElement("form");
    form.className = "step-compose";
    form.noValidate = true;
    const inputId = `add-step-${record.itemId}`;
    const label = document.createElement("label");
    label.htmlFor = inputId;
    label.textContent = live.length ? "Add another step" : "Add a step";
    const input = document.createElement("input");
    input.type = "text";
    input.id = inputId;
    input.required = true;
    input.autocomplete = "off";
    input.value = drafts.step ?? this.stepDrafts.get(record.itemId) ?? "";
    input.dataset.itemId = record.itemId;
    input.dataset.itemAction = "add-step";
    input.dataset.focusId = "add-step";
    input.dataset.domainDisabled = String(record.status !== "active" || steps.length >= 16);
    input.disabled = this.isDisabled || input.dataset.domainDisabled === "true";
    const message = document.createElement("p");
    message.className = "compose-message";
    message.id = `${inputId}-message`;
    message.setAttribute("aria-live", "polite");
    input.setAttribute("aria-describedby", message.id);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add step";
    submit.disabled = input.disabled;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const textValue = input.value.trim();
      const invalid = !textValue || [...textValue].length > 80 || new TextEncoder().encode(textValue).length > 256 || [...textValue].some((character) => /\p{Cc}/u.test(character));
      message.textContent = invalid ? (textValue ? STEP_RULE : "Type a step first.") : "";
      if (invalid) { input.focus(); return; }
      this.dispatch("add-item-step", { itemId: record.itemId, text: textValue });
    });
    form.append(label, input, submit, message);
    this.stepInput = input;
    group.append(form);
    return group;
  }

  createAttachments(record) {
    const group = this.group("Photos & files", "Photos and PDFs are encrypted with the rest of the household record.");
    const tiles = document.createElement("kin-attachments");
    tiles.mode = "full";
    tiles.previews = this.previewProvider;
    tiles.parentRecord = { kind: "item", id: record.itemId, label: record.text, readonly: record.status === "archived" };
    tiles.attachments = this.attachmentRecords;
    group.append(tiles);
    return group;
  }

  createPlanning(record) {
    const group = this.group("Planned date", "Optional. A date puts the item on Today when the day comes.");
    const editor = document.createElement("div");
    editor.className = "item-planning-date";
    const label = document.createElement("label");
    label.className = "item-planning-date-field";
    label.textContent = "Date";
    const input = document.createElement("input");
    input.type = "date";
    input.className = "item-planning-date-input";
    input.setAttribute("aria-label", `Planned date for ${record.text}`);
    input.dataset.itemId = record.itemId;
    input.dataset.focusId = "planning-date";
    input.value = record.planningDate ? formatPlanningDate(record.planningDate) : "";
    input.addEventListener("change", () => this.dispatchPlanningDate(input.value ? Number(input.value.replaceAll("-", "")) : null));
    label.append(input);
    editor.append(label);
    for (const [labelText, offset] of [["Today", 0], ["Tomorrow", 1]]) {
      const shortcut = this.button(labelText, () => this.dispatchPlanningDate(localCivilDateOffset(offset)), "item-planning-date-shortcut");
      shortcut.setAttribute("aria-label", `Plan ${record.text} for ${labelText.toLowerCase()}`);
      shortcut.dataset.itemId = record.itemId;
      editor.append(shortcut);
    }
    if (record.planningDate) {
      const clear = this.button("Clear", () => this.dispatchPlanningDate(null), "item-planning-date-shortcut");
      clear.setAttribute("aria-label", `Clear planned date for ${record.text}`);
      clear.dataset.itemId = record.itemId;
      editor.append(clear);
    }
    group.append(editor);
    return group;
  }

  createResponsibility(record) {
    const group = this.group("Responsibility");
    const responsibility = document.createElement("kin-responsibility");
    responsibility.record = { targetKind: "item", targetId: record.itemId, text: record.text, ownerId: this.responsibilities?.find((entry) => entry.targetKind === "item" && entry.targetId === record.itemId)?.memberId ?? null, memberId: this.memberId, memberIds: this.memberIds };
    group.append(responsibility);
    return group;
  }

  createArea(record) {
    const group = this.group("Area");
    const label = document.createElement("label");
    label.className = "item-area-label";
    label.append(document.createTextNode("Area"));
    const select = document.createElement("select");
    select.className = "item-area-select";
    select.setAttribute("aria-label", `Area for ${record.text}`);
    select.dataset.itemId = record.itemId;
    select.dataset.focusId = "area";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No area";
    select.append(none);
    for (const area of this.areas) {
      if (area.archived && area.areaId !== record.areaId) continue;
      const option = document.createElement("option");
      option.value = area.areaId;
      const duplicates = this.areas.filter((candidate) => candidate.name.toLowerCase() === area.name.toLowerCase());
      option.textContent = `${area.name}${duplicates.length > 1 ? ` · ${area.areaId.slice(-4)}` : ""}${area.archived ? " (archived)" : ""}`;
      select.append(option);
    }
    select.value = record.areaId ?? "";
    select.addEventListener("change", () => this.dispatch("change-item-area", { itemId: record.itemId, areaId: select.value || null }));
    label.append(select);
    group.append(label);
    return group;
  }

  createReminder(record) {
    const group = this.group("Reminder on this device");
    // The control is kept across re-renders of the same item so an open
    // reminder editor (and its typed date/time) survives a background refresh.
    const id = `item:${record.itemId}`;
    const reminder = this.reminderControl?.targetRecord?.id === id ? this.reminderControl : document.createElement("kin-reminder");
    reminder.target = { id, title: record.text };
    if (this.reminderDrafts.has(record.itemId)) reminder.restoreDraftState(this.reminderDrafts.get(record.itemId));
    reminder.reminder = this.reminderRecord;
    if (reminder.hasDraft) this.reminderDrafts.set(record.itemId, reminder.getDraftState());
    reminder.disabled = this.isDisabled || record.status !== "active";
    this.reminderControl = reminder;
    group.append(reminder);
    return group;
  }

  createQuickAccess(record) {
    const group = this.group("Quick access", "Pinned items appear at the top of Today. A pin is a shortcut, not a deadline.");
    const pin = this.button(this.isPinned ? "Unpin" : "Pin to Today", () => this.dispatch("pin-intent", { targetKind: "item", targetId: record.itemId, pinned: !this.isPinned }), "pin-button");
    pin.setAttribute("aria-pressed", String(this.isPinned));
    pin.setAttribute("aria-label", `${this.isPinned ? "Unpin" : "Pin"} ${record.text}${!this.isPinned && this.pinLimitReached ? "; pin limit reached" : ""}`);
    pin.dataset.itemId = record.itemId;
    pin.dataset.itemAction = this.isPinned ? "unpin" : "pin";
    pin.dataset.focusId = "pin";
    pin.dataset.domainDisabled = String(!this.isPinned && this.pinLimitReached);
    pin.disabled = this.isDisabled || pin.dataset.domainDisabled === "true";
    group.append(pin);
    return group;
  }

  createArchive(record) {
    const group = this.group("History");
    group.append(this.lastChanged(record));
    const archive = this.button("Archive", () => this.dispatch("archive-item", { itemId: record.itemId }), "archive-button");
    archive.setAttribute("aria-label", `Archive ${record.text}`);
    archive.dataset.itemId = record.itemId;
    archive.dataset.itemAction = "archive";
    archive.dataset.focusId = "archive";
    const note = document.createElement("p");
    note.className = "item-detail-note";
    note.textContent = "Archiving keeps the record in household history but removes it from every list.";
    group.append(archive, note);
    return group;
  }

  lastChanged(record) {
    const line = document.createElement("p");
    line.className = "item-last-changed";
    if (Number.isSafeInteger(record.lastChangedAt) && Number.isFinite(new Date(record.lastChangedAt).getTime())) {
      line.textContent = `Last changed ${new Date(record.lastChangedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
    } else line.textContent = "";
    return line;
  }

  button(label, action, className = "") { return button(label, action, { className, disabled: this.isDisabled }); }

  dispatchPlanningDate(planningDate) {
    if (this.record.planningDate === planningDate) return;
    this.dispatch("set-item-planning-date", { itemId: this.record.itemId, planningDate });
  }

  dispatch(action, detail) {
    this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }
}

export function formatPlanningDate(value) {
  const year = Math.floor(value / 10000).toString().padStart(4, "0");
  const month = (Math.floor(value / 100) % 100).toString().padStart(2, "0");
  const day = (value % 100).toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

customElements.define("kin-item-detail", KinItemDetail);
