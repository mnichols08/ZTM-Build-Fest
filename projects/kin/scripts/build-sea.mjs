#!/usr/bin/env node
// Builds Kin's home server as one executable per platform: a Node single
// executable application (SEA) holding the server, the web app and the WASM
// engine (ADR 0025 §10, #714). No dependency: the blob is written into a
// copy of the official node binary by Kin's own injector, not postject.
//
//   node scripts/build-sea.mjs [--target LIST] [--node-binary PATH]
//                              [--node-version X.Y.Z] [--wasm PATH]
//                              [--out DIR] [--measure]
//
//   --target        comma-separated: linux-x64, linux-arm64 (default: both).
//                   darwin-arm64, darwin-x64 and win-x64 are not built yet:
//                   Mach-O (#747) and PE (#748) injection are follow-ups.
//   --node-binary   use this node binary (for a single target) instead of
//                   downloading the official one from nodejs.org.
//   --node-version  the node release to build on (default: the node running
//                   this script). The SEA blob is written by a node of that
//                   exact version: this one, or a given or downloaded binary
//                   this machine can run.
//   --wasm          the engine (default web/wasm/kin_engine.wasm; build it
//                   with build-wasm.sh or fetch it with scripts/fetch-wasm.mjs).
//   --out           output folder (default target/sea/dist).
//   --measure       also start the executable for this machine once from an
//                   empty cache and once more, and record the start times.
//
// Output, in --out: kin-<version>-<target>[.exe], SHA256SUMS and
// build-info.json. The build is reproducible: the same sources, engine and
// node binary give byte-identical executables (files are taken in sorted
// order, the blob has no code cache or snapshot, and the injector is
// deterministic). Downloaded node binaries are checked against the release's
// SHASUMS256.txt and their hashes recorded in build-info.json.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { injectElf, readElf } from "./sea/elf.mjs";
import { flipFuse } from "./sea/fuse.mjs";
import { downloadNode, hostTarget, TARGETS } from "./sea/node-release.mjs";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TARGETS = Object.freeze(["linux-x64", "linux-arm64"]);
const FOLLOW_UP = Object.freeze({ macho: "#747 (Mach-O injection for macOS)", pe: "#748 (PE injection for Windows)" });

export class BuildSeaError extends Error {
  constructor(message) {
    super(message);
    this.name = "BuildSeaError";
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseBuildArguments(argv) {
  const options = { targets: [...DEFAULT_TARGETS], nodeBinary: null, nodeVersion: process.version.slice(1), wasm: join(PROJECT_ROOT, "web", "wasm", "kin_engine.wasm"), out: join(PROJECT_ROOT, "target", "sea", "dist"), measure: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const name = argument.startsWith("--") && equals > 0 ? argument.slice(0, equals) : argument;
    const value = () => {
      if (equals > 0 && argument.startsWith("--")) return argument.slice(equals + 1);
      index += 1;
      if (index >= argv.length) throw new BuildSeaError(`${name} needs a value.`);
      return argv[index];
    };
    if (name === "--target") options.targets = value().split(",").map((target) => target.trim()).filter(Boolean);
    else if (name === "--node-binary") options.nodeBinary = resolve(value());
    else if (name === "--node-version") options.nodeVersion = value().replace(/^v/, "");
    else if (name === "--wasm") options.wasm = resolve(value());
    else if (name === "--out") options.out = resolve(value());
    else if (name === "--measure" && equals < 0) options.measure = true;
    else throw new BuildSeaError(`Unknown argument "${argument}".`);
  }
  if (!options.targets.length) throw new BuildSeaError("--target needs at least one target.");
  for (const target of options.targets) {
    if (!Object.hasOwn(TARGETS, target)) throw new BuildSeaError(`Unknown target "${target}". Targets: ${Object.keys(TARGETS).join(", ")}.`);
    const { format } = TARGETS[target];
    if (format !== "elf") throw new BuildSeaError(`${target} can't be built yet: it needs ${FOLLOW_UP[format]}.`);
  }
  if (new Set(options.targets).size !== options.targets.length) throw new BuildSeaError("A target is listed twice.");
  if (options.nodeBinary && options.targets.length !== 1) throw new BuildSeaError("--node-binary is for a single --target.");
  if (!/^\d+\.\d+\.\d+$/.test(options.nodeVersion)) throw new BuildSeaError(`"${options.nodeVersion}" isn't a node version.`);
  return options;
}

// What goes into the executable: the server and the web app (not their
// tests or test helpers), package.json (the version) and the engine.
const SKIP = [/\.test\.mjs$/, /^server\/test-fixtures\//, /^server\/[^/]*-test-utils\.mjs$/, /^server\/durable-restart-worker\.mjs$/, /^web\/wasm\/kin_engine\.wasm(\.sha256)?$/];

export function collectAppFiles({ root = PROJECT_ROOT, wasm }) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !SKIP.some((pattern) => pattern.test(path))) files.push({ path, source: join(root, ...path.split("/")) });
    }
  };
  visit("server");
  visit("web");
  files.push({ path: "package.json", source: join(root, "package.json") });
  if (!existsSync(wasm))
    throw new BuildSeaError(`The WASM engine ${wasm} is missing. Build it with build-wasm.sh (or build-wasm.ps1), or fetch this commit's with node scripts/fetch-wasm.mjs.`);
  files.push({ path: "web/wasm/kin_engine.wasm", source: wasm });
  // Byte order, not locale order, so every machine sorts alike.
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The app manifest the executable unpacks from (scripts/sea/main.cjs). */
export function appManifest(files, { version, nodeVersion }) {
  const entries = files.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) }));
  const bundle = sha256(entries.map(({ path, size, sha256: hash }) => `${path}\0${size}\0${hash}\n`).join(""));
  return { format: 1, name: "kin", version, node: nodeVersion, bundle, files: entries };
}

/** Writes the SEA blob for `files` with `generator` (a node of the target
 * version) and returns its bytes and the manifest. */
export function buildBlob({ files, version, nodeVersion, generator, workDirectory }) {
  rmSync(workDirectory, { recursive: true, force: true });
  mkdirSync(workDirectory, { recursive: true });
  const loaded = files.map(({ path, source }) => ({ path, bytes: readFileSync(source) }));
  const manifest = appManifest(loaded, { version, nodeVersion });
  // Paths in the configuration are relative to the work folder, so where
  // the checkout lives can't reach the blob.
  const assets = { "kin/manifest.json": "manifest.json" };
  writeFileSync(join(workDirectory, "manifest.json"), JSON.stringify(manifest));
  for (const { path, bytes } of loaded) {
    const destination = join(workDirectory, "files", ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    assets[`kin/files/${path}`] = `files/${path}`;
  }
  writeFileSync(join(workDirectory, "main.cjs"), readFileSync(join(PROJECT_ROOT, "scripts", "sea", "main.cjs")));
  const config = { main: "main.cjs", output: "kin.blob", disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets };
  writeFileSync(join(workDirectory, "sea-config.json"), JSON.stringify(config, null, 2));
  const result = spawnSync(generator, ["--experimental-sea-config", "sea-config.json"], { cwd: workDirectory, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  if (result.status !== 0) throw new BuildSeaError(`node --experimental-sea-config failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  return { blob: readFileSync(join(workDirectory, "kin.blob")), manifest };
}

/** The executable for one ELF target: `base` (an unmodified node binary)
 * with its fuse flipped and the blob added. */
export function buildElfExecutable(target, base, blob) {
  const { machine } = readElf(base);
  if (machine !== TARGETS[target].machine) throw new BuildSeaError(`The node binary for ${target} is for another processor (ELF machine ${machine}).`);
  return injectElf(flipFuse(Buffer.from(base)), blob);
}

function nodeVersionOf(binary) {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  return result.status === 0 ? result.stdout.trim().replace(/^v/, "") : null;
}

async function baseBinary(target, options, cacheDirectory) {
  if (options.nodeBinary) return { bytes: readFileSync(options.nodeBinary), source: options.nodeBinary, archive: null };
  const cached = join(cacheDirectory, `node-v${options.nodeVersion}-${target}${TARGETS[target].suffix}`);
  const record = `${cached}.json`;
  if (existsSync(cached) && existsSync(record)) {
    const bytes = readFileSync(cached);
    const info = JSON.parse(readFileSync(record, "utf8"));
    if (info.sha256 === sha256(bytes)) return { bytes, source: info.archive, archive: info };
  }
  const downloaded = await downloadNode(target, options.nodeVersion);
  mkdirSync(cacheDirectory, { recursive: true });
  writeFileSync(cached, downloaded.binary, { mode: 0o755 });
  const info = { archive: downloaded.archive, archiveSha256: downloaded.archiveSha256, sha256: sha256(downloaded.binary) };
  writeFileSync(record, JSON.stringify(info, null, 2));
  return { bytes: downloaded.binary, source: downloaded.archive, archive: info };
}

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

/** Starts `executable` with an empty data directory and resolves with the
 * milliseconds until the service reports it is ready. */
export async function measureStart(executable, { appCache, timeoutMs = 60_000 } = {}) {
  const data = mkdtempSync(join(tmpdir(), "kin-sea-data-"));
  const port = await freePort();
  const started = performance.now();
  const child = spawn(executable, [], {
    env: { ...process.env, NODE_OPTIONS: "", KIN_MODE: "home", KIN_DATA_DIR: data, KIN_PORT: String(port), KIN_APP_CACHE: appCache },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return await new Promise((resolveTime, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new BuildSeaError(`The executable didn't start within ${timeoutMs / 1000} seconds: ${output.slice(-500)}`)), timeoutMs);
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('"service_ready"')) { clearTimeout(timer); resolveTime(Math.round(performance.now() - started)); }
      };
      child.stdout.setEncoding("utf8").on("data", onData);
      child.stderr.setEncoding("utf8").on("data", onData);
      child.once("exit", (code) => { clearTimeout(timer); reject(new BuildSeaError(`The executable exited with ${code}: ${output.slice(-500)}`)); });
    });
  } finally {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
    await new Promise((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", done)));
    rmSync(data, { recursive: true, force: true });
  }
}

/** Builds every requested target; returns the build information. `work`
 * (default target/sea) holds the downloaded node binaries and the blob. */
export async function buildSea(options, { log = (line) => console.log(line) } = {}) {
  const version = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;
  const work = options.work ?? join(PROJECT_ROOT, "target", "sea");
  const files = collectAppFiles({ wasm: options.wasm });
  const host = hostTarget();
  const bases = new Map();
  for (const target of options.targets) {
    log(`Getting node v${options.nodeVersion} for ${target}`);
    bases.set(target, await baseBinary(target, options, join(work, "node")));
  }
  // The blob must come from a node of the same version as the binaries.
  let generator = null;
  if (process.version === `v${options.nodeVersion}`) generator = process.execPath;
  else if (host && bases.has(host)) {
    const candidate = options.nodeBinary ?? join(work, "node", `node-v${options.nodeVersion}-${host}${TARGETS[host].suffix}`);
    if (nodeVersionOf(candidate) === options.nodeVersion) generator = candidate;
  }
  if (!generator)
    throw new BuildSeaError(`Writing the blob needs node v${options.nodeVersion} on this machine: run the build with that version, or include this machine's target (${host ?? "none"}).`);
  log(`Writing the SEA blob (${files.length} files) with ${generator}`);
  const { blob, manifest } = buildBlob({ files, version, nodeVersion: options.nodeVersion, generator, workDirectory: join(work, "blob") });

  mkdirSync(options.out, { recursive: true });
  const targets = [];
  for (const target of options.targets) {
    const base = bases.get(target);
    const executable = buildElfExecutable(target, base.bytes, blob);
    const file = `kin-${version}-${target}${TARGETS[target].suffix}`;
    writeFileSync(join(options.out, file), executable);
    chmodSync(join(options.out, file), 0o755);
    targets.push({ target, file, size: executable.length, sha256: sha256(executable), node: { sha256: sha256(base.bytes), ...(base.archive ? { archive: base.archive.archive, archiveSha256: base.archive.archiveSha256 } : { source: "--node-binary" }) } });
    log(`Built ${join(options.out, file)} (${(executable.length / 1048576).toFixed(1)} MiB)`);
  }
  const info = { name: "kin", version, node: options.nodeVersion, bundle: manifest.bundle, files: manifest.files.length, blob: { size: blob.length, sha256: sha256(blob) }, targets };
  writeFileSync(join(options.out, "SHA256SUMS"), targets.map(({ sha256: hash, file }) => `${hash}  ${file}\n`).join(""));
  writeFileSync(join(options.out, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);

  if (options.measure) {
    const own = targets.find(({ target }) => target === host);
    if (!own) throw new BuildSeaError(`--measure needs this machine's target (${host ?? "none"}) in the build.`);
    const appCache = mkdtempSync(join(tmpdir(), "kin-sea-cache-"));
    try {
      const executable = join(options.out, own.file);
      const firstStartMs = await measureStart(executable, { appCache });
      const startMs = await measureStart(executable, { appCache });
      const timing = { target: own.target, size: own.size, firstStartMs, startMs, node: options.nodeVersion };
      writeFileSync(join(options.out, "start-time.json"), `${JSON.stringify(timing, null, 2)}\n`);
      log(`Start: ${firstStartMs} ms the first time (unpacking), ${startMs} ms after`);
    } finally {
      rmSync(appCache, { recursive: true, force: true });
    }
  }
  return info;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildSea(parseBuildArguments(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof BuildSeaError) && error?.name !== "ElfInjectError" && error?.name !== "FuseError" && error?.name !== "NodeReleaseError") throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
