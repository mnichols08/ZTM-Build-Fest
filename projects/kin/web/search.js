export const MAX_SEARCH_RESULTS = 100;

const CLASSIFICATION_LABELS = {
  today: "Today",
  need: "Needs",
  shopping: "Shopping",
  staple: "Staples",
};

const matches = (value, query) =>
  typeof value === "string" && value.toLowerCase().includes(query);

export function searchHouseholdRecords({
  items = [],
  handoffs = [],
  talks = [],
  notes = [],
  referenceRecords = [],
  maintenanceEvents = [],
  areas = [],
  query = "",
  classification = "",
  status = "",
  areaId = "",
} = {}) {
  const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  const results = [];
  let totalCount = 0;
  if (!normalizedQuery) return { results, totalCount };

  const areaName = (id) => areas.find((area) => area.areaId === id)?.name;
  const addResult = (result) => {
    totalCount += 1;
    if (results.length < MAX_SEARCH_RESULTS) results.push(result);
  };

  for (const item of items) {
    if (
      item.status === "archived" ||
      (classification && item.classification !== classification) ||
      (status && item.status !== status) ||
      (areaId === "unassigned" && item.areaId) ||
      (areaId && areaId !== "unassigned" && item.areaId !== areaId)
    ) continue;

    const classificationLabel = CLASSIFICATION_LABELS[item.classification] ?? "Item";
    const area = item.areaId ? areaName(item.areaId) : null;
    const context = [
      classificationLabel,
      item.status === "completed" ? "Completed" : "Active",
      area ? `${area}${areas.find((entry) => entry.areaId === item.areaId)?.archived ? " (archived Area)" : ""}` : null,
    ].filter(Boolean).join(" · ");

    if (matches(item.text, normalizedQuery)) {
      addResult({
        kind: "Item",
        id: item.itemId,
        text: item.text,
        detail: "",
        context,
      });
    }

    for (const step of item.steps ?? []) {
      if (step.archived || !matches(step.text, normalizedQuery)) continue;
      addResult({
        kind: "Checklist Step",
        id: `${item.itemId}:${step.stepId}`,
        text: step.text,
        detail: `Item: ${item.text}`,
        context,
      });
    }
  }

  for (const handoff of handoffs) {
    if (handoff.status === "archived" || !matches(handoff.text, normalizedQuery)) continue;
    addResult({
      kind: "Handoff",
      id: handoff.handoffId,
      text: handoff.text,
      detail: "",
      context: handoff.status === "acknowledged" ? "Acknowledged" : "Needs attention",
    });
  }

  for (const talk of talks) {
    if (talk.status === "archived" || !matches(talk.text, normalizedQuery)) continue;
    addResult({
      kind: "Talk",
      id: talk.talkId,
      text: talk.text,
      detail: "",
      context: talk.status === "resolved" ? "Resolved" : "Open",
    });
  }

  for (const note of notes) {
    if (
      note.archived ||
      (!matches(note.title, normalizedQuery) && !matches(note.body, normalizedQuery))
    ) continue;
    addResult({
      kind: "Note",
      id: note.noteId,
      text: note.title,
      detail: note.body,
      context: note.areaId ? areaName(note.areaId) ?? "Archived Area" : "",
    });
  }

  const activeReferences = referenceRecords.filter((record) => !record.archived);
  for (const record of activeReferences) {
    const detail = record.fields.map((field) => `${field.label}: ${field.value}`).join(" · ");
    if (!matches(record.title, normalizedQuery) && !record.fields.some((field) => matches(field.label, normalizedQuery) || matches(field.value, normalizedQuery))) continue;
    addResult({ kind: "Reference Record", id: record.recordId, text: record.title, detail, context: "Household reference" });
  }
  for (const event of maintenanceEvents) {
    if (event.archived || !matches(event.summary, normalizedQuery)) continue;
    const record = activeReferences.find((candidate) => candidate.recordId === event.recordId);
    if (!record) continue;
    const date = String(event.performedOn);
    addResult({ kind: "Maintenance", id: event.maintenanceId, text: event.summary, detail: "", context: `${record.title} · ${date.slice(4, 6)}/${date.slice(6, 8)}/${date.slice(0, 4)}` });
  }

  return { results, totalCount };
}
