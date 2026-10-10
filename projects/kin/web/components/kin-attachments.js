class KinAttachments extends HTMLElement {
  constructor() { super(); this.parent = null; this.records = []; }
  set parentRecord(value) { this.parent = value; this.render(); }
  set attachments(value) { this.records = Array.isArray(value) ? value : []; this.render(); }
  render() {
    if (!this.parent) return;
    const id = `attachment-${this.parent.kind}-${this.parent.id}`;
    const section = document.createElement("section"); section.className = "attachment-list";
    const label = document.createElement("label"); label.htmlFor = id; label.textContent = "Attach a file";
    const input = document.createElement("input"); input.id = id; input.type = "file"; input.accept = "image/jpeg,image/png,image/webp,application/pdf"; input.setAttribute("aria-label", `Attach a file to ${this.parent.label}`); input.hidden = Boolean(this.parent.readonly);
    label.hidden = Boolean(this.parent.readonly);
    const status = document.createElement("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    input.addEventListener("change", () => { const file = input.files?.[0]; if (file) { status.textContent = `${file.name} selected. Saving on this device…`; this.dispatch("add-attachment", { file, parentKind: this.parent.kind, parentId: this.parent.id, status }); } input.value = ""; });
    section.append(label, input);
    const list = document.createElement("ul");
    for (const record of this.records.filter((item) => item.parentKind === this.parent.kind && item.parentId === this.parent.id)) {
      const row = document.createElement("li"); const name = document.createElement("span"); name.textContent = record.name;
      const state = document.createElement("small"); state.textContent = statusLabel(record.state); state.setAttribute("aria-live", "polite");
      row.append(name, state);
      if (["local", "queued", "synced"].includes(record.state)) {
        const open = document.createElement("button"); open.type = "button"; open.textContent = "Open"; open.setAttribute("aria-label", `Open ${record.name}`); open.addEventListener("click", () => this.dispatch("open-attachment", { attachmentId: record.attachmentId, parentKind: record.parentKind, parentId: record.parentId })); row.append(open);
        const save = document.createElement("button"); save.type = "button"; save.textContent = "Save file"; save.setAttribute("aria-label", `Save ${record.name}`); save.addEventListener("click", () => this.dispatch("open-attachment", { attachmentId: record.attachmentId, parentKind: record.parentKind, parentId: record.parentId, download: true })); row.append(save);
      }
      if (record.state === "download-needed" || record.state === "failed") {
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry"; retry.setAttribute("aria-label", `Retry ${record.name}`); retry.addEventListener("click", () => this.dispatch("retry-attachments", {})); row.append(retry);
      }
      if (!this.parent.readonly) { const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove ${record.name}`); remove.addEventListener("click", () => this.dispatch("remove-attachment", { attachmentId: record.attachmentId })); row.append(remove); }
      list.append(row);
    }
    section.append(status, list);
    this.replaceChildren(section);
  }
  dispatch(action, detail) { this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true })); }
}

function statusLabel(state) {
  return ({ local: "Available offline", queued: "Waiting to sync", uploading: "Uploading", synced: "Available offline", "download-needed": "Download needed", failed: "This attachment is unavailable", removed: "Removed" })[state] ?? "This attachment is unavailable";
}

customElements.define("kin-attachments", KinAttachments);
