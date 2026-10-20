// Lists › Meals (#333): plan the week's dinners from the household's own
// recipes, choose who's cooking, and put a dinner's ingredients on Shopping.
//
// - The week is seven day rows, Monday to Sunday, each with its dinner (or
//   "Nothing planned"), who's cooking, and one Plan / Change button. A
//   container query lays the rows in two columns when the week has room
//   (tablets); on wide screens the recipes sit beside a single list.
// - Planning opens a native <dialog>: find a recipe (the filter is focused,
//   recent recipes first), or "Something else…", plus who's cooking. Nothing
//   needs dragging; wide screens also offer "Put on…" a day per recipe.
//   Closing returns focus to the day's button.
// - Recipes are saved whole from a name, "Ingredients (one per line)" and
//   notes. An ingredient that exactly matches an active Staple is linked to it
//   (and the editor says so); each line's Staple select changes the link.
// - Nothing is counted or compared: who cooked is never totalled.
//
// The element only renders and reports; `actions` (app/meals.js) does the
// writing: saveRecipe, archiveRecipe, setDinner, clearDinner, setCook and
// addIngredients, each resolving true when it saved.
import { cookLabel, cookOptions, filterRecipes, matchingStaple, mondayOf, recentRecipes, weekDays, weekLabel, addDays } from "../meals/meals-view.js";
import { MealFormatError, collapseText, ingredientsFromText, normalizeDinnerName, normalizeRecipe } from "../wasm/kin-meals.js";

let instances = 0;

class KinMeals extends HTMLElement {
  constructor() {
    super();
    this.idPrefix = `meals-${++instances}`;
    this.mealsValue = { recipes: [], dinners: [] };
    this.today = null;
    this.monday = null;
    this.peopleValue = { myId: null, memberIds: [], names: new Map() };
    this.staplesValue = [];
    this.actions = null;
    this.isDisabled = false;
    this.planning = null;
    this.editing = null;
  }

  connectedCallback() {
    if (!this.firstElementChild) this.build();
    this.render();
  }

  /** { recipes, dinners } from kin-meals.js decodeMeals. */
  set meals(value) {
    this.mealsValue = value ?? { recipes: [], dinners: [] };
    this.render();
  }

  get meals() {
    return this.mealsValue;
  }

  /** The household's civil date today ("YYYY-MM-DD"). */
  set date(value) {
    // Showing the current week follows the date across midnight; a week the
    // person moved to stays put.
    const following = !this.monday || (this.today && this.monday === mondayOf(this.today));
    this.today = value;
    if (value && following) this.monday = mondayOf(value);
    this.render();
  }

  /** { myId, memberIds, names } for who's cooking (meals-view.js). */
  set people(value) {
    this.peopleValue = value ?? { myId: null, memberIds: [], names: new Map() };
    this.render();
  }

  get people() {
    return this.peopleValue;
  }

  /** Staple items ({ itemId, text, status }) for linking ingredients. */
  set staples(value) {
    this.staplesValue = value ?? [];
    if (this.editing) this.renderStaples(this.current());
  }

  get staples() {
    return this.staplesValue;
  }

  set disabled(value) {
    this.isDisabled = Boolean(value);
    this.render();
  }

  build() {
    const id = this.idPrefix;
    this.className = "meals";
    const layout = document.createElement("div");
    layout.className = "meals-layout";

    // The week.
    const week = document.createElement("section");
    week.className = "meals-week";
    week.setAttribute("aria-labelledby", `${id}-week-heading`);
    const head = document.createElement("div");
    head.className = "meals-week-head";
    this.weekHeading = document.createElement("h2");
    this.weekHeading.id = `${id}-week-heading`;
    this.weekHeading.tabIndex = -1;
    const nav = document.createElement("div");
    nav.className = "meals-week-nav";
    const navButton = (label, step) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        this.monday = step === 0 ? mondayOf(this.today) : addDays(this.monday, step * 7);
        this.render();
        this.weekHeading.focus();
      });
      nav.append(button);
      return button;
    };
    this.previousWeek = navButton("Previous week", -1);
    this.thisWeek = navButton("This week", 0);
    this.nextWeek = navButton("Next week", 1);
    head.append(this.weekHeading, nav);
    this.days = document.createElement("ol");
    this.days.className = "meal-days";
    week.append(head, this.days);

    // Recipes.
    const recipes = document.createElement("section");
    recipes.className = "meals-recipes";
    recipes.setAttribute("aria-labelledby", `${id}-recipes-heading`);
    const recipesHead = document.createElement("div");
    recipesHead.className = "meals-recipes-head";
    const recipesHeading = document.createElement("h2");
    recipesHeading.id = `${id}-recipes-heading`;
    recipesHeading.textContent = "Recipes";
    this.addRecipe = document.createElement("button");
    this.addRecipe.type = "button";
    this.addRecipe.className = "add-button";
    this.addRecipe.textContent = "Add a recipe";
    this.addRecipe.addEventListener("click", () => this.openRecipe(null, this.addRecipe));
    recipesHead.append(recipesHeading, this.addRecipe);
    this.emptyRecipes = document.createElement("p");
    this.emptyRecipes.className = "section-hint meals-empty";
    this.emptyRecipes.textContent = "Save a meal once and reuse it any week.";
    this.recipeList = document.createElement("ul");
    this.recipeList.className = "recipe-list";
    recipes.append(recipesHead, this.emptyRecipes, this.recipeList);

    // What the last "Add ingredients" did, with a way to Shopping. The app's
    // status line announces it; this stays put so it can be read again.
    this.result = document.createElement("p");
    this.result.className = "meals-result";
    this.result.hidden = true;

    layout.append(week, recipes);
    this.append(this.result, layout, this.buildPlanDialog(), this.buildRecipeDialog());
  }

  /** Shows what adding ingredients did, linking to Shopping. */
  showResult(message, href) {
    if (!this.result) return;
    const link = document.createElement("a");
    link.href = href;
    link.textContent = "Open Shopping";
    this.result.replaceChildren(`${message} `, link);
    this.result.hidden = false;
  }

  // ---- The week ------------------------------------------------------------

  dinnerOn(date) {
    return this.mealsValue.dinners.find((dinner) => dinner.date === date) ?? null;
  }

  // ---- Focus across re-renders ------------------------------------------
  // A refresh (another tab, sync, the minute timer) rebuilds rows, and the
  // busy guard disables every control; either would drop keyboard focus.
  // Controls are found again by what they are, not by node.

  /** A stable key for a control in this view, or null. */
  focusKey(node) {
    if (!node || !this.contains(node)) return null;
    if (node.id) return `#${node.id}`;
    const day = node.closest(".meal-day");
    if (day) return `day|${day.dataset.date}|${node.className}`;
    const recipe = node.closest(".recipe");
    if (recipe) return `recipe|${recipe.dataset.recipeId}|${[...recipe.querySelectorAll("button, select")].indexOf(node)}`;
    const planned = node.closest(".meal-plan-recipes li");
    if (planned) return `plan|${node.dataset.recipeId}`;
    return null;
  }

  findByKey(key) {
    if (!key) return null;
    if (key.startsWith("#")) return this.querySelector(key);
    const [kind, id, detail] = key.split("|");
    if (kind === "day") return this.querySelector(`.meal-day[data-date="${id}"] [class="${detail}"]`) ?? this.querySelector(`.meal-day[data-date="${id}"] .meal-plan`);
    if (kind === "recipe") return this.querySelector(`.recipe[data-recipe-id="${id}"]`)?.querySelectorAll("button, select")[Number(detail)] ?? null;
    if (kind === "plan") return this.querySelector(`.meal-plan-recipes button[data-recipe-id="${id}"]`);
    return null;
  }

  /** Puts focus back on `key`'s control when focus was lost. */
  restoreFocus(key) {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    const target = this.findByKey(key);
    if (lost && target && !target.disabled) target.focus();
  }

  /** Called by the app before it disables controls for a save. */
  deferFocusedControl() {
    this.deferredFocus = this.focusKey(document.activeElement) ?? this.deferredFocus ?? null;
  }

  /** Called once controls are enabled again. */
  settleDeferredFocus() {
    const key = this.deferredFocus;
    this.deferredFocus = null;
    this.restoreFocus(key);
  }

  render() {
    if (!this.firstElementChild || !this.today) return;
    const focused = this.focusKey(document.activeElement);
    // "Put on" days chosen but not yet put survive the rebuild.
    const chosen = new Map([...this.querySelectorAll(".recipe")].map((item) => [item.dataset.recipeId, item.querySelector(".recipe-put-on select")?.value ?? ""]));
    const days = weekDays(this.monday ?? mondayOf(this.today));
    const current = mondayOf(this.today) === days[0].date;
    this.weekHeading.textContent = current ? `This week · ${weekLabel(days[0].date)}` : `Week of ${weekLabel(days[0].date)}`;
    this.thisWeek.hidden = current;
    for (const button of [this.previousWeek, this.thisWeek, this.nextWeek]) button.disabled = this.isDisabled;
    const rows = days.map((day) => this.dayRow(day));
    this.days.replaceChildren(...rows);
    this.renderRecipes(days);
    this.addRecipe.disabled = this.isDisabled;
    for (const [recipeId, date] of chosen) {
      const select = this.querySelector(`.recipe[data-recipe-id="${recipeId}"] .recipe-put-on select`);
      if (select && date && [...select.options].some((option) => option.value === date)) select.value = date;
    }
    if (this.planning) this.renderPlan();
    this.restoreFocus(focused);
  }

  dayRow(day) {
    const dinner = this.dinnerOn(day.date);
    const row = document.createElement("li");
    row.className = "meal-day";
    row.dataset.date = day.date;
    if (day.date === this.today) row.classList.add("is-today");
    const name = document.createElement("h3");
    name.className = "meal-day-name";
    name.textContent = day.label;
    if (day.date === this.today) {
      const badge = document.createElement("span");
      badge.className = "meal-today";
      badge.textContent = "Tonight";
      name.append(" ", badge);
    }
    const what = document.createElement("p");
    what.className = dinner ? "meal-dinner" : "meal-dinner is-empty";
    what.textContent = dinner?.name ?? "Nothing planned";
    row.append(name, what);
    if (dinner) {
      const cook = document.createElement("p");
      cook.className = "meal-cook";
      cook.textContent = `Cooking: ${cookLabel(dinner.cookId, this.people)}`;
      row.append(cook);
    }
    const actions = document.createElement("div");
    actions.className = "meal-day-actions";
    const plan = document.createElement("button");
    plan.type = "button";
    plan.className = "meal-plan";
    plan.textContent = dinner ? "Change" : "Plan";
    plan.setAttribute("aria-label", `${dinner ? "Change" : "Plan"} dinner for ${day.longLabel}`);
    plan.disabled = this.isDisabled;
    plan.addEventListener("click", () => this.openPlan(day, plan));
    actions.append(plan);
    if (dinner?.recipeId && this.mealsValue.recipes.some((recipe) => recipe.recipeId === dinner.recipeId)) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "meal-ingredients";
      add.textContent = "Add ingredients to Shopping";
      add.setAttribute("aria-label", `Add ingredients for ${dinner.name} on ${day.longLabel} to Shopping`);
      add.disabled = this.isDisabled;
      add.addEventListener("click", () => void this.actions?.addIngredients({ date: day.date }, dinner.name));
      actions.append(add);
    }
    row.append(actions);
    return row;
  }

  renderRecipes(days) {
    const recipes = [...this.mealsValue.recipes].sort((left, right) => left.name.localeCompare(right.name));
    this.emptyRecipes.hidden = recipes.length > 0;
    this.recipeList.replaceChildren(...recipes.map((recipe) => {
      const item = document.createElement("li");
      item.className = "recipe";
      item.dataset.recipeId = recipe.recipeId;
      const name = document.createElement("p");
      name.className = "recipe-name";
      name.textContent = recipe.name;
      const meta = document.createElement("p");
      meta.className = "recipe-meta item-meta";
      meta.textContent = recipe.ingredients.length === 1 ? "1 ingredient" : `${recipe.ingredients.length} ingredients`;
      const actions = document.createElement("div");
      actions.className = "recipe-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.setAttribute("aria-label", `Edit ${recipe.name}`);
      edit.disabled = this.isDisabled;
      edit.addEventListener("click", () => this.openRecipe(recipe, edit));
      actions.append(edit);
      if (recipe.ingredients.length) {
        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "Add ingredients to Shopping";
        add.setAttribute("aria-label", `Add ingredients for ${recipe.name} to Shopping`);
        add.disabled = this.isDisabled;
        add.addEventListener("click", () => void this.actions?.addIngredients({ recipeId: recipe.recipeId }, recipe.name));
        actions.append(add);
      }
      // Wide screens: put it on a day of the week shown, without a dialog.
      const putOn = document.createElement("label");
      putOn.className = "recipe-put-on";
      putOn.textContent = "Put on ";
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Put ${recipe.name} on a day`);
      select.disabled = this.isDisabled;
      const choose = document.createElement("option");
      choose.value = "";
      choose.textContent = "Choose a day";
      select.append(choose, ...days.map((day) => {
        const option = document.createElement("option");
        option.value = day.date;
        option.textContent = day.longLabel;
        return option;
      }));
      const put = document.createElement("button");
      put.type = "button";
      put.textContent = "Put";
      put.disabled = this.isDisabled;
      put.addEventListener("click", async () => {
        if (!select.value) { select.focus(); return; }
        const date = select.value;
        const current = this.dinnerOn(date);
        if ((current?.recipeId === recipe.recipeId && current.name === recipe.name) ||
          await this.actions?.setDinner({ date, recipeId: recipe.recipeId, name: recipe.name }))
          this.querySelector(`.meal-day[data-date="${date}"] .meal-plan`)?.focus();
      });
      putOn.append(select, put);
      actions.append(putOn);
      item.append(name, meta, actions);
      return item;
    }));
  }

  // ---- Planning a day ------------------------------------------------------

  buildPlanDialog() {
    const id = this.idPrefix;
    const dialog = document.createElement("dialog");
    dialog.className = "meal-dialog meal-plan-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-plan-title`);
    this.planTitle = document.createElement("h2");
    this.planTitle.id = `${id}-plan-title`;
    const findLabel = document.createElement("label");
    findLabel.htmlFor = `${id}-plan-find`;
    findLabel.textContent = "Find a recipe";
    this.planFind = document.createElement("input");
    this.planFind.type = "search";
    this.planFind.id = `${id}-plan-find`;
    this.planFind.autocomplete = "off";
    this.planFind.addEventListener("input", () => this.renderPlan());
    this.planRecipesHint = document.createElement("p");
    this.planRecipesHint.className = "section-hint";
    this.planRecipes = document.createElement("ul");
    this.planRecipes.className = "meal-plan-recipes";
    const otherLabel = document.createElement("label");
    otherLabel.htmlFor = `${id}-plan-other`;
    otherLabel.textContent = "Something else…";
    const otherRow = document.createElement("div");
    otherRow.className = "meal-plan-other";
    this.planOther = document.createElement("input");
    this.planOther.id = `${id}-plan-other`;
    this.planOther.placeholder = "For example: Leftovers";
    this.planOtherError = document.createElement("small");
    this.planOtherError.id = `${id}-plan-other-error`;
    this.planOtherError.setAttribute("role", "alert");
    this.planOtherError.hidden = true;
    this.planOther.setAttribute("aria-describedby", this.planOtherError.id);
    const useOther = document.createElement("button");
    useOther.type = "button";
    useOther.textContent = "Use this";
    useOther.addEventListener("click", () => void this.planSomethingElse());
    this.planOther.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void this.planSomethingElse(); }
    });
    otherRow.append(this.planOther, useOther);
    const cookLabelElement = document.createElement("label");
    cookLabelElement.htmlFor = `${id}-plan-cook`;
    cookLabelElement.textContent = "Who's cooking";
    this.planCook = document.createElement("select");
    this.planCook.id = `${id}-plan-cook`;
    this.planCook.addEventListener("change", () => void this.changeCook());
    this.planCookHint = document.createElement("small");
    this.planCookHint.className = "section-hint";
    this.planCookHint.textContent = "Plan a dinner first, then choose who's cooking.";
    const actions = document.createElement("div");
    actions.className = "meal-dialog-actions";
    this.planClear = document.createElement("button");
    this.planClear.type = "button";
    this.planClear.textContent = "Clear this dinner";
    this.planClear.addEventListener("click", () => void this.clearPlanned());
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Done";
    close.addEventListener("click", () => dialog.close());
    actions.append(this.planClear, close);
    dialog.append(this.planTitle, findLabel, this.planFind, this.planRecipesHint, this.planRecipes, otherLabel, otherRow, this.planOtherError, cookLabelElement, this.planCook, this.planCookHint, actions);
    dialog.addEventListener("close", () => {
      const opener = this.planning?.opener;
      const date = this.planning?.day.date;
      this.planning = null;
      const target = this.querySelector(`.meal-day[data-date="${date}"] .meal-plan`) ?? opener;
      if (target?.isConnected) target.focus();
    });
    this.planDialog = dialog;
    return dialog;
  }

  openPlan(day, opener) {
    this.planning = { day, opener };
    this.planFind.value = "";
    this.planOther.value = this.dinnerOn(day.date)?.recipeId ? "" : this.dinnerOn(day.date)?.name ?? "";
    this.planOtherError.hidden = true;
    this.renderPlan();
    this.planDialog.showModal?.();
    if (!this.planDialog.open) this.planDialog.setAttribute("open", "");
    this.planFind.focus();
  }

  renderPlan() {
    const focused = this.focusKey(document.activeElement);
    const { day } = this.planning;
    const dinner = this.dinnerOn(day.date);
    this.planTitle.textContent = `Dinner for ${day.longLabel}`;
    const query = this.planFind.value;
    const recipes = query.trim() ? filterRecipes(this.mealsValue.recipes, query) : recentRecipes(this.mealsValue, 8);
    this.planRecipesHint.textContent = !this.mealsValue.recipes.length
      ? "No recipes yet. Use Something else, or add a recipe from the Recipes list."
      : query.trim()
        ? (recipes.length ? "" : "No recipe matches. Use Something else instead.")
        : "Recent recipes";
    this.planRecipesHint.hidden = !this.planRecipesHint.textContent;
    this.planRecipes.replaceChildren(...recipes.map((recipe) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = recipe.name;
      button.dataset.recipeId = recipe.recipeId;
      if (dinner?.recipeId === recipe.recipeId) {
        button.setAttribute("aria-pressed", "true");
        button.setAttribute("aria-label", `${recipe.name} (planned)`);
      }
      button.disabled = this.isDisabled;
      button.addEventListener("click", async () => {
        // Already planned: nothing to save, just move on to the cook.
        const current = this.dinnerOn(day.date);
        if (current?.recipeId === recipe.recipeId && current.name === recipe.name) { this.planCook.focus(); return; }
        if (await this.actions?.setDinner({ date: day.date, recipeId: recipe.recipeId, name: recipe.name })) this.planCook.focus();
      });
      item.append(button);
      return item;
    }));
    const options = cookOptions(this.people);
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No one yet";
    const current = dinner?.cookId ?? "";
    const list = [none, ...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.id;
      element.textContent = option.label;
      return element;
    })];
    if (current && !options.some((option) => option.id === current)) {
      const former = document.createElement("option");
      former.value = current;
      former.textContent = "A former household member";
      list.push(former);
    }
    this.planCook.replaceChildren(...list);
    this.planCook.value = current;
    this.planCook.disabled = this.isDisabled || !dinner;
    this.planCookHint.hidden = Boolean(dinner);
    this.planClear.hidden = !dinner;
    this.planClear.disabled = this.isDisabled;
    this.restoreFocus(focused);
  }

  async planSomethingElse() {
    const name = this.planOther.value;
    const date = this.planning?.day.date;
    if (!date) return;
    this.planOtherError.hidden = true;
    try {
      // Checked here first so the message sits beside the field at once.
      const text = normalizeDinnerName(name);
      const current = this.dinnerOn(date);
      if (current && !current.recipeId && current.name === text) { this.planCook.focus(); return; }
      if (await this.actions?.setDinner({ date, recipeId: null, name })) this.planCook.focus();
    } catch (error) {
      if (!(error instanceof MealFormatError)) throw error;
      this.planOtherError.textContent = error.message;
      this.planOtherError.hidden = false;
      this.planOther.focus();
    }
  }

  async changeCook() {
    const date = this.planning?.day.date;
    if (!date) return;
    await this.actions?.setCook(date, this.planCook.value || null);
  }

  async clearPlanned() {
    const date = this.planning?.day.date;
    if (date && await this.actions?.clearDinner(date)) this.planDialog.close();
  }

  // ---- Recipes ------------------------------------------------------------

  buildRecipeDialog() {
    const id = this.idPrefix;
    const dialog = document.createElement("dialog");
    dialog.className = "meal-dialog recipe-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-recipe-title`);
    this.recipeTitle = document.createElement("h2");
    this.recipeTitle.id = `${id}-recipe-title`;
    const form = document.createElement("form");
    form.className = "compose-form recipe-form";
    form.noValidate = true;
    const field = (label, control, hint = null) => {
      const element = document.createElement("label");
      element.htmlFor = control.id;
      element.textContent = label;
      const error = document.createElement("small");
      error.id = `${control.id}-error`;
      error.setAttribute("role", "alert");
      error.hidden = true;
      control.setAttribute("aria-describedby", [hint?.id, error.id].filter(Boolean).join(" "));
      form.append(element, ...(hint ? [hint] : []), control, error);
      return error;
    };
    this.recipeName = document.createElement("input");
    this.recipeName.id = `${id}-recipe-name`;
    this.recipeName.placeholder = "For example: Taco night";
    this.recipeNameError = field("Recipe name", this.recipeName);
    this.recipeIngredients = document.createElement("textarea");
    this.recipeIngredients.id = `${id}-recipe-ingredients`;
    this.recipeIngredients.rows = 6;
    this.recipeIngredients.placeholder = "One ingredient per line";
    this.recipeIngredientsError = field("Ingredients (one per line)", this.recipeIngredients);
    this.recipeNotes = document.createElement("textarea");
    this.recipeNotes.id = `${id}-recipe-notes`;
    this.recipeNotes.rows = 3;
    const notesHint = document.createElement("small");
    notesHint.id = `${id}-recipe-notes-hint`;
    notesHint.className = "section-hint";
    notesHint.textContent = "Optional: steps, a link, who likes it.";
    this.recipeNotesError = field("Notes", this.recipeNotes, notesHint);
    // Each saved ingredient's Staple link.
    this.stapleLinks = document.createElement("fieldset");
    this.stapleLinks.className = "recipe-staples";
    const legend = document.createElement("legend");
    legend.textContent = "Staples";
    this.stapleHint = document.createElement("p");
    this.stapleHint.className = "section-hint";
    this.stapleHint.textContent = "Linked ingredients add the Staple itself to Shopping.";
    this.stapleRows = document.createElement("ul");
    this.stapleRows.className = "recipe-staple-rows";
    this.stapleLinks.append(legend, this.stapleHint, this.stapleRows);
    const actions = document.createElement("div");
    actions.className = "meal-dialog-actions";
    this.recipeSave = document.createElement("button");
    this.recipeSave.type = "submit";
    this.recipeSave.className = "add-button";
    this.recipeArchive = document.createElement("button");
    this.recipeArchive.type = "button";
    this.recipeArchive.textContent = "Archive recipe";
    this.recipeArchive.addEventListener("click", () => void this.archiveEditing());
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Close";
    cancel.addEventListener("click", () => dialog.close());
    actions.append(this.recipeSave, this.recipeArchive, cancel);
    form.append(this.stapleLinks, actions);
    form.addEventListener("submit", (event) => { event.preventDefault(); void this.saveEditing(); });
    dialog.append(this.recipeTitle, form);
    dialog.addEventListener("close", () => {
      const opener = this.editing?.opener;
      const recipeId = this.editing?.recipeId;
      this.editing = null;
      const target = recipeId ? this.querySelector(`.recipe[data-recipe-id="${recipeId}"] button`) : null;
      (target?.isConnected ? target : opener?.isConnected ? opener : this.addRecipe).focus();
    });
    this.recipeDialog = dialog;
    return dialog;
  }

  openRecipe(recipe, opener) {
    this.editing = { recipeId: recipe?.recipeId ?? null, opener };
    this.recipeTitle.textContent = recipe ? `Edit ${recipe.name}` : "New recipe";
    this.recipeName.value = recipe?.name ?? "";
    this.recipeIngredients.value = recipe?.ingredients.map((line) => line.text).join("\n") ?? "";
    this.recipeNotes.value = recipe?.notes ?? "";
    for (const error of [this.recipeNameError, this.recipeIngredientsError, this.recipeNotesError]) error.hidden = true;
    this.recipeSave.textContent = recipe ? "Save changes" : "Save recipe";
    this.recipeArchive.hidden = !recipe;
    this.renderStaples(recipe);
    this.recipeDialog.showModal?.();
    if (!this.recipeDialog.open) this.recipeDialog.setAttribute("open", "");
    this.recipeName.focus();
  }

  /** The saved ingredients' Staple selects. */
  renderStaples(recipe) {
    this.stapleLinks.hidden = !recipe?.ingredients.length;
    if (!recipe) return;
    const active = this.staples.filter((item) => item.status !== "archived");
    this.stapleRows.replaceChildren(...recipe.ingredients.map((line, index) => {
      const row = document.createElement("li");
      const label = document.createElement("label");
      const selectId = `${this.idPrefix}-staple-${index}`;
      label.htmlFor = selectId;
      label.textContent = line.text;
      const select = document.createElement("select");
      select.id = selectId;
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "None";
      select.append(none, ...active.map((item) => {
        const option = document.createElement("option");
        option.value = item.itemId;
        option.textContent = item.text;
        return option;
      }));
      const note = document.createElement("small");
      note.className = "recipe-staple-note";
      note.id = `${selectId}-note`;
      select.setAttribute("aria-describedby", note.id);
      if (line.staple === "archived") {
        // Kept, never silently dropped: it adds as a new item now.
        const archived = document.createElement("option");
        archived.value = line.stapleId;
        archived.textContent = "Staple no longer listed — will be added as a new item";
        select.append(archived);
        note.textContent = "That Staple is no longer listed, so this is added as a new item.";
      } else if (line.stapleId && line.staple === "active") {
        const staple = active.find((item) => item.itemId === line.stapleId);
        if (staple && collapseKey(staple.text) === collapseKey(line.text)) note.textContent = `Matched to Staple “${staple.text}”.`;
      }
      select.value = line.stapleId ?? "";
      select.disabled = this.isDisabled;
      select.addEventListener("change", () => void this.relink(index, select.value || null));
      row.append(label, select, note);
      return row;
    }));
  }

  current() {
    return this.mealsValue.recipes.find((recipe) => recipe.recipeId === this.editing?.recipeId) ?? null;
  }

  async relink(index, stapleId) {
    const recipe = this.current();
    if (!recipe) return;
    const ingredients = recipe.ingredients.map((line, at) => ({ text: line.text, stapleId: at === index ? stapleId : line.stapleId }));
    await this.actions?.saveRecipe({ recipeId: recipe.recipeId, name: recipe.name, ingredients, notes: recipe.notes }, { quiet: true });
    this.renderStaples(this.current());
    this.querySelector(`#${this.idPrefix}-staple-${index}`)?.focus();
  }

  async saveEditing() {
    const editing = this.editing;
    if (!editing) return;
    for (const error of [this.recipeNameError, this.recipeIngredientsError, this.recipeNotesError]) error.hidden = true;
    const previous = this.current();
    let recipe;
    try {
      const ingredients = ingredientsFromText(this.recipeIngredients.value, previous?.ingredients ?? []);
      // An exact match to an active Staple is linked; Kin says so in the
      // Staples list, and one tap there changes it.
      // Only lines that are new or changed: a link the person removed stays
      // removed when the recipe is saved again.
      const known = new Set((previous?.ingredients ?? []).map((line) => line.text));
      for (const line of ingredients) {
        if (line.stapleId || known.has(line.text)) continue;
        line.stapleId = matchingStaple(line.text, this.staples)?.itemId ?? null;
      }
      recipe = normalizeRecipe({ name: this.recipeName.value, ingredients, notes: this.recipeNotes.value });
    } catch (error) {
      if (!(error instanceof MealFormatError)) throw error;
      const [target, message] = /name/i.test(error.message) && !error.detail
        ? [this.recipeNameError, this.recipeName]
        : /^Notes/.test(error.message)
          ? [this.recipeNotesError, this.recipeNotes]
          : [this.recipeIngredientsError, this.recipeIngredients];
      target.textContent = error.message;
      target.hidden = false;
      message.focus();
      return;
    }
    const recipeId = await this.actions?.saveRecipe({ recipeId: editing.recipeId, ...recipe });
    if (!recipeId || this.editing !== editing) return;
    // Stay open on the saved recipe, now with its Staple links to check.
    editing.recipeId = recipeId;
    const saved = this.current();
    this.recipeTitle.textContent = `Edit ${saved?.name ?? recipe.name}`;
    this.recipeSave.textContent = "Save changes";
    this.recipeArchive.hidden = false;
    this.renderStaples(saved);
    this.recipeSave.focus();
  }

  async archiveEditing() {
    const recipe = this.current();
    if (!recipe || !confirm(`Archive “${recipe.name}”? Dinners already planned keep its name.`)) return;
    if (await this.actions?.archiveRecipe(recipe.recipeId)) this.recipeDialog.close();
  }
}

const collapseKey = (text) => collapseText(text).toLowerCase();

customElements.define("kin-meals", KinMeals);
