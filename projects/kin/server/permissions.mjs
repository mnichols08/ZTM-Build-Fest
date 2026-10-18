// The Kin service runs under Node's permission model (#106): it may read the
// app directory and read and write only its data directory (the database,
// its WAL and lock files). It may not start child processes or workers, or
// load addons or WASI. server/start.mjs builds these flags and starts the
// service with them; the service refuses to start without them.
//
// Maintenance commands (server/admin.mjs, deploy/railway/snapshot.mjs) run as
// separate, short-lived processes outside this sandbox, because backups and
// restores write outside the data directory.
import { dirname, join, resolve } from "node:path";
import { canonicalPath, resolveDurablePath } from "./path-safety.mjs";

export const APP_ROOT = resolve(import.meta.dirname, "..");

/** The database path the service uses (createKinServer calls this too):
 * an explicit path, else KIN_DATABASE_PATH, else <data directory>/kin.sqlite
 * where the data directory is explicit, KIN_DATA_DIR or .kin-data in the app
 * directory. */
export function configuredDatabasePath({ databasePath, dataDirectory } = {}, env = process.env) {
  const directory = dataDirectory ?? env.KIN_DATA_DIR ?? join(APP_ROOT, ".kin-data");
  return resolveDurablePath(databasePath ?? env.KIN_DATABASE_PATH ?? join(directory, "kin.sqlite"));
}

/** The directory the service may write: the database's, canonical so the
 * allowlist matches what the permission model compares (symlinks resolved). */
export function serviceDataDirectory(databasePath) {
  return canonicalPath(dirname(resolve(databasePath)));
}

/** Node flags for the service's sandbox. */
export function permissionFlags(databasePath) {
  const appRoot = canonicalPath(APP_ROOT);
  const data = serviceDataDirectory(databasePath);
  return ["--permission", `--allow-fs-read=${appRoot}`, `--allow-fs-read=${data}`, `--allow-fs-write=${data}`];
}

/** Why the running process is not sandboxed as the service must be, or
 * null. Checked at startup so a missing path fails with a clear message. */
export function permissionProblem(databasePath, permission = process.permission) {
  if (!permission)
    return "Kin's service runs under Node's permission model. Start it with `npm start`, run.sh or run.ps1 (they use server/start.mjs), or pass --unrestricted for local development only.";
  const data = serviceDataDirectory(databasePath);
  const required = [
    ["fs.read", canonicalPath(APP_ROOT), "--allow-fs-read"],
    ["fs.read", data, "--allow-fs-read"],
    ["fs.write", data, "--allow-fs-write"],
  ];
  for (const [scope, path, flag] of required)
    if (!permission.has(scope, path))
      return `Kin's permission allowlist is missing ${JSON.stringify(path)}. Add ${flag}=${path}, or start Kin with server/start.mjs.`;
  for (const scope of ["child", "worker", "addon", "wasi"])
    if (permission.has(scope))
      return `Kin's service must not be allowed to use "${scope}". Remove that --allow flag.`;
  // Writing anywhere but the data directory must be denied.
  if (permission.has("fs.write", canonicalPath(APP_ROOT)) && !data.startsWith(canonicalPath(APP_ROOT)))
    return "Kin's service may write only its data directory. Remove the broader --allow-fs-write flag.";
  return null;
}
