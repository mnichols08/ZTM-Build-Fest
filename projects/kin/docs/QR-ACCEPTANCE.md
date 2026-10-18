# QR engine: acceptance status (#94, #95)

Each acceptance criterion from issues #94 (encoder) and #95 (decoder) is
marked **Done** (verified by the named test or check), **Changed** (met in a
different form, with the reason), or **Deferred** (moved to the named issue).
Nothing here is marked done without evidence. Verification commands are in
the PR description.

## #94 — encoder

| Criterion | Status | Evidence / reason |
|---|---|---|
| Byte mode, versions 1–10, level M, smallest version chosen | Done | `encode.rs` `choose_version`; `versions_grow_with_the_payload` |
| Reed–Solomon over GF(256), generator built at compile time | Done | `rs.rs` `build_generators` is a `const fn` table; `generators_have_the_standard_roots` |
| Function patterns, format BCH(15,5), version BCH(18,6) from v7 | Done | `layout.rs`; `every_version_and_mask_round_trips` |
| Zigzag data placement, all 8 masks, 4 penalty rules, lowest chosen | Done | `encode.rs`, `layout.rs` `penalty`; `golden_grids_match_an_independent_encoder_for_every_mask` |
| Fixed module buffer `[u8; 57 × 57]` plus `size`; no heap on the encode path | Done | `Code { size, dark: [u8; 3249] }`; every encoder buffer is an array. The only allocation is the ABI result buffer (`wire.rs`), which the host owns. |
| `qr_encode(in, len, out) -> size` ABI | Changed | Implemented as `kin_qr_encode(ptr, len)` returning a `KQRM` result, with KERR errors. ABI.md requires host-owned result buffers and KERR on every export; an out-pointer would bypass that contract. The size is in the result header. |
| ISO 18004 Annex I example, byte-mode equivalent, codewords asserted | Changed | `01234567` in byte mode is pinned to the reference grid for all 8 masks. The check is on the full module grid, which embeds every codeword, not on a codeword list. The annex's own example is numeric and cannot be a byte-mode fixture. |
| Golden grids for 3 URLs in TEST-VECTORS | Changed | The three grids are pinned by FNV-1a 64 hashes per mask (24 hashes) in `docs/TEST-VECTORS.md`, with the same hashes asserted in Rust. Full grids for the three texts are about 11 KB of bit strings, which is hard to review. The hashes are reproducible from the reference encoder. |
| Round-trip every version and mask through the decoder | Done | `coverage::every_version_and_mask_round_trips` (80 cases) |
| Reject input over capacity | Done | `TooLong` → `SizeLimit`; `malformed` and `wire` tests |

## #95 — decoder

| Criterion | Status | Evidence / reason |
|---|---|---|
| Grayscale input up to 1280 × 720 | Done | `decode.rs` `MAX_WIDTH`, `MAX_HEIGHT`, `MAX_PIXELS`; `malformed_frames_are_refused_with_the_reason`, `a_symbol_fits_a_full_720p_frame` |
| Adaptive threshold, integral image, fixed scratch sized for the maximum frame | Changed | The integral image and binary buffers live in a reusable `Scratch`. They grow to the largest frame seen, capped at `MAX_PIXELS`, rather than being reserved at startup, so an idle page doesn't hold about 4.7 MB. `scratch_memory_is_reused_across_frames` checks that repeat frames don't grow the scratch. |
| Finder search, triangle of the 3 best candidates | Done | Candidates capped at 64; the best triangle is picked from the 8 strongest (`pick_triangle`). |
| Alignment search and perspective from 4 points | Done | Template matched along the symbol's own axes, so it works at any rotation; `reads_at_every_quarter_turn_of_rotation` covers every 15°. |
| Format info with error tolerance, unmasking, codeword reading | Done | Distance ≤ 3; `a_damaged_format_copy_is_still_read` |
| Reed–Solomon: syndromes, Berlekamp–Massey, Chien, Forney | Done | `rs.rs`, now on fixed arrays; `corrects_up_to_half_the_check_symbols`, `reads_damage_up_to_the_correction_budget` |
| Byte-mode payload out, `qr_decode(frame, w, h) -> len` | Changed | Implemented as `kin_qr_decode(ptr, len)` with `width:u32, height:u32, luma` in one buffer, and the payload as the result. Same KERR contract as the rest of the ABI. |
| Frame copied into a preallocated WASM buffer, no copy back | Deferred to #96 | The ABI frees each input after the call, so a reusable frame buffer needs the browser host to hold one allocation. That's part of the camera component. |
| Hard caps on frame size, candidates and iterations; no panic; no allocation per frame | Done | `PIXEL_BUDGET` (4 M pixel reads per pass), `MAX_FINDERS`, `TEMPLATE_COST`, a fixed window radius; `fuzz_*` tests; `scratch_memory_is_reused_across_frames`. A second, inverted pass runs only when the first fails. |
| Round trip across all versions and masks | Done | `every_version_and_mask_round_trips` |
| Rotation 0–360°, perspective, scaling, Gaussian noise, blur, inversion, damage | Done | `reads_at_every_quarter_turn_of_rotation` (24 angles), `every_version_reads_through_a_mild_tilt`, `reads_through_perspective_rotation_and_noise`, `reads_at_every_scale_from_three_to_eight_pixels_per_module`, `reads_through_gaussian_sensor_noise`, `reads_light_on_dark_symbols`, `reads_blurred_frames`, `reads_two_pixel_blur_at_a_comfortable_scale`, `reads_damage_up_to_the_correction_budget` |
| Fuzz-style panic safety | Done | `fuzz_random_frames_never_panic` (612 frames), `fuzz_corrupted_symbols_never_panic` (120 symbols), `long_fuzz_run` (20 000 frames, `#[ignore]`). Wrong payloads are never returned in the corruption tests. |
| Release-WASM benchmark, ≤ 25 ms at 640 × 480 | Deferred (not measured here) | The native release figure is 2.6 ms median at 640 × 480 and 7.2 ms at 1280 × 720 (`bench_decode_native`). The WASM figure needs the `wasm32` target, which this environment couldn't install. The benchmark is `scripts/qr-performance.mjs`; it must be run after `build-wasm.sh`, and its result recorded. |
| Version 1 symbols on perspective frames | Deferred (documented limitation) | The fourth corner needs an alignment pattern, which version 1 lacks. Kin's links are far longer than 14 bytes. Recorded in `docs/ABI.md`. |

## Out of scope for this PR

- #96: camera capture, the frame loop, the frame buffer and the QR display component.
- #97, #98: invite and sign-in flows, and their server endpoints and passkey gates.
- #102: PAIRING.md, CHANGELOG and the user-facing docs. The version 1 limit and
  the ABI are documented here and in `docs/ABI.md`.
