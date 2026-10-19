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
  const calls = { send: [], edit: [], remove: [], hide: [], attach: [] };
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
    const freshAnnouncer = fresh.querySelector('[aria-live="polite"]');
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
  const announcer = chat.querySelector('[aria-live="polite"]');
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
  check([...menu.querySelectorAll("button")].map((button) => button.dataset.action).join() === "copy,edit,delete", "own message actions (not Delete for me while it waits to send)");
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
  check([...theirMenu.querySelectorAll("button")].map((button) => button.dataset.action).join() === "copy,remove,hide", "an admin may remove others' messages");
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

  chat.room = null;
  await settle();
  if (!app) chat.remove();
  return "chat regressions passed";
}
