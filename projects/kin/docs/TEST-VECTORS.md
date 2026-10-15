# Canonical Test Vectors

**Status:** Single protocol-24 baseline (refactor track, Slice 2). Kin has never shipped to real users, so protocols 1–23, the schema-1 `ITEM_ADDED` payload and their compatibility vectors were removed rather than migrated (owner decision D3). Release notes keep the historical evidence.

## Golden fixtures

`rust/fixtures/golden/*.kine` and `*.kins` are exact protocol-24 request and
projection bytes for five scenarios built through the command path: an empty
household, a household using every command kind, bound pre-sync history with
two devices diverging offline, an expired Pulse in a paused mode, and 400 bulk
Items. They pin canonical event encoding and projection encoding together.
Native Rust (`rust/src/golden_tests.rs`) and the release WASM
(`web/wasm/golden.test.mjs`) must both reproduce them byte for byte.
Regenerating them (`KIN_UPDATE_GOLDEN=1 cargo test golden`) is a deliberate
protocol change and needs its own justification.

The `.kins` files hold a fresh engine instance's first projection, so every
section revision is 1; the WASM test instantiates a new module per fixture for
that reason. Refactor Slice 4 regenerated only the `.kins` files, when the
section table was added. Every `.kine` request stayed byte-identical, so
canonical event bytes did not change. Each new projection was checked to be
exactly the old header, a table of revision-1 entries, and the old body
regrouped into per-domain sections with no other byte changed.

## Common envelope values

IDs are 16-byte values shown as 32 lowercase hexadecimal characters. Unless a
vector overrides a field, events use:

```text
household_id   = aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
actor_id       = bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
device_id      = cccccccccccccccccccccccccccccccc
event schema   = 2 for ITEM_ADDED, 1 for every other kind
request        = protocol 24, local (zero target household), no bindings
```

Timestamps are signed UTC Unix milliseconds. `local_sequence` is IndexedDB
ordering metadata and is not encoded in any event. Unless a vector says
otherwise, events appear in input order with `local_sequence` and
`logical_time` starting at 1. The `ITEM_ADDED` payload is
`item_id[16] | classification:u8 | reserved[3]=0 | text_length:u32 | text`,
with classification 0 Today, 1 Need, 2 Shopping, 3 Staple. Requests carry an
explicit `as_of` and civil date; [ABI](ABI.md) has the complete layouts.

## Items

**001 — Add item.** `ITEM_ADDED` event `…01`, item `11111111111111111111111111111111`,
timestamp `1760000000000`, text `"Buy milk"`, classification Today. Expected:
one active Today item with that ID, text, creator `bb…` and creation time.

**002 — Multiple items.** Vector 001 plus a second `ITEM_ADDED` (event `…02`,
item `22…`, timestamp `1760000030000`, text `"Restock wipes"`, Need). Expected:
both items in add order.

**003 — Complete item.** Vector 001 then `ITEM_COMPLETED` (event `…02`, logical
time 2) for item `11…`. Expected: status completed.

**004 — Invalid reference.** A lone `ITEM_COMPLETED` for an unknown item.
Expected: status code 4, no projection.

**005 — Duplicate event ID.** Vector 001's exact bytes twice. Expected: one
item (exact duplicates are ignored). The same event ID with different bytes
fails with code 4 and never overwrites.

**006 — Replay determinism.** Replaying Vector 003 repeatedly yields
byte-identical projections. Replay never depends on ambient time, randomness,
map iteration order, the network or the DOM.

**007 — Repeated completion fact.** Vector 003 then a distinct second
`ITEM_COMPLETED`. Expected: replay succeeds and the item stays completed; the
history keeps both facts. (Rust's command validator refuses to create such a
redundant completion, but replay of one that exists is idempotent.)

**008 — Unsupported versions.** A request header with any version other than
24, an `ITEM_ADDED` with schema 1 or 3, or any other kind with schema 2.
Expected: status code 3, no partial result; stored bytes stay untouched.

**009 — Malformed payload.** An `ITEM_ADDED` whose declared text length (5)
exceeds the two text bytes present. Expected: status code 2.

**010 — Household mismatch.** Two local events from different households in
one request. Expected: status code 4; the whole stream is rejected.

**011 — Inert text.** Vector 001 with text `<script>alert("x")</script>`.
Expected: the exact string is preserved, and the browser renders it as text.

**012 — Lifecycle.** A Need item, then `ITEM_COMPLETED`, `ITEM_REOPENED` and
`ITEM_ARCHIVED`. Expected: archived, classification unchanged, all four events
retained.

**013 — Archived item mutation.** Vector 012 followed by any further Item
mutation. Expected: code 4, no partial projection.

**014 — Exact lifecycle payloads.** `ITEM_COMPLETED`, `ITEM_REOPENED` and
`ITEM_ARCHIVED` with payload lengths 0–17 except 16. Expected: code 2.

**015 — Maximum replay.** 10,000 `ITEM_ADDED` events with unique IDs and
alternating classifications. Expected: 10,000 ordered items, a projection below
64 MiB, byte-identical across repeated replays, natively and in WASM.

## Handoff, Talk and Pulse

**016 — Handoff.** Kind 5 adds an unacknowledged Handoff; kind 6 acknowledges
(repeating it is a no-op); kind 7 archives; any later mutation fails with
code 4. Acknowledgement actor and time stay in the source envelope.

**017 — Talk.** Kind 8 adds an open topic; 9 resolves (repeat is a no-op); 10
reopens; 11 archives. Unknown references and archived mutations fail with
code 4.

**018 — Pulse.** Actor A sets Drained at 1000 ms, expiring at 2000 ms. At
`as_of` 1999 it is active; at 2000 and 2001 expired; at 1000 active again
(explicit time, reversible). A later SET replaces A only; CLEAR twice succeeds;
actor B is independent. No expiry event exists.

## Since You Last Looked

**019 — Cursor boundary.** `ITEM_ADDED(1, "Milk")`, `ITEM_COMPLETED(2)`,
`PULSE_SET(3)`, cursor event 1. Expected: one `item-completed` entry (event 2,
text "Milk", no classification), total count 1, through event 3. Pulse has no
entry. A cursor that is not in the stream fails with code 4.

**020 — Entry cap.** Ten meaningful changes, then `PULSE_CLEARED(11)`, no
cursor. Expected: total 10, eight entries (events 3–10 in input order), through
event 11. No actor or timestamp appears in summary records.

## Distributed replay

**021 — Equal logical times.** Events with equal logical times reduce in
`(device_id, event_id)` order regardless of input order; the summary's through
event is the last event in input (arrival) order.

**022 — Identity bindings.** Pre-sync events under placeholder IDs replay as
the bound authenticated identity without changing their canonical bytes. A
placeholder tuple with no binding, a duplicate binding, a binding for another
household, or bindings on a local (zero-target) request fail with code 4.

**023 — Terminal archive.** An archive and a completion of the same Item at the
same logical time from different devices: the Item is archived in every input
order.
