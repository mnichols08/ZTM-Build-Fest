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

Since Slice 6 the WASM test replays a fixture by appending the `.kine`
records to a fresh instance's history and projecting its context; the bytes
are unchanged. The `.kins` files hold a fresh engine instance's first projection, so every
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

## Device names (v1.1)

These vectors are written out by hand in `rust/src/device_name_tests.rs`;
none comes from the production encoders.

**024 — Descriptions and nicknames.** Member 1 describes devices 0x12 and
0x11, member 2 describes 0x21. Device 0x11 nicknames itself "Kitchen phone",
then device 0x12 renames it "Mikey’s phone 📱"; 0x11 describes itself again
as "Chrome on iPhone 17"; member 2 sets and clears a nickname. Expected KDEV
order 0x11, 0x12, 0x21 with 0x11 keeping its newer automatic name and the
later nickname, and no nickname on 0x12 or 0x21.

**025 — Authority without poisoning.** After member 1 describes 0x11, member 2
nicknaming 0x11 or describing 0x11 replays and changes nothing. A history that
starts with member 1 nicknaming an undescribed 0x11 (a member who joined later)
replays with a nickname-only entry owned by member 1; a later description by
member 1 keeps the nickname, one by member 2 replaces the entry. Member 1 can
still rename it by command; member 2 cannot (code 4).

**026 — Canonical names.** An empty name, surrounding whitespace, a newline,
U+202E, U+200B, a leading U+FEFF, a 49-character automatic name and a
33-character nickname all fail decoding with code 2. Forty-eight four-byte
characters (192 bytes) decode; so does a nickname with a zero-width joiner
inside an emoji sequence. A zero target device, a short length field, invalid
UTF-8 and a missing nickname length fail with code 2.

**027 — Not projected.** Replaying an Item with and without a description and
nickname gives identical KINS bytes except the summary's through event ID.

**028 — KDEV layout.** Two devices encode as `"KDEV"`, version 1, reserved 0,
count 2, then for each the device ID, member ID, the two u16 lengths and the
names; the empty table is the 12-byte header with count 0. Held history with
an identity binding names the bound device and member.

## Item pictures and my things today (Simple view, #344)

These vectors are written out by hand in `rust/src/simple_tests.rs`.

**039 — Emoji payload.** Item 7 with "🧦", "👩‍🍳", "🇬🇧" and none round-trip;
the payload is the item ID, `01 00 00 00` and the emoji's u16 length and
bytes, or `00 00 00 00` when cleared. A non-zero reserved flag byte, a
trailing byte, text after a clear, a zero item ID, and "a", "🧦🧦", "" or "x🧦"
fail with code 2.

**040 — Set, change, clear.** Adding item 1 and setting "🪥" then "🦷" works;
the same emoji again, an unknown item and an archived item fail (code 4).
KIEM reports only the unarchived item: `"KIEM"`, `01 00`, `00 00`, count 1,
item 1, length 4, "🦷". An emoji event for an item the history lacks replays
and isn't reported.

**041 — My things today (20261003).** For the child: item 3 planned
20261001, item 1 planned 20261003, undated item 2, then routines "Bins out"
(open) and "Feed the fish" (done). Not listed: an item planned 20261010, a
completed, an archived and a Staple item, and other members' things. After
item 2 is unassigned and the mode is Vacation, only items 3 and 1 remain.
KMTD encodes an item as `01 00 00 00`, its ID and a zero date; KMTQ with
version 2 fails with code 3, a zero member or a short query with code 2.

## Store sections (#411)

These vectors are written out by hand in `rust/src/shopping_section_tests.rs`;
section and item IDs are `numbered_id(n)`. JavaScript mirrors 046, 047 and
050 in `web/wasm/kin-sections.test.mjs` and `abi-ownership.test.mjs`.

**046 — List payload.** Sections 1 "Produce" and 2 "Dairy" encode as
`02 00 00 00`, section 1, `07 00` "Produce", section 2, `05 00` "Dairy"; the
empty list is `00 00 00 00`. Thirty sections and a 40-byte name ("é" × 20)
encode. A non-zero reserved byte, a trailing or missing byte, a count that
disagrees with the entries, 31 sections, a repeated or zero ID, and the names
" Dairy", "Dairy ", "", " ", "a\u{7}b" or 41 × "x" fail with code 2. "Dairy"
and "dairy" together decode (a command rule, not a format rule).

**047 — Item payload.** Item 7 in section 2 is item 7's ID then section 2's
(32 bytes); cleared, the section is 16 zero bytes. 31 or 33 bytes, or a zero
item ID, fail with code 2.

**048 — List rules.** Setting the empty list on a new household fails (code 4,
no change); setting "Produce", "Dairy" works; the same list again, or a list
with "Dairy" and "DAIRY", fails with code 4; a repeated ID, " Produce ", a
41-byte name or 31 sections fail with code 2. Reordering and renaming are
changes; the empty list then clears it.

**049 — Item rules.** With Milk (item 1) and sections 1 "Produce" and 2
"Dairy": an unknown item, unknown section 5, or clearing a section that isn't
set fails (code 4); Milk in Dairy works, again fails. An archived item fails
whether set or cleared. When the list becomes just "Produce", Milk shows none;
clearing it, or setting Dairy, fails; setting Produce works. Replay keeps an
item section naming a section never listed, or an item it lacks, and shows
none; listing that section ID later shows the item in it. Of two lists made
from the same history, the later in replay order wins.

**050 — KSHS.** Items 1 Milk (Dairy), 2 Apples (Produce), 3 Batteries (none)
and 4 (Produce, then archived), with the list "Dairy" (section 2), "Produce"
(section 1): `"KSHS"`, `01 00`, `00 00`, count 2, section 2, `05 00` "Dairy",
section 1, `07 00` "Produce", item count 2, item 1 + section 2, item 2 +
section 1. An empty history is `"KSHS"`, `01 00 00 00` and two zero counts.

## Taking turns on routines (#429)

These vectors are written out by hand in `rust/src/rotation_tests.rs`; the
routine is `numbered_id(20)` ("Bins out", daily from 2026-10-03) and the
members Alex, Sam and Jo are 16 bytes of `01`, `02` and `03`. JavaScript
mirrors 051, 052 and 055 in `web/wasm/kin-rotations.test.mjs` and
`abi-ownership.test.mjs`.

**051 — Rotation payload.** Alex, Sam, Jo with Sam's turn is the routine ID,
`03 01 00 00`, then the three member IDs (68 bytes); ending is the routine ID
and `00 00 00 00`. Twelve members with index 11 decode. One member, thirteen,
a repeat, a zero member, index 2 of two, index 1 with no list, a zero
routine, a non-zero reserved byte, a trailing or missing byte, or a count
that disagrees with the members fail with code 2.

**052 — Turn payload.** The routine ID then Sam's (32 bytes). 31 or 33
bytes, a zero member or a zero routine fail with code 2.

**053 — Rotation rules.** Ending with no rotation, an unknown routine, or the
same rotation again fails (code 4); a repeat, one member or an index past the
list fails with code 2. Alex, Sam, Jo at index 1 makes Sam current, Jo next
and Sam the owner; reordering or moving the index is a change. While it
rotates, an owner change fails (code 4). Ending it leaves the last current
member (Alex) the owner, which can then change as usual. An archived routine
takes neither a rotation, an end nor a turn.

**054 — The turn passes when it's done.** Alex, Sam, Jo from Alex: completing
the 3rd makes Sam current; reopening the 3rd makes Alex current again.
Completing the 3rd, 4th and 5th comes back to Alex. Reopening the 4th (not
the one that passed it) changes nothing; reopening the 5th makes Jo current;
completing and reopening the 4th passes it to Alex and back. A day nobody
completes keeps Jo's turn. After a completion passes it to Alex, a turn set to
Jo and then reopening that occurrence keeps Jo. Two devices completing the
same occurrence move the turn once, in either arrival order. Of a turn to Jo
(device `33`), a completion (device `11`) and a new list Alex, Sam (device
`22`) at the same logical time, replay order gives Alex current with the turn
to Jo ignored; an owner change from a device that hadn't seen the rotation is
ignored.

**055 — KRRS.** Bins out rotating Sam, Alex, Jo at index 2, routine 22
rotating then archived, routine 23 rotating then ended, routine 21 never
rotating: `"KRRS"`, `01 00`, `00 00`, count 1, routine 20, `03 02 00 00`, Sam,
Alex, Jo. An empty history is `"KRRS"`, `01 00 00 00` and a zero count.
## The sitter page (#442)

These vectors are written out by hand in `rust/src/sitter_tests.rs`; record
IDs are `numbered_id(n)`, and the household has note 1 "Bedtime", reference
record 2 "Grandma" and routine 3 "Feed the cat". JavaScript mirrors 060, 063
and 064 in `web/wasm/kin-sitter.test.mjs` and `abi-ownership.test.mjs`.

**060 — Page payload.** Note 1, reference record 2 and routine 3 with the
intro "Bed by 8.\nThanks!" encode as `03 00 00 00`, then `01 00 00 00` +
note 1, `02 00 00 00` + record 2, `03 00 00 00` + routine 3, then `11 00` and
the intro (83 bytes). The empty page is six zero bytes. Thirty entries, a
500-byte intro ("é" × 250) and the same ID as a note and as a routine encode.
A non-zero reserved byte in the count or an entry, an entry kind 0, 4 or 255,
a trailing or missing byte, a count that disagrees with the entries, 31
entries, an entry twice, a zero ID, invalid UTF-8, and the intros " Hi",
"Hi ", "\nHi", "Hi\n", " ", "a\u{7}b", "a\r\nb", "a\tb" or 501 × "x" fail
with code 2.

**061 — Page rules.** Setting the empty page on a new household fails
(code 4, no change), as do an unknown note, reference record or routine 9,
and note 1 named as a routine. The full page with intro "Bed by 8." works;
the same page again fails (code 4); an entry twice, " Bed by 8." or 31
entries fail with code 2. Reordering, a new intro and dropping entries are
changes and replace the page whole. An archived note or reference record
can't be added (code 4); the empty page then clears it.

**062 — Replay.** With note 4 "Wi-Fi" and the page note 4, routine 3, note 1,
record 2: after note 1 and routine 3 are archived the page reads note 4,
record 2, and the event keeps all four. A page naming note 50, which the
history lacks, replays and skips it; once note 50 is created it shows, in
the page's order. Of two pages made from the same history, the later in
replay order wins.

**063 — KCMD.** Action 70 carries the payload as its text with zero entity,
date, option and expiry; a 30-entry page with a 500-byte intro fits; a
non-zero entity, date, option or expiry, an untrimmed intro or an empty text
fail.

**064 — KSIT.** With note 4 "Gone" archived after the page routine 3, note 4,
record 2, note 1 with intro "Hi": `"KSIT"`, `01 00`, `00 00`, count 3, then
`03 00 00 00` + routine 3, `02 00 00 00` + record 2, `01 00 00 00` + note 1,
then `02 00` "Hi". An empty history is `"KSIT"`, `01 00 00 00`, a zero count
and a zero intro length.

## A member's private log (#489)

Written out by hand in `rust/src/private_tests.rs`: household `aa` × 16,
member Sam `01` × 16 on device `11` × 16, event IDs `numbered_id(n)`, the
timestamp 1,791,475,200,000 + n. `web/wasm/kin-private.test.mjs` mirrors 067.

**065 — Private note (kind 100).** Event 1, logical time 1, note `5a` × 16
with text "Call Mum": header `01 00` `64 00`, then the IDs, timestamp and
logical time, payload length `1c 00 00 00` (20 + 8), then `5a` × 16,
`08 00 00 00` and "Call Mum" (116 bytes in all). It decodes to
`PRIVATE_NOTE_SET` and re-encodes byte for byte. A zero note ID, a length
that doesn't cover the text exactly, a payload under 20 bytes, a tab, invalid
UTF-8 or 2,049 bytes fail with code 2; a line feed, 2,048 bytes and empty
text (removal) decode. Kinds 101, 150 and 199 fail with code 3.

**066 — Logs.** The household, chat and board logs and a KINE request refuse
the note with code 4; the private log refuses an item record with code 4 and
holds at most 50,000 records (the next append fails with code 5). Two
members' notes in one private log fail replay with code 4.

**067 — KPRV.** An empty log is `"KPRV"`, `01 00 00 00`, 16 zero bytes,
count 0, `01 00 00 00` (one section), `01 00 00 00` (section 1) and length
`04 00 00 00`, then a zero note count: 44 bytes. After note 2 "two" (event 1)
and note 1 "one" (event 2), the member is `01` × 16, the count 2, and the
notes section lists note 1 (logical time 2, device `11` × 16, "one") before
note 2. A later note for the same ID replaces it and empty text removes it,
the latest in replay order winning.

### Just for me (#510)

Numbered 090–094, apart from the journal's vectors added alongside. Written
out by hand in `rust/src/private_item_tests.rs` with the same household,
member, device, IDs and timestamps as 065–067; `web/wasm/kin-private.test.mjs`
mirrors 092 and 093.

**090 — Private item added (kind 110).** Event 1, logical time 1, item
`5b` × 16, date 20261005, text "Dentist": header `01 00` `6e 00`, payload
length `1f 00 00 00` (16 + 4 + 4 + 7), then `5b` × 16, the date
`8d 28 35 01`, `07 00 00 00` and "Dentist" (119 bytes in all). It decodes to
`PRIVATE_ITEM_ADDED` and re-encodes byte for byte, as does every kind
110–118. A zero ID, an invalid date (20261332), empty text, a line feed or
other control character in the text, invalid UTF-8, 4,097 bytes of text,
trailing bytes, a tab in a note or a 2,049-byte note, a setting byte other
than 0 or 1 or a non-zero reserved byte fail with code 2; 4,096 bytes of
text, a note with line feeds and an empty note decode. Kind 119 fails with
code 3. Every other log and a KINE request refuse kind 110 with code 4.

**091 — Replay.** Items 1 (undated) and 2 (dated 20261010) are added; item 1
is edited and dated 20261003; item 2 is completed, reopened and completed,
and gets the note "A book"; a second add of item 1, a completion of unknown
item 9, and item 3 added then deleted twice follow. Expected: two live items;
item 1 "Call the dentist (Tue)" dated 20261003, open, changed at logical
time 4 (the second add changed nothing); item 2 done with its note; item 3 a
tombstone. Restoring item 3 brings it back as it was; the setting set off
reads off. With 2,000 live items, a further add is ignored, and after one
delete an add and a restore compete for the place: the earlier in replay
order wins. Two members' items in one log fail replay with code 4.

**092 — KPRV section 11.** With no item and no setting, KPRV is exactly 067
(44 bytes, one section). After item 2 "two" dated 20261003 (event 1), item 1
"one" (event 2), the note "n" on item 1 (event 3), item 2 completed (event
4) and item 3 added and deleted (events 5–6): the section count is 2; section
1 is the empty notes section; section 11 has flags 0 and count 2, then item
1 (added at timestamp + 2, changed at 3, no date, open, text 3 and note 1,
"one" "n") and item 2 (changed at 4, date 20261003, done, "two"). A log
holding only the setting set off has section 11 with flags 1 and no items
(60 bytes in all).

**093 — Private commands.** `kin_private_execute` with KCMD action 110,
event `numbered_id(1)`, logical time 1 and the 090 payload, on an empty
private log, returns `KCMT` v1 with the 090 record, its KMET and an empty
projection, and leaves the log empty. The KCMD has `6e 00` at offset 8,
zeros at 92–123 and payload length `1f 00 00 00` at 124.

**094 — Command refusals (code 4).** Adding a known or deleted ID, untrimmed
text or notes, edits, completions, reopenings, dates, notes and settings
that change nothing, changes to unknown or deleted items, deleting a deleted
item, restoring a live one, a logical time not after the log's latest, a
known event ID, another member, another household, any other log, and an
add or restore with 2,000 live items. A household action fails with code 3;
an entity ID in the header or a payload length that doesn't match fails
with code 2.

## Household chat (v1.1)

Chat records are written out by hand in `rust/src/chat_tests.rs`; IDs, blob
refs and keys are distinct byte patterns per message and version.

**030 — Lifecycle.** Member 1 posts message 1 and member 2 posts message 2;
member 1 edits message 1 twice (once from another device) and member 2
deletes message 2. Expected: message 1 edited with the second edit's blob and
key, its edited-at time the second edit's; message 2 deleted with a zero blob
and key; retired blobs message 1 v0, message 1 v1, message 2 v0, in that
order.

**031 — Conflicts change nothing shown.** Against a posted text message and a
posted attachment, each of these leaves the messages and claims unchanged: a
second post of the same ID (by anyone), an edit by another member, an edit
of the attachment (each makes its new blob a retirement candidate), an edit
to the blob the message already has, an edit or deletion of an unknown
message, and a non-admin deletion by another member (none adds a
candidate). Nothing changes a deleted message; an edit after it makes its
blob a candidate.

**032 — Delete beats edit.** An edit and a deletion by the author at the same
logical time, from two devices, in both replay orders: the message ends
deleted with a zero blob, and both blobs it had (the original and the edit's)
are retired.

**033 — Admin claims.** An admin removes member 1's message twice and member
2 claims once. Replay records the claims (the admin once) and leaves the
message live; a page naming the admin, or member 2, shows it removed and
retires its blob; a page naming neither shows it live.

**034 — Separate logs.** The household history refuses a batch holding a
chat record and keeps nothing of it; the chat log refuses a household
record; a whole household KINE request refuses a chat record (code 4).
Chat commands fail against the household history and household commands
against the chat log (code 4).

**035 — KCHP layout.** Four messages (one edited, one attachment removed by
the named admin, one deleted by its author), texts held for two blobs: the
newest three with texts and retired blobs encode byte for byte as ABI.md
describes, and reading the page forgets the retired blobs' texts.

**036 — Long chat.** 100,000 posts, one in ten edited, one in twenty deleted:
the newest page of 50 replays within the test's bound, and the next page
reuses the checkpoint (`History::last_replay_reused`).

**037 — Shown blobs are never retired.** Edits A, B, then A again: the
message shows A and only B is retired. Two messages sharing a blob: deleting
one retires nothing while the other shows it; deleting both retires it once.
Commands refuse both reuses.

**038 — Backdated copies.** A modified client copies member 1's blob into an
earlier-dated post of its own message: both messages show (the copy as its
author's) and nothing is retired. Into an earlier-dated edit of its own
attachment: the blob is a candidate, but member 1's message still shows it,
so it is not retired.

## Talk later topics (#312)

These vectors are written out by hand in `rust/src/chat_topic_tests.rs`,
reusing the chat records above.

**042 — Topic payload.** Message 1 with state 0, 1 and 2 round-trips as kind
65: the message ID, the state and three zero bytes (20 bytes). A trailing or
missing byte, state 3 or 0xFF, a non-zero reserved byte and a zero message ID
fail with code 2; so do KCMD action 65 with option 3, a zero entity ID, a
payload or a date. The household history refuses a topic record.

**043 — Transitions.** Against messages 1–3: resolving or clearing message 1
with no topic fails (code 4); member 2 opens it; opening it again fails;
member 1 resolves it; resolving again fails; it reopens, resolves and clears;
clearing again fails. Message 2 clears from open. Message 99 (unknown) fails.
Message 3, once its author deletes it, fails for every state and its open
topic is gone. On a message a named admin removed, open and resolve fail and
clear succeeds. With 200 topics listed, a 201st open fails until one is
cleared; resolving one at the limit succeeds.

**044 — Tolerant replay.** Latest in log order wins: opened by member 2 then
resolved by member 1 lists message 1 resolved, flagged by member 2, changed by
member 1, in any arrival order. A resolve with no topic lists it resolved; the
same state again changes nothing; a topic on message 9 (unknown), or logged
before its message's post, changes nothing. Cleared then opened again starts
the record over at the end of the list. The author's deletion drops the topic
and a later flag on it changes nothing; an admin's removal keeps the record
but a page naming that admin leaves it out. Replay keeps 200 topics and
ignores the 201st.

**045 — KCHP topics section.** Messages 1–3, a pin on 1, member 2 opens 1,
member 1 opens 2 and resolves 1, member 2 opens 3, member 1 deletes 3. A page
asking for texts, reactions, pins, polls and topics equals the page without
topics followed by: count 2; message 1, `02 00 00 00`, member 2, then its
quote (live text by member 1, index 0, first line "Holiday plans"); message
2, `01 00 00 00`, member 1, then its quote (index 1, no text held). Flag bit 6
is refused.

## Push payload (RFC 8291)

**029 — RFC 8291 Appendix A.** Plaintext "When I grow up, I want to be a
watermelon", application-server private key
`yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw`, user-agent public key
`BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`,
auth secret `BTBZMqHH6r4Tts7J_aSIgg`, salt `DGv6ra1nlYgDCS1FRnbzlw`.
`encryptPushPayload` must produce the RFC's message exactly, and decrypting
it with the user-agent private key `q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94`
must give the plaintext (`server/push.test.mjs`).

## QR symbols (#94)

The engine's QR encoder (`rust/src/qr/`) must produce the module grid below
for each text and mask, byte mode, level M. Each grid is pinned by the FNV-1a
64 hash of its modules (one byte per module, row-major, no quiet zone). The
reference is python-qrcode 8.x with byte mode forced and `mask_pattern` set,
run once and recorded here; it is not a runtime or build dependency.
`coverage::golden_grids_match_an_independent_encoder_for_every_mask` checks
all of them.

- `01234567`, version 1 (side 21): the ISO/IEC 18004 Annex I example, in byte
  mode. The annex example itself is numeric, so this is its byte-mode
  equivalent.
- `https://kin.example.org/#join=7kq4-zpm2-hr9t-vxb6`, version 4 (side 33).
- `https://kin.example.org/#sign-in=q7tk-2mzp-vx8r-3hdn-4wjb-9cfl-6ygs-zt5m`,
  version 5 (side 37).
- `https://kin.example.org/#v7=` followed by `0123456789abcdef` five times,
  version 7 (side 45), which carries version information.
- `https://kin.example.org/#v10=` followed by `0123456789abcdef` eleven
  times, version 10 (side 57).

| Text | Mask | FNV-1a 64 |
|---|---|---|
| `01234567` | 0–7 | `6ca855685a57b68d` `d3a2a295bf82e0c3` `03266a2fbe5602a3` `e2cffb098f25ae39` `fef5e643e723249b` `e20213afa4307655` `4c91aab4c8c01f95` `ef39ad586b7ebd8f` |
| join link | 0–7 | `92424d5f7ff9a791` `5e761cb029f507e3` `21f4527da7335d8a` `18e017e9e3e71022` `c01aac4b6d43773f` `2aff60efa4dc7421` `9eedae69d11331e6` `31ab0d471c819530` |
| sign-in link | 0–7 | `9050850d9fab18d5` `077723bf125628f3` `76bb94d44063b69f` `7c55179d943c7a85` `532d25518e3545cf` `12bc4b76d93e24be` `524efe1360e99449` `aee5e630353e1e1f` |
| version 7 text | 0–7 | `5b34cdaec1d9bd61` `0e6a1f274c02af4a` `d237884cd26ca547` `8da5669b736d8525` `08a6e8a98fd7136b` `cd1d4ccbeab9f7a9` `7a10146e7cc5a345` `97941fff7077a7d7` |
| version 10 text | 0–7 | `1bf516d39bd37249` `f77dc892ed145b02` `f3d2907f803b734f` `ce259b63f00e8839` `4dedc77efa96692b` `234fcb9d1fb8814d` `2ce91836c8b2447d` `01e5eb08f87c65ab` |

The V4 and V6 grids in `tests.rs` come from the same reference. Their masks
differ from the encoder's lowest-penalty choice, which is still a valid
symbol.

### Decoder frames (#95)

The decoder is checked on synthetic camera frames built in the Rust tests
from encoded symbols, not on stored images, so the corpus is code and can't
drift from the encoder:

- every version 1–10 with every mask, round-tripped (80 frames);
- rotation at every 15° (24 angles), a mild perspective tilt for versions
  2–10 (version 1 has no alignment pattern: the documented limit), and
  perspective with rotation and noise together;
- scale from 3 to 8 pixels per module;
- Gaussian sensor noise (an Irwin–Hall approximation), blur of radius 1 at
  6 pixels per module and radius 2 at 8, and light-on-dark symbols;
- damage up to the Reed–Solomon budget is read, and beyond it is refused or
  detected, never misread;
- adversarial frames: a symbol among finder-like decoys is still read, and
  too many decoys are refused rather than misread;
- the work budget: a clean symbol given too small a budget ends the search
  instead of running on.

[QR-ACCEPTANCE](QR-ACCEPTANCE.md) lists each test by name.
`scripts/qr-regression.mjs` reads a QR code through a real browser camera
(a fake video device) and the engine.
