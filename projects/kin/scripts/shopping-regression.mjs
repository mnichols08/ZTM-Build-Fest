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
  check(
    app.compose.classification.querySelector('option[value="staple"]'),
    "Staples is an available capture destination",
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

  app.compose.input.value = "Laundry detergent";
  app.compose.classification.value = "staple";
  app.compose.form.requestSubmit();
  await idle();
  let staple = app.state.items.find(
    (record) => record.text === "Laundry detergent",
  );
  check(
    staple?.classification === "staple" &&
      app.staples.querySelector("kin-item .item-text")?.textContent ===
        staple.text &&
      !app.shopping.querySelector("kin-item .item-text")?.textContent?.includes(
        staple.text,
      ),
    "Staples appear only in the reusable Staples list",
  );
  check(
    !app.staples.querySelector("kin-item .complete-button") &&
      app.staples.querySelector("kin-item .replenish-button"),
    "Staples offer replenishment rather than completion",
  );

  const replenish = app.staples.querySelector("kin-item .replenish-button");
  replenish.focus();
  const append = app.store.append;
  let firstAttempt = true;
  let originalCommand;
  let retryCommand;
  app.store.append = async function (...args) {
    if (firstAttempt) {
      firstAttempt = false;
      originalCommand = args[0];
      const error = new Error("Synthetic replenishment storage failure");
      error.code = 5;
      throw error;
    }
    retryCommand = args[0];
    return append.apply(this, args);
  };
  try {
    replenish.click();
    await idle();
    check(
      !app.state.items.some(
        (record) =>
          record.text === staple.text && record.classification === "shopping",
      ) && !app.retryButton.hidden,
      "Failed replenishment is reported without appending a Shopping Item",
    );
    app.retryButton.click();
    await idle();
  } finally {
    app.store.append = append;
  }
  const shoppingCopies = app.state.items.filter(
    (record) =>
      record.text === staple.text && record.classification === "shopping",
  );
  const shoppingCopy = shoppingCopies[0];
  check(
    originalCommand?.id === retryCommand?.id &&
      shoppingCopies.length === 1 &&
      staple.status === "active" &&
      shoppingCopy?.status === "active" &&
      app.shopping.querySelector("kin-item .item-text")?.textContent ===
        staple.text,
    "Retry appends exactly one Shopping Item with the same identity and keeps the staple",
  );
  check(
    app.staples.querySelector("kin-item .replenish-button") ===
      document.activeElement,
    "Staples focus returns to Add to Shopping after persistence",
  );

  app.staples.querySelector("kin-item .archive-button").click();
  await idle();
  staple = app.state.items.find((record) => record.itemId === staple.itemId);
  check(
    staple.status === "archived" &&
      app.staples.querySelector("kin-item") === null &&
      app.shopping.querySelector("kin-item .item-text")?.textContent ===
        shoppingCopy.text,
    "Archiving a staple does not remove its Shopping copy",
  );
  return "PASS Shopping lifecycle and Staples replenishment, isolation, and focus";
}
