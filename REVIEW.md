# Review instructions — Kin (`projects/kin/`)

Kin is a local-first, end-to-end-encrypted household app: a Rust→WASM domain core with a hand-written ABI, vanilla web components, an encrypted IndexedDB event store, and a zero-dependency Node relay. It hasn't shipped. The work under review is the **v1.0 readiness epic**. Standing project rules are in `projects/kin/AGENTS.md`.

Review as three reviewers at once and tag each finding with its lens:
- **[Sentinel]**: security, authorization, crypto, data loss, test evidence.
- **[Bedrock]**: correctness, determinism, memory/allocation, debt, dependency rule.
- **[Interface]**: user-visible behavior, accessibility, copy, mobile width. Only when the PR touches `web/`.

## What Important (🔴) means here
Use Important only for something that would, on merge:
- make two devices disagree after sync, or lose, drop or silently quarantine a household event;
- let a role do something its rule forbids (see `projects/kin/docs/HOUSEHOLD-IDENTITY-DEFAULTS.md`, `PRODUCT-BOUNDARIES.md` and the authority table in the issue);
- store, sign or trust a value from an **unsigned** field when a signed one exists (the S2 class);
- check authority only at creation, not again at the moment the action takes effect (the A1 class);
- expose plaintext, keys or recovery material, or keep them past a lock;
- break the KINE/KINS formats, golden fixtures, WASM ABI, IndexedDB schema or archive format without saying so at the top of the PR;
- add any third-party crate, npm package, CDN script or vendored library;
- change a file outside `projects/kin/`, except owner-maintained files the PR says it changes on purpose;
- claim a security fix with no regression test that fails before the fix.

Everything else is Nit at most: naming, style, refactors, comments, missing non-security tests.

## Always check
1. **The linked issue.** Open it (`Closes #N` in the PR body). Check each acceptance criterion and say which are met, unmet or unverifiable. An unmet criterion is Important.
2. **Determinism.** Rust replay orders by `(logical_time, device_id, event_id)`. Domain logic uses no wall clock, randomness, `HashMap` iteration order or float comparison. JS mirrors the Rust order exactly.
3. **Convergence.** For a sync change, think through A-local/B-remote, B-local/A-remote and a fresh device replaying everything. All three must produce identical projections with zero quarantines.
4. **Authorization.** Server routes re-check membership, role and household at mutation time. Demotion, removal and revocation take effect on pending pairings and sessions.
5. **Lock hygiene.** Anything opened while unlocked (drafts, blob URLs, decrypted caches) is cleared or revoked on lock.
6. **Allocation and copies** in hot paths (replay, envelope parse, sync batches): no needless `clone()`/`to_vec()`/`String` building where a slice works.
7. **Verification honesty.** The PR body lists the commands run. The Edge browser suites run only in Windows CI, so any claim they passed must match CI.

## Verification bar
- Behavior claims need a `file:line` citation from the code, not an inference from names.
- For a convergence or authorization bug, describe the concrete sequence of events or requests that triggers it.
- If you can't verify something, say "unverified" and drop it to Nit.

## Do not report
- Anything CI already enforces: `rustfmt`, clippy, test failures CI shows.
- Generated `web/wasm/*.wasm`, `Cargo.lock`, `package-lock.json`.
- Documentation wording, unless it contradicts the code or tells users to do something unsafe.
- Pre-existing issues outside the diff. Note at most three as 🟣, briefly.

## Volume and convergence
- At most five Nits per review; give the rest as a count.
- On a re-review, check first whether each earlier Important finding is fixed and say so per finding. Then post only new Important findings. No new Nits after the first review.

## Summary shape
Start the summary with one line in exactly this form:

`Verdict: READY | CHANGES NEEDED — <n> important, <m> nits — acceptance <met>/<total>`

Then list the acceptance criteria with ✅ / ❌ / ❔, then findings grouped by lens. Keep it short. Don't approve or merge; a human does that.
