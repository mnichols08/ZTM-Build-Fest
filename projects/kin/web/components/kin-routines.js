
import {
  MAX_PLAYBOOK_ENTRIES,
  validatePlaybook,
} from "../household-validation.js";
import "./kin-responsibility.js";

class KinRoutines extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.playbookRecords = [];
    this.editingPlaybookId = null;
    this.isDisabled = false;
    this.householdMode = "normal";
    this.instanceId = `routines-${++KinRoutines.instances}`;
  }

  connectedCallback() {
    if (this.input) return;
    const section = document.createElement("section");
    section.className = "today-section";
    const heading = document.createElement("h2");
    heading.textContent = "Routines";
    const hint = document.createElement("p");
    this.hint = hint;
    const form = document.createElement("form");
    form.className = "compose-form routine-form";
    const label = document.createElement("label");
    label.htmlFor = "routine-text";
    label.textContent = "What needs doing regularly?";
    this.input = document.createElement("input");
    this.input.id = "routine-text";
    this.input.required = true;
    this.input.maxLength = 4096;
    this.input.autocomplete = "off";
    const cadenceLabel = document.createElement("label");
    cadenceLabel.htmlFor = "routine-cadence";
    cadenceLabel.textContent = "Repeat";
    this.cadence = document.createElement("select");
    this.cadence.id = "routine-cadence";
    for (const [value, text] of [
      ["daily", "Daily"],
      ["weekly", "Weekly"],
      ["biweekly", "Every two weeks"],
      ["monthly", "Monthly"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.cadence.append(option);
    }
    this.button = document.createElement("button");
    this.button.type = "submit";
    this.button.className = "add-button";
    this.button.textContent = "Add routine";
    this.message = document.createElement("p");
    this.message.id = "routine-message";
    this.message.setAttribute("role", "alert");
    this.input.setAttribute("aria-describedby", this.message.id);
    this.input.addEventListener("input", () => this.saveDraft());
    this.cadence.addEventListener("change", () => this.saveDraft());
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (this.isDisabled) return;
      const text = this.input.value;
      if (!text.trim() || new TextEncoder().encode(text).length > 4096) {
        this.message.textContent = "Add a few words, up to 4096 UTF-8 bytes.";
        this.focusInput();
        return;
      }
      this.message.textContent = "";
      this.dispatch("create-routine", { text, cadence: this.cadence.value });
    });
    form.append(label, this.input, cadenceLabel, this.cadence, this.button, this.message);
    const playbooks = document.createElement("section");
    playbooks.className = "playbook-section";
    const playbookHeading = document.createElement("h3"); playbookHeading.textContent = "Household playbooks";
    const playbookHint = document.createElement("p"); playbookHint.textContent = "Save a reusable checklist. Using one creates an ordinary checklist you can edit independently.";
    const playbookForm = document.createElement("form"); playbookForm.className = "compose-form"; playbookForm.noValidate = true;
    const playbookTitleId = `${this.instanceId}-playbook-title`;
    const playbookTitleLabel = document.createElement("label"); playbookTitleLabel.htmlFor = playbookTitleId; playbookTitleLabel.textContent = "Playbook name";
    this.playbookTitle = document.createElement("input"); this.playbookTitle.id = playbookTitleId; this.playbookTitle.placeholder = "Playbook name";
    this.playbookTitleError = document.createElement("small"); this.playbookTitleError.id = `${this.instanceId}-playbook-title-error`; this.playbookTitleError.setAttribute("role", "alert"); this.playbookTitleError.hidden = true; this.playbookTitle.setAttribute("aria-describedby", this.playbookTitleError.id);
    const playbookEntriesId = `${this.instanceId}-playbook-entries`;
    const playbookEntriesLabel = document.createElement("label"); playbookEntriesLabel.htmlFor = playbookEntriesId; playbookEntriesLabel.textContent = "Checklist steps (one per line)";
    this.playbookEntries = document.createElement("textarea"); this.playbookEntries.id = playbookEntriesId; this.playbookEntries.rows = 4; this.playbookEntries.placeholder = "One checklist step per line";
    this.playbookCountError = document.createElement("small"); this.playbookCountError.id = `${this.instanceId}-playbook-count-error`; this.playbookCountError.setAttribute("role", "alert"); this.playbookCountError.hidden = true;
    this.playbookEntryErrors = document.createElement("div"); this.playbookEntryErrors.className = "field-errors";
    this.playbookEntries.setAttribute("aria-describedby", this.playbookCountError.id);
    this.playbookSave = document.createElement("button"); this.playbookSave.type = "submit"; this.playbookSave.className = "add-button"; this.playbookSave.textContent = "Save playbook";
    playbookForm.addEventListener("submit", event => {
      event.preventDefault();
      if (this.isDisabled) return;
      const entries = this.playbookEntries.value.split(/\r?\n/);
      const result = validatePlaybook(this.playbookTitle.value, entries);
      this.showValidationError(this.playbookTitle, this.playbookTitleError, result.errors.title);
      this.showValidationError(this.playbookEntries, this.playbookCountError, result.errors.count);
      this.playbookEntryErrors.replaceChildren();
      const entryErrorIds = [];
      result.errors.entries.forEach((message, index) => {
        if (!message) return;
        const error = document.createElement("small");
        error.id = `${this.instanceId}-playbook-entry-error-${index}`;
        error.setAttribute("role", "alert");
        error.textContent = `Step ${index + 1}: ${message}`;
        entryErrorIds.push(error.id);
        this.playbookEntryErrors.append(error);
      });
      this.playbookEntries.setAttribute("aria-describedby", [this.playbookCountError.id, ...entryErrorIds].join(" "));
      if (entryErrorIds.length && !this.playbookEntries.hasAttribute("aria-invalid")) this.playbookEntries.setAttribute("aria-invalid", "true");
      if (!entryErrorIds.length && !result.errors.count) this.playbookEntries.removeAttribute("aria-invalid");
      if (!result.valid) {
        (result.errors.title ? this.playbookTitle : this.playbookEntries).focus();
        return;
      }
      this.dispatch("save-playbook", { playbookId: this.editingPlaybookId, title: result.title, entries: result.entries });
    });
    playbookForm.append(playbookTitleLabel, this.playbookTitle, this.playbookTitleError, playbookEntriesLabel, this.playbookEntries, this.playbookCountError, this.playbookEntryErrors, this.playbookSave);
    this.playbookList = document.createElement("ul"); this.playbookList.className = "item-list";
    playbooks.append(playbookHeading, playbookHint, playbookForm, this.playbookList);
    this.list = document.createElement("ul");
    this.list.className = "item-list";
    this.empty = document.createElement("p");
    this.empty.className = "empty-state";
    this.empty.textContent = "No routines yet. Add a small household rhythm.";
    section.append(heading, hint, form, this.empty, this.list, playbooks);
    this.append(section);
    this.render();
    this.disabled = this.isDisabled;
  }

  set routines(value) { this.records = value; this.render(); }
  set responsibilityContext(value) { this.responsibilities = value?.responsibilities ?? []; this.memberId = value?.memberId ?? null; this.memberIds = value?.memberIds ?? []; this.render(); }
  set playbooks(value) { this.playbookRecords = value ?? []; this.renderPlaybooks(); }
  set householdMode(value) {
    this.mode = value;
    this.render();
  }
  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, textarea, select, button")) control.disabled = this.isDisabled;
  }
  focusInput() { this.input.focus(); }
  saveDraft() {
    // Keep drafts only in the unlocked input.
  }
  clearIfMatches({ text, cadence }) {
    if (this.input.value !== text || this.cadence.value !== cadence) return;
    this.input.value = "";
    this.saveDraft();
  }
  clearPlaybookEditor() { this.editingPlaybookId = null; this.playbookTitle.value = ""; this.playbookEntries.value = ""; this.playbookSave.textContent = "Save playbook"; }
  showValidationError(control, messageNode, message) {
    messageNode.textContent = message;
    messageNode.hidden = !message;
    if (message) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  }
  dispatch(action, detail) {
    if (!this.isDisabled) this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }
  captureFocus() {
    const control = document.activeElement;
    return this.contains(control) ? { control, id: control.dataset.routineId, action: control.dataset.action } : null;
  }
  restoreFocus(focus) {
    if (!focus) return;
    if (focus.control.isConnected) { focus.control.focus(); return; }
    const sameRow = [...this.querySelectorAll("button[data-routine-id]")].filter(button => button.dataset.routineId === focus.id);
    (sameRow.find(button => button.dataset.action === focus.action) ?? sameRow[0] ?? this.input).focus();
  }
  render() {
    if (!this.list) return;
    const focus = this.captureFocus();
    this.list.replaceChildren();
    const modeLabels = { normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" };
    this.hint.textContent = this.mode === "normal"
      ? "Daily, weekly (Monday-start), every two weeks from creation, or by calendar month."
      : `Routine occurrences are paused during ${modeLabels[this.mode] ?? "this mode"}. Definitions stay unchanged.`;
    const visible = this.records.filter(record => record.status !== "archived");
    this.empty.hidden = visible.length !== 0;
    for (const record of visible) {
      const row = document.createElement("li");
      row.className = "item-row routine-row";
      const content = document.createElement("div");
      const text = document.createElement("p");
      text.className = "item-text";
      text.textContent = record.text;
      const status = document.createElement("p");
      status.className = "routine-status";
      const labels = {
        daily: ["Daily", "today"],
        weekly: ["Weekly", "this week"],
        biweekly: ["Every two weeks", "this two-week period"],
        monthly: ["Monthly", "this month"],
      };
      const [cadenceLabel, period] = labels[record.cadence];
      status.textContent = `${cadenceLabel} · ${this.mode !== "normal" ? `Paused during ${modeLabels[this.mode] ?? "this mode"}` : record.occurrenceStatus === "unavailable" ? "Not available for the current date" : record.occurrenceStatus === "completed" ? `Done ${period}` : `Open ${period}`}`;
      content.append(text, status);
      const responsibility = document.createElement("kin-responsibility");
      responsibility.record = { targetKind: "routine", targetId: record.routineId, text: record.text, ownerId: this.responsibilities?.find((entry) => entry.targetKind === "routine" && entry.targetId === record.routineId)?.memberId ?? null, memberId: this.memberId, memberIds: this.memberIds };
      content.append(responsibility);
      const actions = document.createElement("div");
      actions.className = "item-action";
      const remind = document.createElement("button");
      remind.type = "button"; remind.textContent = "Routine reminder"; remind.disabled = this.isDisabled;
      remind.setAttribute("aria-label", `Set a reminder for ${record.text}`);
      remind.addEventListener("click", () => {
        const value = window.prompt("When should Kin remind you? Enter a local date and time, such as 2026-10-10T09:00");
        if (!value) return;
        this.dispatch("set-local-reminder", { id: `routine:${record.routineId}`, title: record.text, at: new Date(value).getTime() });
      });
      const cancelReminder = document.createElement("button"); cancelReminder.type = "button"; cancelReminder.textContent = "Cancel reminder"; cancelReminder.disabled = this.isDisabled;
      cancelReminder.setAttribute("aria-label", `Cancel reminder for ${record.text}`);
      cancelReminder.addEventListener("click", () => this.dispatch("cancel-local-reminder", { id: `routine:${record.routineId}` }));
      actions.append(remind, cancelReminder);
      const addAction = (label, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = action === "archive-routine" ? "archive-button" : "complete-button";
        button.setAttribute("aria-label", `${label} ${record.text}${action === "archive-routine" ? "" : ` ${period}`}`);
        button.dataset.routineId = record.routineId;
        button.dataset.action = action;
        button.disabled = this.isDisabled;
        button.addEventListener("click", () => this.dispatch(action, { routineId: record.routineId, ...(action === "archive-routine" ? {} : { occurrenceKey: record.occurrenceKey }) }));
        actions.append(button);
      };
      if (this.mode === "normal" && record.occurrenceStatus !== "unavailable") addAction(record.occurrenceStatus === "completed" ? "Reopen" : "Complete", record.occurrenceStatus === "completed" ? "reopen-routine-occurrence" : "complete-routine-occurrence");
      addAction("Archive", "archive-routine");
      row.append(content, actions);
      this.list.append(row);
    }
    this.restoreFocus(focus);
    this.renderPlaybooks();
  }
  renderPlaybooks() {
    if (!this.playbookList) return;
    this.playbookList.replaceChildren();
    for (const record of this.playbookRecords.filter(value => !value.archived)) {
      const row = document.createElement("li"); row.className = "item-row";
      const content = document.createElement("div"); const title = document.createElement("p"); title.className = "item-text"; title.textContent = record.title;
      const entries = document.createElement("ol"); for (const text of record.entries) { const item = document.createElement("li"); item.textContent = text; entries.append(item); }
      content.append(title, entries);
      const actions = document.createElement("div"); actions.className = "item-action";
      const add = (label, action, callback) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = this.isDisabled; button.dataset.playbookId = record.playbookId; button.dataset.action = action; button.addEventListener("click", callback); actions.append(button); };
      add("Use checklist", "instantiate", () => this.dispatch("instantiate-playbook", { playbookId: record.playbookId }));
      add("Edit", "edit", () => { this.editingPlaybookId = record.playbookId; this.playbookTitle.value = record.title; this.playbookEntries.value = record.entries.join("\n"); this.playbookSave.textContent = "Save changes"; this.playbookTitle.focus(); });
      add("Archive", "archive", () => this.dispatch("archive-playbook", { playbookId: record.playbookId }));
      row.append(content, actions); this.playbookList.append(row);
    }
  }
}
KinRoutines.instances = 0;
customElements.define("kin-routines", KinRoutines);
