class KinAreas extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.isDisabled = false;
  }

  set areas(value) {
    this.records = Array.isArray(value) ? value : [];
    this.render();
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    for (const control of this.querySelectorAll("button, input"))
      control.disabled = this.isDisabled;
    if (!this.isDisabled && this.deferredFocus?.isConnected) {
      const target = this.deferredFocus;
      this.deferredFocus = null;
      target.focus();
    }
  }

  render(focusId = null) {
    const priorFocus = this.pendingFocus ?? (this.contains(document.activeElement)
      ? document.activeElement.dataset.focusId ?? (document.activeElement.id === "area-create-name" ? "create-area" : null)
      : focusId);
    this.pendingFocus = null;
    const section = document.createElement("section");
    section.className = "area-section card";
    const heading = document.createElement("h2");
    heading.textContent = "Areas";
    heading.tabIndex = -1;
    heading.dataset.focusId = "area-heading";
    const intro = document.createElement("p");
    intro.textContent = "Areas help keep household things together.";
    section.append(heading, intro);

    const form = document.createElement("form");
    form.className = "area-create-form";
    const label = document.createElement("label");
    label.htmlFor = "area-create-name";
    label.textContent = "New Area";
    const input = document.createElement("input");
    input.id = "area-create-name";
    input.dataset.focusId = "create-area";
    input.name = "name";
    input.maxLength = 96;
    input.autocomplete = "off";
    input.required = true;
    input.setAttribute("aria-describedby", "area-name-help area-name-error");
    const help = document.createElement("small");
    help.id = "area-name-help";
    help.textContent = "Up to 48 characters.";
    const error = this.makeNameError();
    const add = document.createElement("button");
    add.type = "submit";
    add.textContent = "Add Area";
    form.append(label, input, help, error, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitName(input, error, "create-area", {});
    });
    section.append(form);

    const active = this.records.filter((area) => !area.archived);
    const archived = this.records.filter((area) => area.archived);
    if (!this.records.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No Areas yet. You can add one whenever it helps.";
      section.append(empty);
    }
    if (active.length) section.append(this.makeList(active, false));
    if (archived.length) {
      const archivedHeading = document.createElement("h3");
      archivedHeading.textContent = "Archived Areas";
      section.append(archivedHeading, this.makeList(archived, true));
    }
    this.replaceChildren(section);
    this.disabled = this.isDisabled;
    if (priorFocus) {
      const target = [...this.querySelectorAll("[data-focus-id]")].find((node) => node.dataset.focusId === priorFocus);
      if (target?.disabled) this.deferredFocus = target;
      else target?.focus();
    }
  }

  makeList(records, archived) {
    const list = document.createElement("ul");
    list.className = "area-list";
    for (const area of records) {
      const row = document.createElement("li");
      row.className = "area-row";
      const name = document.createElement("span");
      name.className = "area-name";
      name.textContent = this.displayName(area);
      row.append(name);
      if (!archived) {
        const rename = document.createElement("button");
        rename.type = "button";
        rename.textContent = "Rename";
        rename.setAttribute("aria-label", `Rename ${area.name}`);
        rename.dataset.focusId = `rename-${area.areaId}`;
        rename.addEventListener("click", () => this.editName(row, area));
        const archive = document.createElement("button");
        archive.type = "button";
        archive.className = "archive-button";
        archive.textContent = "Archive";
        archive.setAttribute("aria-label", `Archive ${area.name}`);
        archive.dataset.focusId = `archive-${area.areaId}`;
        archive.addEventListener("click", () => this.confirmArchive(row, area));
        row.append(rename, archive);
      } else {
        const label = document.createElement("span");
        label.className = "area-archived-label";
        label.textContent = "Archived";
        row.append(label);
      }
      list.append(row);
    }
    return list;
  }

  displayName(area) {
    const duplicates = this.records.filter((candidate) => candidate.name.toLowerCase() === area.name.toLowerCase());
    return duplicates.length > 1 ? `${area.name} · ${area.areaId.slice(-4)}` : area.name;
  }

  editName(row, area) {
    const form = document.createElement("form");
    form.className = "area-edit-form";
    const label = document.createElement("label");
    label.textContent = `Rename ${area.name}`;
    const input = document.createElement("input");
    input.value = area.name;
    input.maxLength = 96;
    input.required = true;
    const error = this.makeNameError();
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save name";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.render(`rename-${area.areaId}`));
    form.append(label, input, error, save, cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitName(input, error, "rename-area", { areaId: area.areaId });
    });
    row.replaceChildren(form);
    input.focus();
    input.select();
  }

  makeNameError() {
    const error = document.createElement("small");
    error.id = "area-name-error";
    error.className = "area-name-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    return error;
  }

  submitName(input, error, action, detail) {
    const result = validateAreaName(input.value);
    if (result.error) {
      error.textContent = result.error;
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", `${input.id ? "area-name-help " : ""}${error.id}`);
      return;
    }
    input.value = result.value;
    input.removeAttribute("aria-invalid");
    error.hidden = true;
    this.dispatch(action, { ...detail, name: result.value });
  }

  confirmArchive(row, area) {
    const prompt = document.createElement("div");
    prompt.className = "area-confirm";
    prompt.setAttribute("role", "group");
    prompt.setAttribute("aria-label", `Archive ${area.name}`);
    const text = document.createElement("span");
    text.textContent = `Keep existing links to ${area.name} for household history?`;
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "Archive Area";
    confirm.addEventListener("click", () => this.dispatch("archive-area", { areaId: area.areaId }));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.render(`archive-${area.areaId}`));
    prompt.append(text, confirm, cancel);
    row.replaceChildren(prompt);
    confirm.focus();
  }

  dispatch(action, detail) {
    this.pendingFocus = action === "rename-area" ? `rename-${detail.areaId}`
      : action === "create-area" ? "create-area" : "area-heading";
    this.dispatchEvent(new CustomEvent("kin:area-intent", {
      detail: { action, ...detail }, bubbles: true, composed: true,
    }));
  }

  focus() { this.querySelector("h2")?.focus(); }
}

function validateAreaName(raw) {
  const value = raw.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
  if (!value) return { value, error: "Enter an Area name." };
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value))
    return { value, error: "Area names can't contain control characters." };
  if (Array.from(value).length > 48) return { value, error: "Area names can be up to 48 characters." };
  if (new TextEncoder().encode(value).length > 96) return { value, error: "This Area name is too long." };
  return { value, error: null };
}

customElements.define("kin-areas", KinAreas);
