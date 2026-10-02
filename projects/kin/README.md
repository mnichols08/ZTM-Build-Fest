# Kin

> A private, lightweight household coordination app for the little things families need to know, remember, hand off, or discuss.

**Current status: `v0.1.3` — Household Heartbeat Hardening.** Kin provides a local household item loop: add items, complete items, persist immutable events in IndexedDB, and reconstruct state through a Rust/WASM engine after reload. The `.1.1` and `.1.2` patches hardened correctness, interruption recovery, and accessibility; `.1.3` audits the durable core, privacy, dependencies, and release documentation. Planning/specification through `v0.0.9` and community/release documentation through `v0.0.12` remain preserved in history.

## The problem

Household information gets scattered across memory, messages, calendars, sticky notes, verbal conversations, and assumptions. That makes small handoffs easy to miss and everyday coordination harder than it needs to be. The gaps can lead to "I thought you knew," "Why didn't you tell me?", "I thought you were doing that," or conversations happening at the wrong time.

Kin aims to make useful household context easier to share and find. It is not a promise to prevent conflict or fix relationships, and it will not decide who is right or measure anyone's contribution.

## Intended direction

Kin is intended as a private, lightweight shared household operating layer. Today’s simple item view and local add/complete loop are implemented. Needs classification, Handoff, Talk, Pulse, Routines, and Since You Last Looked remain future concepts.

The intended technical direction is Rust compiled to WebAssembly, native Web Components, vanilla JavaScript, and browser APIs, with a local-first start and no external framework unless a demonstrated requirement justifies one.

## Release history

- `v0.0.1` — Product definition and principles (`kin-v0.0.1`)
- `v0.0.2` — Architecture, event model, and privacy design (`kin-v0.0.2`)
- `v0.0.3` — UX flows and implementation planning (`kin-v0.0.3`)
- `v0.0.4` — Household Domain Specification (`kin-v0.0.4`)
- `v0.0.5` — Trust, Identity, and Synchronization Design (`kin-v0.0.5`)
- `v0.0.6` — Implementation Contract (`kin-v0.0.6`)
- `v0.0.7` — Data Durability & Evolution (`kin-v0.0.7`)
- `v0.0.8` — Developer & Contributor Experience (`kin-v0.0.8`)
- `v0.0.9` — Implementation Preflight (`kin-v0.0.9`)
- `v0.0.10` — GitHub Community & Project Documentation (`kin-v0.0.10`)
- `v0.0.11` — Implementation Cycle Handoff (`kin-v0.0.11`)
- `v0.0.12` — Changelog & Release History (`kin-v0.0.12`)
- `v0.1.0` — Household Heartbeat (`kin-v0.1.0`)
- `v0.1.1` — Core Correctness (`kin-v0.1.1`)
- `v0.1.2` — Resilience & Accessibility (`kin-v0.1.2`)
- `v0.1.3` — Household Heartbeat Hardening (`kin-v0.1.3`)
- See the [changelog](CHANGELOG.md) for the completed release history.

## Install, build, and run

Requirements: Rust/Cargo with the `wasm32-unknown-unknown` target, Python 3 for the optional static server, and a modern browser with WebAssembly, ES modules, Custom Elements, and IndexedDB.

From the repository root in PowerShell:

```powershell
rustup target add wasm32-unknown-unknown
.\projects\kin\build-wasm.ps1
py -m http.server 8000 --directory projects/kin/web
```

Then open `http://localhost:8000`. On macOS/Linux, build and copy the local WASM artifact with `sh projects/kin/build-wasm.sh`, then serve with `python3 -m http.server 8000 --directory projects/kin/web`.

Kin stores household events in the current browser profile's IndexedDB and may keep the in-progress compose draft in tab-scoped `sessionStorage`. It does not provide accounts, backup, encryption, pairing, or cross-device sync; browser storage is not a security boundary against device compromise or extensions. Use synthetic household text while evaluating this prototype.

## AI usage

AI-assisted development tools are used for brainstorming, product planning, architecture exploration, documentation, implementation support, debugging, and testing. Kin has no AI runtime, analytics, backend, or third-party runtime dependency; household events are processed locally and are not transmitted by the application.

## License

Kin is available under the [MIT License](LICENSE).

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [GitHub community files and monorepo limitations](docs/GITHUB-COMMUNITY.md)

Kin is nested in the ZTM Build Fest repository. Its community files and templates are kept inside `projects/kin/`; GitHub does not automatically apply nested `.github` templates or count them in the parent repository's Community Standards profile.

## Project documents

- [Changelog](CHANGELOG.md)
- [Product vision](docs/PRODUCT.md)
- [Principles and non-goals](docs/PRINCIPLES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Conceptual data model](docs/DATA-MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [Household domain](docs/DOMAIN.md)
- [Event contract](docs/EVENTS.md)
- [Derived state and replay](docs/STATE.md)
- [Entity lifecycles](docs/LIFECYCLES.md)
- [Identity and trusted devices](docs/IDENTITY.md)
- [Pairing](docs/PAIRING.md)
- [Synchronization design](docs/SYNC.md)
- [Cryptographic posture](docs/CRYPTOGRAPHY.md)
- [Threat model](docs/THREAT-MODEL.md)
- [Implementation layout and responsibilities](docs/IMPLEMENTATION.md)
- [JavaScript/WASM ABI](docs/ABI.md)
- [IndexedDB storage contract](docs/STORAGE.md)
- [Web Component contract](docs/COMPONENTS.md)
- [Testing contract](docs/TESTING.md)
- [Accessibility contract](docs/ACCESSIBILITY.md)
- [Persistent contract versioning](docs/VERSIONING.md)
- [Migration safety](docs/MIGRATIONS.md)
- [Portable household data](docs/PORTABILITY.md)
- [Retention and deletion](docs/RETENTION.md)
- [Development workflow](docs/DEVELOPMENT.md)
- [Code style](docs/CODE-STYLE.md)
- [Release process](docs/RELEASES.md)
- [Debugging and diagnostics](docs/DEBUGGING.md)
- [Implementation preflight](docs/PREFLIGHT.md)
- [Requirement traceability](docs/TRACEABILITY.md)
- [Canonical test vectors](docs/TEST-VECTORS.md)
- [Accepted architecture decision: event-sourced household state](docs/decisions/0001-event-sourced-household-state.md)
- [UX flows](docs/UX.md)
- [Roadmap](docs/ROADMAP.md)
- [v0.1.0 implementation specification](docs/V0.1.0.md)
