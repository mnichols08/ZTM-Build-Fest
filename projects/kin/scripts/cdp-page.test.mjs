// Issue #164: a new tab is used only once it has loaded Kin's origin.
import assert from "node:assert/strict";
import test from "node:test";
import { waitForOrigin } from "./cdp-page.mjs";

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
