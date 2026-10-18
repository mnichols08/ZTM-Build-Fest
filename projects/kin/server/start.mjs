// Starts the Kin service inside Node's permission model (server/permissions.mjs).
// This launcher is the only part that may start a process; the service itself
// cannot. It creates the data directory first (the sandbox can only write
// inside it), hands the service the canonical database path (the model
// compares paths as written, so a symlinked path would be denied), forwards
// stop requests, and exits with the service's code.
//
//   node server/start.mjs            the service, sandboxed
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { constants } from "node:os";
import { canonicalPath } from "./path-safety.mjs";
import { configuredDatabasePath, permissionFlags } from "./permissions.mjs";

let databasePath;
let flags;
try {
  const configured = configuredDatabasePath();
  mkdirSync(dirname(configured), { recursive: true, mode: 0o700 });
  databasePath = join(canonicalPath(dirname(configured)), basename(configured));
  flags = permissionFlags(databasePath);
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", outcome: "configuration_or_storage", message: error.message }));
  process.exit(1);
}

const child = spawn(process.execPath, [...flags, join(import.meta.dirname, "server.mjs")], {
  stdio: "inherit",
  env: { ...process.env, KIN_DATABASE_PATH: databasePath },
});

// SIGTERM (start.sh, Docker, systemd) is sent to this launcher only, so it is
// forwarded. A terminal's Ctrl+C (SIGINT) already reaches the service too, so
// it is not forwarded again; a SIGINT sent to the launcher alone is passed on
// as SIGTERM, which the service handles the same way. On Windows nothing is
// forwarded: there, kill() ends a process without letting it close, and
// Ctrl+C reaches every process in the console.
const forward = (signal) => {
  if (process.platform === "win32" || child.exitCode !== null) return;
  child.kill(signal);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => {
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) forward("SIGTERM"); }, 250).unref();
});
child.on("error", (error) => {
  console.error(JSON.stringify({ event: "startup_failed", outcome: "launch_failed", message: error.message }));
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 0)));
