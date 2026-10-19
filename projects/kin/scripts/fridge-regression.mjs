// The family fridge in a real browser (#317): the real WASM engine and real
// IndexedDB behind a board room that stays offline (this harness has no sync
// service), real pointer input through the DevTools protocol, and the door's
// layout on a phone, a tablet and a desktop.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";

const MEMBER = "a1".repeat(16);
const HOUSEHOLD = "f1".repeat(16);

export async function fridgeRegressions(client, until) {
  const page = (expression) => client.evaluate(expression);
  const strokes = () => page(`window.__fridgeRoom.board().strokes.length`);

  // A board room with this page's engine, a fresh household key and device
  // keys, and a request that always reports being offline.
  await page(`(async () => {
    const app = document.querySelector("kin-app");
    const { BoardRoom } = await import("/board/board-room.js");
    const { generateHouseholdKey, generateDeviceKeys } = await import("/sync/crypto.js");
    const householdKey = await generateHouseholdKey();
    const keys = await generateDeviceKeys();
    const offline = async () => { throw Object.assign(new Error("Household sync could not be reached."), { code: "connection_unavailable" }); };
    window.__fridgeOptions = {
      identity: { householdId: "${HOUSEHOLD}", memberId: "${MEMBER}", deviceId: "${"d1".repeat(16)}" },
      keyStore: { vault: { assertUnlocked() {} }, getEpoch: async (_, epoch) => epoch === 1 ? { keyEpoch: 1, householdKey } : null, listEpochs: async () => [{ keyEpoch: 1, householdKey }] },
      deviceKeys: { keys }, request: offline,
    };
    const room = await BoardRoom.open({ ...window.__fridgeOptions, engine: app.engine });
    window.__fridgeRoom = room;
    app.fridge.memberId = "${MEMBER}";
    app.fridge.room = room;
    location.hash = "#household/fridge";
    app.ctx.navigation.showPageFromLocation();
    return true;
  })()`);

  const door = () => page(`(() => {
    const rect = document.querySelector("kin-fridge .fridge-door").getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right };
  })()`);
  const at = (rect, fx, fy) => ({ x: Math.round(rect.left + rect.width * fx), y: Math.round(rect.top + rect.height * fy) });

  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  // ---- Layout on a phone, a tablet and a desktop ---------------------------
  for (const [label, metrics] of [
    ["phone", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }],
    ["tablet", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
  ]) {
    await setViewport(client, metrics);
    await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
    const rect = await door();
    const layout = await page(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth, small: [...document.querySelectorAll("kin-fridge .fridge-tools button")].filter((b) => b.getBoundingClientRect().height < 44).length })`);
    assert.ok(Math.abs(rect.width / rect.height - 0.75) < 0.01, `${label}: the door keeps its 3:4 shape (${rect.width}×${rect.height})`);
    assert.ok(rect.width >= 240 && rect.right <= layout.innerWidth, `${label}: the door fits the screen`);
    assert.ok(layout.scrollWidth <= layout.innerWidth, `${label}: no horizontal scroll`);
    assert.equal(layout.small, 0, `${label}: every tool is at least 44px tall`);
  }

  // ---- Drawing with a finger (phone) -------------------------------------
  await setViewport(client, { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
  let rect = await door();
  const touch = (type, points) => client.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ ...p, id })) });
  const start = at(rect, 0.2, 0.2);
  await touch("touchStart", [start]);
  for (let step = 1; step <= 10; step += 1) await touch("touchMove", [{ x: start.x + step * 8, y: start.y + step * 5 }]);
  await touch("touchEnd", []);
  await until(async () => (await strokes()) === 1);
  const inked = await page(`(() => {
    const canvas = document.querySelector("kin-fridge .fridge-ink");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
    return false;
  })()`);
  assert.equal(inked, true, "the stroke is drawn on the door");
  assert.match(await page(`document.querySelector("kin-fridge .fridge-summary").textContent`), /^1 drawing by you\. Waiting to send\./);

  // A second finger turns the stroke into a gesture: nothing is drawn.
  const second = at(rect, 0.5, 0.5);
  await touch("touchStart", [second]);
  await touch("touchMove", [{ x: second.x + 20, y: second.y + 20 }]);
  await touch("touchStart", [{ x: second.x + 20, y: second.y + 20 }, { x: second.x + 80, y: second.y }]);
  await touch("touchMove", [{ x: second.x + 30, y: second.y + 30 }, { x: second.x + 90, y: second.y + 10 }]);
  await touch("touchEnd", []);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await strokes(), 1, "a second finger cancels the stroke");

  // ---- A pen with a palm resting on the screen ----------------------------
  await setViewport(client, { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true });
  await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
  rect = await door();
  const pen = (type, point, buttons = 1) => client.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons, clickCount: 1, pointerType: "pen" });
  const penAt = at(rect, 0.3, 0.6);
  await pen("mousePressed", penAt);
  const palm = at(rect, 0.8, 0.9);
  await touch("touchStart", [palm]);
  for (let step = 1; step <= 6; step += 1) {
    await pen("mouseMoved", { x: penAt.x + step * 10, y: penAt.y });
    await touch("touchMove", [{ x: palm.x - step * 3, y: palm.y }]);
  }
  await touch("touchEnd", []);
  await pen("mouseReleased", { x: penAt.x + 60, y: penAt.y }, 0);
  await until(async () => (await strokes()) === 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await strokes(), 2, "the pen draws; the palm does not");

  // ---- Eraser, undo and redo (desktop mouse) -------------------------------
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page(`document.querySelector("kin-fridge .fridge-door").scrollIntoView({ block: "center" })`);
  rect = await door();
  const mouse = (type, point, buttons = 1) => client.send("Input.dispatchMouseEvent", { type, ...point, button: "left", buttons, clickCount: 1 });
  await page(`document.querySelector("kin-fridge .fridge-eraser").click()`);
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-eraser").getAttribute("aria-pressed")`), "true");
  // The pen stroke runs along y = 0.6 from x = 0.3; rub across it.
  const rub = at(rect, 0.32, 0.55);
  await mouse("mousePressed", rub);
  for (let step = 1; step <= 8; step += 1) await mouse("mouseMoved", { x: rub.x, y: rub.y + step * 6 });
  await mouse("mouseReleased", { x: rub.x, y: rub.y + 48 }, 0);
  await until(async () => (await strokes()) === 1);
  await page(`document.querySelector("kin-fridge .fridge-history button:first-child").click()`);
  await until(async () => (await strokes()) === 2);
  assert.equal(await page(`document.querySelector("kin-fridge .fridge-status").textContent`), "Erase undone.");
  await page(`document.querySelector("kin-fridge .fridge-history button:last-child").click()`);
  await until(async () => (await strokes()) === 1);
  await page(`document.querySelector("kin-fridge .fridge-colour").click()`);
  const tools = await page(`[...document.querySelectorAll("kin-fridge .fridge-tools button")].every((button) => button.tagName === "BUTTON" && button.getAttribute("aria-label") || button.textContent)`);
  assert.equal(tools, true, "every tool is a named button");

  // After a lock, the stored log decrypts and replays to the same fridge.
  const reopened = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const before = window.__fridgeRoom.board().strokes.map((stroke) => stroke.id).join();
    window.__fridgeRoom.close();
    const { BoardRoom } = await import("/board/board-room.js");
    const room = await BoardRoom.open({ ...window.__fridgeOptions, engine: app.engine });
    window.__fridgeRoom = room;
    app.fridge.room = room;
    return { before, after: room.board().strokes.map((stroke) => stroke.id).join(), waiting: room.waiting };
  })()`);
  assert.equal(reopened.after, reopened.before, "the reopened fridge matches");
  assert.equal(reopened.waiting, true, "unsent changes are still waiting");

  // Clean up: no room, no fridge database left behind for later checks.
  await page(`(async () => {
    const app = document.querySelector("kin-app");
    app.fridge.room = null;
    window.__fridgeRoom?.close();
    delete window.__fridgeRoom;
    delete window.__fridgeOptions;
    await new Promise((resolve) => { const request = indexedDB.deleteDatabase("kin-board-log:${HOUSEHOLD}"); request.onsuccess = request.onerror = request.onblocked = resolve; });
    location.hash = "#today";
    app.ctx.navigation.showPageFromLocation();
    return true;
  })()`);
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await client.send("Emulation.clearDeviceMetricsOverride");
  return "PASS fridge: 3:4 door fits phone, tablet and desktop; finger, pen and mouse drawing; second-finger cancel; palm rejection; eraser, undo and redo through the real engine (#317)";
}
