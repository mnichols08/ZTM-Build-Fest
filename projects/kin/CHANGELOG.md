# Changelog

This file records completed Kin releases. The `v0.0.x` releases are planning and documentation milestones; they do not represent implemented application features. The first implementation milestone remains `v0.1.0`.

## [0.1.4]

### Fixed

- Preserved the original IndexedDB write failure cause so quota errors receive actionable retry guidance without losing the draft or changing the event log.

### Improved

- Refreshed same-origin peer tabs from the canonical IndexedDB event stream through Rust replay using content-free BroadcastChannel invalidations.
- Added cross-platform build and version-consistency tooling, an explicit WASM-focused Rust toolchain pin, and a same-origin Content Security Policy.
- Expanded malformed protocol, deterministic replay, storage retry, cross-tab, and accessibility regression coverage.

### Tests

- 32 Rust tests and 3 built-in Node bridge tests passed.
- `cargo fmt --check`, Clippy with warnings denied, `wasm32-unknown-unknown` release build, both build scripts, and the version-consistency check passed.
- Browser checks passed for add/complete/reload, keyboard submission, Unicode and inert rendering, malformed-row preservation, quota abort/retry, two-tab refresh, 320px layout, and same-origin requests.

### Validation

- Tested on Windows 10 x64 with Rust 1.93.0, Node 22.12.0, and headless Edge 154.0.4258.48 through local CDP; CSP loaded with no CSP violations. An automatic `/favicon.ico` request returned 404.
- Forced-colors, increased text spacing, and 320px reflow were checked in the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150). Native 200% browser zoom, Firefox, Safari, standalone Chrome, NVDA, and VoiceOver remain unverified.

## [0.1.3]

### Audited

- Confirmed JavaScript remains a browser adapter and renderer; Rust remains the only authoritative event validator and item-state reducer.
- Documented the event, identity, ordering, and protocol foundations that later capabilities can extend without implementing those capabilities.
- Confirmed no npm runtime packages, frontend frameworks, WASM helper crates, or third-party network dependencies are present.
- Rechecked local-only storage/requests, privacy-safe diagnostics, and the v0.0.10 community/security/support guidance.

### Validation

- Full Rust, bridge, WASM, reload, malformed-storage, Unicode, keyboard, and narrow-viewport regressions were run for the v0.1.x line.
- The release review records remaining platform and assistive-technology gaps and makes no certification claim for untested environments.

## [0.1.2]

### Improved

- Preserved in-progress compose drafts across same-tab reloads with best-effort `sessionStorage`; successful persistence clears the draft.
- Restored keyboard focus after asynchronous add and completion actions and exposed initialization/save progress with `aria-busy`.
- Kept retryable startup feedback for WASM and IndexedDB failures without discarding stored household events.

### Validation

- Verified draft restore/clear, WASM failure and retry with focus restoration, add/complete focus continuity, status updates, reduced-motion preference, and 320px/360px/640px reflow in the browser.
- Confirmed a blocked `sessionStorage` does not prevent startup or saving; draft retention degrades without affecting the event store.
- Confirmed primary controls are at least 48px high. Testing used Windows 10 x64 with the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150.0.7871.250).
- Screen-reader and non-Chromium browser testing remain unverified.

## [0.1.1]

### Fixed

- Preserved leading U+FEFF and other Unicode text during UTF-8 validation while continuing to reject malformed lone surrogates.
- Closed IndexedDB connections when local-context initialization fails or a blocked open later completes.
- Rejected corrupted event metadata through deterministic integrity errors before lossy conversion or replay.

### Tests

- Added regression tests for BOM/emoji preservation, malformed surrogate input, and the exact UTF-8 byte limit.
- Verified invalid completion does not append, corrupted rows remain stored, concurrent tabs preserve contiguous event order, and rapid duplicate submission creates one event.
- Re-ran 24 Rust tests, 3 built-in Node bridge tests, formatting, Clippy, the WASM build, and browser reload checks.

## [0.1.0]

### Added

- Delivered the local Household Heartbeat flow using native Web Components, Rust/WASM event validation and replay, and IndexedDB event persistence.
- Added and completed household items, with deterministic state reconstruction after reload.
- Added the manual versioned binary ABI, local identity placeholders, bounded protocol parsing, and regression tests for replay and malformed input.
- Added project-local build and static-serving instructions.

### Validation

- Rust unit and protocol tests passed; the `wasm32-unknown-unknown` release build succeeded.
- Browser checks passed for add, complete, reload, inert rendering of script-like text, keyboard submission, narrow layout, and same-origin-only requests.
- Windows 10 x64 was exercised using the integrated VS Code browser (Code 1.139.1, Electron 43.6.0, Chromium 150.0.7871.250). Firefox, Safari, standalone Chrome, and assistive-technology testing were not performed.

## [0.0.12]

### Added

- Established a project-scoped changelog and documented how release entries are maintained.

### Changed

- Updated Kin's current release references through `v0.0.12`; `v0.0.9` remains the specification freeze and `v0.1.0` remains the first implementation milestone.

## [0.0.11]

### Added

- Defined the general minor-release cadence: capability in `.0`, then correctness, resilience/accessibility, and hardening patches when meaningful work exists.

### Changed

- Corrected stale current-version references and confirmed that `v0.1.0` is the first implementation milestone.

## [0.0.10]

### Added

- Added project-scoped Code of Conduct, security, support, contribution, issue-template, and pull-request guidance.
- Documented GitHub's discovery limitations for community files nested in the ZTM Build Fest monorepo.

## [0.0.9]

### Added

- Completed the implementation preflight, accepted architecture decisions, canonical test vectors, and requirement traceability for the frozen `v0.1.0` scope.

## [0.0.8]

### Added

- Documented contributor expectations, cross-platform development guidance, code style, release process, and privacy-safe debugging.

## [0.0.7]

### Added

- Specified persistent-contract versioning, migration safety, portability, retention, and event-log evolution.

## [0.0.6]

### Added

- Froze the initial implementation contract for the manual JS/WASM ABI, binary protocol, IndexedDB event store, components, tests, and accessibility.

## [0.0.5]

### Added

- Specified household/member/device identity, pairing, cryptographic posture, threat model, and synchronization design.

## [0.0.4]

### Added

- Defined the household domain, immutable event semantics, entity lifecycles, and deterministic state reconstruction.

## [0.0.3]

### Added

- Documented initial UX flows, the release roadmap, and the first implementation specification.

## [0.0.2]

### Added

- Established the technical foundation: architecture, event model, local-first direction, privacy posture, and dependency policy.

## [0.0.1]

### Added

- Defined Kin's product foundation, intended users, principles, scope, and non-goals.
