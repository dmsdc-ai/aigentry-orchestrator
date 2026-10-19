import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { assertNoSourceLeak, childEnv, finish, fixture, invokeNode, publicEntry } from "./fixture.js";

const binding = "00000000-0000-4000-8000-000000000001";
const route = ["env", "run", "--binding", binding, "--input-fd", "3", "--", "dispatch",
  "--spawn-and-dispatch", "--cli", "claude", "--target", "fixture-target"];

test("public env-run rejects a missing source before central staging", { skip: process.platform === "win32" }, () => {
  const root = fixture();
  const result = invokeNode(publicEntry(), ["env", "run", "--binding", binding, "--", "dispatch",
    "--spawn-and-dispatch", "--cli", "claude"], root);
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /SANDBOX_AUTH_WORKER_TOKEN_REQUIRED/);
  assert.equal(fs.existsSync(path.join(root, "central")), false);
  finish(root, { status: result.status, stderr: result.stderr });
});

test("public input owner rejects regular file descriptors, conflict, and malformed bytes", { skip: process.platform === "win32" }, () => {
  for (const bytes of ["fixture-secret\n", "", "two\nframes\n", "bad\r\n", "bad\0\n", "badé\n", "x".repeat(4097) + "\n"]) {
    const root = fixture(), file = path.join(root, "frame");
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const result = invokeNode(publicEntry(), route, root, {}, ["ignore", "pipe", "pipe", fd]);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 4, result.stderr);
      assert.match(result.stderr, /ENV_INPUT_CHANNEL_UNSUPPORTED/);
      assert.equal(fs.existsSync(path.join(root, "central")), false);
      assertNoSourceLeak(result, "fixture-secret");
      finish(root, { status: result.status, stderr: result.stderr });
    } finally { fs.closeSync(fd); }
  }
  const root = fixture();
  const conflict = invokeNode(publicEntry(), route, root,
    { AIGENTRY_CLAUDE_OAUTH_TOKEN: "other-secret" }, ["ignore", "pipe", "pipe", "ignore"]);
  assert.equal(conflict.signal, null, conflict.stderr);
  assert.equal(conflict.status, 4, conflict.stderr);
  assert.match(conflict.stderr, /ENV_INPUT_CONFLICT/);
  assert.doesNotMatch(conflict.stderr, /Assertion failed|uv__io_poll|SIGABRT/);
  assertNoSourceLeak(conflict, "other-secret");
  assert.equal(fs.existsSync(path.join(root, "central")), false);
  finish(root, { status: conflict.status, stderr: conflict.stderr });
});

async function freshPipe(root: string, payload: string, argv = route, extra: NodeJS.ProcessEnv = {},
  preload?: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  const child = spawn(process.execPath, [...(preload ? ["--require", preload] : []), publicEntry(), ...argv], {
    stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...childEnv(root), ...extra },
  });
  const pipe = child.stdio[3];
  if (!(pipe instanceof Writable)) throw new Error("fixture pipe missing");
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  pipe.on("error", () => { /* an early refusal may close the child end */ });
  pipe.end(payload);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stderr };
}

function traceFd3(root: string): { preload: string; events: () => string[] } {
  const preload = path.join(root, "fd-trace.cjs"), log = path.join(root, "fd-trace.log");
  fs.writeFileSync(preload, `
const fs = require("node:fs");
const log = ${JSON.stringify(log)};
const originalStat = fs.fstatSync, originalClose = fs.closeSync;
const fromCli = () => (new Error().stack || "").includes("bin/init/cli.mjs");
const record = event => fs.appendFileSync(log, event + "\\n");
let marker;
fs.fstatSync = function(fd, ...args) {
  if (fd === 3 && fromCli()) record("fstat");
  return originalStat.call(this, fd, ...args);
};
fs.closeSync = function(fd) {
  if (fd !== 3 || !fromCli()) return originalClose.call(this, fd);
  record("close");
  const result = originalClose.call(this, fd);
  if (process.env.TRACE_REUSE_FD3 === "1") {
    const reused = fs.openSync("/dev/null", "r");
    record("reused:" + reused);
    marker = originalStat.call(fs, reused);
  }
  return result;
};
process.on("exit", () => {
  if (!marker) return;
  try {
    const current = originalStat.call(fs, 3);
    record(current.dev === marker.dev && current.ino === marker.ino && current.rdev === marker.rdev
      ? "reuse-live" : "reuse-lost");
  } catch { record("reuse-lost"); }
});
`, { flag: "wx", mode: 0o600 });
  return { preload, events: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
}

test("pre-acquisition conflicts and duplicates do not probe or close fd 3", { skip: process.platform === "win32" }, async () => {
  const root = fixture(), trace = traceFd3(root);
  const ignored = spawnSync(process.execPath, ["--require", trace.preload, publicEntry(), ...route], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe", "ignore"],
    env: { ...childEnv(root), AIGENTRY_CLAUDE_OAUTH_TOKEN: "conflict-fixture" },
  });
  assert.equal(ignored.error, undefined);
  assert.equal(ignored.signal, null, ignored.stderr);
  assert.equal(ignored.status, 4, ignored.stderr);
  assert.match(ignored.stderr, /ENV_INPUT_CONFLICT/);
  assert.doesNotMatch(ignored.stderr, /conflict-fixture|Assertion failed|uv__io_poll/);
  const supplied = await freshPipe(root, "", route,
    { AIGENTRY_CLAUDE_OAUTH_TOKEN: "conflict-fixture" }, trace.preload);
  assert.equal(supplied.signal, null, supplied.stderr);
  assert.equal(supplied.code, 4, supplied.stderr);
  assert.match(supplied.stderr, /ENV_INPUT_CONFLICT/);
  const duplicate = spawnSync(process.execPath, ["--require", trace.preload, publicEntry(),
    "env", "run", "--input-fd", "3", "--input-fd", "3", "--", "dispatch"], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe", "ignore"], env: childEnv(root),
  });
  assert.equal(duplicate.error, undefined);
  assert.equal(duplicate.signal, null, duplicate.stderr);
  assert.equal(duplicate.status, 4, duplicate.stderr);
  assert.match(duplicate.stderr, /ENV_DUPLICATE_OPTION/);
  const malformed = spawnSync(process.execPath, ["--require", trace.preload, publicEntry(),
    "env", "run", "--input-fd", "3", "--binding", binding, "--binding", binding, "--", "dispatch"], {
    encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe", "ignore"], env: childEnv(root),
  });
  assert.equal(malformed.error, undefined);
  assert.equal(malformed.signal, null, malformed.stderr);
  assert.equal(malformed.status, 4, malformed.stderr);
  assert.match(malformed.stderr, /ENV_DUPLICATE_OPTION/);
  assert.deepEqual(trace.events(), []);
  assert.equal(fs.existsSync(path.join(root, "central")), false);
  finish(root, { ignored: ignored.status, supplied: supplied.code, duplicate: duplicate.status,
    malformed: malformed.status });
});

test("selected regular input is inspected without reading or closing it", { skip: process.platform === "win32" }, () => {
  const root = fixture(), trace = traceFd3(root), file = path.join(root, "regular-frame");
  fs.writeFileSync(file, "fixture-secret\n", { flag: "wx", mode: 0o600 });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let closed = false;
  try {
    const result = spawnSync(process.execPath, ["--require", trace.preload, publicEntry(), ...route], {
      encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe", fd], env: childEnv(root),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 4, result.stderr);
    assert.match(result.stderr, /ENV_INPUT_CHANNEL_UNSUPPORTED/);
    assert.deepEqual(trace.events(), ["fstat"]);
    const first = Buffer.alloc(1);
    assert.equal(fs.readSync(fd, first, 0, 1, null), 1);
    assert.equal(first.toString(), "f");
    assert.equal(fs.existsSync(path.join(root, "central")), false);
    const summary = { status: result.status, events: trace.events() };
    fs.closeSync(fd);
    closed = true;
    finish(root, summary);
  } finally { if (!closed) fs.closeSync(fd); }
});

test("selected valid pipe closes once and does not close a reused fd 3", { skip: process.platform === "win32" }, async () => {
  const root = fixture(), trace = traceFd3(root);
  const result = await freshPipe(root, "owned-fixture\n", route, { TRACE_REUSE_FD3: "1" }, trace.preload);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 78, result.stderr);
  assert.match(result.stderr, /ENV_MANAGED_ROUTE_REFUSED/);
  assert.doesNotMatch(result.stderr, /owned-fixture/);
  assert.deepEqual(trace.events(), ["fstat", "close", "reused:3", "reuse-live"]);
  assert.equal(fs.existsSync(path.join(root, "central")), false);
  finish(root, { code: result.code, events: trace.events() });
});

test("two separate public invocations consume fresh valid pipes independently", { skip: process.platform === "win32" }, async () => {
  const root = fixture(), traces: Array<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> = [];
  for (const source of ["first-fixture", "second-fixture"]) {
    const result = await freshPipe(root, source + "\n");
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 78, result.stderr);
    assert.match(result.stderr, /ENV_MANAGED_ROUTE_REFUSED/);
    assert.equal(result.stderr.includes(source), false);
    traces.push(result);
  }
  assert.equal(fs.existsSync(path.join(root, "central")), false);
  finish(root, traces);
});

test("public pipe owner rejects malformed frames before dispatch effects", { skip: process.platform === "win32" }, async () => {
  for (const payload of ["", "bad\r\n", "two\nframes\n", "bad\0\n", "badé\n", "x".repeat(4097) + "\n"]) {
    const root = fixture();
    const result = await freshPipe(root, payload);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /ENV_INPUT_INVALID/);
    assert.equal(fs.existsSync(path.join(root, "central")), false);
    finish(root, { code: result.code, stderr: result.stderr });
  }
});

test("public pipe owner rejects an open producer at its time bound", { skip: process.platform === "win32", timeout: 14_000 }, async () => {
  const root = fixture();
  const child = spawn(process.execPath, [publicEntry(), ...route], {
    stdio: ["ignore", "pipe", "pipe", "pipe"], env: childEnv(root),
  });
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr += String(chunk); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdio[3]?.destroy();
  assert.equal(result.signal, null, stderr);
  assert.equal(result.code, 4, stderr);
  assert.match(stderr, /ENV_INPUT_TIMEOUT/);
  assert.equal(fs.existsSync(path.join(root, "central")), false);
  finish(root, { code: result.code, stderr });
});

test("public accepted input reaches the single dispatch parser and rejects repeated scope flags", { skip: process.platform === "win32" }, async () => {
  const root = fixture(), trace = traceFd3(root);
  const result = await freshPipe(root, "parser-fixture\n", ["env", "run", "--binding", binding, "--input-fd", "3", "--",
    "dispatch", "--spawn-and-dispatch", "--cli", "claude", "--cli", "codex"], {}, trace.preload);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stderr, /ENV_DUPLICATE_OPTION/);
  assert.equal(result.stderr.includes("parser-fixture"), false);
  assert.deepEqual(trace.events(), []);
  assert.equal(fs.existsSync(path.join(root, "central")), false);
  finish(root, result);
});
