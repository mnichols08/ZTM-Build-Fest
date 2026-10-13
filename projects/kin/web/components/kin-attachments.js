import { attachmentKindLabel, formatAttachmentSize, isImageAttachment } from "../attachments/attachment-preview.js";
import { attachmentProgressKey, getAttachmentProgress, subscribeAttachmentProgress } from "../attachments/attachment-progress.js";

const OPENABLE = new Set(["local", "queued", "synced"]);
const DOCUMENT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></svg>';
const IMAGE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m20 15-4.5-4.5L8 18"/></svg>';

class KinAttachments extends HTMLElement {
  constructor() {
    super();
    this.parent = null;
    this.records = [];
    // "full" shows the attach button and the tiles (notes, references,
    // maintenance); "tiles" shows saved files and capture progress only, for
    // item rows whose own Add photo button sits on the row.
    this.mode = "full";
    this.previewProvider = null;
    this.observer = null;
    this.unsubscribeProgress = null;
  }
  connectedCallback() {
    // Progress lives outside this element because rows are rebuilt on every
    // refresh; re-rendering on change keeps the text current without props.
    this.unsubscribeProgress ??= subscribeAttachmentProgress((key) => {
      if (this.parent && key === attachmentProgressKey(this.parent.kind, this.parent.id)) this.render();
    });
    this.render();
  }
  set parentRecord(value) { this.parent = value; this.render(); }
  set attachments(value) { this.records = Array.isArray(value) ? value : []; this.render(); }
  set previews(provider) { this.previewProvider = typeof provider === "function" ? provider : null; this.render(); }
  get ownRecords() {
    return this.records.filter((item) => item.parentKind === this.parent?.kind && item.parentId === this.parent?.id);
  }
  disconnectedCallback() {
    this.observer?.disconnect(); this.observer = null;
    this.unsubscribeProgress?.(); this.unsubscribeProgress = null;
  }
  render() {
    if (!this.parent) return;
    this.observer?.disconnect();
    this.observer = null;
    const section = document.createElement("section");
    section.className = "attachment-list";
    const readonly = Boolean(this.parent.readonly);
    if (this.mode !== "tiles" && !readonly) {
      // A real button: the file input itself is owned by <kin-app> and opened
      // synchronously from this click, so a list refresh while the native
      // picker is open cannot detach the control that receives the file.
      const add = document.createElement("button");
      add.type = "button";
      add.className = "attachment-add";
      add.textContent = "Add a photo or file";
      add.setAttribute("aria-label", `Add a photo or file to ${this.parent.label}`);
      add.addEventListener("click", () => this.dispatch("pick-attachment", { parentKind: this.parent.kind, parentId: this.parent.id, label: this.parent.label, opener: add }));
      section.append(add);
    }
    const progress = getAttachmentProgress(this.parent.kind, this.parent.id);
    if (progress) {
      const status = document.createElement("p");
      status.className = "attachment-status";
      status.dataset.phase = progress.phase;
      status.setAttribute("role", progress.phase === "error" ? "alert" : "status");
      status.setAttribute("aria-live", progress.phase === "error" ? "assertive" : "polite");
      status.textContent = progress.message;
      section.append(status);
    }
    const own = this.ownRecords;
    if (own.length) {
      const list = document.createElement("ul");
      list.className = "attachment-tiles";
      for (const record of own) list.append(this.renderTile(record, readonly));
      section.append(list);
    }
    if (!section.childElementCount) { this.replaceChildren(); return; }
    this.replaceChildren(section);
  }

  renderTile(record, readonly) {
    const row = document.createElement("li");
    const image = isImageAttachment(record);
    const openable = OPENABLE.has(record.state);
    row.className = `attachment-tile ${image ? "attachment-tile-image" : "attachment-tile-document"}`;
    const kind = attachmentKindLabel(record);
    const figure = document.createElement("div");
    figure.className = "attachment-figure";
    if (image && openable) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "attachment-thumb";
      view.setAttribute("aria-label", `View ${record.name}`);
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.hidden = true;
      const placeholder = document.createElement("span");
      placeholder.className = "attachment-icon";
      placeholder.innerHTML = IMAGE_ICON;
      view.append(placeholder, img);
      view.addEventListener("click", () => this.dispatch("view-attachment", { attachmentId: record.attachmentId, parentKind: record.parentKind, parentId: record.parentId, name: record.name, opener: view }));
      figure.append(view);
      this.requestPreview(record, img, placeholder, view);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.innerHTML = image ? IMAGE_ICON : DOCUMENT_ICON;
      figure.append(icon);
    }
    const body = document.createElement("div");
    body.className = "attachment-body";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = record.name;
    const meta = document.createElement("small");
    meta.className = "attachment-meta";
    meta.setAttribute("aria-live", "polite");
    meta.textContent = [kind, formatAttachmentSize(record.size), statusLabel(record.state)].filter(Boolean).join(" · ");
    body.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "attachment-actions";
    if (openable) {
      const open = document.createElement("button"); open.type = "button"; open.textContent = "Open"; open.setAttribute("aria-label", `Open ${record.name}`); open.addEventListener("click", () => this.dispatch("open-attachment", { attachmentId: record.attachmentId, parentKind: record.parentKind, parentId: record.parentId })); actions.append(open);
      const save = document.createElement("button"); save.type = "button"; save.textContent = "Save file"; save.setAttribute("aria-label", `Save ${record.name}`); save.addEventListener("click", () => this.dispatch("open-attachment", { attachmentId: record.attachmentId, parentKind: record.parentKind, parentId: record.parentId, download: true })); actions.append(save);
    }
    if (record.state === "download-needed" || record.state === "failed") {
      const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry"; retry.setAttribute("aria-label", `Retry ${record.name}`); retry.addEventListener("click", () => this.dispatch("retry-attachments", {})); actions.append(retry);
    }
    if (!readonly) { const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove"; remove.setAttribute("aria-label", `Remove ${record.name}`); remove.addEventListener("click", () => this.dispatch("remove-attachment", { attachmentId: record.attachmentId })); actions.append(remove); }
    body.append(actions);
    row.append(figure, body);
    return row;
  }

  requestPreview(record, img, placeholder, view) {
    if (!this.previewProvider) return;
    const apply = (preview) => {
      if (!img.isConnected) return;
      if (!preview?.url) { view.classList.add("attachment-thumb-unavailable"); return; }
      img.src = preview.url;
      if (preview.width && preview.height) { img.width = preview.width; img.height = preview.height; }
      img.hidden = false;
      placeholder.hidden = true;
    };
    const cached = this.previewProvider(record, { peek: true });
    if (cached) { apply(cached); return; }
    const load = () => { Promise.resolve(this.previewProvider(record)).then(apply, () => apply(null)); };
    // Decode only when the tile is actually visible so long lists stay light.
    if (typeof IntersectionObserver !== "function") { load(); return; }
    this.observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.observer?.unobserve(entry.target);
        entry.target.__kinLoadPreview?.();
      }
    }, { rootMargin: "200px" });
    view.__kinLoadPreview = load;
    this.observer.observe(view);
  }

  dispatch(action, detail) { this.dispatchEvent(new CustomEvent(`kin:${action}`, { detail, bubbles: true, composed: true })); }
}

function statusLabel(state) {
  return ({ local: "Saved on this device", queued: "Saved here, waiting to sync", uploading: "Syncing", synced: "Synced", "download-needed": "Not downloaded yet", failed: "Couldn't sync or open", removed: "Removed" })[state] ?? "Couldn't be opened";
}

customElements.define("kin-attachments", KinAttachments);
