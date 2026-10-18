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
  const me = "a1".repeat(16), other = "b2".repeat(16);
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
  const calls = { send: [], edit: [], remove: [] };
  const room = {
    identity: { memberId: me, householdId: "c3".repeat(16), deviceId: "d4".repeat(16) },
    admins: [me],
    pendingMessages: new Set(),
    syncError: null,
    refused: [],
    retireRefusal: null,
    get isAdmin() { return true; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    authorLabel(id) { return id === me ? "You" : "Adult 2"; },
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
  check([...menu.querySelectorAll("button")].map((button) => button.dataset.action).join() === "copy,edit,delete", "own message actions");
  menu.querySelector('[data-action="edit"]').click();
  await settle();
  check(input.value === "Send button" && chat.querySelector(".chat-cancel").hidden === false, "editing in the composer");
  input.value = "Send button (fixed)";
  chat.querySelector('.chat-form button[type="submit"]').click();
  await settle();
  check(calls.edit.at(-1)?.[1] === "Send button (fixed)", "edit saved");
  check(textOf(rows().at(-1)) === "Send button (fixed)" && rows().at(-1).querySelector(".chat-note").textContent.startsWith("Edited"), "edited shown");
  const theirs = rows().findLast((row) => !row.classList.contains("own"));
  theirs.querySelector(".chat-menu-button").click();
  await settle();
  const theirMenu = chat.querySelector(`[data-message-id="${theirs.dataset.messageId}"] .chat-menu`);
  check([...theirMenu.querySelectorAll("button")].map((button) => button.dataset.action).join() === "copy,remove", "an admin may remove others' messages");
  const realConfirm = window.confirm;
  window.confirm = () => true;
  try {
    theirMenu.querySelector('[data-action="remove"]').click();
    await settle();
  } finally {
    window.confirm = realConfirm;
  }
  check(calls.remove.at(-1)?.[1] === true, "removed as admin");
  check(textOf(chat.querySelector(`[data-message-id="${theirs.dataset.messageId}"]`)) === "Removed by an admin", "removal shown to everyone");
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
  chat.room = null;
  await settle();
  if (!app) chat.remove();
  return "chat regressions passed";
}
