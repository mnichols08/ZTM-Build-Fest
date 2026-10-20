// Chat fits the screen (#310, #311) in a real browser, on the room the chat
// suite leaves behind (500 messages): the page doesn't scroll, the message
// list does; Chat opens at the latest message; the one-row composer stays in
// view above the phone's bottom bar, and above the keyboard (emulated by a
// shorter viewport while the message box has focus); jump to latest works.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";

export async function chatLayoutRegressions(client, { until }) {
  const page = (expression) => client.evaluate(expression);
  const frames = () => page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`);
  await page(`(() => { const app = document.querySelector("kin-app"); app.ctx.navigation.navigate("#updates/chat"); return true; })()`);
  await frames();
  const measure = () => page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const scroller = chat.querySelector(".chat-scroll");
    const form = chat.querySelector(".chat-form").getBoundingClientRect();
    const row = chat.querySelector(".chat-compose-row").getBoundingClientRect();
    const nav = document.querySelector(".primary-nav");
    const navRect = nav && getComputedStyle(nav).position === "fixed" && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect() : null;
    const visible = window.visualViewport ? visualViewport.height : innerHeight;
    return {
      fit: chat.querySelector(".chat-section").classList.contains("chat-fit"),
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      sideways: document.documentElement.scrollWidth - innerWidth,
      atLatest: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4,
      list: scroller.clientHeight, visible,
      composerBottom: Math.round(form.bottom), rowHeight: Math.round(row.height),
      navTop: navRect ? Math.round(navRect.top) : null,
    };
  })()`);

  for (const [label, metrics] of [
    ["phone", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }],
    ["phone landscape", { width: 568, height: 320, deviceScaleFactor: 2, mobile: true }],
    ["tablet", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }],
    ["tablet landscape", { width: 1024, height: 768, deviceScaleFactor: 2, mobile: true }],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }],
    ["desktop at 200%", { width: 640, height: 400, deviceScaleFactor: 2, mobile: false }],
  ]) {
    await setViewport(client, metrics);
    await page(`(() => { const s = document.querySelector("kin-app kin-chat .chat-scroll"); s.scrollTop = s.scrollHeight; return true; })()`);
    await frames();
    const view = await measure();
    assert.ok(view.fit, `${label}: the chat fits the screen`);
    assert.ok(view.pageScroll <= 2, `${label}: the page itself doesn't scroll (${view.pageScroll}px)`);
    assert.ok(view.sideways <= 0, `${label}: no horizontal scroll`);
    assert.ok(view.composerBottom <= view.visible + 1, `${label}: the composer is in view (${view.composerBottom} of ${view.visible})`);
    if (view.navTop !== null) assert.ok(view.composerBottom <= view.navTop + 1, `${label}: the composer sits above the bottom bar`);
    assert.ok(view.rowHeight <= 120, `${label}: the composer is one row (${view.rowHeight}px)`);
    assert.ok(view.atLatest, `${label}: showing the latest message`);
  }

  // A phone with the keyboard open: the message box has focus and the
  // visible height shrinks; the bottom bar steps aside, the list keeps room.
  await setViewport(client, { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] }).catch(() => {});
  await page(`(() => { document.querySelector("kin-app kin-chat textarea").focus(); return true; })()`);
  await setViewport(client, { width: 320, height: 300, deviceScaleFactor: 2, mobile: true });
  await frames();
  const typing = await measure();
  const composing = await page(`document.documentElement.hasAttribute("data-chat-composing")`);
  assert.ok(composing, "focusing the message box marks the page as composing");
  assert.ok(typing.composerBottom <= typing.visible + 1, `keyboard open: the composer stays above it (${typing.composerBottom} of ${typing.visible})`);
  assert.ok(typing.list >= typing.visible * 0.25, `keyboard open: the list keeps room (${typing.list} of ${typing.visible})`);
  await page(`(() => { document.activeElement?.blur(); return true; })()`);
  await client.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  // Scrolled up, Jump to latest appears and takes you back.
  await setViewport(client, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page(`(() => { const s = document.querySelector("kin-app kin-chat .chat-scroll"); s.scrollTop = 0; s.dispatchEvent(new Event("scroll")); return true; })()`);
  await until(() => page(`!document.querySelector("kin-app kin-chat .chat-jump").hidden`), { attempts: 200 });
  await page(`(() => { document.querySelector("kin-app kin-chat .chat-jump").click(); return true; })()`);
  await until(() => page(`(() => { const s = document.querySelector("kin-app kin-chat .chat-scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 4; })()`), { attempts: 300 });

  // The + menu holds photo, file, camera and poll; Escape returns to +.
  const menu = await page(`(() => {
    const chat = document.querySelector("kin-app kin-chat");
    const more = chat.querySelector(".chat-more");
    more.click();
    const open = !chat.querySelector(".chat-add-menu").hidden && more.getAttribute("aria-expanded") === "true";
    const inside = document.activeElement?.closest?.(".chat-add-menu") !== null;
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    return { open, inside, closed: chat.querySelector(".chat-add-menu").hidden, back: document.activeElement === more,
      voice: !chat.querySelector(".chat-voice-open").hidden, send: chat.querySelector(".chat-form .add-button").hidden };
  })()`);
  assert.deepEqual(menu, { open: true, inside: true, closed: true, back: true, voice: true, send: true }, "the + menu, and Voice while the box is empty");

  await client.send("Emulation.clearDeviceMetricsOverride");
  await page(`(async () => { await window.__chatCleanup?.(); delete window.__chatCleanup; return true; })()`);
  return "PASS chat fits the screen at 320×568 to desktop and 200%, opens at the latest message, keeps the one-row composer above the bar and the keyboard, jumps to latest, and the + menu (#310, #311)";
}
