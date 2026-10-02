# Development Workflow

**Status:** current workflow for the v0.1.x local prototype.

## Build and run

```text
clone the ZTM Build Fest repository
        |
        v
work inside projects/kin/
        |
        v
install rustup/Cargo and the wasm32-unknown-unknown target
        |
        v
build the Rust/WASM module using the project-local manifest
        |
        v
serve the static web files from localhost
        |
        v
open the supported browser and exercise v0.1.0
```

From the repository root in PowerShell:

```powershell
.\projects\kin\build-wasm.ps1
py -m http.server 8000 --directory projects/kin/web
```

Open `http://localhost:8000`. On macOS/Linux, build from the repository root with `sh projects/kin/build-wasm.sh`, then serve with `python3 -m http.server 8000 --directory projects/kin/web`. Never run Cargo from the Build Fest repository root for Kin; generated artifacts belong under `projects/kin/`.

## First-class operating systems

Windows, macOS, and Linux are intended development environments. Documentation and future scripts must not assume Bash, GNU-only utilities, POSIX path syntax, or a Unix package manager. Prefer Cargo/rustup and portable project commands. Where a command differs, show native PowerShell and shell equivalents rather than forcing developers to install a compatibility shell.

Windows developers should be able to use PowerShell and standard Rust tooling. macOS and Linux developers should be able to use their standard shells and rustup. Compiler/browser differences should be captured in issue reports with OS and version details.

## Intended minimal tools

- Rust toolchain (`rustup`, `cargo`) and the `wasm32-unknown-unknown` target
- A modern browser with the platform APIs in [IMPLEMENTATION](IMPLEMENTATION.md)
- A lightweight static-file server bound to localhost during development
- Optional system Python for serving static files (`py -m http.server` on Windows or `python3 -m http.server` on macOS/Linux); this is not an application dependency
- Optional Node.js for the built-in bridge regression tests; no npm packages are required
- Python 3.11 or later for the built-in TOML-based version consistency check

No npm dependency tree or framework runtime is planned. If static serving later requires a helper, prefer a minimal cross-platform option with a clear security/update story.

## Browser capabilities

The application requires WebAssembly, ES modules, Custom Elements, IndexedDB, `CustomEvent`, text encoders/decoders, and secure-context browser APIs. WebAuthn and Web Crypto for content security belong to later identity/sync work, not v0.1.0 authentication or encryption. Desktop Chrome was exercised in the integrated VS Code browser; this does not certify the full browser support target.

## Development data

Use synthetic household text only. Never copy private family messages, health details, credentials, or real household history into test fixtures, screenshots, bug reports, or logs. Local test data can be removed through the browser's site-data controls for the local origin. Kin does not include a reset command that could accidentally remove household data.
