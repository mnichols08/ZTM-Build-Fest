import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExpiredPortableMembers } from "./archive.js";

test("restore expiry normalization changes only active Temporary members", () => {
  const snapshot = { local_context: [{ portable_membership: [
    { memberId: "11".repeat(16), memberKind: "temporary", status: "active", expiresAt: 100 },
    { memberId: "22".repeat(16), memberKind: "temporary", status: "removed", expiresAt: 100 },
    { memberId: "33".repeat(16), memberKind: "temporary", status: "expired", expiresAt: 100 },
    { memberId: "44".repeat(16), memberKind: "temporary", status: "active", expiresAt: 300 },
  ] }] };

  normalizeExpiredPortableMembers(snapshot, 200);

  assert.deepEqual(snapshot.local_context[0].portable_membership.map((member) => member.status), [
    "expired", "removed", "expired", "active",
  ]);
});
