import { localCivilDateOffset } from "../browser-time.js";

class KinItem extends HTMLElement {
  constructor() {
    super();
    this.record = null;
    this.isDisabled = false;
    this.showSteps = false;
  }

  set item(value) {
    this.record = value;
    this.render();
  }

  set areaOptions(value) {
    this.areas = Array.isArray(value) ? value : [];
    this.render();
  }

  set checklistExpanded(value) {
    this.showSteps = Boolean(value);
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input, select")) {
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
    }
  }

  render() {
    if (!this.record) {
      return;
    }
    const row = document.createElement("div");
    row.className = `item-row item-${this.record.status}`;
    const text = document.createElement("p");
    text.className = "item-text";
    text.textContent = this.record.text;
    const details = document.createElement("div");
    details.className = "item-details";
    details.append(text);
    if (this.record.status !== "archived") {
      const label = document.createElement("label");
      label.className = "item-area-label";
      const select = document.createElement("select");
      select.className = "item-area-select";
      select.setAttribute("aria-label", `Area for ${this.record.text}`);
      select.dataset.itemId = this.record.itemId;
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "No area";
      select.append(none);
      for (const area of this.areas ?? []) {
        if (area.archived && area.areaId !== this.record.areaId) continue;
        const option = document.createElement("option");
        option.value = area.areaId;
        const duplicates = (this.areas ?? []).filter((candidate) => candidate.name.toLowerCase() === area.name.toLowerCase());
        option.textContent = `${area.name}${duplicates.length > 1 ? ` · ${area.areaId.slice(-4)}` : ""}${area.archived ? " (archived)" : ""}`;
        select.append(option);
      }
      select.value = this.record.areaId ?? "";
      select.disabled = this.isDisabled;
      select.addEventListener("change", () => this.dispatchEvent(new CustomEvent("kin:change-item-area", {
        detail: { itemId: this.record.itemId, areaId: select.value || null }, bubbles: true, composed: true,
      })));
      label.append(select);
      details.append(label);
    } else if (this.record.areaId) {
      const area = (this.areas ?? []).find((candidate) => candidate.areaId === this.record.areaId);
      if (area) {
        const context = document.createElement("span");
        context.className = "area-archived-label";
        context.textContent = `Area: ${area.name}${area.archived ? " (archived)" : ""}`;
        details.append(context);
      }
    }
    if (this.record.status !== "archived") {
      details.append(this.createPlanningDateEditor());
    } else if (this.record.planningDate) {
      const planned = document.createElement("span");
      planned.className = "item-planning-date-label";
      planned.textContent = `Planned for ${formatPlanningDate(this.record.planningDate)}`;
      details.append(planned);
    }
    const action = document.createElement("div");
    action.className = "item-action";
    const isStaple = this.record.classification === "staple";
    const steps = Array.isArray(this.record.steps) ? this.record.steps : [];
    const activeSteps = steps.filter((step) => !step.archived);
    const completedSteps = activeSteps.filter((step) => step.completed).length;
    if (isStaple) {
      const replenish = document.createElement("button");
      replenish.type = "button";
      replenish.className = "replenish-button";
      replenish.textContent = "Add to Shopping";
      replenish.setAttribute("aria-label", `Add ${this.record.text} to Shopping`);
      replenish.dataset.itemId = this.record.itemId;
      replenish.dataset.itemAction = "replenish";
      replenish.disabled = this.isDisabled || this.record.status !== "active";
      replenish.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("kin:replenish-staple", {
          detail: { itemId: this.record.itemId },
          bubbles: true,
          composed: true,
        }));
      });
      action.append(replenish);
    } else {
      const stepSummary = document.createElement("span");
      stepSummary.className = "step-summary";
      stepSummary.textContent = `${completedSteps} of ${activeSteps.length} steps`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "step-toggle-button";
      toggle.textContent = this.showSteps ? "Hide steps" : "Checklist";
      toggle.setAttribute("aria-expanded", String(this.showSteps));
      toggle.setAttribute("aria-controls", `checklist-${this.record.itemId}`);
      toggle.setAttribute(
        "aria-label",
        `${this.showSteps ? "Hide" : "Show"} checklist for ${this.record.text}, ${completedSteps} of ${activeSteps.length} steps`,
      );
      toggle.dataset.itemId = this.record.itemId;
      toggle.dataset.itemAction = "toggle-steps";
      toggle.disabled = this.isDisabled;
      toggle.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("kin:toggle-item-steps", {
          detail: { itemId: this.record.itemId },
          bubbles: true,
          composed: true,
        }));
      });
      action.append(stepSummary, toggle);
    }

    if (isStaple) {
      if (this.record.status !== "active") {
        const unavailable = document.createElement("span");
        unavailable.className = "completed-label";
        unavailable.textContent = "Unavailable";
        action.append(unavailable);
      }
    } else if (this.record.status === "active") {
      action.append(
        this.createAction("Complete", "complete", "complete-button"),
      );
    } else {
      const completed = document.createElement("span");
      completed.className = "completed-label";
      completed.textContent = "Completed";
      action.append(completed);
      action.append(this.createAction("Reopen", "reopen", "reopen-button"));
    }
    action.append(this.createAction("Archive", "archive", "archive-button"));

    row.append(details, action);
    if (!isStaple && this.showSteps) {
      row.append(this.createChecklist(steps));
    }
    this.replaceChildren(row);
  }

  createChecklist(steps) {
    const panel = document.createElement("section");
    panel.className = "item-checklist";
    panel.id = `checklist-${this.record.itemId}`;
    const list = document.createElement("ul");
    list.className = "step-list";
    for (const step of steps.filter((entry) => !entry.archived)) {
      const entry = document.createElement("li");
      entry.className = "step-row";
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = step.completed;
      checkbox.id = `step-${this.record.itemId}-${step.stepId}`;
      checkbox.dataset.itemId = this.record.itemId;
      checkbox.dataset.stepId = step.stepId;
      checkbox.dataset.itemAction = "toggle-step";
      checkbox.dataset.domainDisabled = String(this.record.status !== "active");
      checkbox.disabled = this.isDisabled || this.record.status !== "active";
      checkbox.addEventListener("change", () => {
        this.dispatchEvent(new CustomEvent(
          `kin:${checkbox.checked ? "complete" : "reopen"}-item-step`,
          {
            detail: {
              itemId: this.record.itemId,
              stepId: step.stepId,
            },
            bubbles: true,
            composed: true,
          },
        ));
      });
      const text = document.createElement("span");
      text.textContent = step.text;
      label.htmlFor = checkbox.id;
      label.append(checkbox, text);
      entry.append(label);
      entry.append(this.createStepAction(
        "Archive step",
        "archive-item-step",
        step.stepId,
        step.text,
      ));
      list.append(entry);
    }
    panel.append(list);
    if (this.record.status !== "active") {
      const hint = document.createElement("p");
      hint.className = "step-parent-hint";
      hint.textContent = "Reopen this item before changing its steps.";
      panel.append(hint);
    }
    const form = document.createElement("form");
    form.className = "step-compose";
    const inputId = `add-step-${this.record.itemId}`;
    const label = document.createElement("label");
    label.htmlFor = inputId;
    label.textContent = "Add a step";
    const input = document.createElement("input");
    input.type = "text";
    input.id = inputId;
    input.required = true;
    input.autocomplete = "off";
    input.dataset.itemId = this.record.itemId;
    input.dataset.itemAction = "add-step";
    input.dataset.domainDisabled = String(
      this.record.status !== "active" || steps.length >= 16,
    );
    input.disabled = this.isDisabled || input.dataset.domainDisabled === "true";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Add step";
    submit.disabled = input.disabled;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const textValue = input.value.trim();
      const textLength = [...textValue].length;
      const bytesLength = new TextEncoder().encode(textValue).length;
      const invalid =
        !textValue ||
        textLength > 80 ||
        bytesLength > 256 ||
        [...textValue].some((character) => /\p{Cc}/u.test(character));
      input.setCustomValidity(invalid ? "Use 1–80 characters and no more than 256 UTF-8 bytes; control characters are not allowed." : "");
      if (invalid) {
        input.reportValidity();
        return;
      }
      this.dispatchEvent(new CustomEvent("kin:add-item-step", {
        detail: { itemId: this.record.itemId, text: textValue },
        bubbles: true,
        composed: true,
      }));
    });
    form.append(label, input, submit);
    panel.append(form);
    return panel;
  }

  createStepAction(label, action, stepId, stepText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "step-archive-button";
    button.textContent = label;
    button.setAttribute("aria-label", `${label} ${stepText}`);
    button.dataset.itemId = this.record.itemId;
    button.dataset.stepId = stepId;
    button.dataset.itemAction = action;
    button.dataset.domainDisabled = String(this.record.status !== "active");
    button.disabled = this.isDisabled || this.record.status !== "active";
    button.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent(`kin:${action}`, {
        detail: { itemId: this.record.itemId, stepId },
        bubbles: true,
        composed: true,
      }));
    });
    return button;
  }

  createAction(label, action, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.setAttribute("aria-label", `${label} ${this.record.text}`);
    button.dataset.itemId = this.record.itemId;
    button.dataset.itemAction = action;
    button.disabled = this.isDisabled;
    button.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent(`kin:${action}-item`, {
          detail: { itemId: this.record.itemId },
          bubbles: true,
          composed: true,
          cancelable: false,
        }),
      );
    });
    return button;
  }

  createPlanningDateEditor() {
    const editor = document.createElement("div");
    editor.className = "item-planning-date";
    const label = document.createElement("label");
    label.className = "item-planning-date-field";
    label.textContent = "Planned date";
    const input = document.createElement("input");
    input.type = "date";
    input.className = "item-planning-date-input";
    input.setAttribute("aria-label", `Planned date for ${this.record.text}`);
    input.dataset.itemId = this.record.itemId;
    input.value = this.record.planningDate
      ? formatPlanningDate(this.record.planningDate)
      : "";
    input.disabled = this.isDisabled;
    input.addEventListener("change", () => this.dispatchPlanningDate(
      input.value ? Number(input.value.replaceAll("-", "")) : null,
    ));
    label.append(input);
    editor.append(label);
    for (const [labelText, offset] of [["Today", 0], ["Tomorrow", 1]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "item-planning-date-shortcut";
      button.textContent = labelText;
      button.setAttribute("aria-label", `Plan ${this.record.text} for ${labelText.toLowerCase()}`);
      button.dataset.itemId = this.record.itemId;
      button.disabled = this.isDisabled;
      button.addEventListener("click", () => {
        this.dispatchPlanningDate(localCivilDateOffset(offset));
      });
      editor.append(button);
    }
    if (this.record.planningDate) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "item-planning-date-shortcut";
      clear.textContent = "Clear";
      clear.setAttribute("aria-label", `Clear planned date for ${this.record.text}`);
      clear.dataset.itemId = this.record.itemId;
      clear.disabled = this.isDisabled;
      clear.addEventListener("click", () => this.dispatchPlanningDate(null));
      editor.append(clear);
    }
    return editor;
  }

  dispatchPlanningDate(planningDate) {
    if (this.record.planningDate === planningDate) return;
    this.dispatchEvent(new CustomEvent("kin:set-item-planning-date", {
      detail: { itemId: this.record.itemId, planningDate },
      bubbles: true,
      composed: true,
    }));
  }
}

function formatPlanningDate(value) {
  const year = Math.floor(value / 10000).toString().padStart(4, "0");
  const month = (Math.floor(value / 100) % 100).toString().padStart(2, "0");
  const day = (value % 100).toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

customElements.define("kin-item", KinItem);
