# Debugging and Diagnostics

**Status:** Current through v0.7.4 Routine Stale-Action Correctness; privacy-safe diagnostic policy. Current ABI errors and UI feedback use bounded messages; no household-content logging exists. Symbolic diagnostics below remain future vocabulary.

## Useful diagnostic categories

Future errors should be deterministic and actionable without exposing private household content. Stable machine-readable codes may include:

```text
KIN_PROTOCOL_UNSUPPORTED
KIN_EVENT_INVALID
KIN_REFERENCE_UNKNOWN
KIN_STORAGE_FAILED
KIN_MIGRATION_FAILED
KIN_EXPORT_INVALID
KIN_SYNC_CONFLICT
KIN_AUTH_FAILED
KIN_CRYPTO_FAILED
```

These names are a diagnostic vocabulary, not current ABI codes or implemented APIs. The v0.1.0 manual ABI already specifies numeric WASM status categories in [ABI](ABI.md); a future bridge may map those categories to stable user/support codes without changing their domain meaning. Avoid duplicating error registries without need.

## Privacy-safe logging

> Debugging must not casually expose private household text.

Logs should favor bounded technical context:

```text
event_id
event_type
error_code
protocol_version
storage_schema_version
application_version
```

Do not log event payloads, item text, Handoff text, Talk topics, Pulse values, member display names, passkey assertions, encryption keys, pairing secrets, or decrypted exports. Avoid URLs, exception messages, and browser storage dumps that may include content.

If a developer explicitly opts into inspecting local synthetic test data, keep it local, visible, narrowly scoped, and off by default. Never upload diagnostic bundles containing household content automatically. Bug reports should include repro steps, browser/OS version, and redacted diagnostic codes rather than private messages.

## Planned failure investigation

- **WASM load/ABI mismatch:** check local artifact presence, expected export names, protocol version, and status code; do not dump linear memory.
- **Malformed event/replay mismatch:** use synthetic event IDs/payloads and canonical test vectors; report event kind, version, sequence, and error category, not text.
- **IndexedDB failure/migration:** record operation, schema versions, transaction state, and recoverability; preserve database bytes and do not clear storage as a debugging shortcut.
- **Protocol incompatibility:** report expected/observed version numbers and preserve unsupported bytes.
- **Sync conflict:** use synthetic households/devices, event IDs, logical order, and conflict class; do not include plaintext event content.
- **Authentication/cryptography failure:** never log credentials, assertions, pairing codes, plaintext keys, or secret material. Capture only reviewed high-level failure categories and protocol versions.

## Push notification checks

The in-app **Notifications on this device** panel is the safe first diagnostic. It shows this browser's permission, whether this device has a Kin subscription, and its mute state. It deliberately does not show or export the push endpoint, subscription keys, or endpoint fingerprint.

Test delivery with two distinct household members: opt in on the receiving member's device, leave it unmuted, then make and sync a household change from the other member's device. Allow up to the two-minute coalescing window. A second device belonging to the author is not a receiver, because selection uses the stable member ID and excludes all devices owned by that member. There is no manual push sender, delivery receipt, read receipt, or presence diagnostic.

If the panel cannot load subscription state, check the connection and retry there. If permission is blocked, change the site's notification permission in the browser. On iPhone and iPad, use the Home Screen installation. If the server reports notifications unavailable, its operator must configure an HTTPS VAPID subject; do not work around that state by exposing subscription details.

The original push design and its service, subscription, recipient, service-worker, and client contracts are tracked in [#85](https://github.com/mnichols08/ZTM-Build-Fest/issues/85), [#86](https://github.com/mnichols08/ZTM-Build-Fest/issues/86), [#87](https://github.com/mnichols08/ZTM-Build-Fest/issues/87), [#88](https://github.com/mnichols08/ZTM-Build-Fest/issues/88), [#89](https://github.com/mnichols08/ZTM-Build-Fest/issues/89), and [#90](https://github.com/mnichols08/ZTM-Build-Fest/issues/90).

A local “export diagnostics” feature, if considered, requires a preview/redaction policy and user consent. Diagnostics must not become hidden analytics or activity surveillance.
