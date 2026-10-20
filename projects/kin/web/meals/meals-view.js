// Meals without the DOM (#333): the week a day belongs to, the people who
// can cook, a staple that matches an ingredient, recent recipes and tonight's
// line. Dates are "YYYY-MM-DD" civil dates throughout; arithmetic is done in
// UTC so a daylight-saving change never moves a day.
import { collapseText } from "../wasm/kin-meals.js";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const toUtc = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  return value;
};
const fromUtc = (value) => `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;

/** The date `days` after `date` (negative goes back). */
export const addDays = (date, days) => fromUtc(new Date(toUtc(date).getTime() + days * DAY_MS));

/** Monday of the week `date` falls in (weeks start on Monday, like weekly
 * routines). */
export function mondayOf(date) {
  const weekday = (toUtc(date).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

/** The seven days of the week starting `monday`, each with its labels. */
export function weekDays(monday) {
  return WEEKDAYS.map((name, index) => {
    const date = addDays(monday, index);
    const value = toUtc(date);
    return {
      date,
      weekday: name,
      label: `${SHORT_WEEKDAYS[index]} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`,
      longLabel: `${name} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`,
    };
  });
}

/** "5–11 Oct" or "29 Sep – 5 Oct" for a week. */
export function weekLabel(monday) {
  const start = toUtc(monday), end = toUtc(addDays(monday, 6));
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}`
    : `${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]}`;
}

/**
 * Who can be the cook: "You" first, then the household's other current
 * members by preferred name (v1.3), else "Household member N" in a stable
 * order. Anyone may cook, Limited and Temporary members included; nothing is
 * counted or ranked.
 */
export function cookOptions({ myId = null, memberIds = [], names = new Map() } = {}) {
  const others = [...new Set(memberIds)].filter((id) => id && id !== myId).sort();
  const options = myId ? [{ id: myId, label: "You" }] : [];
  others.forEach((id, index) => options.push({ id, label: names.get(id) ?? `Household member ${index + 1}` }));
  return options;
}

/** The cook's label for a day, "You", a name, or "No one yet". */
export function cookLabel(cookId, people) {
  if (!cookId) return "No one yet";
  return cookOptions(people).find((option) => option.id === cookId)?.label ?? "A former household member";
}

/** "Tacos · You're cooking", "Tacos · Sam's cooking" or "Tacos". */
export function tonightLine(dinner, people) {
  if (!dinner) return null;
  if (!dinner.cookId) return dinner.name;
  const label = cookLabel(dinner.cookId, people);
  return label === "You" ? `${dinner.name} · You're cooking` : `${dinner.name} · ${label} is cooking`;
}

/** The active staple whose text matches an ingredient exactly (collapsed and
 * lowercased), so Kin can suggest it and say so; otherwise null. */
export function matchingStaple(text, staples) {
  const key = collapseText(text).toLowerCase();
  return staples.find((item) => item.status !== "archived" && collapseText(item.text).toLowerCase() === key) ?? null;
}

/** Recipes most recently planned first (by the latest date they were planned
 * for), then the rest by name, for the plan dialog. */
export function recentRecipes(meals, limit = 5) {
  const lastPlanned = new Map();
  for (const dinner of meals.dinners) if (dinner.recipeId) lastPlanned.set(dinner.recipeId, dinner.date);
  return [...meals.recipes]
    .sort((left, right) => (lastPlanned.get(right.recipeId) ?? "").localeCompare(lastPlanned.get(left.recipeId) ?? "") || left.name.localeCompare(right.name))
    .slice(0, limit);
}

/** Recipes whose name contains every word of `query` (case-insensitive). */
export function filterRecipes(recipes, query) {
  const words = collapseText(query).toLowerCase().split(" ").filter(Boolean);
  if (!words.length) return [...recipes].sort((left, right) => left.name.localeCompare(right.name));
  return recipes.filter((recipe) => words.every((word) => recipe.name.toLowerCase().includes(word)))
    .sort((left, right) => left.name.localeCompare(right.name));
}
