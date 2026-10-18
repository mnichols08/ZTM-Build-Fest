// Updates → Chat (#112): the household's one chat room.
//
// The room (web/chat/chat-room.js) owns the chat log, sending and sync; this
// element shows a window of it and a composer. It never renders markup from
// a message: every text goes in through textContent, and links stay plain
// text (no previews, which would make requests).
//
// The message list renders only a window of the log (at most WINDOW_MAX
// rows): scrolling near the top loads older messages into it and trims the
// newest, scrolling back down does the reverse, and the position on screen
// is kept across each change. While the window ends at the latest message
// new ones are added and, if the list was scrolled to the bottom, scrolled
// into view; otherwise "Jump to latest" appears.
//
// The list is a role="log" region kept quiet (aria-live="off"); a separate
// polite live region announces only new incoming messages, never paging.
// The draft lives in this element only: locking replaces the element.
import { chatTextProblem, MAX_CHAT_TEXT_CHARS } from "../chat/chat-room.js";

/** Rows rendered at first and added per page. */
const PAGE = 60;
/** Most rows kept rendered at once. */
const WINDOW_MAX = 240;
/** Pixels from an edge that count as "near" it. */
const EDGE = 160;
/** Messages from one author this close together are grouped. */
const GROUP_MS = 5 * 60_000;

const STATUS_TEXT = { deleted: "Message deleted", "removed-by-admin": "Removed by an admin" };

class KinChat extends HTMLElement {
  constructor() {
    super();
    this.chatRoom = null;
    this.unsubscribe = null;
    // The window of the log on screen: indexes [start, end), and whether it
    // follows the latest message.
    this.start = 0;
    this.end = 0;
    this.following = true;
    this.total = 0;
    this.messages = [];
    this.texts = new Map();
    this.editing = null;
    this.menuFor = null;
    this.announcedThrough = null;
    this.renderQueued = false;
    this.rendering = Promise.resolve();
    this.isDisabled = false;
  }

  connectedCallback() {
    if (this.list) return;
    const section = document.createElement("section");
    section.className = "today-section chat-section";
    const heading = document.createElement("h2");
    heading.id = "chat-heading";
    heading.textContent = "Chat";
    this.notice = document.createElement("p");
    this.notice.className = "chat-notice";
    this.notice.id = "chat-notice";

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
    this.older.addEventListener("click", () => this.loadOlder());
    this.list = document.createElement("ol");
    this.list.className = "chat-list";
    this.scroller.append(this.older, this.list);
    this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });

    this.jump = document.createElement("button");
    this.jump.type = "button";
    this.jump.className = "chat-jump";
    this.jump.textContent = "Jump to latest";
    this.jump.hidden = true;
    this.jump.addEventListener("click", () => this.jumpToLatest());

    this.announcer = document.createElement("div");
    this.announcer.className = "visually-hidden";
    this.announcer.setAttribute("aria-live", "polite");

    const form = document.createElement("form");
    form.className = "compose-form chat-form";
    this.label = document.createElement("label");
    this.label.htmlFor = "chat-text";
    this.label.textContent = "Message";
    this.input = document.createElement("textarea");
    this.input.id = "chat-text";
    this.input.rows = 2;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-describedby", "chat-message");
    this.input.addEventListener("keydown", (event) => {
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
    this.cancel.addEventListener("click", () => this.stopEditing());
    this.message = document.createElement("p");
    this.message.id = "chat-message";
    this.message.className = "compose-message";
    this.message.setAttribute("role", "alert");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });
    const buttons = document.createElement("div");
    buttons.className = "chat-form-buttons";
    buttons.append(this.send, this.cancel);
    form.append(this.label, this.input, buttons, this.message);
    this.form = form;

    section.append(heading, this.notice, this.scroller, this.jump, form, this.announcer);
    this.replaceChildren(section);
    document.addEventListener("click", this.closeMenuOnOutside = (event) => {
      if (this.menuFor && !event.composedPath().some((node) => node?.classList?.contains?.("chat-menu-wrap"))) this.closeMenu();
    });
    this.queueRender({ reset: true });
  }

  disconnectedCallback() {
    if (this.closeMenuOnOutside) document.removeEventListener("click", this.closeMenuOnOutside);
  }

  /** The chat room, or null while there is none (sync not set up, locked). */
  set room(value) {
    if (value === this.chatRoom) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.chatRoom = value ?? null;
    this.texts.clear();
    this.announcedThrough = null;
    this.following = true;
    this.stopEditing();
    if (this.chatRoom) this.unsubscribe = this.chatRoom.subscribe(() => this.queueRender());
    this.queueRender({ reset: true });
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
    this.send.disabled = off;
  }

  enterSends() {
    return typeof matchMedia !== "function" || matchMedia("(hover: hover) and (pointer: fine)").matches;
  }

  /** Coalesces renders: the room may notify several times in a row. */
  queueRender(options = {}) {
    this.pendingReset ||= Boolean(options.reset);
    if (this.renderQueued) return this.rendering;
    this.renderQueued = true;
    this.rendering = this.rendering.then(() => new Promise((resolve) => queueMicrotask(resolve))).then(async () => {
      this.renderQueued = false;
      const reset = this.pendingReset;
      this.pendingReset = false;
      try {
        await this.render({ reset });
      } catch (error) {
        this.showNotice(error?.code === "chat_locked" ? "" : "Kin couldn't show the chat right now.");
      }
    });
    return this.rendering;
  }

  showNotice(text) {
    this.notice.textContent = text;
    this.notice.hidden = !text;
  }

  noticeText() {
    const room = this.chatRoom;
    if (!room) return "Chat works once this device syncs with your household. Turn on sync under Household → People & devices.";
    if (room.syncError?.code === "connection_unavailable") return "Offline. Messages you send wait on this device and go out when you reconnect.";
    if (room.syncError) return `Chat is paused: ${room.syncError.message}`;
    if (room.retireRefusal) return "A message was deleted here, but Kin couldn't delete its content on the household service.";
    if (room.refused?.length) return "Kin skipped a chat message it couldn't verify.";
    return "";
  }

  async render({ reset = false } = {}) {
    if (!this.list) return;
    this.applyDisabled();
    this.showNotice(this.noticeText());
    const room = this.chatRoom;
    if (!room) {
      this.list.replaceChildren();
      this.messages = [];
      this.older.hidden = true;
      this.jump.hidden = true;
      return;
    }
    const wasAtBottom = this.atBottom();
    const anchor = reset ? null : this.captureAnchor();
    const probe = room.page({ limit: 1, includeText: false });
    const previousTotal = this.total;
    this.total = probe.total;
    if (reset || this.following) {
      this.end = this.total;
      this.start = Math.max(0, this.end - Math.max(PAGE, reset ? PAGE : this.end - this.start));
      if (this.end - this.start > WINDOW_MAX) this.start = this.end - WINDOW_MAX;
      this.following = true;
    }
    this.start = Math.min(this.start, this.end);
    const page = this.end > this.start ? room.page({ before: this.end, limit: this.end - this.start }) : { messages: [], start: this.end };
    this.messages = page.messages;
    this.start = page.start;
    this.paint();
    this.older.hidden = this.start === 0;
    const grew = this.total > previousTotal && previousTotal > 0;
    if (reset || (this.following && wasAtBottom)) {
      this.scrollToBottom();
      this.jump.hidden = true;
    } else {
      if (anchor) this.restoreAnchor(anchor);
      // Scrolled up, or looking at older messages: offer the way back.
      if (!this.following || grew) this.jump.hidden = false;
    }
    if (grew) this.announceNew(previousTotal);
    else if (this.announcedThrough === null) this.announcedThrough = this.total;
    // Texts the engine doesn't hold yet: open them, then paint again.
    const missing = this.messages.filter((message) => message.text === null && message.blobRef && !this.texts.has(message.messageId));
    if (missing.length) {
      for (const message of missing) this.texts.set(message.messageId, { loading: true });
      const results = await room.loadTexts(missing);
      if (room !== this.chatRoom) return;
      for (const [messageId, result] of results) this.texts.set(messageId, result);
      const retry = [...results.values()].some((result) => typeof result.text === "string");
      if (retry) {
        const keep = this.captureAnchor();
        const bottom = this.atBottom();
        const fresh = room.page({ before: this.end, limit: Math.max(1, this.end - this.start) });
        this.messages = fresh.messages;
        this.paint();
        if (bottom) this.scrollToBottom();
        else if (keep) this.restoreAnchor(keep);
      } else this.paint();
      if (grew) this.announceNew(previousTotal, true);
    }
  }

  /** Builds the rows of the current window. */
  paint() {
    const room = this.chatRoom;
    const rows = [];
    let previous = null;
    for (const message of this.messages) {
      rows.push(this.row(message, previous, room));
      previous = message;
    }
    this.list.replaceChildren(...rows);
  }

  row(message, previous, room) {
    const item = document.createElement("li");
    item.className = "chat-row";
    item.dataset.messageId = message.messageId;
    const own = message.authorId === room.identity.memberId;
    if (own) item.classList.add("own");
    const grouped = previous && previous.authorId === message.authorId &&
      message.postedAt - previous.postedAt < GROUP_MS && previous.status !== "removed-by-admin";
    const author = room.authorLabel(message.authorId);
    if (grouped) item.classList.add("grouped");
    const header = document.createElement("p");
    header.className = "chat-meta";
    const name = document.createElement("span");
    name.className = "chat-author";
    name.textContent = author;
    const time = document.createElement("time");
    const posted = new Date(message.postedAt);
    time.dateTime = posted.toISOString();
    time.textContent = posted.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    time.title = posted.toLocaleString();
    header.append(name, " · ", time);
    // A grouped row keeps its author and time for screen readers.
    if (grouped) header.className = "chat-meta visually-hidden";
    item.append(header);

    const body = document.createElement("p");
    body.className = "chat-text";
    const visible = message.status === "live" || message.status === "edited";
    if (!visible) {
      body.classList.add("chat-gone");
      body.textContent = STATUS_TEXT[message.status];
    } else {
      const loaded = this.texts.get(message.messageId);
      if (message.text !== null) body.textContent = message.text;
      else if (loaded?.deleted) { body.classList.add("chat-gone"); body.textContent = "Message deleted"; }
      else if (loaded?.pending) { body.classList.add("chat-gone"); body.textContent = "Waiting for this message to arrive…"; }
      else if (loaded?.failed) { body.classList.add("chat-gone"); body.textContent = "This message couldn't be opened."; }
      else { body.classList.add("chat-gone"); body.textContent = "Loading…"; }
    }
    item.append(body);

    const notes = [];
    if (message.status === "edited") notes.push("Edited");
    if (room.pendingMessages?.has(message.messageId)) notes.push("Waiting to send");
    if (notes.length) {
      const note = document.createElement("p");
      note.className = "chat-note";
      note.textContent = notes.join(" · ");
      item.append(note);
    }
    const actions = this.actionsFor(message, own, room);
    if (actions.length) item.append(this.menu(message, actions, author));
    return item;
  }

  actionsFor(message, own, room) {
    const visible = message.status === "live" || message.status === "edited";
    if (!visible) return [];
    const actions = [];
    if (message.text !== null) actions.push(["copy", "Copy"]);
    if (own && message.text !== null) actions.push(["edit", "Edit"]);
    if (own) actions.push(["delete", "Delete for everyone"]);
    else if (room.isAdmin) actions.push(["remove", "Remove as admin"]);
    return actions;
  }

  menu(message, actions, author) {
    const wrap = document.createElement("div");
    wrap.className = "chat-menu-wrap";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "chat-menu-button";
    toggle.textContent = "⋯";
    toggle.setAttribute("aria-label", `Actions for ${author === "You" ? "your" : `${author}'s`} message`);
    toggle.setAttribute("aria-haspopup", "true");
    const open = this.menuFor === message.messageId;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.addEventListener("click", () => {
      if (this.menuFor === message.messageId) this.closeMenu();
      else this.openMenu(message.messageId);
    });
    wrap.append(toggle);
    if (open) {
      const list = document.createElement("div");
      list.className = "chat-menu";
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", "Message actions");
      for (const [action, label] of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.textContent = label;
        button.addEventListener("click", () => void this.act(action, message));
        list.append(button);
      }
      list.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        this.closeMenu();
        this.list.querySelector(`[data-message-id="${message.messageId}"] .chat-menu-button`)?.focus();
      });
      wrap.append(list);
    }
    return wrap;
  }

  openMenu(messageId) {
    this.menuFor = messageId;
    this.paint();
    this.list.querySelector(`[data-message-id="${messageId}"] .chat-menu button`)?.focus();
  }

  closeMenu() {
    if (!this.menuFor) return;
    this.menuFor = null;
    this.paint();
  }

  async act(action, message) {
    const room = this.chatRoom;
    this.closeMenu();
    if (!room) return;
    try {
      if (action === "copy") {
        await navigator.clipboard.writeText(message.text);
        this.say("Copied.");
      } else if (action === "edit") {
        this.editing = message;
        this.input.value = message.text;
        this.label.textContent = "Edit message";
        this.send.textContent = "Save";
        this.cancel.hidden = false;
        this.input.focus();
      } else if (action === "delete" || action === "remove") {
        const question = action === "delete"
          ? "Delete this message for everyone? Its text is deleted from every device when they next sync."
          : "Remove this message for everyone? Everyone will see \"Removed by an admin\".";
        if (!confirm(question)) return;
        await room.remove(message, { byAdmin: action === "remove" });
        this.say(action === "delete" ? "Message deleted." : "Message removed.");
      }
    } catch (error) {
      this.message.textContent = error?.message || "Kin couldn't do that right now.";
    }
  }

  stopEditing() {
    this.editing = null;
    if (!this.input) return;
    this.label.textContent = "Message";
    this.send.textContent = "Send";
    this.cancel.hidden = true;
  }

  async submit() {
    const room = this.chatRoom;
    if (!room || this.isDisabled || this.sending) return;
    const text = this.input.value;
    const problem = chatTextProblem(text);
    if (problem) {
      this.message.textContent = problem;
      this.input.focus();
      return;
    }
    this.message.textContent = "";
    this.sending = true;
    this.send.disabled = true;
    try {
      if (this.editing) await room.edit(this.editing, text);
      else await room.send(text);
      // Only clear what was sent: typing that continued meanwhile stays.
      if (this.input.value === text) this.input.value = "";
      this.stopEditing();
      this.following = true;
      await this.queueRender();
      this.scrollToBottom();
      this.jump.hidden = true;
    } catch (error) {
      this.message.textContent = error?.message || "Kin couldn't send that. Your text is still here.";
    } finally {
      this.sending = false;
      this.applyDisabled();
      this.input.focus();
    }
  }

  say(text) {
    this.announcer.textContent = "";
    queueMicrotask(() => { this.announcer.textContent = text; });
  }

  /** Announces messages that arrived from others since the last count. */
  announceNew(previousTotal, textsLoaded = false) {
    const room = this.chatRoom;
    const from = Math.max(this.announcedThrough ?? previousTotal, previousTotal);
    const incoming = this.messages.filter((message) => message.index >= from &&
      message.authorId !== room.identity.memberId && (message.status === "live" || message.status === "edited"));
    if (!textsLoaded) this.announcedThrough = this.total;
    if (!incoming.length) return;
    const last = incoming.at(-1);
    const text = last.text ?? this.texts.get(last.messageId)?.text;
    if (!text && !textsLoaded && last.text === null) {
      // Announce once its text is open (render() calls back with it).
      this.announcedThrough = from;
      return;
    }
    const who = room.authorLabel(last.authorId);
    const more = incoming.length > 1 ? `${incoming.length} new messages. ` : "";
    this.say(`${more}${who}: ${text ?? "new message"}`);
    this.announcedThrough = this.total;
  }

  atBottom() {
    const s = this.scroller;
    return !s || s.scrollHeight - s.scrollTop - s.clientHeight < EDGE;
  }

  scrollToBottom() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** The first row at or below the top of the view, and where it sits. */
  captureAnchor() {
    const top = this.scroller.getBoundingClientRect().top;
    for (const row of this.list.children) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) return { messageId: row.dataset.messageId, offset: box.top - top };
    }
    return null;
  }

  restoreAnchor(anchor) {
    const row = this.list.querySelector(`[data-message-id="${anchor.messageId}"]`);
    if (!row) return;
    const top = this.scroller.getBoundingClientRect().top;
    this.scroller.scrollTop += row.getBoundingClientRect().top - top - anchor.offset;
  }

  onScroll() {
    if (!this.chatRoom || this.paging) return;
    if (this.scroller.scrollTop < EDGE && this.start > 0) void this.loadOlder();
    else if (this.atBottom() && this.end < this.total) void this.loadNewer();
    if (this.following && this.atBottom()) this.jump.hidden = true;
  }

  /** Brings older messages into the window, trimming the newest past the
   * window's size; the rows on screen stay where they are. */
  async loadOlder() {
    if (!this.chatRoom || this.start === 0) return;
    this.paging = true;
    try {
      this.start = Math.max(0, this.start - PAGE);
      if (this.end - this.start > WINDOW_MAX) {
        this.end = this.start + WINDOW_MAX;
        this.following = false;
      }
      await this.queueRender();
    } finally {
      this.paging = false;
    }
  }

  async loadNewer() {
    if (!this.chatRoom) return;
    this.paging = true;
    try {
      this.end = Math.min(this.total, this.end + PAGE);
      if (this.end - this.start > WINDOW_MAX) this.start = this.end - WINDOW_MAX;
      if (this.end === this.total) this.following = true;
      await this.queueRender();
    } finally {
      this.paging = false;
    }
  }

  async jumpToLatest() {
    this.following = true;
    await this.queueRender({ reset: true });
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
