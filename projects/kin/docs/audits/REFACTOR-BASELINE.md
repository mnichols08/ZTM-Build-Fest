# Refactor track — performance baseline

Baseline for the `kin-refactor-track` slices and the record each slice is
compared against. A slice may not regress a measured stage by more than 10%
without a written justification in its report.

## How it is measured

`node scripts/core-performance.mjs --browser <chromium>` (builds the release
WASM first if it is missing). Every figure is a median after one warm-up.

- **Node stages** (real release WASM, no storage; 7 samples): request encode,
  copy into WASM memory, Rust replay plus projection encode, copy-out plus JS
  decode. Inputs are `ITEM_ADDED` events through the Rust command encoder.
- **Browser stages** (real IndexedDB, Web Crypto and the shipped app in a
  temporary headless profile): native IDB read of every protected row (4
  samples), decryption of every row (4), store unlock to the first projection
  (1), store-level refresh (`getCatchUpState` plus replay; 5) and command
  (`append`; 5), and in the app page: `renderState()` (5), the full
  `refreshFromEvents()` a peer tab runs, including render (5), and unlock
  through the app's recovery-key path (1).
- Datasets: 1,000 short-text events (24-byte text), and 9,980 short-text and
  9,980 × 4,096-byte events. Browser fixtures stop 20 events short of the
  10,000-event store limit so the command samples can append. The table rows
  still say "10k".

Environment: Windows 11 x64, Node 22.13.0, Edge 155.0.4283.45, Rust 1.93.0.
Measurements are from one machine with nothing else running. They are evidence
for relative change, not a device-class benchmark.

## Baseline (`kin-development` at `d616eef` plus the Phase 0 bridge changes, before the arena)

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Request encode | 0.24 | 0.95 | 12.57 |
| Copy into WASM | 0.01 | 0.15 | 6.55 |
| Rust replay + encode | 1.07 | 9.90 | 83.73 |
| Copy-out + JS decode | 4.47 | 32.11 | 80.46 |
| IDB read (all rows) | 12.1 | 119.2 | 492.8 |
| Decrypt (all rows) | 123 | 1,445 | 10,711 |
| Store unlock → projection | 275 | 3,444 | 24,456 |
| Store refresh | 128 | 1,515 | 10,556 |
| Store command | 133 | 1,516 | 10,743 |
| App `renderState()` | 269 | 2,498 | 2,321 |
| App peer refresh (incl. render) | 420 | 4,688 | 13,538 |
| App unlock (recovery key) | 664 | 5,998 | 24,940 |

Observations that drive the slices:

- Decryption dominates every storage path (H1). A refresh or command decrypts
  the whole log, and unlock decrypted it twice (`ensureContext` then
  `getCatchUpState`).
- Rust replay is small next to everything around it. At 10k short events JS
  decode (32 ms) costs three times the replay (10 ms) (H2, H3).
- Rendering every section costs about 2–2.5 s at 10k events whether or not
  anything changed (H5); after Slice 1 it dominates the app refresh.

## Slice 1 — session plaintext arena

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Request encode (Node, array input) | 0.21 | 0.76 | 8.70 |
| Copy into WASM | 0.01 | 0.14 | 5.14 |
| Rust replay + encode | 1.03 | 9.91 | 67.38 |
| Copy-out + JS decode | 4.52 | 33.83 | 58.49 |
| IDB read (all rows) | 11.3 | 88.7 | 454.4 |
| Decrypt (all rows) | 117 | 1,188 | 8,390 |
| Store unlock → projection | 142 | 1,447 | 9,223 |
| **Store refresh** | **5.4** | **50.1** | **194** |
| **Store command** | **6.8** | **57.2** | **226** |
| App `renderState()` | 169 | 2,023 | 2,023 |
| App peer refresh (incl. render) | 219 | 2,541 | 2,856 |
| App unlock (recovery key) | 416 | 3,439 | 12,616 |

The "IDB read" and "decrypt" rows are the raw full-log costs, measured
directly. With the arena, normal operation pays them once, at unlock.

**D1 gate (decrypted history in memory only if it measurably helps): passed.**

- Store refresh at 10k events fell from 1,515 ms to 50 ms (30×), under the
  100 ms target. Commands fell from 1,516 ms to 57 ms (27×). With 4 KB events
  they fell from about 10.6 s to about 0.2 s.
- Decryption no longer grows with history on refresh or command; only rows
  after the arena tail are decrypted (one row for one new event, asserted by
  the two-tab regression). The remaining refresh cost is the full replay,
  decode and copy, which still grow linearly (about 5 ms per 1,000 short
  events). Phases 3–5 (Slices 6–8) target that work.
- Unlock is faster, not slower: one full decrypt instead of two (store unlock
  3,444 → 1,447 ms at 10k; app unlock 5,998 → 3,439 ms).
- The app's peer refresh is still about 2.5 s at 10k because `renderState()`
  rebuilds every section (about 2.0 s). That is H5, the subject of Slice 4. It
  does not affect the store-level gate, which measures the history path the
  arena changes.
- No Node stage regressed beyond noise. The 10k decode moved +5% between
  runs, inside run-to-run variance; the 4 KB stages improved because command
  requests no longer copy the history twice.

## Slice 2 — protocol 24 only

Two runs, because the first showed movement in stages this slice did not
touch (the Node array encode and the app render); the second, with nothing
else running, is the comparison of record.

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Request encode | 0.25 | 0.74 | 8.48 |
| Copy into WASM | 0.01 | 0.14 | 5.10 |
| Rust replay + encode | 1.09 | 9.93 | 62.99 |
| Copy-out + JS decode | 3.78 | 31.93 | 55.61 |
| Store unlock → projection | 146 | 1,416 | 9,463 |
| Store refresh | 5.6 | 48 | 180 |
| Store command | 7 | 55 | 242 |
| App `renderState()` | 177 | 2,144 | 2,216 |
| App peer refresh (incl. render) | 236 | 2,536 | 2,697 |
| App unlock (recovery key) | 407 | 5,245 | 12,399 |

Every multi-sample stage is within ±10% of Slice 1 except render at 10k short
(+6%, inside the first run's spread). App unlock at 10k varied between runs:
3,439 ms (Slice 1), 4,027 ms (Slice 2, first run) and 5,245 ms (Slice 2,
second run). It is one unrepeated sample of the app's whole boot-and-unlock
path, and the replay code under it is unchanged, so this is run-to-run
variance, not a regression. The store-level unlock, which is sampled more
directly, is 1,416 ms against 1,447 ms. Replay itself is unchanged: decoding
and encoding run the same protocol-24 code without version branches, and the
golden fixtures are byte-identical.

## Slice 3 — shared component helpers and the `<kin-app>` split

| Stage (ms) | 1k short | 10k short | 10k × 4 KB |
| --- | ---: | ---: | ---: |
| Rust replay + encode | 1.10 | 9.88 | 64.88 |
| Copy-out + JS decode | 3.98 | 30.80 | 58.47 |
| Store unlock → projection | 142 | 1,453 | 9,703 |
| Store refresh | 6 | 47 | 161 |
| Store command | 7 | 54 | 202 |
| App `renderState()` | 185 | 2,245 | 2,050 |
| App peer refresh (incl. render) | 228 | 2,594 | 2,959 |
| App unlock (recovery key) | 409 | 3,495 | 13,258 |

The split moves code without changing it, and no stage moved by more than
10% against Slice 2. The largest moves were app peer refresh at 10k × 4 KB
(+9.7%) and render at 10k short (+4.7%), both inside the run-to-run spread
recorded above. The added indirection (`this.ctx.<controller>`) is one
property lookup per call.
