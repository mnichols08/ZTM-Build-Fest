// Issue #164: a new tab is used only once it has loaded Kin's origin.
import assert from "node:assert/strict";
import test from "node:test";
import { createLoadTrace, waitForOrigin } from "./cdp-page.mjs";

test("waitForOrigin waits through about:blank and a lost context until the page has loaded", async () => {
  const answers = [false, new Error("Execution context was destroyed."), false, true];
  let calls = 0;
  await waitForOrigin(async (expression) => {
    if (expression.startsWith("`")) return "about:blank (complete)";
    const next = answers[Math.min(calls++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  }, "http://127.0.0.1:1");
  assert.equal(calls, 4);
});

test("waitForOrigin fails clearly instead of carrying on with the wrong page", async () => {
  await assert.rejects(
    waitForOrigin(async (expression) => expression.startsWith("`") ? "about:blank (complete)" : false, "http://127.0.0.1:1", { timeoutMs: 120 }),
    /did not finish loading http:\/\/127\.0\.0\.1:1 within 120 ms; last seen: about:blank \(complete\)/);
});

test("waitForOrigin re-navigates a tab stuck on about:blank", async () => {
  let navigated = 0;
  await waitForOrigin(async (expression) => {
    if (expression.startsWith("`")) return navigated ? "http://127.0.0.1:1/ (interactive)" : "about:blank (complete)";
    return navigated > 0;
  }, "http://127.0.0.1:1", { renavigateAfterMs: 60, navigate: async () => { navigated += 1; } });
  assert.equal(navigated, 1);
});

// #594: a start that stopped part way says which scripts it still waits for.
test("createLoadTrace counts scripts per load and names open and aborted ones", () => {
  let clock = 1_000;
  const trace = createLoadTrace({ now: () => clock });
  const event = (method, params) => trace.observe({ method, params });
  event("Page.frameNavigated", { frame: { loaderId: "LOAD1", url: "http://127.0.0.1:1/" } });
  for (const [requestId, path] of [["1", "/components/kin-app.js"], ["2", "/a.js"], ["3", "/b.js"]])
    event("Network.requestWillBeSent", { requestId, loaderId: "LOAD1", type: "Script", request: { url: `http://127.0.0.1:1${path}` }, initiator: { type: "script" } });
  event("Network.responseReceived", { requestId: "1", response: { status: 200, fromServiceWorker: true } });
  event("Network.loadingFinished", { requestId: "1" });
  event("Network.loadingFailed", { requestId: "2", type: "Script", errorText: "net::ERR_ABORTED", canceled: true });
  clock += 500;
  const lines = trace.lines();
  assert.equal(lines[0], "scripts per load: LLOAD1 3 sent/1 done (1 by the worker)/1 failed, 500 ms ago");
  assert.equal(lines[1], "scripts not finished: LLOAD1 /b.js 500 ms, response none");
  assert.match(lines[2], /committed {2}LLOAD1 \/ \| -500ms failed Script LLOAD1 net::ERR_ABORTED canceled \/a\.js by script after 0 ms/);
  assert.equal(trace.abortedSummary(), "1 page load(s) lost a module request (/a.js); the start-up guard loads such a page again");
});

test("createLoadTrace has no aborted summary when nothing was cancelled", () => {
  const trace = createLoadTrace();
  trace.observe({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom\n at x" } } } });
  assert.equal(trace.abortedSummary(), "");
  assert.match(trace.lines().at(-1), /exception Error: boom/);
});
