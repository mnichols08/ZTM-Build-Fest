# Catch-up Context Experiment

**Status:** Bounded v0.47 presentation experiment  
**Persistence:** None  
**New domain concepts:** None

## Hypothesis

People can scan Catch-up changes more confidently when a lifecycle action also
names its existing destination. “Milk handled in Shopping” carries more useful
context than “Milk handled” without requiring actor attribution, timestamps,
new events or another stored preference.

## Scope

The experiment changes only display copy derived from fields already present in
the Rust summary projection:

- Item lifecycle entries name Today, To do, Shopping or Staples from their
  existing classification.
- Handoff acknowledgement/archive entries name Handoff.
- Talk resolve/reopen/archive entries name Talk.
- Unknown classifications keep the neutral “your lists” fallback.

The eight-entry cap, omitted count, local caught-up cursor, event-free
acknowledgement, ordering and privacy boundary are unchanged.

## Validation boundary

Automated tests prove deterministic wording, neutral fallback behavior and the
existing Catch-up lifecycle. They do not prove that people understand the copy
more quickly. Before treating the experiment as settled product language, use a
small first-use comparison and check whether people can answer where a changed
record lives without opening it.

Remove or shorten the destination phrase if it creates repetitive scanning or
if human comparison shows no comprehension benefit. Do not add persistence,
ranking, actor attribution or per-entry timestamps to rescue the experiment.
