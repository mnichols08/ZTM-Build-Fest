# JavaScript–WASM ABI

**Status:** Protocol 24 is the only replay format (refactor track, Slice 2; owner decision D3). Protocols 1–23 and the schema-1 `ITEM_ADDED` payload were removed, not migrated; their contracts survive only in the release records. The Rust sources that implement this contract are `rust/src/wire.rs`, `request.rs`, `event_decode.rs`, `history.rs`, `state_encode.rs` (with `state_encode/records.rs`), `sections.rs`, `codec.rs`, `command.rs`, `archive.rs` and `abi.rs`. Refactor Slice 4 added the KINS section table and regrouped the body into one contiguous section per domain. Slice 6 moved the history into the engine instance (`kin_history_*`, `kin_project`, `kin_execute`) and removed the whole-history `kin_apply_events` and `kin_execute_command`. The version stays 24 because event encoding and the KINE layout are unchanged.

All multibyte integers are little-endian. IDs are exactly 16 opaque bytes and are never parsed, except for the bytewise tie-break in replay ordering. Text is strict UTF-8 with no terminator. Reserved fields must be zero. Decoders reject truncation, trailing bytes, overflow, unknown codes, invalid UTF-8 and unsupported versions; they never reinterpret a different layout.

## Exports and ownership

```text
kin_alloc(length) -> ptr             kin_free(ptr, length) -> status
kin_history_reset() -> status        empty the instance's history
kin_history_append(ptr, len)         append a record batch to the history
kin_history_truncate(count) -> status   keep the first `count` records
kin_project(ptr, len)                replay the history: KINE context -> KINS
kin_device_names(ptr, len)           replay the history: KINE context -> KDEV (v1.1)
kin_chat_history_reset() -> status   empty the chat log (the text arena stays)
kin_chat_history_append(ptr, len)    append a chat record batch to the chat log
kin_chat_history_truncate(count) -> status   keep the chat log's first `count`
kin_chat_execute(ptr, len)           chat command: length + KCMD + admins + KINE context -> KCMT
kin_chat_page(ptr, len)              replay the chat log: KCHQ -> KCHP (v1.1)
kin_chat_text(ptr, len)              decrypted texts for the arena: KCHT -> KCHS
kin_chat_texts_clear() -> status     drop every decrypted chat text
kin_execute(ptr, len)                command: length + KCMD + KINE context -> KCMT
kin_encode_command(ptr, len)         KCMD -> canonical event bytes
kin_event_metadata(ptr, len)         one canonical event -> KMET
kin_event_metadata_batch(ptr, len)   KMDQ -> KMDL
kin_plan_import(ptr, len)            import plan of the history: KINE context -> KIMP
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
at 64 MiB and 10,000 events (250,000 for the chat log).

`kin_alloc(0)` and a failed allocation return 0, which the host treats as
failure. Live allocations sit in a fixed table of 8 slots. The host holds one
input at a time, so a full table means a leaked allocation, and `kin_alloc`
returns 0. `kin_clear` releases retained buffers, the history, the chat log
and the chat-text arena (whose bytes it zero-fills first); it does not
promise physical erasure. `engine.dispose()`
calls it.

## Instance history (Slice 6)

Each engine instance holds one canonical history (`rust/src/history.rs`):
records in local arrival order, stored as received in one byte buffer with an
`(offset, length)` span per record. Projections and commands replay this
history; no call carries a whole history any more. Since Slice 9
`kin_plan_import` also takes a record-less context: the host fills the
instance's history with the archive's records being imported (the mirror
resets it to that history, in batches of about 4 MiB, and back to the
session's history on the next replay) and the plan is computed from it.

- `kin_history_append(ptr, len)` adds records after those held. Its input is
  `count:u32`, then `count` record lengths (u32 each), then the records back
  to back. Every record is checked (`decode_event`) before any is appended,
  so a failure leaves the history unchanged and publishes a KERR error. It
  publishes no result on success. The history is capped at 10,000 records
  and 64 MiB.
- `kin_history_truncate(count)` keeps the first `count` records (status 1 if
  `count` exceeds the history). It touches neither result nor error buffer.
- `kin_history_reset()` empties the history, zero-filling its bytes, and drops
  its checkpoint.
- `kin_project(ptr, len)` takes a KINE request whose `event_count` is 0 and
  which carries no records: its as_of, cursor, civil date, target household
  and bindings are the replay context. It publishes the KINS projection with
  stamped section revisions.
- `kin_execute(ptr, len)` takes `intent length:u32`, the KCMD intent, then such
  a record-less KINE context, and publishes KCMT. The history is not changed;
  the host appends the new event once it is stored.

The history also keeps a checkpoint (Slice 7): the replay state of its first
N records, built in one identity context (target household and bindings). A
projection or command applies only the records after N, if each of them has a
logical time strictly greater than the checkpoint's last one. A record at an
equal logical time could make an earlier decision concurrent with a new
archive, so it rebuilds instead. So does a different identity context, a
truncation below N, or an apply error. The result always equals a replay of
the whole history; `rust/src/history_tests.rs` checks this after every record
of every golden fixture. `kin_project` advances the checkpoint to the whole
history. `kin_execute` uses it and applies the command's event to a copy.

**The chat log (v1.1, #109).** Each instance also holds a second history,
the chat log, with the same layout, batches, checkpoint and mirror
(`kin_chat_history_*`). It takes chat records (kinds 44–47) only, and the
household history takes every other kind; either refuses the other's with
code 4, as does a whole KINE request carrying a chat record. The chat log
holds up to 250,000 records and 64 MiB. `kin_chat_execute` runs chat
commands against it (any other command fails with code 4, as a chat command
does against the household history). Its input is `intent length:u32`, the
KCMD intent, `admin count:u32` (at most 16), the household admins' member IDs
as the service reports them (16 bytes each, non-zero), then a record-less
KINE context. It publishes KCMT with an empty projection: a chat event changes
no projection, and applying it to a copy of the chat would copy all of it. `kin_chat_page` and `kin_chat_text` read the
chat log and the text arena (side formats below).

Records stay where they were appended: the history keeps one buffer and an
`(offset, length)` span per record, and reads them as `EventView`s
(`event_decode.rs`). A view gives the header fields and the payload slice
without copying or decoding. Since Slice 8 only the records the checkpoint
has not applied are decoded into owned events. The catch-up summary reads the
event ID and a small borrowed extract (`SummaryInput`) from each view. Command
checks use what the replay already knows (its household, last logical time
and event IDs) instead of scanning the history.

The bridge keeps the instance's history equal to what a caller asks it to
replay (`web/wasm/history-mirror.js`). Views of the same session arena and
epoch send only the records added since the last call, or truncate for a
shorter view. Another arena, a new epoch or a plain array resets the instance
and sends that history whole. `historyWith(view, extras)` appends the extras
for one replay and truncates them afterwards. Growth reserves an eighth more
than the history holds, so appending a few events copies nothing.

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

For `kin_project` and `kin_execute` the request is only the context: its
`event_count` must be 0 and nothing may follow the bindings; the events are
the instance history's records.

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
| 42 | DEVICE_DESCRIBED (v1.1) | name length u32, the header device's automatic name (1–48 characters, at most 192 bytes) |
| 43 | DEVICE_NICKNAMED (v1.1) | device ID (non-zero), nickname length u32 (zero clears), nickname (1–32 characters) |
| 44 | CHAT_MESSAGE_POSTED (v1.1, chat log) | message ID, content kind u8 (1 text, 2 attachment), 3 reserved, blob ref (32), blob key (32): 84 bytes |
| 45 | CHAT_MESSAGE_EDITED (v1.1, chat log) | message ID, blob ref (32), blob key (32): 80 bytes |
| 46 | CHAT_MESSAGE_DELETED (v1.1, chat log) | message ID, by_admin u8 (0 or 1), 3 reserved: 20 bytes |
| 47 | CHAT_REACTION_SET (v1.1, chat log) | message ID, on u8 (0 or 1), 3 reserved, emoji length u32, the emoji's UTF-8 (one emoji grapheme, 1–32 bytes) |

Fixed-length payloads must have exactly their length. Text, title and bound
details beyond the byte layout (trimming, scalar counts, controls, per-entity
limits) are domain validation in `state.rs` and fail with code 4.

Device names (kinds 42 and 43, added in v1.1 without a protocol change) are
the exception: their names must already be canonical in the event, so the
decoder fails a name with surrounding whitespace, a control character, a
disguising format character (bidirectional controls, zero-width space, word
joiner, soft hyphen, byte-order mark; zero-width joiner and non-joiner are
allowed) or too many characters with code 2. Once decoded, a device-name
event never fails replay, because names are cosmetic (`replay/devices.rs`): a
device keeps the member that first described it, an event from another member
changes nothing, and a nickname for a device this history has not seen
described is kept as a nickname-only entry. The latest description and
nickname in replay order win. Commands enforce the strict rules. Device names are not part of KINS: they leave the engine
only through `kin_device_names`. An engine older than v1.1 fails both kinds
with code 3 (unsupported).

Chat events (kinds 44–47, v1.1, no protocol change) belong to the chat log
(above). A zero message ID, blob ref or key, an unknown content kind, a
`by_admin` other than 0 or 1, or a non-zero reserved byte fails with code 2.
Once decoded, a chat event never fails replay (`replay/chat.rs`): one that
conflicts with what the log knows is kept and changes nothing
([EVENTS](EVENTS.md#v110-household-chat) has the rules). An engine older than
v1.1 fails all three with code 3.

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

- The ABI stamps revisions on the projections returned by `kin_project`
  and `kin_execute`. Each section's counter starts at 0 per instance
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
  commands carry the parent Item ID first in their payload. The entity ID is
  always the command's own entity, chosen by action (`ENTITY_FIELDS` in
  `web/wasm/kin-engine.js`). References to other entities (a note's or
  reference record's Area, a maintenance entry's record and Routine, a Step's
  Item, an attachment's parent) travel in the payload and never become the
  entity ID.
- **KCMT v1** (command result): `"KCMT"`, version 1, reserved, then event,
  metadata and projection lengths (u32 each) and the three buffers. Execution
  validates the history, requires a fresh event ID and a logical time above
  history, rejects stale Routine intents and Item completions or reopenings
  that would not change status, and returns the KINS projection of the
  candidate history (the instance history plus the new event, which is not
  kept).
- **KMET v1** (92 bytes): `"KMET"`, version 1, reserved, event/household/
  actor/device IDs, timestamp i64, logical time u64, event version u16, kind
  u16. **KMDQ v1 / KMDL v1** batch these: `"KMDQ"`, version, reserved, count,
  then length-prefixed events; the result is `"KMDL"` with the same prefix and
  `count` KMET records. One invalid record rejects the batch.
- **KDEV v1** (device names, `kin_device_names`): `"KDEV"`, version 1,
  reserved u16, device count u32, then per device in device-ID order: device
  ID, member ID (16 bytes each, after identity bindings), automatic-name
  length u16 (zero for a nickname-only entry), nickname length u16 (zero
  when none), the automatic name and the nickname (UTF-8). Every entry has at
  least one of the two names. The context is a record-less KINE request, as for
  `kin_project`. KCMD action 42 (`describe-device`) carries the name as its
  payload and a zero entity ID; action 43 (`nickname-device`) carries the
  target device as its entity ID and the nickname as its payload (empty
  clears). Executing either rejects a name that would change nothing.
- **Chat commands (KCMD 44–47, v1.1).** The entity ID is the message ID.
  Action 44 (`post-chat-message`) carries the content kind in the u8 field
  (1 text, 2 attachment) and a 64-byte payload: blob ref, then blob key.
  Action 45 (`edit-chat-message`) carries the same payload and a zero u8
  field. Action 46 (`delete-chat-message`) carries `by_admin` (0 or 1) in the
  u8 field and no payload. A zero ref or key is malformed (code 2). Executing
  requires a blob reference the chat log has never seen (to post or edit), a
  new message ID to post; the author, a text message and a message not
  deleted to edit; and to delete, a message not deleted, with `by_admin` 0
  for your own and 1 for another member's, once per admin and only with the
  actor among the admins named in the request. Action 47
  (`react-chat-message`) carries `on` (0 or 1) in the u8 field and the emoji
  as its text payload (1–32 bytes; one emoji grapheme, which executing
  checks, failing with code 4 otherwise). Executing requires a message the log holds that is neither
  deleted nor removed by a named admin, and a change: turning on a reaction
  the actor already has, or off one they lack, is refused, as is a 25th
  different emoji on one message (replay ignores one past the 24th too).
- **KCHQ v1** (chat page request, `kin_chat_page`): `"KCHQ"`, version 1,
  reserved u16, before u32 (the page ends before this message index;
  `0xFFFFFFFF` for the newest), limit u16 (1–500), flags u8 (bit 0: texts the
  arena holds; bit 1: retired blobs; bit 2: reactions), reserved u8, admin count u32 (at most
  16), the admins' member IDs (16 bytes each, non-zero), then a record-less
  KINE context as for `kin_project`.
- **KCHP v1** (chat page): `"KCHP"`, version 1, reserved u16, then u32s:
  total messages, index of the page's first message, messages in the page,
  text bytes, retired blobs. Then 128 bytes per message, oldest first:
  message ID @0, author @16, posting device @32 (after identity bindings),
  posted at i64 @48, edited at i64 @56 (0 if never), index u32 @64, status u8
  @68 (0 live, 1 edited, 2 deleted, 3 removed by an admin), content kind u8
  @69, reserved u16, blob ref @72 (zero unless live or edited), text offset
  u32 @104 and length u32 @108 (length 0: the arena doesn't hold the text),
  reaction groups u32 @112 (0 unless the request asked for reactions and the
  message is live or edited), 12 reserved. Then 32 bytes of blob key per message (zero unless live or
  edited), the text bytes, and 32 bytes per retired blob: every blob replaced
  by an edit or deleted by its author, every blob brought by an event that
  applies nowhere ([EVENTS](EVENTS.md#v110-household-chat)), plus the blobs
  of messages removed by a named admin, each once and only if no live or
  edited message shows it (`ChatState::retired_blobs`). A request for
  reactions adds a last section: for each message in order, each of its
  groups, in the order replay first saw the emoji: emoji length u8, the
  emoji's UTF-8, member count u32 (at least 1), then 16 bytes per member's
  actor ID (in the order they reacted). A deleted or removed message has no
  groups. Reading a page first forgets
  the arena's texts for those blobs, so a deleted message's text never comes
  back out. Message indexes
  are positions in posting (replay) order, so a late-arriving older message
  shifts them; hosts re-read from the newest after a sync.
- **KCHT v1 / KCHS v1** (chat texts, `kin_chat_text`): `"KCHT"`, version 1,
  reserved u16, count u32 (1–500), then per text: blob ref (32, non-zero),
  length u32, the UTF-8 text. Every entry is framed before any is stored. The
  result is `"KCHS"`, version 1, reserved u16, count u32, then a status byte
  per text: 0 held (or already held: texts are content-addressed), 1 refused
  by the text rules. The arena holds at most 16 MiB: a batch that wouldn't
  fit starts it over once, before storing anything, so every text a batch
  reports as held is held, and the host supplies earlier texts again. The
  arena grows by copying into a new buffer and zero-filling the old one, so
  freed memory holds no text. Texts stay until lock (`kin_clear`) or
  `kin_chat_texts_clear` (a member who lost chat access while unlocked);
  `kin_chat_history_reset` keeps them, since the history mirror resets the
  chat log whenever it is handed a plain array.
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
The engine reuses every decoded section of the last state it produced whose
revision is unchanged, keeping those arrays' identity. Cross-section
references are checked again on every decode. A replay or command history may
be a session-arena view, a `historyWith(view, extras)` source or an array of
canonical records; the history mirror (above) brings the instance up to date
with it before `kin_project` or `kin_execute`. `createEngine(exports)` wraps
instantiated exports for tests, `web/wasm/abi-test-support.mjs` replays whole
KINE requests through the raw ABI for tests, and `engine.projectionBytes(...)`
returns exact KINS bytes for the projection-equivalence oracle.

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
