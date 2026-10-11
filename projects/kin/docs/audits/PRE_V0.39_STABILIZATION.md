# Pre-v0.39 Stabilization

This working matrix follows [`POST_V0.38_TRUST_AUDIT.md`](POST_V0.38_TRUST_AUDIT.md).
No blocker is resolved until its original reproduction is rerun successfully.

## Remediation matrix

| Blocker | Root cause | Fix milestone | Regression test | Status | Commit |
|---|---|---|---|---|---|
| B-001 | Replay treats a greater Lamport time as proof an offline device observed an archive. | v0.38.2 | Original offline archive conflict; Rust distributed replay order permutations; future valid event after stale completion. | IN PROGRESS | — |
| B-002 | Responsibility replay rejects any assignment/clear after an archived target; automatic reconciliation emits the clear. | v0.38.2 | Original concurrent Responsibility/archive repro; deterministic cross-device no-op regression. | IN PROGRESS | — |
| B-003 | Relay accepts unbounded decimal logical times, and remote batch replay aborts atomically on one invalid event. | v0.38.2 | Original poison/time repro; shared ceiling/advance checks; invalid remote event quarantine followed by valid replay. | IN PROGRESS | — |
| B-004 | Last-Adult checks count active Adult records without checking a usable passkey and trusted device. | v0.38.3 | Original HTTP sequence; no-device/revoked-device safety; two usable Adults. | IN PROGRESS | — |
| B-005 | Device revocation is a session-only DELETE with no target-specific confirmation, accessible name, or fresh passkey. | v0.38.3 | Session-only denial; wrong/cancelled/valid fresh-auth flows; named-control UI regression. | IN PROGRESS | — |
| B-006 | Sync enable authorizes participation but does not require Adult trust authority. | v0.38.3 | Original HTTP repro; Limited/Temporary denial; Adult enable and member participation. | IN PROGRESS | — |
| B-007 | Service-worker cache name is frozen at v0.34 and install writes into the active cache. | v0.38.4 | Version consistency, separate staging, failed staging retention, activation cleanup, offline shell. | IN PROGRESS | — |
| B-008 | Protected archive serialization has a 64 MiB ceiling although encrypted attachment storage allows 50 MiB. | v0.38.4 | Original 11/12 attachment repro; single/multiple/aggregate/archive bound and digest checks. | IN PROGRESS | — |

## Original repro baseline

Run with Node 22.21.1 unless otherwise noted:

| Blocker | Baseline result |
|---|---|
| B-001 | REPRODUCED: merged offline completion fails replay with code 4. |
| B-002 | REPRODUCED: equal-time Responsibility change and clear fail with code 4. |
| B-003 | REPRODUCED: invalid responsibility poisons replay; 2^64-scale times pass the relay contract and exhaust subsequent writes. |
| B-004 | REPRODUCED: Adult A revokes B's only device and leaves; no usable Adult path remains. |
| B-005 | REPRODUCED by audit code-path inspection: generic “Revoke device” button and session-only DELETE. |
| B-006 | REPRODUCED: Temporary enables sync and Adult sees it enabled. |
| B-007 | REPRODUCED by audit code-path inspection: static worker cache is v0.34.0. |
| B-008 | REPRODUCED: 12 valid attachments (48.05 MiB) fail serialization at the old 64 MiB protected-value cap. |

The initial default Node runtime was 22.12.0, below Kin's declared 22.13 floor; B-004 and B-006 were rerun on the installed 22.21.1 runtime.

## Closure

| Blocker | Status | Fix commit | Original repro result |
|---|---|---|---|
| B-001 | IN PROGRESS | — | Not rerun after final fix. |
| B-002 | IN PROGRESS | — | Not rerun after final fix. |
| B-003 | IN PROGRESS | — | Not rerun after final fix. |
| B-004 | IN PROGRESS | — | Not rerun after final fix. |
| B-005 | IN PROGRESS | — | Not rerun after final fix. |
| B-006 | IN PROGRESS | — | Not rerun after final fix. |
| B-007 | IN PROGRESS | — | Not rerun after final fix. |
| B-008 | IN PROGRESS | — | Not rerun after final fix. |
