import assert from "node:assert/strict";
import test from "node:test";
import { captureAttachment, removeAttachment } from "./attachment-lifecycle.js";

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    async getSyncState() { return null; },
    async sealAttachmentData(id, data) { return { id, encryptedFixture: true, size: data.bytes.length }; },
    async openAttachmentData() { throw new Error("not used"); },
    async saveAttachment(row) { rows.set(row.attachment_id, structuredClone(row)); },
    async loadAttachments() { return [...rows.values()]; },
    async updateAttachmentState(id, state) { const row = rows.get(id); if (row) rows.set(id, { ...row, state }); },
    async deleteAttachment(id) { rows.delete(id); },
  };
}

test("offline capture protects locally before committing the canonical binding", async () => {
  const store = fakeStore();
  const calls = [];
  const saved = await captureAttachment({
    file: new File([new Uint8Array([1, 2, 3])], "receipt.pdf", { type: "application/pdf" }),
    parentKind: "item", parentId: "11".repeat(16), identity: { householdId: "22".repeat(16) }, store,
    append: async (command) => { calls.push(command); assert.equal((await store.loadAttachments()).length, 1); },
  });
  assert.equal(saved.state, "queued");
  assert.equal(calls[0].type, "bind-attachment");
  assert.equal(store.rows.get(saved.attachmentId).ciphertext, null);
  assert.equal(store.rows.get(saved.attachmentId).state, "queued");
});

test("a failed canonical append leaves protected bytes for orphan reconciliation", async () => {
  const store = fakeStore();
  await assert.rejects(captureAttachment({
    file: new File([new Uint8Array([4])], "scan.png", { type: "image/png" }),
    parentKind: "item", parentId: "33".repeat(16), identity: { householdId: "44".repeat(16) }, store,
    append: async () => { throw new Error("offline"); },
  }), /offline/);
  assert.equal((await store.loadAttachments()).length, 1);
  assert.ok((await store.loadAttachments())[0].localSealed);
});

test("removal commits canonical history before marking local data for remote cleanup", async () => {
  const store = fakeStore();
  await store.saveAttachment({ attachment_id: "55".repeat(16), ciphertext: new Uint8Array([1]), localSealed: null, keyEpoch: 1, digest: "66".repeat(32), state: "synced" });
  let stateSeenDuringAppend;
  await removeAttachment({ attachmentId: "55".repeat(16), store, append: async () => { stateSeenDuringAppend = (await store.loadAttachments())[0].state; } });
  assert.equal(stateSeenDuringAppend, "synced");
  assert.equal((await store.loadAttachments())[0].state, "removed");
});
