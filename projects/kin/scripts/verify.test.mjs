import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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

test("a normally exiting child succeeds", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exit(0)"], { capture: true });
  assert.equal(result.code, 0);
  assert.equal(result.error, null);
});

test("missing executables return an actionable process error", async () => {
  const result = await runCommand("kin-no-such-executable-verify-test", [], { capture: true });
  assert.equal(result.code, 1);
  assert.match(result.error.message, /spawn|not found|ENOENT/i);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} terminates an active isolated child process tree`, async () => {
    const signalSource = new EventEmitter();
    const source = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('descendant:' + child.pid); setInterval(() => {}, 1000);`;
    const result = await runCommand(process.execPath, ["-e", source], {
      capture: true,
      signalSource,
      spawnImpl: (command, args, options) => {
        const child = spawn(command, args, options);
        child.once("spawn", () => setTimeout(() => signalSource.emit(signal), 150));
        return child;
      },
    });
    assert.equal(result.interrupted, true);
    assert.equal(result.signal, signal);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    const descendantPid = Number(/descendant:(\d+)/.exec(result.stdout)?.[1]);
    assert.ok(descendantPid > 0, "isolated command created a descendant process");
    let descendantAlive = true;
    for (let attempt = 0; attempt < 20 && descendantAlive; attempt += 1) {
      try {
        if (process.platform !== "win32") {
          const stat = await readFile(`/proc/${descendantPid}/stat`, "utf8").catch(() => null);
          if (stat && stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) { descendantAlive = false; break; }
        }
        process.kill(descendantPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") descendantAlive = false;
        else throw error;
      }
      if (descendantAlive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(descendantAlive, false, `descendant process ${descendantPid} remained after cleanup`);
  });
}

test("interruption cleanup waits for a racing child close and resolves once", async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  let releaseCleanup;
  let terminations = 0;
  const resultPromise = runCommand("race", [], {
    signalSource,
    spawnImpl: () => child,
    terminateTree: async () => { terminations += 1; await new Promise((resolve) => { releaseCleanup = resolve; }); },
  });
  signalSource.emit("SIGTERM");
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  releaseCleanup();
  const result = await resultPromise;
  assert.equal(terminations, 1);
  assert.equal(result.code, 143);
  assert.equal(result.signal, "SIGTERM");
});

test("cleanup errors fail the interrupted command and listeners are removed", async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = null;
  child.stderr = null;
  const beforeInt = signalSource.listenerCount("SIGINT");
  const beforeTerm = signalSource.listenerCount("SIGTERM");
  const pending = runCommand("cleanup-failure", [], {
    signalSource,
    spawnImpl: () => child,
    terminateTree: async () => { throw new Error("tree cleanup denied"); },
  });
  signalSource.emit("SIGINT");
  child.emit("close", null, "SIGKILL");
  const result = await pending;
  assert.equal(result.code, 1);
  assert.match(result.error.message, /tree cleanup denied/);
  assert.equal(signalSource.listenerCount("SIGINT"), beforeInt);
  assert.equal(signalSource.listenerCount("SIGTERM"), beforeTerm);
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
  let prerequisiteCommands = 0;
  const result = await runVerification({
    execute: async () => { prerequisiteCommands += 1; return { code: 1, stdout: "", stderr: "compiler missing", error: new Error("compiler missing") }; },
    output: (message) => output.push(message),
  });
  assert.equal(result.stages[0].status, "FAIL");
  assert.equal(result.stages[1].status, "NOT RUN");
  assert.equal(result.stages[2].status, "NOT RUN");
  assert.equal(result.stages[3].status, "NOT RUN");
  assert.ok(result.stages[0].results.some(({ status }) => status === "NOT RUN"));
  assert.equal(result.code, 1);
  assert.equal(prerequisiteCommands, 1, "environment verification stops at its first failed prerequisite");
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
  const staticStage = result.stages.find(({ name }) => name.startsWith("B —"));
  assert.equal(staticStage.status, "FAIL");
  assert.equal(staticStage.results[0].status, "PASS");
  assert.equal(staticStage.results[1].status, "FAIL");
  assert.equal(staticStage.results.length, 4);
  assert.match(staticStage.results[2].label, /Version consistency: skipped after failure in Clippy/);
  assert.match(staticStage.results[3].label, /Kin diff whitespace: skipped after failure in Clippy/);
  assert.ok(staticStage.results.slice(2).every(({ status }) => status === "NOT RUN"));
  assert.equal(result.stages.find(({ name }) => name.startsWith("C —")).status, "NOT RUN");
  assert.equal(result.stages.find(({ name }) => name.startsWith("D —")).status, "NOT RUN");
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
    if (command === "cargo" && args[0] === "fmt") return { code: 130, signal: "SIGINT", interrupted: true, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "22.13.0", output: () => {} });
  assert.equal(result.code, 1);
  assert.equal(result.stages.find(({ name }) => name.startsWith("B —")).status, "FAIL");
  assert.equal(result.stages.find(({ name }) => name.startsWith("C —")).status, "NOT RUN");
  assert.equal(commands.some(([command, firstArg]) => command === "cargo" && firstArg === "test"), false);
});

test("a failed Node suite prevents Rust tests and WASM build", async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push([command, args]);
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (command === "python") return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === process.execPath && args[0] === "--test") return { code: 1, stdout: "", stderr: "controlled node failure" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ execute, nodeVersion: "22.13.0", output: () => {} });
  const tests = result.stages.find(({ name }) => name.startsWith("C —"));
  assert.equal(tests.results[0].status, "FAIL");
  assert.equal(tests.results[1].status, "NOT RUN");
  assert.equal(result.stages.find(({ name }) => name.startsWith("D —")).status, "NOT RUN");
  assert.equal(commands.some(([command, args]) => command === "cargo" && args[0] === "build"), false);
  assert.equal(result.code, 1);
});

test("a failed required browser suite marks later browser suites NOT RUN", async () => {
  const executedSuites = [];
  const execute = async (command, args) => {
    if (command === "rustup" && args[0] === "show") return { code: 0, stdout: "1.93.0-x86_64-pc-windows-msvc", stderr: "" };
    if (command === "rustup" && args[0] === "target") return { code: 0, stdout: "wasm32-unknown-unknown", stderr: "" };
    if (command === "python") return { code: 0, stdout: "Python 3.12.0", stderr: "" };
    if (command === "git" && args[0] === "ls-files") return { code: 1, stdout: "", stderr: "ignored" };
    if (command === process.execPath && args[0]?.endsWith(".mjs") && args[0].includes("regression")) {
      executedSuites.push(args[0]);
      return { code: 9, stdout: "", stderr: "controlled browser regression failure" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await runVerification({ browser: true, browserExecutable: process.execPath, execute, nodeVersion: "22.13.0", output: () => {} });
  const browser = result.stages.find(({ name }) => name.startsWith("E —"));
  assert.equal(executedSuites.length, 1);
  assert.equal(browser.results[0].status, "FAIL");
  assert.ok(browser.results.slice(1).every(({ status }) => status === "NOT RUN"));
  assert.equal(result.code, 1);
});

test("version comparison handles numeric components", () => {
  assert.deepEqual(parseVersion("22.13.0"), [22, 13, 0]);
  assert.ok(compareVersions(parseVersion("22.12.99"), parseVersion("22.13.0")) < 0);
});
