import { describeReminderTime, localDateValue, localTimeValue, reminderShortcut, resolveReminderTime } from "../reminder-time.js";

// In-app replacement for the window.prompt reminder entry. Labelled date and
// time inputs, shortcuts that only fill those inputs, a readable confirmation
// of the resolved local time, validation, and Set/Cancel. Dispatches the
// existing kin:set-local-reminder / kin:cancel-local-reminder intents; the
// browser-local LocalReminders model is unchanged.

const DEVICE_NOTE = "On this device only, while Kin is open in this browser.";

class KinReminder extends HTMLElement {
  constructor() {
    super();
    this.targetRecord = null;
    this.current = null;
    this.isDisabled = false;
    this.editing = false;
    this.draft = { date: "", time: "" };
    this.error = "";
    this.instanceId = `reminder-${++KinReminder.instances}`;
  }

  set target(value) { this.targetRecord = value ?? null; this.render(); }
  set reminder(value) { this.current = value?.at ? { at: value.at } : null; this.render(); }
  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input")) control.disabled = this.isDisabled;
  }
  get hasDraft() { return this.editing && Boolean(this.draft.date || this.draft.time); }

  connectedCallback() { this.render(); }

  open() { this.editing = true; this.error = ""; this.render(); this.querySelector("input")?.focus(); }
  close() { this.editing = false; this.draft = { date: "", time: "" }; this.error = ""; this.render(); }

  render() {
    if (!this.targetRecord) { this.replaceChildren(); return; }
    const { id, title } = this.targetRecord;
    const wrap = document.createElement("div");
    wrap.className = "reminder";
    const status = document.createElement("p");
    status.className = "reminder-status";
    status.textContent = this.current ? `Reminds ${describeReminderTime(this.current.at)} on this device.` : "";
    wrap.append(status);
    const note = document.createElement("p");
    note.className = "reminder-note";
    note.textContent = DEVICE_NOTE;
    if (this.current || this.editing) wrap.append(note);

    if (!this.editing) {
      const actions = document.createElement("div");
      actions.className = "reminder-actions";
      const set = this.button(this.current ? "Change reminder" : "Remind me", () => this.open());
      set.setAttribute("aria-label", `${this.current ? "Change" : "Set"} reminder for ${title}`);
      if (!this.current) set.title = DEVICE_NOTE;
      set.dataset.reminderAction = "open";
      actions.append(set);
      if (this.current) {
        const cancel = this.button("Cancel reminder", () => this.dispatch("cancel-local-reminder", { id }));
        cancel.setAttribute("aria-label", `Cancel reminder for ${title}`);
        cancel.dataset.reminderAction = "cancel";
        actions.append(cancel);
      }
      wrap.append(actions);
      this.replaceChildren(wrap);
      return;
    }

    const form = document.createElement("form");
    form.className = "reminder-form";
    form.noValidate = true;
    const dateId = `${this.instanceId}-date`;
    const timeId = `${this.instanceId}-time`;
    const errorId = `${this.instanceId}-error`;
    const dateLabel = document.createElement("label");
    dateLabel.htmlFor = dateId;
    dateLabel.textContent = "Date";
    const date = document.createElement("input");
    date.type = "date";
    date.id = dateId;
    date.value = this.draft.date;
    date.setAttribute("aria-describedby", errorId);
    dateLabel.append(date);
    const timeLabel = document.createElement("label");
    timeLabel.htmlFor = timeId;
    timeLabel.textContent = "Time";
    const time = document.createElement("input");
    time.type = "time";
    time.id = timeId;
    time.value = this.draft.time;
    time.setAttribute("aria-describedby", errorId);
    timeLabel.append(time);
    const fields = document.createElement("div");
    fields.className = "reminder-fields";
    fields.append(dateLabel, timeLabel);

    const shortcuts = document.createElement("div");
    shortcuts.className = "reminder-shortcuts";
    for (const [label, kind] of [["In 1 hour", "in-1-hour"], ["This evening", "this-evening"], ["Tomorrow morning", "tomorrow-morning"]]) {
      const shortcut = this.button(label, () => {
        const filled = reminderShortcut(kind, Date.now());
        date.value = filled.date;
        time.value = filled.time;
        update();
      });
      shortcut.className = "reminder-shortcut";
      shortcuts.append(shortcut);
    }

    const preview = document.createElement("p");
    preview.className = "reminder-preview";
    preview.setAttribute("aria-live", "polite");
    const error = document.createElement("p");
    error.className = "reminder-error";
    error.id = errorId;
    error.setAttribute("role", "alert");
    const update = () => {
      this.draft = { date: date.value, time: time.value };
      const result = resolveReminderTime({ date: date.value, time: time.value, now: Date.now() });
      preview.textContent = result.at ? `Reminds ${describeReminderTime(result.at)} on this device.` : "";
      if (this.error && !result.error) { this.error = ""; error.textContent = ""; }
    };
    date.addEventListener("input", update);
    time.addEventListener("input", update);
    update();
    if (this.error) error.textContent = this.error;

    const actions = document.createElement("div");
    actions.className = "reminder-actions";
    const set = document.createElement("button");
    set.type = "submit";
    set.className = "primary-action";
    set.textContent = "Set reminder";
    set.setAttribute("aria-label", `Set reminder for ${title}`);
    set.dataset.reminderAction = "set";
    const cancel = this.button("Cancel", () => { this.close(); this.querySelector('[data-reminder-action="open"]')?.focus(); });
    cancel.dataset.reminderAction = "close";
    actions.append(set, cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.isDisabled) return;
      const result = resolveReminderTime({ date: date.value, time: time.value, now: Date.now() });
      if (result.error) {
        this.error = result.error;
        error.textContent = result.error;
        (date.value ? time : date).focus();
        return;
      }
      this.dispatch("set-local-reminder", { id, title, at: result.at });
    });
    form.append(fields, shortcuts, preview, error, actions);
    wrap.append(form);
    this.replaceChildren(wrap);
    this.disabled = this.isDisabled;
  }

  // Called by the owner once the reminder model accepted the time.
  saved(at) { this.current = at ? { at } : null; this.close(); }

  button(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = this.isDisabled;
    button.addEventListener("click", action);
    return button;
  }

  dispatch(action, detail) {
    if (!this.isDisabled) this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }
}
KinReminder.instances = 0;

export { localDateValue, localTimeValue };
customElements.define("kin-reminder", KinReminder);
