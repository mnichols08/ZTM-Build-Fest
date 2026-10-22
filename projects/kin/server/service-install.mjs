// Running Kin as a service that starts with the computer (ADR 0025 §10, #716):
// a systemd unit on Linux, a launchd LaunchDaemon on macOS, and on Windows a
// Task Scheduler task at startup.
//
// Windows: a service registered with sc.exe must answer the Service Control
// Manager, which a console program can't (error 1053). The ADR's answer is a
// small std-only Rust service host; until it exists (a follow-up under
// #713), this uses the ADR's fallback: a scheduled task that starts at boot
// as the low-privilege LOCAL SERVICE account, with the launcher supervising
// (restarting) the service itself, since Task Scheduler's own restart only
// covers a task that fails to start.
//
// `kin --install-service`, `--uninstall-service` and `--print-service` come
// here from the launcher (server/launcher.mjs), outside the sandbox. Install
// and uninstall need admin rights (sudo, or an elevated prompt on Windows).
// Uninstalling removes the service and Kin's installed copy and never touches
// the data directory.
//
// Each command is first built as a plan (a list of steps), which is what the
// tests check, then carried out step by step.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { homeDataDirectory } from "./mode.mjs";

export const SYSTEMD_UNIT_PATH = "/etc/systemd/system/kin.service";
export const LINUX_INSTALL_DIRECTORY = "/usr/local/lib/kin";
export const LINUX_ACCOUNT = "kin";
export const LAUNCHD_LABEL = "io.journeytocode.kin";
export const LAUNCHD_PLIST_PATH = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
export const MACOS_INSTALL_DIRECTORY = "/usr/local/libexec/kin";
export const MACOS_APP_CACHE = "/Library/Caches/Kin";
export const MACOS_LOG_DIRECTORY = "/Library/Logs/Kin";
export const WINDOWS_TASK_NAME = "Kin";
// Well-known Windows accounts, by SID so they work in every language.
const LOCAL_SERVICE = "*S-1-5-19";
const SYSTEM = "*S-1-5-18";
const ADMINISTRATORS = "*S-1-5-32-544";

export class ServiceInstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "ServiceInstallError";
  }
}

// --- Generated files -------------------------------------------------------

/** One systemd ExecStart= word: quoted when needed, `%` and `$` escaped. */
export function systemdWord(word) {
  const escaped = word.replaceAll("%", "%%").replaceAll("$", "$$$$");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(escaped)) return escaped;
  return `"${escaped.replace(/[\\"]/g, "\\$&")}"`;
}

/** The systemd unit (kin.service). `execStart` is the program and its
 * arguments; `sea` adds a cache directory for the executable's app files. */
export function systemdUnit({ execStart, sea }) {
  return `# Kin home server (ADR 0025 §10). Installed by \`kin --install-service\`;
# removed by \`kin --uninstall-service\`, which keeps /var/lib/kin.
[Unit]
Description=Kin home server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${LINUX_ACCOUNT}
Group=${LINUX_ACCOUNT}
ExecStart=${execStart.map(systemdWord).join(" ")}
Environment=KIN_MODE=home
Environment=KIN_DATA_DIR=/var/lib/kin
StateDirectory=kin
StateDirectoryMode=0700
${sea ? "# The executable unpacks its app files here (KIN_APP_CACHE).\nCacheDirectory=kin\nCacheDirectoryMode=0700\n" : ""}UMask=0077
Restart=on-failure
RestartSec=5
# The service gives itself 30 seconds to close its database.
TimeoutStopSec=40
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=${sea ? "yes" : "read-only"}
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
CapabilityBoundingSet=
# MemoryDenyWriteExecute stays off: V8's JIT compiler writes code pages.

[Install]
WantedBy=multi-user.target
`;
}

const xml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

/** The launchd LaunchDaemon plist. */
export function launchdPlist({ programArguments, userName, environment, logPath }) {
  const strings = (values) => values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const variables = Object.entries(environment).map(([name, value]) => `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Kin home server (ADR 0025 §10). Kin's install-service command wrote
     this; its uninstall-service command removes it and keeps Kin's data.
     (XML comments can't hold a double hyphen, so no flag names here.) -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(programArguments)}
  </array>
  <key>UserName</key>
  <string>${xml(userName)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${variables}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>40</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

/** One Windows command-line argument, quoted as CommandLineToArgvW reads it. */
export function windowsArgument(value) {
  if (value !== "" && !/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** The Task Scheduler task (XML, written to disk as UTF-16 with a BOM). */
export function scheduledTaskXml({ command, args, workingDirectory }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- Kin home server (ADR 0025 §10). Kin's install-service command wrote
     this; its uninstall-service command removes it and keeps Kin's data.
     (XML comments can't hold a double hyphen, so no flag names here.) -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Kin home server. Starts when the computer starts.</Description>
    <URI>\\${WINDOWS_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-19</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command)}</Command>
      <Arguments>${xml(args.map(windowsArgument).join(" "))}</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// --- Plans -------------------------------------------------------------------

/** Where things go on each platform. */
export function serviceLayout(platform, env = process.env) {
  if (platform === "linux")
    return { dataDirectory: homeDataDirectory("linux", env), installDirectory: LINUX_INSTALL_DIRECTORY, executable: `${LINUX_INSTALL_DIRECTORY}/kin`, definition: SYSTEMD_UNIT_PATH };
  if (platform === "darwin")
    return { dataDirectory: homeDataDirectory("darwin", env), installDirectory: MACOS_INSTALL_DIRECTORY, executable: `${MACOS_INSTALL_DIRECTORY}/kin`, definition: LAUNCHD_PLIST_PATH, appCache: MACOS_APP_CACHE, logDirectory: MACOS_LOG_DIRECTORY };
  if (platform === "win32") {
    const programData = env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData";
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files";
    const dataDirectory = homeDataDirectory("win32", env);
    return {
      dataDirectory,
      installDirectory: win32.join(programFiles, "Kin"),
      executable: win32.join(programFiles, "Kin", "kin.exe"),
      definition: `Task Scheduler task \\${WINDOWS_TASK_NAME}`,
      appCache: win32.join(programData, "Kin-app"),
      logFile: win32.join(dataDirectory, "logs", "kin.log"),
    };
  }
  throw new ServiceInstallError(`Kin can't be installed as a service on ${platform}.`);
}

/** The program a service manager runs, and how it is installed. A single
 * executable is copied to the layout's install directory and run from there;
 * `node server/start.mjs` is run in place. */
function serviceProgram(program, layout) {
  if (program?.kind === "sea") return { command: layout.executable, args: [], copyFrom: program.executable };
  if (program?.kind === "node") return { command: program.command, args: [...program.args], copyFrom: null };
  throw new ServiceInstallError("Kin doesn't know which program to install.");
}

// Debian, Ubuntu, Raspberry Pi OS and Fedora all have it here.
const NOLOGIN = "/usr/sbin/nologin";

/**
 * The service definition text for `platform`: { path, content }.
 */
export function serviceDefinition({ platform, program, env = process.env, user = null }) {
  const layout = serviceLayout(platform, env);
  const run = serviceProgram(program, layout);
  if (platform === "linux")
    return { path: layout.definition, content: systemdUnit({ execStart: [run.command, ...run.args], sea: program.kind === "sea" }) };
  if (platform === "darwin")
    return {
      path: layout.definition,
      content: launchdPlist({
        programArguments: [run.command, ...run.args],
        userName: user ?? "<the account that runs Kin>",
        environment: { KIN_MODE: "home", KIN_DATA_DIR: layout.dataDirectory, KIN_APP_CACHE: layout.appCache },
        logPath: posix.join(layout.logDirectory, "kin.log"),
      }),
    };
  const args = [...run.args, "--supervise", "--log-file", layout.logFile];
  if (program.kind === "sea") args.push("--app-cache", layout.appCache);
  return { path: layout.definition, content: scheduledTaskXml({ command: run.command, args, workingDirectory: layout.dataDirectory }) };
}

/**
 * The steps that install (`action` "install") or remove ("uninstall") the
 * service. Steps: { kind: "admin" | "mkdir" | "copy" | "write" | "remove" |
 * "run", … }; a "run" step with `unless` is skipped when that command
 * succeeds, and one with `allowFailure` may fail.
 */
export function servicePlan(action, { platform, program, env = process.env, user = null }) {
  const layout = serviceLayout(platform, env);
  const run = serviceProgram(program, layout);
  const sea = program.kind === "sea";
  const steps = [{ kind: "admin", platform }];
  const notes = [];
  const keep = `Kin's data in ${layout.dataDirectory} was kept. Delete it yourself only if you no longer need it; a backup of it can be used to impersonate this home server.`;

  if (platform === "linux") {
    if (action === "install") {
      steps.push({ kind: "require", path: "/run/systemd/system", message: "This computer doesn't use systemd, so Kin can't install itself as a service here. Run Kin from your own init system instead (docs/HOME-SERVER.md)." });
      steps.push({ kind: "run", command: "useradd", args: ["--system", "--user-group", "--no-create-home", "--home-dir", layout.dataDirectory, "--shell", NOLOGIN, LINUX_ACCOUNT], unless: { command: "id", args: ["-u", LINUX_ACCOUNT] } });
      if (sea) {
        steps.push({ kind: "mkdir", path: layout.installDirectory, mode: 0o755 });
        steps.push({ kind: "copy", from: run.copyFrom, to: layout.executable, mode: 0o755 });
      }
      steps.push({ kind: "write", path: layout.definition, content: serviceDefinition({ platform, program, env }).content, mode: 0o644 });
      steps.push({ kind: "run", command: "systemctl", args: ["daemon-reload"] });
      steps.push({ kind: "run", command: "systemctl", args: ["enable", "kin.service"] });
      steps.push({ kind: "run", command: "systemctl", args: ["restart", "kin.service"] });
      notes.push(`Kin runs as the "${LINUX_ACCOUNT}" account and keeps its data in ${layout.dataDirectory}. Check it with: systemctl status kin; journalctl -u kin`);
    } else {
      steps.push({ kind: "run", command: "systemctl", args: ["disable", "--now", "kin.service"], allowFailure: true });
      steps.push({ kind: "remove", path: layout.definition });
      steps.push({ kind: "run", command: "systemctl", args: ["daemon-reload"], allowFailure: true });
      if (sea) steps.push({ kind: "remove", path: layout.installDirectory, recursive: true });
      notes.push(keep, `The "${LINUX_ACCOUNT}" account was kept too, so the data keeps its owner (remove it with: userdel ${LINUX_ACCOUNT}).`);
    }
    return { steps, notes, layout };
  }

  if (platform === "darwin") {
    const account = user ?? env.SUDO_USER ?? null;
    if (action === "install") {
      if (!account || account === "root")
        throw new ServiceInstallError("Run the install with sudo from the account Kin should run as, or name it with --user. Kin doesn't run as root.");
      if (sea) {
        steps.push({ kind: "mkdir", path: layout.installDirectory, mode: 0o755 });
        steps.push({ kind: "copy", from: run.copyFrom, to: layout.executable, mode: 0o755 });
        // The copy keeps the download's quarantine flag, which would stop
        // launchd from starting an unsigned program. The person already chose
        // to open this one (docs/HOME-SERVER.md, unsigned builds).
        steps.push({ kind: "run", command: "xattr", args: ["-d", "com.apple.quarantine", layout.executable], allowFailure: true });
      }
      for (const path of [layout.dataDirectory, layout.appCache, layout.logDirectory]) {
        steps.push({ kind: "mkdir", path, mode: 0o700 });
        steps.push({ kind: "run", command: "chown", args: [account, path] });
      }
      steps.push({ kind: "write", path: layout.definition, content: serviceDefinition({ platform, program, env, user: account }).content, mode: 0o644 });
      steps.push({ kind: "run", command: "launchctl", args: ["bootout", `system/${LAUNCHD_LABEL}`], allowFailure: true });
      steps.push({ kind: "run", command: "launchctl", args: ["bootstrap", "system", layout.definition] });
      notes.push(`Kin runs as ${account} and keeps its data in ${layout.dataDirectory}. Its log is ${posix.join(layout.logDirectory, "kin.log")}.`);
    } else {
      steps.push({ kind: "run", command: "launchctl", args: ["bootout", `system/${LAUNCHD_LABEL}`], allowFailure: true });
      steps.push({ kind: "remove", path: layout.definition });
      if (sea) steps.push({ kind: "remove", path: layout.installDirectory, recursive: true });
      notes.push(keep);
    }
    return { steps, notes, layout };
  }

  // Windows: the scheduled-task fallback (see the top of this file).
  if (action === "install") {
    for (const path of [layout.dataDirectory, layout.appCache]) {
      steps.push({ kind: "mkdir", path });
      // Only LOCAL SERVICE (which runs Kin), SYSTEM and Administrators.
      steps.push({ kind: "run", command: "icacls", args: [path, "/inheritance:r", "/grant:r", `${SYSTEM}:(OI)(CI)F`, `${ADMINISTRATORS}:(OI)(CI)F`, `${LOCAL_SERVICE}:(OI)(CI)M`] });
    }
    if (sea) {
      steps.push({ kind: "mkdir", path: layout.installDirectory });
      steps.push({ kind: "copy", from: run.copyFrom, to: layout.executable });
    }
    steps.push({ kind: "task", content: serviceDefinition({ platform, program, env }).content });
    steps.push({ kind: "run", command: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK_NAME] });
    notes.push(`Kin starts with Windows as the LOCAL SERVICE account and keeps its data in ${layout.dataDirectory}. Its log is ${layout.logFile}.`);
  } else {
    steps.push({ kind: "run", command: "schtasks", args: ["/End", "/TN", WINDOWS_TASK_NAME], allowFailure: true });
    steps.push({ kind: "run", command: "schtasks", args: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], allowFailure: true });
    // Windows can't delete a running program: uninstalling from the
    // installed copy itself leaves that folder for the person to delete.
    if (sea) steps.push({ kind: "remove", path: layout.installDirectory, recursive: true, allowFailure: true });
    notes.push(keep);
  }
  return { steps, notes, layout };
}

// --- Carrying a plan out ---------------------------------------------------

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return { code: result.error ? -1 : result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

function defaultIsAdmin(platform, run) {
  if (platform === "win32") return run("net", ["session"]).code === 0;
  return process.getuid?.() === 0;
}

/** Carries out a plan's steps in order; stops at the first failure. */
export function executePlan(plan, { run = defaultRun, isAdmin = defaultIsAdmin, log = () => {}, fs = { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } } = {}) {
  for (const step of plan.steps) {
    switch (step.kind) {
      case "admin":
        if (!isAdmin(step.platform, run))
          throw new ServiceInstallError(step.platform === "win32"
            ? "Installing a service needs an administrator. Open the command prompt with \"Run as administrator\" and try again."
            : "Installing a service needs admin rights. Run the same command with sudo.");
        break;
      case "require":
        if (!fs.existsSync(step.path)) throw new ServiceInstallError(step.message);
        break;
      case "mkdir":
        log(`Creating ${step.path}`);
        fs.mkdirSync(step.path, { recursive: true, ...(step.mode ? { mode: step.mode } : {}) });
        if (step.mode) fs.chmodSync(step.path, step.mode);
        break;
      case "copy": {
        // Copied beside the target and renamed over it, so reinstalling over
        // a running copy works and a failed copy leaves the old one.
        log(`Installing ${step.to}`);
        const next = `${step.to}.new`;
        fs.copyFileSync(step.from, next);
        if (step.mode) fs.chmodSync(next, step.mode);
        fs.renameSync(next, step.to);
        break;
      }
      case "write":
        log(`Writing ${step.path}`);
        fs.writeFileSync(step.path, step.content, { mode: step.mode });
        if (step.mode) fs.chmodSync(step.path, step.mode);
        break;
      case "remove":
        log(`Removing ${step.path}`);
        try {
          fs.rmSync(step.path, { recursive: step.recursive === true, force: true });
        } catch (error) {
          if (!step.allowFailure) throw error;
          log(`Couldn't remove ${step.path} (${error.code ?? error.message}); delete it yourself once Kin has stopped.`);
        }
        break;
      case "task": {
        // schtasks reads the definition from a file, in UTF-16 with a BOM.
        const file = join(tmpdir(), `kin-task-${randomBytes(6).toString("hex")}.xml`);
        fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(step.content, "utf16le")]));
        try {
          log(`Registering the scheduled task ${WINDOWS_TASK_NAME}`);
          const result = run("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", file, "/F"]);
          if (result.code !== 0) throw new ServiceInstallError(`schtasks /Create failed: ${(result.stderr || result.stdout).trim()}`);
        } finally {
          fs.rmSync(file, { force: true });
        }
        break;
      }
      case "run": {
        if (step.unless && run(step.unless.command, step.unless.args).code === 0) break;
        log(`Running ${step.command} ${step.args.join(" ")}`);
        const result = run(step.command, step.args);
        if (result.code !== 0 && !step.allowFailure)
          throw new ServiceInstallError(`${step.command} ${step.args.join(" ")} failed${result.stderr || result.stdout ? `: ${(result.stderr || result.stdout).trim()}` : "."}`);
        break;
      }
      default:
        throw new ServiceInstallError(`Unknown install step ${step.kind}.`);
    }
  }
}

/** The launcher's --print-service, --install-service and --uninstall-service. */
export async function runServiceCommand(options, { program, env = process.env, platform = process.platform, stdout = process.stdout, run, isAdmin, fs } = {}) {
  if (options.command === "print-service") {
    const user = platform === "darwin" ? options.user ?? env.SUDO_USER ?? env.USER ?? null : null;
    const definition = serviceDefinition({ platform, program, env, user });
    stdout.write(`# ${definition.path}\n${definition.content}`);
    return 0;
  }
  const plan = servicePlan(options.command === "install-service" ? "install" : "uninstall", { platform, program, env, user: options.user });
  executePlan(plan, { run, isAdmin, fs, log: (line) => stdout.write(`${line}\n`) });
  stdout.write(`${options.command === "install-service" ? "Kin is installed as a service." : "The Kin service is removed."}\n`);
  for (const note of plan.notes) stdout.write(`${note}\n`);
  return 0;
}
