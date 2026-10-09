export async function shoppingRegressions() {
  const app = document.querySelector("kin-app");
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const idle = async () => {
    for (
      let i = 0;
      (app.busy || app.refreshing || app.pendingRefresh) && i < 300;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing, "Shopping work returns idle");
  };

  check(
    app.compose.classification.querySelector('option[value="shopping"]'),
    "Shopping is an available capture destination",
  );
  app.compose.input.value = "Shopping regression item";
  app.compose.classification.value = "shopping";
  app.compose.input.focus();
  app.compose.form.requestSubmit();
  await idle();

  let item = app.state.items.find(
    (record) => record.text === "Shopping regression item",
  );
  check(item?.classification === "shopping", "Shopping classification is replayed");
  check(
    app.shopping.querySelector("kin-item .item-text")?.textContent ===
      item.text &&
      !app.needs.querySelector("kin-item .item-text")?.textContent?.includes(
        item.text,
      ),
    "Shopping appears only in its dedicated list",
  );

  const complete = app.shopping.querySelector("kin-item .complete-button");
  complete.focus();
  complete.click();
  await idle();
  item = app.state.items.find(
    (record) => record.text === "Shopping regression item",
  );
  check(item.status === "completed", "Shopping completion is persisted");
  check(
    app.shopping.querySelector("kin-item .reopen-button") ===
      document.activeElement,
    "List focus follows the completed item's Reopen action",
  );

  app.shopping.querySelector("kin-item .reopen-button").click();
  await idle();
  check(
    app.state.items.find((record) => record.itemId === item.itemId).status ===
      "active",
    "Shopping item can be reopened",
  );
  app.shopping.querySelector("kin-item .archive-button").click();
  await idle();
  check(
    app.state.items.find((record) => record.itemId === item.itemId).status ===
      "archived" &&
      !app.shopping.querySelector("kin-item"),
    "Archived Shopping item is retained but hidden",
  );
  return "PASS shared Shopping capture, list isolation, lifecycle, and focus";
}
