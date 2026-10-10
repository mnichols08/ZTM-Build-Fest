class KinToday extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.areaRecords = [];
    this.pinRecords = [];
    this.attachmentRecords = [];
    this.isDisabled = false;
    this.display = "all";
    this.expandedSteps = new Set();
    this.onToggleSteps = (event) => {
      const { itemId } = event.detail;
      if (this.expandedSteps.has(itemId)) this.expandedSteps.delete(itemId);
      else this.expandedSteps.add(itemId);
      this.pendingFocus = this.captureFocus();
      this.render();
    };
  }

  connectedCallback() {
    this.addEventListener("kin:toggle-item-steps", this.onToggleSteps);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("kin:toggle-item-steps", this.onToggleSteps);
  }

  set items(value) {
    this.records = Array.isArray(value) ? value : [];
    this.render();
  }

  set areas(value) {
    this.areaRecords = Array.isArray(value) ? value : [];
    this.render();
  }

  set pins(value) {
    this.pinRecords = Array.isArray(value) ? value : [];
    this.render();
  }

  set attachments(value) { this.attachmentRecords = Array.isArray(value) ? value : []; this.render(); }
  set responsibilityContext(value) { this.ownerContext = value ?? {}; this.render(); }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const item of this.querySelectorAll("kin-item")) {
      item.disabled = this.isDisabled;
    }
    for (const control of this.querySelectorAll("button, input, select")) {
      control.disabled = this.isDisabled || control.dataset.domainDisabled === "true";
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
    const sections = [];
    if (this.display === "today") {
      const quick = this.createQuickAccess();
      if (quick) sections.push(quick);
    }
    sections.push(...[
      ["today", "Today"],
      ["need", "Needs"],
      ["shopping", "Shopping"],
      ["staple", "Staples"],
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
    }));
    this.replaceChildren(...sections);
    this.restoreFocus(focus);
  }

  createQuickAccess() {
    const targets = this.pinRecords
      .filter((pin) => pin.targetKind === "item")
      .map((pin) => this.records.find((item) => item.itemId === pin.targetId && item.status !== "archived"))
      .filter(Boolean);
    if (!targets.length) return null;
    const section = document.createElement("section");
    section.className = "today-section quick-access";
    const heading = document.createElement("h2");
    heading.textContent = "Quick access";
    section.append(heading);
    const list = document.createElement("ul");
    list.className = "item-list";
    for (const item of targets) {
      const row = document.createElement("li");
      const entry = document.createElement("div");
      entry.className = "quick-access-row";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "quick-access-open";
      open.textContent = item.text;
      open.setAttribute("aria-label", `Open ${item.text}`);
      open.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:open-pin", {
        detail: { itemId: item.itemId }, bubbles: true, composed: true,
      })));
      const unpin = document.createElement("button");
      unpin.type = "button";
      unpin.textContent = "Unpin";
      unpin.setAttribute("aria-label", `Unpin ${item.text}`);
      unpin.disabled = this.isDisabled;
      unpin.addEventListener("click", () => this.dispatchEvent(new CustomEvent("kin:pin-intent", {
        detail: { targetKind: "item", targetId: item.itemId, pinned: false }, bubbles: true, composed: true,
      })));
      entry.append(open, unpin);
      row.append(entry);
      list.append(row);
    }
    section.append(list);
    return section;
  }

  captureFocus() {
    const control = this.contains(document.activeElement)
      ? document.activeElement
      : this.deferredFocus?.isConnected ? this.deferredFocus : null;
    if (!this.contains(control)) return null;
    const row = control.closest("kin-item");
    return {
      control,
      itemId: control.dataset.itemId,
      action: control.dataset.itemAction,
      isAreaSelect: control.matches?.(".item-area-select") ?? false,
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
    if (focus.isAreaSelect) {
      const select = [...this.querySelectorAll(".item-area-select")].find((node) => node.dataset.itemId === focus.itemId);
      if (select) {
        if (select.disabled) this.deferredFocus = select;
        else select.focus();
        return;
      }
    }
    const controls = [...this.querySelectorAll("kin-item [data-item-id]")];
    const sameItem = controls.filter((control) => control.dataset.itemId === focus.itemId);
    const replacementAction = {
      complete: "reopen",
      reopen: "complete",
      "archive-item-step": "toggle-step",
      pin: "unpin",
      unpin: "pin",
    }[focus.action];
    const target = sameItem.find((control) => control.dataset.itemAction === focus.action)
      ?? (replacementAction
        ? sameItem.find((control) => control.dataset.itemAction === replacementAction)
        : null)
      ?? sameItem.find((control) => control.dataset.itemAction === "add-step")
      ?? sameItem[0]
      ?? controls[Math.min(Math.max(0, focus.index), controls.length - 1)];
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
      item.attachments = this.attachmentRecords;
    item.responsibilityContext = this.ownerContext;
      item.areaOptions = this.areaRecords;
      item.pinned = this.pinRecords.some((pin) => pin.targetKind === "item" && pin.targetId === record.itemId);
      item.pinLimitReached = this.pinRecords.length >= 10;
      item.checklistExpanded = this.expandedSteps.has(record.itemId);
      item.disabled = this.isDisabled;
      listItem.append(item);
      list.append(listItem);
    }
    return list;
  }
}

customElements.define("kin-today", KinToday);
