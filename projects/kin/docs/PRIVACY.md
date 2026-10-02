# Privacy

**Status:** v0.1.0 processes the item event stream locally in the browser and persists it in IndexedDB. There is no account system, encryption, or sync service. Local browser storage is not a security boundary against device compromise, shared browser profiles, or malicious extensions.

The in-progress compose draft may be held in tab-scoped `sessionStorage` to survive a reload. It is not part of the event log, is not shared with another tab, and is cleared after successful save or explicit clear. Browser site-data controls remove both the event store and any draft.

Same-origin tabs may exchange the fixed `events-changed` notification over `BroadcastChannel` after a committed write. The notification contains no household or event content; each tab reloads the event log from IndexedDB and reconstructs its own view locally.

Household information can be highly personal. Future implementation must minimize exposure and communicate clearly what is stored and shared.

## Intended principles

- **Local-first:** Begin with data stored and processed on the user's device where practical.
- **Minimum server knowledge:** If a service is introduced, design it to know as little household content as reasonably possible.
- **No advertising and no sale of data:** These are product commitments for the intended direction.
- **No household-content analytics:** Do not collect household content for analytics.
- **No default AI processing:** Household content will not be sent to an AI service by default. Kin is not designed around an AI runtime.
- **Encrypted synchronization later:** Sync, if introduced, should protect household content in transit and at rest on the service; the threat model and key design must be specified before claiming end-to-end confidentiality.
- **Explicit device authorization:** Pairing or trusting a device must be intentional and understandable.
- **Device revocation:** Future users should be able to revoke a device's access.
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

## Future encrypted sync concept

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

This is a conceptual direction only. Passkeys, household keys, encryption, pairing, authorization, revocation, and sync are not yet implemented. A passkey is not itself a household encryption design. Key creation, backup/recovery, device enrollment, revocation, metadata exposure, and failure recovery all need an explicit threat model before implementation.

The planning design for these boundaries is documented in [Identity](IDENTITY.md), [Pairing](PAIRING.md), [Synchronization](SYNC.md), [Cryptography](CRYPTOGRAPHY.md), and the [Threat Model](THREAT-MODEL.md). These documents specify intended properties and open decisions; they do not establish implemented security guarantees.

## Data lifecycle questions

Event-oriented history is not an excuse to keep personal data indefinitely. The planning policy distinguishes routine archival, household deletion, device revocation, and member removal in [RETENTION](RETENTION.md), and specifies user-controlled portable copies in [PORTABILITY](PORTABILITY.md). Exact deletion propagation, backup windows, and service metadata retention must be finalized before remote sync ships; the policy documents are not implemented guarantees.

## Claims boundary

Documentation describes intent, not verified security properties. Kin must not be described as encrypted, private-by-design in a technically verified sense, or safe for sensitive content until implementation and review support those claims.
