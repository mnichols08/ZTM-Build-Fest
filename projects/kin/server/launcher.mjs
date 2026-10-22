// The Kin launcher: the one part of Kin that may start processes (#106). It
// starts the service inside Node's permission model (server/permissions.mjs)
// and, for the home server (ADR 0025 §10, #713), installs or removes Kin as
// a service, answers a health check and runs the admin commands.
//
// Two programs use it. `node server/start.mjs` runs the service as
// `node --permission … server/server.mjs`. The single executable
// (scripts/sea/main.cjs) can't pass Node flags on its command line, so it
// starts a second copy of itself with the flags in NODE_OPTIONS; how the
// service process is started is the caller's `serviceProcess`.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { constants } from "node:os";
import { canonicalPath } from "./path-safety.mjs";
import { configuredDatabasePath, permissionFlags } from "./permissions.mjs";

export const USAGE = `Usage: kin [command] [options]

Commands (at most one):
  (none)                 run Kin
  --install-service      install Kin as a service that starts when the computer
                         starts and restarts if it fails (needs admin rights)
  --uninstall-service    remove the service; Kin's data directory is kept
  --print-service        print the service definition without installing it
  --health               exit with 0 if the running service answers /health
  --version              print Kin's version
  --help                 show this help
  admin <arguments>      run an admin command (backup, restore, …)

Options:
  --supervise            restart the service when it fails (the Windows task uses it)
  --log-file PATH        append the service's output to PATH
  --user NAME            macOS: the account the service runs as (default: the
                         account that ran sudo)
  --platform NAME        with --print-service: linux, darwin or win32`;

const COMMANDS = Object.freeze({
  "--install-service": "install-service",
  "--uninstall-service": "uninstall-service",
  "--print-service": "print-service",
  "--health": "health",
  "--version": "version",
  "--help": "help",
  "-h": "help",
});
const PLATFORMS = Object.freeze(["linux", "darwin", "win32"]);
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;
const RESTART_RESET_MS = 60_000;

export class LauncherUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "LauncherUsageError";
  }
}

/** The launcher's command line as { command, supervise, logFile, user,
 * platform, adminArgs }. Throws LauncherUsageError. */
export function parseLauncherArguments(argv) {
  const options = { command: "run", supervise: false, logFile: null, user: null, platform: null, adminArgs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "admin") {
      if (options.command !== "run") throw new LauncherUsageError("Give one command at a time.");
      options.command = "admin";
      options.adminArgs = argv.slice(index + 1);
      break;
    }
    const equals = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = equals > 0 ? argument.slice(0, equals) : argument;
    const value = () => {
      if (equals > 0) return argument.slice(equals + 1);
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) throw new LauncherUsageError(`${name} needs a value.`);
      return argv[index];
    };
    if (COMMANDS[name] && equals < 0) {
      if (options.command !== "run") throw new LauncherUsageError("Give one command at a time.");
      options.command = COMMANDS[name];
    } else if (name === "--supervise" && equals < 0) options.supervise = true;
    else if (name === "--log-file") options.logFile = value();
    else if (name === "--user") options.user = value();
    else if (name === "--platform") options.platform = value();
    else throw new LauncherUsageError(`Unknown argument "${argument}".`);
  }
  if ((options.supervise || options.logFile) && options.command !== "run")
    throw new LauncherUsageError("--supervise and --log-file are for running Kin.");
  if (options.logFile === "") throw new LauncherUsageError("--log-file needs a path.");
  if (options.user !== null && !["install-service", "print-service"].includes(options.command))
    throw new LauncherUsageError("--user is for --install-service and --print-service.");
  if (options.user !== null && !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(options.user))
    throw new LauncherUsageError(`"${options.user}" isn't an account name.`);
  if (options.platform !== null && options.command !== "print-service")
    throw new LauncherUsageError("--platform is for --print-service.");
  if (options.platform !== null && !PLATFORMS.includes(options.platform))
    throw new LauncherUsageError(`--platform must be one of ${PLATFORMS.join(", ")}.`);
  return options;
}

/** The URL the health check asks: the service's own listener. */
export function healthUrl(env = process.env) {
  const host = env.KIN_HOST || "127.0.0.1";
  const port = Number(env.KIN_PORT ?? 8000);
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostPart}:${port}/health`;
}

/** 0 when the running service answers /health within five seconds, else 1. */
export async function checkHealth(env = process.env, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(healthUrl(env), { signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    return response.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

/** Opens `path` for appending (owner-only), first moving a file over 10 MiB
 * to `path.1` so a long-running service's log can't fill the disk. */
function openLog(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
  return openSync(path, "a", 0o600);
}

/**
 * Runs the service until it stops and resolves with the exit code the
 * launcher should use. `serviceProcess({ flags, env })` returns the
 * { command, args, env } that starts the service with the sandbox flags.
 * With `supervise`, a service that fails is started again after a delay
 * (1 second, doubling to 1 minute, reset after a minute up).
 */
export function runService({ serviceProcess, env = process.env, supervise = false, logFile = null, spawnImpl = spawn, signals = process, platform = process.platform }) {
  let log = null;
  const write = (stream, line) => {
    if (log !== null) writeSync(log, `${line}\n`);
    else stream.write(`${line}\n`);
  };
  let databasePath;
  let flags;
  try {
    if (logFile) log = openLog(logFile);
    const configured = configuredDatabasePath({}, env);
    // The sandbox can only write inside the data directory, so it is made
    // here, owner-only. The permission model compares paths as written, so
    // the service is given the canonical path (symlinks resolved).
    mkdirSync(dirname(configured), { recursive: true, mode: 0o700 });
    databasePath = join(canonicalPath(dirname(configured)), basename(configured));
    flags = permissionFlags(databasePath);
  } catch (error) {
    write(process.stderr, JSON.stringify({ event: "startup_failed", outcome: "configuration_or_storage", message: error.message }));
    if (log !== null) closeSync(log);
    return Promise.resolve(1);
  }
  const serviceEnv = { ...env, KIN_DATABASE_PATH: databasePath, ...(supervise ? { KIN_STOP_WITH_LAUNCHER: "1" } : {}) };
  const spec = serviceProcess({ flags, env: serviceEnv });

  return new Promise((resolveExit) => {
    let child = null;
    let stopping = false;
    let delay = RESTART_MIN_MS;
    let restartTimer = null;
    const finish = (code) => {
      if (log !== null) closeSync(log);
      resolveExit(code);
    };
    // SIGTERM (start.sh, Docker, systemd, launchd) is sent to this launcher
    // only, so it is forwarded. A terminal's Ctrl+C (SIGINT) already reaches
    // the service too, so it is not forwarded again; a SIGINT sent to the
    // launcher alone is passed on as SIGTERM, which the service handles the
    // same way. On Windows nothing is forwarded: there, kill() ends a process
    // without letting it close, and Ctrl+C reaches every process in the
    // console (a supervised service closes when its stdin does instead).
    const forward = (signal) => {
      if (platform === "win32" || !child || child.exitCode !== null) return;
      child.kill(signal);
    };
    const onTerm = () => {
      stopping = true;
      if (restartTimer) { clearTimeout(restartTimer); finish(0); return; }
      forward("SIGTERM");
    };
    const onInt = () => {
      stopping = true;
      if (restartTimer) { clearTimeout(restartTimer); finish(130); return; }
      setTimeout(() => { if (child && child.exitCode === null && child.signalCode === null) forward("SIGTERM"); }, 250).unref();
    };
    signals.on("SIGTERM", onTerm);
    signals.on("SIGINT", onInt);
    const start = () => {
      restartTimer = null;
      const startedAt = Date.now();
      const piped = log !== null;
      child = spawnImpl(spec.command, spec.args, {
        stdio: [supervise ? "pipe" : "inherit", piped ? "pipe" : "inherit", piped ? "pipe" : "inherit"],
        env: spec.env,
        windowsHide: true,
      });
      if (piped) {
        child.stdout?.on("data", (chunk) => writeSync(log, chunk));
        child.stderr?.on("data", (chunk) => writeSync(log, chunk));
      }
      child.on("error", (error) => {
        write(process.stderr, JSON.stringify({ event: "startup_failed", outcome: "launch_failed", message: error.message }));
        signals.removeListener("SIGTERM", onTerm);
        signals.removeListener("SIGINT", onInt);
        finish(1);
      });
      child.on("exit", (code, signal) => {
        const exitCode = code ?? 128 + (constants.signals[signal] ?? 0);
        if (!supervise || stopping || exitCode === 0) {
          signals.removeListener("SIGTERM", onTerm);
          signals.removeListener("SIGINT", onInt);
          finish(exitCode);
          return;
        }
        if (Date.now() - startedAt >= RESTART_RESET_MS) delay = RESTART_MIN_MS;
        write(process.stderr, JSON.stringify({ event: "service_restarting", code: exitCode, delayMs: delay }));
        restartTimer = setTimeout(start, delay);
        delay = Math.min(delay * 2, RESTART_MAX_MS);
      });
    };
    start();
  });
}

/**
 * The launcher's entry point; resolves with the process exit code.
 *   serviceProcess  how to start the sandboxed service (see runService)
 *   program         how a service manager starts Kin (server/service-install.mjs)
 *   version         Kin's version, for --version
 */
export async function runLauncher(argv, { serviceProcess, program, version, env = process.env, platform = process.platform, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseLauncherArguments(argv);
  } catch (error) {
    if (!(error instanceof LauncherUsageError)) throw error;
    stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  switch (options.command) {
    case "help":
      stdout.write(`${USAGE}\n`);
      return 0;
    case "version":
      stdout.write(`${version}\n`);
      return 0;
    case "health":
      return checkHealth(env);
    case "admin": {
      // Backups and restores write outside the data directory, so the admin
      // commands run here, outside the sandbox, as `node server/admin.mjs`.
      const { runAdminCommand } = await import("./admin.mjs");
      const { DurableStoreError } = await import("./durable-store.mjs");
      try {
        await runAdminCommand(options.adminArgs);
        return 0;
      } catch (error) {
        stderr.write(`${error instanceof DurableStoreError ? error.message : "Kin database operation failed."}\n`);
        return 1;
      }
    }
    case "print-service":
    case "install-service":
    case "uninstall-service": {
      const service = await import("./service-install.mjs");
      try {
        return await service.runServiceCommand(options, { program, env, platform: options.platform ?? platform, stdout, stderr });
      } catch (error) {
        if (!(error instanceof service.ServiceInstallError)) throw error;
        stderr.write(`${error.message}\n`);
        return 1;
      }
    }
    default:
      return runService({ serviceProcess, env, supervise: options.supervise, logFile: options.logFile, platform });
  }
}
