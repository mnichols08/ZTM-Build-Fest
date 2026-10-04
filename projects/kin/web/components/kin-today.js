class KinToday extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.isDisabled = false;
    this.display = "all";
  }

  connectedCallback() {
    this.render();
  }

  set items(value) {
    this.records = Array.isArray(value) ? value : [];
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const item of this.querySelectorAll("kin-item")) {
      item.disabled = this.isDisabled;
    }
    if (!this.isDisabled && this.deferredFocus?.isConnected) {
      const target = this.deferredFocus;
      this.deferredFocus = null;
      target.focus();
    }
  }

  render() {
    const focus = this.pendingFocus ?? this.captureFocus();
    this.pendingFocus = null;
    const sections = [
      ["today", "Today"],
      ["need", "Needs"],
    ].filter(([classification]) => this.display === "all" || classification === this.display)
      .map(([classification, title]) => {
      const section = document.createElement("section");
      section.className = "today-section";
      const heading = document.createElement("h2");
      heading.textContent = title;
      heading.tabIndex = -1;
      section.append(heading);

      const records = this.records.filter(
        (record) =>
          record.classification === classification &&
          record.status !== "archived",
      );
      const active = records.filter((record) => record.status === "active");
      const completed = records.filter(
        (record) => record.status === "completed",
      );
      if (active.length > 0) {
        section.append(this.createList(active));
      }
      if (completed.length > 0) {
        const completedHeading = document.createElement("h3");
        completedHeading.className = "completed-heading";
        completedHeading.textContent = "Completed";
        section.append(completedHeading, this.createList(completed));
      }
      if (records.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "Nothing here yet.";
        section.append(empty);
      }
      return section;
    });
    this.replaceChildren(...sections);
    this.restoreFocus(focus);
  }

  captureFocus() {
    const control = document.activeElement;
    if (!this.contains(control)) return null;
    const row = control.closest("kin-item");
    return {
      control,
      itemId: control.dataset.itemId,
      action: control.dataset.itemAction,
      index: row ? [...this.querySelectorAll("kin-item")].indexOf(row) : -1,
    };
  }

  rememberFocus() {
    this.pendingFocus = this.captureFocus();
  }

  restoreFocus(focus) {
    if (!focus) return;
    if (focus.control.isConnected) {
      focus.control.focus();
      return;
    }
    const buttons = [...this.querySelectorAll("kin-item button[data-item-id]")];
    const sameItem = buttons.filter((button) => button.dataset.itemId === focus.itemId);
    const target = sameItem.find((button) => button.dataset.itemAction === focus.action)
      ?? sameItem[0]
      ?? buttons[Math.min(Math.max(0, focus.index), buttons.length - 1)];
    const next = target ?? this.querySelector(".today-section h2");
    if (next?.disabled) this.deferredFocus = next;
    else next?.focus();
  }

  createList(records) {
    const list = document.createElement("ul");
    list.className = "item-list";
    for (const record of records) {
      const listItem = document.createElement("li");
      const item = document.createElement("kin-item");
      item.item = record;
      item.disabled = this.isDisabled;
      listItem.append(item);
      list.append(listItem);
    }
    return list;
  }
}

customElements.define("kin-today", KinToday);
