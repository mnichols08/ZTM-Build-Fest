import {
  MAX_REFERENCE_FIELDS,
  validateReferenceRecord,
} from "../household-validation.js";
import "./kin-attachments.js";

class KinNotes extends HTMLElement {
  constructor() {
    super();
    this.records = [];
    this.referenceRecords = [];
    this.areaRecords = [];
    this.maintenanceEvents = [];
    this.attachmentRecords = [];
    this.routineRecords = [];
    this.disabledState = false;
    this.editor = { noteId: null, title: "", body: "", areaId: "" };
    this.referenceEditor = null;
    this.pendingFocus = null;
    this.instanceId = `notes-${++KinNotes.instances}`;
  }

  set notes(value) { this.records = Array.isArray(value) ? value : []; this.render(); }
  set references(value) { this.referenceRecords = Array.isArray(value) ? value : []; this.render(); }
  set areas(value) { this.areaRecords = Array.isArray(value) ? value : []; this.render(); }
  set maintenance(value) { this.maintenanceEvents = Array.isArray(value) ? value : []; this.render(); }
  set attachments(value) { this.attachmentRecords = Array.isArray(value) ? value : []; this.render(); }
  set routines(value) { this.routineRecords = Array.isArray(value) ? value : []; this.render(); }
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
      row.append(this.makeAttachmentControl("note", note.noteId, note.title));
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

    const references = document.createElement("section");
    references.className = "reference-records";
    const referenceHeading = document.createElement("h2");
    referenceHeading.textContent = "Household reference";
    const referenceHint = document.createElement("p");
    referenceHint.textContent = "Keep practical details such as Wi-Fi names, appliance models, or service contacts. Values are shared with the household.";
    const referenceForm = document.createElement("form");
    referenceForm.noValidate = true;
    const referenceEditor = this.referenceEditor ?? {
      recordId: null,
      title: "",
      areaId: "",
      fields: [{ fieldId: crypto.randomUUID().replaceAll("-", ""), label: "", value: "" }],
    };
    this.referenceEditor = referenceEditor;
    const referenceTitleId = id("reference-title");
    const referenceTitleLabel = document.createElement("label");
    referenceTitleLabel.htmlFor = referenceTitleId;
    referenceTitleLabel.textContent = "Title";
    const referenceTitle = document.createElement("input");
    referenceTitle.id = referenceTitleId;
    referenceTitle.value = referenceEditor.title;
    referenceTitle.dataset.focusId = "reference-title";
    const referenceTitleError = this.makeError(id("reference-title-error"));
    referenceTitle.setAttribute("aria-describedby", referenceTitleError.id);
    referenceTitle.addEventListener("input", () => { referenceEditor.title = referenceTitle.value; });

    const referenceAreaId = id("reference-area");
    const referenceAreaLabel = document.createElement("label");
    referenceAreaLabel.htmlFor = referenceAreaId;
    referenceAreaLabel.textContent = "Area (optional)";
    const referenceArea = document.createElement("select");
    referenceArea.id = referenceAreaId;
    const noReferenceArea = document.createElement("option");
    noReferenceArea.value = "";
    noReferenceArea.textContent = "No Area";
    referenceArea.append(noReferenceArea);
    for (const item of this.areaRecords.filter((candidate) => !candidate.archived)) {
      const option = document.createElement("option");
      option.value = item.areaId;
      option.textContent = item.name;
      referenceArea.append(option);
    }
    if (referenceEditor.areaId && ![...referenceArea.options].some((option) => option.value === referenceEditor.areaId)) {
      const oldArea = this.areaRecords.find((candidate) => candidate.areaId === referenceEditor.areaId);
      const option = document.createElement("option");
      option.value = referenceEditor.areaId;
      option.textContent = `${oldArea?.name ?? "Archived Area"} (archived)`;
      referenceArea.append(option);
    }
    referenceArea.value = referenceEditor.areaId;
    referenceArea.addEventListener("change", () => { referenceEditor.areaId = referenceArea.value; });

    const fieldHeading = document.createElement("h3");
    fieldHeading.textContent = "Fields";
    const referenceCountError = this.makeError(id("reference-count-error"));
    const referenceFields = document.createElement("div");
    referenceFields.className = "reference-field-list";
    const fieldControls = [];
    referenceEditor.fields.forEach((field, index) => {
      const fieldset = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = `Field ${index + 1}`;
      const labelId = id(`reference-label-${index}`);
      const fieldLabel = document.createElement("label");
      fieldLabel.htmlFor = labelId;
      fieldLabel.textContent = "Label";
      const labelInput = document.createElement("input");
      labelInput.id = labelId;
      labelInput.value = field.label;
      labelInput.dataset.focusId = `reference-label-${index}`;
      labelInput.dataset.referenceIndex = String(index);
      const labelError = this.makeError(id(`reference-label-error-${index}`));
      labelInput.setAttribute("aria-describedby", labelError.id);
      labelInput.addEventListener("input", () => { field.label = labelInput.value; });
      const valueId = id(`reference-value-${index}`);
      const valueLabel = document.createElement("label");
      valueLabel.htmlFor = valueId;
      valueLabel.textContent = "Value";
      const valueInput = document.createElement("textarea");
      valueInput.id = valueId;
      valueInput.rows = 2;
      valueInput.value = field.value;
      valueInput.dataset.focusId = `reference-value-${index}`;
      valueInput.dataset.referenceIndex = String(index);
      const valueError = this.makeError(id(`reference-value-error-${index}`));
      valueInput.setAttribute("aria-describedby", valueError.id);
      valueInput.addEventListener("input", () => { field.value = valueInput.value; });
      fieldset.append(fieldLabel, labelInput, labelError, valueLabel, valueInput, valueError);
      if (referenceEditor.fields.length > 1) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove field";
        remove.addEventListener("click", () => {
          referenceEditor.fields.splice(index, 1);
          this.pendingFocus = `reference-label-${Math.max(0, index - 1)}`;
          this.referenceEditor = referenceEditor;
          this.render();
        });
        fieldset.append(remove);
      }
      fieldControls.push({ labelInput, labelError, valueInput, valueError });
      referenceFields.append(fieldset);
    });
    const addReferenceField = document.createElement("button");
    addReferenceField.type = "button";
    addReferenceField.textContent = "Add field";
    addReferenceField.setAttribute("aria-describedby", referenceCountError.id);
    addReferenceField.addEventListener("click", () => {
      referenceEditor.fields.push({ fieldId: crypto.randomUUID().replaceAll("-", ""), label: "", value: "" });
      this.pendingFocus = `reference-label-${referenceEditor.fields.length - 1}`;
      this.referenceEditor = referenceEditor;
      this.render();
    });
    const referenceSave = document.createElement("button");
    referenceSave.type = "submit";
    referenceSave.textContent = referenceEditor.recordId ? "Save changes" : "Save reference";
    referenceSave.dataset.focusId = "reference-save";
    referenceForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.disabledState) return;
      referenceEditor.title = referenceTitle.value;
      referenceEditor.areaId = referenceArea.value;
      fieldControls.forEach((controls, index) => {
        referenceEditor.fields[index].label = controls.labelInput.value;
        referenceEditor.fields[index].value = controls.valueInput.value;
      });
      const result = validateReferenceRecord(referenceEditor.title, referenceEditor.fields);
      this.showFieldError(referenceTitle, referenceTitleError, result.errors.title);
      this.showFieldError(addReferenceField, referenceCountError, result.errors.count);
      result.errors.fields.forEach((errors, index) => {
        const controls = fieldControls[index];
        this.showFieldError(controls.labelInput, controls.labelError, errors.label);
        this.showFieldError(controls.valueInput, controls.valueError, errors.value);
      });
      if (!result.valid) {
        const invalid = referenceTitleError.textContent
          ? referenceTitle
          : referenceCountError.textContent
            ? addReferenceField
            : fieldControls.find((controls) => controls.labelError.textContent || controls.valueError.textContent);
        (invalid?.labelError?.textContent ? invalid.labelInput : invalid?.valueError?.textContent ? invalid.valueInput : invalid)?.focus();
        return;
      }
      this.dispatch("save-reference-record", {
        recordId: referenceEditor.recordId,
        title: result.title,
        areaId: referenceArea.value || null,
        fields: result.fields,
      });
    });
    referenceForm.append(referenceTitleLabel, referenceTitle, referenceTitleError, referenceAreaLabel, referenceArea, fieldHeading, referenceCountError, referenceFields, addReferenceField, referenceSave);
    const referenceList = document.createElement("ul");
    for (const record of this.referenceRecords.filter((item) => !item.archived)) {
      const row = document.createElement("li");
      const title = document.createElement("h3");
      title.textContent = record.title;
      row.append(title);
      const fields = document.createElement("dl");
      for (const field of record.fields) {
        const label = document.createElement("dt"); label.textContent = field.label;
        const value = document.createElement("dd"); value.textContent = field.value;
        fields.append(label, value);
      }
      row.append(fields);
      row.append(this.makeAttachmentControl("reference-record", record.recordId, record.title));
      const maintenance = document.createElement("section");
      const maintenanceHeading = document.createElement("h4"); maintenanceHeading.textContent = "Maintenance";
      maintenance.append(maintenanceHeading);
      const history = document.createElement("ul");
      for (const event of this.maintenanceEvents.filter((entry) => entry.recordId === record.recordId && !entry.archived).sort((a, b) => b.performedOn - a.performedOn || a.maintenanceId.localeCompare(b.maintenanceId))) {
        const entry = document.createElement("li");
        const date = String(event.performedOn); const next = event.nextOn ? ` · Next around ${String(event.nextOn).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")}` : "";
        entry.textContent = `${event.summary} · ${date.slice(4,6)}/${date.slice(6,8)}/${date.slice(0,4)}${next}`;
        entry.append(this.makeAttachmentControl("maintenance", event.maintenanceId, event.summary));
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Archive event"; remove.setAttribute("aria-label", `Archive maintenance event: ${event.summary}`);
        remove.addEventListener("click", () => this.dispatch("archive-maintenance-event", { maintenanceId: event.maintenanceId }));
        entry.append(" ", remove); history.append(entry);
      }
      maintenance.append(history);
      const form = document.createElement("form"); form.noValidate = true;
      const summary = document.createElement("input"); summary.required = true; summary.maxLength = 240; summary.setAttribute("aria-label", `Maintenance summary for ${record.title}`); summary.placeholder = "What was done?";
      const performed = document.createElement("input"); performed.type = "date"; performed.required = true; performed.setAttribute("aria-label", "Date performed");
      const nextOn = document.createElement("input"); nextOn.type = "date"; nextOn.setAttribute("aria-label", "Next date (optional)");
      const routine = document.createElement("select"); routine.setAttribute("aria-label", "Link a Routine (optional)");
      const none = document.createElement("option"); none.value = ""; none.textContent = "No linked Routine"; routine.append(none);
      for (const candidate of this.routineRecords.filter((item) => item.status === "active")) { const option = document.createElement("option"); option.value = candidate.routineId; option.textContent = candidate.text; routine.append(option); }
      const addEvent = document.createElement("button"); addEvent.type = "submit"; addEvent.textContent = "Add maintenance";
      form.addEventListener("submit", (event) => { event.preventDefault(); if (!summary.value.trim() || !performed.value) return; const numericDate = (value) => value ? Number(value.replaceAll("-", "")) : null; this.dispatch("save-maintenance-event", { maintenanceId: crypto.randomUUID().replaceAll("-", ""), recordId: record.recordId, performedOn: numericDate(performed.value), summary: summary.value.trim(), nextOn: numericDate(nextOn.value), routineId: routine.value || null }); });
      form.append(summary, performed, nextOn, routine, addEvent); maintenance.append(form); row.append(maintenance);
      if (record.areaId) {
        const linked = this.areaRecords.find((candidate) => candidate.areaId === record.areaId);
        const areaText = document.createElement("small");
        areaText.textContent = linked ? `${linked.name}${linked.archived ? " (archived Area)" : ""}` : "Archived Area";
        row.append(areaText);
      }
      const edit = document.createElement("button");
      edit.type = "button"; edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        this.referenceEditor = { recordId: record.recordId, title: record.title, areaId: record.areaId ?? "", fields: record.fields.map((field) => ({ ...field })) };
        this.pendingFocus = "reference-title";
        this.render();
      });
      const archive = document.createElement("button");
      archive.type = "button"; archive.textContent = "Archive";
      archive.addEventListener("click", () => this.dispatch("archive-reference-record", { recordId: record.recordId }));
      row.append(edit, archive);
      referenceList.append(row);
    }
    references.append(referenceHeading, referenceHint, referenceForm, referenceList);
    section.append(references);
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

  makeAttachmentControl(kind, parentId, label) {
    const control = document.createElement("kin-attachments");
    control.parentRecord = { kind, id: parentId, label };
    control.attachments = this.attachmentRecords;
    return control;
  }

  clearEditor() {
    this.editor = { noteId: null, title: "", body: "", areaId: "" };
  }

  clearReferenceEditor() {
    this.referenceEditor = null;
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
