// Simple view (#345, #346, ADR 0013) in the real app: the layout a household
// admin chooses for a Limited member. The switch and its cache are covered
// by the server and household drills; here the layout is applied as an
// unlock with the cached flag would, on this unsynced test household.
// Afterwards the page reloads into the full layout.
import assert from "node:assert/strict";
import { setViewport } from "./cdp-viewport.mjs";

export async function simpleRegressions(client, { until, ready }) {
  const page = (expression) => client.evaluate(expression);

  const setup = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const me = app.ctx.detail.responsibilityContext().memberId;
    const hex = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const socks = hex(), other = hex();
    await app.ctx.append.appendCommand({ type: "add", id: socks, text: "Simple regression socks away", classification: "need" });
    await app.ctx.append.appendCommand({ type: "add", id: other, text: "Simple regression not mine", classification: "need" });
    await app.ctx.append.appendCommand({ type: "change-responsibility", targetKind: "item", id: socks, memberId: me });
    await app.ctx.append.appendCommand({ type: "set-item-emoji", itemId: socks, emoji: "🧦" });
    app.ctx.render.renderState();
    location.hash = "#lists/shopping";
    app.ctx.simple.enter();
    app.ctx.render.renderState();
    return { me, socks };
  })()`);
  await until(() => page(`document.querySelector("kin-simple")?.querySelectorAll(".simple-card").length > 0`), { attempts: 300 });

  const shell = await page(`(() => {
    const app = document.querySelector("kin-app");
    const visible = (node) => node && !node.hidden && node.getClientRects().length > 0;
    return {
      flag: document.documentElement.dataset.kinSimple,
      pages: [...app.pages.keys()],
      mounted: ["lists", "routines", "search"].filter((id) => document.getElementById(id)),
      nav: [...app.navLinks.values()].filter(visible).map((link) => [link.textContent.trim(), link.getAttribute("href")]),
      quickAdd: visible(app.quickAdd), search: visible(app.searchLink), lock: visible(app.lockButton),
      hash: location.hash,
      cards: [...document.querySelectorAll("kin-simple .simple-card")].map((card) => ({
        text: card.querySelector(".simple-text").textContent,
        emoji: card.querySelector(".simple-emoji")?.textContent ?? null,
        button: card.querySelector("button").getAttribute("aria-label"),
      })),
      counts: /\\d/.test(document.querySelector("kin-simple").textContent.replace(/Simple regression/g, "")),
    };
  })()`);
  assert.equal(shell.flag, "on");
  assert.deepEqual(shell.pages, ["today", "updates", "household"], "only Today, Chat and the Fridge");
  assert.deepEqual(shell.mounted, [], "no other page is in the document");
  assert.deepEqual(shell.nav, [["Today", "#today"], ["Chat", "#updates/chat"], ["Fridge", "#household/fridge"]]);
  assert.ok(!shell.quickAdd && !shell.search && shell.lock, "Quick add and Search are off; Lock stays");
  assert.equal(shell.hash, "#today", "a hidden page's address goes to Today");
  assert.deepEqual(shell.cards, [{ text: "Simple regression socks away", emoji: "🧦", button: "Done: Simple regression socks away" }],
    "only my own thing, with its picture");
  assert.equal(shell.counts, false, "no counts or totals");

  // Every other route, the palette and item details stay closed.
  const closed = await page(`(async () => {
    const app = document.querySelector("kin-app");
    const reached = [];
    for (const hash of ["#lists", "#routines", "#search", "#household/people", "#updates/handoffs", "#more/security"]) {
      app.ctx.navigation.navigate(hash);
      if (app.route.canonical !== "today") reached.push(hash);
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true, bubbles: true }));
    app.ctx.detail.openItemDetail(${JSON.stringify(setup.socks)});
    return { reached, palette: Boolean(app.commandPalette?.isOpen), selection: app.selection };
  })()`);
  assert.deepEqual(closed, { reached: [], palette: false, selection: null });
  for (const [hash, canonical] of [["#updates/chat", "updates/chat"], ["#household/fridge", "household/fridge"], ["#today", "today"]]) {
    await page(`document.querySelector("kin-app").ctx.navigation.navigate(${JSON.stringify(hash)})`);
    assert.equal(await page(`document.querySelector("kin-app").route.canonical`), canonical);
  }

  // Done, then Undo in the same place; the status says so politely.
  await page(`document.querySelector("kin-simple .simple-done").click()`);
  await until(() => page(`(() => { const app = document.querySelector("kin-app");
    return !app.busy && document.querySelector("kin-simple .simple-undo") !== null && /^Marked “Simple regression socks away” done\\./.test(app.status.textContent); })()`), { attempts: 300 });
  const done = await page(`(() => {
    const app = document.querySelector("kin-app");
    const undo = document.querySelector("kin-simple .simple-undo");
    return { label: undo.getAttribute("aria-label"), focused: document.activeElement === undo, height: undo.getBoundingClientRect().height,
      completed: app.state.items.find((item) => item.text === "Simple regression socks away").status };
  })()`);
  assert.equal(done.label, "Undo: Simple regression socks away");
  assert.equal(done.completed, "completed");
  assert.ok(done.focused, "focus stays on the card's button");
  assert.ok(done.height >= 56, `the button is at least 56px tall (${done.height})`);
  await page(`document.querySelector("kin-simple .simple-undo").click()`);
  await until(() => page(`(() => { const app = document.querySelector("kin-app");
    return !app.busy && document.querySelector("kin-simple .simple-done") !== null && /not done/.test(app.status.textContent); })()`), { attempts: 300 });

  // Layout: one column on a phone, a grid on a tablet; nothing scrolls sideways.
  for (const [label, metrics, columns] of [
    ["phone", { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }, 1],
    ["tablet", { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true }, null],
    ["desktop", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, null],
  ]) {
    await setViewport(client, metrics);
    await page(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    const view = await page(`(() => {
      const card = document.querySelector("kin-simple .simple-card");
      const picture = card.querySelector(".simple-picture").getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth, width: innerWidth, picture: Math.round(picture.width),
        nav: document.querySelector(".primary-nav").getBoundingClientRect().top > innerHeight / 2 };
    })()`);
    assert.ok(view.scroll <= view.width, `${label}: no horizontal scroll`);
    assert.ok(view.picture >= (metrics.width < 720 ? 96 : 128), `${label}: the picture is large (${view.picture}px)`);
    if (columns === 1) assert.ok(view.nav, `${label}: the destinations sit in a bottom bar`);
  }
  await client.send("Emulation.clearDeviceMetricsOverride");

  // Back to the full layout for the rest of the run.
  await client.send("Page.reload");
  await ready(client);
  const full = await page(`(() => ({ flag: document.documentElement.dataset.kinSimple ?? null, lists: Boolean(document.getElementById("lists")) }))()`);
  assert.deepEqual(full, { flag: null, lists: true });
  return "PASS Simple view: only Today, Chat and the Fridge; no palette, details, Quick add or Search; my things with pictures; Done and Undo in place; phone, tablet and desktop (#345, #346)";
}
