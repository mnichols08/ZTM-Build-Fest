import { validatePlaybook } from "../household-validation.js";
import { ROUTINE_PERIOD_LABELS } from "../today-view.js";
import { REPEAT_HINTS, REPEAT_OPTIONS, describeNextOccurrence, describeRepeat } from "../recurrence.js";
import "./kin-reminder.js";
import "./kin-responsibility.js";
import { captureFocus, restoreFocus } from "./shared/focus.js";

// Routines page. Existing routines are the main content; creation sits behind
// an Add routine control. Reusable checklists (canonically "playbooks":
// save-playbook / archive-playbook / instantiate-playbook) have their own
// view with a separate editor. Reminders use the in-app <kin-reminder>.

const MODE_LABELS = { normal: "Normal", vacation: "Vacation", guests: "Guests", rest: "Rest" };
const CADENCE_LABELS = { daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", biweekly: "Every two weeks", monthly: "Monthly" };

class KinRoutines extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.playbookRecords = [];
    this.reminderMap = new Map();
    this.editingPlaybookId = null;
    this.isDisabled = false;
    this.mode = "normal";
    this.currentView = "all";
    this.createOpen = false;
    this.editorOpen = false;
    this.instanceId = `routines-${++KinRoutines.instances}`;
    this.reminderControls = new Map();
    this.civilDate = null;
    // Which row's schedule editor is open, and its unsaved choice, survive
    // the re-render a background refresh causes.
    this.scheduleOpenId = null;
    this.scheduleDrafts = new Map();
  }

  connectedCallback() {
    if (this.input) return;
    // --- Routines view ---
    const routinesView = document.createElement("section");
    routinesView.className = "routines-view";
    routinesView.dataset.view = "all";
    const heading = document.createElement("h2");
    heading.textContent = "Routines";
    heading.tabIndex = -1;
    this.heading = heading;
    this.hint = document.createElement("p");
    this.hint.className = "section-hint";
    const toolbar = document.createElement("div");
    toolbar.className = "view-toolbar";
    this.addButton = document.createElement("button");
    this.addButton.type = "button";
    this.addButton.className = "primary-action";
    this.addButton.textContent = "Add routine";
    this.addButton.setAttribute("aria-expanded", "false");
    this.addButton.setAttribute("aria-controls", `${this.instanceId}-create`);
    this.addButton.addEventListener("click", () => { if (this.createOpen) this.closeCreate(); else this.openCreate(); });
    toolbar.append(this.addButton);

    const form = document.createElement("form");
    form.className = "compose-form routine-form";
    form.id = `${this.instanceId}-create`;
    form.hidden = true;
    form.noValidate = true;
    this.form = form;
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
    for (const [value, text] of Object.entries(CADENCE_LABELS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      this.cadence.append(option);
    }
    const cadenceHint = document.createElement("p");
    cadenceHint.className = "section-hint";
    cadenceHint.textContent = "Weekdays skips Saturday and Sunday. Weekly starts on Monday. Every two weeks counts from the day you add it. Monthly follows the calendar month, so one added on the 31st still repeats in shorter months.";
    this.button = document.createElement("button");
    this.button.type = "submit";
    this.button.className = "add-button";
    this.button.textContent = "Save routine";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { this.closeCreate(); this.addButton.focus(); });
    this.message = document.createElement("p");
    this.message.id = "routine-message";
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    this.input.setAttribute("aria-describedby", this.message.id);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.isDisabled) return;
      const text = this.input.value;
      if (!text.trim()) { this.message.textContent = "Add a few words first."; this.focusInput(); return; }
      if (new TextEncoder().encode(text).length > 4096) { this.message.textContent = "That's too long for one routine. Shorten it to roughly 4,000 characters or fewer."; this.focusInput(); return; }
      this.message.textContent = "";
      this.dispatch("create-routine", { text, cadence: this.cadence.value });
    });
    const actions = document.createElement("div");
    actions.className = "form-actions";
    actions.append(this.button, cancel);
    form.append(label, this.input, cadenceLabel, this.cadence, cadenceHint, actions, this.message);

    this.list = document.createElement("ul");
    this.list.className = "item-list routine-list";
    this.empty = document.createElement("p");
    this.empty.className = "empty-state";
    this.empty.textContent = "No routines yet. Add a small household rhythm when one would help.";
    routinesView.append(heading, this.hint, toolbar, form, this.empty, this.list);

    // --- Reusable checklists view ---
    const checklistsView = document.createElement("section");
    checklistsView.className = "playbook-section";
    checklistsView.dataset.view = "checklists";
    const playbookHeading = document.createElement("h2");
    playbookHeading.textContent = "Reusable checklists";
    playbookHeading.tabIndex = -1;
    this.playbookHeading = playbookHeading;
    const playbookHint = document.createElement("p");
    playbookHint.className = "section-hint";
    playbookHint.textContent = "Save a checklist you use again and again. Using one creates an ordinary To do item with its steps, which you can edit independently.";
    const playbookToolbar = document.createElement("div");
    playbookToolbar.className = "view-toolbar";
    this.newPlaybookButton = document.createElement("button");
    this.newPlaybookButton.type = "button";
    this.newPlaybookButton.className = "primary-action";
    this.newPlaybookButton.textContent = "New reusable checklist";
    this.newPlaybookButton.setAttribute("aria-expanded", "false");
    this.newPlaybookButton.setAttribute("aria-controls", `${this.instanceId}-playbook-editor`);
    this.newPlaybookButton.addEventListener("click", () => { if (this.editorOpen && !this.editingPlaybookId) this.closePlaybookEditor(); else { this.clearPlaybookEditor(); this.openPlaybookEditor(); } });
    playbookToolbar.append(this.newPlaybookButton);
    const playbookForm = document.createElement("form");
    playbookForm.className = "compose-form playbook-form";
    playbookForm.id = `${this.instanceId}-playbook-editor`;
    playbookForm.noValidate = true;
    playbookForm.hidden = true;
    this.playbookForm = playbookForm;
    const playbookTitleId = `${this.instanceId}-playbook-title`;
    const playbookTitleLabel = document.createElement("label"); playbookTitleLabel.htmlFor = playbookTitleId; playbookTitleLabel.textContent = "Checklist name";
    this.playbookTitle = document.createElement("input"); this.playbookTitle.id = playbookTitleId; this.playbookTitle.placeholder = "For example: Leaving for a trip";
    this.playbookTitleError = document.createElement("small"); this.playbookTitleError.id = `${this.instanceId}-playbook-title-error`; this.playbookTitleError.setAttribute("role", "alert"); this.playbookTitleError.hidden = true; this.playbookTitle.setAttribute("aria-describedby", this.playbookTitleError.id);
    const playbookEntriesId = `${this.instanceId}-playbook-entries`;
    const playbookEntriesLabel = document.createElement("label"); playbookEntriesLabel.htmlFor = playbookEntriesId; playbookEntriesLabel.textContent = "Steps (one per line)";
    this.playbookEntries = document.createElement("textarea"); this.playbookEntries.id = playbookEntriesId; this.playbookEntries.rows = 4; this.playbookEntries.placeholder = "One step per line";
    this.playbookCountError = document.createElement("small"); this.playbookCountError.id = `${this.instanceId}-playbook-count-error`; this.playbookCountError.setAttribute("role", "alert"); this.playbookCountError.hidden = true;
    this.playbookEntryErrors = document.createElement("div"); this.playbookEntryErrors.className = "field-errors";
    this.playbookEntries.setAttribute("aria-describedby", this.playbookCountError.id);
    this.playbookSave = document.createElement("button"); this.playbookSave.type = "submit"; this.playbookSave.className = "add-button"; this.playbookSave.textContent = "Save checklist";
    const playbookCancel = document.createElement("button"); playbookCancel.type = "button"; playbookCancel.textContent = "Cancel";
    playbookCancel.addEventListener("click", () => { this.clearPlaybookEditor(); this.closePlaybookEditor(); this.newPlaybookButton.focus(); });
    playbookForm.addEventListener("submit", (event) => {
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
      if (!result.valid) { (result.errors.title ? this.playbookTitle : this.playbookEntries).focus(); return; }
      this.dispatch("save-playbook", { playbookId: this.editingPlaybookId, title: result.title, entries: result.entries });
    });
    const playbookActions = document.createElement("div");
    playbookActions.className = "form-actions";
    playbookActions.append(this.playbookSave, playbookCancel);
    playbookForm.append(playbookTitleLabel, this.playbookTitle, this.playbookTitleError, playbookEntriesLabel, this.playbookEntries, this.playbookCountError, this.playbookEntryErrors, playbookActions);
    this.playbookList = document.createElement("ul"); this.playbookList.className = "item-list playbook-list";
    this.playbookEmpty = document.createElement("p"); this.playbookEmpty.className = "empty-state"; this.playbookEmpty.textContent = "No reusable checklists yet.";
    checklistsView.append(playbookHeading, playbookHint, playbookToolbar, playbookForm, this.playbookEmpty, this.playbookList);

    this.routinesView = routinesView;
    this.checklistsView = checklistsView;
    this.append(routinesView, checklistsView);
    this.render();
    this.disabled = this.isDisabled;
    this.applyView();
  }

  set routines(value) { this.records = Array.isArray(value) ? value : []; this.render(); }
  set today(value) { this.civilDate = Number.isSafeInteger(value) ? value : null; }
  set responsibilityContext(value) { this.responsibilities = value?.responsibilities ?? []; this.memberId = value?.memberId ?? null; this.memberIds = value?.memberIds ?? []; this.render(); }
  set playbooks(value) { this.playbookRecords = value ?? []; this.renderPlaybooks(); }
  set householdMode(value) { this.mode = value; this.render(); }
  set reminders(value) {
    this.reminderMap = value instanceof Map ? value : new Map();
    for (const [id, control] of this.reminderControls) control.reminder = this.reminderMap.get(id) ?? null;
  }
  set view(value) { this.currentView = value === "checklists" ? "checklists" : "all"; this.applyView(); }
  get view() { return this.currentView; }
  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, textarea, select, button")) {
      if (control.closest("kin-reminder")) continue;
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
    for (const control of this.reminderControls.values()) control.disabled = this.isDisabled;
  }
  get hasDraft() {
    return Boolean(this.input?.value.trim() || this.playbookTitle?.value.trim() || this.playbookEntries?.value.trim()) || this.scheduleDrafts.size > 0 ||
      [...this.reminderControls.values()].some((control) => control.hasDraft);
  }

  applyView() {
    if (!this.routinesView) return;
    this.routinesView.hidden = this.currentView !== "all";
    this.checklistsView.hidden = this.currentView !== "checklists";
  }

  openCreate() {
    this.createOpen = true;
    this.form.hidden = false;
    this.addButton.setAttribute("aria-expanded", "true");
    this.addButton.textContent = "Close";
    this.input.focus();
  }
  closeCreate() {
    this.createOpen = false;
    this.form.hidden = true;
    this.message.textContent = "";
    this.addButton.setAttribute("aria-expanded", "false");
    this.addButton.textContent = "Add routine";
  }
  // After a save the form stays open for another routine; otherwise the Add
  // control is the sensible focus target.
  focusInput() { if (this.createOpen) this.input.focus(); else this.addButton.focus(); }
  // Opens one row's schedule editor (from Today's Schedule button) and moves
  // focus into it. Returns false when the task is gone or stopped.
  openSchedule(routineId) {
    if (!this.records.some((record) => record.routineId === routineId && record.status !== "archived")) return false;
    this.scheduleOpenId = routineId;
    this.render();
    const row = this.rowFor(routineId);
    row?.scrollIntoView?.({ block: "nearest" });
    row?.querySelector(".routine-schedule select")?.focus();
    return true;
  }
  closeSchedule(routineId) {
    if (this.scheduleOpenId === routineId) this.scheduleOpenId = null;
    this.scheduleDrafts.delete(routineId);
  }
  rowFor(routineId) { return [...(this.list?.children ?? [])].find((row) => row.dataset.routineId === routineId) ?? null; }
  focusRoutine(routineId) {
    const row = this.rowFor(routineId);
    (row?.querySelector("button[data-routine-id], summary") ?? (this.createOpen ? this.input : this.addButton)).focus();
  }
  focusHeading() { (this.currentView === "checklists" ? this.playbookHeading : this.heading)?.focus(); }
  saveDraft() { /* Drafts stay only in the unlocked inputs. */ }
  clearIfMatches({ text, cadence }) {
    if (this.input.value !== text || this.cadence.value !== cadence) return;
    this.input.value = "";
  }
  openPlaybookEditor() {
    this.editorOpen = true;
    this.playbookForm.hidden = false;
    this.newPlaybookButton.setAttribute("aria-expanded", "true");
    this.playbookTitle.focus();
  }
  closePlaybookEditor() {
    this.editorOpen = false;
    this.playbookForm.hidden = true;
    this.newPlaybookButton.setAttribute("aria-expanded", "false");
  }
  clearPlaybookEditor() {
    this.editingPlaybookId = null;
    this.playbookTitle.value = "";
    this.playbookEntries.value = "";
    this.playbookSave.textContent = "Save checklist";
    this.showValidationError(this.playbookTitle, this.playbookTitleError, "");
    this.showValidationError(this.playbookEntries, this.playbookCountError, "");
    this.playbookEntryErrors.replaceChildren();
    if (this.editorOpen) this.closePlaybookEditor();
  }
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
    return captureFocus(this, {
      describe: (control) => ({ id: control.dataset.routineId ?? control.closest("[data-routine-id]")?.dataset.routineId, action: control.dataset.action }),
    });
  }
  restoreFocus(focus) {
    // A completed row swaps Complete for Reopen (and back); buttons inside a
    // closed Schedule editor cannot take focus.
    restoreFocus(focus, {
      find: ({ id, action }) => {
        const counterpart = { "complete-routine-occurrence": "reopen-routine-occurrence", "reopen-routine-occurrence": "complete-routine-occurrence" }[action];
        const sameRow = [...this.querySelectorAll("button[data-routine-id]")].filter((button) => button.dataset.routineId === id && !button.closest("details:not([open])"));
        return sameRow.find((button) => button.dataset.action === action) ?? sameRow.find((button) => button.dataset.action === counterpart) ?? sameRow[0] ?? (this.createOpen ? this.input : this.addButton);
      },
    });
  }
  render() {
    if (!this.list) return;
    const focus = this.captureFocus();
    this.list.replaceChildren();
    this.hint.textContent = this.mode === "normal"
      ? "Repeating tasks, without streaks or pressure. Complete the current one when it's done; skipping one is fine. Add one here or with Repeat in Quick add."
      : `Routine occurrences are paused during ${MODE_LABELS[this.mode] ?? "this"} mode. Definitions stay unchanged. Change the mode under Household › Areas & status.`;
    const visible = this.records.filter((record) => record.status !== "archived");
    this.empty.hidden = visible.length !== 0;
    if (this.scheduleOpenId && !visible.some((record) => record.routineId === this.scheduleOpenId)) this.scheduleOpenId = null;
    for (const id of [...this.scheduleDrafts.keys()]) if (!visible.some((record) => record.routineId === id)) this.scheduleDrafts.delete(id);
    const keep = new Set();
    for (const record of visible) {
      const row = document.createElement("li");
      row.className = "item-row routine-row";
      row.dataset.routineId = record.routineId;
      const content = document.createElement("div");
      content.className = "item-body";
      const text = document.createElement("p");
      text.className = "item-text";
      text.textContent = record.text;
      const status = document.createElement("p");
      status.className = "routine-status item-meta";
      const period = ROUTINE_PERIOD_LABELS[record.cadence] ?? "this period";
      const next = this.mode === "normal" ? describeNextOccurrence(record.nextOn, this.civilDate) : null;
      status.textContent = [CADENCE_LABELS[record.cadence] ?? record.cadence, this.mode !== "normal"
        ? `Paused during ${MODE_LABELS[this.mode] ?? "this mode"}`
        : record.occurrenceStatus === "unavailable"
          ? record.cadence === "weekdays" ? "Nothing due at the weekend" : "Not available for the current date"
          : record.occurrenceStatus === "completed" ? `Done ${period.toLowerCase()}` : `Open ${period.toLowerCase()}`, next].filter(Boolean).join(" · ");
      content.append(text, status);
      const responsibility = document.createElement("kin-responsibility");
      responsibility.record = { targetKind: "routine", targetId: record.routineId, text: record.text, ownerId: this.responsibilities?.find((entry) => entry.targetKind === "routine" && entry.targetId === record.routineId)?.memberId ?? null, memberId: this.memberId, memberIds: this.memberIds };
      content.append(responsibility);
      const reminderId = `routine:${record.routineId}`;
      const reminder = this.reminderControls.get(reminderId) ?? document.createElement("kin-reminder");
      reminder.target = { id: reminderId, title: record.text };
      reminder.reminder = this.reminderMap.get(reminderId) ?? null;
      reminder.disabled = this.isDisabled;
      this.reminderControls.set(reminderId, reminder);
      keep.add(reminderId);
      content.append(reminder);
      const actions = document.createElement("div");
      actions.className = "item-action";
      const addAction = (label, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.className = action === "archive-routine" ? "archive-button" : "complete-button";
        button.setAttribute("aria-label", `${label} ${record.text}${action === "archive-routine" ? "" : ` ${period.toLowerCase()}`}`);
        button.dataset.routineId = record.routineId;
        button.dataset.action = action;
        button.disabled = this.isDisabled;
        button.addEventListener("click", () => this.dispatch(action, { routineId: record.routineId, ...(action === "archive-routine" ? {} : { occurrenceKey: record.occurrenceKey }) }));
        actions.append(button);
      };
      if (this.mode === "normal" && record.occurrenceStatus !== "unavailable") addAction(record.occurrenceStatus === "completed" ? "Reopen" : "Complete", record.occurrenceStatus === "completed" ? "reopen-routine-occurrence" : "complete-routine-occurrence");
      addAction("Stop repeating", "archive-routine");
      content.append(this.createScheduleEditor(record));
      row.append(content, actions);
      this.list.append(row);
    }
    for (const id of [...this.reminderControls.keys()]) if (!keep.has(id)) this.reminderControls.delete(id);
    this.restoreFocus(focus);
    this.renderPlaybooks();
  }
  // The minimal recurrence editor. Rust has no schedule-change event and
  // history is never rewritten, so a change explicitly starts a new schedule
  // today and stops this one; stopping keeps every past completion.
  createScheduleEditor(record) {
    const id = `${this.instanceId}-schedule-${record.routineId}`;
    const details = document.createElement("details");
    details.className = "routine-schedule";
    details.open = this.scheduleOpenId === record.routineId;
    const summary = document.createElement("summary");
    summary.textContent = "Schedule";
    summary.setAttribute("aria-label", `Schedule for ${record.text}`);
    details.append(summary);
    details.addEventListener("toggle", () => {
      if (details.open) this.scheduleOpenId = record.routineId;
      else if (this.scheduleOpenId === record.routineId) this.scheduleOpenId = null;
    });
    const form = document.createElement("form");
    form.className = "routine-schedule-form";
    form.noValidate = true;
    const current = document.createElement("p");
    const next = describeNextOccurrence(record.nextOn, this.civilDate);
    current.textContent = `${describeRepeat(record.cadence)}.${next && this.mode === "normal" ? ` ${next}.` : ""}`;
    const label = document.createElement("label");
    label.htmlFor = `${id}-cadence`;
    label.textContent = "Repeat";
    const select = document.createElement("select");
    select.id = `${id}-cadence`;
    select.dataset.routineId = record.routineId;
    for (const { value, label: text } of REPEAT_OPTIONS.slice(1)) select.append(new Option(text, value));
    select.value = this.scheduleDrafts.get(record.routineId) ?? record.cadence;
    const scope = document.createElement("p");
    scope.id = `${id}-scope`;
    select.setAttribute("aria-describedby", scope.id);
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "add-button";
    save.textContent = "Change schedule";
    save.dataset.routineId = record.routineId;
    save.dataset.action = "change-routine-schedule";
    const describeScope = () => {
      const changed = select.value !== record.cadence;
      save.dataset.domainDisabled = String(!changed);
      save.disabled = this.isDisabled || !changed;
      scope.textContent = changed
        ? `${REPEAT_HINTS[select.value]} The new schedule starts today. Past completions stay with the current schedule, and ${record.occurrenceStatus === "completed" ? "this period's done mark" : "the open occurrence"} does not carry over.`
        : "Choose a different schedule to change it, or use Stop repeating to end it. Past completions are always kept.";
    };
    select.addEventListener("change", () => {
      if (select.value === record.cadence) this.scheduleDrafts.delete(record.routineId);
      else this.scheduleDrafts.set(record.routineId, select.value);
      describeScope();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.isDisabled || select.value === record.cadence) return;
      this.dispatch("change-routine-schedule", { routineId: record.routineId, cadence: select.value });
    });
    const buttons = document.createElement("div");
    buttons.className = "routine-schedule-actions";
    buttons.append(save);
    form.append(current, label, select, scope, buttons);
    details.append(form);
    select.disabled = this.isDisabled;
    describeScope();
    return details;
  }
  renderPlaybooks() {
    if (!this.playbookList) return;
    this.playbookList.replaceChildren();
    const visible = this.playbookRecords.filter((value) => !value.archived);
    this.playbookEmpty.hidden = visible.length !== 0;
    for (const record of visible) {
      const row = document.createElement("li"); row.className = "item-row playbook-row"; row.dataset.playbookId = record.playbookId;
      const content = document.createElement("div"); content.className = "item-body";
      const title = document.createElement("p"); title.className = "item-text"; title.textContent = record.title;
      const entries = document.createElement("ol"); entries.className = "playbook-steps"; for (const text of record.entries) { const item = document.createElement("li"); item.textContent = text; entries.append(item); }
      content.append(title, entries);
      const actions = document.createElement("div"); actions.className = "item-action";
      const add = (label, action, callback) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("aria-label", `${label}: ${record.title}`); button.disabled = this.isDisabled; button.dataset.playbookId = record.playbookId; button.dataset.action = action; button.addEventListener("click", callback); actions.append(button); };
      add("Use checklist", "instantiate", () => this.dispatch("instantiate-playbook", { playbookId: record.playbookId }));
      add("Edit", "edit", () => { this.editingPlaybookId = record.playbookId; this.playbookTitle.value = record.title; this.playbookEntries.value = record.entries.join("\n"); this.playbookSave.textContent = "Save changes"; this.openPlaybookEditor(); });
      add("Archive", "archive", () => this.dispatch("archive-playbook", { playbookId: record.playbookId }));
      row.append(content, actions); this.playbookList.append(row);
    }
  }
}
KinRoutines.instances = 0;
customElements.define("kin-routines", KinRoutines);
