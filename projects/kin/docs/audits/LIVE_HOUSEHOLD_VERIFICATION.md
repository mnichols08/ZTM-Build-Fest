# Kin Live Household Authority & Recovery Verification

**Dates:** 2026-10-11 (server integration pass), 2026-10-12 (independent-profile and rotation-recovery drills)
**Base:** `kin-development` at `59c94a7` (PR #36 merged; v0.40.1 candidate)
**Working branch:** `test/kin-live-household-verification` (PR #37)
**Scope:** Verification evidence, three original drill fixes, and focused
B-002/P-001 key-rotation recovery. No version bump, archive format, or
package-signature format change.

## Summary

The post-v0.40 audit left household admission, revocation, expiry, restore, and
offline reconnect "UNVERIFIED — ENVIRONMENT" because no automated evidence used
genuinely separate clients. This branch closes most of that gap with
`scripts/household-authority-regression.mjs`: five independent headless
browser profiles (separate `--user-data-dir`, cookies, IndexedDB, device keys,
and CDP virtual authenticators) exercise one real in-process Kin server and
relay over loopback through the product's own pairing, approval, activation,
member-removal, device-revocation, export, and restore controls. The server
clock is injectable, so Temporary expiry is enforced deterministically.

The updated drill passes 94 assertions in Edge 155.0.4283.45 and Chrome
154.0.8037.98 on Windows x64. The original run found three real defects; two
were fixed with regression tests: the unauthenticated household lifecycle
route always returned 500, and Limited/Temporary clients paused sync before
pull and push because they tried Adult-only key provisioning. The third,
**B-002**, stranded remaining devices when the Adult that committed a rotation
was revoked before package delivery. The focused recovery patch retains
committed packages for still-trusted recipients beyond their pre-commit TTL,
removes packages to revoked recipients, and records the rotating device as an
epoch holder (P-001). Service, cryptographic, durable-restart, and independent
browser-profile race regressions now pass. The original drill also surfaced a
stale device-list defect, fixed on this branch, and two polish findings.

Separate profiles on one machine are not physical devices, separate networks,
or independent people. Those drills, installed-PWA behavior, Firefox,
Safari/WebKit, and mobile remain **NOT RUN** and have manual instructions below.

## Evidence Levels

| Level | What it is here | Evidence |
|---|---|---|
| Unit / service tests | Node tests of `PairingService`, `EncryptedSyncService`, components, and pure client helpers; Rust domain tests. | `npm run test:server`, `node --test server/*.test.mjs web/**/*.test.mjs`, `cargo test`. |
| Integration tests | Real HTTP server and relay on loopback with scripted sessions (no browser). | `server/sync-http.test.mjs` two-client test (2026-10-11); `server/household-lifecycle.test.mjs` lifecycle route test (new). |
| Browser automation, single profile | Existing Edge runners with a stubbed API or the real server in one profile. | `security-ui`, `security-storage`, `browser`, `passkey` regressions. |
| Browser automation, independent profiles | **New.** Five separate browser processes/profiles against the real server, relay, and WebAuthn verifier. | `scripts/household-authority-regression.mjs`. |
| Physical devices / humans / networks | Not run. | Manual instructions below. |

## Verification Matrix

Execution method for every "multi-profile drill" row:
`household-authority-regression.mjs`, Node 22.12.0 with
`--experimental-sqlite`, Windows 11 x64, Edge 155.0.4283.45 and Chrome
154.0.8037.98, in-memory SQLite `DurableStore`, injectable server clock,
synthetic households only. The latest run in each browser passed 94 assertions.
Earlier runs of the same script surfaced the findings below before their fixes
or ordering changes.

| Scenario | Expected outcome from current contract | Actual result | Environment / execution method | Evidence | Status |
|---|---|---|---|---|---|
| Adult joins household | Real pairing: invite → claim with fresh passkey → fingerprint-verified approval → activation. The new Adult has Adult trust authority and receives current and later key epochs only ([PAIRING](../PAIRING.md) "new/replacement adults receive only current/future epochs"). | Profile B joined through the product controls, reloaded, unlocked, held the approved identity, created and cancelled an invitation (201/200), received the event A created after admission, and did not receive the pre-join event. | Multi-profile drill (A, B). | "Adult admission assertions" (14 cumulative). | **PASS — multi-profile drill** |
| Limited member joins | Member participates in sync but every trust-management route is denied with `403 adult_required`. | Profile C joined as Limited; seven trust routes (invitations, device pairing, sync enable, device list, member removal, provisioning grants, epoch rotation) returned 403; C synced after A provisioned it and A received C's event. | Multi-profile drill (A, C). | "Limited admission and restriction assertions" (28 cumulative); `server/pairing-service.test.mjs` HTTP denial cases. | **PASS — multi-profile drill** (after B-003 fix; before it, C's sync paused) |
| Temporary member joins | Status and absolute expiry come only from the Adult's invitation; the member cannot manage trust; participates until expiry. | Profile C2 joined with the inviter-chosen expiry, was denied trust management, synced, and A received its event. | Multi-profile drill (A, C2). | "Temporary admission and expiry assertions". | **PASS — multi-profile drill** |
| Temporary member expires | After expiry the server ends participation on the next request, revokes the member's devices, reserves a rotation, and reports `expired` (not `removed`). | Server clock advanced 4 min past expiry: A's household view showed the member ended, server status `expired`, C2's session was refused (401), C2's sync paused, C2's local history stayed intact, A's household page said "access ended", and A committed the reserved rotation. Browsers kept real time. | Multi-profile drill with injectable server clock. | "Temporary admission and expiry assertions" (52 cumulative). | **PASS — multi-profile drill (controlled server clock)** |
| Member is revoked | Removal through the Adult UI revokes the member's devices and sessions; subsequent operations fail; nothing already shared is erased. | While C was offline with an unsent event, A removed C with a fresh passkey. Server marked C `removed`, revoked its device; on reconnect C's sync paused with an authorization code, status and push returned 401, C's local history and outbox were unchanged, A kept C's earlier event and never received the post-removal one, and the relay held exactly one envelope from C. | Multi-profile drill (A, C) with CDP network offline emulation. | "member removal during disconnection assertions" (37 cumulative). | **PASS — multi-profile drill** |
| Device is revoked | Fresh-passkey revocation through the UI; the device's session and device cookie cannot regain access; membership itself persists; remaining Adult recovers any committed epoch before rotating. | B committed the expiry rotation while A was offline. A revoked B before receiving the package, advanced past its package TTL, recovered the signed epoch package, and committed the required following rotation. B's reconnect sync paused (`authentication_required`/`device_not_trusted`), push returned 401, login with B's device cookie was refused, B's local history and outbox were intact, and the relay held no envelope from B. | Multi-profile drill (A, B) with server and client clocks advanced deterministically. | "Temporary expiry and committed-rotation race assertions" (54 cumulative), "device revocation during disconnection assertions" (66 cumulative); `server/rotation-recovery.test.mjs`, `server/durable-sync-integrity.test.mjs`. | **PASS — Edge and Chrome** |
| Household is exported | Export through the product control produces a package whose event count equals local history and whose membership snapshot carries authoritative `active`/`removed`/`expired` statuses. | A's export matched its local history and recorded A active, B active (device revoked, member not removed), C removed, C2 expired. | Multi-profile drill; `downloadArchive()` with the blob captured. | "export assertions" (65 cumulative). | **PASS — multi-profile drill** (P-003 clock-skew note) |
| Household is restored | Validation stages without touching the target; restore imports exact history including removed/expired members' events; membership statuses survive; no identity, sync state, coordinator, or server authority results. | Clean profile D validated and restored A's archive: staged with zero events, imported the exact count, showed events from removed and expired members and nothing after the export, preserved the snapshot byte-for-byte, had no identity/sync state/coordinator, and `/api/sync/status` was 401. | Multi-profile drill (D) via the restore form and file input. | "clean-profile restore and re-authorization assertions" (81 cumulative). | **PASS — multi-profile drill** |
| Restore to clean browser, then re-authorize | A restored device gains sync only through ordinary same-member device pairing; after approval it catches up and deduplicates. | A created a same-member device invitation; D claimed, A approved, D activated and bound to A's membership; A provisioned all epochs; D caught up with the post-export event and ended with the identical event-ID set as A; the relay gained no duplicate. | Multi-profile drill (A, D). | Same section. | **PASS — multi-profile drill** |
| Revocation during disconnection | Stale offline state cannot override server revocation on reconnect; local unsent history is neither uploaded nor erased. | Covered by both the member-removal and device-revocation rows above (client offline through CDP network emulation while the Adult revoked). | Multi-profile drill. | Rows above; `server/sync-http.test.mjs`. | **PASS — multi-profile drill** (OS-level network loss NOT RUN) |
| Two clients reconnect | Concurrent offline edits converge once on both clients with empty outboxes and no duplicates after repeated syncs. | A and D each added an item offline, reconnected, and after two sync rounds each held both items once, identical event-ID sets, empty outboxes; the relay gained exactly two events. | Multi-profile drill (A, D). | "two-client reconciliation assertions" (94 cumulative). | **PASS — multi-profile drill** |
| Rotation committed by a later-revoked device | Remaining trusted devices can recover every committed epoch intended for them, even after package TTL, then complete the required next rotation. | B committed while A was offline; A revoked B before receiving the package, advanced beyond TTL, recovered and verified the package, then rotated again. A did not skip the missing epoch. | Multi-profile drill plus deterministic service, crypto, and durable-restart tests. | "Temporary expiry and committed-rotation race assertions"; `server/rotation-recovery.test.mjs`; `server/durable-sync-integrity.test.mjs`. | **PASS — B-002 fixed** |
| Physical devices, separate networks, installed PWA, Firefox/Safari/mobile | — | Not exercised. | — | Manual instructions below. | **NOT RUN — ENVIRONMENTAL** |

## Findings

### B-001 — Household lifecycle route always returned 500 (FIXED)

Area: Server / authorization recovery. Severity: BLOCKER (reliability of the
path a revoked or removed device uses to tell lost access from deletion).

**Reproduction:** `node docs/audits/post-v0.40-repro/b001-lifecycle-route-500.mjs`
(prints 200 now; before the fix every `GET /api/household/lifecycle?householdId=…`
threw a `ReferenceError` because the route read a `store` binding that only
exists in the server factory). The drill's server log showed `server_error`
outcomes whenever a paused client asked for the lifecycle.
**Fix:** `server/server.mjs` reads `context.store`. Regression:
`server/household-lifecycle.test.mjs` "HTTP lifecycle lookup answers without a
session…" (fails on the old code).

### B-002 — Revoking the device that committed the latest rotation strands the household (FIXED)

Area: Key rotation / revocation recovery. Severity: BLOCKER before the fix
(permanent loss of household sync for every remaining device; no in-product
recovery).

**Reproduction:** `node docs/audits/post-v0.40-repro/b002-revoked-sender-rotation-strands-adult.mjs`.
Two Adults; an access change reserves a rotation; B commits epoch 3 and its
package for A sits in the relay; A revokes B before syncing.
`EncryptedSyncService.onAccessChange` deletes every grant from the excluded
sender, so A's package is gone, no active device is recorded as holding epoch
3, and `rotationPending` is set for epoch 4. The client's `commitRotation`
refuses to rotate without the current key ("The current household key is
unavailable for rotation."), and `runOnce` throws "This device needs an
authorized household key before sync can continue." on every cycle.
**Live observation before the fix:** a Chrome run failed when B's 5-second
background sync committed the expiry rotation before A did.
**Fix:** the server marks packages created by the authorized, committed
compare-and-advance operation as committed recovery material. It retains an
unacknowledged package after sender revocation, including beyond the original
package expiry, only while its recipient remains trusted. Packages for revoked
or expired recipients are removed. The recipient still checks its device
fingerprint and verifies the original package signature against the sender's
verified key history; generic provisioning grants retain their normal TTL.
Acknowledgement records the recipient's held epoch, and rotation commit records
the sender's own epoch (P-001).
**Regression evidence:** `server/rotation-recovery.test.mjs` recovers an expired
package after sender revocation and completes the next rotation;
`server/durable-sync-integrity.test.mjs` repeats retention across a database
restart; `web/sync/crypto.test.mjs` checks expiry bypass only when explicitly
authorized. The updated independent-profile drill reproduces the sequence in
Edge and Chrome, verifies expiry, revocation, package recovery, and the next
rotation. No epoch is skipped.

### B-003 — Non-Adult clients paused sync on Adult-only steps (FIXED)

Area: Client sync / participation. Severity: BLOCKER before the fix (Limited
and Temporary members could not pull or push after any epoch rotation, which
every join, removal, revocation, and expiry triggers).

**Reproduction:** before the fix, the drill's Limited profile paused with
`adult_required: Only adults can provision household key access.` on its first
sync. Root cause is P-001 plus the coordinator attempting
`provisionMemberHistory` and `commitRotation` regardless of member kind, before
pull and push.
**Fix:** `web/sync/sync-coordinator.js` skips both steps unless
`memberHasTrustAuthority(status)` (the server reports `memberKind`). Regression:
`web/sync/sync-coordinator.test.mjs` for the helper and the drill's Limited and
Temporary rows (which fail on the old code).

### P-001 — Rotation does not record the rotating device's own epoch (FIXED with B-002)

`EncryptedSyncService.rotateEpoch` now records the committed epoch on the
rotating device in the same persisted state update. The focused
`server/rotation-recovery.test.mjs` checks this for both the initial and
recovery rotations.

### P-002 — Trusted-device list stayed stale after revocation (FIXED)

The revoke handler called `showDevices()` from inside its own `run()` busy
guard, so the refresh silently returned and the revoked device kept showing
"Trusted" until the page was reopened. Fixed in `web/components/kin-household.js`
to refresh after the operation releases the guard. Regression:
`web/components/kin-household.test.mjs` "device revocation refreshes the
trusted-device list…" (fails on the old code).

### P-003 — Archive membership validation is clock-skew sensitive (OPEN)

`validatePortableMembership` in `web/storage/event-store.js` rejects a
Temporary member with the server's authoritative `expired` status when the
browser's clock is still before `expiresAt`. With the drill's server clock 4
minutes ahead, export failed with "Kin found invalid household membership in
this export." A real client whose clock lags the server by Δ cannot export, or
restore such an archive, during the Δ window after an expiry. v0.40.1 makes the
server status authoritative; the local-clock check contradicts it. Not changed
here because it alters archive validation semantics; the drill uses a short
real expiry before exporting so both clocks agree.

### P-004 — `leaveHousehold` ignores the injected service clock (OPEN, test-infra)

`PairingService.leaveHousehold` calls `canParticipate(member)` with the real
`Date.now()` rather than `this.now()`. Production clocks coincide, so no user
impact, but fake-clock tests of Temporary self-leave behave differently from
the rest of the service.

## Executed Checks

All commands run from the repository root on Windows 11 x64 with the pinned
Rust 1.93.0 toolchain and Node 22.13.0 selected through `fnm exec --using
v22.13.0` (the declared minimum; PATH Node is 22.12.0). `NODE_NO_WARNINGS=1`
suppresses the runtime's experimental SQLite warning.

```powershell
cargo fmt --manifest-path projects/kin/Cargo.toml -- --check
cargo test --manifest-path projects/kin/Cargo.toml
cargo clippy --manifest-path projects/kin/Cargo.toml --all-targets -- -D warnings
cargo build --manifest-path projects/kin/Cargo.toml --target wasm32-unknown-unknown --release
fnm exec --using v22.13.0 node --test (rg --files projects/kin/server projects/kin/web -g '*.test.mjs')
fnm exec --using v22.13.0 npm.cmd run test:server --prefix projects/kin
python projects/kin/scripts/check_version.py
$kinBrowser = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
fnm exec --using v22.13.0 node projects/kin/scripts/household-authority-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/household-authority-regression.mjs 'C:\Program Files\Google\Chrome\Application\chrome.exe'
fnm exec --using v22.13.0 node projects/kin/scripts/browser-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/security-storage-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/security-ui-regression.mjs $kinBrowser
fnm exec --using v22.13.0 node projects/kin/scripts/passkey-regression.mjs $kinBrowser
node projects/kin/docs/audits/post-v0.40-repro/b001-lifecycle-route-500.mjs
node projects/kin/docs/audits/post-v0.40-repro/b002-revoked-sender-rotation-strands-adult.mjs
node projects/kin/docs/audits/post-v0.40-repro/p001-rotation-omits-own-provisioned-epoch.mjs
```

| Check | Result |
|---|---|
| Rust formatting, Clippy (warnings denied), release WASM build | Passed (no Rust changes). |
| `cargo test` | 173 passed, 0 failed. |
| Complete server + web Node suite (Node 22.13.0) | 399 passed, 0 failed (396 before the focused rotation-recovery regressions). |
| `npm run test:server` | Under PATH Node 22.12.0: all 20 server files fail to load with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` (runtime below the declared minimum). Under `fnm exec --using v22.13.0`: see the row below. |
| `fnm exec --using v22.13.0` server Node test suite | 262 passed, 0 failed (259 before the three B-002/P-001 regressions). |
| Version consistency | 0.40.1 consistent across client, server, and release metadata. |
| `household-authority-regression.mjs`, Edge 155.0.4283.45 | 94 assertions, including the committed-rotation race, passed. |
| `household-authority-regression.mjs`, Chrome 154.0.8037.98 | 94 assertions, including the committed-rotation race, passed. Earlier Chrome runs exposed B-002. |
| `browser-regression.mjs`, Edge | Passed, including 10,000-event replay and sync storage. |
| `security-storage-regression.mjs`, Edge | Passed, including page-reload and process-restart recovery. |
| `security-ui-regression.mjs`, Edge | Passed: 36 household-leave, 17 root-rotation UI, 143 lock/recovery/peer-tab/offline assertions. |
| `passkey-regression.mjs`, Edge | 32 virtual-authenticator assertions; PRF exercised. |
| Reproduction scripts | Run as documented in `post-v0.40-repro/README.md`. |

Note on `npm run test:server`: the package script runs under PATH Node. On this
machine PATH Node is 22.12.0, where `node:sqlite` needs `--experimental-sqlite`;
the suite was therefore executed under 22.13.0 through `fnm exec`, which is the
declared minimum runtime. No CI workflow exists for Kin in this repository, so
none of the above is a CI result.

## Manual Reproduction for NOT RUN Scenarios

Use synthetic households, a local build (`projects/kin/run.ps1`), and the
loopback relay. Never use production household data.

1. **Physical devices / independent people.** Repeat the drill's sequence with
   two phones or laptops on different networks: Profile A creates the
   household; B (Adult), C (Limited), D (Temporary with a 10-minute expiry) join
   through the invitation link and compare fingerprints in person. Verify each
   role's controls and the HTTP denials from the browser devtools network tab.
2. **OS-level disconnection.** Put B in airplane mode, add an item, revoke B's
   device from A, reconnect B. Expect B's sync notice "no longer trusted", B's
   item still present locally, A never receiving it.
3. **Expiry in real time.** Wait past D's expiry; expect A's household page to
   show "access ended", D's sync to pause, and export from A to validate.
4. **Installed PWA.** Install Kin from the browser menu, lock, relaunch offline,
   unlock with the recovery key, then reconnect and confirm catch-up.
5. **Restore on a different machine.** Export from A, copy the file and
   recovery key out of band, restore into a fresh browser on another machine,
   confirm no sync until A approves a same-member device pairing, then confirm
   identical history and no duplicates.
6. **B-002 committed-rotation recovery (physical-device follow-up).** Two
   Adults online; let a Temporary member expire; take A offline before its
   next sync; wait for B to commit the rotation; revoke B before A receives its
   package; then reconnect A. Expect A to recover the committed epoch, finish
   the required next rotation, and sync without skipping the missing epoch.
7. Record browser/OS versions, timestamps, and sanitized request outcomes. Do
   not record passkeys, recovery keys, cookies, or household text.

## Release Recommendation

**NOT READY.** B-002 and P-001 now have focused implementation and regression
coverage, including the deliberate independent-profile race in Edge and
Chrome. Physical-device, cross-network, installed-PWA, and non-Chromium
validation remain unrun. This patch does not claim production certification.
