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
