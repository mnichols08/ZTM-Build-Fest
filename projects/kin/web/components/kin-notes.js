class KinNotes extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.referenceRecords = [];
    this.areaRecords = [];
    this.disabledState = false;
    this.editor = { noteId: null, title: "", body: "", areaId: "" };
    this.pendingFocus = null;
    this.instanceId = `notes-${++KinNotes.instances}`;
  }

  set notes(value) { this.records = Array.isArray(value) ? value : []; this.render(); }
  set references(value) { this.referenceRecords = Array.isArray(value) ? value : []; this.render(); }
  set areas(value) { this.areaRecords = Array.isArray(value) ? value : []; this.render(); }
  set disabled(value) { this.disabledState = Boolean(value); this.render(); }

  render() {
    const focused = this.pendingFocus ?? (this.contains(document.activeElement)
      ? document.activeElement.dataset.focusId
      : null);
    this.pendingFocus = null;
    const id = (name) => `${this.instanceId}-${name}`;
    const section = document.createElement("section");
    section.className = "notes-section card";
    const heading = document.createElement("h2");
    heading.textContent = "Notes";
    heading.tabIndex = -1;
    heading.dataset.focusId = "heading";
    section.append(heading);

    const form = document.createElement("form");
    const titleId = id("title");
    const titleLabel = document.createElement("label");
    titleLabel.htmlFor = titleId;
    titleLabel.textContent = "Title";
    const title = document.createElement("input");
    title.id = titleId;
    title.name = "title";
    title.required = true;
    title.value = this.editor.title;
    title.dataset.focusId = "title";
    const titleHelp = document.createElement("small");
    titleHelp.id = id("title-help");
    titleHelp.textContent = "Up to 80 characters and 256 UTF-8 bytes.";
    const titleError = this.makeError(id("title-error"));
    title.setAttribute("aria-describedby", `${titleHelp.id} ${titleError.id}`);

    const bodyId = id("body");
    const bodyLabel = document.createElement("label");
    bodyLabel.htmlFor = bodyId;
    bodyLabel.textContent = "Body";
    const body = document.createElement("textarea");
    body.id = bodyId;
    body.name = "body";
    body.value = this.editor.body;
    body.dataset.focusId = "body";
    const bodyHelp = document.createElement("small");
    bodyHelp.id = id("body-help");
    bodyHelp.textContent = "Plain text, up to 4096 UTF-8 bytes.";
    const bodyError = this.makeError(id("body-error"));
    body.setAttribute("aria-describedby", `${bodyHelp.id} ${bodyError.id}`);

    const areaId = id("area");
    const areaLabel = document.createElement("label");
    areaLabel.htmlFor = areaId;
    areaLabel.textContent = "Area (optional)";
    const area = document.createElement("select");
    area.id = areaId;
    area.name = "areaId";
    area.dataset.focusId = "area";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No area";
    area.append(none);
    for (const item of this.areaRecords.filter((candidate) => !candidate.archived)) {
      const option = document.createElement("option");
      option.value = item.areaId;
      option.textContent = item.name;
      area.append(option);
    }
    if (this.editor.areaId && ![...area.options].some((option) => option.value === this.editor.areaId)) {
      const oldArea = this.areaRecords.find((candidate) => candidate.areaId === this.editor.areaId);
      const option = document.createElement("option");
      option.value = this.editor.areaId;
      option.textContent = `${oldArea?.name ?? "Archived Area"} (archived)`;
      area.append(option);
    }
    area.value = this.editor.areaId;

    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = this.editor.noteId ? "Save changes" : "Save note";
    save.dataset.focusId = "save";
    for (const [control, key] of [[title, "title"], [body, "body"], [area, "areaId"]]) {
      const update = () => { this.editor[key] = control.value; };
      control.addEventListener("input", update);
      control.addEventListener("change", update);
    }
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.editor = { noteId: this.editor.noteId, title: title.value, body: body.value, areaId: area.value };
      const result = KinNotes.validateText(title.value, body.value);
      this.showFieldError(title, titleError, result.field === "title" ? result.error : "");
      this.showFieldError(body, bodyError, result.field === "body" ? result.error : "");
      if (result.error) {
        (result.field === "title" ? title : body).focus();
        return;
      }
      this.editor.title = result.title;
      this.pendingFocus = "title";
      this.dispatch(this.editor.noteId ? "update-note" : "create-note", {
        ...(this.editor.noteId ? { noteId: this.editor.noteId } : {}),
        title: result.title,
        body: result.body,
        areaId: area.value || null,
      });
    });
    form.append(titleLabel, title, titleHelp, titleError, bodyLabel, body, bodyHelp, bodyError, areaLabel, area, save);
    section.append(form);

    const activeNotes = this.records.filter((note) => !note.archived);
    if (!activeNotes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No notes yet. Keep a household detail handy here.";
      section.append(empty);
    }
    const list = document.createElement("ul");
    for (const note of activeNotes) {
      const row = document.createElement("li");
      row.className = "note-row";
      const name = document.createElement("h3");
      name.textContent = note.title;
      const text = document.createElement("p");
      text.className = "note-body";
      text.textContent = note.body;
      row.append(name, text);
      const linkedArea = this.areaRecords.find((candidate) => candidate.areaId === note.areaId);
      if (note.areaId) {
        const context = document.createElement("small");
        context.textContent = linkedArea ? `${linkedArea.name}${linkedArea.archived ? " (archived Area)" : ""}` : "Archived Area";
        row.append(context);
      }
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.dataset.focusId = `edit-${note.noteId}`;
      edit.addEventListener("click", () => {
        this.editor = { noteId: note.noteId, title: note.title, body: note.body, areaId: note.areaId ?? "" };
        this.pendingFocus = "title";
        this.render();
        this.querySelector(`#${id("title")}`)?.focus();
      });
      const archive = document.createElement("button");
      archive.type = "button";
      archive.textContent = "Archive";
      archive.dataset.focusId = `archive-${note.noteId}`;
      archive.addEventListener("click", () => {
        this.pendingFocus = activeNotes.length > 1
          ? `edit-${activeNotes.find((item) => item.noteId !== note.noteId).noteId}`
          : "heading";
        this.dispatch("archive-note", { noteId: note.noteId });
      });
      row.append(edit, archive);
      list.append(row);
    }
    section.append(list);

    const references = document.createElement("section"); references.className = "reference-records";
    const referenceHeading = document.createElement("h2"); referenceHeading.textContent = "Household reference";
    const referenceHint = document.createElement("p"); referenceHint.textContent = "Keep practical details such as Wi-Fi names, appliance models, or service contacts. Values are shared with the household.";
    const referenceForm = document.createElement("form");
    const referenceTitle = document.createElement("input"); referenceTitle.required = true; referenceTitle.maxLength = 128; referenceTitle.placeholder = "Record title"; referenceTitle.setAttribute("aria-label", "Reference record title");
    const referenceArea = document.createElement("select"); referenceArea.setAttribute("aria-label", "Reference record Area");
    const noReferenceArea = document.createElement("option"); noReferenceArea.value = ""; noReferenceArea.textContent = "No Area"; referenceArea.append(noReferenceArea);
    for (const item of this.areaRecords.filter((candidate) => !candidate.archived)) { const option = document.createElement("option"); option.value = item.areaId; option.textContent = item.name; referenceArea.append(option); }
    const referenceFields = document.createElement("textarea"); referenceFields.required = true; referenceFields.rows = 4; referenceFields.placeholder = "One field per line, for example: Network name: Home"; referenceFields.setAttribute("aria-label", "Reference fields");
    const referenceSave = document.createElement("button"); referenceSave.type = "submit"; referenceSave.textContent = "Save reference";
    let editing = null;
    referenceForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const fields = referenceFields.value.split(/\r?\n/).map((line, index) => {
        const split = line.indexOf(":");
        const label = split < 0 ? "" : line.slice(0, split).trim();
        const value = split < 0 ? line : line.slice(split + 1).trim();
        const prior = editing?.fields[index];
        return { fieldId: prior?.fieldId ?? crypto.randomUUID().replaceAll("-", ""), label, value };
      });
      if (!referenceTitle.value.trim() || fields.length > 16 || fields.some((field) => !field.label)) return;
      this.dispatch("save-reference-record", { recordId: editing?.recordId ?? null, title: referenceTitle.value, areaId: referenceArea.value || null, fields });
      editing = null; referenceTitle.value = ""; referenceFields.value = ""; referenceArea.value = ""; referenceSave.textContent = "Save reference";
    });
    referenceForm.append(referenceTitle, referenceArea, referenceFields, referenceSave);
    const referenceList = document.createElement("ul");
    for (const record of this.referenceRecords.filter((item) => !item.archived)) {
      const row = document.createElement("li"); const title = document.createElement("h3"); title.textContent = record.title; row.append(title);
      const fields = document.createElement("dl"); for (const field of record.fields) { const label = document.createElement("dt"); label.textContent = field.label; const value = document.createElement("dd"); value.textContent = field.value; fields.append(label, value); } row.append(fields);
      if (record.areaId) { const linked = this.areaRecords.find((candidate) => candidate.areaId === record.areaId); const areaText = document.createElement("small"); areaText.textContent = linked ? `${linked.name}${linked.archived ? " (archived Area)" : ""}` : "Archived Area"; row.append(areaText); }
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", () => { editing = record; if (record.areaId && ![...referenceArea.options].some((option) => option.value === record.areaId)) { const oldArea = this.areaRecords.find((candidate) => candidate.areaId === record.areaId); const option = document.createElement("option"); option.value = record.areaId; option.textContent = `${oldArea?.name ?? "Archived Area"} (archived)`; referenceArea.append(option); } referenceTitle.value = record.title; referenceArea.value = record.areaId ?? ""; referenceFields.value = record.fields.map((field) => `${field.label}: ${field.value}`).join("\n"); referenceSave.textContent = "Save changes"; referenceTitle.focus(); });
      const archive = document.createElement("button"); archive.type = "button"; archive.textContent = "Archive"; archive.addEventListener("click", () => this.dispatch("archive-reference-record", { recordId: record.recordId })); row.append(edit, archive); referenceList.append(row);
    }
    references.append(referenceHeading, referenceHint, referenceForm, referenceList); section.append(references);
    this.replaceChildren(section);
    for (const control of this.querySelectorAll("button,input,textarea,select")) control.disabled = this.disabledState;
    const candidate = focused && [...this.querySelectorAll("[data-focus-id]")]
      .find((node) => node.dataset.focusId === focused);
    if (candidate?.disabled) this.pendingFocus = focused;
    else candidate?.focus();
  }

  showFieldError(control, error, message) {
    if (message) {
      error.textContent = message;
      error.hidden = false;
      control.setAttribute("aria-invalid", "true");
    } else {
      error.textContent = "";
      error.hidden = true;
      control.removeAttribute("aria-invalid");
    }
  }

  clearEditor() {
    this.editor = { noteId: null, title: "", body: "", areaId: "" };
  }

  dispatch(action, detail) {
    this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true }));
  }

  makeError(id) {
    const error = document.createElement("small");
    error.id = id;
    error.setAttribute("role", "alert");
    error.hidden = true;
    return error;
  }

  static validateText(rawTitle, body) {
    const title = rawTitle.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
    const bytes = (value) => new TextEncoder().encode(value).length;
    if (!title) return { title, body, field: "title", error: "Enter a title." };
    if (Array.from(title).some((character) => /\p{Cc}/u.test(character))) return { title, body, field: "title", error: "Titles can't contain control characters." };
    if (Array.from(title).length > 80) return { title, body, field: "title", error: "Titles can be up to 80 characters." };
    if (bytes(title) > 256) return { title, body, field: "title", error: "Titles can be up to 256 UTF-8 bytes." };
    if (bytes(body) > 4096) return { title, body, field: "body", error: "Note bodies can be up to 4096 UTF-8 bytes." };
    if (Array.from(body).some((character) => /\p{Cc}/u.test(character) && !"\n\r\t".includes(character))) return { title, body, field: "body", error: "Note bodies can contain line breaks and tabs, but no other control characters." };
    return { title, body, field: null, error: null };
  }
}
KinNotes.instances = 0;
customElements.define("kin-notes", KinNotes);
