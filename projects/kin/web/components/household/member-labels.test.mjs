import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MEMBER_NAME_CHARS, friendlyDeviceLabel } from "./member-labels.js";

test("a nickname always wins over the derived label (#225)", () => {
  assert.equal(friendlyDeviceLabel({ nickname: "Kitchen phone", automatic: "Chrome on iPhone", preferredName: "Mikey" }), "Kitchen phone");
});

test("the owner's name sits beside the automatic name, without a possessive", () => {
  assert.equal(friendlyDeviceLabel({ automatic: "Chrome on Mac", preferredName: "Mikey" }), "Mikey · Chrome on Mac");
  assert.equal(friendlyDeviceLabel({ automatic: "Chrome on Mac", preferredName: "  Mikey  " }), "Mikey · Chrome on Mac");
  assert.doesNotMatch(friendlyDeviceLabel({ automatic: "Chrome on Mac", preferredName: "Mikey" }), /'s|’s/);
});

test("without a name, or without a known platform, the label falls back", () => {
  assert.equal(friendlyDeviceLabel({ automatic: "Chrome on Mac" }), "Chrome on Mac");
  assert.equal(friendlyDeviceLabel({ automatic: "Chrome on Mac", preferredName: "   " }), "Chrome on Mac");
  // No automatic name yet: callers keep their own "New device" fallback.
  assert.equal(friendlyDeviceLabel({ preferredName: "Mikey" }), null);
  assert.equal(friendlyDeviceLabel(), null);
});

test("member names share Rust's 32-character limit", () => {
  assert.equal(MAX_MEMBER_NAME_CHARS, 32);
});
