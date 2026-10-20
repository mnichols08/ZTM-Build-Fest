// Shopping mode (#403, #404, #408): the Shopping list for use in the shop.
// A full-screen modal dialog with one large native checkbox per item.
// Ticking an item completes it with the ordinary command (kin:complete-item,
// so Undo applies); it then moves to "In the basket", where unticking reopens
// it. The screen stays on while the mode is open, where the browser allows.
// It works offline like the rest of Kin; changes sync later.
import { ScreenWake } from "../wake-lock.js";

const WAKE_PREFERENCE = "kin.shopping.keepScreenOn";

function readPreference() {
  try { return globalThis.localStorage?.getItem(WAKE_PREFERENCE) !== "off"; } catch { return true; }
}
function writePreference(on) {
  try { globalThis.localStorage?.setItem(WAKE_PREFERENCE, on ? "on" : "off"); } catch { /* not kept */ }
}

class KinShoppingMode extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.basket = new Set();
    this.isDisabled = false;
    this.wake = new ScreenWake();
  }

  connectedCallback() {
    if (this.dialog) return;
    this.dialog = document.createElement("dialog");
    this.dialog.className = "shopping-mode";
    this.dialog.setAttribute("aria-labelledby", "shopping-mode-title");
    const top = document.createElement("div");
    top.className = "shopping-mode-top";
    const heading = document.createElement("h2");
    heading.id = "shopping-mode-title";
    heading.textContent = "Shopping";
    this.count = document.createElement("p");
    this.count.className = "shopping-mode-count";
    this.count.setAttribute("role", "status");
    this.done = document.createElement("button");
    this.done.type = "button";
    this.done.className = "shopping-mode-done primary-action";
    this.done.textContent = "Done shopping";
    this.done.addEventListener("click", () => this.close());
    const titles = document.createElement("div");
    titles.append(heading, this.count);
    top.append(titles, this.done);
    this.list = document.createElement("ul");
    this.list.className = "shopping-mode-list";
    this.list.setAttribute("aria-label", "To buy");
    this.empty = document.createElement("p");
    this.empty.className = "empty-state shopping-mode-empty";
    this.basketDetails = document.createElement("details");
    this.basketDetails.className = "shopping-mode-basket";
    this.basketSummary = document.createElement("summary");
    this.basketList = document.createElement("ul");
    this.basketList.className = "shopping-mode-list";
    this.basketList.setAttribute("aria-label", "In the basket");
    this.basketDetails.append(this.basketSummary, this.basketList);
    const wakeLabel = document.createElement("label");
    wakeLabel.className = "shopping-mode-wake";
    this.wakeSwitch = document.createElement("input");
    this.wakeSwitch.type = "checkbox";
    this.wakeSwitch.addEventListener("change", () => {
      writePreference(this.wakeSwitch.checked);
      if (this.wakeSwitch.checked) void this.wake.keepOn();
      else void this.wake.release();
    });
    wakeLabel.append(this.wakeSwitch, " Keep the screen on while shopping");
    wakeLabel.hidden = !this.wake.supported;
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener("close", () => void this.wake.release());
    // Ticking disables the boxes while Kin saves; this brings focus back.
    this.dialog.addEventListener("focusin", (event) => { if (event.target.dataset?.itemId) this.lastFocus = event.target.dataset.itemId; });
    this.dialog.append(top, this.list, this.empty, this.basketDetails, wakeLabel);
    this.append(this.dialog);
  }

  disconnectedCallback() {
    void this.wake.release();
  }

  /** Every Item (the projection's array); only Shopping ones show. */
  set items(value) {
    const next = Array.isArray(value) ? value : [];
    if (next === this.records) return;
    this.records = next;
    if (this.isOpen) this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const box of this.querySelectorAll(".shopping-mode-list input")) box.disabled = this.isDisabled;
    if (!this.isDisabled && this.isOpen) {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected)
        (this.querySelector(`.shopping-mode-list input[data-item-id="${this.lastFocus}"]`) ?? this.list.querySelector("input") ?? this.done)?.focus({ preventScroll: true });
    }
  }

  get isOpen() {
    return Boolean(this.dialog?.open);
  }

  open({ opener = null } = {}) {
    if (!this.dialog) this.connectedCallback();
    if (this.dialog.open) return;
    this.opener = opener;
    this.basket = new Set();
    this.basketDetails.open = false;
    this.render();
    this.dialog.showModal();
    this.wakeSwitch.checked = readPreference();
    if (this.wake.supported && this.wakeSwitch.checked) void this.wake.keepOn();
    (this.list.querySelector("input") ?? this.done).focus();
  }

  close() {
    void this.wake.release();
    if (this.dialog?.open) this.dialog.close();
    this.basket = new Set();
    const opener = this.opener;
    this.opener = null;
    // The list redraws while you shop, replacing its Start shopping button:
    // focus goes to the one there now.
    const target = opener?.isConnected ? opener : opener?.classList?.contains("start-shopping") ? document.querySelector("kin-today .start-shopping") : null;
    target?.focus();
  }

  render() {
    const shopping = this.records.filter((record) => record.classification === "shopping");
    const toBuy = shopping.filter((record) => record.status === "active");
    // The basket: what was ticked in this trip and is still completed.
    for (const id of [...this.basket]) if (!shopping.some((record) => record.itemId === id && record.status === "completed")) this.basket.delete(id);
    const inBasket = shopping.filter((record) => this.basket.has(record.itemId));
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    const focused = this.contains(active) ? active.dataset.itemId : lost ? this.lastFocus : null;
    this.list.replaceChildren(...toBuy.map((record) => this.row(record, false)));
    this.basketList.replaceChildren(...inBasket.map((record) => this.row(record, true)));
    this.count.textContent = toBuy.length === 0 ? "Nothing left to buy" : toBuy.length === 1 ? "1 thing to buy" : `${toBuy.length} things to buy`;
    this.empty.hidden = toBuy.length > 0;
    this.empty.textContent = inBasket.length ? "That's everything. Done shopping when you're ready." : "Nothing on the Shopping list.";
    this.basketDetails.hidden = inBasket.length === 0;
    this.basketSummary.textContent = inBasket.length === 1 ? "In the basket: 1" : `In the basket: ${inBasket.length}`;
    if (focused) {
      const same = this.querySelector(`.shopping-mode-list input[data-item-id="${focused}"]`);
      (same ?? this.list.querySelector("input") ?? this.done).focus({ preventScroll: true });
    }
  }

  row(record, checked) {
    const item = document.createElement("li");
    item.className = "shopping-mode-item";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.disabled = this.isDisabled;
    box.dataset.itemId = record.itemId;
    box.addEventListener("change", () => {
      if (box.checked) this.basket.add(record.itemId);
      else this.basket.delete(record.itemId);
      this.dispatchEvent(new CustomEvent(box.checked ? "kin:complete-item" : "kin:reopen-item", {
        bubbles: true, composed: true, detail: { itemId: record.itemId },
      }));
    });
    const text = document.createElement("span");
    text.className = "shopping-mode-text";
    text.textContent = record.text;
    label.append(box, text);
    item.append(label);
    return item;
  }
}

if (!customElements.get("kin-shopping-mode")) customElements.define("kin-shopping-mode", KinShoppingMode);
