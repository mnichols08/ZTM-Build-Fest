import assert from "node:assert/strict";
import test from "node:test";
import { EventStoreError, validatePortableMembership } from "./event-store.js";

const member = (memberId, memberKind, status, expiresAt) => ({
  memberId, memberKind, status,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

test("portable membership accepts authoritative Temporary status across either browser clock skew", () => {
  const expired = member("11".repeat(16), "temporary", "expired", 2_000);
  const active = member("22".repeat(16), "temporary", "active", 2_000);
  const removed = member("33".repeat(16), "temporary", "removed", 3_000);

  // Historical membership snapshots are validated structurally. A browser clock
  // cannot override the server-authored status during export or restore.
  const systemNow = Date.now;
  try {
    Date.now = () => 1_000; // Browser behind server: expiry lies in the future locally.
    validatePortableMembership([expired, active, removed]);
    Date.now = () => 4_000; // Browser ahead: an active server status stays active.
    validatePortableMembership([expired, active, removed]);
  } finally {
    Date.now = systemNow;
  }
  assert.equal(expired.status, "expired");
  assert.equal(active.status, "active");
  assert.equal(removed.status, "removed");
});

test("portable membership rejects contradictory status and expiry structures", () => {
  const invalid = [
    member("11".repeat(16), "adult", "expired"),
    member("22".repeat(16), "limited", "active", 3_000),
    member("33".repeat(16), "temporary", "expired"),
    member("44".repeat(16), "temporary", "active", Number.NaN),
    member("55".repeat(16), "temporary", "unknown", 3_000),
    { ...member("66".repeat(16), "temporary", "removed", 3_000), unexpected: true },
  ];
  for (const snapshot of invalid)
    assert.throws(() => validatePortableMembership([snapshot]), EventStoreError);
});

test("legacy archives without portable membership remain valid", () => {
  validatePortableMembership([]);
  assert.throws(() => validatePortableMembership(null), EventStoreError);
});
