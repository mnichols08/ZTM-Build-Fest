// The launcher (server/launcher.mjs, #713): its command line, the health
// check, supervising the service and its log file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkHealth, healthUrl, LauncherUsageError, parseLauncherArguments, runLauncher, runService } from "./launcher.mjs";
import { APP_ROOT } from "./permissions.mjs";
import { canonicalPath } from "./path-safety.mjs";

function temporary(t) {
  const directory = canonicalPath(mkdtempSync(join(tmpdir(), "kin-launcher-")));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

test("the command line takes one command and the options that belong to it", { timeout: 60_000 }, () => {
  const parse = parseLauncherArguments;
  assert.deepEqual(parse([]), { command: "run", supervise: false, stopOnStdinClose: false, logFile: null, user: null, platform: null, adminArgs: [] });
  assert.equal(parse(["--install-service"]).command, "install-service");
  assert.equal(parse(["--uninstall-service"]).command, "uninstall-service");
  assert.equal(parse(["--health"]).command, "health");
  assert.equal(parse(["-h"]).command, "help");
  assert.deepEqual(parse(["--print-service", "--platform", "win32"]), { command: "print-service", supervise: false, stopOnStdinClose: false, logFile: null, user: null, platform: "win32", adminArgs: [] });
  assert.equal(parse(["--print-service", "--platform=darwin", "--user=mikey"]).user, "mikey");
  assert.deepEqual(parse(["--supervise", "--log-file", "C:\\Kin\\kin.log"]), { command: "run", supervise: true, stopOnStdinClose: false, logFile: "C:\\Kin\\kin.log", user: null, platform: null, adminArgs: [] });
  assert.deepEqual(parse(["admin", "backup", "--to", "x"]).adminArgs, ["backup", "--to", "x"]);
  // The Windows service host's command line (server/service-install.mjs).
  assert.equal(parse(["--stop-on-stdin-close", "--log-file", "C:\\Kin\\kin.log"]).stopOnStdinClose, true);

  for (const [argv, message] of [
    [["--install-service", "--uninstall-service"], /one command/],
    [["--bogus"], /Unknown argument "--bogus"/],
    [["serve"], /Unknown argument "serve"/],
    [["--log-file"], /needs a value/],
    [["--log-file", "--supervise"], /needs a value/],
    [["--log-file="], /needs a path/],
    [["--health", "--supervise"], /for running Kin/],
    [["--version", "--stop-on-stdin-close"], /for running Kin/],
    [["--stop-on-stdin-close=1"], /Unknown argument/],
    [["--user", "mikey"], /--user is for/],
    [["--install-service", "--user", "bad name"], /isn't an account name/],
    [["--platform", "linux"], /--platform is for --print-service/],
    [["--print-service", "--platform", "beos"], /must be one of/],
    [["--health=1"], /Unknown argument/],
  ])
    assert.throws(() => parse(argv), (error) => error instanceof LauncherUsageError && message.test(error.message), argv.join(" "));
});

test("the health check asks the service's own listener", { timeout: 60_000 }, async (t) => {
  assert.equal(healthUrl({}), "http://127.0.0.1:8000/health");
  assert.equal(healthUrl({ KIN_HOST: "::1", KIN_PORT: "9000" }), "http://[::1]:9000/health");
  assert.equal(healthUrl({ KIN_HOST: "localhost", KIN_PORT: "8080" }), "http://localhost:8080/health");

  let healthy = true;
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/health" && healthy ? 200 : 503).end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = { KIN_HOST: "127.0.0.1", KIN_PORT: String(server.address().port) };
  assert.equal(await checkHealth(env), 0);
  healthy = false;
  assert.equal(await checkHealth(env), 1);
  assert.equal(await checkHealth({ KIN_HOST: "127.0.0.1", KIN_PORT: "1" }), 1, "nothing listening");
  assert.equal(await checkHealth(env, () => Promise.reject(new Error("timeout"))), 1);
});

// A child process stand-in whose exits the test scripts.
function fakeSpawn(exitCodes) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => { child.killedWith = signal; setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); }); };
    calls.push({ command, args, options, child });
    const code = exitCodes[calls.length - 1];
    if (code !== undefined) setImmediate(() => { child.exitCode = code; child.emit("exit", code, null); });
    return child;
  };
  return { spawnImpl, calls };
}

test("a supervised service that fails is started again; a stop ends supervision", { timeout: 20_000 }, async (t) => {
  const root = temporary(t);
  const env = { KIN_DATA_DIR: join(root, "data") };
  const { spawnImpl, calls } = fakeSpawn([1]);
  const signals = new EventEmitter();
  const serviceProcess = ({ flags, env: serviceEnv }) => ({ command: "kin-service", args: flags, env: serviceEnv });
  const running = runService({ serviceProcess, env, supervise: true, spawnImpl, signals, platform: "linux" });
  // The first run fails; the second starts after the one-second delay.
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.equal(calls.length, 2);
  for (const { options, args } of calls) {
    assert.equal(options.stdio[0], "pipe", "the service's stdin is held open");
    assert.equal(options.env.KIN_STOP_WITH_LAUNCHER, "1");
    assert.equal(options.env.KIN_DATABASE_PATH, join(root, "data", "kin.sqlite"));
    assert.equal(args[0], "--permission");
  }
  if (process.platform !== "win32") assert.equal(statSync(join(root, "data")).mode & 0o777, 0o700);
  signals.emit("SIGTERM");
  assert.equal(await running, 0);
  assert.equal(calls[1].child.killedWith, "SIGTERM");
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("without supervision the launcher exits with the service's code", { timeout: 60_000 }, async (t) => {
  const root = temporary(t);
  const { spawnImpl, calls } = fakeSpawn([3]);
  const code = await runService({ serviceProcess: ({ env }) => ({ command: "kin-service", args: [], env }), env: { KIN_DATA_DIR: join(root, "data") }, spawnImpl, signals: new EventEmitter() });
  assert.equal(code, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.stdio[0], "inherit");
  assert.equal(calls[0].options.env.KIN_STOP_WITH_LAUNCHER, undefined);
});

// A stdin the test closes, as the service host closes the launcher's.
function fakeStdin() {
  const stdin = new EventEmitter();
  stdin.paused = true;
  stdin.resume = () => { stdin.paused = false; return stdin; };
  stdin.pause = () => { stdin.paused = true; return stdin; };
  return stdin;
}

test("--stop-on-stdin-close: the end of stdin closes the service's stdin and the launcher exits with its code", { timeout: 20_000 }, async (t) => {
  const root = temporary(t);
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    // The service closes its database when its stdin ends, then exits 0.
    child.stdin = { end: () => { child.stdinEnded = true; setImmediate(() => { child.exitCode = 0; child.emit("exit", 0, null); }); } };
    child.kill = (signal) => { child.killedWith = signal; };
    calls.push({ command, args, options, child });
    return child;
  };
  const stdin = fakeStdin();
  const signals = new EventEmitter();
  const running = runService({ serviceProcess: ({ env }) => ({ command: "kin-service", args: [], env }), env: { KIN_DATA_DIR: join(root, "data") }, stopOnStdinClose: true, spawnImpl, signals, stdin, platform: "win32" });
  assert.equal(stdin.paused, false, "the launcher reads its stdin");
  assert.equal(calls[0].options.stdio[0], "pipe");
  assert.equal(calls[0].options.env.KIN_STOP_WITH_LAUNCHER, "1");
  stdin.emit("end");
  assert.equal(await running, 0);
  assert.equal(calls[0].child.stdinEnded, true);
  assert.equal(calls[0].child.killedWith, undefined, "nothing is killed on Windows");
  assert.equal(calls.length, 1);
  assert.equal(stdin.paused, true, "a finished launcher stops reading");
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("--stop-on-stdin-close: a service that fails on its own ends the launcher, for the host to restart", { timeout: 20_000 }, async (t) => {
  const root = temporary(t);
  const { spawnImpl, calls } = fakeSpawn([5]);
  const stdin = fakeStdin();
  const code = await runService({ serviceProcess: ({ env }) => ({ command: "kin-service", args: [], env }), env: { KIN_DATA_DIR: join(root, "data") }, stopOnStdinClose: true, spawnImpl, signals: new EventEmitter(), stdin, platform: "win32" });
  assert.equal(code, 5);
  assert.equal(calls.length, 1);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.listenerCount("error"), 0);
});

test("--log-file appends the service's output to an owner-only file and rotates a large one", { timeout: 20_000 }, async (t) => {
  const root = temporary(t);
  const log = join(root, "logs", "kin.log");
  const serviceProcess = ({ env }) => ({ command: process.execPath, args: ["-e", "console.log('hello from the service'); console.error('and its errors')"], env });
  assert.equal(await runService({ serviceProcess, env: { ...process.env, KIN_DATA_DIR: join(root, "data") }, logFile: log }), 0);
  assert.equal(await runService({ serviceProcess, env: { ...process.env, KIN_DATA_DIR: join(root, "data") }, logFile: log }), 0);
  const text = readFileSync(log, "utf8");
  assert.equal(text.match(/hello from the service/g).length, 2);
  assert.match(text, /and its errors/);
  if (process.platform !== "win32") assert.equal(statSync(log).mode & 0o777, 0o600);
  writeFileSync(log, Buffer.alloc(10 * 1024 * 1024 + 1, 0x2e));
  assert.equal(await runService({ serviceProcess, env: { ...process.env, KIN_DATA_DIR: join(root, "data") }, logFile: log }), 0);
  assert.equal(statSync(`${log}.1`).size, 10 * 1024 * 1024 + 1);
  assert.match(readFileSync(log, "utf8"), /^hello from the service/);
});

test("a configuration problem stops the launcher before it starts anything", { timeout: 60_000 }, async () => {
  const { spawnImpl, calls } = fakeSpawn([]);
  const code = await runService({ serviceProcess: () => assert.fail("not started"), env: { KIN_MODE: "office" }, spawnImpl, signals: new EventEmitter() });
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
  // A database inside the web root is refused too (path-safety.mjs).
  assert.equal(await runService({ serviceProcess: () => assert.fail("not started"), env: { KIN_DATABASE_PATH: join(APP_ROOT, "web", "kin.sqlite") }, spawnImpl, signals: new EventEmitter() }), 1);
  assert.equal(calls.length, 0);
});

test("runLauncher answers --help, --version and usage errors", { timeout: 60_000 }, async () => {
  const output = () => { const chunks = []; return { write: (chunk) => chunks.push(chunk), text: () => chunks.join("") }; };
  const stdout = output();
  const stderr = output();
  assert.equal(await runLauncher(["--version"], { version: "9.8.7", stdout, stderr }), 0);
  assert.equal(stdout.text(), "9.8.7\n");
  assert.equal(await runLauncher(["--help"], { version: "x", stdout, stderr }), 0);
  assert.match(stdout.text(), /--install-service/);
  assert.equal(await runLauncher(["--nope"], { version: "x", stdout, stderr }), 2);
  assert.match(stderr.text(), /Unknown argument "--nope"[\s\S]*Usage:/);
});

test("server/start.mjs prints the service definition for this checkout", { timeout: 60_000 }, () => {
  const run = (args) => spawnSync(process.execPath, [join(APP_ROOT, "server", "start.mjs"), ...args], { encoding: "utf8", timeout: 30_000 });
  const unit = run(["--print-service", "--platform", "linux"]);
  assert.equal(unit.status, 0, unit.stderr);
  assert.match(unit.stdout, /^# \/etc\/systemd\/system\/kin\.service\n/);
  assert.ok(unit.stdout.includes(join(APP_ROOT, "server", "start.mjs").replaceAll("\\", "\\\\")) || unit.stdout.includes(join(APP_ROOT, "server", "start.mjs")));
  assert.equal(run(["--version"]).stdout.trim(), JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")).version);
  const usage = run(["--nope"]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage: kin/);
});
