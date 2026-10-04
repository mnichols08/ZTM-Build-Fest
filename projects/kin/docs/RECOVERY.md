# Recovery and Household Continuity

**Status:** implemented through v0.13.4. Recovery restores only authority that a
currently active adult and trusted device can legitimately grant. It never
turns an archive, an old passkey, a stale device, or a server backup into new
household authority.

## Capability matrix

| Loss scenario | Recoverable? | Authority required | Data preserved? |
| --- | --- | --- | --- |
| One browser session lost | Yes | Existing trusted-device token and that member's valid passkey | Yes; server state and local encrypted storage are unchanged. |
| One trusted device lost | Yes, if another trusted device for that active adult remains | Active same-member session, fresh replacement enrollment, and explicit approval on the remaining device | Yes when the remaining device holds the retained epoch keys; the lost device is revoked. |
| One passkey lost | Yes, if another trusted device/passkey remains | Existing trusted device plus another valid credential; replacement adds a fresh credential | Yes; losing a passkey does not remove content keys already held by devices. |
| Browser profile wiped | Sometimes | Another trusted same-member device can authorize a fresh device, or a local encrypted archive and its recovery secret can restore local-only history | Shared history is preserved when keys are provisioned; archive restore remains local-only. |
| One adult loses all credentials | Yes, while the other adult has a trusted device and valid passkey | The other active adult authorizes; the affected adult establishes and activates a fresh passkey/device | Yes when the authorizing device holds and provisions the entitled epochs. |
| Server DB restored from backup | Yes, within the backup and retained tombstone limits | Service operator, verified backup, explicit deletion-history acknowledgement, and preserved newer lifecycle ledger | Opaque relay data and authority present in the accepted restore are preserved; plaintext keys are never in the DB. |
| Household key missing on one device | Sometimes | Another currently trusted, entitled device must provision the missing epoch | Only epochs held by an entitled device are recoverable; sync pauses instead of skipping ciphertext. |
| All trusted devices lost | Only from an encrypted local archive for local-only use | Archive plus its recovery secret; no sync authority is restored | Archive history may survive, but the server household and missing epoch keys cannot be recovered. |
| Both adults lose credentials | No supported server recovery | None; Kin has no email/SMS fallback, universal delegate, or server escrow | Encrypted local archives may remain locally readable with their secrets; shared authority is unrecoverable. |
| Deleted household | No | None after finalization | Server identity, relay data, and authority are gone; external local copies remain outside the service boundary. |

## Separate recovery authorities

- **Identity recovery** proves a member using a current member-bound credential.
  A household adult cannot silently become another adult.
- **Device replacement** authorizes a fresh device ID, device token, passkey,
  and device key pair. The specifically lost device is revoked atomically with
  approval and its sessions stop working.
- **Content-key continuity** is client-to-client provisioning of only the
  epochs to which the new device is entitled. The service stores wrapped
  packages, never plaintext household keys.
- **Server-state restore** restores the SQLite authorization and opaque relay
  database. It does not recreate client keys, local roots, or passkeys.
- **Household membership continuity** keeps the stable active member record.
  Replacement does not create a third adult or reactivate a removed adult.

## Replacement-device flow

An active adult signs in on a remaining trusted device, chooses the particular
lost device, and starts a ten-minute replacement invitation. The replacement
browser creates a fresh passkey and fresh device identity/key material. The
remaining device reviews the new-device fingerprint and approves the exact
claim with a fresh WebAuthn assertion. Approval revokes the selected lost
device and its sessions, trusts the new device, and lets existing
recipient-bound provisioning deliver retained epochs.

The claim is household-, member-, device-, and version-bound. It expires,
becomes single-use after activation, and cannot replace the approving device.
An old pairing code, revoked device, unrelated member, or archive cannot use
this path. Revocation cannot erase plaintext or keys already copied to the lost
device.

## Member-assisted recovery

Adult A proves current membership, trusted-device control, and their own fresh
passkey approval. Adult B proves participation by creating and then activating
a fresh passkey on a fresh device. A authorizes the bounded recovery ceremony;
A does not receive B's session, cannot authenticate as B, and cannot rotate B's
credential into one of A's existing credentials.

Approval keeps B's stable active member ID, revokes every old B device and
session, removes B's old credential records, and installs only B's newly
created credential/device. The new device is entitled to B's retained history,
which an authorized key-holding device may provision through the existing
recipient-bound encrypted packages. Removed members, unrelated members,
revoked devices, expired claims, stale approval versions, and activation
replays fail closed.

A malicious or compromised account can authorize an attacker as the recovery
claimant and thereby lock B out; the two-adult product already lets one adult
remove the other. Kin records the approving member/device and recovery target,
requires a separate claimant credential, and never makes A become B, but it
cannot distinguish a coerced or dishonest approval from a legitimate one.

## Honest failure boundary

Kin has no hidden server content-key escrow. If every trusted device, every
usable local archive/recovery secret, and every valid credential/recovery
authority is gone, encrypted household content is unrecoverable. This is safer
than silently granting authority from stale server state.

## Stale backups and rollback

When an older backup is restored over a surviving validated database, Kin uses
the backup for durable relay history but preserves the target's newer active
authority: member active/removed state, the exact current credential set,
trusted and revoked devices, device-token verifiers, current epoch/rotation
state, live provisioning grants, and a newer cancellation that returned a
household to active. Final deletion tombstones still override the backup, and
pending deletion still blocks restore entirely. Thus an older
device, credential, member record, completed recovery, or pre-rotation state
cannot silently regain authority through restore.

This is deliberately not generalized history merging. If the active database
and every later authority/deletion record are both lost, the service cannot
infer changes made after the chosen backup. Operators must preserve the latest
database/deletion ledger and choose a known-good backup. The explicit restore
acknowledgement remains required.

If the surviving target contains an active household that the selected backup
does not contain, restore is refused. Kin does not reconstruct a household from
authority metadata alone or silently discard authority created after the
backup. Replacement and member-assisted recovery evaluate the trusted-device
limit after their required revocations, so recovery remains possible at the
configured limit without widening the final device count.

## Stale devices and missing keys

A revoked device cannot reauthenticate, upload, pull, receive provisioning,
overwrite a newer epoch, or cancel a completed recovery. Recovery claims are
process-local, bounded, ten/fifteen-minute capabilities; approval versions and
activation are single-use, restart discards unfinished claims, and terminal
records are pruned.

If a legitimate device lacks an epoch, sync pauses and identifies the missing
history instead of skipping undecryptable events. The epoch is recoverable from
another trusted device that is entitled to it, or the history may be recovered
locally from an encrypted archive and its separate recovery secret. If neither
source still holds the epoch key, that history is unrecoverable.

## Server disaster recovery

A verified SQLite backup can restore server membership/routing metadata and
opaque relay ciphertext. Clients then reauthenticate and reconcile against the
restored authority. A backup alone never contains passkey private material,
device private keys, local encryption roots, plaintext household keys, or
plaintext content. If a surviving current database exists, keep it so restore
can preserve newer authority and tombstones. With only an old backup, later
revocations/deletions cannot be reconstructed and global rollback resistance is
not claimed.

## User-visible boundaries

The household view uses “Replace this device,” “Recover access,” and
“Authorize recovery,” not key-epoch or wrapping terminology. Before approval it
states whether another adult is required, which old devices/credentials stop
working, and that previously copied information cannot be erased. Missing key
errors say that some encrypted history cannot be recovered instead of silently
omitting it.

Final household deletion cannot be recovered. A removed member must be invited
as a new member rather than silently reactivated. An old backup cannot override
authority preserved by a newer surviving database. Loss of all entitled epoch
keys and archive secrets is permanent.

Native buttons, checkboxes, forms, confirmation dialogs, live status text, and
alert messages preserve keyboard operation and announcements. Controls retain
48-pixel targets, wrap in narrow layouts, and recovery uses the existing
visible countdown/expiry behavior. Revocation and recovery completion require
explicit confirmation plus WebAuthn approval; activation requires a second
passkey action on the recovering device.

