# Kin Live Household Authority & Recovery Verification

**Date:** 2026-10-11
**Base:** `kin-development` at `59c94a7` (PR #36 merged; v0.40.1 candidate)
**Working branch:** `test/kin-live-household-verification`
**Scope:** Verification only; no product behavior or version changes.

## Summary

The post-v0.40 audit's open household authority/recovery gap is partly closed
with a repeatable HTTP integration test using two separately authenticated
adult clients and a real loopback Kin server/relay process. It verifies event
exchange, duplicate retry idempotency, post-revocation denial for the stale
client session, and continued history access by the remaining authorized
client.

This is server integration coverage, not browser automation, independent
browser-profile validation, or a physical multi-device drill. The event
envelopes in the new test are deterministic relay fixtures; cryptographic
encryption and WASM event replay are covered separately by the existing
`sync-e2e.test.mjs` test against in-process relay services. No live human
household data or production service was used.

PR #36 is merged. Its audit already recorded passing Rust, Node, WASM, Edge,
and virtual-authenticator regressions, while explicitly leaving multi-profile
admission, restore, and offline reconnect drills open. Existing role, expiry,
revocation, archive, and stale-backup tests were reviewed before adding this
focused integration case; they were not duplicated.

## Verification Matrix

| Scenario | Expected outcome from current contract | Actual result | Environment / execution method | Evidence | Status |
|---|---|---|---|---|---|
| Adult joins household | Approved Adult pairing establishes household participation and the documented Adult trust-management authority. | Adult A pairs and approves Adult B; both sessions exchange relay events. Full UI ceremony not exercised. | Node server integration test; loopback HTTP server + relay, two distinct session cookies. | `server/sync-http.test.mjs` — “independent HTTP clients retain relay history…”; `server/pairing-service.test.mjs`. | **PASS — automated integration** |
| Limited member joins | Member can participate under Limited rules but cannot manage trust or enable sync. | Existing service/HTTP assertions cover role assignment and forbidden trust operations; no separate browser admission flow run. | Existing Node unit/HTTP tests. | `server/pairing-service.test.mjs` (Limited/Temporary HTTP denial cases); `server/sync-service.test.mjs` (Limited cannot enable sync). | **PASS — automated** |
| Temporary member joins | Temporary status and expiry come from the Adult-created invitation; claimant input cannot extend policy. | Existing pairing tests assert the invitation expiry is retained and Temporary role cannot enable sync. | Existing Node service tests. | `server/pairing-service.test.mjs` (Temporary pairing expiry); `server/sync-service.test.mjs`. | **PASS — automated** |
| Temporary member expires | At/after expiry, participation stops and expiry/revocation state is finalized according to service policy. | Existing tests exercise expiry and access denial using the service clock/expiry boundary; no wall-clock browser wait was performed. | Existing Node service and HTTP tests with synthetic time/expiry values. | `server/pairing-service.test.mjs` (“expired temporary members…” and expiry finalization); HTTP Temporary access tests in the same file. | **PASS — automated** |
| Member is revoked | Removed member sessions and subsequent unauthorized operations fail; historical records are not silently erased. | Existing server tests cover member removal/session invalidation and recovery protections. Not repeated as a new live browser flow. | Existing Node service, HTTP, and lifecycle tests. | `server/pairing-service.test.mjs`; `server/household-lifecycle.test.mjs`; `server/recovery.test.mjs`. | **PASS — automated** |
| Device is revoked | Revoked device cannot use its old session to read, upload, or regain authority; remaining authority and history remain available. | New test revokes Client B's device. Its existing session receives 401 for status, pull, and push. Client A can still read both stored events exactly once. | Node integration test against an actual ephemeral loopback HTTP service/relay process; separate client identity/session objects. Revocation is invoked through the pairing service and the sync access-change hook. | `server/sync-http.test.mjs` new test; existing stale-cursor/revocation HTTP test. | **PASS — automated integration** |
| Household is exported | Export is valid and preserves canonical household history and attachment integrity. | Existing archive/real-browser storage suites passed in the PR #36 audit. This turn did not rerun export in a browser. | Prior audit: Edge security-storage runner and archive tests; synthetic data. | `web/security/archive.test.mjs`; PR #36 audit report export/restore section and Automated Gate. | **PASS — prior automated evidence** |
| Household is restored | Historical data is validated and preserved; restore alone does not restore membership/device trust. Expired Temporary members stay expired. | Existing restore and portable-member expiry tests cover the contracts. No new restore was performed in this turn. | Prior audit automated storage suite; Node archive normalization unit test. | `web/security/archive.test.mjs`; `server/recovery.test.mjs`; `server/household-lifecycle.test.mjs`; PR #36 audit. | **PASS — prior automated evidence** |
| Restore to clean browser | Imported history is local-only until normal household authorization; clean profile cannot silently gain sync authority. | Edge storage and UI runners passed their restore-related assertions in temporary isolated profiles, but no household was exported in one profile and restored into another independent profile. | Edge 155 automation, isolated temporary profile; no cross-profile household restore. | `scripts/security-storage-regression.mjs`; `scripts/security-ui-regression.mjs`; open item from PR #36 audit. | **NOT RUN — independent-profile drill** |
| Revocation during disconnection | Once server revocation commits, stale offline credentials cannot push or pull on reconnect; locally copied history is not erased. | New test retries a prior event and then reconnects with the same now-revoked session; status/pull/push are denied. Network disconnection itself is represented by delayed requests, not an OS/browser offline transition. | Loopback HTTP integration test, deterministic sequential requests. | `server/sync-http.test.mjs` new test and existing stale-cursor HTTP test. | **PASS — server reconnect invariant; browser offline drill NOT RUN** |
| Two clients reconnect | Exact retries deduplicate; distinct accepted events remain available without loss or unintended duplication. | New test posts the same envelope twice, then confirms the authorized client reads exactly two distinct events once each. It does not run browser outbox/cursor reconciliation or concurrent writes. | Loopback HTTP relay integration test with two authenticated client sessions. | `server/sync-http.test.mjs`; `server/durable-cursor.test.mjs`; `web/storage/remote-replay.test.mjs`; `server/sync-e2e.test.mjs` (real crypto/WASM, in-process relay). | **PASS — bounded integration; browser reconciliation NOT RUN** |

## Evidence Levels and Limits

- **Unit/service tests:** Existing role, expiry, revocation, restore, relay
  cursor, and recovery tests. PR #36 reports the full prior gates as passing.
- **Integration test:** `server/sync-http.test.mjs` starts a real Kin HTTP
  server and relay on an ephemeral loopback port and makes requests as two
  separately authenticated client sessions. It is repeatable and uses no
  persistent production database.
- **Browser automation:** Edge 155.0.4283.45 on Windows x64 passed the core
  browser, security-storage, security-UI, and passkey virtual-authenticator
  runners in this pass. Their temporary profiles and multiple tabs do not
  constitute the two-independent-profile household restore/revocation drill.
- **Browser availability:** Chrome is installed but was not exercised; Firefox,
  Safari/WebKit, and mobile browsers/devices were not available or run.
- **Physical devices / human household:** Not run. No physical-device,
  independent human account, or production relay validation is claimed.
- **CI:** No Kin-specific GitHub Actions workflow is present in this checkout;
  these checks are not represented as CI results.

## Executed Check

Command used to accommodate the installed Node 22.12.0 runtime, where
`node:sqlite` requires its experimental flag:

```powershell
node --experimental-sqlite --test projects/kin/server/sync-http.test.mjs
```

Result: **5 passed, 0 failed** (including the new test). The standard package
engine requires Node `>=22.13.0`; this environment used 22.12.0 with the
experimental SQLite flag. A sandboxed attempt could not spawn the Node test
worker (`EPERM`); the same command succeeded when run with permission to spawn
the local test process and bind its loopback relay. No app data was written.

Additional checks run in this pass:

```powershell
cargo fmt --manifest-path projects/kin/Cargo.toml -- --check
cargo test --manifest-path projects/kin/Cargo.toml
cargo clippy --manifest-path projects/kin/Cargo.toml --all-targets -- -D warnings
cargo build --manifest-path projects/kin/Cargo.toml --target wasm32-unknown-unknown --release
npm run test:server --prefix projects/kin
node --test (rg --files projects/kin/server projects/kin/web -g '*.test.mjs')
node projects/kin/scripts/browser-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node projects/kin/scripts/security-storage-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node projects/kin/scripts/security-ui-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node projects/kin/scripts/passkey-regression.mjs 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

Results: formatting passed; Rust **173 passed**; warnings-denied Clippy passed;
release WASM build passed; server Node **258 passed**; complete server + web
Node **393 passed**; Edge core browser, security-storage, security-UI, and
passkey runners passed (32 virtual-authenticator assertions, PRF exercised).
The browser storage runner included actual page reload and browser-process
restart recovery assertions. These checks used Node 22.12.0 with
`NODE_OPTIONS=--experimental-sqlite` and `NODE_NO_WARNINGS=1`; Edge was
155.0.4283.45 on Windows x64. `python projects/kin/scripts/check_version.py`
and final whitespace/path checks are recorded after the report was updated.

The published package engine requires Node `>=22.13.0`; using 22.12.0 with the
flag is a local compatibility workaround, not a substitute for rerunning under
the declared minimum runtime. The merged
[post-v0.40 release audit](POST_V0.40_RELEASE_AUDIT.md) records earlier gates
under Node 22.13.0.

## Manual Reproduction for Remaining Profile Scenarios

Use synthetic households and two clean browser profiles (or two devices) on a
local Kin build and local relay. Do not use production household data.

1. In Profile A, create a household and invite Adult B, Limited C, and
   Temporary D with a short, explicitly selected expiry. Approve each through
   the normal product flow. Verify each role/status in the UI and server
   authorization responses; verify Limited and Temporary cannot manage trust.
2. In Profile A, create a harmless test event. In Profile B, sync and verify it
   appears once. Disconnect Profile B at the OS/browser network layer, revoke
   B's device in A, then reconnect B. Confirm pulls and pushes fail, while A
   retains the full history. Retry any already-submitted event and verify no
   extra copy appears.
3. Wait past D's chosen expiry using real time or a documented controlled
   service clock. Verify D loses access, then export the household. Restore
   into a clean Profile C using the archive secret. Confirm the event history
   and expired status survive, while C has no sync authority until normally
   authorized.
4. Reconnect two currently authorized clients after making distinct offline
   changes on each. Verify both events converge once, repeat an upload retry,
   reload both profiles, and compare the resulting history.
5. Save sanitized request outcomes, client/browser versions, relay launch
   method, profile separation, timestamps, and any deviations. Never include
   passkeys, recovery secrets, session cookies, household text, or ciphertext
   from a real household in the report.

## Findings and Release Recommendation

No application defect was reproduced. The new automated relay test passes, and
existing applicable automated evidence remains the basis for the other PASS
rows. Independent browser-profile restore, actual network-offline revocation,
Temporary expiry in the running UI, concurrent browser reconciliation, and
physical-device validation remain unproven. These are **ENVIRONMENTAL / NOT
RUN**, not evidence of a product failure.

**Recommendation: keep the release candidate NOT READY.** Automated server
authorization and relay history invariants are better covered, but this work
does not complete the real profile/device recovery evidence required by the
post-v0.40 audit and does not justify declaring Kin release-ready.

## PR Summary

Adds a focused two-client HTTP relay integration regression and records a
scenario-by-scenario authority/recovery matrix with evidence levels, actual
results, environment limits, and manual reproduction steps. No application
feature, cryptographic/persistence format, version, or unrelated project was
changed. The targeted test command passed 5/5. Full regression gates and
independent-profile/mobile drills remain outstanding.

Suggested PR title: **test(kin): verify live household authority and recovery boundaries**
