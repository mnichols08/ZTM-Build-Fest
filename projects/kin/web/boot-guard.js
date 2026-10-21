// Start-up guard (#594): loads Kin again when its module graph didn't load.
//
// Kin starts from one module script (components/kin-app.js) that imports
// about 240 modules, all answered by the service worker from its cache. On
// Edge for Windows a page load sometimes has every module request still in
// flight at one instant cancelled by the browser (net::ERR_ABORTED, no
// response, no navigation, ~100 ms after the page commits). A module graph
// with one failed fetch never runs, and the browser reports it only as an
// `error` event on the <script> element: no console error, nothing pending,
// a page that says "Skip to content" and nothing else, for good.
//
// This classic, deferred script runs just before that module script and
// watches for exactly that event. A failed graph is loaded again, at most
// twice per tab in a row; after that, a short message offers to try again.
// Exceptions thrown while Kin's modules run are not load failures (they are
// reported on the window, not the element) and never cause a reload.
//
// Refresh-resume (#351) unlocks only a load the browser calls a refresh.
// This guard's own reload is one, so when the failed load was not a refresh
// (a new tab, a link, a shortcut) the one-use resume ticket the previous
// page left is deleted first: that load stays locked, as it would have been.
"use strict";
(function installBootGuard(win) {
  if (!win || !win.document || win.kinBootGuard) return;
  var RETRY_KEY = "kin.boot-retry";
  var TICKET_KEY = "kin.reload-resume";
  var MAX_RETRIES = 2;
  var doc = win.document;

  function session() {
    try { return win.sessionStorage || null; } catch (error) { return null; }
  }
  function retries(storage) {
    try {
      var count = Number(storage.getItem(RETRY_KEY));
      return Number.isInteger(count) && count > 0 ? count : 0;
    } catch (error) { return null; }
  }
  function navigationType() {
    try {
      var entry = win.performance.getEntriesByType("navigation")[0];
      return entry ? entry.type : null;
    } catch (error) { return null; }
  }
  function isEntryScript(target) {
    return Boolean(target) && target.tagName === "SCRIPT" && target.type === "module" &&
      /\/components\/kin-app\.js(?:$|[?#])/.test(String(target.src || ""));
  }
  function explain() {
    if (!doc.body || doc.querySelector("[data-kin-boot-failed]")) return;
    var box = doc.createElement("div");
    box.setAttribute("role", "alert");
    box.setAttribute("data-kin-boot-failed", "");
    box.className = "boot-failed";
    var text = doc.createElement("p");
    text.textContent = "Kin didn't finish loading.";
    var button = doc.createElement("button");
    button.type = "button";
    button.textContent = "Try again";
    button.addEventListener("click", function () {
      var storage = session();
      try { if (storage) storage.removeItem(RETRY_KEY); } catch (error) { /* reload anyway */ }
      win.location.reload();
    });
    box.appendChild(text);
    box.appendChild(button);
    doc.body.appendChild(box);
  }
  function onFailedStart() {
    var storage = session();
    var count = storage ? retries(storage) : null;
    // Without a counter a reload could repeat for ever: explain instead.
    if (count === null || count >= MAX_RETRIES) return explain();
    try {
      storage.setItem(RETRY_KEY, String(count + 1));
      if (navigationType() !== "reload") storage.removeItem(TICKET_KEY);
    } catch (error) { return explain(); }
    win.location.reload();
  }

  var guard = {
    // An `error` event doesn't bubble, but the window sees it while capturing.
    onError: function (event) {
      if (isEntryScript(event && event.target)) onFailedStart();
    },
  };
  win.kinBootGuard = guard;
  win.addEventListener("error", guard.onError, true);
  // Kin started: the next failure starts counting again.
  try {
    win.customElements.whenDefined("kin-app").then(function () {
      var storage = session();
      try { if (storage) storage.removeItem(RETRY_KEY); } catch (error) { /* nothing to clear */ }
    });
  } catch (error) { /* no custom elements: Kin can't start here anyway */ }
})(typeof window === "undefined" ? null : window);
