// Kin's single executable (#714, ADR 0025 §10): the build script's options
// and contents and, on Linux, a full build that is reproducible and runs:
// it serves the app and the engine in home mode, inside the permission
// model, from its unpacked and checked app files.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appManifest, BuildSeaError, buildSea, collectAppFiles, DEFAULT_TARGETS, parseBuildArguments, PROJECT_ROOT } from "./build-sea.mjs";
import { readElf } from "./sea/elf.mjs";
import { SEA_FUSE } from "./sea/fuse.mjs";
import { hostTarget } from "./sea/node-release.mjs";

const WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;

function temporary(t, prefix = "kin-sea-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}

test("the build takes the Linux targets and explains the ones that aren't built yet", { timeout: 60_000 }, () => {
  assert.deepEqual(DEFAULT_TARGETS, ["linux-x64", "linux-arm64"]);
  const options = parseBuildArguments(["--target", "linux-arm64", "--node-binary", "node-arm64", "--node-version", "v24.22.0", "--measure"]);
  assert.deepEqual(options.targets, ["linux-arm64"]);
  assert.equal(options.nodeVersion, "24.22.0");
  assert.equal(options.measure, true);
  assert.equal(parseBuildArguments([]).nodeVersion, process.version.slice(1));
  for (const [argv, message] of [
    [["--target", "darwin-arm64"], /#747/],
    [["--target", "darwin-x64"], /#747/],
    [["--target", "win-x64"], /#748/],
    [["--target", "linux-riscv64"], /Unknown target/],
    [["--target", "linux-x64,linux-x64"], /listed twice/],
    [["--node-binary", "node"], /single --target/],
    [["--node-version", "24"], /isn't a node version/],
    [["--sign"], /Unknown argument/],
  ])
    assert.throws(() => parseBuildArguments(argv), (error) => error instanceof BuildSeaError && message.test(error.message), argv.join(" "));
});

test("the executable holds the server, the web app, package.json and the engine, not tests", { timeout: 60_000 }, (t) => {
  const wasm = join(temporary(t), "engine.wasm");
  writeFileSync(wasm, WASM);
  const files = collectAppFiles({ wasm });
  const paths = files.map(({ path }) => path);
  for (const path of ["package.json", "server/server.mjs", "server/launcher.mjs", "server/permissions.mjs", "server/durable-store/schema.mjs", "web/index.html", "web/wasm/kin-engine.js", "web/wasm/kin_engine.wasm", "server/home/tunnel-client.mjs", "relay/ktun.mjs"])
    assert.ok(paths.includes(path), path);
  assert.ok(!paths.some((path) => path.endsWith(".test.mjs")), "no tests");
  assert.deepEqual(paths.filter((path) => path.startsWith("relay/")), ["relay/ktun.mjs"], "of the relay, only the codec the tunnel shares");
  assert.ok(!paths.some((path) => path.startsWith("server/test-fixtures/") || path.endsWith("-test-utils.mjs")), "no test helpers");
  assert.deepEqual(paths, [...paths].sort((left, right) => (left < right ? -1 : 1)), "sorted byte-wise");
  assert.equal(files.find(({ path }) => path === "web/wasm/kin_engine.wasm").source, wasm);
  assert.throws(() => collectAppFiles({ wasm: join(tmpdir(), "no-such-engine.wasm") }), /build-wasm\.sh/);

  const loaded = [{ path: "a", bytes: Buffer.from("1") }, { path: "b", bytes: Buffer.from("22") }];
  const manifest = appManifest(loaded, { version: "1.2.3", nodeVersion: "24.22.0" });
  assert.deepEqual(manifest.files, [{ path: "a", size: 1, sha256: sha256("1") }, { path: "b", size: 2, sha256: sha256("22") }]);
  assert.equal(appManifest(loaded, { version: "1.2.3", nodeVersion: "24.22.0" }).bundle, manifest.bundle);
  assert.notEqual(appManifest([loaded[0], { path: "b", bytes: Buffer.from("23") }], { version: "1.2.3", nodeVersion: "24.22.0" }).bundle, manifest.bundle);
});

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

function start(executable, env) {
  const child = spawn(executable, [], { env: { ...process.env, NODE_OPTIONS: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      const line = output.split("\n").find((entry) => entry.includes('"service_ready"'));
      if (line) resolve(JSON.parse(line));
    };
    child.stdout.setEncoding("utf8").on("data", onData);
    child.stderr.setEncoding("utf8").on("data", onData);
    child.once("exit", (code) => reject(new Error(`exited with ${code}: ${output}`)));
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return; }
    child.removeAllListeners("exit");
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
  return { child, ready, stop, output: () => output };
}

test("on Linux the executable builds reproducibly and serves Kin in home mode inside the sandbox", { timeout: 110_000 }, async (t) => {
  const target = hostTarget();
  if (process.platform !== "linux") { t.skip("builds and runs only on Linux"); return; }
  let base;
  try {
    base = readFileSync(process.execPath);
    readElf(base);
  } catch {
    t.skip("this machine's node isn't an ELF executable");
    return;
  }
  if (process.platform !== "linux" || !DEFAULT_TARGETS.includes(target)) { t.skip("builds and runs only on Linux x64 and arm64"); return; }
  if (!base.includes(Buffer.from(SEA_FUSE))) { t.skip("this node was built without SEA support"); return; }

  const root = temporary(t);
  const wasm = join(root, "kin_engine.wasm");
  writeFileSync(wasm, WASM);
  const build = (out) => buildSea({ ...parseBuildArguments(["--target", target, "--node-binary", process.execPath, "--wasm", wasm, "--out", out]), work: join(root, "work") }, { log: () => {} });
  const info = await build(join(root, "one"));
  const again = await build(join(root, "two"));
  const file = `kin-${VERSION}-${target}`;
  const executable = join(root, "one", file);
  const bytes = readFileSync(executable);

  // Reproducible, and recorded.
  assert.equal(sha256(readFileSync(join(root, "two", file))), sha256(bytes));
  assert.deepEqual(again, info);
  assert.equal(readFileSync(join(root, "one", "SHA256SUMS"), "utf8"), `${sha256(bytes)}  ${file}\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "one", "build-info.json"), "utf8")), info);
  assert.equal(info.version, VERSION);
  assert.equal(info.targets[0].size, bytes.length);
  assert.equal(info.targets[0].node.sha256, sha256(base));
  assert.ok(bytes.includes(Buffer.from(`${SEA_FUSE}:1`)), "the fuse is flipped");

  const run = (args, env = {}) => spawnSync(executable, args, { encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "", ...env } });
  assert.equal(run(["--version"]).stdout, `${VERSION}\n`);

  const cache = join(root, "cache");
  const port = await freePort();
  // No KIN_MODE: the executable is the home server.
  const env = { KIN_MODE: "", KIN_DATA_DIR: join(root, "data"), KIN_APP_CACHE: cache, KIN_PORT: String(port) };
  const service = start(executable, env);
  t.after(service.stop);
  const ready = await service.ready;
  assert.deepEqual(ready, { event: "service_ready", origin: `http://localhost:${port}`, mode: "home" });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  assert.deepEqual(Buffer.from(await (await fetch(`http://127.0.0.1:${port}/wasm/kin_engine.wasm`)).arrayBuffer()), WASM);
  assert.equal(run(["--health"], env).status, 0);
  // The service is a second process, started with the permission model in
  // NODE_OPTIONS (server.mjs also refuses to serve without it).
  const children = readFileSync(`/proc/${service.child.pid}/task/${service.child.pid}/children`, "utf8").trim().split(/\s+/);
  assert.equal(children.length, 1);
  const serviceEnv = readFileSync(`/proc/${children[0]}/environ`, "latin1").split("\0");
  const nodeOptions = serviceEnv.find((entry) => entry.startsWith("NODE_OPTIONS="));
  assert.match(nodeOptions, /--permission /);
  assert.ok(nodeOptions.includes(`--allow-fs-write=${join(root, "data")}`), nodeOptions);
  assert.ok(serviceEnv.includes("KIN_SEA_ROLE=service"));
  assert.equal(await service.stop(), 0);
  assert.equal(run(["--health"], env).status, 1);
  assert.ok(existsSync(join(root, "data", "kin.sqlite")));

  // The unpacked app is checked on every start: a changed file is replaced.
  const unpacked = run(["--prepare"], env).stdout.trim();
  assert.equal(unpacked, join(cache, `app-${info.bundle.slice(0, 16)}`));
  const server = join(unpacked, "server", "server.mjs");
  const original = readFileSync(server);
  appendFileSync(server, "\nthrow new Error('tampered');\n");
  assert.equal(run(["--prepare"], env).status, 0);
  assert.deepEqual(readFileSync(server), original);

  // Home mode is the executable's default, with its refusals.
  const refused = run([], { ...env, KIN_ANDROID_PACKAGE: "io.example.kin" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr + refused.stdout, /home_mode_setting_refused/);
  assert.match(run(["--print-service", "--platform", "linux"], env).stdout, /^ExecStart=\/usr\/local\/lib\/kin\/kin$/m);
});
