// Hash-route resolution for the unlocked shell. Pure: no DOM, no history.
// Canonical routes are `page` or `page/segment`; legacy hashes alias onto them
// so bookmarks and in-app links from earlier releases keep working.

export const PRIMARY_DESTINATIONS = Object.freeze([
  Object.freeze({ id: "today", label: "Today" }),
  Object.freeze({ id: "lists", label: "Lists" }),
  Object.freeze({ id: "routines", label: "Routines" }),
  Object.freeze({ id: "updates", label: "Updates" }),
  Object.freeze({ id: "household", label: "Household" }),
]);

// Segments are presentation groupings over existing records; the first entry
// is the default when a page is requested without one.
export const SEGMENTS = Object.freeze({
  lists: Object.freeze([
    Object.freeze({ id: "todo", label: "To do", classification: "need" }),
    Object.freeze({ id: "shopping", label: "Shopping", classification: "shopping" }),
    Object.freeze({ id: "staples", label: "Staples", classification: "staple" }),
  ]),
  routines: Object.freeze([
    Object.freeze({ id: "all", label: "Routines" }),
    Object.freeze({ id: "checklists", label: "Reusable checklists" }),
  ]),
  updates: Object.freeze([
    Object.freeze({ id: "handoffs", label: "Handoffs" }),
    Object.freeze({ id: "talk", label: "Talk" }),
  ]),
  household: Object.freeze([
    Object.freeze({ id: "hub", label: "Household" }),
    Object.freeze({ id: "notes", label: "Notes & reference" }),
    Object.freeze({ id: "areas", label: "Areas & status" }),
    Object.freeze({ id: "people", label: "People & devices" }),
    Object.freeze({ id: "privacy", label: "Privacy & recovery" }),
  ]),
});

const PAGE_TITLES = Object.freeze({
  today: "Today",
  lists: "Lists",
  routines: "Routines",
  updates: "Updates",
  household: "Household",
  search: "Search",
});

// Legacy destinations and tabs from earlier releases.
const ALIASES = Object.freeze({
  handoff: "updates/handoffs",
  "handoff/handoffs": "updates/handoffs",
  "handoff/talk": "updates/talk",
  talk: "updates/talk",
  handoffs: "updates/handoffs",
  more: "household",
  "more/notes": "household/notes",
  "more/areas": "household/areas",
  "more/people": "household/people",
  "more/privacy": "household/privacy",
  "more/security": "household/privacy",
  "more/household": "household/people",
  needs: "lists/todo",
  "lists/needs": "lists/todo",
  "lists/need": "lists/todo",
  "lists/staple": "lists/staples",
  "household/security": "household/privacy",
  "household/household": "household/people",
  "routines/playbooks": "routines/checklists",
});

export function routeHash(page, segment = null) {
  const segments = SEGMENTS[page];
  if (!segments) return `#${page}`;
  const chosen = segments.find((entry) => entry.id === segment) ?? segments[0];
  // The hub and the first list are the page's default and stay short.
  if (chosen === segments[0] && (page === "household" || page === "routines")) return `#${page}`;
  return `#${page}/${chosen.id}`;
}

export function resolveRoute({ hash = "", pathname = "/" } = {}) {
  let requested = String(hash ?? "").replace(/^#/, "").replace(/\/+$/, "").toLowerCase();
  if (!requested && pathname === "/pair") requested = "household/people";
  requested = ALIASES[requested] ?? requested;
  const [pageCandidate, segmentCandidate] = requested.split("/");
  const page = PAGE_TITLES[pageCandidate] ? pageCandidate : "today";
  const segments = SEGMENTS[page] ?? null;
  const segment = segments
    ? (segments.find((entry) => entry.id === segmentCandidate) ?? segments[0]).id
    : null;
  const canonical = segments ? `${page}/${segment}` : page;
  // Search is reachable from every page; it marks no primary destination.
  const destination = page === "search" ? null : page;
  return { page, segment, canonical, destination, title: PAGE_TITLES[page], hash: segments ? routeHash(page, segment) : `#${page}` };
}

export function listSegmentForClassification(classification) {
  if (classification === "today") return "todo";
  return SEGMENTS.lists.find((entry) => entry.classification === classification)?.id ?? "todo";
}
