//! QR decoder for camera frames, written from scratch.
//!
//! Pipeline: a locally adaptive threshold; finder-pattern detection by the
//! 1:1:3:1:1 run ratio, confirmed on both axes and grouped into one
//! right-angled triangle; an alignment-pattern refinement for versions 2+; a
//! homography from module grid to frame; format read with BCH correction;
//! unmasking; de-interleaving; Reed–Solomon correction; byte-mode parse.
//!
//! Only level M, byte mode and versions 1–10 are read: the symbols Kin draws.

use super::{
    layout::{self, Grid},
    rs, tables, QrError,
};

/// A grayscale frame, one byte per pixel, row-major.
pub struct Frame<'a> {
    pub width: usize,
    pub height: usize,
    pub luma: &'a [u8],
}

/// Reads the single QR symbol in `frame` and returns its payload.
pub fn decode(frame: &Frame) -> Result<Vec<u8>, QrError> {
    if frame.width == 0 || frame.height == 0 || frame.luma.len() != frame.width * frame.height {
        return Err(QrError::NotFound);
    }
    let binary = binarize(frame);
    let finders = find_finders(&binary, frame.width, frame.height);
    let triangle = pick_triangle(&finders).ok_or(QrError::NotFound)?;
    let geometry = Geometry::from_triangle(&triangle, &binary, frame.width, frame.height)?;
    let version = geometry.version;
    let transform = geometry.transform()?;
    let dark = sample(&binary, frame.width, frame.height, &transform, geometry.dim);
    let (mask, _) = read_format(&dark, geometry.dim)?;
    let grid = Grid::with_function_patterns(version);
    let codewords = read_codewords(&dark, &grid, version, mask);
    let data = correct_blocks(&codewords, version)?;
    parse_byte_mode(&data, version)
}

// ---------------------------------------------------------------------------
// Binarization
// ---------------------------------------------------------------------------

/// Dark if a pixel is clearly darker than its neighbourhood mean. Local means
/// tolerate uneven lighting and glare, which a global threshold doesn't.
fn binarize(frame: &Frame) -> Vec<u8> {
    let (w, h) = (frame.width, frame.height);
    let mut integral = vec![0u32; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0u32;
        for x in 0..w {
            row += u32::from(frame.luma[y * w + x]);
            integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
        }
    }
    let half = (w.min(h) / 12).max(4);
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(half), (y + half + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(half), (x + half + 1).min(w));
            let sum = integral[y1 * (w + 1) + x1] + integral[y0 * (w + 1) + x0]
                - integral[y0 * (w + 1) + x1]
                - integral[y1 * (w + 1) + x0];
            let count = ((y1 - y0) * (x1 - x0)) as u64;
            let pixel = u64::from(frame.luma[y * w + x]);
            // pixel < mean - 8, without dividing.
            if pixel * count + 8 * count < u64::from(sum) {
                out[y * w + x] = 1;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Finder patterns
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
struct Finder {
    x: f64,
    y: f64,
    unit: f64,
    hits: u32,
}

/// Position along one axis through a dark centre, measured outward.
struct Axis {
    /// Offset of the centre run's midpoint from the scan origin.
    mid: f64,
    /// Length of the dark run through the origin.
    centre: usize,
    /// Light, dark, light, dark run lengths, outward on the negative side
    /// first, then the positive side.
    outer: [usize; 4],
}

/// Measures the run structure through (x, y) along one axis. Fails if the
/// origin isn't dark or the pattern runs off the frame.
fn scan_axis(
    binary: &[u8],
    w: usize,
    h: usize,
    x: usize,
    y: usize,
    horizontal: bool,
) -> Option<Axis> {
    let pixel = |t: isize| -> Option<bool> {
        let (px, py) = if horizontal {
            (x as isize + t, y as isize)
        } else {
            (x as isize, y as isize + t)
        };
        if px < 0 || py < 0 || px >= w as isize || py >= h as isize {
            return None;
        }
        Some(binary[py as usize * w + px as usize] == 1)
    };
    if !pixel(0)? {
        return None;
    }
    let mut neg = 0isize;
    while pixel(-neg - 1)? {
        neg += 1;
    }
    let mut pos = 0isize;
    while pixel(pos + 1)? {
        pos += 1;
    }
    let centre = (neg + pos + 1) as usize;
    let mid = (pos - neg) as f64 / 2.0;
    // Runs are measured up to a cap: a run that reaches it is too long for
    // any pattern here, and the caller's length check rejects it. Measuring
    // stops there so a dark area next to a pattern can't stall the scan.
    let limit = centre * 2 + 4;
    let mut outer = [0usize; 4];
    let mut t = -neg - 1;
    for (slot, light) in [(0usize, true), (1, false)] {
        while outer[slot] < limit && pixel(t)? != light {
            outer[slot] += 1;
            t -= 1;
        }
    }
    let mut t = pos + 1;
    for (slot, light) in [(2usize, true), (3, false)] {
        while outer[slot] < limit && pixel(t)? != light {
            outer[slot] += 1;
            t += 1;
        }
    }
    Some(Axis { mid, centre, outer })
}

/// Confirms a centre-plus-four-outer run pattern with `centre_units` units in
/// the centre and one unit in each outer run. Returns the unit size.
fn unit_of(axis: &Axis, centre_units: usize) -> Option<f64> {
    let total = axis.centre + axis.outer.iter().sum::<usize>();
    let unit = total as f64 / (centre_units + 4) as f64;
    if unit < 1.0 {
        return None;
    }
    let tolerance = 0.5 * unit;
    let expected = [centre_units as f64 * unit, unit, unit, unit, unit];
    let measured = [
        axis.centre as f64,
        axis.outer[0] as f64,
        axis.outer[1] as f64,
        axis.outer[2] as f64,
        axis.outer[3] as f64,
    ];
    let ok = expected
        .iter()
        .zip(&measured)
        .all(|(e, m)| (e - m).abs() <= tolerance);
    ok.then_some(unit)
}

fn find_finders(binary: &[u8], w: usize, h: usize) -> Vec<Finder> {
    let mut found: Vec<Finder> = Vec::new();
    for y in 0..h {
        // Runs along the row: (colour, start, length).
        let mut runs: Vec<(u8, usize, usize)> = Vec::new();
        let mut x = 0;
        while x < w {
            let colour = binary[y * w + x];
            let start = x;
            while x < w && binary[y * w + x] == colour {
                x += 1;
            }
            runs.push((colour, start, x - start));
        }
        for i in 0..runs.len().saturating_sub(4) {
            if !(runs[i].0 == 1
                && runs[i + 1].0 == 0
                && runs[i + 2].0 == 1
                && runs[i + 3].0 == 0
                && runs[i + 4].0 == 1)
            {
                continue;
            }
            let lengths: Vec<usize> = (0..5).map(|k| runs[i + k].2).collect();
            let total: usize = lengths.iter().sum();
            if total < 7 {
                continue;
            }
            let unit = total as f64 / 7.0;
            let fits = [1.0, 1.0, 3.0, 1.0, 1.0]
                .iter()
                .zip(&lengths)
                .all(|(k, &len)| (len as f64 - k * unit).abs() <= 0.5 * unit);
            if !fits {
                continue;
            }
            let centre_run = runs[i + 2];
            let cx = centre_run.1 as f64 + centre_run.2 as f64 / 2.0;
            // Confirm vertically through the centre column.
            let column = cx.round() as usize;
            let Some(vertical) = scan_axis(binary, w, h, column, y, false) else {
                continue;
            };
            let Some(vertical_unit) = unit_of(&vertical, 3) else {
                continue;
            };
            let cy = y as f64 + vertical.mid;
            let candidate_unit = (unit + vertical_unit) / 2.0;
            merge(&mut found, cx, cy, candidate_unit);
        }
    }
    found
}

/// Adds a detection, or folds it into a nearby one: a finder is seen on many
/// rows, and each row's measurement is averaged in.
fn merge(found: &mut Vec<Finder>, x: f64, y: f64, unit: f64) {
    for finder in found.iter_mut() {
        let reach = 1.5 * finder.unit.max(unit);
        if (finder.x - x).hypot(finder.y - y) < reach {
            let n = finder.hits as f64;
            finder.x = (finder.x * n + x) / (n + 1.0);
            finder.y = (finder.y * n + y) / (n + 1.0);
            finder.unit = (finder.unit * n + unit) / (n + 1.0);
            finder.hits += 1;
            return;
        }
    }
    found.push(Finder {
        x,
        y,
        unit,
        hits: 1,
    });
}

/// The three finders as (top-left, top-right, bottom-left).
#[derive(Clone, Copy)]
struct Triangle {
    top_left: Finder,
    top_right: Finder,
    bottom_left: Finder,
}

/// The triple of finders to read. A real symbol's finders are seen on many
/// rows, while stray matches in the data are seen on few, so the strongest
/// triple that forms a plausible triangle wins; its shape only breaks ties.
/// Perspective bends the triangle a lot, so the shape test is loose.
fn pick_triangle(finders: &[Finder]) -> Option<Triangle> {
    let mut candidates = finders.to_vec();
    candidates.sort_by_key(|f| std::cmp::Reverse(f.hits));
    candidates.truncate(8);
    let mut best: Option<((u32, f64), Triangle)> = None;
    for a in 0..candidates.len() {
        for b in a + 1..candidates.len() {
            for c in b + 1..candidates.len() {
                let trio = [candidates[a], candidates[b], candidates[c]];
                let weakest = trio.iter().map(|f| f.hits).min().unwrap_or(0);
                if let Some((shape, triangle)) = score_triangle(trio) {
                    // Higher weakest-hit count first, then the better shape.
                    let key = (weakest, -shape);
                    let better = best.as_ref().is_none_or(|(current, _)| {
                        key.0 > current.0 || (key.0 == current.0 && key.1 > current.1)
                    });
                    if better {
                        best = Some((key, triangle));
                    }
                }
            }
        }
    }
    best.map(|(_, triangle)| triangle)
}

/// A right triangle of similar-sized finders; lower error is better.
fn score_triangle(trio: [Finder; 3]) -> Option<(f64, Triangle)> {
    let dist = |p: Finder, q: Finder| (p.x - q.x).hypot(p.y - q.y);
    let units = [trio[0].unit, trio[1].unit, trio[2].unit];
    let (umin, umax) = (
        units.iter().cloned().fold(f64::MAX, f64::min),
        units.iter().cloned().fold(0.0, f64::max),
    );
    if umax / umin > 1.6 {
        return None;
    }
    // The right angle sits at the vertex opposite the longest side.
    let sides = [
        (dist(trio[1], trio[2]), 0usize),
        (dist(trio[0], trio[2]), 1),
        (dist(trio[0], trio[1]), 2),
    ];
    let (hyp, right) = sides
        .iter()
        .cloned()
        .fold((0.0, 0), |acc, s| if s.0 > acc.0 { s } else { acc });
    let legs: Vec<usize> = (0..3).filter(|&k| k != right).collect();
    let (l1, l2) = (
        dist(trio[legs[0]], trio[right]),
        dist(trio[legs[1]], trio[right]),
    );
    let (lo, hi) = (l1.min(l2), l1.max(l2));
    if lo <= 0.0 {
        return None;
    }
    let leg_error = (hi - lo) / hi;
    let hyp_error = (hyp * hyp - (l1 * l1 + l2 * l2)).abs() / (hyp * hyp);
    if leg_error > 0.35 || hyp_error > 0.35 || hi / lo > 1.6 {
        return None;
    }
    let corner = trio[right];
    let (mut tr, mut bl) = (trio[legs[0]], trio[legs[1]]);
    // Orientation: from the corner, top-right lies to the right and
    // bottom-left below; a mirrored triple has the cross product negative.
    let cross = (tr.x - corner.x) * (bl.y - corner.y) - (tr.y - corner.y) * (bl.x - corner.x);
    if cross < 0.0 {
        std::mem::swap(&mut tr, &mut bl);
    }
    Some((
        leg_error + hyp_error,
        Triangle {
            top_left: corner,
            top_right: tr,
            bottom_left: bl,
        },
    ))
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

struct Geometry {
    version: usize,
    dim: usize,
    top_left: (f64, f64),
    top_right: (f64, f64),
    bottom_left: (f64, f64),
    /// The fourth correspondence: alignment centre if found, else affine
    /// extrapolation.
    bottom_right: (f64, f64),
}

impl Geometry {
    fn from_triangle(t: &Triangle, binary: &[u8], w: usize, h: usize) -> Result<Geometry, QrError> {
        let leg = |a: Finder, b: Finder| (a.x - b.x).hypot(a.y - b.y);
        let unit = (t.top_left.unit + t.top_right.unit + t.bottom_left.unit) / 3.0;
        let modules = (leg(t.top_left, t.top_right) + leg(t.top_left, t.bottom_left)) / 2.0 / unit;
        // Centre-to-centre distance is dim - 7 modules. Sizes step by four, so
        // the estimate snaps to the nearest valid version; a module count off
        // by one at high versions is common and harmless.
        let estimate = modules + 7.0;
        let version = ((estimate - 17.0) / 4.0).round() as i64;
        if !(1..=10).contains(&version) {
            return Err(QrError::Unsupported);
        }
        let dim = 17 + 4 * version;
        let tl = (t.top_left.x, t.top_left.y);
        let tr = (t.top_right.x, t.top_right.y);
        let bl = (t.bottom_left.x, t.bottom_left.y);
        // Where the bottom-right alignment centre (module dim-6.5) falls if the
        // symbol is an affine image of the finder triangle. Its centre is
        // (dim-6.5)-3.5 = dim-10 modules along an axis that is dim-7 long.
        let span = (dim - 7) as f64;
        let fraction = (dim as f64 - 10.0) / span;
        let expected = (
            tl.0 + fraction * (tr.0 - tl.0) + fraction * (bl.0 - tl.0),
            tl.1 + fraction * (tr.1 - tl.1) + fraction * (bl.1 - tl.1),
        );
        let mut geometry = Geometry {
            version: version as usize,
            dim: dim as usize,
            top_left: tl,
            top_right: tr,
            bottom_left: bl,
            bottom_right: expected,
        };
        // Versions 2 and up have an alignment pattern there: prefer its
        // measured centre to the extrapolation.
        if geometry.version >= 2 {
            if let Some(found) = find_alignment(binary, w, h, expected, unit) {
                geometry.bottom_right = found;
            }
        }
        // Perspective makes the fourth point hard to predict (version 1 has no
        // alignment pattern at all). Fit it to the timing patterns, which
        // alternate along the top and left edges at known module positions.
        geometry.bottom_right = refine_bottom_right(binary, w, h, &geometry);
        Ok(geometry)
    }

    /// Homography from module coordinates to frame pixels.
    fn transform(&self) -> Result<[f64; 8], QrError> {
        let d = self.dim as f64;
        let pairs = [
            ((3.5, 3.5), self.top_left),
            ((d - 3.5, 3.5), self.top_right),
            ((3.5, d - 3.5), self.bottom_left),
            ((d - 6.5, d - 6.5), self.bottom_right),
        ];
        solve_homography(pairs).ok_or(QrError::NotFound)
    }
}

/// Mismatching modules between the frame and an alignment pattern centred at
/// `(cx, cy)` (frame pixels) with `unit` pixels per module. The whole 5×5
/// template is checked, so the light ring and the dark outer ring are
/// both tested. Neighbouring data can't fake a full match.
fn alignment_mismatches(binary: &[u8], w: usize, h: usize, cx: f64, cy: f64, unit: f64) -> usize {
    let mut mismatches = 0;
    for dy in -2isize..=2 {
        for dx in -2isize..=2 {
            let want = u8::from(dx.abs().max(dy.abs()) != 1);
            let x = (cx + dx as f64 * unit).floor();
            let y = (cy + dy as f64 * unit).floor();
            let got = if x >= 0.0 && y >= 0.0 && (x as usize) < w && (y as usize) < h {
                binary[y as usize * w + x as usize]
            } else {
                0
            };
            mismatches += usize::from(got != want);
        }
    }
    mismatches
}

/// Moves the fourth correspondence within about a module of its estimate to
/// the position where the timing patterns agree best with their known
/// alternation. Two passes, coarse then fine.
fn refine_bottom_right(binary: &[u8], w: usize, h: usize, geometry: &Geometry) -> (f64, f64) {
    let start = geometry.bottom_right;
    let mut best = (timing_agreement(binary, w, h, geometry, start), start);
    let module_pixels = (geometry.top_left.0 - geometry.top_right.0)
        .hypot(geometry.top_left.1 - geometry.top_right.1)
        / (geometry.dim - 7) as f64;
    for step in [0.25, 0.05] {
        let centre = best.1;
        for dy in -6..=6 {
            for dx in -6..=6 {
                let candidate = (
                    centre.0 + f64::from(dx) * step * module_pixels,
                    centre.1 + f64::from(dy) * step * module_pixels,
                );
                let score = timing_agreement(binary, w, h, geometry, candidate);
                if score > best.0 {
                    best = (score, candidate);
                }
            }
        }
    }
    best.1
}

/// How many timing modules agree with the expected alternation under the
/// homography implied by `bottom_right`.
fn timing_agreement(
    binary: &[u8],
    w: usize,
    h: usize,
    geometry: &Geometry,
    bottom_right: (f64, f64),
) -> usize {
    let d = geometry.dim as f64;
    let pairs = [
        ((3.5, 3.5), geometry.top_left),
        ((d - 3.5, 3.5), geometry.top_right),
        ((3.5, d - 3.5), geometry.bottom_left),
        ((d - 6.5, d - 6.5), bottom_right),
    ];
    let Some(transform) = solve_homography(pairs) else {
        return 0;
    };
    let mut agreed = 0;
    for i in 8..geometry.dim - 8 {
        let want = u8::from(i % 2 == 0);
        for (mx, my) in [(i as f64 + 0.5, 6.5), (6.5, i as f64 + 0.5)] {
            let (px, py) = project(&transform, mx, my);
            let (x, y) = (px.floor(), py.floor());
            if x >= 0.0
                && y >= 0.0
                && (x as usize) < w
                && (y as usize) < h
                && binary[y as usize * w + x as usize] == want
            {
                agreed += 1;
            }
        }
    }
    agreed
}

/// Finds the alignment pattern near `expected`. A candidate needs a dark
/// centre whose light ring is one unit wide on both axes; its own centre run
/// gives the local module size, which perspective makes different from the
/// finders' average. The full 5×5 template must then match, and the nearest
/// good candidate to `expected` wins.
fn find_alignment(
    binary: &[u8],
    w: usize,
    h: usize,
    expected: (f64, f64),
    unit: f64,
) -> Option<(f64, f64)> {
    // The affine estimate can be several modules off under strong perspective.
    let radius = (12.0 * unit).ceil() as isize;
    let (cx, cy) = (expected.0.round() as isize, expected.1.round() as isize);
    let mut best: Option<(f64, (f64, f64))> = None;
    for y in (cy - radius).max(0)..=(cy + radius).min(h as isize - 1) {
        for x in (cx - radius).max(0)..=(cx + radius).min(w as isize - 1) {
            let (ux, uy) = (x as usize, y as usize);
            if binary[uy * w + ux] != 1 {
                continue;
            }
            let Some(horizontal) = scan_axis(binary, w, h, ux, uy, true) else {
                continue;
            };
            let Some(local_h) = alignment_unit(&horizontal) else {
                continue;
            };
            let Some(vertical) = scan_axis(binary, w, h, ux, uy, false) else {
                continue;
            };
            let Some(local_v) = alignment_unit(&vertical) else {
                continue;
            };
            if (local_h - local_v).abs() > 0.5 * unit {
                continue;
            }
            let local = (local_h + local_v) / 2.0;
            let centre = (x as f64 + horizontal.mid, y as f64 + vertical.mid);
            let mismatches = alignment_mismatches(binary, w, h, centre.0, centre.1, local);
            if mismatches > 3 {
                continue;
            }
            let distance = (centre.0 - expected.0).hypot(centre.1 - expected.1);
            let cost = mismatches as f64 + distance / (12.0 * unit);
            if best.is_none_or(|(c, _)| cost < c) {
                best = Some((cost, centre));
            }
        }
    }
    best.map(|(_, centre)| centre)
}

/// An alignment pattern's centre run is one unit wide and its light ring is
/// one unit wide. The dark outer run is only checked for a minimum width.
fn alignment_unit(axis: &Axis) -> Option<f64> {
    let unit = axis.centre as f64;
    if unit < 1.0 {
        return None;
    }
    let tolerance = 0.5 * unit;
    let light_ok = [axis.outer[0], axis.outer[2]]
        .iter()
        .all(|&run| (run as f64 - unit).abs() <= tolerance);
    let dark_ok = [axis.outer[1], axis.outer[3]]
        .iter()
        .all(|&run| run as f64 >= tolerance);
    (light_ok && dark_ok).then_some(unit)
}

/// Solves the eight-unknown homography mapping four module points to pixels.
pub(crate) fn solve_homography(pairs: [((f64, f64), (f64, f64)); 4]) -> Option<[f64; 8]> {
    // Rows of the linear system A·h = b, h = [a b c d e f g h] with i = 1.
    let mut a = [[0f64; 9]; 8];
    for (k, ((mx, my), (ix, iy))) in pairs.iter().enumerate() {
        a[2 * k] = [*mx, *my, 1.0, 0.0, 0.0, 0.0, -mx * ix, -my * ix, *ix];
        a[2 * k + 1] = [0.0, 0.0, 0.0, *mx, *my, 1.0, -mx * iy, -my * iy, *iy];
    }
    // Gaussian elimination with partial pivoting.
    for col in 0..8 {
        let pivot = (col..8).max_by(|&p, &q| a[p][col].abs().total_cmp(&a[q][col].abs()))?;
        if a[pivot][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, pivot);
        let pivot_row = a[col];
        for (row, row_cells) in a.iter_mut().enumerate() {
            if row != col {
                let factor = row_cells[col] / pivot_row[col];
                for (cell, &p) in row_cells[col..].iter_mut().zip(&pivot_row[col..]) {
                    *cell -= factor * p;
                }
            }
        }
    }
    let mut solution = [0f64; 8];
    for i in 0..8 {
        solution[i] = a[i][8] / a[i][i];
    }
    Some(solution)
}

/// Maps a module-space point through the homography to a pixel.
pub(crate) fn project(h: &[f64; 8], mx: f64, my: f64) -> (f64, f64) {
    let denominator = h[6] * mx + h[7] * my + 1.0;
    (
        (h[0] * mx + h[1] * my + h[2]) / denominator,
        (h[3] * mx + h[4] * my + h[5]) / denominator,
    )
}

/// Samples the module grid at module centres.
fn sample(binary: &[u8], w: usize, h: usize, transform: &[f64; 8], dim: usize) -> Vec<u8> {
    let mut modules = vec![0u8; dim * dim];
    for my in 0..dim {
        for mx in 0..dim {
            let (px, py) = project(transform, mx as f64 + 0.5, my as f64 + 0.5);
            let (x, y) = (px.round(), py.round());
            if x >= 0.0 && y >= 0.0 && (x as usize) < w && (y as usize) < h {
                modules[my * dim + mx] = binary[y as usize * w + x as usize];
            }
        }
    }
    modules
}

// ---------------------------------------------------------------------------
// Format, data and correction
// ---------------------------------------------------------------------------

/// Reads the two format copies and returns the mask of the closest valid word.
fn read_format(dark: &[u8], dim: usize) -> Result<(u8, u32), QrError> {
    let mut first = 0u32;
    let mut second = 0u32;
    let mut seen = [false; 15];
    for (x, y, bit) in layout::format_modules(dim) {
        let value = u32::from(dark[y * dim + x]);
        let target = if seen[bit as usize] {
            &mut second
        } else {
            &mut first
        };
        *target |= value << bit;
        seen[bit as usize] = true;
    }
    let valid = layout::all_format_words();
    let mut best: Option<(u32, u8, u32)> = None;
    for word in [first, second] {
        for (mask, &candidate) in valid.iter().enumerate() {
            let distance = (word ^ candidate).count_ones();
            if best.is_none_or(|(d, _, _)| distance < d) {
                best = Some((distance, mask as u8, word));
            }
        }
    }
    match best {
        Some((distance, mask, word)) if distance <= 3 => Ok((mask, word)),
        _ => Err(QrError::Unsupported),
    }
}

/// Reads the codeword bytes in placement order, undoing the mask.
fn read_codewords(dark: &[u8], grid: &Grid, version: usize, mask: u8) -> Vec<u8> {
    let size = grid.size;
    let order = grid.data_order();
    let total = tables::DATA_CODEWORDS[version - 1]
        + tables::EC_PER_BLOCK[version - 1] * tables::block_data_lengths(version).len();
    let mut bytes = vec![0u8; total];
    for (position, &index) in order.iter().enumerate().take(total * 8) {
        let (row, column) = (index / size, index % size);
        let bit = dark[index] ^ u8::from(layout::mask_applies(mask, row, column));
        bytes[position / 8] |= bit << (7 - position % 8);
    }
    bytes
}

/// De-interleaves the blocks, corrects each one, and returns the data bytes.
fn correct_blocks(codewords: &[u8], version: usize) -> Result<Vec<u8>, QrError> {
    let lengths = tables::block_data_lengths(version);
    let ec = tables::EC_PER_BLOCK[version - 1];
    let mut blocks: Vec<Vec<u8>> = lengths.iter().map(|&d| vec![0u8; d + ec]).collect();
    let longest = lengths.iter().copied().max().unwrap_or(0);
    let mut k = 0;
    for i in 0..longest {
        for (block, &d) in blocks.iter_mut().zip(&lengths) {
            if i < d {
                block[i] = codewords[k];
                k += 1;
            }
        }
    }
    for i in 0..ec {
        for (b, &d) in lengths.iter().enumerate() {
            blocks[b][d + i] = codewords[k];
            k += 1;
        }
    }
    let mut data = Vec::with_capacity(tables::DATA_CODEWORDS[version - 1]);
    for (block, &d) in blocks.iter_mut().zip(&lengths) {
        rs::correct(block, ec).ok_or(QrError::Uncorrectable)?;
        data.extend_from_slice(&block[..d]);
    }
    Ok(data)
}

/// Parses a byte-mode segment: mode, count, payload.
fn parse_byte_mode(data: &[u8], version: usize) -> Result<Vec<u8>, QrError> {
    let mut reader = BitReader {
        bytes: data,
        position: 0,
    };
    if reader.read(4)? != 0b0100 {
        return Err(QrError::Unsupported);
    }
    let count = reader.read(tables::count_bits(version))? as usize;
    let mut payload = Vec::with_capacity(count);
    for _ in 0..count {
        payload.push(reader.read(8)? as u8);
    }
    // Anything but a terminator (or padding) after the payload is another
    // segment in a different mode. Kin reads one byte segment only, so refuse
    // rather than return a truncated payload.
    if reader.remaining_nonzero_mode() {
        return Err(QrError::Unsupported);
    }
    Ok(payload)
}

struct BitReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl BitReader<'_> {
    /// True when the next four bits name a mode: a terminator is 0000.
    fn remaining_nonzero_mode(&self) -> bool {
        let mut probe = BitReader {
            bytes: self.bytes,
            position: self.position,
        };
        probe.read(4).map(|mode| mode != 0).unwrap_or(false)
    }
}

impl BitReader<'_> {
    fn read(&mut self, width: usize) -> Result<u32, QrError> {
        if self.position + width > self.bytes.len() * 8 {
            return Err(QrError::Malformed);
        }
        let mut value = 0u32;
        for _ in 0..width {
            let bit = (self.bytes[self.position / 8] >> (7 - self.position % 8)) & 1;
            value = (value << 1) | u32::from(bit);
            self.position += 1;
        }
        Ok(value)
    }
}
