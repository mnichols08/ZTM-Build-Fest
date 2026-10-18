// Chat content blobs (#110): storing encrypted message content by hash,
// who may retire it, tombstones, quotas, durability and the HTTP routes.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatBlobService, MAX_RETIRE_REFS } from "./chat-blob-service.mjs";
import { DurableStore, MAX_CHAT_BLOB_BYTES, MAX_HOUSEHOLD_CHAT_BLOB_BYTES, MIN_CHAT_BLOB_BYTES } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";
import { SERVER_SCHEMA_VERSION, sqlitePragma } from "./durable-store/shared.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });

/** A sealed blob as a device makes it: version 1, nonce, ciphertext and tag. */
function blob(size = 64) {
  const bytes = randomBytes(size);
  bytes[0] = 1;
  return { bytes, ref: createHash("sha256").update(bytes).digest("hex") };
}

/** One household: the founding admin (two devices), and a second Adult. */
function household({ store = null, pairing = new PairingService({ store, now: () => clock.now }) } = {}) {
  const service = new ChatBlobService({ pairingService: pairing, store, now: () => clock.now });
  const admin = pairing.bootstrap({ credential: credential(`admin-${randomBytes(4).toString("hex")}`) });
  const add = (create, id) => {
    clock.now += 60_001;
    const invitation = create();
    const claim = pairing.claimPairing({ code: invitation.code, credential: credential(id), deviceLabel: "Edge on Windows" });
    pairing.approvePairing(admin.sessionToken, invitation.pairingId, claim.version);
    return pairing.activateClaim(claim.claimToken);
  };
  const adminLaptop = add(() => pairing.createDevicePairing(admin.sessionToken), `admin-laptop-${randomBytes(4).toString("hex")}`);
  const partner = add(() => pairing.createPairing(admin.sessionToken), `partner-${randomBytes(4).toString("hex")}`);
  const auth = (who) => pairing.authorize(who.sessionToken);
  return { pairing, service, admin, adminLaptop, partner, auth };
}
const clock = { now: 1_800_000_000_000 };

const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

test("a blob is stored once, by the hash of its bytes, and read back", () => {
  const h = household();
  const content = blob();
  assert.deepEqual(h.service.put(h.auth(h.partner), content.ref, content.bytes), { accepted: true, size: 64 });
  assert.deepEqual(h.service.put(h.auth(h.admin), content.ref, content.bytes), { accepted: false, size: 64 }, "the same bytes again");
  assert.deepEqual(h.service.get(h.auth(h.admin), content.ref), content.bytes);
  const tampered = Buffer.from(content.bytes);
  tampered[10] ^= 1;
  for (const [ref, bytes] of [
    [content.ref, tampered],
    [content.ref.toUpperCase(), content.bytes],
    ["ab".repeat(31), content.bytes],
    [blob(MIN_CHAT_BLOB_BYTES - 1).ref, blob(MIN_CHAT_BLOB_BYTES - 1).bytes],
  ])
    assert.throws(() => h.service.put(h.auth(h.partner), ref, bytes), rejects("chat_blob_invalid", 400));
  const short = blob(MIN_CHAT_BLOB_BYTES - 1);
  assert.throws(() => h.service.put(h.auth(h.partner), short.ref, short.bytes), rejects("chat_blob_invalid", 400));
  const large = blob(MAX_CHAT_BLOB_BYTES + 1);
  assert.throws(() => h.service.put(h.auth(h.partner), large.ref, large.bytes), rejects("chat_blob_invalid", 400));
  assert.throws(() => h.service.get(h.auth(h.partner), blob().ref), rejects("chat_blob_missing", 404));
});

test("another household can't read, overwrite or retire a blob", () => {
  const pairing = new PairingService({ now: () => clock.now });
  const ours = household({ pairing });
  const theirs = household({ pairing });
  const content = blob();
  ours.service.put(ours.auth(ours.partner), content.ref, content.bytes);
  assert.throws(() => theirs.service.get(theirs.auth(theirs.admin), content.ref), rejects("chat_blob_missing", 404));
  // The service of the second household is a separate instance here; blobs
  // are keyed by household, so share one service to prove it.
  const shared = new ChatBlobService({ pairingService: pairing, now: () => clock.now });
  shared.put(ours.auth(ours.partner), content.ref, content.bytes);
  assert.throws(() => shared.get(theirs.auth(theirs.partner), content.ref), rejects("chat_blob_missing", 404));
  assert.deepEqual(shared.retire(theirs.auth(theirs.admin), [content.ref]), { retired: 0 }, "an unknown blob there");
  assert.deepEqual(shared.get(ours.auth(ours.admin), content.ref), content.bytes, "ours is untouched");
  // Their copy of the same bytes is theirs alone.
  assert.equal(shared.put(theirs.auth(theirs.partner), content.ref, content.bytes).accepted, true);
});

test("the uploader retires from any of their devices, an admin retires anyone's, nobody else", () => {
  const h = household();
  const own = blob(), partners = blob(), another = blob();
  h.service.put(h.auth(h.admin), own.ref, own.bytes);
  h.service.put(h.auth(h.partner), partners.ref, partners.bytes);
  h.service.put(h.auth(h.partner), another.ref, another.bytes);
  // The partner is not an admin: all or nothing, so their own blob stays too.
  assert.throws(() => h.service.retire(h.auth(h.partner), [another.ref, own.ref]), rejects("chat_blob_retire_forbidden", 403));
  assert.deepEqual(h.service.get(h.auth(h.partner), another.ref), another.bytes);
  assert.deepEqual(h.service.retire(h.auth(h.partner), [another.ref]), { retired: 1 });
  // The admin posted from the phone and deletes from the laptop.
  assert.deepEqual(h.service.retire(h.auth(h.adminLaptop), [own.ref]), { retired: 1 });
  const before = h.pairing.events.filter((event) => event.type === "chat_content_removed_by_admin").length;
  assert.deepEqual(h.service.retire(h.auth(h.admin), [partners.ref, own.ref, blob().ref]), { retired: 1 }, "unknown and retired refs are skipped");
  const audits = h.pairing.events.filter((event) => event.type === "chat_content_removed_by_admin");
  assert.equal(audits.length, before + 1);
  assert.deepEqual(Object.keys(audits.at(-1)).sort(), ["at", "count", "deviceId", "householdId", "memberId", "persisted", "type"]);
  for (const refs of [[], ["zz"], Array(MAX_RETIRE_REFS + 1).fill(0).map(() => blob().ref), [own.ref, own.ref], "nope"])
    assert.throws(() => h.service.retire(h.auth(h.admin), refs), rejects("chat_blob_invalid", 400));
});

test("a retired blob is gone for good: reads and uploads say it was deleted", () => {
  const h = household();
  const content = blob();
  h.service.put(h.auth(h.partner), content.ref, content.bytes);
  h.service.retire(h.auth(h.partner), [content.ref]);
  assert.throws(() => h.service.get(h.auth(h.admin), content.ref), rejects("chat_blob_deleted", 410));
  assert.throws(() => h.service.put(h.auth(h.partner), content.ref, content.bytes), rejects("chat_blob_deleted", 410));
  assert.deepEqual(h.service.retire(h.auth(h.partner), [content.ref]), { retired: 0 });
});

test("a full household's uploads are refused until content is retired", () => {
  const h = household();
  const content = blob(1024);
  const usage = h.service.storage.chatBlobUsage.bind(h.service.storage);
  h.service.storage.chatBlobUsage = (householdId) => ({ ...usage(householdId), bytes: MAX_HOUSEHOLD_CHAT_BLOB_BYTES - 1023 });
  assert.throws(() => h.service.put(h.auth(h.partner), content.ref, content.bytes), rejects("chat_storage_full", 409));
  h.service.storage.chatBlobUsage = usage;
  assert.equal(h.service.put(h.auth(h.partner), content.ref, content.bytes).accepted, true);
});

test("members who can't take part can't use chat blobs", () => {
  const h = household();
  const content = blob();
  const auth = h.auth(h.partner);
  const removed = { ...auth, member: { ...auth.member, active: false } };
  for (const call of [() => h.service.put(removed, content.ref, content.bytes), () => h.service.get(removed, content.ref), () => h.service.retire(removed, [content.ref])])
    assert.throws(call, rejects("chat_unavailable", 403));
});

test("blobs and tombstones persist, and household deletion purges them", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kin-chat-blobs-"));
  let store;
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  store = new DurableStore(join(directory, "kin.sqlite"));
  assert.equal(SERVER_SCHEMA_VERSION, 12);
  assert.equal(sqlitePragma(store.db, "user_version", { simple: true }), 12);
  const h = household({ store });
  const kept = blob(), gone = blob();
  h.service.put(h.auth(h.partner), kept.ref, kept.bytes);
  h.service.put(h.auth(h.partner), gone.ref, gone.bytes);
  h.service.retire(h.auth(h.partner), [gone.ref]);
  // Sessions are process-local; the authorization taken before the restart
  // stands in for a fresh one.
  const auth = h.auth(h.admin);
  store.close();
  store = new DurableStore(join(directory, "kin.sqlite"));
  const reopened = new ChatBlobService({ pairingService: new PairingService({ store, now: () => clock.now }), store, now: () => clock.now });
  assert.deepEqual(reopened.get(auth, kept.ref), kept.bytes);
  assert.throws(() => reopened.get(auth, gone.ref), rejects("chat_blob_deleted", 410));
  assert.deepEqual(store.chatBlobUsage(h.admin.householdId), { rows: 2, bytes: 64 });
  // The bytes of a retired blob are really dropped, not just hidden.
  assert.equal(store.db.prepare("SELECT ciphertext FROM chat_blobs WHERE blob_ref = ?").get(gone.ref).ciphertext, null);
  assert.equal(store.householdPurgeStatus(h.admin.householdId).counts.chatBlobs, 2);
  store.forcePurgeHousehold(h.admin.householdId, clock.now);
  assert.equal(store.householdPurgeStatus(h.admin.householdId).counts.chatBlobs, 0);
  assert.equal(store.getChatBlob(h.admin.householdId, kept.ref), null);
  assert.equal(store.validate(), true);
});

test("the chat blob routes need a trusted session and move raw bytes", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const content = blob(200);
  assert.equal((await fetch(`${url}/api/chat/blobs/${content.ref}`)).status, 401);
  const adult = app.service.bootstrap({ credential: credential("adult") });
  const cookie = `kin_session=${adult.sessionToken}; kin_device=${adult.deviceToken}`;
  const put = await fetch(`${url}/api/chat/blobs/${content.ref}`, { method: "PUT", headers: { cookie, "content-type": "application/octet-stream" }, body: content.bytes });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { accepted: true, size: 200 });
  const got = await fetch(`${url}/api/chat/blobs/${content.ref}`, { headers: { cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), content.bytes);
  const wrong = await fetch(`${url}/api/chat/blobs/${blob().ref}`, { method: "PUT", headers: { cookie, "content-type": "application/octet-stream" }, body: content.bytes });
  assert.equal(wrong.status, 400);
  const retire = await fetch(`${url}/api/chat/blobs/retire`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ refs: [content.ref] }) });
  assert.deepEqual(await retire.json(), { retired: 1 });
  const after = await fetch(`${url}/api/chat/blobs/${content.ref}`, { headers: { cookie } });
  assert.equal(after.status, 410);
  assert.equal((await after.json()).error, "chat_blob_deleted");
});
