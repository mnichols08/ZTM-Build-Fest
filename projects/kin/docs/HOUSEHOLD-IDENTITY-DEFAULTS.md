# Household Identity & Shared Appearance

**Candidate:** v0.47.0 on `feat/kin-household-owner-settings`
**Base:** Personal Appearance v0.46.0 candidate at `158160ad4bc84a12b7346a4dfd5facf82f8cccca`

## Authority

The member created by household bootstrap is recorded as `owner_member_id` (the founder) and is the household's first **household admin**. Admin status is a server-recorded flag (`members.household_admin`) that only an active Adult can hold. The service derives it from the authenticated session's durable member and device records; request fields such as `ownerId`, `isOwner`, `admin`, `householdAdmin`, role, or display name are ignored.

An admin can make another active Adult an admin or remove admin status, using the same fresh-passkey ceremony as member removal (`POST /api/household/admins/options` and `/finish`). Children/Limited members and babysitters/guests (Temporary members) can never be admins. Kin refuses to demote, remove, or let leave the last admin who still has a passkey and a usable trusted device, so a household with a recorded admin always keeps one. Demoting an admin revokes any member invitations they had pending. Grants and revocations are audited as `household_admin_granted` / `household_admin_revoked`.

| Action | Household with an admin | Legacy household with no admin |
|---|---|---|
| Invite or approve a new member (Adult, Child/Limited, Babysitter/Guest) | Admin | Any Adult |
| Remove another member, revoke another member's device | Admin | Any Adult |
| Request or cancel household deletion | Admin | Any Adult |
| Recover an admin's identity | Admin | n/a |
| Recover a non-admin member, manage own devices, key provisioning and rotation | Any Adult | Any Adult |
| Change shared household settings | Admin | Nobody (fails closed) |
| Grant or remove admin status | Admin | Nobody (fails closed) |
| Delete an attachment's encrypted copy from the relay | Its uploader or any Adult | Its uploader or any Adult |

Settings reads require an active household member on a trusted device. Writes require that same authorization plus admin status. Removal, expiry, device revocation, deletion state, and session expiry therefore fail before the admin check.

Schema migration 9 records which member uploaded each attachment's encrypted bytes to the relay: the first device to upload them, which is normally the device that attached the file, but can be another member's device that re-uploads a cached copy after the relay lost it. Attachments stored before it have no recorded uploader, so only an Adult can delete them. The relay audits each deletion as `attachment_deleted` (attachment, member and device IDs; no content).

Schema migration 8 makes each recorded founder-owner an admin. It deliberately leaves ownerless legacy households without one. Kin does not infer an admin from member ordering, activity, device possession, or adult status. Those households keep the earlier Adult-level management so they remain usable, but shared-setting writes and admin grants fail closed. Claiming admin status in a legacy household is deferred for explicit security review.

The Identity & defaults management panel is absent from the rendered and accessibility trees unless the authenticated settings response identifies the current member as an admin. The Household access screen shows admin, invitation, and removal controls only when the server's household view reports `canManageMembers`. The server enforces every one of these rules independently. Other members keep their personal appearance controls.

## Protected contract

`household_settings` stores one household-scoped opaque ciphertext, its key epoch, SHA-256 integrity digest, monotonic revision, authenticated writer IDs, and update time. The client payload is version 1 and contains the normalized household name plus appearance mode, color source/seed, manual color metadata, and the processed optional image. The service cannot read the name or image. A write supplies the last observed revision; stale writes receive a conflict and never overwrite a newer value. The service accepts a write only at the authoritative active epoch, while rotation is not pending, and only from a device provisioned for that epoch. The encrypted record survives restart and is removed with household data.

Names are trimmed and NFC-normalized, must be nonempty, contain at most 80 Unicode code points and 240 UTF-8 bytes, and may not contain control, formatting, or surrogate characters. UI rendering must use text nodes/textContent. Locked and signed-out shells retain the neutral `Kin` title; the manifest and global PWA identity remain Kin.

## Appearance precedence

Each property resolves independently: an explicit device-local personal value, then the saved household value, then Kin's built-in value. `undefined` means follow household; a Kin-default color is an explicit color source; and `image: null` is an explicit no-background choice. “Use household appearance” clears all local overrides. Saving household settings never rewrites the personal appearance record, including the owner's.

Shared images use the Personal Appearance validation, bounded resize, metadata-stripping re-encode, dominant-color extraction, and palette generation. The normalized image is included inside the authenticated encrypted settings payload, never exposed by a public URL, and any decrypted object URL is session-scoped and revoked on lock. A revision is applied only after the complete payload validates; image decode failure falls back to its readable seed palette.

## Offline, rotation, and lifecycle

Shared writes require a current online authenticated session and authoritative revision. No offline mutation is queued. After transport decryption, digest verification, AEAD authentication, and content validation succeed, Kin stores the accepted envelope in the root-protected `kin-crypto-keys` IndexedDB database, scoped by household ID. A fresh offline unlock reopens that protected cache and decrypts it again with the recorded household epoch key; missing keys, routing mismatches, malformed records, and tampering fail closed. A lower server or cached revision cannot replace a newer validated cache, while a newer valid server revision replaces it after reconnection. The owner-editing capability is never restored from cache.

The ciphertext records its epoch and is readable only by devices entitled to that epoch. Rotation pauses settings writes; after commit, a later save must use the new active epoch. Key rotation does not weaken historic read entitlement. Revoked/removed devices cannot read or write through the API, and queued forged writes have no special path. Household deletion removes the server record; archive restore alone does not restore server authority.

## Known limitations

- Claiming admin status in a legacy household is deferred.
- The relay accepts and serves the encrypted revision; recipient receipt is not implied by write acceptance.
- An unavailable admin does not cause automatic promotion. If the only admin loses every device, other Adults cannot recover them, and admin actions stay unavailable. Households should keep a second admin. Authorized members retain read-only use of the last settings.
- "Child" is presented as the existing Limited member class and "babysitter" as the existing Temporary class. Kin adds no separate child or babysitter permission tier.
