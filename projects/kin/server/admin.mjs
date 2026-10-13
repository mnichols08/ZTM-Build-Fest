import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DurableStore, DurableStoreError } from "./durable-store.mjs";
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
  if (command === "clear") {
    // `npm run clear` may already carry the flag; repeating it is harmless.
    if (!parameters.length || parameters.some((parameter) => parameter !== "--delete-all-households"))
      throw new DurableStoreError(
        "Clearing every household requires the explicit --delete-all-households flag. Stop the Kin service first; a verified pre-clear copy is kept next to the database.",
      );
    const databasePath = resolveDurablePath(defaultDatabasePath);
    const result = await DurableStore.clearAllHouseholds(databasePath, {
      acknowledgeDeleteAllHouseholds: true,
    });
    const { removed } = result;
    console.log(
      [
        `Kin database cleared at ${result.databasePath}.`,
        `Removed ${removed.households} household(s), ${removed.members} member(s), ${removed.devices} device(s), ${removed.events} relay event(s) and ${removed.attachments} attachment(s). Schema and migration metadata were kept.`,
        `A verified copy of the database before clearing was preserved at ${result.preservedDatabasePath}; restore it with the restore command or delete it once it is no longer needed.`,
        "Clearing the service cannot erase encrypted household copies in browsers, exported archives, or other backups. Those devices will need fresh household approval to sync again.",
      ].join("\n"),
    );
    return;
  }
  throw new DurableStoreError(
    "Usage: node server/admin.mjs backup <destination> | restore <backup-file> --acknowledge-deletion-history | clear --delete-all-households",
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
