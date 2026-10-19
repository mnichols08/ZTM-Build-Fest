# Household Events

**Status:** Current through v0.31.0 Maintenance Records. Protocol 21 adds bounded maintenance save/archive events 37–38 and an additive projection after Reference Records. Rust owns canonical command encoding and decoding; older protocols reject histories containing unsupported new entities. Protocol 20 adds Reference Records; protocol 19 adds ordered Playbooks. Equal-time distributed replay remains deterministic; local encryption wraps canonical bytes without rewriting them.

## Canonical record

Kin uses an append-oriented event stream as the canonical historical record. Current mutable UI state is a projection, not a competing source of truth.

The conceptual envelope is:

```text
Event
├── event_id
├── household_id
├── actor_id
├── device_id
├── timestamp
├── logical_time
├── kind
├── event_version
└── payload
```

Fields are specified now to avoid casually changing identity semantics later. The initial release may use local placeholder identities and a simpler local order; it does not implement household membership or sync.

- **event_id:** Opaque globally unique event identity. Must be generated without relying on a shared sequential database counter so independent offline devices can create events without collisions. A random 128-bit identifier is a suitable direction; exact generation and collision handling belong in the implementation contract.
- **household_id:** Stable opaque identity for the household to which the event belongs. v0.1.0 uses a locally persisted placeholder, not a server-registered household.
- **actor_id:** Stable member identity for the person who initiated the event. v0.1.0 uses a temporary local actor placeholder.
- **device_id:** Stable identity for the originating installation. v0.1.0 uses a local installation placeholder; it is not a trusted-device credential.
- **timestamp:** UTC wall-clock creation time for display and audit context. It is not sufficient to order distributed events and must not by itself control deterministic replay.
- **logical_time:** Non-negative logical ordering counter. In v0.1.0, local append order is authoritative and the counter can correspond to local order. In v0.9 synchronized v8 replay, a device advances beyond the greatest logical time it has observed before creating a causally later event; equal values represent concurrent events.
- **kind:** One canonical uppercase past-tense fact name from the event catalogue below. Do not mix imperative (`ADD_ITEM`) and fact (`ITEM_ADDED`) styles.
- **event_version:** Version of this event payload schema, distinct from the Kin application version, overall JS/WASM protocol version, IndexedDB schema, and portable export version. See [VERSIONING](VERSIONING.md).
- **payload:** Minimal, kind-specific validated data. For an item event this includes the stable item ID; `ITEM_ADDED` also carries its user-entered text.

## Event naming and availability

Use uppercase entity/action-past-tense names consistently. The milestone column records assigned scope; Item, Handoff and Talk events are implemented; later events remain planned.

| Event kind                     | Planned milestone | Purpose                                                      |
| ------------------------------ | ----------------- | ------------------------------------------------------------ |
| `ITEM_ADDED`                   | v0.1.0            | Add an item with stable item ID and text.                    |
| `ITEM_COMPLETED`               | v0.1.0            | Mark an existing item completed.                             |
| `ITEM_REOPENED`                | v0.2.0            | Reopen a completed item; active is a valid no-op.            |
| `ITEM_ARCHIVED`                | v0.2.0            | Tombstone an active/completed item without deleting history. |
| `HANDOFF_ADDED`                | v0.3.0            | Add a short household handoff.                               |
| `HANDOFF_ACKNOWLEDGED`         | v0.3.0            | Record receipt of a handoff.                                 |
| `HANDOFF_ARCHIVED`             | v0.3.0            | Archive a handoff.                                           |
| `TALK_ADDED`                   | v0.4.0            | Capture a topic for later discussion.                        |
| `TALK_RESOLVED`                | v0.4.0            | Mark a Talk item resolved.                                   |
| `TALK_REOPENED`                | v0.4.0            | Reopen a resolved Talk item.                                 |
| `TALK_ARCHIVED`                | v0.4.0            | Archive a Talk item.                                         |
| `PULSE_SET`                    | v0.5.0            | Set time-bounded capacity context, including expiry.         |
| `PULSE_CLEARED`                | v0.5.0            | Clear current Pulse context.                                 |
| `ROUTINE_CREATED`              | v0.7.0            | Define a recurring household need.                           |
| `ROUTINE_OCCURRENCE_COMPLETED` | v0.7.0            | Complete a routine occurrence.                               |
| `ROUTINE_OCCURRENCE_REOPENED`  | v0.7.0            | Reopen a routine occurrence.                                 |
| `ROUTINE_ARCHIVED`             | v0.7.0            | Archive a routine definition.                                |
| `AREA_CREATED`                  | v0.15.0           | Create a stable-ID household Area with a display name.       |
| `AREA_RENAMED`                  | v0.15.0           | Change an Area's display name without changing its identity. |
| `AREA_ARCHIVED`                 | v0.15.0           | Retain the Area and its assignments as historical context.   |
| `ITEM_AREA_CHANGED`             | v0.15.0           | Set or clear an Item's optional Area assignment.              |
| `ITEM_STEP_ADDED`               | v0.17.0           | Append a bounded ordered Step to an active Item.              |
| `ITEM_STEP_COMPLETED`           | v0.17.0           | Complete an active Step without completing its Item.         |
| `ITEM_STEP_REOPENED`            | v0.17.0           | Reopen a completed Step.                                     |
| `ITEM_STEP_ARCHIVED`            | v0.17.0           | Terminally archive a Step while retaining its history.        |
| `PIN_ADDED`                      | v0.26.0           | Pin an existing stable household entity ID for quick access.  |
| `PIN_REMOVED`                    | v0.26.0           | Remove an existing entity from the ordered Pins projection.   |
| `PLAYBOOK_SAVED`                  | v0.27.0           | Create or edit an ordered reusable checklist template.        |
| `PLAYBOOK_ARCHIVED`               | v0.27.0           | Retain a Playbook as an archived template.                    |
| `REFERENCE_RECORD_SAVED`          | v0.30.0           | Create or edit a bounded household reference card.             |
| `REFERENCE_RECORD_ARCHIVED`       | v0.30.0           | Retain a reference card as an archived record.                 |
| `MAINTENANCE_EVENT_SAVED`         | v0.31.0           | Add or correct a factual maintenance event for a Reference Record. |
| `MAINTENANCE_EVENT_ARCHIVED`      | v0.31.0           | Archive a maintenance event while retaining its history.       |
| `HOUSEHOLD_MODE_CHANGED`        | v0.21.0           | Set the explicit household-wide mode.                         |
| `ITEM_PLANNING_DATE_CHANGED`    | v0.22.0           | Set or clear an Item's optional fixed civil planning date.     |
| `DEVICE_DESCRIBED`              | v1.1.0            | Record the automatic name a device reports for itself.         |
| `DEVICE_NICKNAMED`              | v1.1.0            | Set or clear the nickname a member gives one of their devices. |
| `CHAT_MESSAGE_POSTED`           | v1.1.0 (chat log) | Post a chat message whose content is a separate encrypted blob. |
| `CHAT_MESSAGE_EDITED`           | v1.1.0 (chat log) | The author replaces a text message's content blob.             |
| `CHAT_MESSAGE_DELETED`          | v1.1.0 (chat log) | The author deletes a message for everyone, or an admin removes it. |
| `HOUSEHOLD_CREATED`            | v0.8.0            | Establish a household identity when pairing is introduced.   |
| `MEMBER_INVITED`               | v0.8.0            | Record a member invitation.                                  |
| `MEMBER_JOINED`                | v0.8.0            | Record accepted household membership.                        |
| `MEMBER_REMOVED`               | v0.8.0            | Record explicit member removal.                              |
| `DEVICE_AUTHORIZED`            | v0.8.0            | Authorize a device for a member.                             |
| `DEVICE_REVOKED`               | v0.8.0            | Revoke a device's future authorization.                      |
| `AGREEMENT_CREATED`            | Unscheduled       | Record a deliberately created agreement.                     |
| `AGREEMENT_REVISED`            | Unscheduled       | Record a deliberate revision.                                |
| `AGREEMENT_ARCHIVED`           | Unscheduled       | Archive an agreement.                                        |

“Since You Last Looked” is a derived view of events, not a new event kind. v0.4.x supports Item kinds 1–4, Handoff kinds 5–7 and Talk kinds 8–11. Handoff/Talk kinds use schema 1; later kinds are deferred. Existing event kind codes remain unchanged. Event schema v1 `ITEM_ADDED` contains no classification and normalizes to Today. Schema v2 `ITEM_ADDED` adds a fixed classification byte (`0 = Today`, `1 = Need`, `2 = Shopping`, `3 = Staple`); protocol 13 enables code 2 and protocol 14 enables code 3. The three reserved bytes and text-length field remain unchanged. New instances write schema v2 for adds and schema v1 for the other Item events. Protocol and event version compatibility is specified in [ABI](ABI.md) and [VERSIONING](VERSIONING.md). The unscheduled agreement events are not a release commitment.

Step event kinds use the additive schema-1 codes 25–28. An add contains both
the parent Item ID and stable Step ID plus bounded plain text; the other three
events contain both IDs. Protocol 11 carries Steps in the derived result and
canonical event records through the existing encrypted event path. Older
protocols reject these kinds instead of skipping them.

## Immutability and corrections

Once persisted, an event is immutable. Correct or reverse a prior fact by appending a later event, never by rewriting the old event. For example:

```text
ITEM_ADDED
ITEM_COMPLETED
ITEM_REOPENED
```

This preserves replay, history, offline synchronization, derived change summaries, and auditable conflict handling. Event retention and user-requested data deletion remain explicit privacy concerns; see [Privacy](PRIVACY.md).

## Identity and ordering

Event IDs must be opaque and collision-resistant across independent offline devices; sequential database IDs alone are not suitable as the global identity. A duplicate ID with byte-identical canonical content is a repeated delivery and is ignored after its first application. The same ID with different content is a deterministic integrity error, not a last-write-wins replacement.

For v0.1.0, events are replayed in persisted `local_sequence` order. A single IndexedDB read/write transaction over `events` and `local_context` reads the current full event stream and logical counter, builds the candidate event, synchronously asks Rust to validate/replay that candidate stream, then appends the event and advances the counter before the transaction completes. The event is not visible as accepted until transaction completion. IndexedDB serializes overlapping read/write transactions, so tabs cannot independently reserve the same local order. `local_sequence` and `logical_time` both reflect committed local append order; the counter update and append either both commit or both abort. Timestamps never reorder the local log.

For future sync, retain originating device identity and logical time. The initial ordering requirement is a deterministic total tie-break tuple `(logical_time, device_id, event_id)` using a fixed bytewise ordering for IDs. Causally later events must have a greater logical time than events their author has observed. Equal logical times represent concurrent events; the device and event IDs make replay order stable, but do not themselves resolve semantic conflicts. Conflict policy is planned for v0.0.5.

Wall clocks can drift, collide, or move backward, so timestamps are never the distributed ordering authority. This ordering direction is a requirement to validate during the protocol design, not a claim that sync exists in v0.1.0.

## Idempotency and invalid events

- Re-delivery of an identical `event_id` and identical canonical event is ignored; replaying it has no additional effect.
- Reuse of an `event_id` with different content is invalid and fails reconstruction deterministically.
- A distinct `ITEM_COMPLETED` for an already-completed known item is a valid state no-op; both valid facts remain in history. This makes completion robust to repeated user intent without rewriting prior events.
- `ITEM_COMPLETED`, `ITEM_REOPENED`, or `ITEM_ARCHIVED` for an unknown item is invalid.
- `ITEM_REOPENED` on an active item is a valid state no-op; archival is terminal and every ordinary mutation of an archived item is invalid.
- Duplicate `ITEM_ADDED` for an existing item ID is invalid unless it is the exact same event already deduplicated by event ID.
- Malformed payloads, impossible field values, cross-household events, and unsupported event schema versions are invalid.
- An unknown event kind is not silently skipped. A client that cannot interpret an event must stop reconstruction with a deterministic unsupported-event error and preserve stored bytes for recovery by compatible software.

Event schema evolution must not rewrite history merely because the current internal model changes. Use explicit supported-version decoders and preserve canonical source bytes; unsupported newer events fail closed without destructive reinterpretation. Migration and forward-compatibility rules are detailed in [VERSIONING](VERSIONING.md) and [MIGRATIONS](MIGRATIONS.md).

Invalid input must not yield partially mutated visible state. The reducer returns an error for the failed stream; storage remains unchanged until an explicitly designed recovery action exists. See [State](STATE.md) for reconstruction semantics.

## v0.4.0 Talk

Stable schema-1 codes: 8 TALK_ADDED, 9 TALK_RESOLVED, 10 TALK_REOPENED, 11 TALK_ARCHIVED. Add payload is talk_id[16], text_length:u32, strict UTF-8 text (1–4096 bytes, nonblank). Lifecycle payloads are exactly talk_id[16]. Codes 1–7 and their canonical bytes are unchanged. Exact duplicate delivery is idempotent; conflicting event identity and duplicate Talk identity fail. See [V0.4.0](V0.4.0.md).

## v0.5.0 Pulse

Schema-1 codes 12 PULSE_SET (value:u8, reserved[7]=0, expires_at:i64; 16 bytes) and 13 PULSE_CLEARED (empty). Actor and set_at come from the envelope. Codes 1–11 unchanged; no expiry/acknowledgement event. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

No domain event kinds are added. Codes 1–13 and their persisted bytes remain unchanged. Summary entries are derived in Rust protocol v6 from existing Item, Handoff, and Talk events; Pulse remains excluded from entries while still contributing to the exact through-event boundary. Viewing or marking the local summary never appends a household event. See [V0.6.0](V0.6.0.md).

## v0.7.0 Routines

Schema-1 codes 14 ROUTINE_CREATED, 15 ROUTINE_OCCURRENCE_COMPLETED, 16 ROUTINE_OCCURRENCE_REOPENED, 17 ROUTINE_ARCHIVED. Creation persists text/cadence/creation civil date; occurrence actions persist a deterministic date key. Cadence values 0/1 are Daily/Monday-start Weekly; protocol 12 additionally supports 2 (every two weeks anchored to creation date) and 3 (calendar month start); protocol 24 adds 4 (Weekdays: one occurrence per Monday–Friday civil date, none at the weekend, keys on or after creation). No reset or automatically created occurrence event. Archive is terminal. The earlier conceptual ROUTINE_COMPLETED name never had a persisted wire code and is replaced by occurrence-specific naming. See [V0.7.0](V0.7.0.md) and [V0.18.0](releases/V0.18.0.md).

## v0.15.0 Areas

Area kinds 18–21 use event schema 1 and require replay protocol 9. Area IDs are
stable 128-bit identifiers. Names are trimmed at Unicode whitespace; empty,
control-bearing, over-96-byte, or over-48-Unicode-scalar names are invalid.
Commands reject case-insensitive duplicate names after trimming, including
archived names. Concurrent offline create/rename facts with matching display
names remain separate IDs during replay; the reducer never silently merges
them. The UI suffixes their labels with a short stable-ID fragment until a
member renames one.

`AREA_ARCHIVED` changes availability, not history. Existing `ITEM_AREA_CHANGED`
associations remain. A current command rejects a known archived Area, while a
stale offline assignment authored before observing the archive remains
replayable after sync. Protocol 9 deterministic ordering gives both devices
the same projection. Clearing an assignment is `ITEM_AREA_CHANGED` with the
reserved all-zero optional Area ID; zero is not a valid Area identity. There is
no Area deletion event.

## v0.9.x Distributed Canonical Events

Sync encrypts the exact canonical event bytes; it does not create a semantic JSON event record or rewrite pre-sync identity headers. New synchronized events embed authenticated household/member/device IDs. Historical local placeholder IDs are resolved by a separately signed, encrypted identity-binding control record, supplied to protocol v8 as verified context; source `canonical_bytes` remain exact. Event IDs remain stable 128-bit random identifiers and identify logical events independently of server cursors.

Protocols v1-v7 preserve their legacy strict increasing logical-time behavior. Protocol v8 accepts equal logical times and sorts a copy for state replay by `(logical_time, effective device_id bytewise, event_id bytewise)`. The decoded/input event array retains local arrival order for catch-up summary boundaries; transport cursor and UI acknowledgement cursor are separate. The local logical clock advances beyond the maximum observed event before authoring a causally later event.

Concurrent completion/reopen retains both facts and uses deterministic replay order for projection. Archive wins over an equal-Lamport concurrent mutation from another device; the losing mutation remains stored and is a state no-op. A mutation with greater logical time after the author observed archive is invalid and pauses replay. Duplicate delivery of identical event ID and bytes applies once; same ID with different bytes/envelope is corruption. See [V0.9.0](V0.9.0.md) and [ABI](ABI.md).

## v0.21.0 Household Modes

`HOUSEHOLD_MODE_CHANGED` is schema 1, event kind 29, with one payload byte:
0 Normal, 1 Vacation, 2 Guests, or 3 Rest. A history without a mode event
projects Normal. Distinct concurrent changes are retained and resolve by the
existing protocol-15 distributed ordering tuple; exact duplicate event
delivery is idempotent. The event has no entity ID, schedule, duration, or
automatic actor.

## Item completion and reopening preconditions

A new `complete-item` command requires the Item to be active, and `reopen-item`
requires it to be completed. Rust checks this against the full local history
inside the adapter's append transaction and rejects a stale intent with code 4,
so repeated or stale intents (a second tab, a bulk action, its undo) append
nothing. Replay is unchanged: historical duplicate `ITEM_COMPLETED` or
`ITEM_REOPENED` facts from older clients or other devices remain idempotent
no-ops. No event layout, protocol version, or storage format changes.

## v1.1.0 Device names

`DEVICE_DESCRIBED` (kind 42) and `DEVICE_NICKNAMED` (kind 43) are schema 1
and were added without changing replay protocol 24 ([ABI](ABI.md) has the
payloads). They keep device names inside the encrypted household history, so
the server never learns a name anyone typed ([PRIVACY](PRIVACY.md),
[IDENTITY](IDENTITY.md#device-names)).

- Names are cosmetic, so a decoded device-name event never fails replay. An
  event that conflicts with what a history knows is kept and changes nothing;
  commands enforce the rules below when the event is created.
- A description names the event's own header device. The device belongs to
  the member who first described it; a later description of it by another
  member changes nothing. A device describes itself again when its automatic
  name changes (a browser update, an installed app), and the latest
  description wins.
- A nickname targets a device by ID, and only that device's member may set
  it, from any of their devices. An empty nickname clears it, and the latest
  nickname wins. Within one history the naming device has seen the
  description, so the nickname replays after it. But a member who joined
  later never receives descriptions made before they joined, so their history
  can hold a nickname for a device it has never seen described. Replay keeps
  that as a nickname-only entry owned by its author (clearing that nickname
  removes the entry, and clearing an unknown device's nickname changes
  nothing). A later description by
  the same member completes it; one by another member wins and drops the
  nickname.
- Names are canonical in the event: trimmed, at most 48 characters for an
  automatic name and 32 for a nickname, with no control characters and no
  disguising format characters. Anything else is a malformed event.
- Device names never appear in the KINS projection or the catch-up summary.
  Hosts read them with `kin_device_names`.
- A v1.0 engine does not know these kinds. It stops at the first one with the
  unsupported-event error above and syncs again once updated
  ([V1.0-COMPATIBILITY](V1.0-COMPATIBILITY.md)).

## v1.1.0 Household chat

`CHAT_MESSAGE_POSTED` (44), `CHAT_MESSAGE_EDITED` (45) and
`CHAT_MESSAGE_DELETED` (46), and `CHAT_REACTION_SET` (47) are schema 1 and leave replay protocol 24
unchanged ([ABI](ABI.md) has the payloads; [ADR 0008](decisions/0008-household-chat.md)
the product decisions).

- **Their own log.** Chat events live in the chat log, never in the
  household history. Each refuses the other's events (code 4), so chat never
  counts against the household's 10,000 events and a household request never
  carries chat. The chat log holds up to 250,000 events.
- **Metadata only.** An event carries the message ID, the content blob's
  32-byte SHA-256 reference and its 32-byte random key, and (for a post) the
  content kind: text or attachment. Text and files live in the blob, outside
  the log, so deleting a message can delete its content.
- **Conflicts change nothing shown.** As with device names, a decoded chat
  event never fails replay. One that conflicts with what a log knows is kept
  and changes nothing a page shows; commands enforce the rules when the event
  is created. The first post of a message ID wins. Only the author edits,
  only a text message, never a deleted one. The author deletes for everyone;
  deletion is terminal, so it wins over an edit at the same logical time in
  either replay order.
- **Blob references.** Honest devices never repeat a blob reference (each
  is a content hash under a random key), and commands refuse one the log has
  seen. Replay doesn't rely on that: logical times are the author's to
  write and every chat member can read every reference, so a modified client
  could copy one into an earlier-dated event. A reused reference applies like
  any other, and a blob a visible message shows is never retired. A copy can
  only show the content again as its author's own message; it can't hide or
  delete the original. It can keep a deleted message's blob from being
  retired while the copy is visible, which adds nothing: whoever made it
  already held the key and the bytes.
- **Retired blobs.** Hosts delete these locally and on the service. The
  candidates are every blob an edit replaced or the author's deletion
  dropped, and every blob brought by an event that applies nowhere (a second
  post of an existing ID, another member's edit, an edit of an attachment,
  an edit after or concurrent with the author's deletion). A page retires
  each candidate, and each blob of a message removed by a named admin, once
  and only while no live or edited message shows it. An edit of a message
  the log doesn't hold keeps its blob, since where the message is known the
  edit may apply. An edit to the blob a message already has changes
  nothing.
- **Admin removal is a claim.** `by_admin` set on another member's message
  records a claim. Only the service knows who is an admin, so a page counts
  the claim when the host names its author among the household's admins;
  the message then shows "Removed by an admin" and its blob is retired. The
  host names the admins to commands too (`kin_chat_execute`), so Kin's own
  clients only make a claim as a current admin. A claim is counted while its
  author is an admin, whenever it was made: one written by a modified client
  before its author became an admin counts once they are one, and one whose
  author stops being an admin stops counting (the message reads as live
  again, but its blob has usually been deleted by then, so its content stays
  gone).
- **Text rules.** A message's decrypted text is checked in Rust when the host
  hands it over: 1 to 4,000 Unicode scalar values, valid UTF-8, not only
  whitespace, and no control characters other than tab and line feed. It is
  plain text, rendered with `textContent`.
- **Reactions (#127).** `CHAT_REACTION_SET` (47) turns one emoji on or off
  for the event's actor on one message. The emoji is a single grapheme from
  the emoji ranges (a pictograph with optional variation selector and skin
  tone, a flag, a keycap, or such parts joined by zero-width joiners), at
  most 32 bytes, checked in Rust (`chat::check_emoji`); an event with
  anything else is malformed. Replay order is total, so the last write per
  (member, message, emoji) wins, and a member's devices converge. A
  reaction to a message the log lacks changes nothing. A page leaves out the
  reactions of a message it shows as deleted or removed, and lists the rest
  grouped by emoji in the order replay first saw them. Commands refuse a
  reaction that would change nothing and a 25th different emoji on one
  message; replay applies the same cap, so a log can't grow one message
  without bound. A joiner joins only pictographs, never flags or keycaps.
- Chat never appears in the KINS projection or the catch-up summary. Hosts
  read it with `kin_chat_page`.
- An engine older than v1.1 does not know these kinds and rejects them with
  the unsupported-event error (code 3), rather than dropping them.

## v0.22.0 Lightweight Planning Dates

`ITEM_PLANNING_DATE_CHANGED` is schema 1, event kind 30, with a 20-byte
payload: 16-byte Item ID and a little-endian `u32` civil date. Values 00010101
through 99991231 must represent valid Gregorian dates; zero clears the date.
The event has no timestamp semantics beyond the ordinary envelope and stores
no time zone or reminder. Event updates remain replayable after archival when
authored offline; UI command validation rejects new changes to archived Items.
# Logical time bounds

Event logical time is a positive integer no greater than `9,007,199,254,740,991`
(the largest JavaScript safe integer). A replayed event may advance the current
maximum by at most `1,000,000`. Rust replay, browser storage and the sync relay
enforce the same ceiling; replay uses checked, deterministic integer arithmetic.
This keeps canonical history interoperable and prevents one trusted device
from exhausting the clock with a single event. Existing histories within these
bounds remain valid.
