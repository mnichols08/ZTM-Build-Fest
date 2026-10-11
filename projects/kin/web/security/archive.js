import { LocalVault, serializeProtectedValue, deserializeProtectedValue, VaultError } from "./local-vault.js";
import { EventStore } from "../storage/event-store.js";

const KIN_VERSION = "0.40.1";
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_EVENT_COUNT = 10_000;
const MAX_ATTACHMENT_COUNT = 64;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const stagedArchives = new WeakMap();

export async function exportHouseholdArchive({ store, engine, vault, portableMembership }) {
  await assertCurrentProtection(vault);
  const snapshot = await store.snapshotForArchive({ portableMembership });
  if (snapshot.local_context[0]?.sync_household_id &&
      !Array.isArray(snapshot.local_context[0]?.portable_membership))
    throw new VaultError("Connect to your household before exporting so its membership history can be included.");
  const source = await EventStore.securityStatus();
  await assertCurrentProtection(vault);
  const manifest = {
    formatVersion: source.formatVersion, vaultId: source.vaultId, rootVersion: source.rootVersion,
    wrappers: source.wrappers.filter((wrapper) => wrapper.type === "recovery"), verifier: source.verifier,
  };
  if (!manifest.wrappers.length) throw new VaultError("Create a verified recovery path before exporting.");
  const household = await EventStore.validateArchiveSnapshot({ snapshot, engine, vault });
  const packageManifest = {
    packageFormatVersion: 2,
    kinVersion: KIN_VERSION,
    exportedAt: new Date().toISOString(),
    eventCount: household.eventCount,
    attachmentCount: household.attachmentCount,
    attachmentBytes: household.attachmentBytes,
    integrityVersion: 1,
  };
  const payload = { packageFormatVersion: 2, snapshot };
  const authenticatedMetadata = serializeProtectedValue({ archiveVersion: 2, manifest, packageManifest });
  const envelope = await vault.sealArchive(payload, authenticatedMetadata, { rawCiphertext: true });
  await assertCurrentProtection(vault);
  const { ciphertext, ...protection } = envelope;
  const framedMetadata = serializeProtectedValue({
    archiveVersion: 2, manifest, packageManifest, protection,
  });
  return engine.encodeArchive(framedMetadata, ciphertext);
}

export async function validateHouseholdArchive({ bytes, recoverySecret, engine, vault }) {
  await assertCurrentProtection(vault);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new VaultError("Choose a Kin export no larger than 160 MiB.");
  const { metadata, ciphertext } = engine.decodeArchive(bytes);
  const header = deserializeProtectedValue(metadata);
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw new VaultError("This file is damaged or incomplete.");
  const archiveVersion = header.archiveVersion;
  if (archiveVersion !== 1 && archiveVersion !== 2)
    throw new VaultError("This Kin export version is not supported.");
  const expectedHeaderFields = archiveVersion === 1
    ? ["archiveVersion", "manifest", "protection"]
    : ["archiveVersion", "manifest", "packageManifest", "protection"];
  if (!hasExactKeys(header, expectedHeaderFields) ||
      !hasExactKeys(header.protection, ["nonce", "salt", "vaultId", "version"]))
    throw new VaultError("This file is damaged or incomplete.");
  const packageManifest = archiveVersion === 2
    ? validatePackageManifest(header.packageManifest)
    : null;
  let sourceVault;
  const unsubscribe = vault.onLock(() => sourceVault?.lock());
  try {
    sourceVault = await LocalVault.unlock(header.manifest, recoverySecret);
    await assertCurrentProtection(vault);
    const authenticatedMetadata = archiveVersion === 1
      ? serializeProtectedValue({ archiveVersion: 1, manifest: header.manifest })
      : serializeProtectedValue({ archiveVersion: 2, manifest: header.manifest, packageManifest });
    const decoded = await sourceVault.openArchive(
      { ...header.protection, ciphertext },
      authenticatedMetadata,
      { ownedCiphertext: true },
    );
    await assertCurrentProtection(vault);
    let snapshot;
    if (archiveVersion === 1) {
      snapshot = decoded;
    } else {
      if (!hasExactKeys(decoded, ["packageFormatVersion", "snapshot"]) ||
          decoded.packageFormatVersion !== 2)
        throw new VaultError("This Kin export version is not supported.");
      snapshot = decoded.snapshot;
    }

    normalizeExpiredPortableMembers(snapshot);

    const sourceSummary = await EventStore.validateArchiveSnapshot({
      snapshot, engine, vault: sourceVault,
    });
    if (packageManifest && (
      packageManifest.eventCount !== sourceSummary.eventCount ||
      packageManifest.attachmentCount !== sourceSummary.attachmentCount ||
      packageManifest.attachmentBytes !== sourceSummary.attachmentBytes
    ))
      throw new VaultError("This file is damaged or incomplete.");

    const stagedSnapshot = await rewrapLocalAttachments(snapshot, sourceVault, vault);
    const summary = await EventStore.validateArchiveSnapshot({
      snapshot: stagedSnapshot, engine, vault,
    });
    await assertCurrentProtection(vault);
    const stage = Object.freeze({});
    stagedArchives.set(stage, {
      snapshot: stagedSnapshot,
      engine,
      vault,
      vaultId: vault.vaultId,
      generation: vault.generation,
      summary,
      packageFormatVersion: archiveVersion,
    });
    return Object.freeze({
      stage,
      eventCount: summary.eventCount,
      attachmentCount: summary.attachmentCount,
      attachmentBytes: summary.attachmentBytes,
      packageFormatVersion: archiveVersion,
    });
  } finally {
    unsubscribe();
    sourceVault?.lock();
  }
}

export async function restoreValidatedHouseholdArchive({ stage, engine, vault, store }) {
  await assertCurrentProtection(vault);
  const staged = stagedArchives.get(stage);
  if (!staged || staged.engine !== engine || staged.vault !== vault ||
      staged.vaultId !== vault.vaultId || staged.generation !== vault.generation)
    throw new VaultError("Check this Kin export again before restoring it.");
  try {
    if (store && await store.containsSameHouseholdArchive(staged.snapshot, { engine, vault })) {
      discardValidatedHouseholdArchive(stage);
      return { eventCount: staged.snapshot.events.length, alreadyPresent: true };
    }
    const result = await EventStore.restoreEmpty({
      vault, engine, snapshot: staged.snapshot, ownedSnapshot: true,
    });
    discardValidatedHouseholdArchive(stage);
    return result;
  } catch (error) {
    await assertCurrentProtection(vault);
    throw error;
  }
}

export function discardValidatedHouseholdArchive(stage) {
  const staged = stagedArchives.get(stage);
  if (!staged) return;
  stagedArchives.delete(stage);
  zeroByteValues(staged.snapshot, new Set());
}

export async function importHouseholdArchive({ bytes, recoverySecret, engine, vault, store }) {
  const staged = await validateHouseholdArchive({ bytes, recoverySecret, engine, vault });
  return restoreValidatedHouseholdArchive({ stage: staged.stage, engine, vault, store });
}

function validatePackageManifest(value) {
  const exportedAtIsCanonical = typeof value?.exportedAt === "string" &&
    value.exportedAt.length <= 32 &&
    Number.isFinite(Date.parse(value.exportedAt)) &&
    new Date(value.exportedAt).toISOString() === value.exportedAt;
  if (!hasExactKeys(value, [
    "packageFormatVersion", "kinVersion", "exportedAt", "eventCount",
    "attachmentCount", "attachmentBytes", "integrityVersion",
  ]) || value.packageFormatVersion !== 2 || value.integrityVersion !== 1 ||
      typeof value.kinVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.kinVersion) ||
      !exportedAtIsCanonical ||
      !Number.isSafeInteger(value.eventCount) || value.eventCount < 0 ||
      value.eventCount > MAX_EVENT_COUNT ||
      !Number.isSafeInteger(value.attachmentCount) || value.attachmentCount < 0 ||
      value.attachmentCount > MAX_ATTACHMENT_COUNT ||
      !Number.isSafeInteger(value.attachmentBytes) || value.attachmentBytes < 0 ||
      value.attachmentBytes > MAX_ATTACHMENT_BYTES)
    throw new VaultError("This Kin export manifest is damaged or unsupported.");
  return value;
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function normalizeExpiredPortableMembers(snapshot, now = Date.now()) {
  const members = snapshot?.local_context?.[0]?.portable_membership;
  if (!Array.isArray(members)) return;
  for (const member of members) {
    if (member?.memberKind === "temporary" && member.status === "active" && Number.isSafeInteger(member.expiresAt) &&
        member.expiresAt <= now) member.status = "expired";
  }
}

async function rewrapLocalAttachments(snapshot, sourceVault, targetVault) {
  const staged = structuredClone(snapshot);
  for (const attachment of staged.attachments ?? []) {
    if (attachment.ciphertext) continue;
    const saved = await sourceVault.open(attachment.localSealed, {
      store: "attachment-file", id: attachment.attachment_id,
    });
    try {
      attachment.localSealed = await targetVault.seal(saved, {
        store: "attachment-file", id: attachment.attachment_id,
      });
    } finally {
      saved?.bytes?.fill(0);
    }
    await assertCurrentProtection(targetVault);
  }
  return staged;
}

function zeroByteValues(value, seen) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof ArrayBuffer) {
    new Uint8Array(value).fill(0);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength).fill(0);
    return;
  }
  for (const child of Object.values(value)) zeroByteValues(child, seen);
}

async function assertCurrentProtection(vault) {
  vault.assertUnlocked();
  await vault.checkSecurityEpoch?.();
  vault.assertUnlocked();
}
