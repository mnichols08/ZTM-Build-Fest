import test from "node:test";
import assert from "node:assert/strict";
import { backgroundFileProblem, dominantColorFromPixels } from "./image.js";

test("background validation rejects unsupported, empty, and oversized input", () => {
  assert.match(backgroundFileProblem({ size: 1, type: "image/svg+xml" }), /JPEG/);
  assert.match(backgroundFileProblem({ size: 0, type: "image/png" }), /non-empty/);
  assert.match(backgroundFileProblem({ size: 13 * 1024 * 1024, type: "image/jpeg" }), /12 MiB/);
  assert.equal(backgroundFileProblem({ size: 20, type: "image/webp" }), null);
});

test("dominant extraction ignores transparency, quantizes, and breaks ties stably", () => {
  const pixels = new Uint8ClampedArray([
    250, 10, 10, 255, 245, 12, 8, 255, 4, 4, 250, 255, 255, 255, 255, 0,
  ]);
  assert.equal(dominantColorFromPixels(pixels), "#F80B09");
  assert.equal(dominantColorFromPixels(new Uint8ClampedArray([0, 0, 0, 0])), null);
  assert.equal(dominantColorFromPixels(new Uint8ClampedArray([1, 1, 241, 255, 241, 1, 1, 255])), "#0101F1");
});
