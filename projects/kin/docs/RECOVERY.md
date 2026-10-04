# Recovery and Household Continuity

**Status:** implemented through v0.13.1. Recovery restores only authority that a
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

