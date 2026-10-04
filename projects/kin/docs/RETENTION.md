# Retention, Archival, and Deletion

**Status:** Household deletion and server lifecycle retention are implemented
through the v0.12.3 review candidate. The service holds opaque ciphertext and
limited authorization/routing metadata; it does not hold household plaintext or
content keys. See [V0.12.0](V0.12.0.md) for the user-facing lifecycle contract.

## Distinct operations

| Operation | Meaning | What it does not mean |
| --- | --- | --- |
| Archive | Hide a domain item/record from normal views using an explicit tombstone event; retain canonical history for replay. | Household erasure or physical removal. |
| Member removal | End one member's authorization and revoke their devices under the membership protocol. | Household deletion or retrieval of previously copied data. |
| Device revocation | Reject future sessions/sync and rotate access for an active household. | Erasure of local plaintext, keys or prior copies. |
| Household deletion | Block household authority immediately, allow a 30-day cancellation period, then purge service-controlled household data and retain a minimal anti-resurrection tombstone. | Remote erasure of local, exported, offline or externally backed-up copies. |
| Local reset | Remove data from one reachable browser/profile using its local controls. | Erasure from the service, another device or an export. |
| Encrypted archive | User-created portable local copy, encrypted under its separate archive/recovery boundary. | Server backup, sync identity or deletion tombstone. |

Archive is routine domain state; deletion is an authenticated service lifecycle.
Never overload one control or event to imply both.

## Service lifecycle retention

| Data class | Owner and retention |
| --- | --- |
| Active household identity and membership | Durable service database until member/household transition; minimum information needed to authenticate and authorize. |
| Trusted/revoked devices and credentials | Durable while the household is active or deletion is pending. Purged at final deletion. |
| Pending request metadata | Request time and finalization deadline only; retained for up to 30 days to implement cancellation. Request invalidates every household session immediately. |
| Household tombstone | One row containing the opaque household ID, version, `deleted` state and deletion timestamp; retained indefinitely because it is the only in-database protection against restoring an older backup over a deletion. It contains no members, credentials, device identifiers, event ciphertext or audit content. |
| Encrypted events, identity bindings, relay/device cursors and key epochs | Retained while active and throughout the 30-day pending window; all purged at finalization. These are opaque ciphertext and routing/coordination state. |
| Sessions and ceremony flows | Sessions are in-memory, expire within 12 hours, and are invalidated on deletion request. WebAuthn flows are in-memory with a 2-minute TTL and are cleared for the household. Restart discards both. |
| Pairing/provisioning | Pairing flows expire and are process-local. Provisioning grants expire after 10 minutes and are pruned during sync operations; finalization purges all remaining grants. |
| Security audit | Global 10,000-row maximum; oldest rows are discarded when exceeded. Finalization purges the household's audit rows. This count bound is not a time-based promise. |
| Temporary/rate-limit state | Process-local, bounded and expired/reset; never an authority source after restart. |
| Backups | No automatic service-managed retention or expiry. Database backup files remain under operator control and may contain the database contents as of backup time. Restore requires an explicit acknowledgement and merges newer tombstones from an existing target. |
| Local stores, offline devices and user-created exports | Retained outside the server deletion mechanism until each holder removes them. Kin cannot discover, revoke or erase inaccessible copies. |

The tombstone is intentionally the only indefinitely retained household record.
It prevents this database from accepting an old household state after restore;
it is not a global registry shared by hosts. Its one-row-per-deleted-household
cardinality grows with deleted households. There is no safe garbage-collection
deadline that preserves anti-resurrection for arbitrarily old backups.

## Backup and restore guarantee

An in-place restore reads lifecycle rows from the pre-restore target before
replacement. If any target household is `deletion_pending`, restore is refused:
cancel deletion using current valid household authority or allow it to finalize
first. This prevents a backup from restoring stale membership, device or
credential authority that could authorize cancellation during the grace period.
For other targets, existing finalized `deleted` tombstones override stale
backups, including pending or active backup states; data for a deleted ID is
purged and cannot become authoritative. Active targets remain restorable.
The command refuses restore unless the operator supplies
`--acknowledge-deletion-history` and prints a warning.

If both the current database and its later tombstones have been lost, a backup
from before deletion cannot prove that deletion occurred. Kin cannot safely
reconcile a deletion it has no record of. The explicit restore warning is not a
claim of rollback protection. Backups copied elsewhere are not deleted when
the active database purges a household.

## Event history growth

The service keeps the full canonical encrypted relay history and bindings while
a household exists. There is no checkpointing, compaction or history pruning.
The existing per-household event/binding limits reject further writes; they do
not discard old history and are not a scale or retention guarantee. Final
deletion purges the service's complete event and cursor history. Existing
client copies remain. Any future compaction needs separate proof for replay,
unknown event preservation, offline writers, tombstones and backup restore.

## Local and user-controlled data

Service deletion cannot reach IndexedDB, keys, application caches, plaintext
already seen by an authorized adult, screenshots, exported archives, or
external backup providers. Users must remove local site data on each reachable
device and manage exports/backups where they are stored. Browser storage
deletion is not a guarantee of physical-media sanitization.
