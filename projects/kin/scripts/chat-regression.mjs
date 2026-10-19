// Updates → Chat (#112) in a real browser: windowed rendering and paging,
// receiving (a stub room stands in for the chat relay and its live socket),
// sending with Enter and the Send button, offline queueing, editing,
// deleting, inert text, and the live region. All fixtures are synthetic.
//
// Serialized into the isolated browser: everything it uses is defined
// inside the function.
export async function chatRegressions() {
  const check = (value, message) => {
    if (!value) throw new Error(`chat: ${message}`);
  };
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  };
  const app = document.querySelector("kin-app");
  let chat = app?.chat;
  if (!chat) {
    chat = document.createElement("kin-chat");
    document.body.append(chat);
  }
  const hex = (value, length = 32) => value.toString(16).padStart(length, "0");
  const me = "a1".repeat(16), other = "b2".repeat(16), third = "c5".repeat(16);
  const listeners = new Set();
  const log = [];
  const held = new Map();
  const sources = new Map();
  const start = Date.UTC(2026, 9, 18, 8, 0, 0);
  let clock = 0;
  let ids = 0;
  const add = (authorId, text, { incoming = false, at = log.length } = {}) => {
    ids += 1;
    const messageId = hex(ids);
    const blobRef = hex(ids, 64);
    log.splice(at, 0, { messageId, authorId, deviceId: hex(9), postedAt: start + (clock += 60_000), editedAt: null, status: "live", contentKind: "text", blobRef, blobKey: new Uint8Array(32).fill(1) });
    // Incoming text isn't in the engine yet: the view must load it.
    if (incoming) sources.set(blobRef, text);
    else held.set(blobRef, text);
    return messageId;
  };
  const notify = () => { for (const listener of listeners) listener(); };
  // What a reply quotes, looked up from its original every time (#129).
  const quoteOf = (id) => {
    const original = log.find((row) => row.messageId === id);
    if (!original) return { messageId: id, state: "unknown", contentKind: null, authorId: null, index: null, blobRef: null, blobKey: null, text: null };
    const shown = original.status === "live" || original.status === "edited";
    return {
      messageId: id, state: original.status, contentKind: original.contentKind, authorId: original.authorId, index: log.indexOf(original),
      blobRef: shown ? original.blobRef : null, blobKey: shown ? original.blobKey : null, text: shown ? held.get(original.blobRef) ?? null : null,
    };
  };
  const calls = { send: [], edit: [], remove: [], hide: [], attach: [], search: [] };
  const attachments = new Map();
  const room = {
    identity: { memberId: me, householdId: "c3".repeat(16), deviceId: "d4".repeat(16) },
    admins: [me],
    pendingMessages: new Set(),
    syncError: null,
    refused: [],
    retireRefusal: null,
    get isAdmin() { return true; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    authorLabel(id) { return id === me ? "You" : id === third ? "Adult 3" : "Adult 2"; },
    page({ before = null, limit = 50 } = {}) {
      const end = before ?? log.length;
      const first = Math.max(0, end - limit);
      return {
        total: log.length,
        start: first,
        messages: log.slice(first, end).map((message, offset) => ({
          ...message,
          replyTo: message.replyOf ? quoteOf(message.replyOf) : null,
          index: first + offset,
          text: message.blobRef ? held.get(message.blobRef) ?? null : null,
        })),
        retired: [],
      };
    },
    async loadTexts(messages) {
      const results = new Map();
      for (const message of messages) {
        const text = sources.get(message.blobRef);
        if (text === undefined) results.set(message.messageId, { pending: true });
        else { held.set(message.blobRef, text); results.set(message.messageId, { text }); }
      }
      return results;
    },
    async loadQuoteTexts(messages) {
      const results = new Map();
      for (const { replyTo } of messages) {
        if (!replyTo?.blobRef || replyTo.text !== null) continue;
        const text = sources.get(replyTo.blobRef);
        if (text === undefined) results.set(replyTo.messageId, { pending: true });
        else { held.set(replyTo.blobRef, text); results.set(replyTo.messageId, { text }); }
      }
      return results;
    },
    members: [{ id: me, kind: "adult", active: true }, { id: other, kind: "adult", active: true }, { id: third, kind: "adult", active: true }],
    // Chat search (#124): the engine's, simplified. Folds case and accents
    // one UTF-16 unit at a time, so string indexes stay put; ranges are UTF-8
    // byte offsets, as the engine reports them.
    async search(options, onUpdate, stopped = () => false) {
      calls.search.push(options);
      const fold = (text) => [...text].map((ch) => ch.normalize("NFD")[0].toLowerCase()).join("");
      const needle = fold(options.query);
      const encoder = new TextEncoder();
      const run = (searching, incomplete) => {
        const results = [];
        let total = 0;
        for (let index = log.length - 1; index >= 0; index -= 1) {
          const message = log[index];
          if (message.status !== "live" && message.status !== "edited") continue;
          if (this.hidden.has(message.messageId)) continue;
          if (options.authors?.length && !options.authors.includes(message.authorId)) continue;
          if (options.attachmentsOnly && message.contentKind !== "attachment") continue;
          const text = held.get(message.blobRef);
          let ranges = [];
          if (needle) {
            if (message.contentKind !== "text" || text === undefined) continue;
            const at = fold(text).indexOf(needle);
            if (at < 0) continue;
            ranges = [[encoder.encode(text.slice(0, at)).length, encoder.encode(text.slice(0, at + needle.length)).length]];
          }
          total += 1;
          if (results.length < options.limit) results.push({
            messageId: message.messageId, index, authorId: message.authorId, postedAt: message.postedAt,
            contentKind: message.contentKind, ranges, excerpt: text ?? "", excerptOffset: 0,
          });
        }
        return { total, results, searching, incomplete };
      };
      const older = log.filter((message) => message.contentKind === "text" && !held.has(message.blobRef) && sources.has(message.blobRef));
      onUpdate(run(older.length > 0, false));
      if (!older.length || stopped()) return run(false, false);
      await new Promise((resolve) => setTimeout(resolve, 40));
      for (const message of older) held.set(message.blobRef, sources.get(message.blobRef));
      const done = run(false, false);
      onUpdate(done);
      return done;
    },
    async openAttachment(message) {
      const found = attachments.get(message.blobRef);
      if (!found) throw Object.assign(new Error("gone"), { code: "chat_attachment_deleted" });
      return { text: found.text, files: found.files.map((file) => ({ name: file.name, type: file.type, size: file.size, photo: file.type.startsWith("image/") })) };
    },
    async attachmentFile(message, index) {
      return attachments.get(message.blobRef).files[index];
    },
    async attachmentThumbnail(message, index) {
      const file = attachments.get(message.blobRef).files[index];
      return file.type.startsWith("image/") ? new Blob([file], { type: "image/jpeg" }) : null;
    },
    async sendAttachments({ text, files }) {
      calls.attach.push([text, files.map((file) => file.name)]);
      ids += 1;
      const messageId = hex(ids);
      const blobRef = hex(ids, 64);
      log.push({ messageId, authorId: me, deviceId: hex(9), postedAt: start + (clock += 60_000), editedAt: null, status: "live", contentKind: "attachment", blobRef, blobKey: new Uint8Array(32).fill(2) });
      attachments.set(blobRef, { text, files });
      notify();
      return { messageId };
    },
    async send(text) {
      calls.send.push(text);
      const messageId = add(me, text);
      this.pendingMessages.add(messageId);
      notify();
      return { messageId };
    },
    async edit(message, text) {
      calls.edit.push([message.messageId, text]);
      const entry = log.find((row) => row.messageId === message.messageId);
      entry.status = "edited";
      entry.blobRef = hex(1000 + log.length, 64);
      held.set(entry.blobRef, text);
      notify();
    },
    hidden: new Set(),
    isHidden(messageId) { return this.hidden.has(messageId); },
    async hide(message) {
      calls.hide.push(message.messageId);
      this.hidden.add(message.messageId);
      notify();
    },
    async remove(message, { byAdmin = false } = {}) {
      calls.remove.push([message.messageId, byAdmin]);
      const entry = log.find((row) => row.messageId === message.messageId);
      Object.assign(entry, { status: byAdmin ? "removed-by-admin" : "deleted", blobRef: null, blobKey: null });
      notify();
    },
  };
  const rows = () => [...chat.querySelectorAll(".chat-row")];
  const textOf = (row) => row.querySelector(".chat-text").textContent;
  const scroller = chat.querySelector(".chat-scroll");

  // No room: nothing to show, and the composer is off.
  chat.room = null;
  await settle();
  check(chat.querySelector(".chat-notice").textContent.includes("syncs with your household"), "explains chat needs sync");
  check(chat.querySelector("textarea").disabled, "no composer without a room");
  check(scroller.getAttribute("role") === "log" && scroller.getAttribute("aria-live") === "off", "a quiet log region");

  // A long history renders only a window, newest at the bottom.
  for (let index = 0; index < 500; index += 1) add(index % 3 ? other : me, `Message ${index}`);
  chat.room = room;
  await settle();
  check(rows().length === 60, `renders a window, not the history (${rows().length})`);
  check(textOf(rows().at(-1)) === "Message 499", "newest at the bottom");
  check(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2, "starts at the latest message");
  check(!chat.querySelector("textarea").disabled, "composer on");
  // The admin's chat policy (#123): read only swaps the composer for a note
  // and removes the author's own edit/delete; no access hides the chat.
  const accessEvents = [];
  chat.addEventListener("kin:chat-access", (event) => accessEvents.push(event.detail.access));
  room.access = "read";
  notify();
  await settle();
  check(chat.querySelector(".chat-form").hidden, "read only: no message box");
  check(!chat.querySelector(".chat-read-only").hidden && chat.querySelector(".chat-read-only").textContent.includes("read-only for you"), "read only: says why");
  check(!scroller.hidden, "read only: the conversation is still there");
  check(accessEvents.at(-1) === "read", "the app hears the change");
  const labels = chat.actionsFor({ ...room.page().messages.find((entry) => entry.authorId === room.identity.memberId), text: "x", contentKind: "text" }, room);
  check(!labels.includes("edit") && !labels.includes("delete") && labels.includes("copy") && labels.includes("hide"), `read only: copy and hide only (${labels})`);
  room.access = "none";
  notify();
  await settle();
  check(scroller.hidden && chat.querySelector(".chat-form").hidden, "no access: nothing of the chat shows");
  check(chat.querySelector(".chat-notice").textContent.includes("isn't available"), "no access: says so");
  check(accessEvents.at(-1) === "none", "the app hears it, and hides the Chat tab");
  check(location.hash !== "#updates/chat", "no access: the Chat tab is left");
  room.access = "write";
  notify();
  await settle();
  location.hash = "#updates/chat";
  await settle();
  check(!chat.querySelector(".chat-form").hidden && chat.querySelector(".chat-read-only").hidden && !scroller.hidden, "restored: composer back");
  // Grouping: consecutive messages from one author show the author once.
  const grouped = rows().filter((row) => row.classList.contains("grouped"));
  check(grouped.length > 0 && grouped.every((row) => row.querySelector(".chat-meta.visually-hidden")), "grouped rows keep their author for screen readers");

  // A fresh view paging up through history it never showed stays quiet.
  {
    const fresh = document.createElement("kin-chat");
    chat.after(fresh);
    fresh.room = room;
    await settle();
    const heard = [];
    const freshAnnouncer = fresh.querySelector('.visually-hidden[aria-live="polite"]');
    const ear = new MutationObserver(() => { if (freshAnnouncer.textContent) heard.push(freshAnnouncer.textContent); });
    ear.observe(freshAnnouncer, { childList: true, characterData: true, subtree: true });
    for (let i = 0; i < 4; i += 1) {
      fresh.querySelector(".chat-older").click();
      await settle();
    }
    const freshScroller = fresh.querySelector(".chat-scroll");
    freshScroller.scrollTop = 0;
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    check(heard.length === 0, `paging through unseen history announces nothing (${heard})`);
    ear.disconnect();
    fresh.room = null;
    fresh.remove();
  }

  // Scrolling up loads older messages and keeps the rows on screen in place.
  const anchorRow = rows()[3];
  const anchorId = anchorRow.dataset.messageId;
  scroller.scrollTop = anchorRow.offsetTop - scroller.offsetTop - 0;
  const before = anchorRow.getBoundingClientRect().top;
  chat.querySelector(".chat-older").click();
  await settle();
  check(rows().length === 120, `an older page joins the window (${rows().length})`);
  const after = chat.querySelector(`[data-message-id="${anchorId}"]`).getBoundingClientRect().top;
  check(Math.abs(after - before) < 3, `position kept while paging (${before} → ${after})`);
  for (let i = 0; i < 5; i += 1) {
    chat.querySelector(".chat-older").click();
    await settle();
  }
  check(rows().length <= 240, `the window stays bounded (${rows().length})`);
  check(!chat.querySelector(".chat-jump").hidden, "jump to latest when the latest is out of the window");
  chat.querySelector(".chat-jump").click();
  await settle();
  check(textOf(rows().at(-1)) === "Message 499" && chat.querySelector(".chat-jump").hidden, "jumped back to the latest");

  // Receiving (what the live socket's hint brings): appended, its text
  // loaded, announced politely, and shown as text only.
  const announcer = chat.querySelector('.visually-hidden[aria-live="polite"]');
  add(other, '<img src=x onerror="window.chatXss=1"> Dinner at 6', { incoming: true });
  notify();
  await settle();
  await settle();
  check(textOf(rows().at(-1)) === '<img src=x onerror="window.chatXss=1"> Dinner at 6', "incoming text shown as text");
  check(!chat.querySelector(".chat-list img") && !window.chatXss, "inert text");
  check(announcer.textContent.startsWith("Adult 2: <img"), `incoming announced (${announcer.textContent})`);
  check(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2, "followed while at the bottom");
  // Scrolled up, a new message doesn't move the view; jump appears.
  scroller.scrollTop = 0;
  await settle();
  const top = scroller.scrollTop;
  add(other, "Bring bread", { incoming: true });
  notify();
  await settle();
  check(!chat.querySelector(".chat-jump").hidden, "jump appears for new messages while scrolled up");
  check(Math.abs(scroller.scrollTop - top) < 400, "the view wasn't yanked to the bottom");
  chat.querySelector(".chat-jump").click();
  await settle();

  // Sending: Enter sends, Shift+Enter doesn't; offline it waits.
  const input = chat.querySelector("textarea");
  input.value = "Line one";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  await settle();
  check(calls.send.length === 0, "Shift+Enter adds a line");
  input.value = "On my way";
  if (chat.enterSends()) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  else chat.querySelector('.chat-form button[type="submit"]').click();
  await settle();
  check(calls.send.at(-1) === "On my way", "sent");
  check(input.value === "", "composer cleared");
  const mine = rows().at(-1);
  check(textOf(mine) === "On my way" && mine.classList.contains("own"), "own message at the bottom");
  check(mine.querySelector(".chat-note")?.textContent.includes("Waiting to send"), "offline: waiting to send");
  room.pendingMessages.clear();
  notify();
  await settle();
  check(!rows().at(-1).querySelector(".chat-note"), "reconnected: sent");
  // The Send button sends too; a too-long message is refused before sending.
  input.value = "x".repeat(4001);
  chat.querySelector('.chat-form button[type="submit"]').click();
  await settle();
  check(calls.send.length === 1 && chat.querySelector("#chat-message").textContent.includes("too long"), "too long refused");
  check(input.value.length === 4001, "the draft stays");
  input.value = "Send button";
  chat.querySelector('.chat-form button[type="submit"]').click();
  await settle();
  check(calls.send.at(-1) === "Send button", "Send button sends");

  // Editing and deleting through the row menu.
  const ownRow = rows().at(-1);
  ownRow.querySelector(".chat-menu-button").click();
  await settle();
  const menu = chat.querySelector(`[data-message-id="${ownRow.dataset.messageId}"] .chat-menu`);
  check(menu && document.activeElement === menu.querySelector("button"), "menu opens with focus");
  check([...menu.querySelectorAll("button")].map((button) => button.dataset.action).join() === "copy,reply,edit,delete", "own message actions (not Delete for me while it waits to send)");
  menu.querySelector('[data-action="edit"]').click();
  await settle();
  check(input.value === "Send button" && chat.querySelector(".chat-cancel").hidden === false, "editing in the composer");
  check(chat.querySelector(".chat-form").classList.contains("chat-editing") && chat.querySelector(".chat-form label").textContent === "Editing message", "a clear editing bar");
  input.value = "Send button (fixed)";
  chat.querySelector('.chat-form button[type="submit"]').click();
  await settle();
  check(calls.edit.at(-1)?.[1] === "Send button (fixed)", "edit saved");
  const editedRow = rows().at(-1);
  check(textOf(editedRow) === "Send button (fixed)", "edited text shown");
  check(editedRow.classList.contains("grouped")
    ? editedRow.querySelector(".chat-note").textContent.startsWith("Edited") && editedRow.querySelector(".chat-meta").textContent.includes("edited")
    : editedRow.querySelector(".chat-meta .chat-edited")?.textContent.includes("edited"), "\"edited\" by the time, in the row's text");
  check(!chat.querySelector(".chat-form").classList.contains("chat-editing"), "the editing bar goes");
  const theirs = rows().findLast((row) => !row.classList.contains("own"));
  theirs.querySelector(".chat-menu-button").click();
  await settle();
  const theirMenu = chat.querySelector(`[data-message-id="${theirs.dataset.messageId}"] .chat-menu`);
  check([...theirMenu.querySelectorAll("button")].map((button) => button.dataset.action).join() === "copy,reply,remove,hide", "an admin may remove others' messages");
  const realConfirm = window.confirm;
  const questions = [];
  window.confirm = (question) => { questions.push(question); return true; };
  try {
    theirMenu.querySelector('[data-action="remove"]').click();
    await settle();
  } finally {
    window.confirm = realConfirm;
  }
  check(calls.remove.at(-1)?.[1] === true, "removed as admin");
  check(textOf(chat.querySelector(`[data-message-id="${theirs.dataset.messageId}"]`)) === "Removed by an admin", "removal shown to everyone");
  check(questions.at(-1).includes("can't be recalled"), "the confirmation says copies can't be recalled");
  // Delete for everyone on your own: the placeholder keeps author and time.
  window.confirm = (question) => { questions.push(question); return true; };
  const ownForDelete = rows().findLast((row) => row.classList.contains("own") && row.querySelector(".chat-menu-button"));
  ownForDelete.querySelector(".chat-menu-button").click();
  await settle();
  chat.querySelector(`[data-message-id="${ownForDelete.dataset.messageId}"] [data-action="delete"]`).click();
  await settle();
  const deletedRow = chat.querySelector(`[data-message-id="${ownForDelete.dataset.messageId}"]`);
  check(textOf(deletedRow) === "This message was deleted" && deletedRow.querySelector("time"), "deleted placeholder with author and time");
  check(questions.at(-1).startsWith("Delete this message for everyone?") && questions.at(-1).includes("can't be recalled"), "delete-for-everyone confirmation");
  // Delete for me: gone from this view only.
  const forMe = rows().findLast((row) => !row.classList.contains("own"));
  forMe.querySelector(".chat-menu-button").click();
  await settle();
  chat.querySelector(`[data-message-id="${forMe.dataset.messageId}"] [data-action="hide"]`).click();
  await settle();
  check(calls.hide.at(-1) === forMe.dataset.messageId && !chat.querySelector(`[data-message-id="${forMe.dataset.messageId}"]`), "deleted for me: hidden here");
  check(questions.at(-1).includes("Nobody else sees any change"), "delete-for-me confirmation");
  window.confirm = realConfirm;
  // Escape closes a menu and returns focus to its button.
  const escapeRow = rows().at(-1);
  escapeRow.querySelector(".chat-menu-button").click();
  await settle();
  chat.querySelector(".chat-menu button").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await settle();
  check(!chat.querySelector(".chat-menu") && document.activeElement?.classList.contains("chat-menu-button"), "Escape closes the menu");

  // Announcements: only others' new messages, once each, never paging.
  const said = [];
  const watcher = new MutationObserver(() => { if (announcer.textContent) said.push(announcer.textContent); });
  watcher.observe(announcer, { childList: true, characterData: true, subtree: true });
  const quiet = async () => { await settle(); await new Promise((resolve) => setTimeout(resolve, 120)); };
  said.length = 0;
  await chat.loadOlder();
  await quiet();
  check(said.length === 0, `paging announces nothing (${said})`);
  await chat.jumpToLatest();
  await room.send("mine, not announced");
  await quiet();
  check(!said.some((text) => text.includes("mine, not announced")), "own messages aren't announced");
  // A message written offline earlier lands mid-log: still announced as itself.
  add(other, "late from the train", { incoming: true, at: log.length - 3 });
  notify();
  await quiet();
  check(said.filter((text) => text.includes("late from the train")).length === 1, `a late message is announced once (${said})`);
  notify();
  await quiet();
  check(said.filter((text) => text.includes("late from the train")).length === 1, "and not again");
  // Focus on a row's button survives a new message.
  const focusRow = rows().at(-2);
  focusRow.querySelector(".chat-menu-button").focus();
  add(other, "while focused", { incoming: true });
  notify();
  await quiet();
  check(document.activeElement === chat.querySelector(`[data-message-id="${focusRow.dataset.messageId}"] .chat-menu-button`), "focus kept across a new message");
  // A text that couldn't be opened is retried on the next change.
  const flaky = add(other, "eventually", { incoming: true });
  const realLoad = room.loadTexts;
  room.loadTexts = async (messages) => new Map(messages.map((message) => [message.messageId, { failed: true }]));
  notify();
  await quiet();
  check(textOf(chat.querySelector(`[data-message-id="${flaky}"]`)).includes("couldn't be opened"), "failed text shown as such");
  room.loadTexts = realLoad;
  notify();
  await quiet();
  check(textOf(chat.querySelector(`[data-message-id="${flaky}"]`)) === "eventually", "and retried");
  // Editing keeps the unsent draft; Cancel (or Escape) brings it back.
  input.value = "half-written";
  const editable = rows().findLast((row) => row.classList.contains("own") && row.querySelector(".chat-menu-button"));
  editable.querySelector(".chat-menu-button").click();
  await settle();
  chat.querySelector('.chat-menu [data-action="edit"]').click();
  await settle();
  check(input.value !== "half-written", "editing shows the message");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  check(input.value === "half-written" && chat.querySelector(".chat-cancel").hidden, "Escape cancels the edit and restores the draft");
  input.value = "";
  // Scrolling down into the newest page keeps the reader's place.
  for (let i = 0; i < 6; i += 1) { chat.querySelector(".chat-older").click(); await settle(); }
  check(!chat.following, "reading older history");
  while (chat.end < chat.total - 60) await chat.loadNewer();
  const last = rows().at(-1);
  scroller.scrollTop = last.offsetTop - scroller.offsetTop - scroller.clientHeight + last.offsetHeight;
  const lastId = last.dataset.messageId;
  const lastTop = last.getBoundingClientRect().top;
  await chat.loadNewer();
  await settle();
  const after2 = chat.querySelector(`[data-message-id="${lastId}"]`)?.getBoundingClientRect().top;
  check(after2 !== undefined && Math.abs(after2 - lastTop) < 3, `reaching the newest page keeps the place (${lastTop} → ${after2})`);
  watcher.disconnect();

  // Emoji (#113): the picker inserts at the cursor, moves by keyboard, names
  // each emoji; a message of 1–3 emoji shows larger.
  {
    const toggle = chat.querySelector(".emoji-toggle");
    const order = [...chat.querySelectorAll("textarea, .emoji-slot, .emoji-toggle, .chat-form button[type=submit]")];
    check(order.map((node) => node.className || node.tagName).join() === "TEXTAREA,emoji-slot,emoji-toggle,add-button", "the panel sits after the message, before the buttons");
    check(toggle && toggle.getAttribute("aria-expanded") === "false", "an emoji button");
    input.value = "Dinner ready";
    input.setSelectionRange(6, 6);
    toggle.click();
    for (let i = 0; i < 40 && !chat.querySelector(".emoji-grid button"); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const grid = chat.querySelector(".emoji-grid");
    check(grid && toggle.getAttribute("aria-expanded") === "true", "the picker opens");
    const buttons = [...grid.querySelectorAll("button")];
    check(document.activeElement === buttons[0], "focus on the first emoji");
    check(buttons.every((button) => button.getAttribute("aria-label")) && buttons[0].getAttribute("aria-label") === "grinning face", "each emoji has its short name");
    check(buttons.filter((button) => button.tabIndex === 0).length === 1, "one tab stop in the grid");
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    check(document.activeElement === buttons[1], "ArrowRight moves");
    const perRow = buttons.findIndex((button) => button.offsetTop !== buttons[0].offsetTop);
    buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    check(document.activeElement === buttons[1 + perRow], `ArrowDown moves a row (${perRow})`);
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    check(document.activeElement === buttons.at(-1), "End");
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    check(document.activeElement === buttons[0], "Home");
    buttons[0].click();
    check(input.value === "Dinner😀 ready", `inserted at the cursor (${input.value})`);
    // Another category.
    const categories = [...chat.querySelectorAll(".emoji-categories button")];
    check(categories.length >= 5 && categories[0].getAttribute("aria-pressed") === "true", "categories");
    categories[3].click();
    await settle();
    check(chat.querySelector(".emoji-categories button[aria-pressed=\"true\"]").getAttribute("aria-label") === "Food & drink", "switches category");
    check(chat.querySelector(".emoji-grid button").getAttribute("aria-label") === "red apple", "that category's emoji");
    // Escape closes and returns focus to the button.
    chat.querySelector(".emoji-grid button").focus();
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    check(chat.querySelector(".emoji-panel").hidden && document.activeElement === toggle, "Escape closes the picker");
    // Too long: refused with a message, text unchanged.
    input.value = "x".repeat(4000);
    input.setSelectionRange(4000, 4000);
    toggle.click();
    for (let i = 0; i < 20 && chat.querySelector(".emoji-panel").hidden; i += 1) await settle();
    chat.querySelector(".emoji-grid button").click();
    check(input.value.length === 4000 && chat.querySelector("#chat-message").textContent.includes("too long"), "an emoji past the limit is refused");
    input.value = "x".repeat(3999);
    input.setSelectionRange(3999, 3999);
    const firstEmoji = chat.querySelector(".emoji-grid button");
    firstEmoji.click();
    check(input.value === "x".repeat(3999) + firstEmoji.textContent && firstEmoji.textContent.length === 2, "4,000 scalars (4,001 UTF-16 units) fit");
    check(!chat.querySelector("#chat-message").textContent, "and clear the too-long message");
    // Undo still works after an insert.
    input.value = "";
    input.focus();
    document.execCommand("insertText", false, "hello");
    chat.querySelector(".emoji-grid button").click();
    check(input.value === "hello" + firstEmoji.textContent, "inserted after typing");
    input.focus();
    document.execCommand("undo");
    check(input.value === "hello", `undo takes back the emoji (${input.value})`);
    toggle.click();
    input.value = "";
    chat.querySelector("#chat-message").textContent = "";
    // Large emoji-only messages.
    const big = add(other, "🎉🎂", { incoming: true });
    const mixed = add(other, "Happy birthday 🎉", { incoming: true });
    const four = add(other, "😀😀😀😀", { incoming: true });
    notify();
    await settle();
    await settle();
    const bodyOf = (id) => chat.querySelector(`[data-message-id="${id}"] .chat-text`);
    check(bodyOf(big).classList.contains("chat-emoji-only"), "1–3 emoji render larger");
    check(!bodyOf(mixed).classList.contains("chat-emoji-only") && !bodyOf(four).classList.contains("chat-emoji-only"), "text, or four emoji, don't");
    check(parseFloat(getComputedStyle(bodyOf(big)).fontSize) > parseFloat(getComputedStyle(bodyOf(mixed)).fontSize) * 1.5, "visibly larger");
  }

  // Offline notice.
  room.syncError = Object.assign(new Error("offline"), { code: "connection_unavailable" });
  notify();
  await settle();
  check(chat.querySelector(".chat-notice").textContent.startsWith("Offline"), "offline explained");
  room.syncError = null;

  // Narrow screens reflow without sideways scrolling.
  const width = chat.style.width;
  chat.style.width = "320px";
  await settle();
  check(scroller.scrollWidth <= scroller.clientWidth + 1 && chat.scrollWidth <= 321, "no sideways scrolling at 320px");
  chat.style.width = width;

  // Opened while hidden (unlock lands on Today): shown, it's at the latest.
  chat.room = null;
  await settle();
  check(!rows().length, "rows dropped without a room");
  const panel = chat.parentElement;
  const wasHidden = panel.hidden;
  panel.hidden = true;
  const said2 = [];
  const watcher2 = new MutationObserver(() => { if (announcer.textContent) said2.push(announcer.textContent); });
  watcher2.observe(announcer, { childList: true, characterData: true, subtree: true });
  chat.room = room;
  await settle();
  panel.hidden = false;
  await settle();
  check(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2, "shown later, the list is at the latest");
  check(chat.querySelector(".chat-jump").hidden, "no jump needed");
  await new Promise((resolve) => setTimeout(resolve, 120));
  check(said2.length === 0, "a new room's history isn't announced");
  watcher2.disconnect();
  panel.hidden = wasHidden;

  // An empty room's first message from someone else is announced.
  const empty = { ...room, page: () => ({ total: 0, start: 0, messages: [], retired: [] }) };
  const listeners2 = new Set();
  empty.subscribe = (listener) => { listeners2.add(listener); return () => listeners2.delete(listener); };
  chat.room = empty;
  await settle();
  const first = { messageId: hex(99_999), authorId: other, deviceId: hex(9), postedAt: Date.now(), editedAt: null, status: "live", contentKind: "text", blobRef: null, blobKey: null, text: "hello?", index: 0 };
  empty.page = () => ({ total: 1, start: 0, messages: [first], retired: [] });
  for (const listener of listeners2) listener();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 120));
  check(announcer.textContent === "Adult 2: hello?", `the first message is announced (${announcer.textContent})`);
  // Photos and files (#114): chosen in the file dialog, listed, sent with a
  // caption; a photo shows a thumbnail and opens in the viewer; a file shows
  // its name and size and downloads. Refusals are plain.
  chat.room = room;
  await settle();
  // The attach button makes a file input for one choice; capture it here
  // rather than let the dialog open.
  const choose = async (files) => {
    let fileInput = null;
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function captured() { if (this.type === "file") fileInput = this; else click.call(this); };
    try {
      chat.querySelector(".chat-attach").click();
    } finally {
      HTMLInputElement.prototype.click = click;
    }
    check(fileInput !== null, "attach opens a file input for one choice");
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("change"));
    await settle();
    check(!fileInput.isConnected, "the file input is removed after the choice");
  };
  const pdf = new File([new Uint8Array(2048)], "Permission slip.pdf", { type: "application/pdf" });
  const photo = new File([new Uint8Array(512)], "IMG_2041.jpg", { type: "image/jpeg" });
  await choose([pdf]);
  check(!chat.querySelector(".chat-pending").hidden && chat.querySelector(".chat-pending").textContent.includes("Permission slip.pdf"), "a chosen file is listed to send");
  await choose([new File([new Uint8Array(4)], "scan.heic", { type: "image/heic" })]);
  check(chat.querySelector(".compose-message").textContent.includes("can't be sent as a photo"), `a HEIC photo is refused plainly (${chat.querySelector(".compose-message").textContent})`);
  check(chat.querySelector(".chat-pending").textContent.includes("Permission slip.pdf") && !chat.querySelector(".chat-pending").textContent.includes("scan.heic"), "a refused file isn't listed");
  await choose([photo]);
  const pendingRemove = [...chat.querySelectorAll(".chat-pending-remove")].find((button) => button.getAttribute("aria-label") === "Remove IMG_2041.jpg");
  check(Boolean(pendingRemove), "each chosen file can be removed");
  pendingRemove.click();
  await settle();
  check(!chat.querySelector(".chat-pending").textContent.includes("IMG_2041.jpg"), "removing a chosen file unlists it");
  await choose([photo]);
  const textBox = chat.querySelector("textarea");
  textBox.value = "Sign by Friday";
  chat.querySelector("form").requestSubmit();
  await settle();
  check(calls.attach.length === 1 && calls.attach[0][0] === "Sign by Friday" && calls.attach[0][1].join() === "Permission slip.pdf,IMG_2041.jpg", "sent with its caption and files");
  check(chat.querySelector(".chat-pending").hidden && textBox.value === "", "the composer clears after sending");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  const sent = rows().at(-1);
  check(sent.querySelector(".chat-text").textContent === "Sign by Friday", "the caption shows");
  check(sent.querySelector(".chat-file")?.getAttribute("aria-label")?.startsWith("Download Permission slip.pdf, PDF, "), "a file shows its name, type and size");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  const thumb = sent.querySelector(".chat-photo img");
  check(Boolean(thumb?.src?.startsWith("blob:")), "a photo shows a thumbnail");
  sent.querySelector(".chat-photo").click();
  await settle();
  const viewer = chat.querySelector("dialog.chat-viewer");
  check(viewer.open && viewer.querySelector("img").alt === "Photo: IMG_2041.jpg", "a photo opens in the viewer");
  viewer.querySelector(".chat-viewer-actions button:last-child").click();
  await settle();
  check(!viewer.open, "the viewer closes");

  // Read receipts and typing (#120): a stub presence stands in for the
  // room's. A message counts as read only while on screen in a visible,
  // focused window; the newest of the member's own messages carries
  // "Seen by"; who is typing is plain text, not an announcement.
  const presenceListeners = new Set();
  const presence = {
    marks: [], typedCount: 0, stoppedCount: 0, readersByMessage: new Map(), typingIds: [], sendsReceipts: true,
    get settings() { return { receipts: this.sendsReceipts, typing: this.sendsTyping !== false }; },
    markRead(message) { this.marks.push(message.messageId); return true; },
    readers(message) { return this.sendsReceipts ? this.readersByMessage.get(message.messageId) ?? [] : []; },
    typing() { return this.typingIds; },
    typed() { this.typedCount += 1; },
    stopTyping() { this.stoppedCount += 1; },
  };
  room.presence = presence;
  room.members = [{ id: me, active: true }, { id: other, active: true }, { id: third, active: true }];
  room.subscribePresence = (listener) => { presenceListeners.add(listener); return () => presenceListeners.delete(listener); };
  const presenceChanged = async () => { for (const listener of presenceListeners) listener(); await settle(); };
  const mineLast = [...log].reverse().find((message) => message.authorId === me && message.status === "live" && !room.pendingMessages.has(message.messageId));
  chat.room = null;
  await settle();
  chat.room = room;
  await settle();
  // Read tracking: nothing counts while the window isn't visible and focused.
  const realCanRead = chat.canRead.bind(chat);
  chat.canRead = () => false;
  presence.marks.length = 0;
  scroller.scrollTop = scroller.scrollHeight;
  await settle();
  chat.windowChanged();
  check(!presence.marks.length, `nothing is marked read in a window that isn't focused (${presence.marks.length})`);
  chat.canRead = () => true;
  chat.windowChanged();
  await settle();
  const newest = log.at(-1).messageId;
  check(presence.marks.at(-1) === newest, `the newest message on screen is marked read once the window is focused (${presence.marks.at(-1)})`);
  check(!presence.marks.some((id) => log.findIndex((message) => message.messageId === id) < log.length - 80), "messages far above the screen aren't marked");
  // Scrolling away from the newest marks what is on screen then (the cursor
  // itself only moves forward, in the room).
  presence.marks.length = 0;
  scroller.scrollTop = 0;
  await settle();
  chat.windowChanged();
  check(presence.marks.length > 0 && log.findIndex((message) => message.messageId === presence.marks.at(-1)) < log.length - 40, "scrolled up, an older message is the newest on screen");
  scroller.scrollTop = scroller.scrollHeight;
  await settle();
  chat.canRead = realCanRead;

  // "Seen by" sits under the member's latest message and opens its details.
  check(!chat.querySelector(".chat-seen"), "no Seen by line while no one has read it");
  presence.readersByMessage.set(mineLast.messageId, [{ memberId: other, readAt: start + 7_200_000 }]);
  await presenceChanged();
  const seenRow = chat.querySelector(`.chat-row[data-message-id="${mineLast.messageId}"]`);
  check(seenRow && seenRow === rows().filter((row) => row.classList.contains("own")).at(-1) || log.at(-1).authorId !== me, "Seen by belongs to the member's latest own message");
  const seen = chat.querySelector(".chat-seen");
  check(seen && seen.textContent === "Seen by Adult 2", `names who has read it (${seen?.textContent})`);
  presence.readersByMessage.set(mineLast.messageId, [{ memberId: other, readAt: start + 7_200_000 }, { memberId: third, readAt: start + 7_260_000 }]);
  await presenceChanged();
  check(chat.querySelector(".chat-seen").textContent === "Seen by everyone", `everyone when all other members have (${chat.querySelector(".chat-seen")?.textContent})`);
  check(chat.querySelectorAll(".chat-seen").length === 1, "only one message carries the line");
  presence.readersByMessage.set(mineLast.messageId, [{ memberId: other, readAt: start + 7_200_000 }]);
  await presenceChanged();
  chat.querySelector(".chat-seen").focus();
  chat.querySelector(".chat-seen").click();
  await settle();
  const details = chat.querySelector("dialog.chat-details");
  check(details.open && details.textContent.includes("Message details") && details.textContent.includes("Adult 2 · ") && details.textContent.includes("Not seen yet: Adult 3"), `details list each reader with a time and who hasn't (${details.textContent})`);
  check(details.querySelector("time")?.dateTime, "each reader's time is a real time");
  details.querySelector("button").click();
  await settle();
  check(!details.open && document.activeElement?.classList.contains("chat-seen"), "closing details returns focus to the line");
  presence.sendsReceipts = false;
  await presenceChanged();
  check(!chat.querySelector(".chat-seen"), "receipts off: no Seen by lines");
  presence.sendsReceipts = true;
  presence.readersByMessage.clear();

  // Typing: plain text under the list, not a live announcement.
  const typingLine = chat.querySelector(".chat-typing");
  check(typingLine && typingLine.hidden && scroller.getAttribute("aria-describedby") === typingLine.id, "the typing line is the log's description");
  check(!typingLine.closest("[aria-live]") && !typingLine.hasAttribute("aria-live") && typingLine.getAttribute("role") === null, "and not a live region");
  presence.typingIds = [other];
  await presenceChanged();
  check(!typingLine.hidden && typingLine.textContent === "Adult 2 is typing…", `one person typing (${typingLine.textContent})`);
  presence.typingIds = [other, third];
  await presenceChanged();
  check(typingLine.textContent === "Adult 2 and Adult 3 are typing…", `two people typing (${typingLine.textContent})`);
  check(!announcer.textContent.includes("typing"), "typing is never announced");
  presence.typingIds = [];
  await presenceChanged();
  check(typingLine.hidden && typingLine.textContent === "", "gone when they stop");
  // The composer tells the presence about typing, and about stopping.
  const composer = chat.querySelector("textarea");
  presence.typedCount = presence.stoppedCount = 0;
  composer.value = "On my";
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  check(presence.typedCount === 1, "typing in the composer is reported");
  composer.value = "";
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  check(presence.stoppedCount === 1, "clearing the composer stops it");
  composer.value = "again";
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  composer.dispatchEvent(new Event("blur"));
  check(presence.stoppedCount === 2, "leaving the composer stops it");
  composer.value = "sent now";
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  presence.stoppedCount = 0;
  chat.querySelector("form").requestSubmit();
  await settle();
  check(presence.stoppedCount >= 1, "sending stops it");

  // Settings → Chat: the two switches, per member, with the reciprocity said.
  if (customElements.get("kin-chat-settings")) {
    presence.sendsTyping = true;
    presence.settingsCalls = [];
    presence.setSettings = async function setSettings(change) {
      this.settingsCalls.push(change);
      if ("receipts" in change) this.sendsReceipts = change.receipts;
      if ("typing" in change) this.sendsTyping = change.typing;
      for (const listener of presenceListeners) listener();
    };
    const settings = document.createElement("kin-chat-settings");
    document.body.append(settings);
    check(settings.hidden, "the chat settings wait for a chat room");
    settings.room = room;
    await settle();
    check(!settings.hidden, "and show once there is one");
    const boxes = [...settings.querySelectorAll('input[type="checkbox"]')];
    const labelOf = (box) => settings.querySelector(`label[for="${box.id}"]`)?.textContent;
    check(boxes.length === 2 && labelOf(boxes[0]) === "Send read receipts" && labelOf(boxes[1]) === "Show when I'm typing", "two switches, named as the story names them");
    check(boxes.every((box) => box.checked), "both are on by default");
    check(/also stop seeing/.test(settings.textContent), "turning receipts off says it hides theirs too");
    boxes[0].click();
    await settle();
    check(presence.settingsCalls.length === 1 && presence.settingsCalls[0].receipts === false && !boxes[0].checked && boxes[1].checked, "receipts off is saved on its own");
    boxes[1].click();
    await settle();
    check(presence.settingsCalls[1].typing === false && !boxes[1].checked, "typing off is saved on its own");
    presence.sendsReceipts = true;
    presence.sendsTyping = true;
    for (const listener of presenceListeners) listener();
    await settle();
    check(boxes.every((box) => box.checked), "a change made on another device shows here");
    settings.room = null;
    check(settings.hidden, "the settings go when the room does");
    settings.remove();
  }
  room.presence = undefined;

  // Replies (#129): quote bar, quote above the reply, jump, deleted and hidden.
  {
    calls.reply = [];
    const plainSend = room.send;
    room.send = async function send(text, { replyTo = null } = {}) {
      calls.reply.push(replyTo);
      const result = await plainSend.call(this, text);
      if (replyTo) log.find((row) => row.messageId === result.messageId).replyOf = replyTo;
      return result;
    };
    const target = rows().findLast((row) => !row.classList.contains("own") && row.querySelector(".chat-menu-button") && !row.querySelector(".chat-gone"));
    const targetId = target.dataset.messageId;
    const targetText = log.find((row) => row.messageId === targetId);
    target.querySelector(".chat-menu-button").click();
    await settle();
    const reply = chat.querySelector(`[data-message-id="${targetId}"] [data-action="reply"]`);
    check(reply && reply.textContent === "Reply", "Reply is among the message actions");
    reply.click();
    await settle();
    const bar = chat.querySelector(".chat-replying");
    check(!bar.hidden && bar.textContent.includes("Replying to") && bar.textContent.includes(held.get(targetText.blobRef).slice(0, 10)), "a quote bar shows above the box");
    check(document.activeElement === chat.querySelector("textarea"), "focus goes to the message box");
    chat.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(bar.hidden && calls.reply.length === 0, "Escape cancels the reply");
    target.querySelector(".chat-menu-button").click();
    await settle();
    chat.querySelector(`[data-message-id="${targetId}"] [data-action="reply"]`).click();
    await settle();
    bar.querySelector("button").click();
    check(bar.hidden, "Cancel removes the quote bar");
    // Answer for real.
    chat.querySelector(`[data-message-id="${targetId}"] .chat-menu-button`).click();
    await settle();
    chat.querySelector(`[data-message-id="${targetId}"] [data-action="reply"]`).click();
    await settle();
    chat.querySelector("textarea").value = "Answering that";
    chat.querySelector(".chat-form").requestSubmit();
    await settle();
    check(calls.reply.at(-1) === targetId && bar.hidden, "the reply goes with the message it answers and the bar clears");
    const answer = rows().findLast((row) => textOf(row) === "Answering that");
    const quote = answer.querySelector(".chat-quote");
    check(quote?.tagName === "BUTTON" && quote.textContent.includes(held.get(targetText.blobRef).slice(0, 10)) && quote.getAttribute("aria-label").includes("Go to the original message"), "the reply shows a compact quote button");
    // Jump to an original that is far outside the window.
    const answerEntry = log.find((row) => row.messageId === answer.dataset.messageId);
    const old = log.find((row, index) => index > 2 && row.status === "live" && !room.hidden.has(row.messageId));
    answerEntry.replyOf = old.messageId;
    notify();
    await settle();
    check(!chat.querySelector(`[data-message-id="${old.messageId}"]`), "the old original is not on screen yet");
    rows().findLast((row) => row.dataset.messageId === answer.dataset.messageId).querySelector(".chat-quote").click();
    await settle();
    await settle();
    const arrived = chat.querySelector(`[data-message-id="${old.messageId}"]`);
    check(arrived && arrived.classList.contains("chat-highlight"), "the jump loads and highlights the original");
    chat.jump.click();
    await settle();
    await settle();
    check(chat.querySelector(`[data-message-id="${answer.dataset.messageId}"]`), "back at the newest messages");
    // Edits show in the quote; deletion and hiding say so.
    const near = log[log.length - 3];
    answerEntry.replyOf = near.messageId;
    Object.assign(near, { status: "deleted", blobRef: null, blobKey: null });
    notify();
    await settle();
    await settle();
    const deletedQuote = () => chat.querySelector(`[data-message-id="${answer.dataset.messageId}"] .chat-quote`);
    check(deletedQuote()?.textContent === "Original message was deleted", "a deleted original says so");
    room.hidden.add(near.messageId);
    notify();
    await settle();
    check(deletedQuote()?.textContent === "Message hidden" && deletedQuote().tagName === "P", "a hidden original says so and isn't a link");
    room.hidden.delete(near.messageId);
    answerEntry.replyOf = "ee".repeat(16);
    notify();
    await settle();
    check(deletedQuote()?.textContent === "Original message isn't available", "an original this device lacks says so");
    // Not-yet-downloaded originals load on demand.
    const lazy = add(other, "Fetched when quoted", { incoming: true });
    answerEntry.replyOf = lazy;
    notify();
    await settle();
    await settle();
    check(deletedQuote()?.textContent.includes("Fetched when quoted"), "an original that wasn't downloaded loads for the quote");
    room.send = plainSend;
  }

  // Chat search (#124): the panel, results, filters, jump with a text-range highlight.
  {
    const old = add(other, "The wifi password is Café42", { at: 5 });
    const lazy = add(other, "Pick up the cafe order", { incoming: true, at: 9 });
    notify();
    await settle();
    const panel = chat.querySelector(".chat-search-panel");
    const toggle = chat.querySelector(".chat-search-toggle");
    check(panel.hidden && toggle.getAttribute("aria-expanded") === "false", "the search panel starts closed");
    toggle.click();
    await settle();
    const box = panel.querySelector("input[type=search]");
    check(!panel.hidden && toggle.getAttribute("aria-expanded") === "true" && document.activeElement === box, "Search chat opens the panel and focuses its box");
    check(box.labels?.[0]?.textContent === "Search chat", "the box is labeled");
    const type = async (value) => {
      box.value = value;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      await settle();
    };
    const status = () => panel.querySelector(".chat-search-status").textContent;
    const found = () => [...panel.querySelectorAll(".search-result-open")];
    await type("CAFE");
    check(calls.search.at(-1).query === "CAFE" && calls.search.at(-1).limit === 50, "typing searches the room after a pause");
    check(found().length === 2 && status().startsWith("2 chat messages"), `case and accents fold; older messages are fetched (${found().length}, ${status()})`);
    check(found()[0].querySelector("mark")?.textContent.toLowerCase().startsWith("cafe"), "the match is marked with a <mark> element");
    check(found()[1].textContent.includes("Café42") && found()[1].getAttribute("aria-label").includes("Open chat message from Adult 2"), "a result names its author and text");
    check(!panel.querySelector(".search-result-text").innerHTML.includes("<script"), "results are built from text nodes");
    // Choosing the old result loads that stretch of the chat and highlights the match by text range.
    check(!chat.querySelector(`[data-message-id="${old}"]`), "the old message is not on screen yet");
    found()[1].click();
    await settle();
    await settle();
    const arrived = chat.querySelector(`[data-message-id="${old}"]`);
    check(arrived && arrived.classList.contains("chat-highlight"), "choosing a result jumps to the message and marks its row");
    const marked = globalThis.CSS?.highlights?.get("chat-search");
    if (marked) {
      const ranges = [...marked];
      check(ranges.length === 1 && ranges[0].toString() === "Café" && !arrived.querySelector(".chat-text mark"), "the match is highlighted by text range, not markup");
    }
    // Filters reach the engine.
    panel.querySelector("details").open = true;
    const from = panel.querySelector("select");
    check([...from.options].map((option) => option.textContent).join() === "Anyone,You,Adult 2,Adult 3", "From lists the household");
    from.value = other;
    from.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    check(calls.search.at(-1).authors.join() === other && found().every((entry) => entry.textContent.includes("Adult 2")), "From limits the results to one person");
    const dates = panel.querySelectorAll("input[type=date]");
    dates[0].value = "2026-10-18";
    dates[0].dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(calls.search.at(-1).from === new Date(2026, 9, 18).getTime() && calls.search.at(-1).to === 0, "a start date is a local midnight");
    dates[1].value = "2026-10-20";
    dates[1].dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(calls.search.at(-1).to === new Date(2026, 9, 21).getTime(), "an end date includes that whole day (to the next local midnight)");
    dates[0].value = "";
    dates[1].value = "";
    from.value = "";
    from.dispatchEvent(new Event("change", { bubbles: true }));
    const files = panel.querySelector(".chat-search-files input");
    files.checked = true;
    files.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    check(calls.search.at(-1).attachmentsOnly === true, "Only photos and files is sent as a filter");
    files.checked = false;
    files.dispatchEvent(new Event("change", { bubbles: true }));
    await type("no such words");
    check(found().length === 0 && status() === "No matching chat messages.", "no match says so");
    // Nothing about the query is stored.
    check(!JSON.stringify({ ...localStorage }).toLowerCase().includes("cafe") && !JSON.stringify({ ...sessionStorage }).toLowerCase().includes("cafe"), "queries are not stored");
    // Escape closes the panel and returns to the button.
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    check(panel.hidden && document.activeElement === toggle && !globalThis.CSS?.highlights?.get("chat-search"), "Escape closes the panel and clears the highlight");
    void lazy;
  }

  // Reactions (#127): quick bar, chips as toggle buttons, who reacted, read-only.
  {
    calls.react = [];
    room.react = async function react(message, emoji, on) {
      calls.react.push([message.messageId, emoji, on]);
      const entry = log.find((row) => row.messageId === message.messageId);
      const groups = entry.reactions ??= [];
      let group = groups.find((candidate) => candidate.emoji === emoji);
      if (on) {
        if (!group) groups.push(group = { emoji, actors: [] });
        if (!group.actors.includes(me)) group.actors.push(me);
      } else if (group) {
        group.actors = group.actors.filter((actor) => actor !== me);
        if (!group.actors.length) groups.splice(groups.indexOf(group), 1);
      }
      notify();
    };
    const target = rows().findLast((row) => !row.classList.contains("own") && row.querySelector('[data-action="react-open"]'));
    check(target, "a message from someone else offers a reaction button");
    const id = target.dataset.messageId;
    const rowOf = () => chat.querySelector(`[data-message-id="${id}"]`);
    const entry = log.find((row) => row.messageId === id);
    check(!rowOf().querySelector(".chat-reactions"), "no chips before anyone reacts");
    rowOf().querySelector('[data-action="react-open"]').click();
    await settle();
    const quick = [...rowOf().querySelectorAll(".chat-react-bar button")].filter((button) => button.dataset.action !== "react-more");
    check(quick.length === 6 && quick[0].getAttribute("aria-label") === "Thumbs up", "six quick reactions, named");
    check(rowOf().querySelector('[data-action="react-open"]').getAttribute("aria-expanded") === "true", "the button says the bar is open");
    check(document.activeElement === quick[0], "focus moves into the bar");
    quick[0].click();
    await settle();
    check(calls.react.at(-1)?.[1] === "\u{1F44D}" && calls.react.at(-1)?.[2] === true, "choosing a reaction sends it on");
    let chip = rowOf().querySelector(".chat-reaction");
    check(chip && chip.tagName === "BUTTON" && chip.getAttribute("aria-label") === "Thumbs up, 1 person, including you" && chip.getAttribute("aria-pressed") === "true", "a chip with an accessible name appears and is mine");
    check(!rowOf().querySelector(".chat-react-bar") && document.activeElement?.dataset.action === "react-open", "the bar closes and focus returns to the button");
    entry.reactions[0].actors.push(other);
    notify();
    await settle();
    chip = rowOf().querySelector(".chat-reaction");
    check(chip.getAttribute("aria-label") === "Thumbs up, 2 people, including you" && chip.querySelector(".chat-reaction-count").textContent === "2", "another member's reaction counts");
    check(chip.title.includes("You") && chip.title.includes("Adult 2"), "hover lists who reacted");
    chip.click();
    await settle();
    check(calls.react.at(-1)?.[2] === false, "tapping my chip takes my reaction back");
    chip = rowOf().querySelector(".chat-reaction");
    check(chip.getAttribute("aria-label") === "Thumbs up, 1 person" && chip.getAttribute("aria-pressed") === "false", "the chip drops my count");
    // Who reacted, from the row menu.
    rowOf().querySelector(".chat-menu-button").click();
    await settle();
    const details = rowOf().querySelector('[data-action="details"]');
    check(details && details.textContent === "See who reacted", "the menu can list who reacted");
    details.click();
    await settle();
    check(chat.querySelector(".chat-details-reactions")?.textContent.includes("Adult 2"), "the details list who reacted");
    chat.details.close();
    await settle();
    // Read-only members see chips but can't change them.
    room.access = "read";
    notify();
    await settle();
    check(!rowOf().querySelector('[data-action="react-open"]'), "no reaction button without write access");
    check(rowOf().querySelector(".chat-reaction")?.getAttribute("aria-disabled") === "true", "chips are inert without write access");
    const before = calls.react.length;
    rowOf().querySelector(".chat-reaction").click();
    await settle();
    check(calls.react.length === before, "a read-only tap sends nothing");
    room.access = "write";
    notify();
    await settle();
    // A deleted message shows no reactions.
    Object.assign(entry, { status: "deleted", blobRef: null, blobKey: null });
    notify();
    await settle();
    check(!rowOf().querySelector(".chat-reactions") && !rowOf().querySelector('[data-action="react-open"]'), "a deleted message has no reactions");
  }

  chat.room = null;
  await settle();
  if (!app) chat.remove();
  return "chat regressions passed";
}
