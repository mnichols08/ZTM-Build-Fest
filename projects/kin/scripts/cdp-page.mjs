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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setMedia } from "./cdp-media.mjs";

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

// Browser regressions reload pages and expect the lock screen, so every
// regression tab starts with refresh-resume (#351) off. The check that wants
// it on sets the preference to "on" itself; this only fills an unset value.
export const REGRESSION_DEFAULTS_SCRIPT =
  'try { if (localStorage.getItem("kin.reload-resume-enabled") === null) localStorage.setItem("kin.reload-resume-enabled", "off"); } catch {}';

/** Installs REGRESSION_DEFAULTS_SCRIPT for every later page load in a tab. */
// Every page a regression opened (newest last), so a failure can show what
// each one looked like (#328).
const livePages = [];
const MAX_CAPTURED_PAGES = 6;
const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * Saves, for each page the failing regression still has open, a screenshot
 * and its address, title and text, into KIN_DIAGNOSTICS_DIR (nothing when it
 * isn't set). Called from a regression's outer catch before its browser is
 * closed; never throws, and a page that no longer answers is skipped.
 */
export async function captureFailure(suite, { dir = process.env.KIN_DIAGNOSTICS_DIR } = {}) {
  if (!dir) return [];
  const saved = [];
  try {
    await mkdir(dir, { recursive: true });
    const slug = String(suite).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const pages = livePages.slice(-MAX_CAPTURED_PAGES);
    for (const [index, send] of pages.entries()) {
      const call = (method, params) => Promise.race([
        send(method, params),
        delay(CAPTURE_TIMEOUT_MS).then(() => { throw new Error("no answer"); }),
      ]);
      const base = join(dir, `${slug}-page${index + 1}`);
      try {
        const { result } = await call("Runtime.evaluate", {
          expression: `JSON.stringify({ href: location.href, title: document.title, text: (document.body?.innerText ?? "").slice(0, 20000) }, null, 2)`,
          returnByValue: true,
        });
        await writeFile(`${base}.txt`, result?.value ?? "");
        saved.push(`${base}.txt`);
      } catch { /* that page is gone */ }
      try {
        const { data } = await call("Page.captureScreenshot", { format: "png" });
        await writeFile(`${base}.png`, Buffer.from(data, "base64"));
        saved.push(`${base}.png`);
      } catch { /* that page is gone */ }
    }
  } catch { /* diagnostics must never hide the failure itself */ }
  if (saved.length) console.error(`Saved failure diagnostics: ${saved.join(", ")}`);
  return saved;
}

export async function applyRegressionDefaults(send) {
  livePages.push(send);
  // The Page domain must be on, or the script may not be installed.
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: REGRESSION_DEFAULTS_SCRIPT });
  // The tab may already have loaded Kin before the script existed.
  await send("Runtime.evaluate", { expression: REGRESSION_DEFAULTS_SCRIPT }).catch(() => {});
  // Light with forced colours off, whatever the machine's appearance (#795).
  await setMedia({ send });
}
