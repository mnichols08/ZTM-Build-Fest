# JavaScript–WASM ABI

**Status:** Protocol 24 is the only replay format (refactor track, Slice 2; owner decision D3). Protocols 1–23 and the schema-1 `ITEM_ADDED` payload were removed, not migrated; their contracts survive only in the release records. The Rust sources that implement this contract are `rust/src/wire.rs`, `request.rs`, `event_decode.rs`, `state_encode.rs` (with `state_encode/records.rs`), `sections.rs`, `codec.rs`, `command.rs`, `archive.rs` and `abi.rs`. Refactor Slice 4 added the KINS section table and regrouped the body into one contiguous section per domain; the version stays 24 because event encoding and the KINE request are unchanged.

All multibyte integers are little-endian. IDs are exactly 16 opaque bytes and are never parsed, except for the bytewise tie-break in replay ordering. Text is strict UTF-8 with no terminator. Reserved fields must be zero. Decoders reject truncation, trailing bytes, overflow, unknown codes, invalid UTF-8 and unsupported versions; they never reinterpret a different layout.

## Exports and ownership

```text
kin_alloc(length) -> ptr             kin_free(ptr, length) -> status
kin_apply_events(ptr, len)           replay: KINE -> KINS
kin_execute_command(ptr, len)        command: length + KCMD + KINE -> KCMT
kin_encode_command(ptr, len)         KCMD -> canonical event bytes
kin_event_metadata(ptr, len)         one canonical event -> KMET
kin_event_metadata_batch(ptr, len)   KMDQ -> KMDL
kin_plan_import(ptr, len)            decrypted KINE history -> KIMP
kin_archive_header(ptr, len)         two lengths -> 16-byte KARC header
kin_archive_layout(ptr, len)         KARC header + total length -> two lengths
kin_encode_archive / kin_decode_archive   whole KARC framing (retained)
kin_result_ptr/len, kin_error_ptr/len     the last call's result or error
kin_clear()                               drop every retained buffer
```

Pointers are byte offsets into the module's linear memory. Every operation
accepts only the exact pointer and length of a live `kin_alloc` buffer, clears
the previous result and error first, and publishes either a complete result or
a KERR error, never a partial result. Result and error bytes stay valid until
the next call or `kin_clear`; the host copies them before calling again and
re-reads `memory.buffer` after every call, since memory may grow. The host
frees each input exactly once on every exit path (`callCore` in
`web/wasm/kin-engine.js`); `kin_free` returns 1 for an unknown or mismatched
range and never frees an unrelated allocation. Requests and results are capped
at 64 MiB and 10,000 events.

`kin_alloc(0)` and a failed allocation return 0, which the host treats as
failure. `kin_clear` releases retained buffers; it does not promise physical
erasure. `engine.dispose()` calls it.

## Status codes and KERR

`0` success, `1` invalid ABI pointer or range, `2` malformed protocol or
payload, `3` unsupported version or kind, `4` invalid domain event or state,
`5` size or allocation limit, `6` internal error. The same failure always maps
to the same code; messages are diagnostic only and never contain household
text. The error buffer is `KERR | version:u16 = 1 | code:u16 | length:u32 |
UTF-8 message`.

## KINE replay request (protocol 24)

```text
offset size field
0      4    "KINE"
4      2    protocol_version = 24
6      2    reserved = 0
8      4    event_count (<= 10,000)
12     8    as_of: i64 UTC milliseconds (|value| <= 8.64e15)
20     1    cursor_present (0 or 1)
21     3    reserved = 0
24     16   cursor event ID (all zero when absent)
40     4    civil date YYYYMMDD (years 1-9999)
44     16   target household ID (all zero = local replay)
60     2    identity_binding_count (<= 256; must be 0 for local replay)
62     2    reserved = 0
64     96*n identity bindings, then event_count canonical event records
```

A binding is three placeholder IDs (household, actor, device) followed by
three authenticated IDs (household, member, device). Its authenticated
household must equal the target; a duplicate placeholder tuple, a mismatch,
or an event from another household without a binding fails with code 4.
Bindings change only the replay identity; `canonical_bytes` keep the signed
source event. They are how history created before sync (with placeholder IDs
in its canonical bytes) replays after sync, so they are part of the current
contract, not a migration ([IDENTITY](IDENTITY.md)).

Replay reduces an owned copy sorted by `(logical_time, device_id, event_id)`;
equal logical times are valid. The catch-up summary uses input (local arrival)
order: its through event is the last input event, and a present cursor must
name an event in the input or the request fails with code 4. Exact duplicate
events are ignored; one event ID with different bytes fails with code 4.

## Canonical events

Each record is an 88-byte envelope followed by its payload:

```text
2  event_version (2 for ITEM_ADDED, 1 for every other kind)
2  event_kind
16 event_id
16 household_id
16 actor_id
16 device_id
8  timestamp: i64 UTC milliseconds
8  logical_time: u64
4  payload_length
N  payload
```

| Kind | Name | Payload |
| --- | --- | --- |
| 1 | ITEM_ADDED (schema 2) | item ID, classification u8 (0 Today, 1 Need, 2 Shopping, 3 Staple), 3 reserved, text length u32, text (1–4096 bytes) |
| 2–4 | ITEM_COMPLETED / REOPENED / ARCHIVED | item ID |
| 5 | HANDOFF_ADDED | handoff ID, text length u32, text |
| 6–7 | HANDOFF_ACKNOWLEDGED / ARCHIVED | handoff ID |
| 8 | TALK_ADDED | talk ID, text length u32, text |
| 9–11 | TALK_RESOLVED / REOPENED / ARCHIVED | talk ID |
| 12 | PULSE_SET | value u8 (0–4), 7 reserved, expires_at i64 |
| 13 | PULSE_CLEARED | empty |
| 14 | ROUTINE_CREATED | routine ID, cadence u8 (0 Daily, 1 Weekly, 2 every two weeks, 3 Monthly, 4 Weekdays), 3 reserved, created_on u32, text length u32, text |
| 15–16 | ROUTINE_OCCURRENCE_COMPLETED / REOPENED | routine ID, occurrence key u32 |
| 17 | ROUTINE_ARCHIVED | routine ID |
| 18–19 | AREA_CREATED / RENAMED | area ID, name length u32, name (1–96 bytes) |
| 20 | AREA_ARCHIVED | area ID |
| 21 | ITEM_AREA_CHANGED | item ID, area ID (zero clears) |
| 22–23 | NOTE_CREATED / UPDATED | note ID, area ID (zero = none), title length u32, body length u32, title, body |
| 24 | NOTE_ARCHIVED | note ID |
| 25 | ITEM_STEP_ADDED | item ID, step ID, text length u32, text (≤ 256 bytes) |
| 26–28 | ITEM_STEP_COMPLETED / REOPENED / ARCHIVED | item ID, step ID |
| 29 | HOUSEHOLD_MODE_CHANGED | mode u8 (0 Normal, 1 Vacation, 2 Guests, 3 Rest) |
| 30 | ITEM_PLANNING_DATE_CHANGED | item ID, date u32 (zero clears) |
| 31–32 | PIN_ADDED / REMOVED | target kind u8 (1 Item, 2 Note, 3 Routine, 4 Area), 3 reserved, target ID |
| 33 | PLAYBOOK_SAVED | playbook ID, title length u16, entry count u8 (1–16), reserved u8, title, then entries as u16 length + text |
| 34 | PLAYBOOK_ARCHIVED | playbook ID |
| 35 | REFERENCE_RECORD_SAVED | record ID, area ID, title length u16, field count u8 (1–16), reserved u8, title, then fields as field ID, label length u16, value length u16, label, value |
| 36 | REFERENCE_RECORD_ARCHIVED | record ID |
| 37 | MAINTENANCE_EVENT_SAVED | maintenance ID, record ID, performed u32, next u32 (zero = none), routine ID (zero = none), summary length u16, summary |
| 38 | MAINTENANCE_EVENT_ARCHIVED | maintenance ID |
| 39 | ATTACHMENT_BOUND | attachment ID, parent kind u8 (1 Note, 2 Reference Record, 3 Maintenance, 4 Item), parent ID |
| 40 | ATTACHMENT_REMOVED | attachment ID |
| 41 | RESPONSIBILITY_CHANGED | target kind u8 (1 Item, 2 Routine), target ID, member ID (zero clears) |

Fixed-length payloads must have exactly their length. Text, title and bound
details beyond the byte layout (trimming, scalar counts, controls, per-entity
limits) are domain validation in `state.rs` and fail with code 4.

## KINS projection (protocol 24)

The 96-byte header holds `"KINS"`, version 24, reserved 0, then u32 counts:

```text
8  items      12 handoffs   16 talks      20 pulses
24 summary entries          28 summary total count
32 through_present u8, 33-35 reserved, 36 through event ID (16)
52 routines   56 areas      60 notes      64 steps
68 mode u8, 69-71 reserved
72 pins       76 playbooks  80 reference records
84 maintenance events       88 attachments           92 responsibilities
```

A 112-byte section table follows the header: one entry per domain section,
`revision u32, byte length u32`, in body order (`rust/src/sections.rs`). The
lengths cover the body exactly; a decoder rejects a table that does not.

| # | Section | Contents, in order |
|---|---|---|
| 0 | Items | Item records; one Area ID per Item; Steps; one planning date per Item; one last-changed timestamp per Item |
| 1 | Handoffs | Handoff records |
| 2 | Talks | Talk records |
| 3 | Pulses | Pulse records |
| 4 | Routines | Routine records; one next-occurrence date per Routine |
| 5–12 | Areas, Notes, Pins, Playbooks, Reference Records, Maintenance events, Attachments, Responsibilities | their records |
| 13 | Summary | summary entries |

Records:

- Items: item ID, created_by, created_at i64, classification u8, status u8
  (0 active, 1 completed, 2 archived), 2 reserved, text length u32, text.
  Then one Area ID per Item (zero = none); the Steps, grouped by Item in Item
  order: item ID, step ID, completed u8, archived u8, 2 reserved, text length
  u32, text; one planning date u32 per Item (zero = none); one last-changed
  timestamp i64 per Item (latest effective Item or Step event).
- Handoffs: handoff ID, created_by, created_at i64, status u8
  (0 unacknowledged, 1 acknowledged, 2 archived), 3 reserved, text length, text.
- Talks: talk ID, created_by, created_at i64, status u8
  (0 open, 1 resolved, 2 archived), 3 reserved, text length, text.
- Pulses (40 bytes each, ordered by actor): actor ID, set_at i64,
  expires_at i64, value u8, status u8 (0 active, 1 expired), 6 reserved.
- Routines: routine ID, created_by, created_at i64, created_on u32,
  occurrence key u32 (zero = none today), cadence u8, archived u8,
  occurrence u8 (0 none, 1 open, 2 completed), reserved u8, text length, text.
  Then one next-occurrence date u32 per Routine (zero when archived or past
  9999-12-31; otherwise later than the current key).
- Areas: area ID, archived u8, 3 reserved, name length u32, name.
- Notes: note ID, created_by, updated_by, created_at i64, updated_at i64,
  area ID, archived u8, 3 reserved, title length u32, body length u32, title, body.
- Pins (20 bytes each): target kind u8, 3 reserved, target ID.
- Playbooks: playbook ID, archived u8, entry count u8, title length u16,
  2 reserved, title, then entries as u16 length + text.
- Reference Records: record ID, area ID, title length u16, field count u8,
  archived u8, title, then fields as field ID, label length u16, value
  length u16, label, value.
- Maintenance events: maintenance ID, record ID, performed u32, next u32,
  routine ID, archived u8, reserved u8, summary length u16, summary.
- Attachments (36 bytes each): attachment ID, parent kind u8, removed u8,
  2 reserved, parent ID.
- Responsibilities (33 bytes each): target kind u8, target ID, member ID.
- Summary entries (at most 8): event ID, kind u8 (1–15), entity kind u8
  (1 Item, 2 Handoff, 3 Talk, 4 Routine), classification u8 (255 when
  absent; present only for item-added), reserved u8, text length u32, text.

Collections keep original add order and include archived tombstones, so the
browser filters views without reducing state. An empty household is exactly
the header and a table of zero lengths (208 bytes). Counts are bounded (10,000
combined entities, 32 Areas, 128 Notes, 16 Steps per Item, 10 Pins, 32
Playbooks, 128 Reference Records, 8,192 Maintenance events, 256 attachments)
and the whole result by 64 MiB.

### Section revisions

A revision tells the host whether a section changed since the last projection
from the same engine instance, so it can skip decoding and rendering an
unchanged section.

- The ABI stamps revisions on the projections returned by `kin_apply_events`
  and `kin_execute_command`. Each section's counter starts at 0 per instance
  and increases by one (wrapping past `u32::MAX` to 1, never 0) whenever that
  section differs from the same section of the last projection the instance
  emitted. The comparison is exact: the section bytes and the header fields
  that describe it (its counts; for the summary also the total and through
  event, bytes 24–51). An unchanged section keeps its revision.
- The previous projection is the buffer the instance already retains as its
  last result (for a command, the whole KCMT result), moved aside rather than
  copied. Tracking costs one byte comparison per section. While a projection
  call runs, the old and the new result are both alive, so peak memory is up
  to two results instead of one. Between calls one result is retained, as
  before. A non-projection call in between keeps the old projection as the
  comparison basis, so it can outlive that call until the next projection or
  `kin_clear`. `kin_clear` drops it but
  keeps the counters, so a later projection advances every section instead of
  reusing a revision the host may still hold.
- Revision 0 means unversioned. The pure encoder and the KIMP projection
  write 0, and the host always decodes such a section.
- Revisions are a rendering aid, not part of replay or authority. They do not
  depend on event encoding, and equal history still yields identical section
  bytes. The golden fixtures hold a fresh instance's first projection, where
  every revision is 1.

The bridge keys reuse on the engine instance as well as the revision. A
revision is meaningful only within one instance.

## Side formats

- **KCMD v1** (command intent): `"KCMD"`, version 1, reserved, action code u16,
  reserved, then explicit event ID, household, actor, device, timestamp i64,
  logical time u64, entity ID, a u32 date field (Routine key or planning
  date), a u8 field (classification, Pulse value, cadence or mode), 3 reserved,
  Pulse expiry i64, payload length u32 and the action payload (128-byte fixed
  part). JS supplies identity, time and randomness; Rust chooses the event
  schema, builds the canonical payload and validates the command. Step
  commands carry the parent Item ID first in their payload.
- **KCMT v1** (command result): `"KCMT"`, version 1, reserved, then event,
  metadata and projection lengths (u32 each) and the three buffers. Execution
  validates the history, requires a fresh event ID and a logical time above
  history, rejects stale Routine intents and Item completions or reopenings
  that would not change status, and returns the KINS projection of the
  candidate history.
- **KMET v1** (92 bytes): `"KMET"`, version 1, reserved, event/household/
  actor/device IDs, timestamp i64, logical time u64, event version u16, kind
  u16. **KMDQ v1 / KMDL v1** batch these: `"KMDQ"`, version, reserved, count,
  then length-prefixed events; the result is `"KMDL"` with the same prefix and
  `count` KMET records. One invalid record rejects the batch.
- **KIMP v1** (import plan): `"KIMP"`, version 1, reserved, event count u32,
  next logical time u64, projection length u32, KINS projection. Duplicate
  event IDs, including exact duplicates, fail.
- **KARC v1** (archive container): `"KARC"`, version 1, reserved, metadata
  length u32 (1–1 MiB), ciphertext length u32 (at least a 16-byte tag), then
  both sections exactly; at most 160 MiB in total. Framing is not
  authentication; the browser authenticates the package before using it.

## JavaScript bridge

`web/wasm/kin-engine.js` loads and checks the module, allocates and copies
buffers, encodes KINE and KCMD, decodes KINS (`decodeProjection` in
`projection-decode.js`, one module per section family under `projection/`) and
converts status codes to safe messages. It never reduces events.
`engine.applyEvents(..., previous)` reuses every decoded section of `previous`
whose revision is unchanged, keeping those arrays' identity. Cross-section
references are checked again on every decode. A replay or command
history may be an array of canonical records or a contiguous source exposing
`length`, `byteLength` and `copyTo(target, offset)` (the session event arena),
copied in one operation; command requests encode the history once behind a
reserved intent prefix. `createEngine(exports)` wraps instantiated exports for
tests, and `engine.projectionBytes(...)` returns exact KINS bytes for the
projection-equivalence oracle.

## History

Protocols 1–23 were additive: v1 Items, v2 classification and archive, v3
Handoff, v4 Talk, v5 Pulse with `as_of`, v6 catch-up summary, v7 Routines with
a civil date, v8 distributed ordering and identity bindings, v9 Areas, v10
Notes, v11 Steps, v12 richer cadences, v13 Shopping, v14 Staples, v15 modes,
v16 planning dates, v17 last-changed dates, v18 Pins, v19 Playbooks, v20
Reference Records, v21 Maintenance, v22 attachments, v23 responsibility, and
v24 Weekdays plus next-occurrence dates. Protocol 24's layout is the
accumulation of those sections. Refactor Slice 4 regrouped the KINS body into
per-domain sections behind a section table with revisions. The per-version contracts are in the release
records (for example [V0.7.0](V0.7.0.md), [V0.9.0](V0.9.0.md),
[V0.10.0](V0.10.0.md) and `releases/`).
