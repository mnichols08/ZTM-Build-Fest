import assert from "node:assert/strict";

// Daily UX hardening (PR 07): session-lifecycle, offline, accessibility and
// responsive regressions that cut across Quick add, Today, the palette, bulk
// actions and repeating tasks, plus repeated performance samples. Runs on
// the real encrypted store and WASM engine; see docs/DAILY-UX-HARDENING.md.
export async function dailyUxHardeningRegressions(client, { visit, ready }) {
  const page = (fn, ...args) => client.evaluate(`(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`);
  const passed = [];
  const metrics = [];
  const check = (condition, message, detail = null) => { assert.ok(condition, `${message}${detail !== null ? ` ${JSON.stringify(detail)}` : ""}`); passed.push(message); };
  const until = async (fn, label, ...args) => {
    for (let index = 0; index < 400; index++) {
      const value = await page(fn, ...args);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Daily UX hardening timed out: ${label}`);
  };
  const settle = () => page(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  const idle = () => until(() => { const app = document.querySelector("kin-app"); return Boolean(app?.state) && !app.busy && !app.bulkRunning && !app.refreshing && !app.pendingRefresh; }, "idle");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const KEYS = {
    escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    n: { key: "n", code: "KeyN", windowsVirtualKeyCode: 78, text: "n" },
    k: { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 },
  };
  const press = async (spec) => {
    const { text, ...rest } = spec;
    await client.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...rest, ...(text ? { text, unmodifiedText: text } : {}) });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...rest });
    await settle();
  };
  const viewport = async (width, height, mobile) => {
    await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await settle();
  };
  const network = async (offline) => {
    await client.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page((offline) => window.dispatchEvent(new Event(offline ? "offline" : "online")), offline);
  };
  // Quick add through its own dialog and form, as a user would submit it.
  const quickAdd = (title) => page((title) => {
    const app = document.querySelector("kin-app"), q = app.quickAdd;
    if (!q.dialog.open) q.trigger.click();
    q.input.value = title;
    q.input.dispatchEvent(new Event("input", { bubbles: true }));
    q.form.requestSubmit();
    return q.dialog.open || app.busy;
  }, title);
  const copies = (title) => page((title) => document.querySelector("kin-app").state.items.filter((item) => item.text === title).length, title);
  const lockAndSettle = () => page(async () => {
    const app = document.querySelector("kin-app");
    app.lockHousehold();
    await app.lockBarrier;
  });
  const unlock = async () => { await ready(client); await idle(); };
  // Every IndexedDB record, Web Storage entry and Cache Storage response the
  // origin holds, searched for a decrypted title as text or UTF-8 bytes.
  const plaintextAtRest = (needle) => page(async (needle) => {
    const bytes = new TextEncoder().encode(needle);
    const hasBytes = (view) => {
      outer: for (let i = 0; i + bytes.length <= view.length; i++) {
        for (let j = 0; j < bytes.length; j++) if (view[i + j] !== bytes[j]) continue outer;
        return true;
      }
      return false;
    };
    const seen = new Set();
    const scan = (value) => {
      if (value == null || seen.has(value)) return false;
      if (typeof value === "string") return value.includes(needle);
      if (typeof value !== "object") return false;
      seen.add(value);
      if (value instanceof ArrayBuffer) return hasBytes(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return hasBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      if (value instanceof Blob) return false;
      return Object.values(value).some(scan) || (value instanceof Map && [...value.values()].some(scan));
    };
    const found = [];
    for (const { name } of await indexedDB.databases()) {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        for (const store of database.objectStoreNames) {
          const rows = await new Promise((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          if (scan(rows)) found.push(`idb:${name}/${store}`);
        }
      } finally { database.close(); }
    }
    for (const [label, storage] of [["local", localStorage], ["session", sessionStorage]])
      for (let i = 0; i < storage.length; i++) if (scan(storage.getItem(storage.key(i)))) found.push(`${label}:${storage.key(i)}`);
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith("/api/")) found.push(`cache-api:${request.url}`);
        if ((await (await cache.match(request)).text()).includes(needle)) found.push(`cache:${request.url}`);
      }
    }
    return found;
  }, needle);
  const stats = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    return { n: sorted.length, median: Number(at(0.5).toFixed(2)), p95: Number(at(0.95).toFixed(2)), max: Number(sorted.at(-1).toFixed(2)) };
  };
  const stamp = (await page(() => crypto.randomUUID())).slice(0, 6);

  try {
    await page(async () => {
      const app = document.querySelector("kin-app");
      if ((app.state.mode ?? "normal") !== "normal") await app.appendCommand({ type: "set-household-mode", mode: "normal" });
    });
    await viewport(1280, 900, false);
    await visit("today");
    await idle();

    // --- Example 1: offline Quick add survives a reload exactly once -------
    const offlineTitle = `Offline capture ${stamp}`;
    await network(true);
    await quickAdd(offlineTitle);
    await idle();
    check(await copies(offlineTitle) === 1, "offline Quick add commits exactly one task to the local encrypted store");
    check((await plaintextAtRest(offlineTitle)).length === 0, "the offline task's title is not readable in IndexedDB, Web Storage or Cache Storage, and no API response is cached", await plaintextAtRest(offlineTitle));
    // Reload through the shell, then unlock and replay with the network off
    // (offline shell delivery itself is covered by the security UI suite).
    await network(false);
    await client.send("Page.reload");
    await until(() => Boolean(document.querySelector("kin-app")?.security?.heading), "reloaded shell");
    await network(true);
    await unlock();
    await visit("today");
    const afterReload = await page((title) => {
      const app = document.querySelector("kin-app");
      const item = app.state.items.find((entry) => entry.text === title);
      return { copies: app.state.items.filter((entry) => entry.text === title).length, today: item?.planningDate === app.currentCivilDate(), shown: [...app.today.querySelectorAll("kin-item")].filter((node) => node.record?.text === title).length };
    }, offlineTitle);
    check(afterReload.copies === 1 && afterReload.today && afterReload.shown === 1,
      "after an offline reload and local unlock the task replays once, still planned for today, with one Today row", afterReload);
    await network(false);

    // --- Example 3: lock while Quick add's local write is pending ----------
    const pendingTitle = `Locked mid-save ${stamp}`;
    await page((title) => {
      const app = document.querySelector("kin-app"), store = app.store, original = store.append;
      window.__gate = { reached: false };
      const gate = new Promise((resolve) => { window.__gate.release = resolve; });
      store.append = async (command, engine) => {
        if (command.type === "add" && command.text === title) { window.__gate.reached = true; await gate; }
        return original.call(store, command, engine);
      };
    }, pendingTitle);
    await quickAdd(pendingTitle);
    await until(() => window.__gate.reached, "quick add write pending");
    await lockAndSettle();
    await page(() => window.__gate.release());
    await pause(300);
    const lockedView = await page((title) => {
      const app = document.querySelector("kin-app");
      return {
        leaked: document.body.innerText.includes(title) || document.title.includes(title),
        status: app.status.textContent, alert: app.alert.textContent,
        quickAddOpen: app.quickAdd.dialog.open, draft: app.quickAdd.input.value,
        openDialogs: document.querySelectorAll("dialog[open]").length,
      };
    }, pendingTitle);
    check(!lockedView.leaked && lockedView.status === "Household locked." && !lockedView.alert && !lockedView.quickAddOpen && !lockedView.draft && lockedView.openDialogs === 0,
      "a Quick add write settling after lock cannot reveal its title, announce success, raise an alert or reopen the dialog", lockedView);
    await unlock();
    const afterPending = await page(async (title) => {
      const app = document.querySelector("kin-app");
      const stored = (await app.store.loadEvents()).length;
      return { copies: app.state.items.filter((item) => item.text === title).length, stored, recovery: app.quickAdd.recoveryVisible, pending: app.pendingCapture };
    }, pendingTitle);
    check(afterPending.copies <= 1 && !afterPending.recovery && afterPending.pending === null,
      "unlocking rebuilds from the encrypted store: the interrupted task exists at most once and no stale recovery prompt appears", afterPending);

    // --- Schedule change interrupted by lock, finished after unlock --------
    const routineTitle = `Water plants ${stamp}`;
    const originalId = await page(async (text) => {
      const app = document.querySelector("kin-app");
      const routineId = crypto.randomUUID().replaceAll("-", "");
      await app.appendCommand({ type: "create-routine", routineId, text, cadence: "daily" });
      await app.refreshFromEvents();
      return routineId;
    }, routineTitle);
    await idle();
    await page((routineId) => {
      const app = document.querySelector("kin-app"), store = app.store, original = store.append;
      window.__gate = { reached: false };
      const gate = new Promise((resolve) => { window.__gate.release = resolve; });
      // The archive step is held, then lost to the lock: the replacement is
      // durable but the original still repeats.
      store.append = async (command, engine) => {
        if (command.type === "archive-routine" && command.routineId === routineId) {
          window.__gate.reached = true;
          await gate;
          throw Object.assign(new Error("Kin was locked or reopened during the operation."), { code: "locked" });
        }
        return original.call(store, command, engine);
      };
      void app.changeRoutineSchedule({ routineId, cadence: "weekly" });
    }, originalId);
    await until(() => window.__gate.reached, "schedule change archive pending");
    await lockAndSettle();
    await page(() => window.__gate.release());
    await pause(100);
    await unlock();
    const interrupted = await page((text) => document.querySelector("kin-app").state.routines.filter((routine) => routine.text === text).map((routine) => ({ id: routine.routineId, cadence: routine.cadence, status: routine.status })), routineTitle);
    check(interrupted.length === 2 && interrupted.filter((routine) => routine.status !== "archived").length === 2,
      "a lock between the schedule-change steps leaves the durable replacement and the still-repeating original", interrupted);
    await page((routineId) => document.querySelector("kin-app").changeRoutineSchedule({ routineId, cadence: "weekly" }), originalId);
    await idle();
    const resumed = await page((text) => document.querySelector("kin-app").state.routines.filter((routine) => routine.text === text).map((routine) => ({ id: routine.routineId, cadence: routine.cadence, status: routine.status })), routineTitle);
    const active = resumed.filter((routine) => routine.status !== "archived");
    check(resumed.length === 2 && active.length === 1 && active[0].cadence === "weekly" && resumed.find((routine) => routine.id === originalId)?.status === "archived",
      "retrying the same schedule after unlock resumes the half-saved change: one weekly replacement, the original stopped, no second replacement", resumed);
    const replacementId = active[0].id;

    // --- Local reminders never notify across a lock ------------------------
    await page(() => {
      const app = document.querySelector("kin-app");
      window.__notifications = [];
      window.__permission = { value: "granted" };
      class FakeNotification {
        constructor(title) { window.__notifications.push(title); }
        static get permission() { return window.__permission.value; }
        static requestPermission() { return new Promise((resolve) => { window.__permission.resolve = resolve; }); }
      }
      window.__realNotification = app.localReminders.notification;
      app.localReminders.notification = FakeNotification;
    });
    await page(async (id, title) => { await document.querySelector("kin-app").handleLocalReminder({ id: `routine:${id}`, title, at: Date.now() + 150 }); }, replacementId, routineTitle);
    await until(() => window.__notifications.length === 1, "unlocked routine reminder fires");
    check(true, "control: an unlocked routine reminder notifies once");
    await page(async (id, title) => { await document.querySelector("kin-app").handleLocalReminder({ id: `routine:${id}`, title, at: Date.now() + 400 }); }, replacementId, routineTitle);
    check(await page(() => document.querySelector("kin-app").localReminders.entries.size) === 1, "a second routine reminder is scheduled");
    await lockAndSettle();
    await pause(700);
    const afterLockReminder = await page(() => ({ fired: window.__notifications.length, pending: document.querySelector("kin-app").localReminders.entries.size }));
    check(afterLockReminder.fired === 1 && afterLockReminder.pending === 0,
      "locking cancels every reminder timer, so no notification can show a decrypted routine title while locked", afterLockReminder);
    await unlock();
    await page(() => {
      const app = document.querySelector("kin-app");
      window.__permission.value = "default";
      const item = app.state.items.find((entry) => entry.status === "active");
      window.__late = app.handleLocalReminder({ id: `item:${item.itemId}`, title: item.text, at: Date.now() + 300 });
    });
    await until(() => typeof window.__permission.resolve === "function", "permission prompt open");
    await lockAndSettle();
    await page(async () => { window.__permission.value = "granted"; window.__permission.resolve("granted"); await window.__late; });
    await pause(500);
    const lateGrant = await page(() => {
      const app = document.querySelector("kin-app");
      return { fired: window.__notifications.length, pending: app.localReminders.entries.size, status: app.status.textContent, alert: app.alert.textContent };
    });
    check(lateGrant.fired === 1 && lateGrant.pending === 0 && lateGrant.status === "Household locked." && !lateGrant.alert,
      "a permission prompt answered after lock registers no reminder and announces nothing into the locked view", lateGrant);
    await unlock();
    await page(() => {
      const app = document.querySelector("kin-app");
      app.localReminders.notification = window.__realNotification;
      window.__permission.value = "granted";
    });

    // --- Household appearance refresh settling after lock ------------------
    for (const outcome of ["resolve", "reject"]) {
      await page(() => {
        const app = document.querySelector("kin-app");
        window.__settings = {};
        const pending = new Promise((resolve, reject) => { window.__settings.resolve = resolve; window.__settings.reject = reject; });
        window.__realCoordinator = app.syncCoordinator;
        app.syncCoordinator = { loadHouseholdSettings: () => pending, stop() {} };
        window.__refresh = app.refreshHouseholdDefaults();
      });
      await lockAndSettle();
      await page(async (outcome) => {
        if (outcome === "resolve") window.__settings.resolve({ admin: false, adminRecorded: false, value: { name: "Secret Household Name", revision: 1_000_000 } });
        else window.__settings.reject(new Error("Device sync was stopped."));
        await window.__refresh.catch(() => {});
      }, outcome);
      const header = await page(() => {
        const app = document.querySelector("kin-app");
        return { brand: app.brandTitle?.textContent, title: document.title, status: app.status.textContent, leaked: document.body.innerText.includes("Secret Household Name") };
      });
      check(header.brand === "Kin" && !header.title.includes("Secret") && header.status === "Household locked." && !header.leaked,
        `a household settings load that ${outcome}s after lock leaves the locked header and status untouched`, header);
      await unlock();
    }

    // --- Household settings save settling after lock or re-open -----------
    // The real editor and its Save button; the coordinator's save is a
    // deferred promise. Every completion the editor receives is recorded. Lock
    // rebuilds the editor, but a household re-open keeps it, so a stale
    // completion there lands in the new session's editor.
    const SECRET = "Secret Saved Household";
    await page(() => { window.__settingsCoordinator = document.querySelector("kin-app").syncCoordinator ?? null; });
    const startSave = () => page(() => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      window.__save = { calls: [] };
      window.__save.promise = new Promise((resolve, reject) => { window.__save.resolve = resolve; window.__save.reject = reject; });
      app.syncCoordinator = { saveHouseholdSettings: (value) => { window.__save.value = value; return window.__save.promise; }, stop() {} };
      if (!editor.__recording) {
        editor.__recording = true;
        editor.addEventListener("kin:save-household-defaults", (event) => {
          const complete = event.detail.complete;
          event.detail.complete = (saved, error) => { window.__save.calls.push({ saved: saved?.name ?? null, error: error?.message ?? null }); complete(saved, error); };
        });
      }
      if (!editor.admin) editor.initialize({ admin: true, adminRecorded: true, value: null });
      editor.feedback.textContent = "";
      [...editor.querySelectorAll("button")].find((button) => button.textContent === "Save household settings").click();
      return Boolean(window.__save.value);
    });
    // Settles the deferred save, then crosses one task boundary so the app's
    // continuation (and any completion) has run.
    const settleSave = (outcome) => page(async (outcome, secret) => {
      if (outcome === "resolve") window.__save.resolve({ ...window.__save.value, name: secret, revision: window.__save.value.revision + 1 });
      else window.__save.reject(new Error("Shared settings could not be saved."));
      await window.__save.promise.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    }, outcome, SECRET);
    const editorView = () => page((secret) => {
      const app = document.querySelector("kin-app"), editor = app.householdDefaults;
      return { calls: window.__save.calls, feedback: editor.feedback.textContent, name: editor.nameInput.value, brand: app.brandTitle?.textContent,
        status: app.status.textContent, leaked: document.body.innerText.includes(secret) || editor.nameInput.value === secret || app.householdSettings?.name === secret };
    }, SECRET);

    for (const outcome of ["reject", "resolve"]) {
      check(await startSave(), `settings save (${outcome} after lock) is pending`);
      await lockAndSettle();
      await settleSave(outcome);
      const locked = await editorView();
      check(locked.calls.length === 0 && !locked.feedback && locked.brand === "Kin" && locked.status === "Household locked." && !locked.leaked,
        `a household settings save that ${outcome}s after lock never calls the old editor's completion or changes the locked view`, locked);
      await unlock();
      const reopened = await editorView();
      check(reopened.calls.length === 0 && !reopened.feedback && !reopened.leaked,
        `after unlocking, nothing from the save that settled (${outcome}) after lock reaches the editor`, reopened);
    }

    check(await startSave(), "settings save during a household re-open is pending");
    await page(async () => { const app = document.querySelector("kin-app"); await app.openUnlockedHousehold(app.vault); });
    await idle();
    await settleSave("resolve");
    const replaced = await editorView();
    check(replaced.calls.length === 0 && !replaced.feedback && !replaced.leaked,
      "a save started before the household was re-opened cannot complete into the same editor serving the new session", replaced);

    check(await startSave(), "settings save in a valid session is pending");
    await settleSave("reject");
    const failed = await page(() => {
      const editor = document.querySelector("kin-app").householdDefaults;
      const save = [...editor.querySelectorAll("button")].find((button) => button.textContent === "Save household settings");
      return { calls: window.__save.calls, feedback: editor.feedback.textContent, live: editor.feedback.getAttribute("role"), retry: Boolean(save) && !save.disabled && save.isConnected };
    });
    check(failed.calls.length === 1 && failed.calls[0].error === "Shared settings could not be saved." && failed.feedback === "Shared settings could not be saved." && failed.live === "status" && failed.retry,
      "a save failing in the current session reports its error through the editor's live status and leaves Save available to retry", failed);
    check(await startSave(), "retry dispatches a new save");
    await settleSave("resolve");
    const succeeded = await editorView();
    check(succeeded.calls.length === 1 && succeeded.calls[0].saved === SECRET && succeeded.name === SECRET && succeeded.brand === SECRET &&
      succeeded.feedback.startsWith("Household settings saved."),
      "the retried save succeeds in the current session: completion runs once and the saved name is applied", succeeded);
    await page(() => {
      const app = document.querySelector("kin-app");
      app.syncCoordinator = window.__settingsCoordinator;
      delete window.__settingsCoordinator;
      app.householdSettings = null;
      app.applyEffectiveAppearance();
      app.householdDefaults.initialize({ admin: false, adminRecorded: false, value: null });
      app.householdDefaults.feedback.textContent = "";
    });

    // --- Accessibility -----------------------------------------------------
    await client.send("Accessibility.enable");
    const axName = async (expression) => {
      const { result } = await client.send("Runtime.evaluate", { expression });
      const { node } = await client.send("DOM.describeNode", { objectId: result.objectId });
      const { nodes } = await client.send("Accessibility.getPartialAXTree", { backendNodeId: node.backendNodeId, fetchRelatives: false });
      return nodes.find((entry) => !entry.ignored)?.name?.value ?? null;
    };
    await viewport(375, 740, true);
    await visit("today");
    const trigger = await page(() => {
      const button = document.querySelector("kin-app").quickAdd.trigger;
      return { visible: getComputedStyle(button, "::before").content !== "none", fontSize: getComputedStyle(button).fontSize };
    });
    const triggerName = await axName(`document.querySelector("kin-app").quickAdd.trigger`);
    check(triggerName === "Quick add" && trigger.visible,
      "at phone width the Quick add trigger shows a short visible label but keeps the accessible name \"Quick add\"", { triggerName, trigger });
    await viewport(1280, 900, false);

    const chevrons = async () => page(() => {
      const app = document.querySelector("kin-app");
      const marker = (summary) => {
        if (!summary) return null;
        const style = getComputedStyle(summary, "::before");
        return { content: style.content, border: style.borderRightStyle, width: style.borderRightWidth };
      };
      return {
        schedule: marker(app.routines.querySelector(".routine-schedule > summary")),
        repeat: marker(app.quickAdd.querySelector(".quick-add-repeat > summary")),
      };
    });
    await visit("routines");
    await idle();
    for (const forced of ["none", "active"]) {
      await client.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: forced }] });
      const markers = await chevrons();
      const shown = (marker) => marker && marker.content !== "none" && marker.border === "solid" && marker.width !== "0px";
      check(shown(markers.schedule) && shown(markers.repeat),
        `the repeating-task Schedule and Repeat disclosures show an open/closed marker by shape, not color alone (forced colors ${forced})`, markers);
    }
    await client.send("Emulation.setEmulatedMedia", { features: [] });

    await visit("lists/todo");
    const bulkDescribed = await page(() => {
      const app = document.querySelector("kin-app");
      const bar = app.needs.bulkBar;
      const message = bar?.message?.isConnected ? bar.message : null;
      return { id: message?.id ?? null, unique: message ? document.querySelectorAll(`[id="${message.id}"]`).length === 1 : false,
        buttons: [bar?.undo, bar?.retry, bar?.dismiss].map((button) => button?.getAttribute("aria-describedby")) };
    });
    check(bulkDescribed.id && bulkDescribed.unique && bulkDescribed.buttons.every((value) => value === bulkDescribed.id),
      "Undo, Try again and Dismiss are described by the bulk outcome, so moving focus to them still conveys the result", bulkDescribed);
    await visit("today");

    // Palette opened from a control that disappears before Escape.
    await page(() => {
      const app = document.querySelector("kin-app");
      const button = document.createElement("button");
      button.type = "button";
      button.id = "hardening-transient-opener";
      button.textContent = "Transient";
      app.pages.get("today").prepend(button);
      button.focus();
    });
    await press(KEYS.k);
    await until(() => document.querySelector("kin-app").commandPalette.isOpen, "palette open");
    await page(() => document.getElementById("hardening-transient-opener").remove());
    await press(KEYS.escape);
    const restored = await page(() => {
      const active = document.activeElement;
      return { open: document.querySelectorAll("dialog[open]").length, connected: active?.isConnected, body: active === document.body,
        visible: Boolean(active?.getClientRects().length), inert: Boolean(active?.closest("[hidden],[inert]")), tag: active?.tagName };
    });
    check(restored.open === 0 && restored.connected && !restored.body && restored.visible && !restored.inert,
      "when the palette's opener is removed, Escape closes it and focus falls back to a connected, visible heading", restored);
    await press(KEYS.n);
    const afterPalette = await page(() => { const q = document.querySelector("kin-app").quickAdd; return { open: q.dialog.open, focus: document.activeElement === q.input }; });
    check(afterPalette.open && afterPalette.focus, "keyboard commands keep working after the palette fallback", afterPalette);
    await press(KEYS.escape);

    // --- Responsive sweep with an unbroken long title ----------------------
    const longTitle = `Hardening${"Unbrokenhouseholdtaskname".repeat(5)}${stamp}`;
    await page(async (text) => {
      const app = document.querySelector("kin-app");
      const itemId = crypto.randomUUID().replaceAll("-", "");
      await app.appendCommand({ type: "add", id: itemId, text, classification: "need" });
      await app.appendCommand({ type: "set-item-planning-date", itemId, planningDate: app.currentCivilDate() });
      await app.refreshFromEvents();
    }, longTitle);
    await idle();
    for (const [width, height] of [[320, 640], [375, 740], [768, 1024], [1280, 900]]) {
      await viewport(width, height, width < 768);
      const layout = {};
      for (const route of ["today", "routines"]) {
        await visit(route);
        layout[route] = await page((text) => {
          const app = document.querySelector("kin-app");
          const row = [...app.today.querySelectorAll("kin-item")].find((node) => node.record?.text === text)?.querySelector(".item-row");
          const rect = row?.getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, rowFits: !row || (rect.left >= 0 && rect.right <= innerWidth) };
        }, longTitle);
      }
      await press(KEYS.n);
      layout.quickAdd = await page(() => {
        const dialog = document.querySelector("kin-app").quickAdd.dialog, rect = dialog.getBoundingClientRect();
        const targets = [...dialog.querySelectorAll("button, select, input, summary")].filter((node) => node.getClientRects().length);
        return { open: dialog.open, fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight, targets: targets.every((node) => node.getBoundingClientRect().height >= 44) };
      });
      await press(KEYS.escape);
      await press(KEYS.k);
      layout.palette = await page(() => {
        const palette = document.querySelector("kin-app").commandPalette, dialog = palette.querySelector("dialog[open]");
        const rect = dialog?.getBoundingClientRect();
        return { open: Boolean(dialog), fits: Boolean(rect) && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
      });
      await press(KEYS.escape);
      check(!layout.today.overflow && layout.today.rowFits && !layout.routines.overflow && layout.quickAdd.open && layout.quickAdd.fits && layout.quickAdd.targets && layout.palette.open && layout.palette.fits,
        `at ${width}px Today and Routines do not scroll sideways, a long unbroken title wraps inside its row, and Quick add and the palette fit with 44px+ targets`, layout);
    }
    await viewport(1280, 900, false);
    await visit("today");
    await idle();

    // --- Performance samples ----------------------------------------------
    await client.send("HeapProfiler.enable");
    await client.send("HeapProfiler.collectGarbage");
    const heapBefore = await page(() => performance.memory?.usedJSHeapSize ?? null);
    const objectUrls = await page(() => {
      window.__urls = { created: 0, revoked: 0 };
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = (...args) => { window.__urls.created++; return create.apply(URL, args); };
      URL.revokeObjectURL = (...args) => { window.__urls.revoked++; return revoke.apply(URL, args); };
      return true;
    });

    const create = [];
    for (let index = 0; index < 15; index++) {
      const title = `Perf capture ${stamp} ${index}`;
      await idle();
      const started = await page(() => performance.now());
      await quickAdd(title);
      const ended = await until((title) => { const app = document.querySelector("kin-app"); return !app.busy && app.state.items.some((item) => item.text === title) && performance.now(); }, "perf capture", title);
      create.push(ended - started);
    }
    metrics.push(["quick-add-commit", stats(create)]);
    await press(KEYS.escape);

    const render = await page(() => {
      const app = document.querySelector("kin-app"), samples = [];
      for (let index = 0; index < 25; index++) {
        const started = performance.now();
        app.today.update({ items: app.state.items });
        samples.push(performance.now() - started);
      }
      return samples;
    });
    metrics.push(["today-render", { ...stats(render), items: await page(() => document.querySelector("kin-app").state.items.length) }]);

    const projection = [];
    for (let index = 0; index < 15; index++) {
      await idle();
      projection.push(await page(async () => {
        const started = performance.now();
        await document.querySelector("kin-app").refreshFromEvents();
        return performance.now() - started;
      }));
    }
    metrics.push(["replay-and-render (incl. recurrence)", { ...stats(projection), routines: await page(() => document.querySelector("kin-app").state.routines.length) }]);

    const palette = await page(async () => {
      const app = document.querySelector("kin-app"), cp = app.commandPalette, samples = [];
      for (let index = 0; index < 15; index++) {
        const started = performance.now();
        cp.openPalette({ opener: app.main.querySelector(".app-view:not([hidden]) h1") });
        cp.input.value = "sho";
        cp.input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push(performance.now() - started);
        cp.dismiss();
      }
      return samples;
    });
    metrics.push(["palette-open-filter (to next frame)", stats(palette)]);

    for (const [count, runs] of [[10, 3], [50, 2]]) {
      const samples = [];
      for (let run = 0; run < runs; run++) {
        const ids = await page(async (count, label) => {
          const app = document.querySelector("kin-app"), ids = [];
          for (let index = 0; index < count; index++) {
            const itemId = crypto.randomUUID().replaceAll("-", "");
            await app.appendCommand({ type: "add", id: itemId, text: `${label} ${index}`, classification: "need" });
            ids.push(itemId);
          }
          await app.refreshFromEvents();
          return ids;
        }, count, `Bulk ${count}/${run} ${stamp}`);
        await idle();
        await visit("lists/todo");
        const ms = await page(async (ids) => {
          const app = document.querySelector("kin-app");
          const started = performance.now();
          app.needs.bulkAction("bulk-item-action", { action: "complete", itemIds: ids });
          while (app.bulkRunning || app.busy) await new Promise((resolve) => setTimeout(resolve, 5));
          const done = ids.every((id) => app.state.items.find((item) => item.itemId === id)?.status === "completed");
          return done ? performance.now() - started : -1;
        }, ids);
        check(ms > 0, `bulk completion of ${count} items finishes every target`);
        samples.push(ms);
        await page(() => document.querySelector("kin-app").clearBulkOutcome());
      }
      metrics.push([`bulk-complete-${count}`, { ...stats(samples), perItem: Number((stats(samples).median / count).toFixed(2)) }]);
    }

    const urls = await page(() => window.__urls);
    await client.send("HeapProfiler.collectGarbage");
    const heapAfter = await page(() => performance.memory?.usedJSHeapSize ?? null);
    check(objectUrls && urls.created === urls.revoked, "daily flows leave no object URL unrevoked", urls);
    metrics.push(["memory", { heapBeforeMB: heapBefore && Number((heapBefore / 1048576).toFixed(1)), heapAfterMB: heapAfter && Number((heapAfter / 1048576).toFixed(1)), objectUrls: urls }]);

    const started = Date.now();
    await client.send("Page.reload");
    await until(() => Boolean(document.querySelector("kin-app")?.security?.heading), "reloaded shell");
    const shellMs = Date.now() - started;
    await unlock();
    metrics.push(["startup (single sample)", { shellMs, readyMs: Date.now() - started, note: "ready includes recovery-secret key derivation" }]);
    await visit("today");
  } finally {
    await client.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await client.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  for (const [name, value] of metrics) console.log(`METRIC daily-ux-hardening ${name} ${JSON.stringify(value)}`);
  return `PASS daily UX hardening (${passed.length} checks): offline Quick add reload and at-rest encryption, lock during a pending Quick add write, schedule change interrupted by lock and resumed, reminders and permission prompts across lock, household settings settling after lock, Quick add trigger name, disclosure markers in forced colors, bulk outcome descriptions, palette opener fallback, 320/375/768/1280 reflow, performance samples`;
}
