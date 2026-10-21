// Lists › Just for me (#510, #511, #517): the member's private to-dos and
// short notes. Only this member's devices can read them (ADR 0019); the
// household never sees them, and they never reach household search, the
// sitter page or household exports.
//
// The list comes from Rust (KPRV section 11) through the app's private-items
// controller, which this element reaches as `controller`:
//   run(command)          a private command (kin-private.js); rejects with a
//                         user-facing `userMessage` when it can't be saved
//   shareAudience()       the other members' names, or null
//   share(item)           "Share with the household…", after this element's
//                         confirmation; resolves { ok, message }
//
// Fast capture first (tired-parent test): type, Enter, done. A date, a note,
// editing and sharing live under each item's "More". Deleting offers Undo,
// which stays until the next change (WCAG 2.2.1); nothing here times out.
import { button } from "./shared/dom.js";
import { privateMarker } from "./shared/private-marker.js";
import { formatCivilDate } from "../today-view.js";

const civilFromInput = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? Number(value.replaceAll("-", "")) : null);
const inputFromCivil = (date) => {
  if (!Number.isSafeInteger(date)) return "";
  const text = String(date).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
};
const quoted = (text) => `“${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`;
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

let instances = 0;

class KinJustForMe extends HTMLElement {
  constructor() {
    super();
    this.idPrefix = `just-for-me-${++instances}`;
    this.controller = null;
    this.availability = { state: "loading" };
    this.items = [];
    this.onToday = true;
    this.today = null;
    this.running = false;
    this.openIds = new Set();
    this.completedOpen = false;
    this.undo = null;
  }

  connectedCallback() {
    if (!this.built) this.build();
    this.render();
  }

  /** `{ availability, items, onToday, today }` from the controller. */
  update({ availability, items, onToday, today } = {}) {
    if (availability) this.availability = availability;
    if (items) this.items = items;
    if (typeof onToday === "boolean") this.onToday = onToday;
    if (Number.isSafeInteger(today)) this.today = today;
    if (this.built) this.render();
  }

  build() {
    this.built = true;
    this.className = "just-for-me";
    const id = this.idPrefix;
    const intro = document.createElement("section");
    intro.className = "list-view just-for-me-view";
    intro.setAttribute("aria-labelledby", `${id}-heading`);
    const heading = document.createElement("h2");
    heading.id = `${id}-heading`;
    heading.tabIndex = -1;
    heading.textContent = "Just for me";
    this.heading = heading;
    const badge = document.createElement("p");
    badge.className = "private-badge";
    badge.append(privateMarker({ text: "" }), "Only you can see this.");
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = "Private to-dos and short notes, on all your devices. Your household never sees them.";
    this.unavailable = document.createElement("p");
    this.unavailable.className = "just-for-me-unavailable";
    this.unavailable.hidden = true;

    // Add: one field and Enter; the date is optional.
    this.form = document.createElement("form");
    this.form.className = "just-for-me-add";
    const textLabel = document.createElement("label");
    textLabel.htmlFor = `${id}-text`;
    textLabel.textContent = "Add something just for you";
    this.input = document.createElement("input");
    this.input.id = `${id}-text`;
    this.input.type = "text";
    this.input.autocomplete = "off";
    this.input.enterKeyHint = "done";
    this.input.required = true;
    const dateLabel = document.createElement("label");
    dateLabel.htmlFor = `${id}-date`;
    dateLabel.className = "just-for-me-date-label";
    dateLabel.textContent = "Date (optional)";
    this.dateInput = document.createElement("input");
    this.dateInput.id = `${id}-date`;
    this.dateInput.type = "date";
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "primary-action";
    add.textContent = "Add";
    const textField = document.createElement("div");
    textField.className = "just-for-me-field";
    textField.append(textLabel, this.input);
    const dateField = document.createElement("div");
    dateField.className = "just-for-me-field just-for-me-date";
    dateField.append(dateLabel, this.dateInput);
    this.form.append(textField, dateField, add);
    this.form.addEventListener("submit", (event) => { event.preventDefault(); void this.add(); });

    this.list = document.createElement("ul");
    this.list.className = "item-list private-list";
    this.list.setAttribute("aria-label", "Just for me, open");
    this.empty = document.createElement("p");
    this.empty.className = "empty-state";
    this.done = document.createElement("details");
    this.done.className = "completed-disclosure today-disclosure";
    this.doneSummary = document.createElement("summary");
    this.doneList = document.createElement("ul");
    this.doneList.className = "item-list private-list";
    this.done.append(this.doneSummary, this.doneList);
    this.done.addEventListener("toggle", () => { this.completedOpen = this.done.open; });

    // What the last change did; after a delete it holds Undo.
    this.feedback = document.createElement("div");
    this.feedback.className = "just-for-me-feedback";
    this.feedbackText = document.createElement("p");
    this.feedbackText.setAttribute("role", "status");
    this.undoButton = button("Undo", () => void this.runUndo(), { className: "undo-toast-action" });
    this.undoButton.hidden = true;
    this.feedback.append(this.feedbackText, this.undoButton);

    // The Today and This week setting (#514): on by default.
    this.setting = document.createElement("div");
    this.setting.className = "just-for-me-setting";
    const settingLabel = document.createElement("label");
    this.settingBox = document.createElement("input");
    this.settingBox.type = "checkbox";
    this.settingBox.id = `${id}-on-today`;
    this.settingBox.setAttribute("aria-describedby", `${id}-on-today-hint`);
    this.settingBox.addEventListener("change", () => void this.perform(
      { type: "set-private-items-on-today", on: this.settingBox.checked },
      this.settingBox.checked ? "Your dated private things show on your Today and This week." : "Your private things stay in Just for me only.",
    ));
    settingLabel.append(this.settingBox, " Show my dated private things on my Today and This week");
    const settingHint = document.createElement("p");
    settingHint.className = "section-hint";
    settingHint.id = `${id}-on-today-hint`;
    settingHint.textContent = "Marked “Private”, on your own devices only. Never in Simple view, never in household search.";
    this.setting.append(settingLabel, settingHint);

    this.shareDialog = this.buildShareDialog();
    intro.append(heading, badge, hint, this.unavailable, this.form, this.feedback, this.list, this.empty, this.done, this.setting);
    this.append(intro, this.shareDialog);
  }

  get ready() {
    return this.availability?.state === "ready";
  }

  render() {
    if (!this.built) return;
    const focusKey = this.contains(document.activeElement) ? this.focusKeyOf(document.activeElement) : null;
    const ready = this.ready;
    this.unavailable.hidden = ready;
    this.unavailable.replaceChildren(...this.unavailableContent());
    for (const node of [this.form, this.list, this.empty, this.done, this.setting]) node.hidden = !ready;
    if (!ready) { this.feedback.hidden = !this.feedbackText.textContent; return; }
    this.feedback.hidden = false;
    for (const details of this.querySelectorAll(".private-more")) {
      if (details.open) this.openIds.add(details.dataset.privateId); else this.openIds.delete(details.dataset.privateId);
    }
    const open = this.items.filter((item) => !item.completed).sort((left, right) => (left.date ?? 99999999) - (right.date ?? 99999999) || left.addedAt - right.addedAt);
    const completed = this.items.filter((item) => item.completed);
    this.list.replaceChildren(...open.map((item) => this.row(item)));
    this.list.hidden = !open.length;
    this.empty.hidden = open.length > 0;
    this.empty.textContent = completed.length
      ? "Everything here is done. Completed things are below."
      : "Nothing here yet. A gift idea, a call to make, a surprise: add it above.";
    this.done.hidden = !completed.length;
    this.doneSummary.textContent = `Completed (${completed.length})`;
    this.doneList.replaceChildren(...completed.map((item) => this.row(item)));
    this.done.open = this.completedOpen;
    this.settingBox.checked = this.onToday;
    if (focusKey) this.findByKey(focusKey)?.focus({ preventScroll: true });
  }

  /** One calm sentence when private storage isn't available here. */
  unavailableContent() {
    switch (this.availability?.state) {
      case "ready":
        return [];
      case "off":
        return ["Your household has turned off private things for you, so Just for me isn't available."];
      case "loading":
        return ["Opening your private things…"];
      default: {
        const link = document.createElement("a");
        link.href = "#household/privacy";
        link.textContent = "Set up your account";
        return ["Just for me needs your Kin account on this device, so your private things can follow you to your other devices. ", link, "."];
      }
    }
  }

  row(item) {
    const row = document.createElement("li");
    row.className = "private-row";
    row.dataset.privateId = item.id;
    const label = document.createElement("label");
    label.className = "private-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = item.completed;
    box.dataset.focusKey = `${item.id}:done`;
    box.addEventListener("change", () => void this.perform(
      { type: box.checked ? "complete-private-item" : "reopen-private-item", itemId: item.id },
      box.checked ? `Done: ${quoted(item.text)}.` : `Reopened ${quoted(item.text)}.`,
    ));
    const text = document.createElement("span");
    text.className = "private-text";
    text.textContent = item.text;
    label.append(box, text);
    row.append(label);
    const meta = [];
    if (item.date != null) meta.push(this.dateText(item.date));
    if (item.note) meta.push("Note");
    if (meta.length) {
      const line = document.createElement("span");
      line.className = "private-meta";
      line.textContent = meta.join(" · ");
      row.append(line);
    }
    if (item.note) {
      const note = document.createElement("p");
      note.className = "private-note";
      note.textContent = item.note;
      row.append(note);
    }
    row.append(this.more(item));
    return row;
  }

  dateText(date) {
    if (date === this.today) return "Today";
    const label = formatCivilDate(date, undefined, { weekday: "short", month: "short", day: "numeric" });
    return this.today != null && date < this.today ? `${label}, still open` : label;
  }

  /** Date, note, edit, share and delete, behind one disclosure per item. */
  more(item) {
    const details = document.createElement("details");
    details.className = "private-more";
    details.dataset.privateId = item.id;
    details.open = this.openIds.has(item.id);
    const summary = document.createElement("summary");
    summary.textContent = "More";
    summary.setAttribute("aria-label", `More for ${item.text}`);
    summary.dataset.focusKey = `${item.id}:more`;
    const body = document.createElement("div");
    body.className = "private-more-body";
    const field = (key, caption, control) => {
      const wrap = document.createElement("div");
      wrap.className = "just-for-me-field";
      const label = document.createElement("label");
      label.htmlFor = `${this.idPrefix}-${key}-${item.id}`;
      label.textContent = caption;
      control.id = label.htmlFor;
      control.dataset.focusKey = `${item.id}:${key}`;
      wrap.append(label, control);
      return wrap;
    };
    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.value = item.text;
    textInput.autocomplete = "off";
    const saveText = button("Save", () => {
      const value = textInput.value.trim();
      if (!value || value === item.text) return;
      void this.perform({ type: "edit-private-item", itemId: item.id, text: value }, `Saved ${quoted(value)}.`);
    });
    saveText.setAttribute("aria-label", `Save the new wording of ${item.text}`);
    saveText.dataset.focusKey = `${item.id}:save-text`;
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = inputFromCivil(item.date);
    const saveDate = button("Save date", () => {
      const date = civilFromInput(dateInput.value);
      if (date === (item.date ?? null)) return;
      void this.perform({ type: "date-private-item", itemId: item.id, date }, date ? `Date saved for ${quoted(item.text)}.` : `Date cleared for ${quoted(item.text)}.`);
    });
    saveDate.setAttribute("aria-label", `Save the date of ${item.text}`);
    saveDate.dataset.focusKey = `${item.id}:save-date`;
    const note = document.createElement("textarea");
    note.rows = 3;
    note.maxLength = 2048;
    note.value = item.note ?? "";
    const saveNote = button("Save note", () => {
      const value = note.value.trim();
      if (value === (item.note ?? "")) return;
      void this.perform({ type: "set-private-item-note", itemId: item.id, note: value }, value ? "Note saved." : "Note removed.");
    });
    saveNote.setAttribute("aria-label", `Save the note on ${item.text}`);
    saveNote.dataset.focusKey = `${item.id}:save-note`;
    const share = button("Share with the household…", () => this.openShare(item, share), { className: "private-share" });
    share.dataset.focusKey = `${item.id}:share`;
    share.setAttribute("aria-label", `Share ${item.text} with the household…`);
    const remove = button("Delete", () => void this.remove(item), { className: "danger-action" });
    remove.dataset.focusKey = `${item.id}:delete`;
    remove.setAttribute("aria-label", `Delete ${item.text}`);
    const row = (...nodes) => { const line = document.createElement("div"); line.className = "private-more-row"; line.append(...nodes); return line; };
    body.append(
      row(field("text", "Wording", textInput), saveText),
      row(field("date", "Date", dateInput), saveDate),
      row(field("note", "Short note", note), saveNote),
      // Something already done stays private: sharing is for what's open.
      item.completed ? row(remove) : row(share, remove),
    );
    details.append(summary, body);
    return details;
  }

  // ---- Changes --------------------------------------------------------------

  async add() {
    const text = this.input.value.trim();
    if (!text) { this.input.focus(); return; }
    const date = civilFromInput(this.dateInput.value);
    const done = await this.perform({ type: "add-private-item", itemId: newId(), text, date }, `Added ${quoted(text)}. Only you can see it.`);
    if (done) {
      this.input.value = "";
      this.dateInput.value = "";
      this.input.focus();
    }
  }

  async remove(item) {
    const done = await this.perform({ type: "delete-private-item", itemId: item.id }, `Deleted ${quoted(item.text)}.`, { keepUndo: true });
    if (!done) return;
    this.undo = item;
    this.undoButton.hidden = false;
    this.undoButton.setAttribute("aria-label", `Undo deleting ${item.text}`);
    this.undoButton.focus();
  }

  async runUndo() {
    const item = this.undo;
    if (!item) return;
    const done = await this.perform({ type: "restore-private-item", itemId: item.id }, `Restored ${quoted(item.text)}.`);
    if (done) this.findByKey(`${item.id}:done`)?.focus();
  }

  /** Runs one private command. Resolves true when it was saved. */
  async perform(command, message, { keepUndo = false } = {}) {
    if (this.running || !this.controller) return false;
    this.running = true;
    if (!keepUndo) this.clearUndo();
    try {
      await this.controller.run(command);
      this.say(message);
      return true;
    } catch (error) {
      this.say(error?.userMessage ?? "Kin couldn't save that private change. Try again.");
      this.render();
      return false;
    } finally {
      this.running = false;
    }
  }

  clearUndo() {
    this.undo = null;
    this.undoButton.hidden = true;
  }

  say(message) {
    this.feedbackText.textContent = message;
    this.feedback.hidden = false;
  }

  // ---- Sharing (#517) --------------------------------------------------------

  buildShareDialog() {
    const id = this.idPrefix;
    const dialog = document.createElement("dialog");
    dialog.className = "meal-dialog private-share-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-share-title`);
    dialog.setAttribute("aria-describedby", `${id}-share-who`);
    const title = document.createElement("h2");
    title.id = `${id}-share-title`;
    title.textContent = "Share with the household?";
    this.shareWho = document.createElement("p");
    this.shareWho.id = `${id}-share-who`;
    const after = document.createElement("p");
    after.className = "section-hint";
    after.textContent = "It leaves Just for me. A note stays private and isn't shared.";
    const actions = document.createElement("div");
    actions.className = "meal-dialog-actions";
    const keep = button("Keep it private", () => dialog.close("keep"));
    keep.autofocus = true;
    const confirm = button("Share with the household", () => dialog.close("share"), { className: "primary-action" });
    actions.append(keep, confirm);
    dialog.append(title, this.shareWho, after, actions);
    dialog.addEventListener("close", () => void this.afterShareDialog(dialog.returnValue));
    return dialog;
  }

  openShare(item, opener) {
    if (this.running || !this.controller || this.shareDialog.open) return;
    this.sharing = { item, opener };
    const audience = this.controller.shareAudience?.() ?? null;
    this.shareWho.textContent = audience
      ? `${quoted(item.text)} will move to To do, where ${audience} will see it.`
      : `${quoted(item.text)} will move to To do, where everyone in your household will see it, including anyone who joins later.`;
    this.shareDialog.returnValue = "";
    this.shareDialog.showModal();
  }

  async afterShareDialog(choice) {
    const sharing = this.sharing;
    this.sharing = null;
    if (!sharing) return;
    if (choice !== "share") {
      sharing.opener?.focus();
      return;
    }
    if (this.running) return;
    this.running = true;
    this.clearUndo();
    try {
      const outcome = await this.controller.share(sharing.item);
      this.say(outcome.message);
    } catch (error) {
      this.say(error?.userMessage ?? "Kin couldn't share that. Nothing was lost; try again.");
    } finally {
      this.running = false;
    }
    if (sharing.opener?.isConnected) sharing.opener.focus();
    else this.heading.focus();
  }

  // ---- Focus across re-renders --------------------------------------------

  focusKeyOf(node) {
    if (!node) return null;
    if (node.dataset?.focusKey) return node.dataset.focusKey;
    if (node.id) return `#${node.id}`;
    return null;
  }

  findByKey(key) {
    if (!key) return null;
    if (key.startsWith("#")) return this.querySelector(`[id="${key.slice(1)}"]`);
    return [...this.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === key) ?? null;
  }

  focusHeading() {
    this.heading?.focus();
  }
}

if (!customElements.get("kin-just-for-me")) customElements.define("kin-just-for-me", KinJustForMe);
