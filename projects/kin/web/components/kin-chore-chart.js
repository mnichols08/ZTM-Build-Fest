// <kin-chore-chart> (#676, ADR 0022 §6): one card per person on the chore
// chart, in their colour, with their name, points this week and reward
// progress ("12 of 20 for Movie night"), today's jobs with big tick boxes
// and pictures, and the rest of the week below.
//
// Self-contained so the kitchen display can reuse it: it only renders and
// reports. Give it `cards` (chores/chore-chart-view.js buildChoreChart);
// optionally `editable` (Adults: "Set reward" on each child's card) and the
// `size="display"` attribute for the kitchen screen's larger targets. It
// dispatches, bubbling and composed:
// - `kin:chore-toggle` { memberId, kind, id, occurrenceKey, done, text } when
//   a tick box changes (the host records it; the next `cards` shows it);
// - `kin:chore-reward` { memberId, goal, text } to set a reward (goal 0 and
//   no text removes it).
// Household text is only ever set as textContent.

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });

function dayName(date) {
  const value = new Date(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100);
  return dayFormat.format(value);
}

class KinChoreChart extends HTMLElement {
  constructor() {
    super();
    this.cardsValue = [];
    this.loaded = false;
    this.isDisabled = false;
    this.isEditable = false;
    this.editing = null;
    this.previewProvider = null;
    this.openWeeks = new Set();
  }

  connectedCallback() {
    if (!this.list) this.build();
    this.render();
  }

  /** The cards to draw (buildChoreChart). */
  set cards(value) {
    this.cardsValue = Array.isArray(value) ? value : [];
    this.loaded = true;
    if (this.editing && !this.cardsValue.some((card) => card.memberId === this.editing)) this.editing = null;
    this.render();
  }
  get cards() { return this.cardsValue; }

  /** Adults may set each child's reward here. */
  set editable(value) {
    this.isEditable = Boolean(value);
    if (!this.isEditable) this.editing = null;
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("input, button")) control.disabled = this.isDisabled || control.dataset.locked === "true";
  }

  /** (attachment row) -> object URL or null, for photo pictures. */
  set previews(provider) {
    this.previewProvider = typeof provider === "function" ? provider : null;
    this.render();
  }

  build() {
    this.classList.add("chore-chart");
    this.list = document.createElement("ul");
    this.list.className = "chore-cards";
    this.list.setAttribute("aria-label", "Chore chart");
    this.empty = document.createElement("p");
    this.empty.className = "chore-empty";
    this.empty.hidden = true;
    this.append(this.empty, this.list);
  }

  focusedKey() {
    const active = document.activeElement;
    return active && this.contains(active) ? active.dataset.focusKey ?? null : null;
  }

  render() {
    if (!this.list) return;
    const focusKey = this.focusedKey();
    this.empty.hidden = this.cardsValue.length > 0;
    this.empty.textContent = this.loaded
      ? "Nobody is on the chore chart yet. Children appear here once they've joined the household."
      : "Loading the chore chart…";
    this.list.replaceChildren(...this.cardsValue.map((card) => this.card(card)));
    if (focusKey) [...this.querySelectorAll("[data-focus-key]")].find((node) => node.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }

  card(card) {
    const item = document.createElement("li");
    item.className = "chore-card";
    item.dataset.memberId = card.memberId;
    item.style.setProperty("--chore-colour", card.colour);
    const headingId = `chore-card-${card.memberId}`;
    const section = document.createElement("section");
    section.setAttribute("aria-labelledby", headingId);
    const header = document.createElement("header");
    header.className = "chore-card-header";
    const heading = document.createElement("h2");
    heading.id = headingId;
    heading.className = "chore-card-name";
    heading.textContent = card.name;
    const points = document.createElement("p");
    points.className = "chore-points";
    points.textContent = card.line;
    header.append(heading, points);
    if (card.reward) {
      const progress = document.createElement("progress");
      progress.className = "chore-progress";
      progress.max = card.reward.goal;
      progress.value = Math.min(card.points, card.reward.goal);
      progress.setAttribute("aria-label", `${card.name}: ${card.line}`);
      header.append(progress);
    }
    section.append(header);

    const todayHeading = document.createElement("h3");
    todayHeading.className = "chore-day-heading";
    todayHeading.id = `${headingId}-today`;
    todayHeading.textContent = "Today";
    section.append(todayHeading);
    if (card.today.length) {
      const list = document.createElement("ul");
      list.className = "chore-list";
      list.setAttribute("aria-labelledby", todayHeading.id);
      for (const chore of card.today) list.append(this.todayRow(card, chore));
      section.append(list);
    } else {
      const none = document.createElement("p");
      none.className = "chore-none";
      none.textContent = "No jobs today.";
      section.append(none);
    }
    const left = card.today.filter((chore) => !chore.done).length;
    if (card.today.length && !left) {
      const all = document.createElement("p");
      all.className = "chore-all-done";
      all.textContent = "All done for today!";
      section.append(all);
    }

    if (card.week.length) {
      const week = document.createElement("details");
      week.className = "chore-week";
      // Stays open across redraws.
      week.open = this.openWeeks.has(card.memberId);
      week.addEventListener("toggle", () => {
        if (week.open) this.openWeeks.add(card.memberId);
        else this.openWeeks.delete(card.memberId);
      });
      const summary = document.createElement("summary");
      summary.textContent = "The rest of the week";
      week.append(summary);
      for (const day of card.week) {
        const name = document.createElement("h4");
        name.className = "chore-week-day";
        name.textContent = dayName(day.date);
        const list = document.createElement("ul");
        list.className = "chore-week-list";
        for (const chore of day.chores) {
          const row = document.createElement("li");
          row.className = `chore-week-row${chore.done ? " is-done" : ""}`;
          row.dataset.key = chore.key;
          const state = document.createElement("span");
          state.className = "chore-week-state";
          state.textContent = chore.done ? "✓ Done" : "Not done";
          const text = document.createElement("span");
          text.textContent = `${chore.picture?.emoji ? `${chore.picture.emoji} ` : ""}${chore.text}`;
          row.append(text, " · ", state);
          list.append(row);
        }
        week.append(name, list);
      }
      section.append(week);
    }
    if (this.isEditable && !card.adult) section.append(this.rewardEditor(card));
    item.append(section);
    return item;
  }

  todayRow(card, chore) {
    const row = document.createElement("li");
    row.className = `chore-row${chore.done ? " is-done" : ""}`;
    row.dataset.key = chore.key;
    const label = document.createElement("label");
    label.className = "chore-tick";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "chore-box";
    box.checked = chore.done;
    box.dataset.focusKey = `${card.memberId}:${chore.key}`;
    // Only today's jobs tick; a day already gone shows as it was.
    box.dataset.locked = chore.today ? "false" : "true";
    box.disabled = this.isDisabled || !chore.today;
    box.addEventListener("change", () => this.emit("kin:chore-toggle", {
      memberId: card.memberId, kind: chore.kind, id: chore.id, occurrenceKey: chore.occurrenceKey, done: box.checked, text: chore.text,
    }));
    const picture = document.createElement("span");
    picture.className = "chore-picture";
    picture.setAttribute("aria-hidden", "true");
    const url = chore.picture?.attachment ? this.previewProvider?.(chore.picture.attachment) : null;
    if (chore.picture?.emoji) picture.textContent = chore.picture.emoji;
    else if (url) {
      const image = document.createElement("img");
      image.alt = "";
      image.src = url;
      picture.append(image);
    } else picture.classList.add("is-empty");
    const text = document.createElement("span");
    text.className = "chore-text";
    text.textContent = chore.text;
    const worth = document.createElement("span");
    worth.className = "chore-worth";
    worth.textContent = chore.points === 1 ? "1 point" : `${chore.points} points`;
    label.append(box, picture, text, worth);
    row.append(label);
    return row;
  }

  rewardEditor(card) {
    const wrap = document.createElement("div");
    wrap.className = "chore-reward";
    const open = this.editing === card.memberId;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary chore-reward-toggle";
    toggle.textContent = card.reward ? "Change reward" : "Set a reward";
    toggle.setAttribute("aria-label", `${toggle.textContent} for ${card.name}`);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.dataset.focusKey = `${card.memberId}:reward`;
    toggle.disabled = this.isDisabled;
    toggle.addEventListener("click", () => {
      this.editing = open ? null : card.memberId;
      this.render();
      if (!open) this.querySelector(`[data-focus-key="${card.memberId}:goal"]`)?.focus();
    });
    wrap.append(toggle);
    if (!open) return wrap;
    const form = document.createElement("form");
    form.className = "chore-reward-form";
    const goalId = `chore-goal-${card.memberId}`, textId = `chore-reward-text-${card.memberId}`;
    const goalLabel = document.createElement("label");
    goalLabel.htmlFor = goalId;
    goalLabel.textContent = "Points to reach this week";
    const goal = document.createElement("input");
    goal.id = goalId;
    goal.type = "number";
    goal.min = "1";
    goal.max = "1000";
    goal.required = true;
    goal.inputMode = "numeric";
    goal.value = String(card.reward?.goal ?? 20);
    goal.dataset.focusKey = `${card.memberId}:goal`;
    const textLabel = document.createElement("label");
    textLabel.htmlFor = textId;
    textLabel.textContent = "Reward";
    const text = document.createElement("input");
    text.id = textId;
    text.type = "text";
    text.required = true;
    text.maxLength = 120;
    text.placeholder = "Movie night";
    text.value = card.reward?.text ?? "";
    text.dataset.focusKey = `${card.memberId}:reward-text`;
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save reward";
    save.disabled = this.isDisabled;
    form.append(goalLabel, goal, textLabel, text, save);
    if (card.reward) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Remove reward";
      remove.disabled = this.isDisabled;
      remove.addEventListener("click", () => {
        this.editing = null;
        this.emit("kin:chore-reward", { memberId: card.memberId, goal: 0, text: "" });
      });
      form.append(remove);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = Number(goal.value);
      if (!form.reportValidity() || !Number.isInteger(value)) return;
      this.editing = null;
      this.emit("kin:chore-reward", { memberId: card.memberId, goal: value, text: text.value });
    });
    wrap.append(form);
    return wrap;
  }

  emit(type, detail) {
    if (this.isDisabled) return;
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
  }
}

if (!customElements.get("kin-chore-chart")) customElements.define("kin-chore-chart", KinChoreChart);
