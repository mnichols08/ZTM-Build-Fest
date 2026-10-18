// Starts the Kin service inside Node's permission model (server/permissions.mjs).
// This launcher is the only part that may start a process; the service itself
// cannot. It creates the data directory first (the sandbox can only write
// inside it), forwards stop signals, and exits with the service's code.
//
//   node server/start.mjs            the service, sandboxed
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { configuredDatabasePath, permissionFlags } from "./permissions.mjs";

let databasePath;
try {
  databasePath = configuredDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", outcome: "configuration_or_storage", message: error.message }));
  process.exit(1);
}

const child = spawn(process.execPath, [...permissionFlags(databasePath), join(import.meta.dirname, "server.mjs")], {
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(JSON.stringify({ event: "startup_failed", outcome: "launch_failed", message: error.message }));
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
