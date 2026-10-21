# Privacy

v0.17.0 Checklist Steps add no Step-specific server interpretation or metadata.
Step labels, IDs, parent associations, and event semantics remain inside
canonical events protected by the existing local and sync encryption
boundaries. Rendering uses text nodes/textContent; household Step text is not
treated as HTML or sent to an AI service.

**Status:** Current as of v1.3.0. Local protected content is encrypted after verified migration. Sync is optional and uploads client-encrypted canonical event envelopes. The durable service receives no plaintext household event payloads or content keys, but it sees and persists routing and traffic metadata; no anonymity or zero-knowledge claim is made.

v0.10 encrypts local canonical events, duplicated outbox content, protected metadata
and private sync key material. Household drafts remain in unlocked memory only;
lock/reload discards them. Startup removes historical sessionStorage draft keys.
Locked startup does not load/replay household plaintext. The content-free
`household-locked` peer message and durable lock epoch invalidate peer capabilities.
Minimal routing IDs, format/lock state, ciphertext lengths and root wrappers remain
visible. Recovery secrets are user-held: Kin never persists them or sends them to the relay. If the person accepts, the browser saves one in its own password manager (THREAT-MODEL C5).

While unlocked, a tab keeps one decrypted copy of the household event history
in memory so it does not decrypt everything again for each change. It is never
written anywhere. Locking, closing the tab, or a lock from another tab
zero-fills and drops it; see [THREAT-MODEL](THREAT-MODEL.md) for what that
does and does not guarantee.

A refresh of the same tab can reopen the household without unlocking again
([ADR 0010](decisions/0010-reload-resume.md)). For that, the tab keeps a
non-extractable key in IndexedDB while unlocked and, only while the page
unloads, writes the root sealed with that key to its own sessionStorage. Both
are deleted when used, after two minutes, on any real lock, and when the
setting is off. No household plaintext or raw key is stored.

Local reminders are in-memory timers in one tab only and are never persisted.
A lock suspends them. While locked, Kin keeps only each reminder's record id,
due time and local vault id; it keeps no title and no timer, so nothing can
notify. Unlocking the same vault re-arms them with titles read from the
freshly decrypted records. A reminder that came due while locked fires once
after unlock. Reminders for records that were archived or removed are dropped,
as are reminders from another vault. Logout, leaving or deletion of the
household, and restoring an export discard reminders entirely. Reload and tab
close also discard them.

Same-origin tabs may exchange the fixed `events-changed` notification over `BroadcastChannel` after a committed write. The notification contains no household or event content; each tab reloads the event log from IndexedDB and reconstructs its own view locally.

Since You Last Looked stores only a local event cursor and local timestamp in the existing `local_context` singleton. A cursor means that this installation explicitly advanced through a boundary; it does not identify a person or assert that a named member read anything. Viewing or marking the summary does not write a household event. The additional `view-state-changed` BroadcastChannel message is a fixed, content-free marker; it carries no cursor, IDs, count, text, actor, or device.

Household information can be highly personal. Sync remains disabled until an authenticated adult explicitly enables it. Local-only use continues without sync.

## Intended principles

Future preferred member names and member/device groupings must be presentation
carried in encrypted household events; they must not become relay authorization
metadata. The existing automatic technical device name remains the narrow
exception needed to identify a device before provisioning. Typed nicknames are
not sent to the relay, and a preferred-member-name implementation must preserve
that boundary. See
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md) for
the migration and cross-platform privacy checks.

- **Local-first:** Begin with data stored and processed on the user's device where practical.
- **Minimum server knowledge:** If a service is introduced, design it to know as little household content as reasonably possible.
- **No advertising and no sale of data:** These are product commitments for the intended direction.
- **No household-content analytics:** Do not collect household content for analytics.
- **No default AI processing:** Household content will not be sent to an AI service by default. Kin is not designed around an AI runtime.
- **Encrypted synchronization:** v0.9 encrypts canonical event bytes before upload and verifies device signatures on recipients. A compromised authorized browser/runtime can still read content.
- **Explicit device authorization:** Pairing and local fingerprint comparison bind generated device keys before provisioning.
- **Device revocation:** Sessions are invalidated and future epochs rotate; prior plaintext/keys cannot be recalled.
- **Clear export and deletion controls:** These should be designed before meaningful household data is stored or synchronized.

## Local-first progression

The v0.1.0 release stores a local event history in browser storage and reconstructs state locally:

```text
Browser
   |
   v
IndexedDB
   |
   v
Rust reconstructs state
```

No remote sync exists in v0.1.0. Local-first describes where this release processes data; it is not a claim that browser storage alone is secure against device compromise, shared browser profiles, or malicious extensions.

## v0.9 Encrypted Sync Boundary

```text
Parent A
    |
  passkey
    |
 household key
    |
 encrypted events
    v
 sync service
    v
 encrypted events
    |
 household key
    |
  Parent B
```

The browser encrypts the exact canonical event bytes and signs envelopes with a device key. The service authorizes, stores, and forwards opaque envelopes; it does not reduce household semantics or hold plaintext epoch keys. Passkeys authenticate members and are not content keys. Full implementation details are in [V0.9.0](V0.9.0.md).

The service still sees household/member/device/session IDs, event IDs, per-device sequences, key epochs, cursors, ciphertext sizes, event counts/timing, provisioning participants, revocation timing, IP addresses, and connection patterns. It can infer which devices share a household and when they synchronize. Encryption does not make traffic anonymous.

Package-v2 exports keep canonical household events, an optional bounded
membership snapshot and protected attachments inside the encrypted payload.
Their public authenticated manifest reveals format/application versions,
export time, event/attachment counts and attachment ciphertext byte count so
compatibility and bounds can be checked. It does not expose household text or
IDs, membership records, credentials, device trust, sessions, or server
authorization. The encrypted membership snapshot is descriptive only. An
archive and its recovery key do not authorize pairing or sync.

The v0.11 implementation candidate stored identity, credential-verification
metadata, trusted-device authorization, opaque relay ciphertext, cursors,
provisioning coordination and bounded security audit entries in SQLite.
Successful relay acknowledgements follow a committed SQLite transaction;
recipient delivery/read, backup existence and hardware-level persistence are
not guaranteed. Sessions, WebAuthn ceremonies, unclaimed pairings and
rate-limit windows are process-local and reset on restart. Local event bytes
and cached exact envelopes remain on devices that hold them. Service backups
contain sensitive routing metadata and encrypted envelopes, and a stale restore
could roll back revocations or key epochs. v0.12 adds a durable deletion
state-machine, immediate session/write invalidation, a 30-day cancellation
window, final service-side purge and a minimal tombstone. Existing-target backup
restore merges newer tombstones; restoring without the newer database/ledger
remains a disclosed rollback limitation. Local event bytes, keys and exported
copies remain on devices that hold them. New/replacement adults do not receive
pre-join epoch keys in v0.9; missing history may be unavailable. All
trusted-device/key loss can make content unrecoverable. See [V0.11.0](V0.11.0.md)
and the [Threat Model](THREAT-MODEL.md).

Push notifications (v1.1, #85): off by default, per device. The service
stores each subscribed device's push endpoint and keys, and already knows
from the relay when a household accepts an encrypted event. A push carries a
fixed payload with no content, event type, author or count, and nothing about
delivery or clicks is recorded. The push service a browser uses (Google,
Mozilla, Apple or Microsoft) sees its own endpoint and when pushes arrive.
Revocation, removal and household deletion delete subscriptions. See
[Push notifications](PUSH.md).

Count on the app icon (#476): off by default, per device. When a member
turns it on, the installed app's icon shows a number (unread messages, and
optionally their own things today), worked out on the device from decrypted
state; nothing about it is sent to the service. The number is shown
**outside the lock**: anyone who can see the device's home screen, dock or
taskbar sees it, including after Kin is closed, and it tells them how much
is waiting (never what). Locking Kin and signing out clear it; turning the
setting off clears it at once. The browser and operating system receive only
the number.

Published install identity (v1.1, #78): off by default. If a household admin
turns on "Show our name and icon on home screens", the service stores the
household name, a short name, an optional description and the icons without
encryption, so it can build the installed app's manifest. Only the household's
own trusted devices can fetch them. Withdrawing deletes the copy, as does
deleting the household; backups taken while it was published still contain
it. The unlocked app uses the name and icon from encrypted household settings,
not this plaintext copy, so withdrawing publication does not remove internal
branding. See
[Household identity](HOUSEHOLD-IDENTITY-DEFAULTS.md#published-install-identity).
The latest accepted encrypted identity revision is cached only in the device's
root-protected sync-key store for offline startup. Its decrypted icon URL is
session-scoped and is revoked when Kin locks, logs out, or changes households.

Device names (v1.1, #71): the server keeps only each device's automatic name
("Chrome on iPhone", or "Device"), which it needs to show approvers which
device is asking to join before that device holds any household key. A name
someone types is a nickname: it travels only inside encrypted household events,
so the server, its logs and its backups never contain it. Labels typed before
v1.1 are reset to "Device" when the service starts, with freed database pages
zeroed and the write-ahead log truncated. Backups taken before that still
contain them until they are rotated out, and restoring one brings them back
until the next start resets them again. See
[Identity](IDENTITY.md#device-names).

Account key vaults (ADR 0018, #564): a member's device may store the
member's keys on the service, sealed so the service can't read them. The
service learns that the member has a vault, its size, its version and when
it changes (which hints at key rotations), how many ways it can be opened
and of which kind (password, passkey, both, backup code), and the public
parameters for those (a password salt, a passkey's credential ID). It never
receives the vault key, a password, a passkey's PRF output or a backup
code. Deleting the household deletes the vaults; backups keep old copies.
See [Cryptography](CRYPTOGRAPHY.md#account-key-vault-adr-0018).

Username and password sign-in (#557, #558): for a member who signs up with
a password, the service now stores **a username** (with the member, in
normalized lower-case form, unique among active members) and **an Argon2id
verifier of a key derived from the password** (`authKey`), with the
password's salt and iteration count. It never receives the password itself,
nor the separate password-derived key that opens the member's vault and
their devices' local data. It learns when the member signs in with the
password and from which address (as for a passkey login), and how many
attempts failed (to limit them). Whether a username is taken is answered to
anyone signing up, as on any sign-up page, at a limited rate. A username is
chosen by the member and can be anything that fits the rules; it need not
be a real name or an email address, and Kin has no email system. Deleting
the household deletes the usernames and verifiers. Removing a member, or a
member leaving, deletes their username, verifier, account vault and its
wrappers on the service (backups keep old copies), and the username can be
chosen again. The member's preferred display name, typed at
first run, is a household event like before: encrypted, never seen by the
service.

**Private storage for each member (ADR 0019, #489).** A member's private
things (the journal, "Just for me", reminders that follow them) are sealed
under a member key that only their own devices hold, read from their account
vault; no other member, household admins included, can read them, and the
service can't either. For each member who uses private storage the service
learns: that they use it; how many private events and blobs they have, how
large and when; which of their devices sent each one; and the member-key
epoch number each is sealed under (which says how many times their key
changed after a device of theirs was revoked). Never their content. Only that
member's other devices are hinted that something changed. A household admin
can turn private storage off for children and teens (it is on by default);
that only stops the service relaying it, and nobody gains access to what is
already on the child's devices. Temporary members have none. Removing a
member deletes their private stream on the service; deleting the household
deletes every member's. Copies on the member's own devices stay, as for
household data. Household exports never include private logs.

The planning design for these boundaries is documented in [Identity](IDENTITY.md), [Pairing](PAIRING.md), [Synchronization](SYNC.md), [Cryptography](CRYPTOGRAPHY.md), and the [Threat Model](THREAT-MODEL.md). These documents specify intended properties and open decisions; they do not establish implemented security guarantees.

## Data lifecycle

The implemented service retention policy distinguishes routine archival,
household deletion, device revocation and member removal in
[RETENTION](RETENTION.md), and specifies user-controlled portable copies in
[PORTABILITY](PORTABILITY.md). Service backups remain operator-managed with no
automatic expiry. Full encrypted relay history is retained until final
deletion or the hard event cap; it is not compacted. Deletion does not erase
copies already held by devices, archives or external backups.

### Voice messages (#134)

Kin asks for the microphone only when a member taps Voice, and releases it the
moment recording stops, is discarded, the page is hidden or the chat locks. A
recording stays on the device until it is sent as an ordinary sealed chat
attachment; nothing is uploaded while recording or reviewing, and nothing is
transcribed or analysed. The waveform (64 numbers) and the length travel
inside the sealed attachment manifest, so the service sees only a file of
ciphertext parts like any other.

### Chat in exports (#136)

An export can include the household chat (on by default, with its size shown
first, and only on a device that may read chat). It is encrypted with the rest
of the export, under the same recovery key, and holds chat events, message
text, photos, files and voice. Messages deleted for everyone appear only as
deleted placeholders. Your "delete for me" list goes only in your own export.
A file you export is outside Kin's control: anyone with it and its recovery key
can read the chat as of that moment. The admin's chat policy (#123) still
applies: a member who may not read chat has no chat to export, and restoring an
export does not give a device chat access it has not been given
([PORTABILITY](PORTABILITY.md#household-chat-in-an-archive-v11-136)).

## Claims boundary

Kin implements client-side encrypted event sync, but it has not received independent security review or production operational hardening. Do not call the service zero-knowledge, anonymous, or robustly recoverable; do not imply cryptography protects a compromised unlocked browser/runtime.

## v0.5.0 Pulse

Fixed Pulse value/expiry stay in local canonical events. No analytics, history UI, scores, interpretation, external service or content-bearing broadcasts. Expiry hides current detail without deleting source events. No actor ID/name is displayed. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

The summary derives household changes without monitoring people. It includes no read receipt, member-view tracking, actor attribution, contribution analytics, individual event timestamps, activity timeline, or summary history. It is processed locally, with no analytics, AI, or external service. See [V0.6.0](V0.6.0.md).
