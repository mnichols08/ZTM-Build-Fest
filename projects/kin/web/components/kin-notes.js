class KinNotes extends HTMLElement {
  constructor() { super(); this.records = []; this.areaRecords = []; this.disabledState = false; }
  set notes(value) { this.records = Array.isArray(value) ? value : []; this.render(); }
  set areas(value) { this.areaRecords = Array.isArray(value) ? value : []; this.render(); }
  set disabled(value) { this.disabledState = Boolean(value); this.render(); }
  render() {
    const section = document.createElement("section"); section.className = "notes-section card";
    const heading = document.createElement("h2"); heading.textContent = "Notes"; section.append(heading);
    const form = document.createElement("form");
    const titleLabel = document.createElement("label"); titleLabel.textContent = "Title";
    const title = document.createElement("input"); title.name = "title"; title.required = true; title.setAttribute("aria-describedby", "note-title-help note-title-error"); titleLabel.append(title);
    const titleHelp = document.createElement("small"); titleHelp.id = "note-title-help"; titleHelp.textContent = "Up to 80 characters and 256 UTF-8 bytes.";
    const titleError = this.makeError("note-title-error");
    const bodyLabel = document.createElement("label"); bodyLabel.textContent = "Body";
    const body = document.createElement("textarea"); body.name = "body"; body.setAttribute("aria-describedby", "note-body-help note-body-error"); bodyLabel.append(body);
    const bodyHelp = document.createElement("small"); bodyHelp.id = "note-body-help"; bodyHelp.textContent = "Plain text, up to 4096 UTF-8 bytes.";
    const bodyError = this.makeError("note-body-error");
    const areaLabel = document.createElement("label"); areaLabel.textContent = "Area (optional)";
    const area = document.createElement("select"); area.name = "areaId";
    const none = document.createElement("option"); none.value = ""; none.textContent = "No area"; area.append(none);
    for (const item of this.areaRecords.filter((candidate) => !candidate.archived)) { const option = document.createElement("option"); option.value = item.areaId; option.textContent = item.name; area.append(option); }
    areaLabel.append(area);
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save note";
    form.append(titleLabel, titleHelp, titleError, bodyLabel, bodyHelp, bodyError, areaLabel, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const result = KinNotes.validateText(title.value, body.value);
      titleError.hidden = result.field !== "title";
      bodyError.hidden = result.field !== "body";
      for (const [control, error, field] of [[title, titleError, "title"], [body, bodyError, "body"]]) {
        if (result.field === field) { error.textContent = result.error; control.setAttribute("aria-invalid", "true"); }
        else control.removeAttribute("aria-invalid");
      }
      if (result.error) return;
      title.value = result.title;
      this.dispatch(form.dataset.noteId ? "update-note" : "create-note", { ...(form.dataset.noteId ? { noteId: form.dataset.noteId } : {}), title: result.title, body: result.body, areaId: area.value || null });
      delete form.dataset.noteId; save.textContent = "Save note";
    });
    section.append(form);
    if (!this.records.some((note) => !note.archived)) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "No notes yet. Keep a household detail handy here."; section.append(empty); }
    const list = document.createElement("ul");
    for (const note of this.records.filter((item) => !item.archived)) {
      const row = document.createElement("li"); row.className = "note-row";
      const name = document.createElement("h3"); name.textContent = note.title;
      const text = document.createElement("p"); text.className = "note-body"; text.textContent = note.body;
      const linkedArea = this.areaRecords.find((candidate) => candidate.areaId === note.areaId);
      if (linkedArea) { const context = document.createElement("small"); context.textContent = `${linkedArea.name}${linkedArea.archived ? " (archived Area)" : ""}`; row.append(context); }
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", () => { title.value = note.title; body.value = note.body; if (note.areaId && ![...area.options].some((option) => option.value === note.areaId)) { const archivedArea = this.areaRecords.find((candidate) => candidate.areaId === note.areaId); if (archivedArea) { const option = document.createElement("option"); option.value = note.areaId; option.textContent = `${archivedArea.name} (archived Area)`; area.append(option); } } area.value = note.areaId ?? ""; form.dataset.noteId = note.noteId; save.textContent = "Save changes"; title.focus(); });
      const archive = document.createElement("button"); archive.type = "button"; archive.textContent = "Archive"; archive.addEventListener("click", () => this.dispatch("archive-note", { noteId: note.noteId }));
      row.append(name, text, edit, archive); list.append(row);
    }
    section.append(list); this.replaceChildren(section);
    for (const control of this.querySelectorAll("button,input,textarea,select")) control.disabled = this.disabledState;
  }
  dispatch(action, detail) { this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true })); }
  makeError(id) { const error = document.createElement("small"); error.id = id; error.setAttribute("role", "alert"); error.hidden = true; return error; }
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
customElements.define("kin-notes", KinNotes);
