# Roadmap

This roadmap is a planning baseline, not a promise of delivery dates. Releases may change as the product is tested. Kin's current release is `v0.1.4` Household Heartbeat Maintenance, continuing patches to the local prototype without introducing a new product capability. The `v0.0.1`–`v0.0.12` planning and documentation history remains preserved; later product increments remain future work.

## Planning releases

### `v0.0.1` — Product foundation

Define what Kin is, who it initially serves, the everyday problem it addresses, its first useful daily loop, and its non-goals. Record the product principles.

### `v0.0.2` — Technical foundation

Document intended browser/Rust responsibilities, a conceptual event model, the local-first direction, the future sync boundary, the privacy posture, and dependency policy.

### `v0.0.3` — UX and implementation planning

Describe conceptual daily flows, sequence the implementation roadmap, and specify the initial direction for the first coded release. Later planning releases refine the domain, trust model, and implementation contract; no app ships in this release.

### `v0.0.4` — Household Domain Specification

Define household entities and lifecycles, the immutable event envelope and naming convention, event availability by release, deterministic validation/replay, and state/tombstone semantics. See [DOMAIN](DOMAIN.md), [EVENTS](EVENTS.md), [STATE](STATE.md), and [LIFECYCLES](LIFECYCLES.md).

### `v0.0.5` — Trust, Identity, and Synchronization Design

Specify household/member/device/credential identity, pairing and device revocation, cryptographic posture, threats, encrypted relay responsibilities, metadata exposure, and offline conflict classes. Design only; no identity, crypto, or sync implementation. See [IDENTITY](IDENTITY.md), [PAIRING](PAIRING.md), [SYNC](SYNC.md), [CRYPTOGRAPHY](CRYPTOGRAPHY.md), and [THREAT-MODEL](THREAT-MODEL.md).

### `v0.0.6` — Implementation Contract

Freeze the initial v0.1.0 scope and specify its ABI, protocol, local storage, components, testing, accessibility, and release gate. The `.0.7`–`.0.9` planning releases add durability, contributor guidance, and final preflight; v0.0.6 does not ship an app. See [IMPLEMENTATION](IMPLEMENTATION.md), [ABI](ABI.md), [STORAGE](STORAGE.md), [COMPONENTS](COMPONENTS.md), [TESTING](TESTING.md), [ACCESSIBILITY](ACCESSIBILITY.md), and [V0.1.0](V0.1.0.md).

### `v0.0.7` — Data Durability & Evolution

Define independent persistent-contract versions, compatibility and migration failure behavior, portable export/import requirements, data retention/deletion boundaries, and event-log growth/checkpoint principles. Specifications only; no migration or export functionality. See [VERSIONING](VERSIONING.md), [MIGRATIONS](MIGRATIONS.md), [PORTABILITY](PORTABILITY.md), and [RETENTION](RETENTION.md).

### `v0.0.8` — Developer & Contributor Experience

Document human contribution expectations, intended cross-platform development setup, code style, release procedure, and privacy-safe debugging. The commands/workflow are guidance only; no executable tooling or application code. See [CONTRIBUTING](../CONTRIBUTING.md), [DEVELOPMENT](DEVELOPMENT.md), [CODE-STYLE](CODE-STYLE.md), [RELEASES](RELEASES.md), and [DEBUGGING](DEBUGGING.md).

### `v0.0.9` — Implementation Preflight

Complete the specification audit, accepted decision records, canonical test vectors, and requirement traceability for the frozen v0.1.0 scope. This Specification Release Candidate 1 completes technical planning; it does not begin implementation. See [PREFLIGHT](PREFLIGHT.md), [TEST-VECTORS](TEST-VECTORS.md), [TRACEABILITY](TRACEABILITY.md), and [accepted decisions](decisions/0001-event-sourced-household-state.md).

### `v0.0.10` — GitHub Community & Project Documentation

Align README with the Build Fest project requirements and add project-scoped conduct, security, support, issue, and pull-request guidance. The MIT license already exists. Because Kin is nested in a monorepo, GitHub does not automatically discover the nested community files/templates; document this limitation rather than changing parent-repository files. This release remains documentation-only.

### `v0.0.11` — Implementation Cycle Handoff

Record the general release cadence for future implementation lines, reaffirm v0.1.0 as the first implementation milestone, and correct stale current-version wording. Preserve the v0.1.0 specification and v0.0.10 community-health work; this release adds no application code or build tooling.

### `v0.0.12` — Changelog & Release History

Establish a Kin-scoped changelog from actual tagged release history and document its maintenance. This is a documentation-only release; it does not begin v0.1.0 implementation.

## First coded release

Each minor release represents a new product capability. Its initial stabilization patches address correctness (`.1`), resilience/accessibility (`.2`), and hardening (`.3`) when needed. After `.3`, stop and ask the user before starting another feature; additional fixes remain patches `.4` and onward.

### `v0.1.0` — Household Heartbeat

Implemented: Rust compiled to WebAssembly, a native `<kin-app>` with focused child custom elements, the manual versioned JS/WASM ABI, `ITEM_ADDED` and `ITEM_COMPLETED`, deterministic Rust replay, IndexedDB event-only persistence, and add/complete/reload behavior using local placeholder identities. No partner login, sync, or other product areas are included. See [V0.1.0.md](V0.1.0.md) for the frozen contract and release checks.

The detailed boundary and acceptance scope are in [V0.1.0.md](V0.1.0.md); release history is in [CHANGELOG](../CHANGELOG.md).

### `v0.1.1` — Core Correctness

Hardened Unicode roundtripping, local storage startup cleanup, and stored-event metadata validation. Regression checks cover malformed input, invalid-event non-append behavior, corrupted-row preservation, concurrent tabs, and rapid repeated submission. No new product capability was added.

### `v0.1.2` — Resilience & Accessibility

Preserves an in-progress compose draft across same-tab reloads using best-effort `sessionStorage`, restores keyboard focus after asynchronous add/complete operations, exposes `aria-busy`, and improves feedback when WASM or local storage is unavailable. Reflow and touch targets were checked at narrow widths. No new product capability was added.

### `v0.1.3` — Household Heartbeat Hardening

Audits the Rust/JavaScript ownership boundary, future-capability leverage, dependency surface, local-only privacy behavior, and v0.0.10 community documentation. Fixes only meaningful infrastructure or hardening gaps; introduces no new product capability.

### `v0.1.4` — Household Heartbeat Maintenance

Continues approved correctness, resilience, accessibility, test, and tooling improvements to the existing Household Heartbeat. No new product capability.

## Product increments

### `v0.2.0` — Today + Needs

Add the Today and Needs views, fast capture, lightweight classification, and active/completed household items.

### `v0.3.0` — Handoff

Add short parent-to-parent handoffs, acknowledgement, recent handoff state, and household context transfer.

### `v0.4.0` — Talk

Add capture and revisit state for topics to discuss later, including resolved/unresolved state. Keep the experience nonjudgmental: no blame or scoring.

### `v0.5.0` — Pulse

Explore a lightweight current-capacity signal with expiration and acknowledgement only if useful. No scoring or historical ranking.

### `v0.6.0` — Since You Last Looked

Derive a compact summary from event additions, completions, changes, new handoffs, and Talk updates. This is intended to become a signature capability while respecting member expectations and privacy.

### `v0.7.0` — Routines

Add recurring household needs and lightweight routines, with recurrence logic in Rust. Avoid turning Kin into a traditional calendar.

### `v0.8.0` — Household Pairing

Begin multi-user household identity. Explore one household with two adult members, QR pairing, a short-lived pairing code, passkeys, and trusted devices. Define authorization and recovery before shipping pairing.

### `v0.9.0` — Encrypted Sync

Explore encrypted event synchronization across trusted devices, revocation, and offline reconciliation. Minimize what the service can know about household content. This release depends on a reviewed threat model and a clear key lifecycle.

### `v1.0.0` — Build Fest release

Focus on polish, reliability, accessibility, mobile UX, privacy documentation, onboarding, a clear demo, and real daily usability. Do not use the release as a reason to add major new architecture.

## Scope discipline

Each roadmap item is future work unless explicitly marked as completed. Authentication, passkeys, encryption, remote services, pairing, and synchronization remain unimplemented and out of scope for the v0.1.x line. Releases through `v0.0.12` were documentation-only; v0.1.0 is the first coded release, and v0.1.3 remains solely its hardening line.
