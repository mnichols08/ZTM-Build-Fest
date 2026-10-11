# Portable Household Data

**Status:** v0.40.0 adds a package-format-v2 manifest in the existing KARC v1 encrypted container. Package metadata is authenticated with the encrypted payload. The payload keeps exact canonical event history, a validated membership snapshot when available, protected local context and attachment records, including ciphertext and digest metadata. Historical package-v1 archives remain readable. The complete package remains bounded to 160 MiB; attachments remain bounded to 64 records and 50 MiB ciphertext. Membership snapshots are descriptive data only; credentials, sessions, device trust and authorization are never restored from an archive. Earlier conceptual sections below are design history.

Current attachment and export limits are in [ATTACHMENT-ARCHIVE-LIMITS](ATTACHMENT-ARCHIVE-LIMITS.md). The pre-v0.39 corrective line keeps attachment ciphertext at a 50 MiB household bound and permits a bounded 160 MiB complete `.kin` archive, including protected snapshot serialization and KARC framing. Rust and browser import/export validation share this archive ceiling; the earlier 64 MiB figure below is historical.

## v0.23.0 calendar export

The Lists page can create a separate, unencrypted `.ics` convenience export
from active Items with explicit planning dates. It contains Item text and
all-day dates, not the canonical event corpus or household metadata. The UI
warns before the user requests a download. The file is a one-way snapshot for
calendar applications; it is not an encrypted backup, sync channel, archive
restore, or import format. Export is limited to 10,000 Items and 16 MiB, and
does not alter Kin storage.

## Implemented archive boundary

**Stable architecture decision (v0.10.2/v0.10.3): archives carry household
history, not authority.** They grant no membership or trusted-device authority.
Device approval and encrypted sync remain separate ceremonies; possession of an
archive and its recovery key is not proof of current membership.
Root rotation does not change old archives: each retains its original recovery key.

The public metadata carries package version, a bounded event/attachment summary,
recovery-wrapped root metadata and encryption parameters. The body is raw
AES-GCM ciphertext, avoiding redundant
base64 expansion of the whole archive. HKDF purpose `kin/archive/v1` separates its
key from local-record keys; manifest metadata is authenticated as AAD. The encrypted
body contains exact canonical rows and protected replay/catch-up context. The
normal export includes recovery wrappers; it never emits plaintext JSON or device
private keys. Keep the recovery secret separately from the archive.

Restore requires an unlocked empty target and the archive's recovery key. Kin
validates the manifest, authenticates and decrypts the complete payload, checks
attachment integrity and plans the whole canonical replay before browser
encryption/atomic import. The transaction checks that
the target history and transport stores are still empty. Imported events remain
byte-for-byte identical; fresh anonymous local actor/device IDs prevent new local
commands from impersonating the source trusted device.

Restored history remains local until the device completes normal household
approval. After approval, the ordinary encrypted sync path binds imported
historical identities to the approved device, deduplicates canonical event IDs,
and catches up with current authorized state. Restore alone supplies no server
trust, cookies, provisioning entitlement or epoch access. A stale archive
cannot reverse server-side removal, expiry, revocation or key state.

## Ownership principle

### v0.10.3 bounded KARC v1 processing

KARC v1 remains one authenticated payload with unchanged bytes/AAD semantics.
Internal raw-ciphertext APIs avoid base64 conversion of the whole archive.
Additive compact Rust framing/layout calls validate metadata/ciphertext lengths
and headers while browser-owned buffers retain opaque ciphertext. Existing
full-buffer ABI exports and old archives remain supported. Import authenticates
the complete body, verifies canonical data and full Rust replay, then publishes
atomically; corruption at the end cannot partially import. Durable lock checks
guard archive phases and the final native transaction aborts on lock.

This reduces avoidable copies without introducing KARC v2. Web Crypto's complete
AES-GCM payload and the bounded full canonical replay still require whole buffers;
desktop measurements in [V0.10.0](V0.10.0.md) quantify the practical limit.

> Household members should be able to obtain a usable copy of their Kin data.

Portability is a product and privacy responsibility, not only a storage convenience. An export should remain understandable and importable without access to the original browser installation or a live Kin server.

## Conceptual export

A future portable archive (possible extension: `.kin`) contains a versioned manifest and the canonical logical event stream:

```text
Kin Export
├── format_version
├── created_at
├── household_id
├── event_count
├── events (canonical envelopes and original payload bytes)
├── optional non-authoritative projection/checkpoint
└── integrity metadata
```

This describes logical sections, not a committed file/container encoding. The export format version is separate from application, event, ABI, and IndexedDB versions. Any included projection/checkpoint is disposable and must not replace events as source of truth.

## Plaintext and encrypted exports

An export may contain sensitive household history. A plaintext export is straightforward to inspect and recover but is readable by anyone who obtains the file; the UI must warn clearly and avoid creating one silently. The user should choose where to save it and be able to cancel.

An encrypted export may be considered later. It would require a reviewed standard encryption/KDF design, secure random generation, authenticated integrity, a clear user-selected passphrase/recovery policy, and interoperable import support. Kin must not invent cryptography or imply an export is encrypted unless it actually is. The possible passphrase flow, parameters, and key management are undecided; there is no encryption implementation in this release.

For device-to-device transfer, use the same validated portable representation or a separately reviewed secure enrollment protocol. Do not treat physical proximity, a QR code, or an export file as authentication by itself.

## Import validation and atomicity

Before changing current household data, stage and validate the entire import:

- Supported `format_version` and declared counts/lengths
- Well-formed structure, bounded sizes, and valid encoding
- Event IDs, household IDs, actor/device IDs, event versions, and payloads
- Duplicate IDs: exact identical duplicates may be deduplicated; same ID with different canonical bytes is an integrity error
- Deterministic event ordering and successful full replay
- Integrity metadata, when present, with a clear distinction between accidental-corruption detection and authenticity
- Household identity compatibility and explicit choice to restore/replace versus create a separate local household

An import must not merge a different household implicitly. Validate into a temporary destination, show the user the household/date/count summary, and commit atomically only after confirmation. Invalid input leaves the existing household state and source file untouched. Unknown newer event versions are preserved and reported as unsupported; never drop them to force an import.

## Integrity limits

A checksum can detect some accidental corruption but does not prove who created the export or protect plaintext. Authentication requires a separately designed signature/key trust model; encryption/authentication claims must follow [CRYPTOGRAPHY](CRYPTOGRAPHY.md). No cryptographic export guarantees are established here.
