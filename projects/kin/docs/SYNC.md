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
check and the discard. A recipient set that is unchanged or grows keeps the
pending key.

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
