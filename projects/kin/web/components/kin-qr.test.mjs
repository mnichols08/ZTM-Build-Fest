// <kin-qr> (#96): layout, painting, the text code and Copy, failure and
// expiry, without a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { connect, disconnect, installDom, recordEvents, settle } from "./qr-test-dom.mjs";

const defined = installDom();
const { KinQr, QUIET_ZONE, paintModules, qrLayout } = await import("./kin-qr.js");
assert.equal(defined["kin-qr"], KinQr);

/** A codec that returns a fixed 21 × 21 grid with a known pattern. */
function fakeCodec({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    encode(text) {
      calls.push(text);
      if (fail) throw new Error("too long");
      const side = 21;
      const modules = new Uint8Array(side * side);
      modules[0] = 1;
      modules[side * side - 1] = 1;
      return { side, modules };
    },
  };
}

function element({ codec = fakeCodec(), value = "https://kin.test/pair#code=ABCD", code = "ABCD-EFGH" } = {}) {
  const qr = new KinQr();
  qr.codec = codec;
  qr.value = value;
  qr.code = code;
  qr.label = "Scan to join the household";
  return qr;
}

const canvasOf = (qr) => qr.find((node) => node.tagName === "CANVAS");

test("every module is a whole number of pixels, never less than one", () => {
  assert.deepEqual(qrLayout(21, 240), { scale: 8, pixels: 232 }, "21 + 8 quiet modules = 29; 240 / 29 = 8");
  assert.deepEqual(qrLayout(57, 240), { scale: 3, pixels: 195 });
  assert.deepEqual(qrLayout(57, 10), { scale: 1, pixels: 65 }, "a tiny size still draws one pixel per module");
});

test("modules are painted black on white with the quiet zone around them", () => {
  const fills = [];
  const context = { fillStyle: "", fillRect(x, y, w, h) { fills.push([this.fillStyle, x, y, w, h]); } };
  const side = 3;
  const modules = Uint8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  paintModules(context, side, modules, 2);
  const total = (side + 2 * QUIET_ZONE) * 2;
  assert.deepEqual(fills[0], ["#ffffff", 0, 0, total, total], "the whole symbol starts light");
  assert.deepEqual(fills.slice(1), [
    ["#000000", 8, 8, 2, 2],
    ["#000000", 10, 10, 2, 2],
    ["#000000", 12, 12, 2, 2],
  ], "only dark modules are painted, offset by four modules");
});

test("the code is shown as text with a Copy button, and the QR is a labelled image", async () => {
  const qr = connect(element());
  await settle();
  const canvas = canvasOf(qr);
  assert.equal(canvas.getAttribute("role"), "img");
  assert.equal(canvas.getAttribute("aria-label"), "Scan to join the household");
  assert.equal(qr.byClass("kin-qr-frame").hidden, false, "the QR shows once drawn");
  assert.equal(qr.byClass("kin-qr-code").textContent, "ABCD-EFGH");
  assert.ok(qr.byText("Copy code"), "Copy sits next to the code");
  assert.equal(canvas.width % 29, 0, "the canvas is a whole number of modules wide");
  assert.equal(canvas.context.fills[0][0], "#ffffff");
});

test("Copy puts the code on the clipboard, and says so when it can't", async () => {
  const written = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text) => { written.push(text); } } } });
  const qr = connect(element());
  await settle();
  qr.byText("Copy code").click();
  await settle();
  assert.deepEqual(written, ["ABCD-EFGH"]);
  assert.equal(qr.byClass("kin-qr-status").textContent, "Code copied.");

  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("denied"); } } } });
  qr.byText("Copy code").click();
  await settle();
  assert.equal(qr.byClass("kin-qr-status").textContent, "Copy is unavailable. Select the code and copy it.");
});

test("a QR that can't be drawn leaves the code as the way through", async () => {
  const qr = connect(element({ codec: fakeCodec({ fail: true }) }));
  await settle();
  assert.equal(qr.byClass("kin-qr-frame").hidden, true);
  assert.equal(qr.byClass("kin-qr-code").textContent, "ABCD-EFGH");
  assert.equal(qr.byClass("kin-qr-status").textContent, "The QR code couldn't be drawn. Use the code instead.");
});

test("an expired payload is replaced by refresh when one is given", async () => {
  const codec = fakeCodec();
  const qr = element({ codec });
  qr.refresh = async () => ({ value: "https://kin.test/pair#code=NEW", code: "NEW-CODE", expiresAt: Date.now() + 60_000 });
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await settle();
  await settle();
  await settle();
  assert.equal(qr.value, "https://kin.test/pair#code=NEW");
  assert.equal(qr.byClass("kin-qr-code").textContent, "NEW-CODE");
  assert.equal(codec.calls.at(-1), "https://kin.test/pair#code=NEW", "the new link is the one drawn");
  disconnect(qr);
});

test("without refresh, an expired payload says so and tells the page", async () => {
  const qr = element();
  const events = recordEvents(qr);
  connect(qr);
  qr.expiresAt = Date.now() - 1;
  await settle();
  await settle();
  assert.ok(events.some((event) => event.type === "kin-qr-expired"));
  assert.equal(qr.byClass("kin-qr-status").textContent, "This code expired. Ask for a new one.");
  assert.equal(qr.byClass("kin-qr-frame").hidden, true, "an expired QR is not shown");
  disconnect(qr);
});

test("a removed element stops waiting for expiry", async () => {
  let refreshed = false;
  const qr = element();
  qr.refresh = async () => { refreshed = true; return null; };
  connect(qr);
  qr.expiresAt = Date.now() + 5;
  disconnect(qr);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshed, false);
});

test("without a code, only the QR and its status are shown", async () => {
  const qr = connect(element({ code: "" }));
  await settle();
  assert.equal(qr.byClass("kin-qr-code-row").hidden, true);
  assert.equal(qr.byClass("kin-qr-code-label").hidden, true);
});
