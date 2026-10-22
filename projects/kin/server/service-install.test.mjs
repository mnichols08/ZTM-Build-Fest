// Running Kin as a service (#716, ADR 0025 §10): the generated systemd unit,
// launchd plist and Windows scheduled task, the install and uninstall plans
// (uninstall never touches the data directory) and carrying a plan out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APP_ROOT } from "./permissions.mjs";
import {
  executePlan, LAUNCHD_PLIST_PATH, launchdPlist, scheduledTaskXml, ServiceInstallError, serviceDefinition,
  serviceLayout, servicePlan, SYSTEMD_UNIT_PATH, systemdUnit, systemdWord, windowsArgument,
} from "./service-install.mjs";

const SEA = { kind: "sea", executable: "/home/mikey/Downloads/kin-1.6.0-linux-x64" };
const NODE = { kind: "node", command: "/usr/bin/node", args: ["/opt/kin app/server/start.mjs"] };
const WINDOWS_ENV = { ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files" };

// XML comments may not contain "--" (a parser rejects the whole file).
function assertXmlComments(text) {
  for (const [, body] of text.matchAll(/<!--([\s\S]*?)-->/g)) assert.ok(!body.includes("--"), `comment holds "--": ${body}`);
}

test("systemd words are quoted and escaped as systemd reads them", { timeout: 60_000 }, () => {
  assert.equal(systemdWord("/usr/local/lib/kin/kin"), "/usr/local/lib/kin/kin");
  assert.equal(systemdWord("/opt/kin app/start.mjs"), '"/opt/kin app/start.mjs"');
  assert.equal(systemdWord("50%"), "50%%");
  assert.equal(systemdWord("$HOME"), '"$$HOME"');
  assert.equal(systemdWord('a"b\\c'), '"a\\"b\\\\c"');
});

test("the systemd unit runs Kin as the kin account, hardened, restarting on failure", { timeout: 60_000 }, () => {
  const unit = systemdUnit({ execStart: ["/usr/local/lib/kin/kin"], sea: true });
  for (const line of [
    "User=kin", "Group=kin", "ExecStart=/usr/local/lib/kin/kin", "Environment=KIN_MODE=home", "Environment=KIN_DATA_DIR=/var/lib/kin",
    "StateDirectory=kin", "StateDirectoryMode=0700", "CacheDirectory=kin", "UMask=0077", "Restart=on-failure", "NoNewPrivileges=yes",
    "ProtectSystem=strict", "ProtectHome=yes", "WantedBy=multi-user.target", "After=network-online.target",
  ])
    assert.ok(unit.split("\n").includes(line), line);
  assert.ok(!/^MemoryDenyWriteExecute=/m.test(unit), "V8's JIT needs writable code");
  const node = systemdUnit({ execStart: [NODE.command, ...NODE.args], sea: false });
  assert.ok(node.includes('ExecStart=/usr/bin/node "/opt/kin app/server/start.mjs"'));
  assert.ok(node.includes("ProtectHome=read-only"));
  assert.ok(!node.includes("CacheDirectory="));
});

test("systemd accepts the unit", { timeout: 60_000 }, (t) => {
  if (process.platform !== "linux") { t.skip("systemd is Linux only"); return; }
  const analyze = spawnSync("systemd-analyze", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (analyze.status !== 0) { t.skip("systemd-analyze isn't available"); return; }
  const directory = mkdtempSync(join(tmpdir(), "kin-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "kin.service");
  // A node install's ExecStart names files that exist here.
  writeFileSync(path, serviceDefinition({ platform: "linux", program: { kind: "node", command: process.execPath, args: [join(APP_ROOT, "server", "start.mjs")] } }).content);
  const result = spawnSync("systemd-analyze", ["verify", path], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split("\n").filter((line) => line.includes("kin.service")).join("\n"), "");
});

test("the LaunchDaemon plist starts Kin at boot as the installing user", { timeout: 60_000 }, () => {
  const plist = launchdPlist({
    programArguments: ["/usr/local/libexec/kin/kin"],
    userName: "mikey",
    environment: { KIN_MODE: "home", KIN_DATA_DIR: "/Library/Application Support/Kin & Co" },
    logPath: "/Library/Logs/Kin/kin.log",
  });
  assertXmlComments(plist);
  assert.match(plist, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(plist, /<key>Label<\/key>\n {2}<string>io\.journeytocode\.kin<\/string>/);
  assert.match(plist, /<key>UserName<\/key>\n {2}<string>mikey<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n {2}<true\/>/);
  assert.match(plist, /<key>Umask<\/key>\n {2}<integer>63<\/integer>/);
  assert.ok(plist.includes("<string>/Library/Application Support/Kin &amp; Co</string>"));
  const python = process.platform === "win32" ? { status: null } : spawnSync("python3", ["-I", "-c", "import plistlib,sys,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))"], { input: plist, encoding: "utf8", timeout: 20_000 });
  // Not on Windows: "python3" there can be the Microsoft Store stub.
  if (process.platform !== "win32" && python.status === 0) {
    const parsed = JSON.parse(python.stdout);
    assert.deepEqual(parsed.ProgramArguments, ["/usr/local/libexec/kin/kin"]);
    assert.equal(parsed.EnvironmentVariables.KIN_DATA_DIR, "/Library/Application Support/Kin & Co");
  }
});

test("Windows arguments are quoted as CommandLineToArgvW reads them", { timeout: 60_000 }, () => {
  assert.equal(windowsArgument("--supervise"), "--supervise");
  assert.equal(windowsArgument("C:\\ProgramData\\Kin\\logs\\kin.log"), "C:\\ProgramData\\Kin\\logs\\kin.log");
  assert.equal(windowsArgument("C:\\Program Files\\Kin"), '"C:\\Program Files\\Kin"');
  assert.equal(windowsArgument("C:\\Program Files\\Kin\\"), '"C:\\Program Files\\Kin\\\\"');
  assert.equal(windowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.equal(windowsArgument(""), '""');
});

test("the scheduled task starts at boot as LOCAL SERVICE with no time limit", { timeout: 60_000 }, () => {
  const task = scheduledTaskXml({ command: "C:\\Program Files\\Kin\\kin.exe", args: ["--supervise", "--log-file", "C:\\Data Dir\\kin.log"], workingDirectory: "C:\\ProgramData\\Kin" });
  assertXmlComments(task);
  assert.match(task, /<BootTrigger>\s*<Enabled>true<\/Enabled>/);
  assert.match(task, /<UserId>S-1-5-19<\/UserId>/);
  assert.match(task, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  // The default is three days, after which Windows would stop Kin.
  assert.match(task, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(task, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.ok(task.includes("<Command>C:\\Program Files\\Kin\\kin.exe</Command>"));
  assert.ok(task.includes("<Arguments>--supervise --log-file &quot;C:\\Data Dir\\kin.log&quot;</Arguments>"));
});

test("each platform's definition names its file and the program to run", { timeout: 60_000 }, () => {
  assert.equal(serviceDefinition({ platform: "linux", program: SEA }).path, SYSTEMD_UNIT_PATH);
  assert.match(serviceDefinition({ platform: "linux", program: SEA }).content, /^ExecStart=\/usr\/local\/lib\/kin\/kin$/m);
  const mac = serviceDefinition({ platform: "darwin", program: SEA, user: "mikey" });
  assert.equal(mac.path, LAUNCHD_PLIST_PATH);
  assert.ok(mac.content.includes("<string>/usr/local/libexec/kin/kin</string>"));
  assert.ok(mac.content.includes("<key>KIN_APP_CACHE</key>\n    <string>/Library/Caches/Kin</string>"));
  const windows = serviceDefinition({ platform: "win32", program: { kind: "sea", executable: "C:\\Users\\m\\Downloads\\kin.exe" }, env: WINDOWS_ENV });
  assert.ok(windows.content.includes("<Command>C:\\Program Files\\Kin\\kin.exe</Command>"));
  assert.ok(windows.content.includes("<Arguments>--supervise --log-file C:\\ProgramData\\Kin\\logs\\kin.log --app-cache C:\\ProgramData\\Kin-app</Arguments>"));
  assert.ok(windows.content.includes("<WorkingDirectory>C:\\ProgramData\\Kin</WorkingDirectory>"));
  const windowsNode = serviceDefinition({ platform: "win32", program: { kind: "node", command: "C:\\node\\node.exe", args: ["C:\\kin\\server\\start.mjs"] }, env: WINDOWS_ENV });
  assert.ok(windowsNode.content.includes("<Arguments>C:\\kin\\server\\start.mjs --supervise --log-file C:\\ProgramData\\Kin\\logs\\kin.log</Arguments>"));
  assert.throws(() => serviceLayout("aix"), ServiceInstallError);
  assert.throws(() => serviceDefinition({ platform: "linux", program: null }), ServiceInstallError);
});

// Every step that removes something, and the data directory it must spare.
function assertKeepsData(plan) {
  const data = plan.layout.dataDirectory;
  for (const step of plan.steps.filter(({ kind }) => kind === "remove")) {
    assert.ok(!data.startsWith(step.path), `${step.path} would remove ${data}`);
    assert.ok(!step.path.startsWith(data), `${step.path} is inside ${data}`);
  }
  assert.ok(!plan.steps.some(({ kind, args = [] }) => kind === "run" && args.some((arg) => arg.startsWith(data))), "no command touches the data");
  assert.ok(plan.notes.some((note) => note.includes(data) && note.includes("kept")));
}

test("Linux: install creates the account, copies the executable, writes the unit and starts it", { timeout: 60_000 }, () => {
  const plan = servicePlan("install", { platform: "linux", program: SEA });
  assert.deepEqual(plan.steps.map(({ kind, command, path, to }) => [kind, command ?? path ?? to ?? null]), [
    ["admin", null],
    ["require", "/run/systemd/system"],
    ["run", "useradd"],
    ["mkdir", "/usr/local/lib/kin"],
    ["copy", "/usr/local/lib/kin/kin"],
    ["write", SYSTEMD_UNIT_PATH],
    ["run", "systemctl"],
    ["run", "systemctl"],
    ["run", "systemctl"],
  ]);
  const user = plan.steps[2];
  assert.deepEqual(user.unless, { command: "id", args: ["-u", "kin"] });
  assert.ok(user.args.includes("--system") && user.args.at(-1) === "kin");
  assert.equal(plan.steps[4].from, SEA.executable);
  assert.deepEqual(plan.steps.slice(6).map(({ args }) => args.join(" ")), ["daemon-reload", "enable kin.service", "restart kin.service"]);
  // From a checkout, node runs Kin in place: nothing is copied.
  assert.ok(!servicePlan("install", { platform: "linux", program: NODE }).steps.some(({ kind }) => kind === "copy" || kind === "mkdir"));
});

test("Linux: uninstall stops and removes the service and the executable, never the data", { timeout: 60_000 }, () => {
  const plan = servicePlan("uninstall", { platform: "linux", program: SEA });
  assert.deepEqual(plan.steps.filter(({ kind }) => kind === "remove").map(({ path }) => path), [SYSTEMD_UNIT_PATH, "/usr/local/lib/kin"]);
  assert.deepEqual(plan.steps[1], { kind: "run", command: "systemctl", args: ["disable", "--now", "kin.service"], allowFailure: true });
  assertKeepsData(plan);
  assertKeepsData(servicePlan("uninstall", { platform: "linux", program: NODE }));
});

test("macOS: install runs Kin as the sudo user, never root, and uninstall keeps the data", { timeout: 60_000 }, () => {
  assert.throws(() => servicePlan("install", { platform: "darwin", program: SEA, env: {} }), /--user/);
  assert.throws(() => servicePlan("install", { platform: "darwin", program: SEA, env: { SUDO_USER: "root" } }), /doesn't run as root/);
  const plan = servicePlan("install", { platform: "darwin", program: SEA, env: { SUDO_USER: "mikey" } });
  const chowned = plan.steps.filter(({ command }) => command === "chown").map(({ args }) => args.join(" "));
  assert.deepEqual(chowned, ["mikey /Library/Application Support/Kin", "mikey /Library/Caches/Kin", "mikey /Library/Logs/Kin"]);
  assert.ok(plan.steps.some(({ kind, path, mode }) => kind === "mkdir" && path === "/Library/Application Support/Kin" && mode === 0o700));
  const written = plan.steps.find(({ kind }) => kind === "write");
  assert.equal(written.path, LAUNCHD_PLIST_PATH);
  assert.ok(written.content.includes("<string>mikey</string>"));
  assert.deepEqual(plan.steps.at(-1), { kind: "run", command: "launchctl", args: ["bootstrap", "system", LAUNCHD_PLIST_PATH] });
  assert.equal(servicePlan("install", { platform: "darwin", program: SEA, env: { SUDO_USER: "mikey" }, user: "kin" }).steps.find(({ command }) => command === "chown").args[0], "kin");
  assertKeepsData(servicePlan("uninstall", { platform: "darwin", program: SEA, env: {} }));
});

test("Windows: install limits the folders to LOCAL SERVICE and admins and registers the task; uninstall keeps the data", { timeout: 60_000 }, () => {
  const plan = servicePlan("install", { platform: "win32", program: { kind: "sea", executable: "C:\\Downloads\\kin.exe" }, env: WINDOWS_ENV });
  const acls = plan.steps.filter(({ command }) => command === "icacls");
  assert.deepEqual(acls.map(({ args }) => args[0]), ["C:\\ProgramData\\Kin", "C:\\ProgramData\\Kin-app"]);
  for (const { args } of acls)
    assert.deepEqual(args.slice(1), ["/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-19:(OI)(CI)M"]);
  assert.ok(plan.steps.some(({ kind, to }) => kind === "copy" && to === "C:\\Program Files\\Kin\\kin.exe"));
  assert.ok(plan.steps.find(({ kind }) => kind === "task").content.includes("<UserId>S-1-5-19</UserId>"));
  assert.deepEqual(plan.steps.at(-1), { kind: "run", command: "schtasks", args: ["/Run", "/TN", "Kin"] });
  const uninstall = servicePlan("uninstall", { platform: "win32", program: { kind: "sea", executable: "C:\\Program Files\\Kin\\kin.exe" }, env: WINDOWS_ENV });
  assert.deepEqual(uninstall.steps.filter(({ command }) => command === "schtasks").map(({ args }) => args[0]), ["/End", "/Delete"]);
  assert.equal(uninstall.steps.find(({ kind }) => kind === "remove").allowFailure, true);
  assertKeepsData(uninstall);
});

test("a plan is carried out in order: admin check, skips, allowed failures and files", { timeout: 60_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "kin-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source"), "executable");
  const commands = [];
  const run = (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "id") return { code: 0, stdout: "998\n", stderr: "" };
    if (command === "broken") return { code: 1, stdout: "", stderr: "it broke\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const plan = { steps: [
    { kind: "admin", platform: "linux" },
    { kind: "run", command: "useradd", args: ["kin"], unless: { command: "id", args: ["-u", "kin"] } },
    { kind: "mkdir", path: join(root, "lib", "kin"), mode: 0o755 },
    { kind: "copy", from: join(root, "source"), to: join(root, "lib", "kin", "kin"), mode: 0o755 },
    { kind: "write", path: join(root, "kin.service"), content: "[Unit]\n", mode: 0o644 },
    { kind: "run", command: "broken", args: ["--maybe"], allowFailure: true },
    { kind: "remove", path: join(root, "gone"), recursive: true },
  ] };
  assert.throws(() => executePlan(plan, { run, isAdmin: () => false }), /sudo/);
  assert.deepEqual(commands, []);
  const lines = [];
  executePlan(plan, { run, isAdmin: () => true, log: (line) => lines.push(line) });
  assert.deepEqual(commands, ["id -u kin", "broken --maybe"], "useradd is skipped when the account exists");
  assert.equal(readFileSync(join(root, "lib", "kin", "kin"), "utf8"), "executable");
  assert.ok(!existsSync(join(root, "lib", "kin", "kin.new")));
  assert.equal(readFileSync(join(root, "kin.service"), "utf8"), "[Unit]\n");
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "lib", "kin", "kin")).mode & 0o777, 0o755);
    assert.equal(statSync(join(root, "kin.service")).mode & 0o777, 0o644);
  }
  assert.ok(lines.some((line) => line.startsWith("Installing ")));
  assert.throws(() => executePlan({ steps: [{ kind: "run", command: "broken", args: [] }] }, { run, isAdmin: () => true }), { message: "broken failed: it broke" });
  assert.throws(() => executePlan({ steps: [{ kind: "require", path: join(root, "missing"), message: "no systemd" }] }, { run }), /no systemd/);
  mkdirSync(join(root, "busy"));
  const failingFs = { rmSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } };
  executePlan({ steps: [{ kind: "remove", path: join(root, "busy"), allowFailure: true }] }, { run, fs: failingFs, log: (line) => lines.push(line) });
  assert.ok(lines.at(-1).includes("Couldn't remove"));
  assert.throws(() => executePlan({ steps: [{ kind: "remove", path: join(root, "busy") }] }, { run, fs: failingFs }), /busy/);
});

test("the scheduled task is registered from a UTF-16 file that is removed afterwards", { timeout: 60_000 }, () => {
  let registered = null;
  const run = (command, args) => {
    const file = args[args.indexOf("/XML") + 1];
    const bytes = readFileSync(file);
    registered = { command, args, bom: [...bytes.subarray(0, 2)], text: bytes.subarray(2).toString("utf16le"), file };
    return { code: 0, stdout: "", stderr: "" };
  };
  executePlan({ steps: [{ kind: "task", content: "<Task/>" }] }, { run, isAdmin: () => true });
  assert.equal(registered.command, "schtasks");
  assert.deepEqual(registered.args.slice(0, 2), ["/Create", "/TN"]);
  assert.deepEqual(registered.bom, [0xff, 0xfe]);
  assert.equal(registered.text, "<Task/>");
  assert.ok(!existsSync(registered.file));
  assert.throws(() => executePlan({ steps: [{ kind: "task", content: "<Task/>" }] }, { run: () => ({ code: 1, stdout: "", stderr: "Access is denied." }) }), /Access is denied/);
});
