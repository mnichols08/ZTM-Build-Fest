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
    const title = document.createElement("input"); title.name = "title"; title.maxLength = 80; title.required = true; titleLabel.append(title);
    const bodyLabel = document.createElement("label"); bodyLabel.textContent = "Body";
    const body = document.createElement("textarea"); body.name = "body"; body.maxLength = 4096; bodyLabel.append(body);
    const areaLabel = document.createElement("label"); areaLabel.textContent = "Area (optional)";
    const area = document.createElement("select"); area.name = "areaId";
    const none = document.createElement("option"); none.value = ""; none.textContent = "No area"; area.append(none);
    for (const item of this.areaRecords.filter((candidate) => !candidate.archived)) { const option = document.createElement("option"); option.value = item.areaId; option.textContent = item.name; area.append(option); }
    areaLabel.append(area);
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save note";
    form.append(titleLabel, bodyLabel, areaLabel, save);
    form.addEventListener("submit", (event) => { event.preventDefault(); this.dispatch(form.dataset.noteId ? "update-note" : "create-note", { ...(form.dataset.noteId ? { noteId: form.dataset.noteId } : {}), title: title.value, body: body.value, areaId: area.value || null }); delete form.dataset.noteId; save.textContent = "Save note"; });
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
}
customElements.define("kin-notes", KinNotes);
