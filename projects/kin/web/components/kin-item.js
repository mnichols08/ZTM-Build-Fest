class KinItem extends HTMLElement {
  constructor() {
    super();
    this.record = null;
    this.isDisabled = false;
  }

  set item(value) {
    this.record = value;
    this.render();
  }

  set areaOptions(value) {
    this.areas = Array.isArray(value) ? value : [];
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button")) {
      control.disabled = this.isDisabled;
    }
    for (const control of this.querySelectorAll("select")) control.disabled = this.isDisabled;
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
    const action = document.createElement("div");
    action.className = "item-action";

    if (this.record.status === "active") {
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
    this.replaceChildren(row);
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
}

customElements.define("kin-item", KinItem);
