// Updates → Chat (#112): the household's one chat room.
//
// The room (web/chat/chat-room.js) owns the chat log, sending and sync; this
// element shows a window of it and a composer. It never renders markup from
// a message: every text goes in through textContent, and links stay plain
// text (no previews, which would make requests).
//
// Window: the list renders at most WINDOW_MAX rows of the log. Scrolling near
// the top (or "Show earlier messages") brings older messages in and trims the
// newest; scrolling back down does the reverse. While the window ends at the
// latest message it "follows": new messages join it and, if the list was at
// the bottom, scroll into view; otherwise "Jump to latest" appears. Paging
// keeps the rows on screen where they are.
//
// Rows are reconciled by message ID: a row whose content didn't change is
// kept as it is, so focus, selection and an open menu survive new messages.
//
// The list is a role="log" region kept quiet (aria-live="off"); a separate
// polite live region announces only messages from others this view hasn't
// seen before (by message ID), never paging or the history shown on opening.
// The draft lives in this element only: locking replaces the element.
import { chatTextProblem, MAX_CHAT_TEXT_CHARS } from "../chat/chat-room.js";
import { emojiOnlyCount } from "../chat/emoji.js";
import { attachmentProblem, MAX_ATTACHMENT_FILES, safeAttachmentName } from "../chat/chat-attachments.js";
import { attachmentKindLabel, formatAttachmentSize } from "../attachments/attachment-preview.js";
import { ObjectUrlRegistry } from "../attachments/object-urls.js";
import "./kin-emoji-picker.js";

/** Rows rendered at first and added per page. */
const PAGE = 60;
/** Most rows kept rendered at once. */
const WINDOW_MAX = 240;
/** Newest messages checked for arrivals while the window shows older ones. */
const ARRIVAL_CHECK = 50;
/** Pixels from an edge that count as "near" it. */
const EDGE = 160;
/** Messages from one author this close together are grouped. */
const GROUP_MS = 5 * 60_000;

const STATUS_TEXT = { deleted: "This message was deleted", "removed-by-admin": "Removed by an admin" };
const ATTACHMENT_TEXT = { loading: "Loading…", pending: "Waiting for these to arrive…", deleted: "This message was deleted", failed: "These couldn't be opened yet." };
/** Blob URLs for photos and downloads last until the room is left (or the
 * page locks): a long lifetime, revoked explicitly. */
const URL_LIFETIME_MS = 2 ** 31 - 1;
/** How long a downloaded file's blob URL lives after the click that saved it. */
const DOWNLOAD_URL_MS = 60_000;
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
const ACTION_LABELS = { copy: "Copy text", edit: "Edit", delete: "Delete for everyone", remove: "Remove as admin", hide: "Delete for me" };
const NO_RECALL = "Copies people already saved, screenshotted or downloaded can't be recalled.";

const visible = (message) => message.status === "live" || message.status === "edited";

class KinChat extends HTMLElement {
  constructor() {
    super();
    this.chatRoom = null;
    this.unsubscribe = null;
    this.urls = new ObjectUrlRegistry({ lifetimeMs: URL_LIFETIME_MS });
    this.resetView();
    this.editing = null;
    this.stashedDraft = null;
    this.renderQueued = false;
    this.pendingMode = null;
    this.rendering = Promise.resolve();
    this.isDisabled = false;
    this.onDocumentClick = (event) => {
      if (this.menuFor && !event.composedPath().some((node) => node?.classList?.contains?.("chat-menu-wrap"))) this.closeMenu();
    };
  }

  /** Forgets everything about the room on screen. */
  resetView() {
    this.start = 0;
    this.end = 0;
    this.total = 0;
    this.following = true;
    this.messages = [];
    this.rows = new Map();
    this.menuFor = null;
    // Per message: { deleted } is final; { pending } and { failed } are
    // retried on the room's next change; { loading } while a load runs.
    this.textStatus = new Map();
    // Per attachment message (#114): { status, text, files, thumbs }.
    this.attachments = new Map();
    // Photos and files chosen to send, not yet sent.
    this.files = [];
    this.urls?.revokeAll();
    this.seen = new Set();
    this.toAnnounce = [];
    this.wasAtBottom = true;
    // Until the first render of a room, what's there is history, not news.
    this.primed = false;
    this.list?.replaceChildren();
  }

  connectedCallback() {
    document.addEventListener("click", this.onDocumentClick);
    if (this.list) {
      this.resizeObserver?.observe(this.scroller);
      return;
    }
    const section = document.createElement("section");
    section.className = "today-section chat-section";
    const heading = document.createElement("h2");
    heading.id = "chat-heading";
    heading.textContent = "Household chat";
    this.notice = document.createElement("p");
    this.notice.className = "chat-notice";

    this.scroller = document.createElement("div");
    this.scroller.className = "chat-scroll";
    this.scroller.setAttribute("role", "log");
    this.scroller.setAttribute("aria-live", "off");
    this.scroller.setAttribute("aria-labelledby", "chat-heading");
    this.scroller.tabIndex = 0;
    this.older = document.createElement("button");
    this.older.type = "button";
    this.older.className = "chat-older";
    this.older.textContent = "Show earlier messages";
    this.older.addEventListener("click", () => void this.loadOlder({ fromButton: true }));
    this.list = document.createElement("ol");
    this.list.className = "chat-list";
    this.scroller.append(this.older, this.list);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
    // A hidden panel has no size, so "scroll to the latest" does nothing
    // there; do it once the list is shown (or resized) while following.
    if (typeof ResizeObserver === "function") {
      let height = 0;
      this.resizeObserver = new ResizeObserver(() => {
        const next = this.scroller.clientHeight;
        if (next && (!height || this.wasAtBottom) && this.following) this.scrollToBottom();
        height = next;
      });
      this.resizeObserver.observe(this.scroller);
    }

    this.jump = document.createElement("button");
    this.jump.type = "button";
    this.jump.className = "chat-jump";
    this.jump.textContent = "Jump to latest";
    this.jump.hidden = true;
    this.jump.addEventListener("click", () => void this.jumpToLatest());

    this.announcer = document.createElement("div");
    this.announcer.className = "visually-hidden";
    this.announcer.setAttribute("aria-live", "polite");

    const form = document.createElement("form");
    form.className = "compose-form chat-form";
    this.form = form;
    this.label = document.createElement("label");
    this.label.htmlFor = "chat-text";
    this.label.textContent = "Message";
    this.input = document.createElement("textarea");
    this.input.id = "chat-text";
    this.input.rows = 2;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-describedby", "chat-message");
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.editing) {
        event.preventDefault();
        this.stopEditing({ restoreDraft: true });
        return;
      }
      // Enter sends and Shift+Enter adds a line on a keyboard device; on a
      // touch screen Enter adds a line and the Send button sends.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || !this.enterSends()) return;
      event.preventDefault();
      form.requestSubmit();
    });
    this.send = document.createElement("button");
    this.send.type = "submit";
    this.send.className = "add-button";
    this.send.textContent = "Send";
    this.cancel = document.createElement("button");
    this.cancel.type = "button";
    this.cancel.className = "chat-cancel";
    this.cancel.textContent = "Cancel edit";
    this.cancel.hidden = true;
    this.cancel.addEventListener("click", () => {
      this.stopEditing({ restoreDraft: true });
      this.input.focus();
    });
    this.message = document.createElement("p");
    this.message.id = "chat-message";
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    // Emoji (#113): the OS emoji keyboard works here too.
    // Its panel sits right after the textarea, so the tab order follows what
    // shows: message, emoji (when open), then the buttons.
    const tooLong = `That would make the message too long. Keep it to ${MAX_CHAT_TEXT_CHARS.toLocaleString("en-US")} characters.`;
    this.emoji = document.createElement("kin-emoji-picker");
    this.emoji.target = this.input;
    const panelSlot = document.createElement("div");
    panelSlot.className = "emoji-slot";
    this.emoji.panelHost = panelSlot;
    this.emoji.addEventListener("kin:emoji-refused", () => { this.message.textContent = tooLong; });
    this.emoji.addEventListener("kin:emoji-inserted", () => {
      if (this.message.textContent === tooLong) this.message.textContent = "";
    });
    // Photos and files (#114): chosen with the file dialog, then listed here
    // until sent. The caption is whatever is in the message box.
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.multiple = true;
    this.fileInput.className = "visually-hidden";
    this.fileInput.tabIndex = -1;
    this.fileInput.setAttribute("aria-hidden", "true");
    this.fileInput.addEventListener("change", () => this.addFiles([...this.fileInput.files]));
    this.attach = document.createElement("button");
    this.attach.type = "button";
    this.attach.className = "chat-attach";
    this.attach.textContent = "Attach";
    this.attach.setAttribute("aria-label", `Attach photos or files (up to ${MAX_ATTACHMENT_FILES})`);
    this.attach.addEventListener("click", () => this.fileInput.click());
    this.pendingList = document.createElement("ul");
    this.pendingList.className = "chat-pending";
    this.pendingList.setAttribute("aria-label", "Photos and files to send");
    this.pendingList.hidden = true;
    const buttons = document.createElement("div");
    buttons.className = "chat-form-buttons";
    buttons.append(this.attach, this.emoji, this.send, this.cancel);
    form.append(this.label, this.input, this.pendingList, panelSlot, buttons, this.message, this.fileInput);

    // A viewer for one photo, shown modally; its URL is released on close.
    this.viewer = document.createElement("dialog");
    this.viewer.className = "chat-viewer";
    this.viewer.setAttribute("aria-labelledby", "chat-viewer-name");
    this.viewer.addEventListener("close", () => this.closeViewer());

    section.append(heading, this.notice, this.scroller, this.jump, form, this.announcer, this.viewer);
    this.replaceChildren(section);
    this.queueRender("reset");
  }

  disconnectedCallback() {
    document.removeEventListener("click", this.onDocumentClick);
    this.resizeObserver?.disconnect();
    this.urls.revokeAll();
  }

  /** The chat room, or null while there is none (sync not set up, locked). */
  set room(value) {
    if (value === this.chatRoom) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.chatRoom = value ?? null;
    this.resetView();
    this.stopEditing({ restoreDraft: true });
    if (this.chatRoom) this.unsubscribe = this.chatRoom.subscribe(() => this.roomChanged());
    this.queueRender("reset");
  }

  get room() {
    return this.chatRoom;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    this.applyDisabled();
  }

  applyDisabled() {
    if (!this.input) return;
    const off = this.isDisabled || !this.chatRoom;
    this.input.disabled = off;
    this.send.disabled = off || Boolean(this.sending);
    this.emoji.disabled = off;
    // Attachments aren't edited: no attaching while editing a message.
    this.attach.disabled = off || Boolean(this.sending) || Boolean(this.editing);
  }

  enterSends() {
    return typeof matchMedia !== "function" || matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  /**
   * The app disables the workspace briefly while it refreshes household
   * state, which would drop focus from the composer mid-typing; it calls
   * these around that (app/status.js) so focus and the caret come back.
   */
  deferFocusedControl() {
    if (document.activeElement !== this.input) return;
    this.deferred = { start: this.input.selectionStart, end: this.input.selectionEnd };
  }

  settleDeferredFocus() {
    const deferred = this.deferred;
    this.deferred = null;
    if (!deferred || !this.input || this.input.disabled || !this.isConnected) return;
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(deferred.start, deferred.end);
  }

  roomChanged() {
    // Texts that weren't there yet, or couldn't be opened, get another try.
    for (const [messageId, status] of this.textStatus)
      if (status.pending || status.failed) this.textStatus.delete(messageId);
    for (const [messageId, state] of this.attachments)
      if (state.status === "pending" || state.status === "failed") this.attachments.delete(messageId);
    this.queueRender("update");
  }

  /**
   * Coalesces renders: the room may notify several times in a row. A mode
   * says how the view moves: "reset" (to the latest), "page" (keep the rows
   * on screen in place), "update" (follow if following at the bottom, else
   * keep in place).
   */
  queueRender(mode = "update") {
    const rank = { update: 0, page: 1, reset: 2 };
    if (!this.pendingMode || rank[mode] > rank[this.pendingMode]) this.pendingMode = mode;
    if (this.renderQueued) return this.rendering;
    this.renderQueued = true;
    this.rendering = this.rendering.then(() => new Promise((resolve) => queueMicrotask(resolve))).then(() => {
      this.renderQueued = false;
      const next = this.pendingMode;
      this.pendingMode = null;
      try {
        this.render(next);
      } catch (error) {
        this.showNotice(error?.code === "chat_locked" ? "" : "Kin couldn't show the chat right now.");
      }
    });
    return this.rendering;
  }

  showNotice(text) {
    if (!this.notice) return;
    this.notice.textContent = text;
    this.notice.hidden = !text;
  }

  noticeText() {
    const room = this.chatRoom;
    if (!room) return "Chat works once this device syncs with your household. Turn on sync under Household → People & devices.";
    if (room.syncError?.code === "connection_unavailable") return "Offline. Messages you send wait on this device and go out when you reconnect.";
    if (room.syncError) return "Chat is paused until household sync can continue. Messages you send wait on this device.";
    if (room.retireRefusal) return "A message was deleted here, but Kin couldn't delete its content on the household service.";
    if (room.refused?.length) return "Kin skipped a chat message it couldn't verify.";
    if (room.hiddenError?.code === "chat_hidden_full") return room.hiddenError.message;
    if (room.hiddenError) return "Messages you deleted for yourself aren't syncing with your other devices right now.";
    if (room.hiddenWaiting) return "Messages you deleted for yourself on your other devices arrive once one of them syncs.";
    return "";
  }

  render(mode) {
    if (!this.list) return;
    this.applyDisabled();
    this.showNotice(this.noticeText());
    const room = this.chatRoom;
    if (!room) {
      this.list.replaceChildren();
      this.rows.clear();
      this.messages = [];
      this.older.hidden = true;
      this.jump.hidden = true;
      return;
    }
    const measured = this.scroller.clientHeight > 0;
    const atBottom = measured ? this.atBottom() : this.wasAtBottom;
    const wasFollowing = this.following;
    const anchor = mode === "reset" ? null : this.captureAnchor();
    const firstRender = !this.primed;
    this.primed = true;

    // One engine page per render: the newest messages while following,
    // otherwise the window as it stands.
    let page;
    if (mode === "reset") {
      page = room.page({ limit: PAGE });
    } else if (this.following) {
      // The window as it stands plus room for what arrived since, then
      // trimmed back to where the window starts (and to its size).
      const wide = room.page({ limit: Math.min(WINDOW_MAX + ARRIVAL_CHECK, this.end - this.start + ARRIVAL_CHECK) });
      const from = Math.max(this.start, wide.total - WINDOW_MAX);
      const messages = wide.messages.filter((message) => message.index >= from);
      page = { ...wide, start: messages[0]?.index ?? wide.total, messages };
    } else {
      page = room.page({ before: this.end, limit: Math.max(1, this.end - this.start) });
    }
    this.total = page.total;
    // Messages this member deleted for themselves don't show (#119); the
    // window still counts them, as the engine does.
    this.messages = page.messages.filter((message) => !room.isHidden?.(message.messageId));
    this.start = page.start;
    this.end = page.start + page.messages.length;
    if (this.end === this.total) this.following = true;

    // Arrivals: among the newest messages only, those from others this view
    // hasn't seen. Older history brought in by paging, and what's there when
    // a room opens, is seen, not announced.
    const newest = this.following ? page.messages.slice(-ARRIVAL_CHECK) : room.page({ limit: ARRIVAL_CHECK }).messages;
    const arrived = [];
    for (const message of newest) {
      if (this.seen.has(message.messageId)) continue;
      this.seen.add(message.messageId);
      if (mode !== "reset" && !firstRender && message.authorId !== room.identity.memberId && visible(message) && !room.isHidden?.(message.messageId)) arrived.push(message);
    }
    for (const message of page.messages) this.seen.add(message.messageId);

    this.reconcile();
    this.older.hidden = this.start === 0;
    if (mode === "reset" || (wasFollowing && atBottom && mode !== "page")) {
      this.scrollToBottom();
      this.jump.hidden = true;
    } else {
      if (anchor) this.restoreAnchor(anchor);
      if (!this.following || (arrived.length && !atBottom)) this.jump.hidden = false;
      else if (this.atBottom()) this.jump.hidden = true;
    }
    this.wasAtBottom = measured ? this.atBottom() : atBottom;
    if (arrived.length) this.toAnnounce.push(...arrived.map((message) => message.messageId));
    this.flushAnnouncements(newest);
    this.loadMissingTexts();
    this.loadMissingAttachments();
  }

  /** Opens texts the engine doesn't hold yet, outside the render queue, and
   * repaints once they're in. */
  loadMissingTexts() {
    const room = this.chatRoom;
    const missing = this.messages.filter((message) => message.text === null && message.blobRef && message.contentKind === "text" && !this.textStatus.has(message.messageId));
    if (!missing.length) return;
    for (const message of missing) this.textStatus.set(message.messageId, { loading: true });
    room.loadTexts(missing).then((results) => {
      if (room !== this.chatRoom) return;
      for (const message of missing) {
        const result = results.get(message.messageId) ?? { failed: true };
        // Opened text goes to the engine, not here: the next page has it.
        if (typeof result.text === "string") this.textStatus.delete(message.messageId);
        else this.textStatus.set(message.messageId, result);
      }
      this.queueRender("update");
    }, () => {
      if (room !== this.chatRoom) return;
      for (const message of missing) this.textStatus.set(message.messageId, { failed: true });
      this.queueRender("update");
    });
  }

  /** Announces arrivals once their text is in (or that it can't be). */
  flushAnnouncements(newest) {
    const room = this.chatRoom;
    if (!this.toAnnounce.length || !room) return;
    const byId = new Map([...this.messages, ...newest].map((message) => [message.messageId, message]));
    const ready = [], waiting = [];
    for (const messageId of this.toAnnounce) {
      const message = byId.get(messageId);
      if (!message) continue;
      const status = this.textStatus.get(messageId);
      // Outside the window its text isn't being opened: say who wrote.
      const shown = this.rows.has(messageId);
      // An attachment's caption and files are settled once its load is done.
      const attachment = message.contentKind === "attachment" && visible(message);
      const settled = attachment
        ? this.attachments.get(messageId)?.status !== undefined && this.attachments.get(messageId).status !== "loading"
        : message.text !== null || !message.blobRef || (status && !status.loading);
      if (!shown || settled) ready.push(message);
      else waiting.push(messageId);
    }
    this.toAnnounce = waiting;
    if (!ready.length) return;
    const last = ready.at(-1);
    const more = ready.length > 1 ? `${ready.length} new messages. ` : "";
    const who = room.authorLabel(last.authorId);
    this.say(last.text !== null ? `${more}${who}: ${last.text}` : `${more}New message from ${who}.`);
  }

  /** Opens the captions and file lists of attachment messages on screen,
   * then their photo thumbnails, outside the render queue. */
  loadMissingAttachments() {
    const room = this.chatRoom;
    if (!room) return;
    const missing = this.messages.filter((message) => visible(message) && message.contentKind === "attachment" && message.blobRef && !this.attachments.has(message.messageId));
    for (const message of missing) this.attachments.set(message.messageId, { status: "loading", text: "", files: [], thumbs: new Map() });
    for (const message of missing) void this.loadAttachment(room, message);
  }

  async loadAttachment(room, message) {
    let opened;
    try {
      opened = await room.openAttachment(message);
    } catch (error) {
      if (room !== this.chatRoom) return;
      const status = error?.code === "chat_attachment_deleted" ? "deleted" : error?.code === "chat_attachment_pending" ? "pending" : "failed";
      this.attachments.set(message.messageId, { status, text: "", files: [], thumbs: new Map() });
      this.queueRender("update");
      return;
    }
    if (room !== this.chatRoom) return;
    const state = { status: "ready", text: opened.text, files: opened.files, thumbs: new Map() };
    this.attachments.set(message.messageId, state);
    this.queueRender("update");
    for (let index = 0; index < opened.files.length; index += 1) {
      if (!opened.files[index].photo) continue;
      try {
        const blob = await room.attachmentThumbnail(message, index);
        if (!blob || room !== this.chatRoom || this.attachments.get(message.messageId) !== state) continue;
        state.thumbs.set(index, this.urls.create(blob));
        this.queueRender("update");
      } catch {
        // No thumbnail: the photo still opens from its button.
      }
    }
  }

  /** Brings the list in line with this.messages, reusing unchanged rows. */
  reconcile() {
    const room = this.chatRoom;
    const keep = new Map();
    let previous = null;
    let cursor = this.list.firstElementChild;
    for (const message of this.messages) {
      const grouped = Boolean(previous && previous.authorId === message.authorId &&
        message.postedAt - previous.postedAt < GROUP_MS && visible(previous));
      const signature = this.signature(message, grouped, room);
      let entry = this.rows.get(message.messageId);
      if (!entry || entry.signature !== signature) {
        const focus = entry ? this.focusIn(entry.row) : null;
        const row = this.row(message, grouped, room);
        if (entry) {
          if (cursor === entry.row) cursor = row;
          entry.row.replaceWith(row);
        }
        entry = { row, signature };
        if (focus) this.restoreFocus(row, focus);
      }
      keep.set(message.messageId, entry);
      if (entry.row !== cursor) this.list.insertBefore(entry.row, cursor);
      else cursor = cursor.nextElementSibling;
      previous = message;
    }
    for (const [messageId, entry] of this.rows) if (!keep.has(messageId)) entry.row.remove();
    this.rows = keep;
  }

  signature(message, grouped, room) {
    const status = this.textStatus.get(message.messageId);
    const attachment = this.attachments.get(message.messageId);
    return [
      message.status, message.text ?? "", message.editedAt ?? "", message.blobRef ?? "", grouped,
      room.pendingMessages?.has(message.messageId) ?? false, status ? Object.keys(status)[0] : "",
      attachment ? [attachment.status, attachment.text, attachment.files.length, attachment.thumbs.size].join("\u0001") : "",
      room.authorLabel(message.authorId), this.menuFor === message.messageId, this.actionsFor(message, room).join(),
    ].join("\u0000");
  }

  /** What in `row` has focus, to put it back on its replacement. */
  focusIn(row) {
    const active = document.activeElement;
    if (!active || !row.contains(active)) return null;
    return active.dataset.action ? { action: active.dataset.action } : { toggle: true };
  }

  restoreFocus(row, focus) {
    const target = (focus.action && row.querySelector(`[data-action="${focus.action}"]`)) || row.querySelector(".chat-menu-button");
    if (target) target.focus({ preventScroll: true });
    else this.scroller.focus({ preventScroll: true });
  }

  row(message, grouped, room) {
    const item = document.createElement("li");
    item.className = "chat-row";
    item.dataset.messageId = message.messageId;
    if (message.authorId === room.identity.memberId) item.classList.add("own");
    if (grouped) item.classList.add("grouped");
    const author = room.authorLabel(message.authorId);
    const header = document.createElement("p");
    // A grouped row keeps its author and time for screen readers.
    header.className = grouped ? "chat-meta visually-hidden" : "chat-meta";
    const name = document.createElement("span");
    name.className = "chat-author";
    name.textContent = author;
    const time = document.createElement("time");
    const posted = new Date(message.postedAt);
    time.dateTime = posted.toISOString();
    const sameDay = posted.toDateString() === new Date().toDateString();
    time.textContent = (sameDay ? TIME : DATE_TIME).format(posted);
    time.title = FULL.format(posted);
    header.append(name, " · ", time);
    // "edited" sits by the time (and so in its row's accessible text).
    if (message.status === "edited") {
      const edited = document.createElement("span");
      edited.className = "chat-edited";
      edited.textContent = " · edited";
      header.append(edited);
    }
    item.append(header);

    const body = document.createElement("p");
    body.className = "chat-text";
    if (!visible(message)) {
      body.classList.add("chat-gone");
      body.textContent = STATUS_TEXT[message.status];
    } else if (message.contentKind === "attachment") {
      // The caption, once its manifest is open; a message of files alone has none.
      const state = this.attachments.get(message.messageId);
      if (state?.status === "ready" && state.text) body.textContent = state.text;
      else if (state?.status === "ready") body.hidden = true;
      else {
        body.classList.add("chat-gone");
        body.textContent = ATTACHMENT_TEXT[state?.status ?? "loading"];
      }
    } else if (message.text !== null) {
      body.textContent = message.text;
      // A message of only 1–3 emoji shows larger (#113).
      const count = emojiOnlyCount(message.text);
      if (count >= 1 && count <= 3) body.classList.add("chat-emoji-only");
    } else {
      const status = this.textStatus.get(message.messageId);
      body.classList.add("chat-gone");
      body.textContent = status?.deleted ? "This message was deleted"
        : status?.pending ? "Waiting for this message to arrive…"
        : status?.failed ? "This message couldn't be opened yet."
        : "Loading…";
    }
    item.append(body);
    const attached = visible(message) && message.contentKind === "attachment" ? this.attachments.get(message.messageId) : null;
    if (attached?.status === "ready" && attached.files.length) item.append(this.attachmentList(message, attached));

    const notes = [];
    // A grouped row's time is visually hidden: show "edited" with the notes.
    if (message.status === "edited" && grouped) notes.push("Edited");
    if (room.pendingMessages?.has(message.messageId)) notes.push("Waiting to send");
    if (notes.length) {
      const note = document.createElement("p");
      note.className = "chat-note";
      note.textContent = notes.join(" · ");
      // A grouped row's hidden header already says "edited" to screen
      // readers: don't say it twice.
      if (notes.length === 1 && notes[0] === "Edited") note.setAttribute("aria-hidden", "true");
      item.append(note);
    }
    const actions = this.actionsFor(message, room);
    if (actions.length) item.append(this.menu(message, actions, author));
    return item;
  }

  /** The photos and files of an attachment message: a thumbnail per photo,
   * and a name, type and size per file. Both open (the photo in a viewer,
   * the file as a download). */
  attachmentList(message, state) {
    const list = document.createElement("ul");
    list.className = "chat-files";
    list.setAttribute("aria-label", "Attachments");
    state.files.forEach((file, index) => {
      const entry = document.createElement("li");
      const label = attachmentKindLabel(file);
      const size = formatAttachmentSize(file.size);
      if (file.photo) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-photo";
        button.setAttribute("aria-label", `Open photo ${file.name}`);
        const url = state.thumbs.get(index);
        if (url) {
          const image = document.createElement("img");
          image.src = url;
          image.alt = "";
          image.decoding = "async";
          button.append(image);
        } else {
          button.classList.add("chat-gone");
          button.textContent = "Loading photo…";
        }
        button.addEventListener("click", () => void this.openPhoto(message, index));
        entry.append(button);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chat-file";
        button.setAttribute("aria-label", `Download ${file.name}, ${label}, ${size}`);
        const name = document.createElement("span");
        name.className = "chat-file-name";
        name.textContent = file.name;
        const details = document.createElement("span");
        details.className = "chat-file-details";
        details.textContent = `${label} · ${size}`;
        button.append(name, details);
        button.addEventListener("click", () => void this.downloadFile(message, index));
        entry.append(button);
      }
      list.append(entry);
    });
    return list;
  }

  /** Opens a photo in the viewer at full size. */
  async openPhoto(message, index) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      const blob = await room.attachmentFile(message, index);
      const url = this.urls.create(blob);
      const file = this.attachments.get(message.messageId)?.files[index];
      this.viewerUrl = url;
      this.viewerMessage = message.messageId;
      this.viewer.replaceChildren();
      const heading = document.createElement("p");
      heading.id = "chat-viewer-name";
      heading.className = "chat-viewer-name";
      heading.textContent = file?.name ?? "Photo";
      const image = document.createElement("img");
      image.src = url;
      image.alt = file?.name ?? "Photo";
      const actions = document.createElement("div");
      actions.className = "chat-viewer-actions";
      const download = document.createElement("button");
      download.type = "button";
      download.textContent = "Download";
      download.addEventListener("click", () => void this.downloadFile(message, index));
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => this.viewer.close());
      actions.append(download, close);
      this.viewer.append(heading, image, actions);
      this.viewer.showModal?.();
      if (!this.viewer.open) this.viewer.setAttribute("open", "");
      close.focus();
    } catch (error) {
      this.message.textContent = this.attachmentError(error);
    }
  }

  closeViewer() {
    if (this.viewerUrl) this.urls.revoke(this.viewerUrl);
    this.viewerUrl = null;
    this.viewer.replaceChildren();
    this.viewer.removeAttribute("open");
    this.rowFor(this.viewerMessage)?.querySelector(".chat-photo")?.focus?.();
  }

  /** Saves a file (or a photo at full size) through a short-lived link. */
  async downloadFile(message, index) {
    const room = this.chatRoom;
    if (!room) return;
    try {
      const blob = await room.attachmentFile(message, index);
      const name = this.attachments.get(message.messageId)?.files[index]?.name ?? "Attachment";
      const url = this.urls.create(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => this.urls.revoke(url), DOWNLOAD_URL_MS);
    } catch (error) {
      this.message.textContent = this.attachmentError(error);
    }
  }

  attachmentError(error) {
    if (error?.code === "chat_attachment_deleted") return "That message was deleted.";
    if (error?.code === "chat_attachment_pending") return "That is still arriving. Try again in a moment.";
    if (error?.code === "chat_storage_unavailable" || error?.code === "connection_unavailable") return "Kin couldn't reach that attachment right now. Try again.";
    return "Kin couldn't open that attachment.";
  }

  /** Adds photos and files to the ones to send, within the limits. */
  addFiles(incoming) {
    this.fileInput.value = "";
    if (!incoming.length) return;
    const next = [...this.files, ...incoming];
    const problem = attachmentProblem(next);
    if (problem) {
      this.message.textContent = problem;
      return;
    }
    this.message.textContent = "";
    this.files = next;
    this.renderPending();
  }

  renderPending() {
    this.pendingList.replaceChildren(...this.files.map((file, index) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${safeAttachmentName(file.name)} · ${formatAttachmentSize(file.size)}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-pending-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${safeAttachmentName(file.name)}`);
      remove.addEventListener("click", () => {
        this.files = this.files.filter((_, at) => at !== index);
        this.renderPending();
        (this.pendingList.querySelector("button") ?? this.attach).focus();
      });
      item.append(name, " ", remove);
      return item;
    }));
    this.pendingList.hidden = this.files.length === 0;
  }

  actionsFor(message, room) {
    // Anyone can delete any message for themselves; a deleted one too.
    if (!visible(message)) return ["hide"];
    const own = message.authorId === room.identity.memberId;
    const actions = [];
    if (message.text !== null) actions.push("copy");
    if (own && message.text !== null && message.contentKind === "text") actions.push("edit");
    if (own) actions.push("delete");
    else if (room.isAdmin) actions.push("remove");
    // Your own message still waiting to send would go out anyway.
    if (!(own && room.pendingMessages?.has(message.messageId))) actions.push("hide");
    return actions;
  }

  /** A disclosure: the ⋯ button shows or hides the row's action buttons. */
  menu(message, actions, author) {
    const wrap = document.createElement("div");
    wrap.className = "chat-menu-wrap";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "chat-menu-button";
    toggle.textContent = "⋯";
    toggle.setAttribute("aria-label", `Actions for ${author === "You" ? "your" : `${author}'s`} message`);
    const open = this.menuFor === message.messageId;
    const menuId = `chat-menu-${message.messageId}`;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-controls", menuId);
    toggle.addEventListener("click", () => {
      if (this.menuFor === message.messageId) this.closeMenu({ focusToggle: true });
      else this.openMenu(message.messageId);
    });
    wrap.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.menuFor !== message.messageId) return;
      event.preventDefault();
      this.closeMenu({ focusToggle: true });
    });
    // Tabbing out of the menu closes it.
    wrap.addEventListener("focusout", (event) => {
      if (this.menuFor === message.messageId && event.relatedTarget && !wrap.contains(event.relatedTarget)) this.closeMenu();
    });
    wrap.append(toggle);
    if (open) {
      const list = document.createElement("div");
      list.className = "chat-menu";
      list.id = menuId;
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", "Message actions");
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.textContent = ACTION_LABELS[action];
        button.addEventListener("click", () => void this.act(action, message));
        list.append(button);
      }
      wrap.append(list);
    }
    return wrap;
  }

  rowFor(messageId) {
    return this.rows.get(messageId)?.row ?? null;
  }

  openMenu(messageId) {
    this.menuFor = messageId;
    this.reconcile();
    const menu = this.rowFor(messageId)?.querySelector(".chat-menu");
    // Bring the whole menu into view (the bottom rows' menus).
    menu?.scrollIntoView({ block: "nearest" });
    menu?.querySelector("button")?.focus({ preventScroll: true });
  }

  closeMenu({ focusToggle = false } = {}) {
    const messageId = this.menuFor;
    if (!messageId) return;
    this.menuFor = null;
    this.reconcile();
    if (focusToggle) this.rowFor(messageId)?.querySelector(".chat-menu-button")?.focus({ preventScroll: true });
  }

  async act(action, message) {
    const room = this.chatRoom;
    this.closeMenu({ focusToggle: action === "copy" });
    if (!room) return;
    try {
      if (action === "copy") {
        await navigator.clipboard.writeText(message.text);
        this.say("Copied.");
      } else if (action === "edit") {
        if (!this.editing) this.stashedDraft = this.input.value;
        this.editing = message;
        this.input.value = message.text;
        this.label.textContent = "Editing message";
        this.form.classList.add("chat-editing");
        this.send.textContent = "Save";
        this.cancel.hidden = false;
        this.input.focus();
      } else if (action === "hide") {
        if (!confirm("Delete this message for you? It disappears here now and on your other devices as they sync. Nobody else sees any change.")) {
          this.rowFor(message.messageId)?.querySelector(".chat-menu-button")?.focus();
          return;
        }
        await room.hide(message);
        this.say("Deleted for you.");
        await this.queueRender("update");
        this.input.focus();
      } else if (action === "delete" || action === "remove") {
        const question = action === "delete"
          ? `Delete this message for everyone? Everyone will see that it was deleted. ${NO_RECALL}`
          : `Remove this message for everyone? Everyone will see "Removed by an admin". ${NO_RECALL}`;
        if (!confirm(question)) {
          this.rowFor(message.messageId)?.querySelector(".chat-menu-button")?.focus();
          return;
        }
        await room.remove(message, { byAdmin: action === "remove" });
        this.say(action === "delete" ? "Message deleted." : "Message removed.");
        await this.queueRender("update");
        // The row stays (now "This message was deleted").
        this.input.focus();
      }
    } catch (error) {
      this.message.textContent = action === "copy"
        ? "Kin couldn't copy that text."
        : error?.code === "chat_text_invalid" ? error.message : "Kin couldn't do that right now. Try again.";
    }
  }

  stopEditing({ restoreDraft = false } = {}) {
    const wasEditing = Boolean(this.editing);
    this.editing = null;
    if (!this.input) return;
    if (wasEditing && restoreDraft) this.input.value = this.stashedDraft ?? "";
    this.stashedDraft = null;
    this.label.textContent = "Message";
    this.form?.classList.remove("chat-editing");
    this.send.textContent = "Send";
    this.cancel.hidden = true;
  }

  async submit() {
    const room = this.chatRoom;
    if (!room || this.isDisabled || this.sending) return;
    const text = this.input.value;
    // With photos or files, the caption may be empty.
    const withFiles = !this.editing && this.files.length > 0;
    const caption = withFiles && !text.trim() ? "" : text;
    const problem = withFiles ? (caption ? chatTextProblem(caption) : null) : chatTextProblem(text);
    if (problem) {
      this.message.textContent = problem;
      this.input.focus();
      return;
    }
    this.message.textContent = "";
    this.sending = true;
    this.applyDisabled();
    const editing = this.editing;
    try {
      if (editing) await room.edit(editing, text);
      else if (withFiles) await room.sendAttachments({ text: caption, files: this.files });
      else await room.send(text);
      if (editing) {
        // Back to whatever draft was there before editing.
        this.stopEditing({ restoreDraft: this.input.value === text });
        await this.queueRender("update");
      } else {
        if (withFiles) {
          this.files = [];
          this.renderPending();
        }
        // Only clear what was sent: typing that continued meanwhile stays.
        if (this.input.value === text) this.input.value = "";
        await this.queueRender("reset");
      }
    } catch (error) {
      const plain = error?.code === "chat_text_invalid" || error?.code === "chat_attachment_invalid";
      this.message.textContent = plain ? error.message : "Kin couldn't send that. Your text is still here.";
    } finally {
      this.sending = false;
      this.applyDisabled();
      if (!this.input.disabled) this.input.focus();
    }
  }

  say(text) {
    this.announcer.textContent = "";
    setTimeout(() => { this.announcer.textContent = text; }, 50);
  }

  atBottom() {
    const s = this.scroller;
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < EDGE;
  }

  scrollToBottom() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.wasAtBottom = true;
  }

  /** The first row at or below the top of the view, and where it sits. */
  captureAnchor() {
    if (!this.scroller.clientHeight) return null;
    const top = this.scroller.getBoundingClientRect().top;
    for (const row of this.list.children) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) return { messageId: row.dataset.messageId, offset: box.top - top };
    }
    return null;
  }

  restoreAnchor(anchor) {
    const row = this.rowFor(anchor.messageId);
    if (!row) return;
    const top = this.scroller.getBoundingClientRect().top;
    this.scroller.scrollTop += row.getBoundingClientRect().top - top - anchor.offset;
  }

  onScroll() {
    if (!this.chatRoom || this.paging || !this.scroller.clientHeight) return;
    this.wasAtBottom = this.atBottom();
    if (this.scroller.scrollTop < EDGE && this.start > 0) void this.loadOlder();
    else if (this.wasAtBottom && !this.following) void this.loadNewer();
    if (this.following && this.wasAtBottom) this.jump.hidden = true;
  }

  /** Brings older messages into the window, trimming the newest past the
   * window's size; the rows on screen stay where they are. */
  async loadOlder({ fromButton = false } = {}) {
    if (!this.chatRoom || this.start === 0 || this.paging) return;
    this.paging = true;
    try {
      this.start = Math.max(0, this.start - PAGE);
      if (this.end - this.start > WINDOW_MAX) this.end = this.start + WINDOW_MAX;
      if (this.end < this.total) this.following = false;
      await this.queueRender("page");
      // The button hides at the start of history: keep focus in the list.
      if (fromButton && this.older.hidden) this.scroller.focus({ preventScroll: true });
    } finally {
      this.paging = false;
    }
  }

  async loadNewer() {
    if (!this.chatRoom || this.paging) return;
    this.paging = true;
    try {
      this.end = Math.min(this.total, this.end + PAGE);
      if (this.end - this.start > WINDOW_MAX) this.start = this.end - WINDOW_MAX;
      await this.queueRender("page");
    } finally {
      this.paging = false;
    }
  }

  async jumpToLatest() {
    this.following = true;
    await this.queueRender("reset");
    this.jump.hidden = true;
    this.input?.focus();
  }

  /** Puts keyboard focus in the composer (keyboard shortcuts, navigation). */
  focusInput() {
    this.input?.focus();
  }
}

if (!customElements.get("kin-chat")) customElements.define("kin-chat", KinChat);

export { KinChat, MAX_CHAT_TEXT_CHARS };
