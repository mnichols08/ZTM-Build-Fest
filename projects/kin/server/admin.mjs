import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireDatabaseMaintenanceLock,
  DurableStore,
  DurableStoreError,
} from "./durable-store.mjs";
import { resolveDurablePath } from "./path-safety.mjs";

const dataDirectory =
  process.env.KIN_DATA_DIR ?? resolve(import.meta.dirname, "..", ".kin-data");
const defaultDatabasePath = resolve(
  process.env.KIN_DATABASE_PATH ?? join(dataDirectory, "kin.sqlite"),
);

export async function runAdminCommand(args) {
  const [command, ...parameters] = args;
  if (command === "backup" && parameters.length === 1) {
    const destination = resolveDurablePath(parameters[0]);
    const databasePath = resolveDurablePath(defaultDatabasePath);
    const result = await DurableStore.createBackup(
      databasePath,
      destination,
    );
    console.log(`Verified Kin backup created at ${result}`);
    return;
  }
  if (
    command === "restore" &&
    parameters.length === 2 &&
    parameters[1] === "--acknowledge-deletion-history"
  ) {
    const source = resolveDurablePath(parameters[0]);
    const databasePath = resolveDurablePath(defaultDatabasePath);
    const result = await DurableStore.restoreBackup(
      source,
      databasePath,
      { acknowledgeDeletionHistory: true },
    );
    console.log(
      [
        result.previousDatabasePath
          ? `Kin database restored. The previous database and WAL sidecars, if any, were preserved at ${result.previousDatabasePath}.`
          : `Kin database restored at ${result.databasePath}.`,
        `Preserved ${result.preservedDeletionCount} newer household lifecycle tombstone(s) from the existing target.`,
        `Preserved current authority for ${result.preservedAuthorityCount} active household(s).`,
        "A backup restored without its later deletion ledger may contain older data; this command cannot detect deletions absent from both databases.",
      ].join("\n"),
    );
    return;
  }
  if (
    (command === "household-status" ||
      command === "household-verify-purged") &&
    parameters.length === 1
  ) {
    const databasePath = resolveDurablePath(defaultDatabasePath);
    const store = new DurableStore(databasePath, { readonly: true });
    try {
      const status = store.householdPurgeStatus(parameters[0]);
      if (command === "household-verify-purged" && !status.purged)
        throw new DurableStoreError(
          "The Kin household has not been fully purged.",
        );
      console.log(JSON.stringify(status, null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (
    command === "household-purge" &&
    parameters.length === 3 &&
    parameters[1] === "--confirm-household-id" &&
    parameters[0] === parameters[2]
  ) {
    const householdId = parameters[0];
    const databasePath = resolveDurablePath(defaultDatabasePath);
    // Disposed in reverse: the store closes, then the lock is released,
    // whatever the purge throws (#106).
    using _maintenance = acquireDatabaseMaintenanceLock(databasePath, "household-purge");
    using store = new DurableStore(databasePath);
    const status = store.forcePurgeHousehold(householdId, Date.now());
    console.log(
      [
        `Kin household ${householdId} was purged and its deletion tombstone was verified.`,
        JSON.stringify(status, null, 2),
        "This does not erase browser storage, offline devices, exports, or separately retained backups.",
      ].join("\n"),
    );
    return;
  }
  throw new DurableStoreError(
    "Usage: node server/admin.mjs backup <destination> | restore <backup-file> --acknowledge-deletion-history | household-status <household-id> | household-purge <household-id> --confirm-household-id <household-id> | household-verify-purged <household-id>",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runAdminCommand(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof DurableStoreError
        ? error.message
        : "Kin database operation failed.",
    );
    process.exitCode = 1;
  });
}
