# Synchronization Design

**Status:** v0.24.0 preserves the existing encrypted-sync boundary. Item planning dates remain inside encrypted canonical event payloads, and the Last changed display value is derived client-side; no plaintext metadata, server interpretation, or new authority is added.

## Binary event transport (refactor Slice 10)

`POST /api/sync/events` and `GET /api/sync/events` carry encrypted event
envelopes as binary (`application/octet-stream`) instead of base64url text
inside JSON (owner decision D3: the JSON form is replaced, not kept beside
it). The envelope itself is unchanged: the browser encrypts and signs it as
before (`web/sync/crypto.js`), the relay validates and stores the same
object (`server/sync-contract.mjs`), and signatures cover the raw nonce and
ciphertext bytes, so nothing about authentication changes. One codec,
`web/sync/envelope-wire.js`, is shared by the browser and the server.

- An envelope record is 148 bytes plus its ciphertext: event, household and
  device IDs (16 bytes each), device sequence and logical time (u64), key
  epoch (u32), nonce (12), signature (64), ciphertext length (u32) and the
  ciphertext. Integers are little-endian; protocol and envelope version 1
  are implied by the format version.
- A push body is `KSEV`, version u16 = 1, count u16, then the records. A
  JSON body is refused with 415 and a malformed batch with 400
  (`sync_batch_invalid`). The media type must be exactly
  `application/octet-stream` (case-insensitive, parameters allowed), not a
  prefix match. A count above 20 is refused before any record is decoded.
  The acknowledgement stays JSON.
- A pull page is `KSEP`, version u16 = 1, flags u8 (bit 0: more pages),
  a zero byte, count u32, the next cursor (8 bytes), then per event its
  cursor (8 bytes) and record. Cursors stay opaque; clients keep them as
  unpadded base64url, the form the query string takes. Errors stay JSON.
- Decoding gives back exactly the object that was encoded: field order,
  lowercase hex IDs and canonical unpadded base64url. The relay's canonical
  duplicate comparison is therefore unchanged. A batch of 20 envelopes is
  48% smaller than the JSON it replaces for 150-byte events and 27% smaller
  for 4 KB events.

Request bodies are read with their limit enforced as they stream
(`server/http-body.mjs`): a declared `Content-Length` over the limit is
refused with 413 before any body byte is read, and a body without one is
refused as soon as it passes the limit, so no more than the limit is ever
buffered. Limits: 256,000 bytes for JSON control requests, 125,848 bytes for
an event batch (8-byte header + 20 × (148-byte fixed record + 6,144-byte
maximum ciphertext)), and the attachment limit for attachment and settings bodies.

## v0.24.0 Useful Household History

The date-only Item history value is derived during client-side replay from
existing encrypted canonical events. No timestamp is duplicated into
plaintext sync metadata and no actor/device or read-receipt state is added.
Distinct concurrent events continue to converge by the established
`(logical_time, device_id, event_id)` ordering.

## v0.22.0 Lightweight Planning Dates

Planning dates are schema-1 canonical Item events carried by the existing
encrypted local event store, outbox, retry, relay, revocation, and archive
paths. They are not duplicated into plaintext sync metadata. Concurrent
updates resolve by protocol 16's existing
`(logical_time, device_id, event_id)` order. Older protocols fail closed on
date-bearing history rather than dropping the field.

## v0.21.0 Household Modes

Explicit mode changes are canonical events and use the existing encrypted
offline store, retry, relay, revocation, and archive paths. Devices that sync
distinct concurrent changes converge through protocol 15's deterministic
`(logical_time, device_id, event_id)` replay ordering. Protocols 1–14 fail
closed on mode-bearing history or non-Normal projections. Sync adds no
plaintext mode metadata or server-side mode behavior.

## v0.20.0 Staples & Replenishment

Staple definitions and ordinary Shopping Items are canonical Item events and
remain inside the existing encrypted local/sync/archive boundaries. Manual
replenishment appends a separate Shopping Item with copied text; it does not
create inventory state, a source relationship, or a server-side operation.
Offline capture, retry, synchronization, and archive import/export continue
through the existing event adapters. Protocol 14 is required to replay
Staples; protocol 13 remains compatible with Shopping-only history.

## v0.17.0 Checklist Steps

Step events use the existing encrypted canonical-event envelope and can be
created offline. Local append and retry preserve the generated Step ID; after
sync, deterministic Rust replay uses the parent Item ID and stable Step ID.
Equal-logical-time archive versus completion/reopen from distinct devices
converges to archived. A same-time parent Item archive suppresses Step
mutations. A later change from another device, after another device archived or
completed the entity, is kept in history and has no effect. Revocation and
epoch rotation continue to govern access to the complete event stream; Steps
add no server interpretation or authority.

## v0.15.0 Areas

Area names, IDs, archive state, and Item assignments are ordinary canonical
household event payloads. They are encrypted with the same household content
key before entering the relay. Relay routing sees only the existing opaque
envelope metadata, never plaintext Area names. Offline create, rename, archive,
and assignment follow the existing retry/idempotency and deterministic replay
path. Revocation and epoch rotation continue to govern access to the entire
household event stream; Areas add no authority or server-side interpretation.

## Intended direction

## v0.10 local security integration

v0.10.2 replaces only the local storage root. Exact device private serialization,
epoch self-seals, pending transition/provisioning/rotation records, pins, bindings,
outbox and cursors survive re-protection. Sync epoch/device transport keys are not
rotated as a side effect. Peer locks dispose old adapters and durable root/epoch
guards reject stale operations.

**Stable archive decision: Option A, intentionally local-only recovery.** Restore
does not establish membership, trusted-device enrollment or epoch entitlement.
Sync reattachment requires a separately authorized future workflow and is not
partially supported. v0.13 must make the archive/authority boundary an explicit
recovery decision; v0.14 must present it without implying that an archive
restores membership or device trust.

Transport envelope/protocol v1 and canonical event protocols v1–v8 remain unchanged.
Local canonical events/outbox copies, epoch records and device private serializations
are now protected by the unlocked local vault; transport encryption alone never
substitutes for this protection. Sync starts only after unlock and stops/aborts on
lock. Browser adapters read validated Rust metadata instead of canonical offsets.

Migration replaces nonextractable legacy private keys through a versioned signed
successor certificate with expected fingerprint, identity and monotonic generation
(at most 16 transitions). The server verifies and accepts exact retries, publishes
bounded public verification history and removes obsolete provisioning packages.
Peers authenticate the chain from existing pins; historical exact envelopes and
approval certificates retain their original signatures. Fingerprint-bound retry
state reprovisions entitled current/history epochs after transition. A queued
transition is accepted before pairing or sync, even if sync itself is disabled.
Local offline migration can finish while that network transition remains pending.

Archive restore is explicitly local-only and cannot silently rejoin sync; see
[PORTABILITY](PORTABILITY.md). A separate verified service-database backup is
required to recover server authority. Sessions and unfinished pairing/login
flows expire on restart; a trusted device must reauthenticate with its passkey.
Member removal/device revocation still reserves future sync key epochs and
cannot erase prior plaintext/keys. Local recovery possession is a separate
authorized path; removing a server member does not magically revoke a copied
recovery key/root.

## v0.10.1 interrupted rotation recovery

Before retrying a pending rotation, refresh authenticated server status and the
verified device directory. If the proposal already committed, recover its exact
sealed epoch key without replacing its packages. Otherwise refresh expired
packages or packages bound to superseded sender/recipient keys and the current
active recipient set. Keep the proposal ID, sealed epoch key and fingerprint;
only recipient packages and optional issuer-fingerprint retry metadata change.
An older request accepted during this refresh still identifies the same key.

## Committed rotation recovery

A successfully committed rotation makes each package for an intended trusted
recipient durable recovery material until that recipient acknowledges it or
loses trust. The package remains bound to its original household, epoch,
recipient fingerprint, grant ID, and sender signature; server metadata marks
only packages created by the committed compare-and-advance operation as
recoverable after their ordinary pre-commit expiry. The client still verifies
the recipient binding and sender signature against the verified device-key
history before saving the key. Generic provisioning grants continue to expire
normally.

When a sender is revoked after commit, packages for still-trusted recipients
remain available, while packages addressed to a revoked, expired, or
key-transitioned recipient are removed. Acknowledgement records the received
epoch on that device. The rotating device records its own new epoch at commit.
This allows a remaining Adult to recover the committed epoch before performing
the rotation required by the access change; it does not let that Adult skip a
missing epoch or make its encrypted event history unreadable. Recovery packages
contain only recipient-wrapped keys, not server-held household content keys.

The recovery marker is assigned by the relay when it accepts the rotation;
fields in a submitted package body cannot set or clear it. Clients relax only
the expiry check, and only for a grant the relay marks this way whose signed
epoch is at or below the relay's current committed epoch; a newer epoch must
arrive unexpired. The expiry is part of the signed package metadata, so the
marker cannot make a package verify that would not verify otherwise.

Epoch numbers come only from signed packages. The grant's outer `keyEpoch`,
`senderDeviceId` and `grantId` are relay metadata and are not signed, so the
client refuses a grant unless each equals the signed package's value and the
package names this household and this device as recipient. A refused grant is
not saved or acknowledged, and sync pauses with an explanation. The key store
also refuses to save a sealed key under any epoch or household other than the
one it was sealed for. Durable validation rejects a marker on
an acknowledged, request-bound, or package-less grant. Grants stored before
the marker existed load as ordinary grants and keep their normal expiry.
Retained packages are bounded by `MAX_KEY_EPOCHS × MAX_ROTATION_PACKAGES`,
which exceeds the most a supported household can accumulate (127 rotations ×
at most 64 recipients), so retained recovery packages cannot block a
legitimate rotation. They do not count against the ordinary 128-transfer
limit. A recipient's own key migration still discards its outstanding
packages, because they are bound to its previous fingerprint.

A retried rotation reuses its pending key only while every device it was
already wrapped for is still a recipient (same device ID and key fingerprint).
If any of them has been revoked or re-keyed since, the pending proposal is
discarded and a fresh key and proposal ID are generated, so a relay that kept
the earlier package cannot hand the departed device the new epoch's key (#176).
Before discarding, the device re-reads the relay status: if the proposal
committed meanwhile (for example a lost response), it is accepted with its
original key instead, and the discard happens only while the relay is still at
the proposal's expected epoch. Rotation runs under a cross-tab Web Lock
(`kin-key-rotation`), so another tab can't commit the proposal between that
check and the discard; a tab that finds the lock held skips that pass. A recipient set that is unchanged or grows keeps the
pending key.

A device whose first sync finds a rotation pending sets up its sync state
first, then commits the rotation. History it held before joining is queued
without a key epoch, like a new change, and its identity binding waits too, so
both are sealed under the new epoch, never the retired one; a binding sealed
earlier and not yet uploaded is re-sealed under the relay's current epoch (by
one tab only). Events from that earlier identity are not pushed until the
binding is on the relay. Changes already sealed or stamped before an access
change are still sent under their epoch once the rotation commits, as ordinary
queued changes are.

Replacing pending packages compares the complete expected pending record in one
encrypted IndexedDB transaction. Completion and removal match the proposal ID,
so a stale tab cannot clear a newer proposal. Completion preserves the local
rotation barrier until an authoritative server-status update releases it; local
events created while another rotation is required retain an unassigned epoch.

The service keeps its latest committed proposal identity across a later access
change while marking the following rotation pending. Uploads remain blocked by
that pending state. A competing accepted proposal requires an authorized transfer
of its key; the losing local proposal never supplies the accepted epoch key.
No canonical event, transport-envelope or database-schema version changes.

## Historical transport progression

```text
Device A
   |
   v
local event
   |
   v
Rust validates domain event
   |
   v
IndexedDB append
   |
   v
client encrypts event payload
   |
   v
authenticated encrypted-event relay
   |
   v
Device B receives ciphertext
   |
   v
decrypt after device authorization
   |
   v
Rust validates, orders, and replays
   |
   v
derived household state
```

Each device remains useful offline. Events are committed locally first, queued for later upload, and retried safely. The receiver deduplicates by stable event ID, validates the event version, and reconstructs state using the deterministic ordering contract. No sync is included in v0.1.0.

## Server responsibility

The server is an authenticated encrypted-event relay, not the household source of truth, relationship analyst, plaintext event processor, or domain rules engine. Clients encrypt/decrypt household payloads and Rust validates/replays domain events. The server may authenticate accounts/devices, authorize access to a household's relay channel, store/forward ciphertext, enforce quotas/rate limits, and return opaque cursors.

Minimum routing metadata may include opaque household/channel ID, authorized device/account reference, event ID or opaque relay cursor, ciphertext size, upload/receipt time, and delivery status. Network services may also observe IP address, connection timing, and transport metadata. Minimize retention and access; encrypted content does not mean anonymous traffic.

The service must not receive plaintext household event payloads or household content keys. Authentication metadata and transport security remain necessary in addition to payload encryption. See [Cryptography](CRYPTOGRAPHY.md).

## Offline and delivery semantics

- Local event persistence succeeds before an event is considered locally accepted.
- Upload is at-least-once; clients must tolerate repeated delivery.
- Exact event duplicates are idempotent under the v0.0.4 event contract.
- Acknowledgement in the v0.11 candidate means the transaction committing ciphertext and its relay/device sequence returned successfully; it does not mean that another member received/read/agreed with it, that a backup exists, or that hardware/filesystem failure is impossible.
- A device may remain offline indefinitely; later synchronization must not rely on wall-clock timestamps as ordering authority.
- Authorization is checked on every sync operation. Revoked-device queued events are rejected unless an explicit, reviewed recovery procedure says otherwise.
- A client unable to decrypt or interpret an event must preserve it and surface a recoverable compatibility error; it must not silently drop it.

### Events that can't be applied yet (quarantine)

A remote event that decodes but doesn't fit this device's history (engine code 4, for example a completion delivered one page before the item it completes) doesn't stop sync. The relay cursor still advances, and the event's canonical bytes are kept in the encrypted `sync_state` record as `{ eventId, encoded, reason, firstSeenAt, attempts }` (`web/storage/quarantine.js`). Every later page that brings an event this device doesn't have yet replays the kept events with it, in canonical order. A kept event never stops a batch: if the engine refuses it for any reason (for example "unsupported" after an engine change), it stays kept, while the same failure on a page event still stops the batch. An event that applies, or arrives again as a duplicate, leaves the quarantine; one refused again counts another attempt and does not alert again. A kept event that is already in history, or that arrives again in the new page, is not replayed from the kept copy; history or the page copy decides, so a kept copy can never collide with them and stop sync.

- **Bound:** 100 rows and 64 KiB of canonical bytes (the rows are re-encrypted with every sync state write). Rows already kept stay; refusals beyond the bound are only counted, as every refusal was before v1.0. A row refused 20 times is moved to the count, so a true poison event can't fill the bound or cost a history replay forever. Bytes that can't be decoded at all are never kept, since retrying can't help them; they're counted too. `quarantinedEventCount` is kept rows plus counted refusals.
- **Review:** while events are kept, the device's status notice names up to three of them by short event ID with a plain-language reason, until they apply. A new refusal also shows it as a toast. It never shows bytes. With nothing kept the toast shows the earlier message.
- **Lifecycle:** the rows live in the same encrypted record as the sync cursor, so they're unreadable while Kin is locked and are removed with the sync state when the device leaves or the household is deleted. They aren't cleared on lock, because that would drop the only copy before the retry that would apply them; the relay re-sending an event is not relied on.
- An unreadable (code 2) or unsupported (code 3) event still stops the batch without advancing the cursor.

## Ordering and reconciliation

Use the deterministic ordering requirements in [EVENTS](EVENTS.md): logical time, then bytewise device ID, then event ID. The tuple defines reproducible replay order only. It is not a semantic “last write wins” policy and must not be presented as deciding who is right.

Implemented conflict behavior and remaining UX limitations:

| Concurrent operations                            | Required consideration                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both devices complete the same item              | Distinct completion facts are retained; replay is an idempotent state no-op after the first completion.                                                                                                       |
| One archives while another mutates               | A change from a different device at the same or a later logical time than another device's archive or completion is kept in history and has no effect. An earlier change applies, and the archive or completion still wins. Archive stays terminal. A device mutating something it archived itself still fails replay. A note created in an area another device archived at the same or an earlier logical time is kept with no area. Exceptions: an equal-time maintenance save against a reference another device archived still applies; a note update into an area another device archived keeps its text and leaves the note's current area unchanged; an equal-time reference save records field owners and leaves the saved text unchanged; completion can be undone by a reopen, per the row below. |
| One completes while another reopens              | Both facts remain; deterministic v8 tuple ordering selects the projection. The order is not semantic authority; the UI does not yet offer explicit conflict adjudication.                                     |
| Concurrent same-entity additions                 | Stable IDs are deduplicated; duplicate entity IDs from different event IDs fail closed rather than merge.                                                                                                     |
| Member/device removed while offline events exist | Authorization is checked at upload; revoked device sessions fail and old-epoch uploads cannot create new authorization. Local unsent canonical history remains local.                                         |

No generic CRDT or wall-clock last-write-wins policy is used. See the exact v8 replay rules and limitations in [V0.9.0](V0.9.0.md).

## Push notifications after commit (v1.1)

When a push batch with new events commits, the relay asks the push service
(#85) to notify other members' subscribed devices. That happens after the
response is decided, in the background; it can't fail, delay or reorder sync,
and a duplicate-only batch notifies nobody. See [Push notifications](PUSH.md).

## Live channel (v1.1, #107)

A trusted device can hold one WebSocket to the service at `/api/live`, so the
service can say "something is new" at once instead of waiting for the next
poll. Household data still moves only over the HTTP sync routes, which stay
the fallback whenever the socket is closed.

- **Native.** RFC 6455 is implemented on `node:http`'s `upgrade` event and
  `node:crypto` (`server/live/websocket.mjs`): the handshake, a streaming
  frame parser, ping/pong and close handling. No extensions (no
  `permessage-deflate`), no subprotocols, binary messages only; every client
  frame must be masked; a message is at most 256 KiB in at most 128 frames.
  The parser is a loop over a header state machine and unmasks payloads in
  place.
- **Access.** The upgrade needs Kin's exact `Origin` (against cross-site
  WebSocket hijacking), a session on a trusted device of an active member, and
  a household not being deleted. One socket per device; a newer one replaces
  the older (close 4409).
- **Losing access closes the socket at once.** A signed-out or expired
  session closes with 4401; a revoked device, removed member or household
  being deleted with 4403. Revocation, replacement and recovery approvals,
  member and membership changes, sign-out and deletion re-check a
  household's sockets; a timer fires when the session or a Temporary
  membership expires; every ping (25 s) re-checks too, and two unanswered
  pings close the socket. A storage failure closes with 1011 (the upgrade
  answers 503), never as lost access. A client that half-closes is let go
  at once.
- **Backpressure.** Messages queue while the socket can't take more (a sync
  hint already waiting isn't queued again); past 1 MiB the socket closes
  with 4429 and the device catches up over HTTP.
- **Limits.** At most 4,096 sockets at once, counting those still closing;
  a device holds at most two (one open, one closing), so a device that
  reconnects in a loop can't crowd others out.
  Stopping the service closes every socket within a quarter of a second.
- **Messages.** Each binary message carries one record,
  `[u8 type][u8 flags][u16 reserved][u32 length][payload]`, little-endian.
  The service sends `HELLO` (1) when the socket opens and `SYNC_HINT` (2) to a
  household's other devices when events are accepted. Both are empty: a hint
  says neither what changed nor who changed it. Clients send only typing
  frames (record 3, see [Read receipts and typing](#read-receipts-and-typing-v11-120));
  the service also sends `RECEIPTS` (4, empty) when a member's receipt slot
  changed. An unknown record type closes the socket.
- **The client (#108, `web/sync/live-channel.js`).** An unlocked device opens
  the socket after its first sync and closes it on lock or sign-out. One
  tab per device holds it (a Web Lock named for the device); another tab
  takes over when that one closes or locks. `HELLO` and every `SYNC_HINT`
  make the coordinator sync over HTTP, so a reconnect resumes from the
  stored transport cursor, any gap is filled by the pull, and events the
  outbox kept while offline go out. A hint during a sync runs one more
  sync after it, at most once a second. The service hints when events are
  accepted and when keys, provisioning grants, identity bindings or a key
  rotation change. While the socket is up and the last sync succeeded, the
  coordinator polls every 30 s as a safety net; otherwise (no socket, or a
  sync paused on an error, no progress, missing keys or a rotation, or sync
  turned off) every 5 s. A dropped
  socket reconnects after a jittered, doubling wait (1-2 s at first, at most
  30 s; at once when the browser comes back online; the longest after being
  replaced by another socket for the device). Going offline drops the
  socket, since one can stay open across a silent network drop. Close 4401
  or 4403 ends the channel, and so does an HTTP sync refused for the
  session or device (an upgrade refused with 401/403 reaches the browser
  only as close 1006); the next successful sync starts it again. The client
  sends nothing on the socket, so no plaintext or envelope ever travels on
  it; events go up and down over HTTP only. That is a deliberate narrowing
  of #108's socket upload and inline envelope delivery, keeping one data
  path that #107 already secures. A browser whose content security policy
  doesn't let `connect-src 'self'` cover WebSockets simply keeps polling.

## Chat content blobs (v1.1, #110)

Each chat message's content (its text now, a photo or file later) is a
**content blob**: sealed on the device under its own random 32-byte AES-GCM
key (`web/chat/chat-blob-crypto.js`), kept outside the event log, and named
by the SHA-256 of its sealed bytes. The key travels only inside the
encrypted chat event, so the service stores ciphertext it can't open and
deleting the blob deletes the content.

- **Format 1:** version byte 1, a 12-byte random nonce, then the AES-GCM
  ciphertext and its 16-byte tag; the additional data binds the format. A key
  seals one blob only. Blobs are 29 bytes to 4 MiB plus 4 KiB.
- **Routes.** `PUT /api/chat/blobs/<ref>` stores a blob (raw bytes; the
  service checks they hash to `<ref>`, and nothing else). Storing the same
  blob again is a no-op. `GET /api/chat/blobs/<ref>` returns it, re-checked;
  404 means it hasn't been uploaded yet, and 410 `chat_blob_deleted` means it
  was deleted, which clients show as a deleted message rather than an error.
  `POST /api/chat/blobs/retire` with `{"refs": [...]}` (at most 64) deletes
  blobs. Every route needs a trusted device of a member who may take part in
  the household, and only reaches that household's blobs.
- **Deletion.** There is no direct `DELETE`. When the engine's chat page
  lists blobs as retired (an edit replaced one, its author deleted the
  message, an admin removed it), every device deletes its local copy, and the
  author's device (an admin's, for a removal) asks the service to retire
  them once the replacing event is accepted (#111). The service retires a live blob only for the member who uploaded it
  (from any of their devices) or a household admin, all of a request or none
  of it; already retired blobs are skipped. A retired blob keeps a tombstone
  (its reference, size, uploader and times, no bytes), so it is not served
  or accepted again. A device that was offline deletes its copy when it next
  syncs and reads a page.
- **Deleted before uploaded.** A retire that names a blob the service
  doesn't have yet (an outbox still holding the upload, an upload in
  flight) is kept as a claim for that member. The upload is refused (410)
  when it comes from the claiming member or when an admin claimed it; a
  claim by anyone else can't stop another member's upload, and it is
  dropped when the upload is stored. A device whose own blob is deleted
  while its upload is in flight also retires it right after the upload.
- **Erasure on the service.** Retiring drops a blob's bytes with SQLite's
  `secure_delete`, so freed pages are zeroed, and then checkpoints the WAL;
  household purge zeroes chat pages the same way and checkpoints after it
  commits. An admin removal's audit row commits together with the retire. Backups taken earlier
  still hold the bytes, and restoring one brings those blobs back as they
  were at the backup, tombstones included or not; devices that already
  deleted their copies keep their own record of the deletion.
- **Bounds.** Per household: 256 MiB of live blobs and 250,000 live blobs;
  beyond either, uploads fail with `chat_storage_full` until content is
  retired. Running counts keep every upload's check constant-time.
  Tombstones (at most 500,000 per household) and claims (at most 20,000 per
  member) never block retiring: past their bound the oldest are dropped
  (for claims, only the claiming member's own), after which a very old
  retired blob could be uploaded again by someone who kept its bytes. #125
  revisits these bounds with measured chat volume.
- **On the device,** blobs live in their own IndexedDB database per
  household ([STORAGE](STORAGE.md#chat-content-blobs-v11-110)).
- Household deletion purges every blob and tombstone at finalization. An
  admin removal adds a `chat_content_removed_by_admin` audit row with a count,
  never what was removed.

## Photos and files (v1.1, #114)

An attachment message is a chat event of kind 44 with content kind 2
(`attachment`, already in the engine). Its content blob is the **chat
attachment manifest** (format 1, `web/chat/chat-attachments.js`): JSON
sealed like any message, holding the caption and, per file, its name, type,
size, an optional thumbnail and its ordered parts. Each part, and each
thumbnail, is a content blob of at most 1 MiB of the file, sealed under its
own key. Limits: 10 files per message, 25 MB per file, names up to 200
characters, captions up to 4,000, a manifest up to 256 KiB.

- **Sending.** Each file is read and sealed in parts as it goes (no whole
  file in memory), then the manifest. Parts and thumbnails are uploaded
  first, the manifest last, and the event after all of them, so a receiver
  that sees the message finds every part. A send that fails while sealing
  drops the parts kept on this device. If the event itself can't be stored,
  the sealed parts stay in this device's blob store, as ciphertext that is
  never uploaded; nothing cleans them up yet, a known local leak of storage
  (not of content).
- **Photos** (recognized by their first bytes: JPEG, PNG, WebP, whatever
  their declared type) are drawn again on a canvas before sealing,
  which removes EXIF, GPS and camera metadata; a 320-pixel JPEG thumbnail is
  made from the same pixels. A photo over 40 megapixels, or in another format
  (HEIC, say), is refused with a message saying what to export.
- **Opening.** The manifest is opened once per room (checked for shape and
  sizes), then each part is fetched, checked against its reference and kept.
  A file's parts are joined into a Blob for a download or the viewer; nothing
  decrypted is stored.
- **Deleting.** Only deletion (for everyone, or an admin's removal) applies;
  attachments aren't edited. The deleting device names the manifest and its
  parts when it sends the delete, from its kept copy or by opening the
  manifest; the service retires them all in batches of 64, and each device
  deletes the parts it kept with the manifest. A device that never fetched a
  manifest has no parts to delete.
- **Limits by the service:** a household holds 256 MiB of live blobs, so a
  message of ten 25 MB files can fill a small household's chat storage;
  uploads then fail with `chat_storage_full` and say so.

## Chat relay (v1.1, #111)

Chat events are canonical events in the same signed, encrypted envelopes as
household events (protocol 1, envelope 1), but they travel in a stream of
their own (`server/chat-relay-service.mjs`) and land in the device's chat log
rather than the household history ([ADR 0008](decisions/0008-household-chat.md)).
Until the chat key exists (#123) they are encrypted under the household key
epoch, like household events. Chat and household envelopes share one signature and AAD
domain; the client tells them apart by kind (the household history refuses
chat kinds and the chat pass accepts only them). The chat key story (#123)
should also separate the two domains.

- **Routes.** `POST /api/chat/events` takes a KSEV batch (at most 20
  envelopes); `GET /api/chat/events?cursor=&limit=` returns a KSEP page of at
  most 200; `GET /api/chat/status` returns `{ deviceSequence, latestCursor }`
  for the calling device. Every route needs a trusted device of a member who
  may take part in the household; pushes also need household sync set up and
  wait out a pending key rotation (409 `sync_rotation_pending`).
- **The same envelope rules as the household relay:** the authenticated
  device's own envelopes only, under a key epoch it holds; each device's chat
  sequence (counted apart from its household sequence) has no gaps; a repeated
  event ID is accepted only with identical bytes; the logical-time advance
  bound applies to the chat stream's own clock; pages only show epochs the
  reading device may read. Its own cursor, sequence and quota (250,000 chat
  events per household) keep chat from counting against household limits.
  Accepted chat sends the same push and live hints as household events.
- **The client** (`web/chat/chat-room.js`) runs one chat pass after each
  successful full household pass of the sync coordinator (a household pass
  that pauses holds chat back too), and a message sent hints the coordinator
  at once. A pass uploads each pending event's content blob, then pushes the
  events in batches of 20 (at most two batches), then asks the service to
  retire the blobs those events replaced (an edit's old text, a deleted
  message's), then pulls up to five pages; a pass that leaves more continues
  on the coordinator's normal continuation schedule. Each pulled event is
  checked as household events are: from a device in the verified directory,
  not revoked before the current epoch, not from before its device's
  history, signed by one of that device's keys, and carrying the same event
  ID, household, author (the signing device's member), device and logical
  time inside as outside; its kind must be a chat kind.
- **Refused events.** An event that says something that can never pass (not
  a chat event, a mismatched identity, a revoked or not-yet-granted device)
  is skipped and remembered (the last 100) for the chat view to report, so
  one bad event from a member's device can't stop the household's chat. A
  signature that doesn't verify pauses chat once (the device may have
  changed its key after this pass read the directory) and is skipped only if
  it fails again on a later pass with a fresh directory. Anything else (a
  device this one doesn't know yet, a missing key epoch, a storage error)
  pauses chat until a later pass. Pushes take at most two batches a pass, so
  chat stays within a small share of the coordinator's request budget.
- **Admins.** Whose removals count comes from the service's own record: the
  device directory (`/api/sync/devices`) marks each device's member
  `householdAdmin`, the rule the service uses to let a member delete others'
  blobs. Devices keep the last list they saw, so removals show offline. The
  engine applies the list when it reads a page, so a removal counts while its
  author is an admin; a change of admins re-checks which blobs that retires. If the service refuses a blob deletion outright (the
  member isn't an admin by its record), the event is sent anyway, the blob
  stays on the service, and the refusal is reported; a deletion that fails
  for now is retried with the event.
- **Sequences.** A device's chat log starts with a provisional sequence. The
  first pass asks `/api/chat/status`: events written before then (offline,
  on a fresh device) are renumbered after the relay's count and sealed again.
  Later passes ask only while something is pending; events at or below the
  relay's count were accepted before a lost reply and leave the outbox
  without being sent again. A pending event sealed under an older key epoch
  is sealed again under the current one before it leaves the device.
- **Failure handling.** Chat trouble is reported to the chat room and the
  household pass still finishes; only lost access or a deleted household
  stops the whole pass. Blob requests go through the coordinator's guard
  (unlocked only, within its request budget, aborted when sync stops).
- **Quota.** At 250,000 chat events a household's pushes fail with
  `chat_limit` and outboxes wait; retention (#125) is what frees room.

## Delete for me (v1.1, #119)

Deleting a message "for me" hides it on all of the member's devices and
changes nothing for anyone else, so it can't be a household or chat event:
every member's devices hold those keys. Each member instead has one record on
the service (`GET`/`PUT /api/chat/hidden`, compare-and-set on its revision,
at most 256 KiB) holding the IDs they hid, sealed by `web/chat/chat-hidden.js`
(format 1):

- The IDs, 16 bytes each, sorted and packed, are encrypted with a new random
  AES-256-GCM key per revision (at most 10,000 IDs: 160 KB, about 213 KB in
  base64url, with room for 64 recipients). The additional data binds
  household, member, revision and the writing device.
- That key is wrapped to each of the member's trusted devices from the
  verified directory, by device and key fingerprint: an ephemeral ECDH P-256
  key and HKDF-SHA-256 to the device's agreement key. Other members' devices
  are never recipients. This stands in for a member-wide key provisioned to
  the member's devices (#119 suggested one): the record is the only thing such
  a key would protect, and sealing each revision to the member's current
  devices needs no new provisioning path; a revoked device simply isn't
  sealed to again.
- The writing device signs every field with its current key. A device opens
  a record only from a trusted, unrevoked device of the same member, for this
  household, member and the revision the service gave, and refuses a revision
  older than one it already saw.

Each chat pass asks only for the revision unless something changed (a hide
here, or the member's devices). Hiding works offline: the ID is kept on the
device and the next pass reads the record, adds it, and writes the result.
Hiding only adds, so two of the member's devices writing at once merge (the
loser of the compare-and-set reads and writes again). Keeping the record
alive:

- A device added or rekeyed since the last write can't open it. If another of
  the member's current devices can, that one writes it again on its next
  pass, sealed to the newcomer too; meanwhile the newcomer's own hides wait
  ("arrive once one of your other devices syncs").
- If none of the member's current devices can open it (all new or rekeyed),
  or its writer is no longer trusted (revoked, removed, rekeyed), a device
  writes it afresh from what it holds. Hides that only a device which is
  gone held are lost; every remaining device keeps its own.
- A device waiting on another that never syncs again (abandoned but not
  revoked) waits until that device is revoked.
- A record older than one a device already saw (a server restored from a
  backup, or one withholding a write) is never trusted to drop anything: the
  device writes back what it holds on top of it.

The record isn't compacted: messages deleted for everyone stay listed (they
show as "This message was deleted", which can itself be hidden), so the
10,000 limit counts every message a member ever hid; retention (#125) is
where old ones can go. A removed member's record stays on the service, sealed
to their now-untrusted devices, until the household is deleted. The service
sees only the record's size, timing and revision. It can't read, forge or
move one; it could withhold one (fewer hidden messages on a device that
hasn't kept them, until a device that has writes again).

## Read receipts and typing (v1.1, #120)

Two small signals for the household chat, neither of them a chat event, and
neither ever sent or stored in the clear: the service sees only that
encrypted frames passed through.

**Read cursors (#121).** A receipt is a *cursor*, "read up to this message",
not a record per message, so storage is constant however long the chat grows.
Each member has one slot on the service (`GET /api/chat/receipts` for everyone's,
`PUT /api/chat/receipts` for their own, compare-and-set on `expectedRevision`),
latest only: it is overwritten, never appended to the chat log. A slot is a
household-key sync envelope (the same AES-256-GCM and ECDSA signature as a chat
event, `web/chat/chat-presence.js`), at most 4,096 bytes, whose
`deviceSequence` is the revision it replaces; the service checks that it comes
from the writing device, under a key epoch the household has, and nothing else.
Its plaintext (format 1) is the cursor (`postedAt` and `messageId`), when it
was read, and the member's two settings.

- A message counts as read by a member when it is at or before their cursor in
  (`postedAt`, `messageId`) order. A deleted message keeps its place, so it
  still counts toward the cursor. This is the order messages are posted in;
  two devices with clocks seconds apart can disagree on a message or two near
  the edge, which shows as seen slightly early or late.
- Cursors only move forward. Two devices of one member merge to the later one,
  and a lower cursor is never written over a higher one (the loser of a
  compare-and-set reads, merges and writes again). Other members' slots are
  trusted only from a device that is that member's, and an older revision than
  one already seen is ignored.
- The client marks a message read only when its row is at least half on screen
  in a visible, focused window with the chat showing (an `IntersectionObserver`
  on the rows, the page's visibility and focus), not when it was merely
  downloaded or a push arrived. It writes at most once every 2 seconds; the
  service allows 40 writes a minute per device.
- Settings, in the same slot so every device of the member sees them
  (the settings that were written last win): **Send read receipts** and
  **Show when I'm typing**, both on by default. Turning receipts off clears the
  stored cursor (the slot says "none"), stops collecting one, and hides other
  members' receipts from that member on all their devices: reciprocity. The
  settings share the slot, not the member's private "delete for me" record
  (#119) as the story suggested: that record is sealed to the member's own
  devices, so it couldn't carry anything the others should read, and the two
  settings are not secret from them anyway.
- The slot is fetched when the chat opens, on a `RECEIPTS` live hint, and at
  most every 15 seconds on the chat pass. The "Seen by" line shows under the
  member's latest message ("Seen by everyone" when every other active member
  has); opening it lists each reader with the time of the report that covered
  the message.
- Where the story named Rust for the merge and projection: the cursors are
  per-member presence, not household or chat state (they are not events, are
  not replayed and are not part of any history), so they live beside the
  device's other presence code in JavaScript with tests, and the engine and
  its ABI are unchanged.

**Typing (#122).** Typing is ephemeral. The client sends a sealed frame
(the same envelope, plaintext kind `typing`, `on` true or false) over the live
channel at most every 3 seconds while the composer has new input, and `on:
false` on send, clear, blur, lock or page hide. The service relays the frame
unchanged to the household's other connected devices whose member may chat,
and keeps nothing: it checks only that the frame is at most 2 KiB, is JSON, and
names the sender's own household and device, and it drops frames faster than a
burst of four then one a second (a connection that keeps sending them is
closed). A receiver verifies the frame like a chat event, drops one that is
not newer than the last it accepted from that device (the sequence is the
sender's clock in milliseconds, so a replay shows nothing), and shows the
indicator for 6 seconds unless refreshed, so it disappears within 6 seconds of
the person stopping, closing, locking or losing connection. Nothing about
typing is written to disk on either side. Turning it off stops this device
sending; the member still sees others'. The indicator is visible text beneath
the list and is the log's accessible description, not a live region, so screen
readers aren't interrupted on every change. Only the tab that holds the
device's live channel (one per device, by Web Lock) sends or receives typing.

## Privacy boundary

Ciphertext payloads conceal content only to the extent that key management and client integrity hold. The relay can still observe routing IDs, ciphertext lengths, timing, delivery patterns, and possibly IP/log metadata. Document retention and access controls for these fields. Do not claim perfect anonymity, complete metadata privacy, or protection from a compromised authorized client.

## v0.9.x Protocol Record

The local service exposes authenticated `/api/sync/status`, `/api/sync/devices`, `/api/sync/events` push/pull, `/api/sync/bindings`, provisioning grant/acknowledgement, and epoch compare-and-advance operations. Every route uses the existing active-member, trusted-device, session, household and revocation checks. Households are bounded to four active adults and 16 trusted devices. The built-in server binds loopback only; use a trusted TLS-terminating proxy for external HTTPS origins. Other bounds: 128 epochs, 128 live provisioning grants, 256 sync requests/device/minute, 20 events or identity controls/batch, 200 KiB/request, 8 KiB/envelope, 10,000 local/outbox events, and 100,000 relay events/household. Sync cursors are opaque base64url relay sequences and never reuse the local catch-up cursor.

The browser stores non-extractable device keys and sealed epoch keys in a separate IndexedDB database. Canonical event rows remain the state authority in `kin` schema 2; `sync_state`, `sync_outbox`, and `sync_bindings` are separate stores. Each new local event and its outbox entry commit atomically. The exact encrypted envelope is retained through retry and after acceptance so a cursor reset after relay restart can requeue the same bytes. A downloaded event advances the transport cursor only in the same transaction as canonical-byte persistence and successful Rust replay. The UI acknowledgement cursor remains independent.

The v0.9.3 baseline duplicated canonical layouts and fixed-offset metadata reads
in browser code. v0.10.0 resolved that debt with Rust-owned commands/codecs and
validated metadata through the narrow WASM adapter; see [ARCHITECTURE](ARCHITECTURE.md).
v0.10.3 additionally rechecks the durable local epoch after each awaited sync
response so a missed peer notification cannot resume private-key use under a
disposed root. Networking and Web Crypto remain browser responsibilities.

The server is intentionally in-memory in this incubation. It returns `durable: false`; full restart loses household identity/session and service-side relay records, and v0.9.x has no way to restore the same authenticated household. A relay-only cursor reset while identity state survives is detected; clients retain local canonical bytes and cached exact envelopes for retry. Sync is not durable across full restart, and ciphertext authored only by a device whose local state is lost may be unavailable. A newly joined/replacement adult receives current and later epochs only; v0.9.x does not grant pre-join epoch keys, so earlier history remains unavailable. All-device loss may make encrypted data unrecoverable.
