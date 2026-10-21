// Renders Kin's PNG icons (#471, #473) from hand-coded geometry, with Node's
// built-ins only: a small rasterizer and a PNG encoder (zlib's deflate plus a
// CRC-32 table). Android ignores SVG-only shortcut icons, and the Play Store
// wrapper needs PNG app icons, so the PNGs are generated here and committed.
//
//   node scripts/render-icons.mjs          writes web/icons/*.png
//   node scripts/render-icons.mjs --check  fails if a committed PNG's pixels
//                                          differ from what this renders
//
// The app icon is web/icon.svg drawn exactly: a 192-unit rounded square
// (radius 40, #8a5b4b) with the "K" polygon (#fff8f1). Shortcut icons use
// the same tile with a single cream glyph each, and no gradients or fine
// detail, so they stay legible when a launcher shrinks or tints them.
//
// Every shape is a pure test `inside(x, y)` in the 192-unit design space.
// Each pixel takes SAMPLES × SAMPLES sub-pixel samples, so edges are
// anti-aliased by coverage. Output is deterministic: the same geometry always
// gives the same pixels (the deflated bytes may differ between zlib builds,
// which is why --check compares pixels, not files).
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DESIGN = 192;
const SAMPLES = 4;
const BROWN = [0x8a, 0x5b, 0x4b];
const CREAM = [0xff, 0xf8, 0xf1];

// ---- PNG encoding --------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC, as PNG uses) of `bytes`. */
export function crc32(bytes, crc = 0xffffffff) {
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An 8-bit RGBA PNG (colour type 6, no interlace) of `rgba`, which holds
 * width × height × 4 bytes, rows top to bottom. Each row uses filter 0. */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new RangeError("encodePng: pixel buffer has the wrong size.");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // compression, filter and interlace methods stay 0.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Reads back a PNG this encoder wrote (8-bit RGBA, filter 0 on every row):
 * `{ width, height, rgba }`. Used by --check and the tests. */
export function decodePng(bytes) {
  if (!SIGNATURE.equals(bytes.subarray(0, 8))) throw new Error("not a PNG");
  let offset = 8, width = 0, height = 0;
  const data = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) throw new Error(`bad CRC in ${type}`);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error("only 8-bit RGBA, non-interlaced PNGs are read");
    } else if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * (stride + 1)] !== 0) throw new Error("only filter 0 is read");
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, rgba };
}

// ---- Shapes (192-unit design space) ---------------------------------------

export const roundRect = (x, y, w, h, r) => (px, py) => {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const dx = Math.max(x + r - px, 0, px - (x + w - r));
  const dy = Math.max(y + r - py, 0, py - (y + h - r));
  return dx * dx + dy * dy <= r * r;
};
export const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
/** Even-odd fill of a closed polygon [[x, y], ...]. */
export const polygon = (points) => (px, py) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
/** A thick line with round ends. */
export const capsule = (x1, y1, x2, y2, r) => (px, py) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return (px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2 <= r * r;
};
export const union = (...shapes) => (px, py) => shapes.some((shape) => shape(px, py));
export const subtract = (shape, ...holes) => (px, py) => shape(px, py) && !holes.some((hole) => hole(px, py));
export const intersect = (...shapes) => (px, py) => shapes.every((shape) => shape(px, py));
const above = (y) => (_px, py) => py <= y;
const scaled = (shape, factor, cx = DESIGN / 2, cy = DESIGN / 2) => (px, py) => shape(cx + (px - cx) / factor, cy + (py - cy) / factor);

// web/icon.svg: <rect width="192" height="192" rx="40"/> and the K path
// "M54 42v108h20v-44l40 44h28l-51-55 48-53h-26l-39 44V42z".
const TILE = roundRect(0, 0, DESIGN, DESIGN, 40);
const K = polygon([[54, 42], [54, 150], [74, 150], [74, 106], [114, 150], [142, 150], [91, 95], [139, 42], [113, 42], [74, 86], [74, 42]]);

const plus = (cx, cy, half, r) => union(capsule(cx - half, cy, cx + half, cy, r), capsule(cx, cy - half, cx, cy + half, r));
// A shopping bag, a little wider at the bottom, with a round handle.
const bag = (cx) => union(
  polygon([[cx - 40, 70], [cx + 40, 70], [cx + 48, 150], [cx - 48, 150]]),
  intersect(subtract(circle(cx, 72, 26), circle(cx, 72, 15)), above(72)),
);

/** Each shortcut's glyph, drawn in cream on the brown tile. */
export const GLYPHS = Object.freeze({
  // The bag with a round "+" badge, set apart by a gap of tile colour.
  "add-shopping": union(
    subtract(bag(84), circle(136, 138, 34)),
    subtract(circle(136, 138, 25), plus(136, 138, 13, 5)),
  ),
  // A ticked box.
  "add-task": union(
    subtract(roundRect(46, 46, 100, 100, 20), roundRect(59, 59, 74, 74, 10)),
    capsule(72, 98, 89, 115, 8),
    capsule(89, 115, 122, 78, 8),
  ),
  // A calendar page: top band, rings, and two rows of days.
  week: union(
    subtract(roundRect(42, 50, 108, 100, 14), roundRect(54, 80, 84, 58, 6)),
    capsule(72, 38, 72, 60, 7),
    capsule(120, 38, 120, 60, 7),
    ...[72, 96, 120].flatMap((x) => [circle(x, 96, 7), circle(x, 122, 7)]),
  ),
  shopping: bag(96),
  // A speech bubble.
  chat: union(roundRect(38, 46, 116, 80, 24), polygon([[62, 116], [56, 152], [100, 120]])),
  // "New journal entry" (#509): a notebook (a spine and two ruled lines cut
  // from its cover) with the round "+" badge, set apart by tile colour.
  "new-journal-entry": union(
    subtract(
      roundRect(42, 36, 92, 120, 14),
      capsule(60, 48, 60, 144, 4),
      capsule(76, 70, 116, 70, 5),
      capsule(76, 92, 106, 92, 5),
      circle(136, 138, 34),
    ),
    subtract(circle(136, 138, 25), plus(136, 138, 13, 5)),
  ),
  // A sun.
  today: union(
    circle(96, 96, 26),
    ...Array.from({ length: 8 }, (_, index) => {
      const angle = (index * Math.PI) / 4;
      const [c, s] = [Math.cos(angle), Math.sin(angle)];
      return capsule(96 + 40 * c, 96 + 40 * s, 96 + 58 * c, 96 + 58 * s, 7);
    }),
  ),
});

// ---- Rasterizing -----------------------------------------------------------

/** Paints `layers` ([{ shape, color: [r, g, b] }], bottom first) into a
 * size × size straight-alpha RGBA buffer. */
export function rasterize(size, layers) {
  const rgba = new Uint8Array(size * size * 4);
  const step = DESIGN / size / SAMPLES;
  const total = SAMPLES * SAMPLES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Composite premultiplied, source-over, layer by layer.
      let r = 0, g = 0, b = 0, a = 0;
      for (const { shape, color } of layers) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          const py = (y * SAMPLES + sy + 0.5) * step;
          for (let sx = 0; sx < SAMPLES; sx++) if (shape((x * SAMPLES + sx + 0.5) * step, py)) hits++;
        }
        if (!hits) continue;
        const coverage = hits / total;
        r = color[0] * coverage + r * (1 - coverage);
        g = color[1] * coverage + g * (1 - coverage);
        b = color[2] * coverage + b * (1 - coverage);
        a = coverage + a * (1 - coverage);
      }
      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
      }
      rgba[offset + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

/** Every icon file (relative to web/) and how to draw it. */
export function iconSpecs() {
  const specs = [
    { file: "icons/icon-192.png", size: 192, layers: [{ shape: TILE, color: BROWN }, { shape: K, color: CREAM }] },
    { file: "icons/icon-512.png", size: 512, layers: [{ shape: TILE, color: BROWN }, { shape: K, color: CREAM }] },
    // Maskable: full bleed, so the launcher's mask decides the corners; the K
    // sits well inside the central safe circle (radius 40% of the icon).
    { file: "icons/icon-maskable-512.png", size: 512, layers: [{ shape: () => true, color: BROWN }, { shape: scaled(K, 0.8), color: CREAM }] },
  ];
  for (const [name, glyph] of Object.entries(GLYPHS))
    for (const size of [96, 192])
      specs.push({ file: `icons/shortcut-${name}-${size}.png`, size, layers: [{ shape: TILE, color: BROWN }, { shape: glyph, color: CREAM }] });
  return specs;
}

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

function main(argv) {
  const check = argv.includes("--check");
  const drifted = [];
  for (const { file, size, layers } of iconSpecs()) {
    const rgba = rasterize(size, layers);
    const path = join(webRoot, file);
    if (check) {
      let committed = null;
      try { committed = decodePng(readFileSync(path)); } catch { /* missing or unreadable: drift */ }
      if (!committed || committed.width !== size || committed.height !== size || !Buffer.from(committed.rgba).equals(Buffer.from(rgba))) drifted.push(file);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodePng(size, size, rgba));
    console.log(`wrote web/${file}`);
  }
  if (drifted.length) {
    console.error(`These icons differ from scripts/render-icons.mjs; run it and commit the result:\n  ${drifted.join("\n  ")}`);
    process.exitCode = 1;
  } else if (check) console.log("Icons match scripts/render-icons.mjs.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
