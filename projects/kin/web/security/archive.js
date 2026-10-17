// Encrypted household archives (.kin): export, then validate and restore.
//
// Kin writes package format 3 (security/archive-stream.js): the household
// sealed as a stream of segments, 256 events per segment, inside the KARC v1
// container. It still reads package format 2 (one sealed value holding the
// whole snapshot), which v0.47 and earlier wrote.
//
// Both formats decode to the same "archive parts" (event-store.js): the
// local context row, the attachment records and the history as a view of an
// event arena. Validation, staging and restore work on parts, so the
// history is held once, as canonical bytes in one arena.
import { LocalVault, validateManifest, serializeProtectedValue, deserializeProtectedValue, VaultError, fromBase64Url, toBase64Url } from "./local-vault.js";
import { EventStore } from "../storage/event-store.js";
import { readArchive, writeArchive } from "./archive-stream.js";
import { manifestRecoveryLabels } from "./key-label.js";

const KIN_VERSION = "1.0.0";
const PACKAGE_FORMAT = 3;
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_EVENT_COUNT = 10_000;
const MAX_ATTACHMENT_COUNT = 64;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const stagedArchives = new WeakMap();

/**
 * The household as a package-format-3 archive. `onProgress({ done, total })`
 * reports events sealed. The history is read from the store's session arena
 * and sealed a chunk at a time into an output allocated once.
 */
export async function exportHouseholdArchive({ store, engine, vault, portableMembership, onProgress }) {
  await assertCurrentProtection(vault);
  const parts = await store.archiveParts({ portableMembership });
  const context = parts.local_context[0];
  if (context?.sync_household_id && !Array.isArray(context?.portable_membership))
    throw new VaultError("Connect to your household before exporting so its membership history can be included.");
  const source = await EventStore.securityStatus();
  await assertCurrentProtection(vault);
  const manifest = {
    formatVersion: source.formatVersion, vaultId: source.vaultId, rootVersion: source.rootVersion,
    wrappers: source.wrappers.filter((wrapper) => wrapper.type === "recovery"), verifier: source.verifier,
  };
  if (!manifest.wrappers.length) throw new VaultError("Create a verified recovery path before exporting.");
  const household = await EventStore.validateArchiveParts({ parts, engine, vault });
  const packageManifest = {
    packageFormatVersion: PACKAGE_FORMAT,
    kinVersion: KIN_VERSION,
    exportedAt: new Date().toISOString(),
    eventCount: household.eventCount,
    attachmentCount: household.attachmentCount,
    attachmentBytes: household.attachmentBytes,
    integrityVersion: 1,
  };
  // The key is bound to this metadata; the framed metadata adds how to
  // derive it again (salt) and the segments' nonce prefix.
  const authenticatedMetadata = serializeProtectedValue({ archiveVersion: PACKAGE_FORMAT, manifest, packageManifest });
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  const key = await vault.archiveStreamKey(salt, authenticatedMetadata);
  await assertCurrentProtection(vault);
  // The key derivation and the segments name the unlocked vault's ID, which
  // is the manifest's; restore checks they agree.
  const protection = { version: 1, vaultId: vault.vaultId, salt: toBase64Url(salt), noncePrefix: toBase64Url(noncePrefix) };
  const metadata = serializeProtectedValue({ archiveVersion: PACKAGE_FORMAT, manifest, packageManifest, protection });
  return writeArchive({
    engine, metadata, key, noncePrefix, vaultId: vault.vaultId,
    context, attachments: parts.attachments, view: parts.history,
    check: () => assertCurrentProtection(vault), onProgress,
  });
}

/**
 * Opens an archive with its recovery key, validates it and stages it for
 * restoreValidatedHouseholdArchive. Nothing is written. Local attachment
 * data is re-sealed for `vault`. `onProgress({ done, total })` reports
 * events read (package format 3).
 */
export async function validateHouseholdArchive({ bytes, recoverySecret, engine, vault, onProgress }) {
  await assertCurrentProtection(vault);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new VaultError("Choose a Kin export no larger than 160 MiB.");
  const { header, metadataLength, ciphertextLength } = readArchiveHeader(bytes, engine);
  const archiveVersion = header.archiveVersion;
  const packageManifest = validatePackageManifest(header.packageManifest, archiveVersion);
  let sourceVault;
  let parts;
  const unsubscribe = vault.onLock(() => sourceVault?.lock());
  try {
    sourceVault = await openArchiveVault(header.manifest, recoverySecret);
    await assertCurrentProtection(vault);
    const authenticatedMetadata = serializeProtectedValue({ archiveVersion, manifest: header.manifest, packageManifest });
    const source = { header, authenticatedMetadata, packageManifest, sourceVault, engine, vault };
    const offset = 16 + metadataLength;
    parts = archiveVersion === 3
      ? await openStreamPackage({ ...source, bytes, offset, length: ciphertextLength, onProgress })
      : await openWholePackage({ ...source, ciphertext: bytes.slice(offset) });

    const sourceSummary = await EventStore.validateArchiveParts({
      parts, engine, vault: sourceVault,
    });
    if ((
      packageManifest.eventCount !== sourceSummary.eventCount ||
      packageManifest.attachmentCount !== sourceSummary.attachmentCount ||
      packageManifest.attachmentBytes !== sourceSummary.attachmentBytes
    ))
      throw new VaultError("This file is damaged or incomplete.");

    parts.attachments = await rewrapLocalAttachments(parts.attachments, sourceVault, vault);
    // Same history and context: the bindings found above save a replay.
    const summary = await EventStore.validateArchiveParts({ parts, engine, vault, bindings: sourceSummary.bindings });
    await assertCurrentProtection(vault);
    const stage = Object.freeze({});
    stagedArchives.set(stage, {
      parts,
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
  } catch (error) {
    if (parts) discardParts(parts);
    throw error;
  } finally {
    unsubscribe();
    sourceVault?.lock();
  }
}

// The framed header, readable without any key. Its manifest and package
// manifest are authenticated later, when the archive key is derived.
function readArchiveHeader(bytes, engine) {
  const { metadataLength, ciphertextLength } = engine.archiveLayout(bytes);
  const header = deserializeProtectedValue(bytes.slice(16, 16 + metadataLength));
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw new VaultError("This file is damaged or incomplete.");
  // Package formats 2 and 3 are read; development-era format 1 is refused.
  const archiveVersion = header.archiveVersion;
  if (archiveVersion !== 2 && archiveVersion !== 3)
    throw new VaultError("This Kin export version is not supported.");
  if (!hasExactKeys(header, ["archiveVersion", "manifest", "packageManifest", "protection"]) ||
      !hasExactKeys(header.protection, ["salt", "vaultId", "version", archiveVersion === 3 ? "noncePrefix" : "nonce"]))
    throw new VaultError("This file is damaged or incomplete.");
  return { header, metadataLength, ciphertextLength };
}

/**
 * What the restore screen shows before asking for a key: when the export was
 * made and which recovery key labels open it (key-label.js). Nothing is
 * unlocked, and the header is not yet authenticated: a wrong label can only
 * mislead the person into trying a key, which then fails to open it.
 */
export async function describeHouseholdArchive(bytes, engine) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new VaultError("Choose a Kin export no larger than 160 MiB.");
  const { header } = readArchiveHeader(bytes, engine);
  const packageManifest = validatePackageManifest(header.packageManifest, header.archiveVersion);
  // Bounded first (at most 16 wrappers), so a crafted header can't make
  // file selection hash without limit.
  let labels;
  try {
    validateManifest(header.manifest);
    labels = await manifestRecoveryLabels(header.manifest);
  } catch { throw new VaultError("This file is damaged or incomplete."); }
  if (!labels.length) throw new VaultError("This file is damaged or incomplete.");
  return Object.freeze({ exportedAt: packageManifest.exportedAt, labels: Object.freeze(labels), packageFormatVersion: header.archiveVersion });
}

/**
 * Unlocks an export's own vault with its recovery key. A wrong key names the
 * label of the key that does open it, since after a key replacement older
 * exports still need the key their device had when they were made.
 */
export async function openArchiveVault(manifest, recoverySecret) {
  try {
    return await LocalVault.unlock(manifest, recoverySecret);
  } catch (error) {
    if (error?.code !== "unlock_failed") throw error;
    // unlock tries the first recovery wrapper, so that is the key to name.
    let labels = [];
    try { labels = await manifestRecoveryLabels(manifest); } catch { /* fall back to the generic message */ }
    if (!labels.length) throw error;
    throw new VaultError(
      `This export opens with recovery key ${labels[0]} from the device that made it, and Kin couldn't open it with the key you entered. Check that you're using that key. Saved data was not changed.`,
      "archive_key_mismatch", error,
    );
  }
}

// Package format 3: segments opened in order into the archive's own arena.
async function openStreamPackage({ header, authenticatedMetadata, packageManifest, sourceVault, engine, vault, bytes, offset, length, onProgress }) {
  const { protection } = header;
  let salt, noncePrefix;
  try {
    salt = fromBase64Url(protection.salt);
    noncePrefix = fromBase64Url(protection.noncePrefix);
  } catch { throw new VaultError("This file is damaged or incomplete."); }
  if (protection.version !== 1 || protection.vaultId !== header.manifest.vaultId ||
      salt.length !== 32 || noncePrefix.length !== 8)
    throw new VaultError("This file is damaged or incomplete.");
  const key = await sourceVault.archiveStreamKey(salt, authenticatedMetadata);
  await assertCurrentProtection(vault);
  const history = EventStore.archiveHistory(engine);
  const parts = { formatVersion: 2, history: null, local_context: [], attachments: [], arena: history.arena };
  try {
    await readArchive({
      bytes, offset, length, key, noncePrefix, vaultId: protection.vaultId,
      attachmentCount: packageManifest.attachmentCount, eventCount: packageManifest.eventCount,
      onContext: (row) => parts.local_context.push(row),
      onAttachment: (row) => parts.attachments.push(row),
      onEvents: (sequences, records, remaining) => {
        // The rest of the stream bounds the history's bytes: reserve them
        // once, at the first chunk.
        if (!history.arena.length) history.reserve(packageManifest.eventCount, remaining);
        history.append(sequences, records);
      },
      check: async () => { sourceVault.assertUnlocked(); await assertCurrentProtection(vault); },
      onProgress,
    });
  } catch (error) {
    discardParts(parts);
    throw error;
  }
  parts.history = history.arena.view();
  return parts;
}

// Package format 2: one sealed value holding the whole snapshot.
async function openWholePackage({ header, authenticatedMetadata, sourceVault, engine, vault, ciphertext }) {
  const decoded = await sourceVault.openArchive(
    { ...header.protection, ciphertext },
    authenticatedMetadata,
    { ownedCiphertext: true },
  );
  await assertCurrentProtection(vault);
  if (!hasExactKeys(decoded, ["packageFormatVersion", "snapshot"]) ||
      decoded.packageFormatVersion !== 2)
    throw new VaultError("This Kin export version is not supported.");
  try {
    return EventStore.archivePartsFromSnapshot(decoded.snapshot, engine);
  } finally {
    // The arena holds the history now; these decoded rows go either way.
    for (const row of Array.isArray(decoded.snapshot?.events) ? decoded.snapshot.events : [])
      if (row?.encoded_event instanceof Uint8Array) row.encoded_event.fill(0);
  }
}

/**
 * Restores a staged archive into an empty household, or reports that this
 * household already holds it. `onProgress({ done, total })` reports events
 * protected for storage.
 */
export async function restoreValidatedHouseholdArchive({ stage, engine, vault, store, onProgress }) {
  await assertCurrentProtection(vault);
  const staged = stagedArchives.get(stage);
  if (!staged || staged.engine !== engine || staged.vault !== vault ||
      staged.vaultId !== vault.vaultId || staged.generation !== vault.generation)
    throw new VaultError("Check this Kin export again before restoring it.");
  try {
    if (store && await store.containsSameHouseholdArchive(staged.parts, { engine, vault })) {
      const eventCount = staged.parts.history.length;
      discardValidatedHouseholdArchive(stage);
      return { eventCount, alreadyPresent: true };
    }
    const result = await EventStore.restoreArchive({ vault, engine, parts: staged.parts, bindings: staged.summary.bindings, onProgress });
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
  discardParts(staged.parts);
}

function discardParts(parts) {
  parts.arena?.wipe();
  zeroByteValues({ context: parts.local_context, attachments: parts.attachments }, new Set());
}

export async function importHouseholdArchive({ bytes, recoverySecret, engine, vault, store }) {
  const staged = await validateHouseholdArchive({ bytes, recoverySecret, engine, vault });
  return restoreValidatedHouseholdArchive({ stage: staged.stage, engine, vault, store });
}

function validatePackageManifest(value, packageFormatVersion) {
  const exportedAtIsCanonical = typeof value?.exportedAt === "string" &&
    value.exportedAt.length <= 32 &&
    Number.isFinite(Date.parse(value.exportedAt)) &&
    new Date(value.exportedAt).toISOString() === value.exportedAt;
  if (!hasExactKeys(value, [
    "packageFormatVersion", "kinVersion", "exportedAt", "eventCount",
    "attachmentCount", "attachmentBytes", "integrityVersion",
  ]) || value.packageFormatVersion !== packageFormatVersion || value.integrityVersion !== 1 ||
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

async function rewrapLocalAttachments(attachments, sourceVault, targetVault) {
  const staged = structuredClone(attachments);
  for (const attachment of staged) {
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
