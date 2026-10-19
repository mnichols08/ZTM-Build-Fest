// A short, dismissible first-use welcome for Today (#261, #263). It explains
// Kin in everyday language and offers one useful first action. It shows only
// while the household has nothing on Today's lists yet and this device has
// not dismissed it, so an experienced member never sees it again, and it
// never creates sample items or household events. The dismissal is a
// device-local preference (like the auto-lock choice), not household data.

export const WELCOME_DISMISSED_KEY = "kin.welcome.dismissed";

/** Whether this device dismissed the welcome. Storage can be unavailable
 * (private windows, blocked site data); then the welcome simply shows until
 * the first item exists. */
export function readWelcomeDismissed(storage = globalThis.localStorage) {
  try { return storage?.getItem(WELCOME_DISMISSED_KEY) === "1"; } catch { return false; }
}

export function writeWelcomeDismissed(storage = globalThis.localStorage) {
  try { storage?.setItem(WELCOME_DISMISSED_KEY, "1"); } catch { /* Preference only. */ }
}

/** The welcome belongs to a household with nothing to show yet. Once there is
 * anything (an item, a routine), the household is in use and it stays away. */
export function welcomeVisible({ hasItems = false, hasRoutines = false, dismissed = false } = {}) {
  return !hasItems && !hasRoutines && !dismissed;
}

/** The welcome card: what Kin is for, who sees it, and one first action.
 * `onStart` opens the existing capture; `onDismiss` hides it for good here. */
export function createWelcome({ onStart, onDismiss, disabled = false } = {}) {
  const section = document.createElement("section");
  section.className = "today-welcome";
  section.dataset.section = "welcome";
  section.setAttribute("aria-labelledby", "today-welcome-title");
  const heading = document.createElement("h2");
  heading.id = "today-welcome-title";
  heading.textContent = "Welcome home";
  const intro = document.createElement("p");
  intro.textContent = "Kin is your household's shared place for what needs doing, what to buy, and what everyone should know. It stays private to your household.";
  const list = document.createElement("ul");
  list.className = "today-welcome-points";
  for (const point of [
    "To do: things someone needs to handle, today or later.",
    "Shopping: things to buy, for whoever goes next.",
    "Updates: notes and handoffs, so nothing gets missed.",
  ]) {
    const item = document.createElement("li");
    item.textContent = point;
    list.append(item);
  }
  const actions = document.createElement("div");
  actions.className = "today-welcome-actions";
  const start = document.createElement("button");
  start.type = "button";
  start.className = "primary-action";
  start.textContent = "Add your first item";
  start.dataset.action = "welcome-start";
  start.disabled = disabled;
  start.addEventListener("click", () => onStart?.(start));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "secondary";
  dismiss.textContent = "Got it";
  dismiss.setAttribute("aria-label", "Got it, hide this welcome");
  dismiss.dataset.action = "welcome-dismiss";
  dismiss.addEventListener("click", () => onDismiss?.());
  actions.append(start, dismiss);
  section.append(heading, intro, list, actions);
  return section;
}
