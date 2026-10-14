export async function quickAddRegressions() {
  const app = document.querySelector("kin-app");
  const quick = app.quickAdd;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const idle = async () => {
    for (let index = 0; (app.busy || app.refreshing || app.pendingRefresh) && index < 400; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    check(!app.busy && !app.refreshing, "quick-add returns idle");
  };
  const count = (text) => app.state.items.filter((item) => item.text === text).length;
  const add = async (text) => {
    quick.trigger.click();
    quick.input.value = text;
    quick.input.dispatchEvent(new Event("input", { bubbles: true }));
    quick.form.requestSubmit();
    await idle();
  };

  app.navigate("#today");
  quick.trigger.focus();
  quick.trigger.click();
  check(quick.dialog.open && document.activeElement === quick.input, "opening focuses the labeled task title");
  quick.input.value = "";
  quick.form.requestSubmit();
  check(quick.dialog.open && quick.error.textContent === "Enter a task title." && document.activeElement === quick.input,
    "empty quick-add stays open with accessible feedback");
  quick.dialog.close();
  check(document.activeElement === quick.trigger, "closing restores focus to the trigger");

  const escape = new Event("cancel", { cancelable: true });
  quick.trigger.click();
  quick.dialog.dispatchEvent(escape);
  if (!escape.defaultPrevented) quick.dialog.close();
  check(!quick.dialog.open && document.activeElement === quick.trigger, "Escape closes without creating a task");

  const imeText = `IME task ${crypto.randomUUID().slice(0, 6)}`;
  quick.trigger.click();
  quick.input.value = imeText;
  quick.input.dispatchEvent(new CompositionEvent("compositionstart"));
  quick.form.requestSubmit();
  check(count(imeText) === 0 && quick.dialog.open, "IME composition does not submit");
  quick.input.dispatchEvent(new CompositionEvent("compositionend"));
  quick.form.requestSubmit();
  quick.form.requestSubmit();
  quick.addButton.click();
  await idle();
  const todayItem = app.state.items.find((item) => item.text === imeText);
  check(count(imeText) === 1 && todayItem?.planningDate === app.currentCivilDate() && !quick.dialog.open,
    "rapid mixed submission creates exactly one durable task visible on Today");

  app.navigate("#lists/shopping");
  const shoppingText = `Quick shopping ${crypto.randomUUID().slice(0, 6)}`;
  await add(shoppingText);
  check(count(shoppingText) === 1 && app.state.items.find((item) => item.text === shoppingText)?.classification === "shopping",
    "quick-add uses the current task-list destination and canonical defaults");

  app.navigate("#lists/todo");
  const retryText = `Retry quick add ${crypto.randomUUID().slice(0, 6)}`;
  const originalAppend = app.appendCommand;
  let attempts = 0;
  app.appendCommand = async function (command) {
    if (command.type === "add" && command.text === retryText && attempts++ === 0) throw new Error("forced local failure");
    return originalAppend.call(this, command);
  };
  await add(retryText);
  const failureState = { open: quick.dialog.open, value: quick.input.value, count: count(retryText), pending: quick.pending, error: quick.error.textContent };
  check(failureState.open && failureState.value === retryText && failureState.count === 0 && !failureState.pending,
    `a local save failure preserves the title and permits retry (${JSON.stringify(failureState)})`);
  quick.form.requestSubmit();
  await idle();
  app.appendCommand = originalAppend;
  check(count(retryText) === 1 && !quick.dialog.open, "failed submission retries safely exactly once");

  return "PASS universal quick-add focus, validation, IME, duplicate guard, routing, durability, and retry";
}
