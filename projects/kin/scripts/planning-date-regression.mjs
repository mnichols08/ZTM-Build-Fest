// Runs inside the browser against real DOM, storage, and Rust/WASM replay.
export async function planningDateRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh) && index < 300; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing, "planning-date work returns idle");
  };
  const originalNow = Date.now;
  const originalPage = location.hash.slice(1) || "today";
  Date.now = () => new Date(2026, 9, 3, 12).getTime();
  try {
    const text = `Planning date ${crypto.randomUUID()}`;
    app.compose.input.value = text;
    app.compose.classification.value = "need";
    app.compose.form.requestSubmit();
    await idle();
    const item = app.state.items.find((entry) => entry.text === text);
    check(item?.planningDate === null, "new Items begin without a planning date");
    app.navLinks.get("lists").click();
    const dateInput = () => app.needs.querySelector(
      `.item-planning-date-input[data-item-id="${item.itemId}"]`,
    );
    check(
      dateInput()?.getAttribute("aria-label") === `Planned date for ${text}`,
      "native date input has an item-specific accessible name",
    );

    const beforeToday = (await app.store.loadEvents()).length;
    const shortcuts = () => [...dateInput().closest("kin-item").querySelectorAll(".item-planning-date-shortcut")];
    shortcuts().find((button) => button.textContent === "Today").click();
    await idle();
    check(
      app.state.items.find((entry) => entry.itemId === item.itemId).planningDate === 20261003 &&
        (await app.store.loadEvents()).length === beforeToday + 1,
      "Today commits one concrete local civil date",
    );
    check(document.activeElement === dateInput(), "focus returns to the date editor");

    shortcuts().find((button) => button.textContent === "Tomorrow").click();
    await idle();
    check(
      app.state.items.find((entry) => entry.itemId === item.itemId).planningDate === 20261004,
      "Tomorrow commits the next local civil date",
    );

    dateInput().value = "2026-10-07";
    dateInput().dispatchEvent(new Event("change", { bubbles: true }));
    await idle();
    check(
      app.state.items.find((entry) => entry.itemId === item.itemId).planningDate === 20261007,
      "native date editing persists the selected day",
    );
    check(!app.calendarExportButton.disabled, "dated active Items enable calendar export");
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    let calendarBlob;
    let download;
    URL.createObjectURL = (blob) => {
      calendarBlob = blob;
      return "blob:calendar-export-regression";
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () {
      download = { href: this.href, filename: this.download };
    };
    try {
      app.calendarExportButton.click();
      const contents = await calendarBlob.text();
      check(
        download?.filename === "kin-planned-items.ics" &&
          download.href === "blob:calendar-export-regression" &&
          calendarBlob.type === "text/calendar;charset=utf-8" &&
          contents.includes("DTSTART;VALUE=DATE:20261007") &&
          contents.includes(`SUMMARY:${text}`),
        "calendar export downloads a local all-day iCalendar file",
      );
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    }
    shortcuts().find((button) => button.textContent === "Clear").click();
    await idle();
    await app.refreshFromEvents();
    check(
      app.state.items.find((entry) => entry.itemId === item.itemId).planningDate === null,
      "clearing and replay retain an unset date",
    );
    check(app.calendarExportButton.disabled, "clearing the last date disables calendar export");
  } finally {
    Date.now = originalNow;
    await app.refreshFromEvents();
    app.navLinks.get(originalPage)?.click();
  }
  return "PASS planning dates, native editor, local shortcuts, persistence, focus and iCalendar download";
}
