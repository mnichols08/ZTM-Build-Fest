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
| `MEMBER_NAMED`                  | v1.3.0            | Set or clear a member's own preferred display name.            |
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

## Member preferred names

`MEMBER_NAMED` (kind 51, #224) is schema 1 and was added in v1.3.0 without
changing replay protocol 24 ([ABI](ABI.md) has the payload). Like device
names it lives only inside the encrypted household history, so the relay never
learns it ([PRIVACY](PRIVACY.md), [IDENTITY](IDENTITY.md#preferred-member-names)).

- The name always belongs to the event's own header actor (after identity
  bindings). There is no target, so no member can name another.
- An empty name clears it, and the member falls back to their existing label.
  The latest event in replay order (logical time, device, event ID) wins, so
  every device converges whatever order events arrive in; an exact duplicate
  is skipped. Renames from any of a member's devices are just later events, so
  the history keeps every earlier name.
- Names are canonical in the event: trimmed, 1–32 characters, no control
  characters and no disguising format characters. Anything else is a malformed
  event. Commands also reject a name that would change nothing.
- A preferred name is presentation only. It never changes a member ID, role,
  device trust, event authorship or push filtering, and it never appears in
  the KINS projection or the catch-up summary. Hosts read names with
  `kin_member_names`.
- A v1.0 engine does not know these kinds. It stops at the first one with the
  unsupported-event error above and syncs again once updated
  ([V1.0-COMPATIBILITY](V1.0-COMPATIBILITY.md)).

## The family fridge

Kinds 52–58 (#317, [ADR 0011](decisions/0011-family-fridge.md)) are schema 1
and live only in the board log, a third log beside the household history and
chat with its own cap (250,000 events), checkpoint and relay stream. Every log
refuses the others' kinds, so these never enter household replay, the KINS
projection or the catch-up summary. Coordinates are a fixed 3:4 board: x
0–4095, y 0–5460. IDs are never zero; reserved bytes are zero.

| Kind | Name | Payload |
|---|---|---|
| 52 | `BOARD_STROKE_ADDED` | stroke ID, colour u8 (0–7), width u8 (0–2), point count u16 (1–1,024), first x u16, first y u16, then per further point dx and dy as zigzag LEB128 varints (minimal, at most 3 bytes); every point stays on the board; at most 4,096 bytes |
| 53 | `BOARD_STROKE_HIDDEN` | stroke ID, hidden u8 (1 erase, 0 restore), 7 reserved |
| 54 | `BOARD_MAGNET_PLACED` | magnet ID, content kind u8 (1 emoji, 2 Kin-drawn, 3 note), Kin number u8 (1–12 for kind 2, else 0), x u16, y u16, text length u16, text (one emoji; empty; or a canonical note: trimmed, 1–60 characters, at most 240 bytes, no control characters) |
| 55 | `BOARD_MAGNET_MOVED` | magnet ID, x u16, y u16, 4 reserved |
| 56 | `BOARD_MAGNET_HIDDEN` | magnet ID, hidden u8, 7 reserved |
| 57 | `BOARD_CLEARED` | clear ID |
| 58 | `BOARD_CLEAR_UNDONE` | clear ID |

Replay (rust/src/board.rs) never fails on a decoded board event:

- The first add of an ID wins. An add beyond the visible budget (2,000 strokes,
  200 magnets) is kept and never shown.
- Erase and remove are visibility: the latest hide or restore in replay order
  wins, and anyone may erase any stroke or move any magnet. A move puts the
  magnet on top.
- A clear hides everything visible and records what it hid; undoing it shows
  exactly those again unless they were hidden since. Showing anything again
  never exceeds the budget.
- An event naming a stroke, magnet or clear the log lacks changes nothing.
- Commands are stricter: a new ID, room in the budget, a change that changes
  something, and a logical time after the board log's latest.

## A member's private log

Kinds 100–199 (#489, [ADR 0019](decisions/0019-member-private-log.md)) are
reserved for records only one member's devices can read. They live only in
that member's private log, a fourth log beside the household history, chat
and the fridge, with its own cap (50,000 events) and checkpoint, sealed under
the member key and relayed in the member's own stream. Every other log
refuses them, so they never enter household replay, the KINS projection, the
catch-up summary, household search or household exports.

| Kind | Name | Payload |
|---|---|---|
| 100 | `PRIVATE_NOTE_SET` | note ID, text length u32 (0 removes it; at most 2,048 bytes), text (line feeds allowed, no other control characters) |
| 120 | `REMINDER_SET` (#522) | target kind u8 (1 item, 2 routine), target ID, due instant (Unix ms, UTC), the setter's UTC offset in minutes (−720 to 840) and IANA time zone (0–64 ASCII bytes; empty when unknown) |
| 121 | `REMINDER_CLEARED` (#522) | target kind, reason u8 (1 canceled, 2 done, 3 dismissed), target ID, the instant it clears |
| 130 | `SETTING_SET` (#525) | key u16 (1–255), value (0–32 bytes of `a-z 0-9 -`; empty unsets the key) |

Kind 100 is a placeholder that proves the log end to end; the journal (#496)
and "Just for me" (#510) add their own kinds and replace it if they need to.
Codes 120–129 belong to reminders and 130–139 to settings (#520,
`rust/src/private_prefs.rs`). Replay (`rust/src/private.rs`) never fails on
a decoded private event, except that every event in one log must have the
same author: the latest note for an ID in replay order wins, and empty text
removes it.

**Reminders and settings that follow a member (#520).** A reminder is keyed
by the item or routine it is about, so a member has at most one per thing
and setting it again (on any device) moves it; that keeps the one-time move
of a device's own reminders into the log free of duplicates. It keeps an
absolute instant, so every device fires at the same moment whatever its
zone, and the setter's zone and offset only to say "9:00 where it was set".
Replay order (logical time, then device ID, then event ID) decides, never a
device clock:

- `REMINDER_SET` replaces the thing's reminder.
- `REMINDER_CLEARED` for "canceled" removes it whatever its instant; "done"
  and "dismissed" remove it only while it is still set for the instant they
  name, so a dismissal of 9:00 that arrives after someone moved it to 10:00
  leaves 10:00.
- `SETTING_SET` is last-writer-wins per key: the latest in replay order
  wins (by logical time, then device ID), and an empty value unsets the key.
  Keys 1 `theme-mode` (household, system, light, dark), 2 `theme-color`
  (household, default, `preset-` or `custom-` and six lowercase hex digits),
  3 `text-size` (standard, large, larger), 4 `motion` (system, reduce), 5
  `reminder-alerts` (on, off), 6 `app-badge` (off, messages,
  messages-and-mine) and 7 `private-on-today` (on, off; reserved for #510)
  take only those values; any other key takes any token, so an older engine
  keeps a later release's settings unchanged.

Commands (`kin_private_execute`) must change something: a reminder set
exactly as it is, a clear of a thing with no reminder (or a done or dismissed
for an instant it no longer has), or a setting set to its current value is
refused with code 4.

## Meals

Kinds 59–63 (#333, [ADR 0012](decisions/0012-meals.md)) are schema 1 events in
the household history. IDs are never zero, reserved bytes are zero, flags are
0 or 1, and text is canonical in the event (whitespace runs collapsed and
trimmed; notes keep their lines, with CRLF as LF and trailing spaces gone).
Payloads are laid out in [ABI](ABI.md).

| Kind | Name | Meaning |
|---|---|---|
| 59 | `RECIPE_SAVED` | A recipe saved whole: name (1–80 characters), up to 40 ingredient lines (1–120 characters each, optionally linked to a Staple item), notes (up to 2,000 characters). At most 4,352 bytes after the ID, so one recipe fits one sync envelope |
| 60 | `RECIPE_ARCHIVED` | The recipe leaves the recipe list for good |
| 61 | `DINNER_SET` | The dinner for one civil date: a recipe with its name when planned, or a one-off name |
| 62 | `DINNER_CLEARED` | That date has no dinner (and no cook) |
| 63 | `DINNER_COOK_SET` | Who's cooking on that date; no member is "No one yet" |

Replay (rust/src/meals.rs) never fails on a decoded meals event:

- A recipe's latest save wins; an archived recipe stays archived and later
  saves of it change nothing.
- One dinner per date: the latest `DINNER_SET` in replay order wins, so two
  devices that planned the same evening offline converge. `DINNER_CLEARED`
  removes the dinner and its cook.
- The cook is kept per date apart from the dinner, so replanning keeps it; it
  shows only while the date has a dinner.
- A dinner naming a recipe the history lacks, and an archive of an unknown
  recipe, change nothing.
- Commands are stricter: at most 200 active recipes, a staple link to an
  active Staple (a link the recipe already had may stay after its staple is
  archived), a dinner naming an active recipe by its current name, a cook only
  for a date with a dinner, and every change must change something.

Nothing here is counted or compared: who cooked is never totalled. Meals are
not part of the KINS projection; hosts read them through `kin_meals` and plan
Shopping additions through `kin_meal_shopping_plan`.

## Item pictures (Simple view)

Kind 64 (#344, [ADR 0013](decisions/0013-simple-view.md)) is a schema 1 event
in the household history:

| Kind | Name | Meaning |
|---|---|---|
| 64 | `ITEM_EMOJI_SET` | An item's picture emoji (one grapheme, validated as a chat reaction), or none to clear it |

Replay (rust/src/simple.rs) never fails on a decoded emoji event: the latest
one for an item wins, and an emoji for an item the history lacks, or one that
is archived, is kept but never reported. Commands are stricter: the item
exists and isn't archived, and the change changes something. The emoji sits
beside an item's text and never replaces it. Hosts read emoji through
`kin_item_emojis` and a member's things today through `kin_my_things`; neither
is part of the KINS projection. Older devices pause sync with "unsupported"
and keep their data until they update.

## Store sections (Shopping)

Kinds 66 and 67 (#411, [ADR 0015](decisions/0015-store-sections.md)) are
schema 1 events in the household history:

| Kind | Name | Meaning |
|---|---|---|
| 66 | `SHOPPING_SECTIONS_SET` | The household's whole ordered list of store sections (0–30, each a stable ID and a name of 1–40 UTF-8 bytes), replacing the previous list |
| 67 | `ITEM_SECTION_SET` | An item's store section, or none (an all-zero section ID) to clear it |

Replay (rust/src/store_sections.rs) never fails on a decoded event. The
latest list in replay order wins; a section left out is gone. The latest
section event for an item wins, and an item whose section is no longer listed
(or never was) shows under none; its event is kept, so listing that section
ID again brings the item back. The payloads are strict: at most 30 sections,
non-zero and unique IDs, names already trimmed, 1–40 bytes, no control
characters. Commands are stricter: no two names equal ignoring case, the list
must change; an item's section needs the item to exist and not be archived,
the section to be in the current list (or none), and a change. Sections are
not areas: an item keeps its area. Hosts read sections through
`kin_shopping_sections`, which is not part of the KINS projection. Older
devices pause sync with "unsupported" and keep their data until they update.

## Taking turns on routines

Kinds 68 and 69 (#429, [ADR 0016](decisions/0016-routine-rotations.md)) are
schema 1 events in the household history:

| Kind | Name | Meaning |
|---|---|---|
| 68 | `ROUTINE_ROTATION_SET` | A routine's rotation: an ordered list of 2–12 distinct members and the index whose turn it is, replacing the previous one; an empty list ends it |
| 69 | `ROUTINE_TURN_SET` | It's this listed member's turn on the routine now (Skip to next, Swap with…) |

Replay (rust/src/rotations.rs, applied from replay/routines.rs) fails only
for a routine the history lacks. A rotation or turn for an archived routine,
and a turn naming a member the rotation no longer lists (or a routine with no
rotation), are recorded with no effect. When `ROUTINE_OCCURRENCE_COMPLETED`
newly completes an occurrence of a rotating routine, the turn moves to the
next member in the list and that occurrence key is remembered; a duplicate
completion of an occurrence already complete (two devices offline) changes
nothing, so the turn moves once. `ROUTINE_OCCURRENCE_REOPENED` of the
remembered occurrence (Undo) moves the turn back one and forgets it;
reopening any other occurrence changes nothing. Setting a rotation or a turn
forgets the key too.

While a rotation is set, replay keeps the routine's responsibility equal to
the current member, so KINS, This week and "my things today" show the
current member as the owner. Ending the rotation writes nothing else: the
last current member stays the owner as an ordinary responsibility. A
`RESPONSIBILITY_CHANGED` for a rotating routine is recorded with no effect
(commands refuse it). Rust counts every listed member as taking turns:
membership (removed or expired members) is not in the history, so the host
passes over inactive members when it shows the turn, shows no current turn
with fewer than two active, and moves the turn on with a `ROUTINE_TURN_SET`
when the current member isn't active. No count of turns per member exists.
Hosts read rotations through `kin_routine_rotations`, which is not part of
the KINS projection. Older devices pause sync with "unsupported" and keep
## The sitter page

Kind 70 (#442, [ADR 0017](decisions/0017-sitter-page.md)) is a schema 1 event
in the household history:

| Kind | Name | Meaning |
|---|---|---|
| 70 | `SITTER_PAGE_SET` | The household's page for Temporary members: an intro (0–500 UTF-8 bytes, empty for none) and an ordered list of up to 30 entries, each a note, reference record or routine by ID, replacing the previous page |

Replay (rust/src/sitter.rs) never fails on a decoded event; the latest page
in replay order wins. An entry whose record is archived, unknown, or of
another kind is kept in the event but skipped when the page is read, so it
shows again if that record appears later. The payload is strict: at most 30
entries, kinds 1–3, non-zero IDs, no entry twice, the intro already trimmed
with no control characters but newline. Commands are stricter: every entry
names a record that exists and isn't archived, and the page must change.
Only Adults may set it; the host checks that, because replay doesn't know
member kinds. Entries point at records and copy nothing, so editing a note
updates the page. Hosts read it through `kin_sitter_page`, which is not part
of the KINS projection. Older devices pause sync with "unsupported" and keep
their data until they update.

## v1.1.0 Household chat

`CHAT_MESSAGE_POSTED` (44), `CHAT_MESSAGE_EDITED` (45) and
`CHAT_MESSAGE_DELETED` (46), `CHAT_REACTION_SET` (47), `CHAT_PIN_SET` (48), `CHAT_POLL_VOTE` (49), `CHAT_POLL_CLOSED` (50) and `CHAT_TOPIC_SET` (65) are schema 1 and leave replay protocol 24
unchanged ([ABI](ABI.md) has the payloads; [ADR 0008](decisions/0008-household-chat.md)
the product decisions).

- **Their own log.** Chat events live in the chat log, never in the
  household history. Each refuses the other's events (code 4), so chat never
  counts against the household's 10,000 events and a household request never
  carries chat. The chat log holds up to 250,000 events.
- **Metadata only.** An event carries the message ID, the content blob's
  32-byte SHA-256 reference and its 32-byte random key, and (for a post) the
  content kind: text, attachment or poll. Text and files live in the blob, outside
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
- **Replies (#129).** A post may name the message it answers. The event
  carries only that ID; the quoted text is looked up from the original each
  time a page is read, so an edit shows and a deletion turns the quote into
  "deleted" (and the original's blob and text are gone with it). Replay
  stores the ID and never checks it against the log (a zero ID or a message
  answering itself is malformed and refused at decode): the original may be
  absent from a log (a member who joined later), and the page then marks it
  unknown. A quote carries the original's first non-blank line, at most 256
  bytes.
  Commands answer only a message that still shows. There are no threads.
- **Mentions (#130).** A post (44) or edit (45) may carry mentions after its
  fixed fields: flags u8 (1 everyone, 2 a reply ID follows), count u8 (at
  most 20), that many member IDs (ascending, unique, 16 bytes each), then the
  reply ID if flagged. Older events with nothing, or with just a reply ID,
  still decode. The command is refused unless every named member is one the
  host lists as able to read chat; replay does not check. An edit replaces
  the message's mentions. The text is not changed: the mention is only a
  record of who the writer meant.
- **Voice messages (#134).** An attachment message (content kind 2) whose
  manifest holds one audio file with a `voice` entry. No event, kind or
  payload byte changes; the engine only reduces samples to a waveform
  (`kin_audio_peaks`, [ABI](ABI.md)).
- **Polls (#135).** A post whose content kind (payload byte 16) is 3 is a
  poll: byte 17 is the option count (2–10) and byte 18 is 1 for multiple
  choice (both zero for other kinds); the question and options are in the
  sealed blob like any text. `CHAT_POLL_VOTE` (49) carries the message ID, the
  choice as a u16 bit set and 2 reserved zero bytes (20 bytes); the later vote
  of a member (by logical time, then device ID, then event ID) replaces the earlier, 0 clears.
  A vote is ignored if the message is not a poll, if the choice is not one the
  poll allows, or if it comes after the author's close. `CHAT_POLL_CLOSED`
  (50) carries the message ID and 4 reserved bytes; only the poll's author
  closes it, and the first close stands. Deleting the poll for everyone drops
  its votes.
- **Talk later (#312, [ADR 0014](decisions/0014-talk-later.md)).**
  `CHAT_TOPIC_SET` (65) sets where one message stands on the "To talk
  about" list: payload is the message ID, `state` u8 (0 cleared, 1 open, 2
  resolved) and 3 reserved zero bytes (20 bytes). It is a chat event, so it
  lives only in the chat log, under the chat key, and a member without chat
  access never receives it. Replay keeps topics in the order first listed,
  with who flagged each (the first actor since it was last cleared) and who
  last changed it: the latest event in replay order wins whatever came
  before, so an open or resolved event on a message with no topic lists it,
  the same state again changes nothing, and cleared drops the topic. A topic
  on a message the log lacks or that its author deleted changes nothing, and
  the author's deletion drops the topic; an admin's removal is only known to
  the service, so a page leaves the topic out while a named admin has removed
  its message. At most 200 open or resolved topics are kept (`MAX_TOPICS`);
  a new one past that changes nothing. Commands are stricter: open needs a
  message that shows and no topic or a resolved one, and room under the
  limit; resolved needs an open topic and a message that shows; cleared
  needs a topic on a message not deleted. A command that would change
  nothing is refused. Any member who can post may set one, as with a pin.
- **Pins (#131).** `CHAT_PIN_SET` (48) pins or unpins one message: payload is
  the message ID, `on` u8 and 3 reserved zero bytes (20 bytes). Replay keeps
  pins in the order applied, with who pinned each: a pin of an unknown
  message or of one already pinned changes nothing (the first pinner stays),
  and an unpin of one that is not pinned changes nothing. The author's
  deletion of a message unpins it; an admin's removal is only known to the
  service, so a page leaves a pin out while a named admin has removed its
  message. Commands allow a pin only on a message that shows, while fewer
  than 10 pins show; any member who can post may pin or unpin. Pins from
  devices that raced past the limit stay in the log but a page lists the
  first 10 that show, so unpinning brings the next one back. Replay keeps at
  most 64 records, and a command that would exceed that is refused.
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
