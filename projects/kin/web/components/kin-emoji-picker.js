// The chat composer's emoji picker (#113): a small built-in table
// (web/chat/emoji.json), drawn by the OS font. It inserts at the cursor of
// its `target` textarea; the OS emoji keyboard works in the composer too.
//
// Keyboard: the toggle opens it with focus on the first emoji. Category
// buttons switch the grid. In the grid the arrow keys move (up and down by a
// row), Home and End go to the first and last, Enter or Space inserts, and
// Escape closes and returns focus to the toggle. The grid keeps one tab stop
// (a roving tabindex). Each emoji's accessible name is its short name.
import { loadEmojiTable } from "../chat/emoji.js";
import { MAX_CHAT_TEXT_CHARS } from "../chat/chat-room.js";

let pickers = 0;

class KinEmojiPicker extends HTMLElement {
  constructor() {
    super();
    this.target = null;
    this.table = null;
    this.category = null;
    this.active = 0;
  }

  connectedCallback() {
    if (this.toggle) return;
    // Not in the constructor: a new element may not get attributes there.
    this.id ||= `kin-emoji-picker-${++pickers}`;
    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "emoji-toggle";
    this.toggle.textContent = "😊";
    this.toggle.setAttribute("aria-label", "Emoji");
    this.toggle.setAttribute("aria-expanded", "false");
    this.toggle.setAttribute("aria-controls", `${this.id}-panel`);
    this.toggle.addEventListener("click", () => (this.panel.hidden ? void this.open() : this.close({ focusToggle: true })));
    this.panel = document.createElement("div");
    this.panel.id = `${this.id}-panel`;
    this.panel.className = "emoji-panel";
    this.panel.setAttribute("role", "group");
    this.panel.setAttribute("aria-label", "Emoji");
    this.panel.hidden = true;
    this.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.panel.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.close({ focusToggle: true });
    });
    this.addEventListener("focusout", (event) => {
      if (!this.panel.hidden && event.relatedTarget && !this.contains(event.relatedTarget)) this.close();
    });
    this.append(this.toggle, this.panel);
  }

  set disabled(value) {
    if (!this.toggle) return;
    this.toggle.disabled = Boolean(value);
    if (value) this.close();
  }

  async open() {
    this.toggle.setAttribute("aria-expanded", "true");
    this.panel.hidden = false;
    if (!this.table) {
      this.panel.replaceChildren(Object.assign(document.createElement("p"), { className: "emoji-status", textContent: "Loading emoji…" }));
      try {
        this.table = await loadEmojiTable();
      } catch {
        this.panel.replaceChildren(Object.assign(document.createElement("p"), { className: "emoji-status", textContent: "Kin couldn't load its emoji. Your device's emoji keyboard still works." }));
        return;
      }
      if (this.panel.hidden) return;
    }
    this.category ??= this.table.categories[0].id;
    this.build();
    this.focusEmoji(this.active);
  }

  close({ focusToggle = false } = {}) {
    if (!this.panel || this.panel.hidden) return;
    this.panel.hidden = true;
    this.toggle.setAttribute("aria-expanded", "false");
    if (focusToggle) this.toggle.focus();
  }

  build() {
    const tabs = document.createElement("div");
    tabs.className = "emoji-categories";
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Emoji categories");
    for (const category of this.table.categories) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = category.emoji[0][0];
      button.setAttribute("aria-label", category.label);
      button.title = category.label;
      button.setAttribute("aria-pressed", String(category.id === this.category));
      button.addEventListener("click", () => {
        this.category = category.id;
        this.active = 0;
        this.build();
        this.panel.querySelector(`.emoji-categories [aria-pressed="true"]`)?.focus();
      });
      tabs.append(button);
    }
    const current = this.table.categories.find((category) => category.id === this.category) ?? this.table.categories[0];
    const heading = document.createElement("p");
    heading.className = "emoji-heading";
    heading.id = `${this.id}-heading`;
    heading.textContent = current.label;
    this.grid = document.createElement("div");
    this.grid.className = "emoji-grid";
    this.grid.setAttribute("role", "group");
    this.grid.setAttribute("aria-labelledby", heading.id);
    this.active = Math.min(this.active, current.emoji.length - 1);
    current.emoji.forEach(([emoji, name], index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = emoji;
      button.setAttribute("aria-label", name);
      button.title = name;
      button.tabIndex = index === this.active ? 0 : -1;
      button.addEventListener("click", () => this.insert(emoji));
      button.addEventListener("focus", () => this.setActive(index));
      this.grid.append(button);
    });
    this.grid.addEventListener("keydown", (event) => this.onGridKey(event));
    this.panel.replaceChildren(tabs, heading, this.grid);
  }

  setActive(index) {
    const buttons = this.grid.children;
    if (buttons[this.active]) buttons[this.active].tabIndex = -1;
    this.active = index;
    buttons[index].tabIndex = 0;
  }

  focusEmoji(index) {
    const button = this.grid?.children[index];
    if (!button) return;
    this.setActive(index);
    button.focus();
  }

  /** Emoji per row, from the layout (the grid wraps to the panel's width). */
  columns() {
    const buttons = [...this.grid.children];
    const top = buttons[0]?.offsetTop;
    const count = buttons.findIndex((button) => button.offsetTop !== top);
    return count > 0 ? count : buttons.length || 1;
  }

  onGridKey(event) {
    const count = this.grid.children.length;
    const columns = this.columns();
    const moves = {
      ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns,
      Home: -Infinity, End: Infinity,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const step = moves[event.key];
    const next = step === -Infinity ? 0 : step === Infinity ? count - 1 : this.active + step;
    if (next < 0 || next >= count) return;
    this.focusEmoji(next);
  }

  /** Inserts at the target's cursor (replacing a selection) and keeps the
   * picker open for another; refuses past the message length limit. */
  insert(emoji) {
    const input = this.target;
    if (!input || input.disabled) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const next = input.value.slice(0, start) + emoji + input.value.slice(end);
    if ([...next].length > MAX_CHAT_TEXT_CHARS) {
      this.dispatchEvent(new CustomEvent("kin:emoji-refused", { bubbles: true, detail: { reason: "too-long" } }));
      return;
    }
    input.setRangeText(emoji, start, end, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new CustomEvent("kin:emoji-inserted", { bubbles: true, detail: { emoji } }));
  }
}

if (!customElements.get("kin-emoji-picker")) customElements.define("kin-emoji-picker", KinEmojiPicker);

export { KinEmojiPicker };
