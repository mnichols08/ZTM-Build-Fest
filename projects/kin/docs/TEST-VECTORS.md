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
of the attachment (each retires its new blob), an edit to an already-seen
blob, a post reusing another message's blob, an edit or deletion of an
unknown message, and a non-admin deletion by another member (none retires
anything). Nothing changes a deleted message; an edit after it retires its
blob.

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

**037 — One event per blob.** Edits A, B, then A again: the third changes
nothing, and the message keeps B with A retired once. A second message
reusing the first's blob is no message, so deleting the first retires only
its own blob. Commands refuse both reuses.

## Push payload (RFC 8291)

**029 — RFC 8291 Appendix A.** Plaintext "When I grow up, I want to be a
watermelon", application-server private key
`yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw`, user-agent public key
`BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`,
auth secret `BTBZMqHH6r4Tts7J_aSIgg`, salt `DGv6ra1nlYgDCS1FRnbzlw`.
`encryptPushPayload` must produce the RFC's message exactly, and decrypting
it with the user-agent private key `q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94`
must give the plaintext (`server/push.test.mjs`).
