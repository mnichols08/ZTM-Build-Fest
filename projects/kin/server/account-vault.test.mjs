// Members' encrypted key vaults on the service (ADR 0018, #566): storage,
// compare-and-set, wrappers, bounds, rate limits and who may read them.
// Service tests run against the in-memory and the durable store.
import assert from "node:assert/strict";
import test from "node:test";
import { AccountVaultService, VAULT_DOWNLOADS_PER_ADDRESS, VAULT_DOWNLOADS_PER_MEMBER, VAULT_WINDOW_MS } from "./account-vault-service.mjs";
import { ARGON2ID_PARAMETERS, hashAuthKey, verifyAuthKey } from "./account-password.mjs";
import { DurableStore } from "./durable-store.mjs";
import { PairingError, PairingService } from "./pairing-service.mjs";
import { createKinServer } from "./server.mjs";

const credential = (id) => ({ id, publicKey: `key-${id}`, algorithm: -7 });
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const rejects = (code, status) => (error) => error instanceof PairingError && error.code === code && error.status === status;

/** A sealed vault as the service sees it: "KVLT", format 1, opaque bytes. */
function sealedVault(size = 120, fill = 7) {
  const bytes = Buffer.alloc(size, fill);
  bytes.write("KVLT", 0, "latin1");
  bytes[4] = 1;
  return b64(bytes);
}

function wrapper(overrides = {}) {
  const wrapped = Buffer.alloc(61, 3);
  wrapped[0] = 1;
  return {
    wrapperId: "1".repeat(32), type: "password", version: 1,
    params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: b64(Buffer.alloc(16, 9)) },
    wrapped: b64(wrapped), ...overrides,
  };
}

const passkeyWrapper = (overrides = {}) => wrapper({
  wrapperId: "2".repeat(32), type: "passkey",
  params: { credentialId: b64(Buffer.alloc(32, 4)), prfSalt: b64(Buffer.alloc(32, 5)) }, ...overrides,
});

function addAdult(pairing, inviter, suffix) {
  const request = pairing.createPairing(inviter.sessionToken);
  const claim = pairing.claimPairing({ code: request.code, credential: credential(`adult-${suffix}`), deviceLabel: "Phone" });
  pairing.approvePairing(inviter.sessionToken, request.pairingId, claim.version);
  return pairing.activateClaim(claim.claimToken);
}

function household(store = null) {
  let now = 1_000_000;
  const clock = () => now;
  const pairing = new PairingService({ store, now: clock });
  const vaults = new AccountVaultService({ store, now: clock });
  const adult = pairing.bootstrap({ credential: credential(`founder-${Math.random()}`) });
  const auth = (who) => pairing.authorize(who.sessionToken);
  return { pairing, vaults, adult, auth, advance: (ms) => { now += ms; } };
}

function bothStores(name, body) {
  test(`${name} (in memory)`, () => body(household()));
  test(`${name} (durable)`, () => {
    const store = new DurableStore(":memory:");
    try { body(household(store)); } finally { store.close(); }
  });
}

bothStores("a member creates, downloads and replaces their vault compare-and-set", (h) => {
  const auth = h.auth(h.adult);
  assert.deepEqual(h.vaults.download(auth, "client"), { vault: null, wrappers: [] });
  assert.deepEqual(h.vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] }), { version: 1 });
  const first = h.vaults.download(auth, "client");
  assert.equal(first.vault.version, 1);
  assert.equal(first.vault.ciphertext, sealedVault());
  assert.deepEqual(first.wrappers.map(({ wrapperId, type, version, params, wrapped }) => ({ wrapperId, type, version, params, wrapped })), [wrapper()]);

  assert.deepEqual(h.vaults.upload(auth, { expectedVersion: 1, ciphertext: sealedVault(150, 8) }), { version: 2 });
  // A device that read version 1 loses the race and must merge.
  assert.throws(() => h.vaults.upload(auth, { expectedVersion: 1, ciphertext: sealedVault(150, 9) }), rejects("vault_version_conflict", 409));
  assert.throws(() => h.vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] }), rejects("vault_version_conflict", 409));
  const second = h.vaults.download(auth, "client");
  assert.equal(second.vault.version, 2);
  assert.equal(second.vault.ciphertext, sealedVault(150, 8));
  // The wrappers don't change with the vault.
  assert.equal(second.wrappers.length, 1);
});

bothStores("a vault is created with at least one wrapper, and wrappers change on their own", (h) => {
  const auth = h.auth(h.adult);
  assert.throws(() => h.vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault() }), rejects("vault_invalid", 400));
  assert.throws(() => h.vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [] }), rejects("vault_invalid", 400));
  assert.throws(() => h.vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper(), wrapper()] }), rejects("vault_invalid", 400));
  assert.throws(() => h.vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper({ version: 2 })] }), rejects("vault_invalid", 400));
  assert.throws(() => h.vaults.putWrapper(auth, "2".repeat(32), passkeyWrapper()), rejects("vault_not_found", 404));
  h.vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] });
  assert.throws(() => h.vaults.upload(auth, { expectedVersion: 1, ciphertext: sealedVault(), wrappers: [wrapper()] }), rejects("vault_invalid", 400));

  // Add a passkey wrapper, replace it, then drop the password wrapper.
  assert.deepEqual(h.vaults.putWrapper(auth, "2".repeat(32), passkeyWrapper()), { wrapperId: "2".repeat(32), version: 1, added: true });
  assert.throws(() => h.vaults.putWrapper(auth, "2".repeat(32), passkeyWrapper()), rejects("vault_wrapper_conflict", 409));
  assert.throws(() => h.vaults.putWrapper(auth, "2".repeat(32), wrapper({ wrapperId: "2".repeat(32), version: 2 })), rejects("vault_wrapper_conflict", 409));
  assert.deepEqual(h.vaults.putWrapper(auth, "2".repeat(32), passkeyWrapper({ version: 2 })), { wrapperId: "2".repeat(32), version: 2, added: false });
  assert.throws(() => h.vaults.putWrapper(auth, "3".repeat(32), wrapper({ version: 2 })), rejects("vault_wrapper_conflict", 409));
  assert.deepEqual(h.vaults.removeWrapper(auth, "1".repeat(32)), { remaining: 1 });
  // The last wrapper stays.
  assert.throws(() => h.vaults.removeWrapper(auth, "2".repeat(32)), rejects("vault_last_wrapper", 409));
  assert.throws(() => h.vaults.removeWrapper(auth, "1".repeat(32)), rejects("vault_wrapper_not_found", 404));
  const { wrappers } = h.vaults.download(auth, "client");
  assert.deepEqual(wrappers.map((entry) => [entry.wrapperId, entry.type, entry.version]), [["2".repeat(32), "passkey", 2]]);

  // At most eight.
  for (let index = 3; index < 10; index += 1)
    h.vaults.putWrapper(auth, String(index).repeat(32), wrapper({ type: "backup-code", params: {} }));
  assert.throws(() => h.vaults.putWrapper(auth, "a".repeat(32), wrapper({ type: "backup-code", params: {} })), rejects("vault_wrapper_limit", 409));
});

bothStores("sizes, formats and wrapper parameters are bounded", (h) => {
  const auth = h.auth(h.adult);
  const create = (body) => h.vaults.upload(auth, { expectedVersion: 0, wrappers: [wrapper()], ...body });
  assert.throws(() => create({ ciphertext: sealedVault(64 * 1024 + 1) }), rejects("vault_invalid", 400));
  assert.throws(() => create({ ciphertext: sealedVault(72) }), rejects("vault_invalid", 400));
  assert.throws(() => create({ ciphertext: b64(Buffer.alloc(200, 1)) }), rejects("vault_invalid", 400), "not a KVLT vault");
  assert.throws(() => create({ ciphertext: `${sealedVault()}=` }), rejects("vault_invalid", 400), "not canonical base64url");
  assert.throws(() => create({ ciphertext: sealedVault(), expectedVersion: -1 }), rejects("vault_invalid", 400));
  const bad = [
    wrapper({ type: "pin" }),
    wrapper({ wrapperId: "X".repeat(32) }),
    wrapper({ wrapped: b64(Buffer.alloc(60, 1)) }),
    wrapper({ params: { kdf: "pbkdf2-sha256", iterations: 100_000, salt: b64(Buffer.alloc(16)) } }),
    wrapper({ params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: b64(Buffer.alloc(8)) } }),
    wrapper({ params: { kdf: "pbkdf2-sha256", iterations: 600_000, salt: b64(Buffer.alloc(16)), extra: 1 } }),
    passkeyWrapper({ params: { credentialId: b64(Buffer.alloc(32)), prfSalt: b64(Buffer.alloc(16)) } }),
    wrapper({ type: "backup-code", params: { salt: "x" } }),
    wrapper({ type: "password-passkey" }),
  ];
  for (const entry of bad) assert.throws(() => create({ ciphertext: sealedVault(), wrappers: [entry] }), rejects("vault_invalid", 400), JSON.stringify(entry));
  assert.equal(create({ ciphertext: sealedVault(64 * 1024), wrappers: [wrapper({ type: "password-passkey",
    params: { ...wrapper().params, ...passkeyWrapper().params } })] }).version, 1);
});

bothStores("downloads are rate-limited per member and per address; writes per member", (h) => {
  const auth = h.auth(h.adult);
  for (let index = 0; index < VAULT_DOWNLOADS_PER_MEMBER; index += 1) h.vaults.download(auth, `address-${index}`);
  assert.throws(() => h.vaults.download(auth, "fresh-address"), rejects("vault_rate_limited", 429));
  h.advance(VAULT_WINDOW_MS + 1);
  h.vaults.download(auth, "fresh-address");

  // One address, many members: a second member's allowance isn't enough to
  // get past the address window.
  const vaults = new AccountVaultService({ now: () => 0 });
  const members = Array.from({ length: VAULT_DOWNLOADS_PER_ADDRESS + 1 }, (_, index) =>
    ({ member: { id: index.toString(16).padStart(32, "0") }, household: { id: "f".repeat(32) } }));
  for (const member of members.slice(0, VAULT_DOWNLOADS_PER_ADDRESS)) vaults.download(member, "router");
  assert.throws(() => vaults.download(members.at(-1), "router"), rejects("vault_rate_limited", 429));
  // The refused attempt didn't spend that member's allowance.
  for (let index = 0; index < VAULT_DOWNLOADS_PER_MEMBER; index += 1) vaults.download(members.at(-1), `elsewhere-${index}`);

  const writer = new AccountVaultService({ now: () => 0 });
  let refused = null;
  for (let index = 0; index < 100 && !refused; index += 1) {
    try { writer.upload(auth, { expectedVersion: index, ciphertext: sealedVault(), wrappers: index ? undefined : [wrapper()] }); }
    catch (error) { refused = error; }
  }
  assert.ok(rejects("vault_rate_limited", 429)(refused));
});

test("the no-cookie download path is a stub that refuses until #568", () => {
  const vaults = new AccountVaultService();
  assert.throws(() => vaults.downloadWithCapability("anything", "client"), rejects("vault_capability_unavailable", 403));
});

test("the vault routes serve only the session's own member on a trusted device", { timeout: 30_000 }, async (t) => {
  const app = createKinServer({ store: false, origin: "https://kin.example.org", host: "127.0.0.1" });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path, { cookie, method = "GET", body } = {}) => fetch(`${url}${path}`, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const cookieOf = (who) => `kin_session=${who.sessionToken}; kin_device=${who.deviceToken}`;

  // No session: refused, before and after a vault exists.
  assert.equal((await call("/api/account/vault")).status, 401);
  assert.equal((await call("/api/account/vault", { method: "PUT", body: { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] } })).status, 401);

  const founder = app.service.bootstrap({ credential: credential("founder") });
  const other = addAdult(app.service, founder, "other");
  const created = await call("/api/account/vault", { cookie: cookieOf(founder), method: "PUT", body: { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] } });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { version: 1 });
  const own = await call("/api/account/vault", { cookie: cookieOf(founder) });
  assert.equal(own.status, 200);
  assert.equal((await own.json()).vault.ciphertext, sealedVault());

  // Another member of the same household sees only their own (none).
  const theirs = await call("/api/account/vault", { cookie: cookieOf(other) });
  assert.deepEqual(await theirs.json(), { vault: null, wrappers: [] });
  // ... and their writes land on their own vault, never the founder's.
  assert.equal((await call("/api/account/vault", { cookie: cookieOf(other), method: "PUT", body: { expectedVersion: 1, ciphertext: sealedVault(100, 1) } })).status, 409);
  assert.equal((await call(`/api/account/vault/wrappers/${"1".repeat(32)}`, { cookie: cookieOf(other), method: "DELETE" })).status, 404);

  // CAS conflict and last-wrapper protection over HTTP.
  const stale = await call("/api/account/vault", { cookie: cookieOf(founder), method: "PUT", body: { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "vault_version_conflict");
  const last = await call(`/api/account/vault/wrappers/${"1".repeat(32)}`, { cookie: cookieOf(founder), method: "DELETE" });
  assert.equal(last.status, 409);
  assert.equal((await last.json()).error, "vault_last_wrapper");
  const added = await call(`/api/account/vault/wrappers/${"2".repeat(32)}`, { cookie: cookieOf(founder), method: "PUT", body: passkeyWrapper() });
  assert.equal(added.status, 200);
  assert.equal((await call(`/api/account/vault/wrappers/${"1".repeat(32)}`, { cookie: cookieOf(founder), method: "DELETE" })).status, 200);
  // A body past the bound is refused before it's read.
  const huge = await call("/api/account/vault", { cookie: cookieOf(founder), method: "PUT", body: { expectedVersion: 1, ciphertext: "A".repeat(200_000) } });
  assert.equal(huge.status, 413);

  // A revoked device is refused even with a live session.
  app.service.devices.get(founder.deviceId).revokedAt = Date.now();
  assert.equal((await call("/api/account/vault", { cookie: cookieOf(founder) })).status, 403);
  app.service.devices.get(founder.deviceId).revokedAt = null;
  // A removed member is refused.
  app.service.members.get(other.memberId).active = false;
  assert.equal((await call("/api/account/vault", { cookie: cookieOf(other) })).status, 403);
  assert.equal((await call("/api/account/vault", { cookie: cookieOf(other), method: "PUT", body: { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] } })).status, 403);
});

test("server schema 21 holds vaults, keeps their invariants and purges them with the household", () => {
  const store = new DurableStore(":memory:");
  try {
    const pairing = new PairingService({ store });
    const vaults = new AccountVaultService({ store });
    const adult = pairing.bootstrap({ credential: credential("adult") });
    const auth = pairing.authorize(adult.sessionToken);
    vaults.upload(auth, { expectedVersion: 0, ciphertext: sealedVault(), wrappers: [wrapper()] });
    store.putAccountPassword(adult.householdId, adult.memberId, { salt: new Uint8Array(16), iterations: 600_000, verifier: "$argon2id$v=19$m=19456,t=2,p=1$x$y", now: 1 });
    assert.equal(store.validate(), true);
    // The database itself refuses out-of-bound rows.
    assert.throws(() => store.db.prepare("UPDATE account_vault_wrappers SET wrapped = ?").run(new Uint8Array(10)), /CHECK/);
    assert.throws(() => store.db.prepare("UPDATE account_passwords SET kdf_iterations = 1000").run(), /CHECK/);
    // A vault left with no wrapper is invalid data.
    store.db.prepare("DELETE FROM account_vault_wrappers").run();
    assert.throws(() => store.validate(), /account vault data is invalid/);
    store.failed = false;
    store.db.prepare(`INSERT INTO account_vault_wrappers (member_id, household_id, wrapper_id, type, version, params, wrapped, updated_at)
      VALUES (?, ?, ?, 'password', 1, '{}', ?, 1)`).run(adult.memberId, adult.householdId, "1".repeat(32), new Uint8Array(61));
    assert.equal(store.validate(), true);
    assert.equal(store.householdPurgeStatus(adult.householdId).counts.accountVaults, 3);
    store.forcePurgeHousehold(adult.householdId, 5);
    assert.equal(store.householdPurgeStatus(adult.householdId).counts.accountVaults, 0);
    assert.equal(store.validate(), true);
  } finally {
    store.close();
  }
});

test("the password verifier is Argon2id over authKey, in PHC form, checked in constant time", async () => {
  const authKey = new Uint8Array(32).fill(7);
  const verifier = await hashAuthKey(authKey);
  assert.match(verifier, new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON2ID_PARAMETERS.memory},t=${ARGON2ID_PARAMETERS.passes},p=${ARGON2ID_PARAMETERS.parallelism}\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$`));
  assert.notEqual(await hashAuthKey(authKey), verifier, "a fresh salt each time");
  assert.equal(await verifyAuthKey(authKey, verifier), true);
  assert.equal(await verifyAuthKey(new Uint8Array(32).fill(8), verifier), false);
  // A verifier with other (in-range) parameters is checked with its own.
  const lighter = await hashAuthKey(authKey, { parameters: { memory: 8_192, passes: 1, parallelism: 1, tagLength: 32 } });
  assert.equal(await verifyAuthKey(authKey, lighter), true);
  await assert.rejects(verifyAuthKey(authKey, "$argon2i$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), { code: "account_password_invalid" });
  await assert.rejects(verifyAuthKey(authKey, verifier.replace("m=19456", "m=9999999")), { code: "account_password_invalid" });
  await assert.rejects(verifyAuthKey(new Uint8Array(31), verifier), { code: "account_password_invalid" });
  await assert.rejects(hashAuthKey(authKey, { parameters: { memory: 1024, passes: 1, parallelism: 1, tagLength: 32 } }), { code: "account_password_invalid" });

  // The store keeps it with the PBKDF2 parameters a new device needs (#557).
  for (const store of [new DurableStore(":memory:"), null]) {
    const pairing = new PairingService({ store });
    const adult = pairing.bootstrap({ credential: credential(`p-${Math.random()}`) });
    const storage = store ?? new AccountVaultService().storage;
    assert.equal(storage.accountPassword(adult.householdId, adult.memberId), null);
    storage.putAccountPassword(adult.householdId, adult.memberId, { salt: new Uint8Array(16).fill(1), iterations: 600_000, verifier, now: 9 });
    const saved = storage.accountPassword(adult.householdId, adult.memberId);
    assert.deepEqual([...saved.salt], new Array(16).fill(1));
    assert.equal(saved.iterations, 600_000);
    assert.equal(await verifyAuthKey(authKey, saved.verifier), true);
    assert.equal(storage.accountPassword("e".repeat(32), adult.memberId), null, "another household's lookup finds nothing");
    store?.close();
  }
});
