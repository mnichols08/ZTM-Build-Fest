import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROJECT_ROOT,
  collectNodeTests,
  compareVersions,
  parseVersion,
  runCommand,
  runVerification,
} from "./verify.mjs";

test("a failing child command returns its exit status", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exit(17)"], { capture: true });
  assert.equal(result.code, 17);
});

test("missing executables return an actionable process error", async () => {
  const result = await runCommand("kin-no-such-executable-verify-test", [], { capture: true });
  assert.equal(result.code, 1);
  assert.match(result.error.message, /spawn|not found|ENOENT/i);
});

test("an interrupted child is reported as failure with its signal", async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", null, "SIGINT"));
    return child;
  };
  const result = await runCommand("interrupted", [], { spawnImpl: fakeSpawn });
  assert.equal(result.code, 1);
  assert.equal(result.signal, "SIGINT");
});

test("missing required browser is a failure and optional browser stage is NOT RUN", async () => {
  const messages = [];
  const availablePrerequisites = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (command === "python") return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    return { code: 0, stdout: "tool available", stderr: "" };
  };
  const result = await runVerification({
    browser: true,
    env: { ...process.env, KIN_BROWSER: "" },
    execute: availablePrerequisites,
    nodeVersion: "22.13.0",
    output: (message) => messages.push(message),
  });
  const browserStage = result.stages.find(({ name }) => name.startsWith("E —"));
  assert.equal(browserStage.status, "FAIL");
  assert.equal(result.code, 1);

  const missingExecutable = await runVerification({
    browser: true,
    browserExecutable: join(tmpdir(), "kin-missing-browser-executable"),
    execute: availablePrerequisites,
    nodeVersion: "22.13.0",
    output: (message) => messages.push(message),
  });
  assert.equal(missingExecutable.stages.find(({ name }) => name.startsWith("E —")).status, "FAIL");
  assert.ok(messages.some((message) => message.includes("browser executable is not accessible")));

  const optional = await runVerification({
    browser: false,
    execute: availablePrerequisites,
    nodeVersion: "22.13.0",
    output: (message) => messages.push(message),
  });
  assert.equal(optional.stages.find(({ name }) => name.startsWith("E —")).status, "NOT RUN");
  assert.equal(messages.some((message) => message.includes("NOT RUN E — Browser verification")), true);
});

test("test discovery is deterministic and works from repository and Kin directory paths", async () => {
  const fromProject = await collectNodeTests(PROJECT_ROOT);
  const fromRepository = await collectNodeTests(join(PROJECT_ROOT));
  assert.deepEqual(fromRepository, fromProject);
  assert.ok(fromProject.some((path) => path.endsWith(join("server", "durable-sync-integrity.test.mjs"))));
  assert.ok(fromProject.every((path) => path.endsWith(".test.mjs")));

  const temporary = await mkdtemp(join(tmpdir(), "kin-test-discovery-"));
  try {
    await mkdir(join(temporary, "server"));
    await mkdir(join(temporary, "web", "nested"), { recursive: true });
    await writeFile(join(temporary, "server", "one.test.mjs"), "");
    await writeFile(join(temporary, "server", "ignored-test.mjs"), "");
    await writeFile(join(temporary, "web", "nested", "two.test.mjs"), "");
    assert.deepEqual((await collectNodeTests(temporary)).map((path) => path.slice(temporary.length + 1)), [
      join("server", "one.test.mjs"),
      join("web", "nested", "two.test.mjs"),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the entry point resolves paths from the repository root and the Kin directory", async () => {
  const script = join(PROJECT_ROOT, "scripts", "verify.mjs");
  for (const cwd of [join(PROJECT_ROOT, "..", ".."), PROJECT_ROOT]) {
    const result = await new Promise((resolveResult) => {
      const child = spawn(process.execPath, [script], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => resolveResult({ code: 1, stdout, stderr, error }));
      child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    });
    assert.match(result.stdout, /Kin verification report/);
    assert.match(result.stdout, new RegExp(`Runtime: Node ${process.versions.node.replaceAll(".", "\\.")}`));
    if (compareVersions(parseVersion(process.versions.node), [22, 13, 0]) < 0) {
      assert.match(result.stdout, new RegExp(`Node\\.js >=22\\.13\\.0 required; found ${process.versions.node.replaceAll(".", "\\.")}`));
    }
  }
});

test("summary reflects failing prerequisites and does not claim later stages passed", async () => {
  const output = [];
  const result = await runVerification({
    execute: async () => ({ code: 1, stdout: "", stderr: "compiler missing", error: new Error("compiler missing") }),
    output: (message) => output.push(message),
  });
  assert.equal(result.stages[0].status, "FAIL");
  assert.equal(result.stages[1].status, "NOT RUN");
  assert.equal(result.stages[2].status, "NOT RUN");
  assert.equal(result.stages[3].status, "NOT RUN");
  assert.equal(result.code, 1);
  assert.ok(output.some((line) => line.includes("NOT RUN")));
  assert.ok(output.some((line) => line.includes("compiler missing")));
});

test("a failing required child command makes the overall gate fail", async () => {
  const execute = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (command === "python") return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "cargo" && args[0] === "clippy") return { code: 23, stdout: "", stderr: "lint failed" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "22.13.0", output: () => {} });
  assert.equal(result.code, 1);
  assert.equal(result.stages.find(({ name }) => name.startsWith("B —")).status, "FAIL");
});

test("an ignored WASM output is explicitly reported without a committed comparison", async () => {
  const execute = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (command === "python") return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "git" && args[0] === "ls-files") return { code: 1, stdout: "", stderr: "path is ignored" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "22.13.0", output: () => {} });
  const wasm = result.stages.find(({ name }) => name.startsWith("D —")).results[0];
  assert.equal(wasm.status, "PASS");
  assert.match(wasm.artifactComparison, /NOT RUN.*ignored\/untracked/);
});

test("an interrupted required command stops later stages and yields a failing summary", async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push([command, args[0]]);
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (command === "python") return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "cargo" && args[0] === "fmt") return { code: 130, signal: "SIGINT", stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "22.13.0", output: () => {} });
  assert.equal(result.code, 1);
  assert.equal(result.stages.find(({ name }) => name.startsWith("B —")).status, "FAIL");
  assert.equal(result.stages.find(({ name }) => name.startsWith("C —")).status, "NOT RUN");
  assert.equal(commands.some(([command, firstArg]) => command === "cargo" && firstArg === "test"), false);
});

test("version comparison handles numeric components", () => {
  assert.deepEqual(parseVersion("22.13.0"), [22, 13, 0]);
  assert.ok(compareVersions(parseVersion("22.12.99"), parseVersion("22.13.0")) < 0);
});
