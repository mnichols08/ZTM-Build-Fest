// Waits until a freshly opened tab has committed its navigation to Kin's
// origin and finished loading (issue #164). The runners open a tab with
// /json/new?<origin> and used to poll location.origin for about 2 s, then
// carry on regardless. On the Windows runner the navigation sometimes took
// longer, so a check ran on about:blank ("Failed to resolve module specifier
// '/security/local-vault.js'") or lost its context when the navigation
// committed mid-check ("Execution context was destroyed").
//
// `evaluate(expression)` returns the value and may reject while the page
// changes; those rejections are retried until the deadline. `navigate()`,
// when given, is called if the tab is still not on the origin after a few
// seconds: on the Windows runner a /json/new tab sometimes stayed on
// about:blank. "Loaded" means past "loading": a page with a long-lived
// request may never report "complete".
import { setTimeout as delay } from "node:timers/promises";

export const PAGE_TIMEOUT_MS = 30_000;

export const RENAVIGATE_AFTER_MS = 5_000;

export async function waitForOrigin(evaluate, origin, { timeoutMs = PAGE_TIMEOUT_MS, navigate, renavigateAfterMs = RENAVIGATE_AFTER_MS } = {}) {
  const expression = `location.origin === ${JSON.stringify(origin)} && document.readyState !== "loading"`;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let nextNavigation = started + renavigateAfterMs;
  let last = "no answer";
  for (;;) {
    try {
      if (await evaluate(expression) === true) return;
      last = await evaluate("`${location.href} (${document.readyState})`").catch(() => last);
    } catch (error) {
      last = error?.message ?? String(error);
    }
    // Still not on the origin (a page that is loading it doesn't need help).
    if (navigate && Date.now() >= nextNavigation && !last.startsWith(origin)) {
      nextNavigation = Date.now() + renavigateAfterMs * 2;
      await navigate().catch(() => {});
    }
    if (Date.now() >= deadline)
      throw new Error(`The browser tab did not finish loading ${origin} within ${timeoutMs} ms; last seen: ${last}`);
    await delay(50);
  }
}
