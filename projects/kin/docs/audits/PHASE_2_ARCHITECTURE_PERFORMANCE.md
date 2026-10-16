# Phase 2 architecture and performance measurements

**Measured:** 2026-10-16  
**Candidate:** v0.47.0 plus the reliability landing stack  
**Environment:** Windows x64, Node 22.13.0, Edge 155.0.4283.45

These measurements decide whether narrowly scoped architecture work is
justified. They are not production certification or a substitute for the
physical-device matrix.

## Busy-state traversal

Command:

```text
node scripts/core-performance.mjs --browser <edge> --json target/phase2-busy-baseline.json
```

`core-performance.mjs` now isolates `StatusController.setBusy(true)` and
`setBusy(false)` around the shipped application. Figures are medians after one
warm-up.

| History | Rendered controls | Busy on | Busy off | Round trip | No-change app refresh |
|---|---:|---:|---:|---:|---:|
| 1,000 short events | 4,166 | 8.8 ms | 8.6 ms | 17.4 ms | 33.8 ms |
| 9,980 short events | 40,086 | 95.8 ms | 105.8 ms | 201.6 ms | 649.6 ms |
| 9,980 events × 4 KB | 40,086 | 96.9 ms | 103.7 ms | 200.6 ms | 674.5 ms |

The cost scales with rendered controls, not canonical byte size. At the local
history bound the traversal alone blocks the main thread for about 0.2 s per
operation. This is material and justifies a native disabled-fieldset prototype.
The status, alert and route-announcement regions must remain outside the
disabled control boundary or remain non-form descendants whose live-region
semantics are verified.

## Cold relay synchronization

Command:

```text
node scripts/relay-performance.mjs --json target/phase2-relay.json
```

The harness uses the real process-local relay, its 20-event binary pages, Web
Crypto signature verification/decryption and one release-WASM replay. It
excludes network latency and IndexedDB commit, so its active result is a lower
bound. Fixture construction is reported but excluded. The cadence lower bound
adds the production coordinator policy: at most five pages per run followed by
the five-second interval.

| History | Pages | Wire bytes | Relay + wire + crypto | WASM replay | Active total | Current cadence floor |
|---|---:|---:|---:|---:|---:|---:|
| 1,000 events | 50 | 306,893 | 160.6 ms | 12.3 ms | 172.9 ms | 45.17 s |
| 10,000 events | 500 | 3,078,894 | 1,432.9 ms | 56.6 ms | 1,489.5 ms | 496.49 s |

The material cost is scheduling: the current policy adds 45 seconds at a
realistic history and 8 minutes 15 seconds at the local maximum even on a
zero-latency relay. Crypto and replay do not justify a rewrite. A bounded,
event-loop-yielding continuation while `hasMore` is true is justified; page
size, envelope format, relay storage and cryptography should remain unchanged.
Browser integration must still measure IndexedDB commit and confirm that
foreground interaction, pause/stop and authorization failures remain
responsive.

## Archive restoration on constrained hardware

Command:

```text
node scripts/security-storage-regression.mjs <edge> --performance-only --maximum-payload --cpu-throttle 4
```

Edge DevTools throttled renderer CPU 4×. This is a repeatable constrained-CPU
simulation, not a physical low-end-device claim. The harness uses real browser
crypto, IndexedDB and release WASM and verifies every restored canonical record
against its source SHA-256 digest. Phase timings exclude the harness's 1.2 s
pre-phase collection wait; the end-to-end restore timing includes it.

| History | Archive | Export | Restore end to end | Restore phase | Restore peak working set | Exact |
|---|---:|---:|---:|---:|---:|---|
| 1,000 short events | 0.15 MiB | 1.46 s | 3.74 s | 2.00 s | 503 MiB | yes |
| 10,000 short events | 1.52 MiB | 4.70 s | 20.34 s | 16.79 s | 389 MiB | yes |
| 10,000 events × 4 KB | 40.25 MiB | 2.95 s | 77.37 s | 73.89 s | 1,024 MiB | yes |

The maximum-payload case is materially slow and memory-heavy, but it is a
synthetic supported bound and the recovery path remains exact and atomic. No
restore architecture change is made from this result alone. Physical-device
archive transfer remains a release gate; if that reproduces memory pressure or
termination, optimize the protect-and-stage phase without weakening atomic
promotion, canonical validation or archive compatibility.

## Decisions

1. Prototype native fieldset disabling because the measured main-thread cost is
   material.
2. Prototype immediate bounded relay continuation because the measured cadence,
   not the protocol or crypto, dominates cold synchronization.
3. Do not redesign archive restoration yet. Carry its constrained maximum as a
   known release risk into physical-device acceptance.
4. Do not change persistent formats, Rust/WASM ownership, relay storage,
   cryptography or archive atomicity from these measurements.

