import { CLASSIFICATION_LABELS, TOO_LONG } from "./kin-compose.js";
import { projectionContext } from "../browser-time.js";

const MAX_ITEM_TEXT_BYTES = 4096;
const textEncoder = new TextEncoder();

function captureDefaults() {
  const [page, segment] = location.hash.replace(/^#/, "").split("/");
  if (page === "today" || !page) {
    return { classification: "need", planningDate: "today", destination: "Today" };
  }
  if (page === "lists") {
    const classification = { todo: "need", shopping: "shopping", staples: "staple" }[segment] ?? "need";
    return { classification, planningDate: null, destination: CLASSIFICATION_LABELS[classification] };
  }
  return { classification: "need", planningDate: null, destination: "To do" };
}

class KinQuickAdd extends HTMLElement {
  constructor() {
    super();
    this.isDisabled = true;
    this.pending = false;
    this.composing = false;
    this.draftRevision = 0;
  }

  connectedCallback() {
    if (this.dialog) return;
    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "quick-add-trigger";
    this.trigger.textContent = "Quick add";
    this.trigger.setAttribute("aria-haspopup", "dialog");

    this.dialog = document.createElement("dialog");
    this.dialog.className = "quick-add-dialog";
    this.dialog.setAttribute("aria-labelledby", "quick-add-title");
    const heading = document.createElement("h2");
    heading.id = "quick-add-title";
    heading.textContent = "Quick add";
    const hint = document.createElement("p");
    hint.className = "quick-add-hint";
    hint.textContent = "Add a household task now. You can add dates and details later.";
    this.form = document.createElement("form");
    this.form.method = "dialog";
    this.form.className = "quick-add-form";
    this.label = document.createElement("label");
    this.label.htmlFor = "quick-add-title-input";
    this.label.textContent = "Task title";
    this.input = document.createElement("input");
    this.input.id = "quick-add-title-input";
    this.input.name = "title";
    this.input.type = "text";
    this.input.required = true;
    this.input.autocomplete = "off";
    this.input.maxLength = MAX_ITEM_TEXT_BYTES;
    this.input.setAttribute("aria-describedby", "quick-add-destination quick-add-error");
    this.destination = document.createElement("p");
    this.destination.id = "quick-add-destination";
    this.destination.className = "quick-add-destination";
    this.error = document.createElement("p");
    this.error.id = "quick-add-error";
    this.error.className = "quick-add-error";
    this.error.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "quick-add-actions";
    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.textContent = "Cancel";
    this.addButton = document.createElement("button");
    this.addButton.type = "submit";
    this.addButton.className = "add-button";
    this.addButton.textContent = "Add";
    actions.append(this.cancelButton, this.addButton);
    this.form.append(this.label, this.input, this.destination, this.error, actions);
    this.dialog.append(heading, hint, this.form);
    this.append(this.trigger, this.dialog);

    this.trigger.addEventListener("click", () => this.open());
    this.cancelButton.addEventListener("click", () => {
      if (this.pending) return;
      this.clearDraft();
      this.dialog.close();
    });
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.input.addEventListener("input", () => { this.draftRevision++; this.error.textContent = ""; });
    this.input.addEventListener("invalid", () => {
      this.error.textContent = "Enter a task title.";
      this.input.focus();
    });
    this.input.addEventListener("compositionstart", () => { this.composing = true; });
    this.input.addEventListener("compositionend", () => { this.composing = false; });
    this.dialog.addEventListener("cancel", (event) => {
      if (this.pending) {
        event.preventDefault();
        this.error.textContent = "Please wait for this task to finish saving.";
      } else {
        this.clearDraft();
      }
    });
    this.dialog.addEventListener("close", () => {
      if (this.opener?.isConnected) this.opener.focus();
      this.opener = null;
    });
    this.disabled = this.isDisabled;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    if (!this.trigger) return;
    this.trigger.disabled = this.isDisabled;
    const saving = this.pending;
    this.input.disabled = this.isDisabled || saving;
    this.addButton.disabled = this.isDisabled || saving;
    this.cancelButton.disabled = saving;
  }

  open() {
    if (this.isDisabled || this.dialog.open) return;
    this.clearDraft();
    this.defaults = captureDefaults();
    this.destination.textContent = `Adds to ${this.defaults.destination}.`;
    this.opener = this.trigger;
    this.dialog.showModal();
    this.input.focus();
  }

  submit(event) {
    event.preventDefault();
    if (this.pending || this.isDisabled || this.composing || event.isComposing) return;
    const text = this.input.value;
    if (!text.trim()) {
      this.input.setCustomValidity("Enter a task title.");
      this.input.reportValidity();
      this.error.textContent = "Enter a task title.";
      this.input.setCustomValidity("");
      return;
    }
    if (textEncoder.encode(text).length > MAX_ITEM_TEXT_BYTES) {
      this.error.textContent = TOO_LONG;
      this.input.focus();
      return;
    }
    this.error.textContent = "";
    this.pending = true;
    this.disabled = this.isDisabled;
    this.addButton.textContent = "Saving…";
    const planningDate = this.defaults.planningDate === "today" ? projectionContext().civilDate : null;
    this.dispatchEvent(new CustomEvent("kin:add-item", {
      detail: { text, classification: this.defaults.classification, planningDate, pinned: false, composer: this, revision: this.draftRevision },
      bubbles: true,
      composed: true,
    }));
  }

  clearIfMatches(draft) {
    if (this.input.value !== draft.text || this.draftRevision !== draft.revision) return;
    this.pending = false;
    this.addButton.textContent = "Add";
    this.clearDraft();
    this.dialog.close("saved");
  }

  showResult(text, { kind = "saved" } = {}) {
    if (kind !== "error") return;
    this.pending = false;
    this.addButton.textContent = "Add";
    this.error.textContent = text;
    this.disabled = this.isDisabled;
    this.input.focus();
  }

  focusInput() { if (this.dialog.open) this.input.focus(); }

  clearDraft() {
    this.input.value = "";
    this.error.textContent = "";
  }

  reset() {
    this.pending = false;
    this.draftRevision++;
    if (this.dialog?.open) this.dialog.close();
    if (this.input) this.clearDraft();
    if (this.addButton) this.addButton.textContent = "Add";
  }
}

customElements.define("kin-quick-add", KinQuickAdd);
