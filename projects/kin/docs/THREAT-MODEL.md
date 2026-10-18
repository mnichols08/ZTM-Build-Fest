# Threat Model

**Status:** Current as of v1.0.0; see [Known limitations at v1.0](#known-limitations-at-v10). Local authenticated encryption, credential/recovery root wrappers, locked startup, encrypted archives and signed transport-key migration complement encrypted sync. The service has durable identity/relay storage, backup/restore and explicit household lifecycle. Independent security audit, cross-browser certification and general rollback protection are not provided.

## Refactor track: decrypted history in memory while unlocked

An unlocked tab now keeps one decrypted copy of the canonical event history in
memory (the session event arena, [STORAGE](STORAGE.md)) instead of decrypting
it again for every command and refresh. Before, each operation produced a
fresh plaintext copy that waited for garbage collection, so an unlocked tab
already held household plaintext in memory: the decrypted events and the
rendered projection. This changes how long one copy lives, not what an unlocked
tab can read. Nothing new is written to disk. The only new persisted value is
a plaintext store-generation counter in `security_state`, which reveals only
that the corpus was replaced.

Lock, close, peer-tab lock and durable-epoch mismatch zero-fill the arena's
buffers and drop them. Zero-filling covers the arena's own buffers. It cannot
erase copies already handed to the engine or the DOM, or copies the JavaScript
engine made internally, and garbage collection still gives no physical-erasure
guarantee. A compromised unlocked runtime could read the history either way.

Rows are checked against their Rust metadata once, when they enter the arena,
instead of on every read. Tampering with persisted ciphertext still fails
authenticated decryption, but it is detected at the next full read (unlock, a
generation or count mismatch), not on the next command. A non-append rewrite
that does not go through Kin's replacement paths (and so does not bump the
generation) is not detected until the next unlock; such a writer already has
storage access.

From Slice 6 the engine instance also keeps its own copy of the canonical
history in WASM memory while unlocked (`rust/src/history.rs`), so a refresh
sends only new events. Before, every replay copied the whole history into
WASM memory and freed it afterwards, without zeroing it. WASM memory never
shrinks, so those bytes could stay resident until something overwrote them. The copy is
zero-filled and dropped on `kin_history_reset` and on lock (`kin_clear` from
`engine.dispose()`). As with the arena, zero-filling covers that buffer only.
From Slice 7 the instance also keeps the replayed household state of that
history (its checkpoint: Item and Note text and other derived values) between
calls. It is dropped, not zero-filled, on the same reset and lock. That state
is what every projection already produced and returned, so this lengthens how
long one copy lives, not what an unlocked engine holds.

Incremental rendering (Slice 4) adds no new plaintext copy. The engine keeps
its last projection buffer between calls, as its result buffer already did, to
compare sections and stamp revisions. The bridge keeps the last decoded state,
which `<kin-app>` already held. Both are dropped on lock (`kin_clear`,
`engine.dispose()`). Revisions are a rendering aid: they never feed replay,
storage, sync or authority. They come from exact byte comparison inside one
engine instance, not from hashes, so crafted content cannot make two different
sections share a revision.

## v0.13 recovery authority

Recovery requires a current trusted adult/device and a fresh claimant
credential; it never derives authority from an archive, stale device, or old
credential. Same-member replacement revokes the selected lost device.
Member-assisted recovery keeps the target member identity but replaces all of
that member's credentials/devices/sessions. A malicious approving adult can
authorize an attacker and lock out other active adults, consistent with the
existing one-adult removal authority; audit attribution and separate claimant
activation prevent silent impersonation but cannot prove honest human intent.

Restore over a surviving database preserves its newer authority and lifecycle
ledger. Loss of that database/ledger leaves no global anti-rollback witness.
Servers never hold plaintext content keys. All trusted key-bearing devices and
archives being lost makes encrypted history permanently unrecoverable.

## v0.10 local-at-rest boundary

Implemented protection after verified migration: an unauthorized person with persisted browser site data but
without an authorized Kin credential/recovery mechanism cannot trivially recover
household plaintext while Kin is locked. While locked, the running tab holds
no reminder titles. It keeps only suspended reminders' record ids, due times and
local vault id, and it cannot show a notification ([PRIVACY](PRIVACY.md)).
v0.9.3 does not provide this protection:
its canonical events, draft text and usable sync CryptoKeys survive logout.
The [v0.10 record](V0.10.0.md) gates this claim on complete migration, including
outbox duplicates and legacy provisioning/decryption capabilities.

This does not protect a compromised unlocked browser runtime, privileged malicious
extensions, OS malware, resident-key memory forensics, a compromised origin/build,
XSS while unlocked, someone able to satisfy the configured authenticator/recovery
path, or previously authorized devices that obtained plaintext/keys. Removing a
member or wrapper cannot erase copies. Browser garbage collection is not guaranteed
physical memory zeroization. Lock drops references and closes capability paths;
encryption protects persisted content, not a compromised running endpoint.

Ciphertext still exposes sizes, counts and minimal routing identifiers. Complete
site-data rollback cannot be reliably detected without an independent trusted
monotonic witness. Recovery-secret disclosure grants its intended access; loss of
all authorized secrets means permanent data loss. An incomplete migration remains
explicitly unprotected legacy data and must never be labelled securely locked.

Startup loads public security metadata only. Logout/manual lock cancels work,
clears household DOM/drafts and disposes the engine, store and vault. Broadcast
notification locks peers immediately; a durable lock epoch rejects stale storage
and network capabilities even if notification is missed. Wrapper revision checks
prevent stale updates undoing a removal. Old-version tabs must be closed/reloaded
for migration; no application can recall plaintext previously copied by them.
Lock also revokes the blob URLs of attachments opened or downloaded in the last
minute, so they no longer resolve. An attachment already showing in another tab
stays visible there until that tab is closed; Kin cannot reach another tab's
content, and a downloaded file is the person's own copy.

Encrypted archive plus its independently held recovery secret can recover a lost
profile's local history. Restore does not reactivate revoked devices or re-create
server identity; sync stays disabled on the restored household. Losing every
credential/recovery secret permanently loses the ciphertext.

## v0.12 household deletion and rollback boundary

The server persists `active`, `deletion_pending` and `deleted` state. A fresh
passkey-authorized request immediately invalidates sessions and rejects sync;
the 30-day pending interval exists to permit authenticated cancellation.
Finalization removes server-held ciphertext and authorization state while
retaining a minimal opaque household-ID tombstone. The state machine does not
delete browser stores, device-held plaintext/keys, exported archives or backups
outside the active database.

Kin refuses restore over an existing target containing any `deletion_pending`
household. The operator must cancel deletion using current valid household
authority or allow it to finalize first; this prevents stale backup authority
from enabling cancellation by a removed adult or revoked device during the
grace period. Existing finalized deletion tombstones are still merged into the
verified backup and its deleted household rows are purged/non-authoritative.
Active targets remain restorable. The admin restore command requires explicit acknowledgement.
If both the current database and the deletion record are lost, Kin cannot infer
a later deletion from a stale backup; this remains a rollback limitation, not a
global anti-rollback guarantee. The permanent tombstone is minimal but its
count grows with deleted households. No physical media sanitization,
cryptographic erasure of client keys or external backup expiration is claimed.

## Assets and boundaries

### v0.10.2 recovery-secret compromise

Explicit recovery replacement generates an independent random root and new
confirmed secret, re-protects every local event/key store, then retires old
recovery/PRF wrappers. Old copied wrapper+secret pairs cannot decrypt records
newly protected under the replacement root. The candidate alone protects the
transitional source-root bridge, which is removed from authority at publication.
This cannot erase copied plaintext, prior archives, sync epoch keys or material
captured in an unlocked runtime. Complete hostile site-data rollback remains
undetectable without an external monotonic witness. Journal/CAS checks reject
stale manifests, competing rotations and foreign vault/root journals through Kin.

Assets include household plaintext (items, handoffs, Talk topics, Pulse), event history, household/member/device identifiers, authentication credentials, device authorization state, encryption keys, pairing-session secrets, and member safety/expectations.

Trust boundaries include the browser UI ↔ Rust/WASM engine, local browser storage, authorized device ↔ sync service, service ↔ database/logs, and one pairing device ↔ another. The service should relay ciphertext, while household content and content keys remain on authorized clients. A compromised authorized client is inside the confidentiality boundary and can expose what it can access.

## v0.9.x threat assessment (historical; local lock added above)

| Threat                                            | Protected                                                                                                           | Partially protected                                                                                                        | Not protected                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Curious-but-honest service operator               | Household event semantics and content keys are not sent to the relay                                                | Household/device/member IDs, event IDs, epochs, timing, counts, ciphertext size, cursors, and membership links are visible | Traffic-pattern inference, availability, or a compromised authorized client    |
| Service database/process compromise               | Relay contains ciphertext only; no plaintext content key                                                            | Persistent routing metadata, public keys, logs, ciphertext and backups can leak                                            | Availability, honest completeness, or hiding metadata                          |
| Passive network observer                          | HTTPS outside loopback plus payload AEAD/signatures                                                                 | IPs, endpoints, packet lengths and timing                                                                                  | Anonymity or traffic analysis                                                  |
| Active network attacker                           | TLS, authenticated sessions, AEAD AAD, device signature, recipient-bound provisioning with epochs taken only from signed packages                               | Denial/delay                                                                                                               | Compromised origin/runtime or availability                                     |
| Malicious/replayed server response                | Signature/AAD prevent envelope substitution; stable IDs/conflicts and persisted cursors detect some replay/rollback | Reordering and withholding may be detected only against locally observed history                                           | First-client completeness or global anti-equivocation/transparency             |
| Revoked trusted device                            | Service rejects its sessions and new epochs exclude it                                                              | It can decrypt keys/ciphertext already held                                                                                | Forgetting prior plaintext/keys or remote erasure                              |
| Stolen locked device                              | Non-extractable device keys and OS lock reduce casual access                                                        | Browser profile access depends on platform/storage implementation                                                          | Hardware-backed protection or a compromised OS                                 |
| Stolen unlocked trusted device                    | Another trusted device can revoke future authorization                                                              | Existing plaintext and usable keys remain accessible until locked/revoked                                                  | Confidentiality during attacker control                                        |
| Malicious household member                        | Authenticated device signature identifies the key-authoring device; adult removal revokes future access             | Member can create valid content as themselves and may retain already provisioned history                                   | Preventing an authorized member from copying or misusing household information |
| Compromised browser/runtime, XSS, build or origin | Nothing cryptographic after code is executing with authorized access                                                | CSP, safe text rendering, dependency minimization reduce risk                                                              | Plaintext/key confidentiality and integrity                                    |
| Lost trusted device                               | Remaining device can revoke it and rotate forward                                                                   | Offline device learns only on reconnect; remaining-device key transfer is required                                         | Erasing downloaded data                                                        |
| All trusted devices lost                          | No server-held plaintext key or hidden escrow exists                                                                | Recovery only if a trusted device/key copy survives                                                                        | Decrypting history when all keys are lost; it may be unrecoverable             |
| Offline conflicting edits                         | Stable IDs, Lamport ordering, deterministic replay and domain validation                                            | Equal-time archive conflict policy is deterministic; intent may still need user review                                     | Inferring human intent or who is right                                         |
| Rollback/replay of old ciphertext                 | Exact event IDs/envelopes, local applied bytes and cursor high-water checks                                         | Relay restart is detectable against local high-water and cached own envelopes are retried                                  | Fresh-device completeness and global rollback detection                        |

The detailed design and guarantees are in [V0.9.0](V0.9.0.md). The following table is the historical v0.8 pairing assessment.

## v0.8 Pairing Threat Notes

| Threat                           | Desired mitigation                                                                                                                                        | Residual limitation                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stolen server database           | Encrypt event payloads on clients with keys unavailable in plaintext to the service; restrict and encrypt operational metadata where appropriate.         | Routing metadata, ciphertext size, timing, IDs, and backups may remain visible. Encryption design and key recovery need review.                                                           |
| Network observer                 | Standard transport security plus authenticated payload encryption; reject unauthenticated or replayed enrollment/sync requests.                           | Endpoints and traffic patterns may be observable; transport security alone does not hide content from the service.                                                                        |
| Lost or stolen trusted device    | Device screen lock/platform protection, short-lived sessions, remote authorization revocation, and key rotation for future events.                        | An unlocked device or copied plaintext/keys can expose downloaded history; revocation cannot remotely erase a disconnected device.                                                        |
| Unlocked authorized device       | Clear shared-device expectations, local OS protections, and minimize unnecessary retained plaintext.                                                      | Kin cannot protect household information from someone who already has access to an unlocked authorized device.                                                                            |
| Compromised pairing code         | Short expiry, high entropy, one-time use, rate limits, transcript binding, explicit mutual confirmation, and cancellation.                                | A compromised authorized endpoint or a user approving the wrong fingerprint can still enroll an attacker.                                                                                 |
| XSS or malicious script          | No unsafe HTML rendering, no `eval`, strict review of DOM sinks, minimal third-party scripts, dependency minimization, and a strong CSP where compatible. | Script execution in the authorized origin can access rendered plaintext and potentially keys; CSP is defense in depth, not a substitute for preventing XSS.                               |
| Malicious household text         | Treat all user content as data, render with text APIs/DOM construction, validate lengths and encoding.                                                    | Content can still be harmful or upsetting to a human reader; validation is not relationship moderation.                                                                                   |
| Revoked member/device            | Server checks current authorization on each operation; revoke sessions/tokens; rotate content keys for future events.                                     | Revocation does not erase data already downloaded, exported, screenshotted, or remembered. Old ciphertext may remain decryptable with keys already copied.                                |
| Compromised sync service         | Authenticate clients, validate opaque transport envelopes, limit service authority, monitor abuse, protect operational systems.                           | Service may deny, delay, reorder, replay, or withhold ciphertext and observe metadata. Clients must detect integrity/replay conditions where possible; availability cannot be guaranteed. |
| Anonymous household flooding     | Creating a household is limited to 3 per client key an hour (`server/pairing-service/bootstrap-limits.mjs`); operators can cap households (`KIN_MAX_HOUSEHOLDS`) or close creation (`KIN_ALLOW_NEW_HOUSEHOLDS=false`). | Without `KIN_TRUSTED_PROXIES` behind a proxy, every client shares one allowance. Distinct addresses (or IPv6 /64s) each get their own; only the cap or closing creation bounds the total. |
| Malicious dependency/build input | Minimize dependencies, pin/review updates, protect build/release process, avoid remote scripts.                                                           | A compromised browser, build tool, dependency, or distribution channel can undermine client-side protections.                                                                             |

## Metadata and anonymity

The relay sees household/member/device/session identifiers; event IDs; per-device sequence; key epoch; cursors; public device keys; ciphertext and wrapped-key sizes; event counts/timing; provisioning grant participants/expiry; revocation and rotation timing; IP and connection metadata. Encrypted payloads hide semantic event kinds, text, titles, descriptions, categories, and entity identifiers. Traffic patterns and which devices share a household remain observable. Kin does not claim anonymity or zero-knowledge service behavior.

## Security principles

- Assume household text and imported/persisted bytes are untrusted.
- Use standard cryptographic APIs and reviewed protocols; never custom cryptography.
- Minimize server knowledge and third-party script/dependency exposure.
- Fail closed on unsupported protocol versions, invalid authentication, and tampered envelopes; do not silently skip unknown content.
- Provide honest recovery and deletion behavior; do not promise recovery if all authorized keys are lost.
- Security claims require implementation, threat review, and validation, not documentation alone.

## Known limitations at v1.0

Plain language first, technical detail second. Each entry says who could
exploit it, what they would get, and what is planned. None of these lets a
stranger read household content without first controlling the relay server or
an unlocked household device.

### S4: the relay can hold back an event without the client noticing

**What it is.** A household's devices trust the relay to deliver every event.
A dishonest relay could quietly skip one, and the receiving device would not
know it was missing.

**Who and what.** Only someone running or controlling the relay. They could
make one device miss a change (an item added, a task completed). They cannot
read or forge the event.

**Detail.** Clients don't track a per-remote-device sequence high-water mark,
so a gap in another device's `deviceSequence` isn't detected. An honest relay
enforces contiguous device sequences on push.

**Planned.** Per-device sequence tracking on the client, with a visible
"missing changes" state.

### S5: revocation and rotation status come from the relay

**What it is.** When an Adult removes a device or rotates the household key,
other devices learn about it from the relay. A dishonest relay could hide a
revocation, or report rotation state that isn't true.

**Who and what.** Someone controlling the relay, working with a revoked
device. The revoked device could keep receiving keys for new epochs it should
no longer read, for example an expired committed-rotation package for an epoch
the relay reports, or a losing concurrent proposal's key. The relay still
cannot relabel a key as a different epoch: epoch numbers come only from signed
packages (#152).

**Detail.** The current committed epoch, the committed-rotation marker and
device revocation are relay-asserted (existing limitation R-3, Remaining
Limitations below). Kin no longer reuses a pending rotation key that was
wrapped for a device that has since left or re-keyed (#176), so an honest
relay is never handed such a key to keep.

**Planned.** Adult-signed revocation and rotation-commit records that every
device verifies.

### A6: a device that joins without sync keys is approved without a certificate

**What it is.** If a joining device submits its claim without sync keys, the
approval can complete without a device certificate.

**Who and what.** A buggy or modified client. The result is lost
availability, not exposure: other devices fail closed and won't send that
device keys, so it simply can't sync.

**Planned.** Require sync keys for every new claim.

### C4: most of the Content-Security-Policy is set in the page, not a header

**What it is.** Kin's main browser protection against injected scripts is
declared in the HTML page. Only `frame-ancestors 'none'` is sent as an HTTP
header.

**Who and what.** Matters only if something can alter the page before the
browser reads its meta tag, for example a misconfigured proxy that injects
content. Kin renders household text with text APIs, never as HTML.

**Planned.** Send the full policy as a header and add Trusted Types.

### C5: the recovery key can linger in memory and on the clipboard

**What it is.** JavaScript can't wipe a string, so the recovery key text
stays in browser memory until it is garbage-collected. After "Copy key" it
also stays on the clipboard until something else is copied.

**Who and what.** Someone with access to the unlocked device, its clipboard
history, or a clipboard-reading app. They would get the recovery key, which
unlocks that device's copy of the household.

**Planned.** Clear the clipboard after about 60 seconds if it still holds the
key.

**Password managers (since #163).** Setup and key replacement mark the key as
a new password, so the browser may offer to save it, and the recovery unlock
form can autofill it. That is the person's choice; it puts the key wherever
their password manager keeps and syncs passwords, protected by that account.
Each entry is named for the key's label ("Kin recovery key K-7F3A"), because
each device has its own key: under one shared name, saving a second device's
key, or a replacement, would overwrite the first. A replaced key's old entry
stays until the person deletes it; unlock asks for the current label's entry,
so autofill doesn't offer the old key. If setup fails and is retried, the
retry has a new key and label, so an unused entry may be left behind.

### C6: an export's header is readable without the key

**What it is.** The start of a Kin export can be read without its recovery
key. It shows when the export was made, how many changes and attachments it
holds, the Kin version, the vault ID, and the recovery wrapper IDs (from which
the recovery key label is computed).

**Who and what.** Anyone who gets the file. They learn those facts, not any
household content; the header is authenticated, so changing it makes the
export fail to open.

**Detail.** Package metadata is AAD for the archive key, not encrypted.

### C2 (residual): an opened attachment stays visible in its own tab after lock

**What it is.** Locking Kin revokes the attachment links it opened, but an
attachment already showing in another browser tab stays on screen until that
tab is closed.

**Who and what.** Someone who can see or use the unlocked computer after Kin
locks.

**Detail.** Object URLs are revoked on lock (#161); a browser cannot be made
to close or blank a tab the page did not create in a way it can control.

### Attachment removal by Limited and Temporary members is enforced by the app, not by sync

**What it is.** The app doesn't let Limited or Temporary members remove
attachments, and the relay refuses to delete a stored attachment unless the
uploader or an Adult asks. But the household event that marks an attachment
removed is not checked against the member's role when devices replay it.

**Who and what.** A Limited or Temporary member running a modified client.
They could hide an attachment from the household's view. The encrypted file
stays on the relay unless the uploader or an Adult deletes it.

**Detail.** Replay (`AttachmentRemoved`) doesn't know member roles; role
checks happen in the client (#156) and in the relay's blob deletion (#156,
server schema 9).

**Planned.** Carry member roles into replay, or move removal behind an
Adult-signed record.

### Push notifications reveal timing to push services (v1.1)

**What it is.** A device that turns on notifications (#85) gives the Kin
service a push endpoint run by its browser's vendor.

**Who and what.** The push service operator (Google, Mozilla, Apple or
Microsoft) learns when that device receives a push, which roughly tracks when
other members change something. The Kin service stores the endpoint and keys;
it already knew when the household had new events. Neither learns any content:
the payload is a fixed "something is new", encrypted to the device (RFC 8291).

**Detail.** Pushes are coalesced to at most one per device per two minutes.
Endpoints are allowlisted, so a subscription can't make the service contact
other hosts. Subscriptions are deleted when a device loses access.

**Planned.** Nothing further; notifications are opt-in per device.

### A published install identity is not encrypted (v1.1)

**What it is.** A household admin can choose to show the household's name and
icon on home screens (#78). That copy is stored by the service in plain form,
because the service builds the installed app's manifest from it.

**Who and what.** Anyone who can read the service's database or backups, and
the household's own trusted devices (which already know it). They learn the
published name, short name, description and icon, nothing else. It is off by
default, the panel says what is stored before the first publish, and only the
household's own trusted devices are served it.

**Detail.** Withdrawal and household deletion delete the row; backups taken
earlier keep it until they are rotated out. An installed app keeps showing the
old name and icon until its platform checks the manifest again, and on iPhone
and iPad until it is added again.

**Planned.** Nothing further; this is the opt-in trade the feature makes.

### Household chat: what the service and members learn (planned, #104)

**What it is.** The household chat epic ([ADR 0008](decisions/0008-household-chat.md))
adds a chat room with read receipts, typing indicators and "online now". This
entry records the boundary before the code exists; each story updates it.

**Who and what.**
- **The service** relays encrypted chat events and stores encrypted content
  blobs. It never sees message text, file names or contents, which message
  someone read, or what anyone typed. It does learn routing metadata: when a
  device holds a live connection, which device sent each event, roughly
  when messages are sent and how
  large they and their blobs are, and, while a member shares them, that a
  receipt, typing or presence signal passed between devices.
- **Household members** see each other's read receipts, typing and "online
  now" only while both share them; each member can turn off sending their
  own, which also stops showing them others'. None is kept as history: there
  is no "last seen".
- **Deleted messages.** Deleting or editing a message deletes its content
  blob on the relay and on every device (offline devices when they next
  sync); the log keeps the message event (who sent it, when, and that it was
  edited or deleted) but not its content. Nothing can recall what someone
  already saw, screenshotted, downloaded or exported, and a device that never
  syncs again keeps its copy.
- **Admin removal** of another member's message is shown to everyone as
  "Removed by an admin", never silent.

**Content blobs (#110, in place).** The service stores each message's
content as a blob sealed under that message's own key, which only the
encrypted chat event carries; it checks a blob's hash and records which
member and device uploaded it. A deleted blob's bytes are dropped on the
service with freed pages zeroed, and a tombstone (reference, size, uploader,
times) keeps it from being served or accepted again; a deletion that beats
its upload is kept as a claim that refuses the upload. Devices drop their
copies when they next read the chat. Only the uploader or a household admin
can have the service delete a blob; in a legacy household with no admin,
nobody can delete a removed member's blobs on the service (it fails closed).
The service also learns when each device fetches each blob (a read signal
to whoever runs it, finer than a read receipt) and when blobs are retired
(when messages are edited or deleted). Limits: any trusted device of the
household can upload blobs within the household's quota; a member who
copied a blob's bytes and key before deletion keeps them; service backups
keep deleted bytes as of backup time, and restoring one can bring deleted
blobs back on the service.

**Chat relay (#111, in place).** Chat events travel in their own relay
stream, encrypted and signed like household events and, until the chat key
(#123), under the household key epoch: anyone holding that epoch (every
device of the household that may sync) can read them, and the service can't.
The service learns each chat event's size, time, sending device and order,
and counts chat apart from household events, so it can tell chat activity
from other household activity. Devices accept a chat event only from a
verified household device, signed by it, with the same identity inside as
outside, so the service can't forge, alter or misattribute who wrote one; it
can still withhold or delay events, as for household sync. Two limits:
whether a deletion counts as an admin's removal rests on the service's
record of who is a household admin (the device directory's `householdAdmin`,
not signed by any device), applied when a page is read, so the service could
make a member's deletion show as an admin removal or hide a real one, and a
removal stops showing as one once its author is no longer an admin (its
content is gone either way). And an event that fails authentication is
skipped and reported rather than stopping chat, so a member's device can
send events other devices refuse, but can't block the room. The device keeps
chat events as those encrypted envelopes; the decrypted log lives in memory
only while unlocked.

**Edit and delete (#117, in place).** Editing replaces a message's content
blob and retires the old one; earlier versions aren't kept. Deleting for
everyone keeps the event (author and time) and retires the content
everywhere as devices sync; a delete wins over a concurrent edit. Deleting
"for me" is kept in a record sealed to the member's own devices and signed
by one of them: other members, and the service, can't read which messages a
member hid. That rests on the device directory: whoever can make a device
trusted for a member (an Adult approving it, a service that forges what the
directory says about revocation) can make it a recipient of later revisions,
as with household key rotation. The service learns that a member's record
changed, its size and when. A member's device that never syncs again keeps showing what it showed.

**Photos and files (#114, in place).** An attachment is one sealed manifest
(the message's content blob: caption, file names, types and sizes, and the
keys of its parts) plus one sealed blob per 1 MiB part and per photo
thumbnail, each under its own key. The service sees part sizes and hashes,
and the number of parts, which bounds a file's size to within a megabyte; it
never sees names, types or contents. Photos are drawn again on the device,
which drops their location, camera and other metadata; a browser that can't
do that refuses the photo. Other files are sent as they are, so a PDF's own
metadata goes with it. A member's device keeps decrypted names only while
the room is open. Deleting the message retires the manifest and every part
on the service and on each device that kept them; a copy a member saved or
downloaded is not recalled.

**Planned.** Each chat story records its own detail here as it lands.

### v1.0 was not tested across every browser and device

**What it is.** v1.0 shipped on the owner's decision with limited real-world
testing. The automated browser suites run the full flow on Edge for Windows on
every change. Beyond that, only the owner's and a few testers' use of the test
server on real phones and computers was recorded. Firefox, Safari on macOS,
Chrome on Android, installed-app updates and offline launch, roaming security
keys, separate networks and moving an export between physical devices were
not run ([V1.0_RELEASE_ACCEPTANCE](audits/V1.0_RELEASE_ACCEPTANCE.md)).

**Who and what.** No attacker gains anything from this. People on untested
browsers or devices may hit problems nobody has seen yet.

**Planned.** Run the remaining rows on later releases and report problems as
issues.

## Remaining Limitations

The incubation service stores identity and relay records in memory. Full restart loses household identity, sessions, pairing state, relay envelopes and cursors; surviving local encrypted history cannot alone resume that household's sync. A relay-only reset is detected against local high-water and exact cached envelopes are requeued when identity survives. Encrypted archive restore recovers local data only. There is no transparency witness, pre-join history grant for new adults, server-identity recovery or remote erasure. Missing epoch keys pause sync. Key-grant epochs come only from signed packages, so a relay cannot relabel an old key as a newer epoch. The current committed epoch, the committed-rotation marker and device revocation are still relay-asserted, so the expiry relaxation for committed-rotation packages only keeps an honest relay consistent; it gives no protection against a malicious one. Such a relay can serve any expired package signed by a device in its directory for an epoch at or below the epoch it reports, including a losing concurrent rotation proposal's key or one signed by a device it has hidden the revocation of. It still cannot relabel a key as a different epoch. Adult-signed rotation and revocation records are the long-term fix. Wrapper removal alone cannot invalidate a copied wrapper plus its secret; explicit root replacement in v0.10.2 protects newly re-encrypted local data, while prior copies remain exposed. New runtime private keys are imported nonextractable, but that is not hardware-backed storage. A compromised unlocked runtime defeats confidentiality. Independent security review and production operational hardening remain required.
