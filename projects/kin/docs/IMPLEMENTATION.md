# v0.1.0 Implementation Contract

**Status:** implemented for v0.1.0. The project-local layout and responsibilities below describe the current Household Heartbeat implementation; later product capabilities remain future work.

## Proposed project layout

```text
projects/kin/
├── AGENTS.md
├── README.md
├── CHANGELOG.md
├── LICENSE
├── Cargo.toml
├── build-wasm.ps1
├── .gitignore
├── docs/
├── rust/
│   └── src/
│       ├── lib.rs
│       ├── abi.rs
│       ├── event.rs
│       ├── state.rs
│       ├── protocol.rs
│       └── error.rs
└── web/
    ├── index.html
    ├── components/
    │   ├── kin-app.js
    │   ├── kin-today.js
    │   ├── kin-compose.js
    │   └── kin-item.js
    ├── wasm/
    │   ├── kin-engine.js
    │   └── kin-engine.test.mjs
    ├── storage/
    │   └── event-store.js
    └── styles/
```

The v0.1.0 implementation uses this layout. The generated `target/` tree and `web/wasm/kin_engine.wasm` are local build artifacts and are ignored by Git. Avoid a general framework or extra component/module unless a scoped requirement needs it.

## Module responsibilities

- **`rust/src/event.rs`:** event kinds, envelope representation, payload validation, and v0.1.0 event decoding.
- **`rust/src/state.rs`:** deterministic reducer and projection of the ordered local event stream into item state.
- **`rust/src/protocol.rs`:** versioned binary request/result encoding and bounded parsing.
- **`rust/src/abi.rs`:** exported C-ABI functions, pointer/length checks, buffer ownership, and status codes.
- **`rust/src/error.rs`:** stable error categories and non-sensitive messages.
- **`rust/src/lib.rs`:** module exports only; no DOM or browser API access.
- **`web/wasm/kin-engine.js`:** load WASM, validate memory ranges, allocate/copy input, call exports, copy result/error bytes before another mutating call, and decode the protocol.
- **`web/storage/event-store.js`:** open/migrate IndexedDB, read the ordered event log, and append an event atomically.
- **`web/components/kin-app.js`:** orchestrate initialization, event-store and WASM calls, loading/error states, and rendering.
- **`web/components/kin-today.js`:** display active and completed items from the Rust projection.
- **`web/components/kin-compose.js`:** capture short item text and dispatch a browser-native custom event.
- **`web/components/kin-item.js`:** render one item and expose its completion control; it contains no authoritative state transition.
- **`web/index.html` and styles:** semantic shell and minimal responsive presentation.

See [ABI](ABI.md), [Storage](STORAGE.md), and [Components](COMPONENTS.md) for implementable contracts. Rust owns authoritative domain rules; JavaScript owns browser integration and persistence.

## Build boundary

The target is `wasm32-unknown-unknown`. The local WASM artifact is loaded by the page; no remote code loader is used. Kin has no `wasm-bindgen`, `web-sys`, `js-sys`, `serde`, `serde_json`, UI framework, or runtime library dependency. `build-wasm.ps1` builds and copies the artifact for local static serving.

`web/index.html` applies a same-origin Content Security Policy. It allows `wasm-unsafe-eval` only for WebAssembly compilation/instantiation; scripts, styles, fetches, images, and fonts remain same-origin. The policy denies objects and restricts base/form targets. A meta-delivered policy cannot set `frame-ancestors`; production hosting should add that directive as an HTTP response header if framing must be prohibited.

## Browser support floor

The target remains the latest two stable major releases of desktop and mobile Chrome, Firefox, and Safari. The browser must provide core WebAssembly, ES modules, Custom Elements, IndexedDB, `CustomEvent`, `TextEncoder`/`TextDecoder`, `crypto.getRandomValues`, and a secure context (including localhost for development). Do not target Internet Explorer or obsolete browsers. The v0.1.0 release was exercised in desktop Chrome through the integrated VS Code browser; the broader target is not certified by that check.
