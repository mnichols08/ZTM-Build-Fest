# Security Policy

**Current security status:** Kin v1.0.0 (release candidate `kin-v1.0.0-rc.1`;
the release before it was v0.10.3) includes encrypted local household storage,
recovery/optional-PRF unlock, journalled root replacement, encrypted archives,
passkey-authenticated pairing, client-encrypted sync, durable identity/relay
storage, recorded household-admin authority, and encrypted shared household
settings. It is not independently audited or production-certified. Persistent
service databases and backups contain identity/routing metadata, authorization
state, encrypted settings and encrypted envelopes; they do not contain
household plaintext or content keys. Restore can roll back
authorization/revocation state. Encryption cannot protect a compromised
unlocked runtime, origin, privileged extension or OS, and rotation cannot erase
data, keys or archives already copied. See [THREAT-MODEL](docs/THREAT-MODEL.md),
[CRYPTOGRAPHY](docs/CRYPTOGRAPHY.md), [VERSIONING](docs/VERSIONING.md), and the
[v0.47 contract](docs/HOUSEHOLD-IDENTITY-DEFAULTS.md).

## Known limitations at v1.0

Kin v1.0 ships with these known limitations, each explained in plain language
in [THREAT-MODEL](docs/THREAT-MODEL.md#known-limitations-at-v10):

- **S4:** a relay can hold back an event without the receiving device noticing.
- **S5:** device revocation and key-rotation status come from the relay.
- **A6:** a device that joins without sync keys is approved without a certificate (it then can't sync; nothing is exposed).
- **C4:** most of the Content-Security-Policy is set in the page rather than an HTTP header.
- **C5:** the recovery key can linger in memory and on the clipboard after "Copy key".
- **C6:** an export's header (date, counts, version, vault and wrapper IDs) is readable without its key.
- **C2 (residual):** an attachment already open in another tab stays visible after Kin locks.
- **Attachment removal** by Limited and Temporary members is blocked by the app and relay, but not checked when devices replay the event.

## Supported versions

The earlier v0.35.1 corrective candidate requires fresh passkey authentication for
self-removal as well as removing another adult. Self-removal now requires fresh
passkey authentication before membership/device revocation and access-change
rotation. Session cookies alone cannot authorize leave. See the
[v0.35.1 security/release contract](docs/releases/V0.35.1.md); this is not
production certification.

Kin is a prototype and has no staffed security-support commitment or guaranteed response time. Follow the private reporting guidance below and include only synthetic data.

## Reporting a vulnerability

Please do not publish exploitable details, household data, credentials, pairing codes, private keys, or proof-of-concept material in a public issue.

Use GitHub's private vulnerability reporting for the hosting repository if that feature is enabled. If it is unavailable, contact the repository maintainer through a private contact method listed on their GitHub profile and identify the affected path/version. Kin does not operate a dedicated security mailbox or promise a response-time SLA.

Reports should include a concise impact description, affected version/commit, safe reproduction steps, and any mitigations already identified. Use synthetic data only. Do not access or retain another person's household information while investigating.

## Scope and response

Implemented security-sensitive areas include safe rendering, WASM
protocol/archive parsing and memory ownership, encrypted IndexedDB migration,
recovery/PRF root wrapping, WebAuthn, device and household-admin authorization,
encrypted archive import, lock cancellation, static shell caching, shared
settings encryption, and sync authorization/relay. Server identity/relay
metadata and ciphertext are durable, but sessions and in-progress ceremonies
remain ephemeral. A separate server backup is needed to restore service
authority; a local encrypted archive restores local history only. Report issues
against behavior that actually exists.

Maintainers will acknowledge and assess reports when available, coordinate a fix and disclosure where applicable, and avoid publishing sensitive details before affected users can reasonably respond. No response-time or remediation guarantee is made.
