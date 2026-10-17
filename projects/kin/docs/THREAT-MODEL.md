# Threat Model

**Status:** v0.12.3 implementation candidate; awaiting human review. Local authenticated encryption, credential/recovery root wrappers, locked startup, encrypted archives and signed transport-key migration complement encrypted sync. The service has durable identity/relay storage, backup/restore and explicit household lifecycle. Independent security audit, cross-browser certification and general rollback protection are not provided.

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

## Remaining Limitations

The incubation service stores identity and relay records in memory. Full restart loses household identity, sessions, pairing state, relay envelopes and cursors; surviving local encrypted history cannot alone resume that household's sync. A relay-only reset is detected against local high-water and exact cached envelopes are requeued when identity survives. Encrypted archive restore recovers local data only. There is no transparency witness, pre-join history grant for new adults, server-identity recovery or remote erasure. Missing epoch keys pause sync. Key-grant epochs come only from signed packages, so a relay cannot relabel an old key as a newer epoch. The current committed epoch, the committed-rotation marker and device revocation are still relay-asserted, so the expiry relaxation for committed-rotation packages only keeps an honest relay consistent; it gives no protection against a malicious one. Such a relay can serve any expired package signed by a device in its directory for an epoch at or below the epoch it reports, including a losing concurrent rotation proposal's key or one signed by a device it has hidden the revocation of. It still cannot relabel a key as a different epoch. Adult-signed rotation and revocation records are the long-term fix. Wrapper removal alone cannot invalidate a copied wrapper plus its secret; explicit root replacement in v0.10.2 protects newly re-encrypted local data, while prior copies remain exposed. New runtime private keys are imported nonextractable, but that is not hardware-backed storage. A compromised unlocked runtime defeats confidentiality. Independent security review and production operational hardening remain required.
