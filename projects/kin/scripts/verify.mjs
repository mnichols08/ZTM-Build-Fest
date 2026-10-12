#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLCHAIN_FILE = join(PROJECT_ROOT, "rust-toolchain.toml");
const BROWSER_RUNNERS = [
  ["browser regression", "browser-regression.mjs"],
  ["security storage regression", "security-storage-regression.mjs"],
  ["security UI regression", "security-ui-regression.mjs"],
  ["passkey regression", "passkey-regression.mjs"],
  ["household authority regression", "household-authority-regression.mjs"],
];

export function runCommand(command, args, { cwd = PROJECT_ROOT, env = process.env, spawnImpl = spawn, capture = false } = {}) {
  return new Promise((resolveResult) => {
    let child;
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolveResult({ code: 1, signal: null, error });
      return;
    }
    const onInterrupt = () => {
      interrupted = true;
      child.kill("SIGINT");
    };
    process.once("SIGINT", onInterrupt);
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; if (!capture) process.stdout.write(chunk); });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; if (!capture) process.stderr.write(chunk); });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", onInterrupt);
      resolveResult({ stdout, stderr, ...result, ...(interrupted ? { code: 130, signal: "SIGINT" } : {}) });
    };
    child.once("error", (error) => finish({ code: 1, signal: null, error }));
    child.once("close", (code, signal) => finish({ code: code ?? 1, signal, error: null }));
  });
}

export async function collectNodeTests(root = PROJECT_ROOT) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(fullPath);
    }
  }
  for (const directory of ["server", "web"]) await visit(join(root, directory));
  return files;
}

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

async function toolchainChannel() {
  const contents = await readFile(TOOLCHAIN_FILE, "utf8");
  return /^channel\s*=\s*"([^"]+)"/m.exec(contents)?.[1] ?? null;
}

function choosePython(env) {
  return env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

async function checkEnvironment({ execute, env, nodeVersion }) {
  const failures = [];
  const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8"));
  const minimumNode = /(?:>=\s*)?(\d+\.\d+\.\d+)/.exec(packageJson.engines?.node ?? "")?.[1];
  const actualNode = nodeVersion;
  if (!minimumNode || compareVersions(parseVersion(actualNode), parseVersion(minimumNode)) < 0) {
    failures.push(`Node.js ${minimumNode ? `>=${minimumNode}` : "minimum from package.json"} required; found ${actualNode}.`);
  }
  for (const [command, args, label] of [
    ["rustc", ["--version"], "Rust compiler"],
    ["cargo", ["--version"], "Cargo"],
    ["rustup", ["show", "active-toolchain"], "rustup pinned toolchain"],
    ["git", ["--version"], "Git"],
  ]) {
    const result = await execute(command, args, { cwd: PROJECT_ROOT, env, capture: true });
    if (result.code !== 0) failures.push(`${label} unavailable: ${result.error?.message ?? result.stderr ?? "command failed"}`);
    else if (command === "rustup") {
      const expected = await toolchainChannel();
      const active = result.stdout.trim().split(/[\s-]+/)[0];
      if (!expected || active !== expected) failures.push(`Pinned Rust toolchain ${expected ?? "in rust-toolchain.toml"} is required; active toolchain is ${result.stdout.trim() || "unknown"}.`);
    }
  }
  const target = await execute("rustup", ["target", "list", "--installed"], { cwd: PROJECT_ROOT, env, capture: true });
  if (target.code !== 0 || !target.stdout.split(/\s+/).includes("wasm32-unknown-unknown")) {
    failures.push("Rust target wasm32-unknown-unknown is required; install it with `rustup target add wasm32-unknown-unknown`.");
  }
  const pythonCommand = choosePython(env);
  const python = await execute(pythonCommand, ["--version"], { cwd: PROJECT_ROOT, env, capture: true });
  const pythonVersionText = /Python\s+(\d+\.\d+\.\d+)/i.exec(`${python.stdout ?? ""}\n${python.stderr ?? ""}`)?.[1];
  const pythonVersion = parseVersion(pythonVersionText);
  if (python.code !== 0 || !pythonVersion || compareVersions(pythonVersion, [3, 11, 0]) < 0) {
    failures.push(`Python >=3.11 is required for the existing TOML version checker; set PYTHON to its executable. ${python.error?.message ?? python.stderr ?? ""}`.trim());
  }
  return failures;
}

function statusOf(results) {
  if (results.some((result) => result.status === "FAIL")) return "FAIL";
  if (results.some((result) => result.status === "NOT RUN")) return "NOT RUN";
  return "PASS";
}

export async function runVerification({ browser = false, browserExecutable, env = process.env, execute = runCommand, output = console.log, nodeVersion = process.versions.node } = {}) {
  const started = Date.now();
  const stages = [];
  let interrupted = false;
  const stage = (name, results) => {
    const record = { name, results, status: statusOf(results) };
    stages.push(record);
    return record;
  };
  const commandResult = async (label, command, args, options = {}) => {
    if (interrupted) return { label, status: "NOT RUN", error: "verification interrupted by SIGINT" };
    output(`$ ${command} ${args.join(" ")}`);
    const result = await execute(command, args, { cwd: PROJECT_ROOT, env, ...options });
    if (result.signal === "SIGINT" || result.code === 130) interrupted = true;
    const testCount = /(?:# tests\s+|ℹ tests\s+|tests\s+)(\d+)/i.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)?.[1]
      ?? (command === "cargo" && args.includes("test") ? /(?:\d+) passed/i.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)?.[0]?.match(/\d+/)?.[0] : undefined);
    const assertionMatches = [...`${result.stdout ?? ""}\n${result.stderr ?? ""}`.matchAll(/PASS\s+(\d+)\s+[^\r\n]*assertions/gi)];
    const assertionCount = assertionMatches.at(-1)?.[1];
    return { label, status: result.code === 0 ? "PASS" : "FAIL", code: result.code, signal: result.signal, error: result.error?.message, testCount, assertionCount };
  };

  const environmentFailures = await checkEnvironment({ execute, env, nodeVersion });
  stage("A — Environment", environmentFailures.length
    ? environmentFailures.map((message) => ({ label: message, status: "FAIL", code: 1 }))
    : [{ label: `Node ${process.versions.node}; pinned Rust and WASM target available`, status: "PASS", code: 0 }]);

  if (environmentFailures.length) {
    stage("B — Static verification", [{ label: "Skipped because environment prerequisites failed", status: "NOT RUN" }]);
    stage("C — Unit and integration tests", [{ label: "Skipped because environment prerequisites failed", status: "NOT RUN" }]);
    stage("D — WASM", [{ label: "Skipped because environment prerequisites failed", status: "NOT RUN" }]);
  } else {
    const python = choosePython(env);
    stage("B — Static verification", [
      await commandResult("Rust format", "cargo", ["fmt", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml"), "--", "--check"]),
      await commandResult("Clippy", "cargo", ["clippy", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml"), "--all-targets", "--", "-D", "warnings"]),
      await commandResult("Version consistency", python, [join(PROJECT_ROOT, "scripts", "check_version.py")]),
      await commandResult("Kin diff whitespace", "git", ["diff", "--check", "--", "."]),
    ]);

    const testFiles = await collectNodeTests();
    const tests = [
      await commandResult(`Complete Node server and web suites (${testFiles.length} files)`, process.execPath, ["--test", ...testFiles], { env: { ...env, NODE_NO_WARNINGS: "1" } }),
      await commandResult("Rust unit tests", "cargo", ["test", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml")]),
    ];
    stage("C — Unit and integration tests", tests);

    const wasm = await commandResult("Release wasm32 build", "cargo", ["build", "--manifest-path", join(PROJECT_ROOT, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"]);
    if (wasm.status === "PASS") {
      const built = join(PROJECT_ROOT, "target", "wasm32-unknown-unknown", "release", "kin.wasm");
      const committed = join(PROJECT_ROOT, "web", "wasm", "kin_engine.wasm");
      const tracked = await execute("git", ["ls-files", "--error-unmatch", "--", "web/wasm/kin_engine.wasm"], { cwd: PROJECT_ROOT, env, capture: true });
      if (tracked.code !== 0) {
        if (browser) {
          try {
            const [builtBytes, browserBytes] = await Promise.all([readFile(built), readFile(committed)]);
            const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
            if (hash(builtBytes) !== hash(browserBytes)) wasm.status = "FAIL", wasm.artifact = `browser WASM is stale (built ${hash(builtBytes)}, web asset ${hash(browserBytes)}); runner did not replace it`;
            else wasm.artifact = `matches generated browser WASM (${hash(browserBytes)})`;
          } catch (error) {
            wasm.status = "FAIL";
            wasm.artifact = `browser WASM is missing; run build-wasm.ps1 or build-wasm.sh before browser verification (${error.message})`;
          }
          wasm.artifactComparison = "local browser asset compared to this build; no committed expected artifact exists";
        } else {
          wasm.artifactComparison = "NOT RUN — generated WASM is ignored/untracked; no committed expected artifact exists";
        }
      } else {
        try {
          const [builtBytes, committedBytes] = await Promise.all([readFile(built), readFile(committed)]);
          const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
          if (hash(builtBytes) !== hash(committedBytes)) wasm.status = "FAIL", wasm.artifact = `stale committed WASM (built ${hash(builtBytes)}, committed ${hash(committedBytes)}); runner did not replace it`;
          else wasm.artifact = `matches committed WASM (${hash(committedBytes)})`;
        } catch (error) {
          wasm.status = "FAIL";
          wasm.artifact = `could not compare build artifact: ${error.message}`;
        }
      }
    }
    stage("D — WASM", [wasm]);
  }

  const executable = browserExecutable ?? env.KIN_BROWSER;
  if (browser && environmentFailures.length) {
    const reason = "blocked by failed environment prerequisites";
    stage("E — Browser verification", BROWSER_RUNNERS.map(([label]) => ({ label: `${label}: ${reason}`, status: "NOT RUN" })));
  } else if (browser && !executable) {
    stage("E — Browser verification", BROWSER_RUNNERS.map(([label]) => ({ label: `${label}: set KIN_BROWSER or pass an executable path`, status: "FAIL", code: 1 })));
  } else if (browser && !(await access(executable).then(() => true, () => false))) {
    stage("E — Browser verification", BROWSER_RUNNERS.map(([label]) => ({ label: `${label}: browser executable is not accessible at ${executable}`, status: "FAIL", code: 1 })));
  } else if (browser && stages[3].status === "FAIL") {
    stage("E — Browser verification", BROWSER_RUNNERS.map(([label]) => ({ label: `${label}: blocked by WASM build or browser asset verification failure`, status: "NOT RUN" })));
  } else if (browser) {
    const results = [];
    for (const [label, script] of BROWSER_RUNNERS) {
      results.push(await commandResult(label, process.execPath, [join(PROJECT_ROOT, "scripts", script), executable]));
    }
    stage("E — Browser verification", results);
  } else stage("E — Browser verification", BROWSER_RUNNERS.map(([label]) => ({ label, status: "NOT RUN" })));

  output("\nKin verification report");
  for (const item of stages) {
    output(`${item.status.padEnd(7)} ${item.name}`);
    for (const result of item.results) {
      if (result.status !== "PASS" || item.results.length > 1 || result.artifactComparison) output(`  ${result.status.padEnd(7)} ${result.label}${result.testCount ? ` (${result.testCount} tests)` : result.assertionCount ? ` (${result.assertionCount} assertions)` : ""}${result.code !== undefined ? ` (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ""})` : ""}${result.error ? `: ${result.error}` : ""}${result.artifact ? ` — ${result.artifact}` : ""}${result.artifactComparison ? `; ${result.artifactComparison}` : ""}`);
    }
  }
  output(`Runtime: Node ${process.versions.node}; browser ${browser ? browserExecutable ?? env.KIN_BROWSER ?? "missing" : "NOT RUN"}`);
  output(`Elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const failed = stages.some(({ status }) => status === "FAIL");
  const notRunMandatory = stages.slice(0, 4).some(({ status }) => status === "NOT RUN");
  return { code: failed || notRunMandatory ? 1 : 0, stages, elapsedMs: Date.now() - started };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const browserIndex = args.indexOf("--browser");
  const invalidArgs = args.filter((arg, index) => arg !== "--browser" && !(browserIndex >= 0 && index === browserIndex + 1));
  if (invalidArgs.length || (browserIndex >= 0 && args[browserIndex + 1]?.startsWith("--"))) {
    console.error("Usage: node scripts/verify.mjs [--browser [EXECUTABLE]]");
    process.exitCode = 2;
  } else {
    const browserExecutable = browserIndex >= 0 ? args[browserIndex + 1] : undefined;
    const result = await runVerification({ browser: browserIndex >= 0, browserExecutable });
    process.exitCode = result.code;
  }
}
