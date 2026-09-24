// Task1167 / release1171 — Windows owned-process acceptance suite
// (operation nt1167z-v1, session nt1167z-tester, independent tester).
//
// This suite exercises the ACTUAL supplied product leaves:
//   native/windows-owned-job/owned-process.mjs  (statically imported below)
//   native/windows-owned-job/owned-job.cc       (via build/Release/owned_job.node)
//   bin/windows-owned-broker.mjs                (launched by the product itself)
// Nothing about ownership, the wire protocol's caller side, or the completion
// oracle is re-implemented or mocked here. The only non-product process the suite
// introduces is tests/fixtures/windows-owned-peer.mjs, which is a *client* of the
// product's control pipe and contains no ownership logic at all.
//
// Polarity of the assertions, stated once so no later reader has to guess:
//   `baseline/*` assert the behaviour the design document claims. They are controls.
//   `hypothesis/*` assert the SAFE invariant (a competing connector must learn
//   nothing and must not be able to fabricate a completed lifetime). On source that
//   has the H1/H2 defects these tests FAIL, and that failure is the reproduction.
//   They are deliberately not inverted into expect-fail tests: inverting them would
//   turn a future fix red and would record a defect as an expectation.
//
// Fault injection vs. production-reachable, kept distinct throughout:
//   * brokerFaultMode 1/2 and handoffHoldMs are PRODUCT test hooks that travel over
//     the already-authenticated channel. Cases using them are labelled
//     `fault-injection` and prove nothing about an attacker's reach.
//   * The peer cases substitute NO product code: the real broker is still spawned
//     by the product and still races for the pipe. What the harness does supply is
//     the pipe name (taken from the product's own onStarted hook) and a pre-warmed
//     process, which removes the peer's Node startup cost from that race. The
//     disclosure of the name and the race bias are therefore harness-assisted; the
//     absence of any caller-side binding, once a peer is connected, is not.
//
// This file refuses to run anywhere it cannot be acceptance. A non-Windows
// invocation exits nonzero rather than reporting skipped-as-passed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  run,
  runSync,
  isSupported,
  inspect,
  OWNED_JOB_PROTOCOL,
  BROKER_FAULT_STAGES,
  __testing,
} from "../../native/windows-owned-job/owned-process.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "windows-owned-peer.mjs");
const WRAPPER = path.join(here, "..", "..", "native", "windows-owned-job", "owned-process.mjs");

const DIAG = process.env.OWNED_ACC_DIAG_DIR
  ? path.resolve(process.env.OWNED_ACC_DIAG_DIR)
  : path.join(os.tmpdir(), "owned-acc-diag");
const JOURNAL = path.join(DIAG, "acceptance-journal.jsonl");

// Per-run synthetic marker. Not a credential, not derived from host state: it
// exists only so a case can prove a byte crossed a boundary. Its value is never
// written to the journal or to any report file.
const MARKER_KEY = "AIG_OWNED_MARKER";
const MARKER_VALUE = crypto.randomBytes(16).toString("hex");
const MARKER_SHA256 = crypto.createHash("sha256").update(MARKER_VALUE).digest("hex");

const CASE_TIMEOUT_MS = 60_000;
const CLOCK_SLACK_MS = 250;

if (process.platform !== "win32") {
  process.stderr.write(
    "REFUSED: windows-owned-process-acceptance is a Windows acceptance suite. " +
      `platform=${process.platform} cannot execute it, and a skip here would be a ` +
      "non-Windows pass masquerading as acceptance. Syntax-check this file with " +
      "`node --check` instead.\n",
  );
  process.exit(3);
}

fs.mkdirSync(path.join(DIAG, "cases"), { recursive: true });

function journal(entry) {
  fs.appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function caseDir(id) {
  const dir = path.join(DIAG, "cases", id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

let WORK = null;

before(() => {
  if (!isSupported()) {
    const state = inspect();
    fs.writeFileSync(path.join(DIAG, "addon-unavailable.json"), JSON.stringify(state, null, 2));
    process.stderr.write(
      "REFUSED: the owned_job addon is not loadable, so no acceptance claim is " +
        `possible. reason=${state.unavailableReason} detail=${state.unavailableDetail}\n`,
    );
    process.exit(4);
  }
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), "owned-acc-work-"));
  const state = inspect();
  fs.writeFileSync(
    path.join(DIAG, "harness.json"),
    JSON.stringify(
      {
        task: "1167",
        release: "1171",
        operation: "nt1167z-v1",
        authorSession: "nt1167z-tester",
        suite: "windows-owned-process-acceptance",
        protocol: OWNED_JOB_PROTOCOL,
        brokerFaultStages: BROKER_FAULT_STAGES,
        // The marker value itself is withheld; the digest is enough to correlate
        // the harness with a fixture report after the fact.
        markerKey: MARKER_KEY,
        markerSha256: MARKER_SHA256,
        workDir: WORK,
        addon: state,
      },
      null,
      2,
    ),
  );
  journal({ event: "suite-start", protocol: OWNED_JOB_PROTOCOL, addonPath: state.addonPath });
});

after(() => {
  // Clean exactly the disposable directory this suite created, nothing else. No
  // process sweep of any kind runs here: every child the suite starts carries its
  // own hard lifetime bound, and a leak is reported as a failure rather than
  // papered over by killing pids whose ownership is unknown.
  if (WORK) {
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5 }); } catch { /* reported, not fatal */ }
  }
  journal({ event: "suite-end" });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function payloadEnv(caseId) {
  const env = Object.create(null);
  // Exactly the Windows variables a bare `node` child needs, plus the synthetic
  // markers. The host environment is not enumerated and not forwarded.
  for (const key of ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT", "COMSPEC"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  env[MARKER_KEY] = MARKER_VALUE;
  env.AIG_OWNED_CASE = caseId;
  return env;
}

function fixtureArgs(caseId, extra) {
  return [
    "--mode=payload-root",
    `--case=${caseId}`,
    `--expect-marker-key=${MARKER_KEY}`,
    `--expect-marker-value=${MARKER_VALUE}`,
    ...extra,
  ];
}

// The journal must contain the observed facts for every case, including the ones
// that fail, so it is written before any assertion runs.
function recordResult(caseId, result, extra = {}) {
  const summary = {
    event: "case-result",
    case: caseId,
    ok: result.ok,
    stopReason: result.stopReason,
    rootExitCode: result.rootExitCode,
    rootPid: result.rootPid,
    stdout: result.stdout.toString("utf8").slice(0, 2000),
    stderr: result.stderr.toString("utf8").slice(0, 2000),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    launchError: result.launchError,
    errorCode: result.error?.code ?? null,
    errorMessage: result.error?.message ?? null,
    cleanup: result.cleanup,
    broker: result.broker,
    job: result.job,
    timings: result.timings,
    protocol: result.protocol,
    addonPath: result.addonPath,
    record: result.record,
    ...extra,
  };
  journal(summary);
  fs.writeFileSync(path.join(caseDir(caseId), "result.json"), JSON.stringify(summary, null, 2));
  return summary;
}

function eventIndex(result, tag) {
  const events = result.record?.events ?? [];
  return events.findIndex((e) => e.tag === tag);
}

// Ordering oracle on the native clock only: barrier strictly precedes the payload
// write, which precedes the launch. Mixing the JS wall clock into this comparison
// would make it a clock-skew test instead of an ordering test.
function assertBarrierOrdering(result) {
  const owned = eventIndex(result, "owned");
  const payloadSent = eventIndex(result, "payload-sent");
  const launched = eventIndex(result, "launched");
  assert.ok(owned >= 0, "no `owned` event: the barrier was never observed");
  assert.ok(payloadSent > owned, "payload frame was sent at or before the ownership barrier");
  assert.ok(launched > payloadSent, "launch was reported before the payload frame was sent");
  assert.ok(
    result.record.launchedAtMs >= result.record.barrierAtMs,
    `launchedAtMs ${result.record.launchedAtMs} predates barrierAtMs ${result.record.barrierAtMs}`,
  );
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is an existence probe, not a termination request, and it targets
    // only a pid this suite itself recorded from a child it started.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // EPERM means it exists but is not ours to signal; treat as alive and say so.
    return error.code === "EPERM";
  }
}

async function waitForFile(file, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = readJson(file);
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForPidGone(pid, budgetMs) {
  const startedAt = Date.now();
  for (;;) {
    if (!pidAlive(pid)) return { gone: true, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= budgetMs) return { gone: false, elapsedMs: Date.now() - startedAt };
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Starts the peer fixture, waits for it to announce readiness, and returns a
// handle whose `release(pipeName)` hands over the name the product just minted.
function startPeer(caseId, stage) {
  const reportFile = path.join(caseDir(caseId), "peer-report.json");
  const child = spawn(
    process.execPath,
    [
      FIXTURE,
      "--mode=peer",
      `--stage=${stage}`,
      "--pipe=-",
      `--report-file=${reportFile}`,
      `--journal=${path.join(caseDir(caseId), "peer-journal.jsonl")}`,
      `--expect-marker-key=${MARKER_KEY}`,
      `--expect-marker-value=${MARKER_VALUE}`,
      "--max-lifetime-ms=25000",
      "--connect-budget-ms=6000",
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: payloadEnv(`${caseId}-peer`) },
  );

  let stdout = "";
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("peer never announced readiness")), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (/^PEER-READY \d+/m.test(stdout)) { clearTimeout(timer); resolve(); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`peer exited early with ${code}`)); });
  });

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    reportFile,
    ready,
    exited,
    release(pipeName) {
      child.stdin.write(pipeName + "\n");
    },
    async collect() {
      const exit = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), 20_000)),
      ]);
      if (exit.timedOut) { try { child.kill(); } catch { /* already gone */ } }
      const report = readJson(reportFile);
      fs.writeFileSync(
        path.join(caseDir(caseId), "peer-io.json"),
        JSON.stringify({ exit, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) }, null, 2),
      );
      return { exit, report, stdout, stderr };
    },
  };
}

// ---------------------------------------------------------------------------
// baseline controls
// ---------------------------------------------------------------------------

test("baseline/01 ordinary root exit runs under a proven barrier and proven cleanup", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "baseline-01-root-exit";
  const dir = caseDir(id);
  const reportFile = path.join(dir, "root-report.json");

  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, [`--report-file=${reportFile}`, "--exit-code=0", "--max-lifetime-ms=20000"]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    executionTimeoutMs: 15_000,
    handshakeTimeoutMs: 5_000,
  });
  const rootReport = readJson(reportFile);
  recordResult(id, result, { rootReport });

  assert.equal(result.stopReason, "root-exit");
  assert.equal(result.rootExitCode, 0);
  assert.equal(result.error, null);
  assert.equal(result.job.barrierObserved, true);
  assert.ok(
    result.job.activeProcessesAtBarrier >= 1,
    `barrier reported ${result.job.activeProcessesAtBarrier} active processes; the self-assigned broker must be counted`,
  );
  assert.equal(result.job.flagsEffectiveKnown, true);
  assert.equal(result.cleanup.state, "complete");
  assert.equal(result.cleanup.reason, "job-empty-and-handles-exited");
  assert.equal(result.cleanup.activeProcessesKnown, true);
  assert.equal(result.cleanup.activeProcessesFinal, 0);
  assert.equal(result.cleanup.brokerExitObserved, true);
  assert.equal(result.ok, true);

  // Raw byte passthrough on the correct stream.
  assert.match(result.stdout.toString("utf8"), new RegExp(`^ROOT-STDOUT ${id} \\d+`, "m"));
  assert.match(result.stderr.toString("utf8"), new RegExp(`^ROOT-STDERR ${id} \\d+`, "m"));
  assert.equal(result.stdoutTruncated, false);

  // The caller's intended env reached the payload; the bootstrap env did not leak.
  assert.ok(rootReport, "the payload root wrote no report");
  assert.equal(rootReport.markerMatch, true);
  assert.equal(rootReport.pid, result.rootPid);
  assert.equal(path.resolve(rootReport.cwd), path.resolve(WORK));

  // On a clean invocation the pipe client IS the broker the product spawned.
  // This is the binding that hypothesis/H1 shows is never actually enforced.
  assert.equal(result.broker.observedPid, result.broker.pid);

  assertBarrierOrdering(result);
  if (result.timings.firstOutputAtMs !== null && result.timings.barrierAtMs !== null) {
    assert.ok(
      result.timings.firstOutputAtMs + CLOCK_SLACK_MS >= result.timings.barrierAtMs,
      `first payload byte at ${result.timings.firstOutputAtMs}ms predates the barrier at ${result.timings.barrierAtMs}ms`,
    );
  }
});

test("baseline/02 a nonzero root exit is an ordinary result, not an error", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "baseline-02-nonzero-exit";
  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, ["--exit-code=23", "--max-lifetime-ms=20000"]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    executionTimeoutMs: 15_000,
    handshakeTimeoutMs: 5_000,
  });
  recordResult(id, result);

  assert.equal(result.stopReason, "root-exit");
  assert.equal(result.rootExitCode, 23);
  assert.equal(result.error, null, "exit code 23 must not be reported as an invocation error");
  assert.equal(result.cleanup.state, "complete");
  assert.equal(result.ok, true);
  assert.equal(result.rootSignal, null);
});

test("baseline/03 the sync path carries stdin bytes and the same ownership proof", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "baseline-03-sync";
  const dir = caseDir(id);
  const reportFile = path.join(dir, "root-report.json");

  const result = runSync({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, [`--report-file=${reportFile}`, "--exit-code=0", "--max-lifetime-ms=20000"]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "sync-stdin-bytes\n",
    executionTimeoutMs: 15_000,
    handshakeTimeoutMs: 5_000,
  });
  recordResult(id, result, { rootReport: readJson(reportFile) });

  assert.equal(result.stopReason, "root-exit");
  assert.equal(result.rootExitCode, 0);
  assert.equal(result.cleanup.state, "complete");
  assert.equal(result.ok, true);
  assert.equal(result.timings.firstOutputAtMs, null, "the sync path cannot observe per-chunk arrival times");
  assertBarrierOrdering(result);

  // The documented sync-only contract: stdin cannot be left open.
  assert.throws(
    () => runSync({
      nodeExe: process.execPath,
      binPath: FIXTURE,
      args: [],
      cwd: WORK,
      env: payloadEnv(id),
    }),
    /ERR_OWNED_JOB_OPTIONS/,
  );
});

test("baseline/04 an execution deadline reaps a live descendant tree", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "baseline-04-deadline-descendant";
  const dir = caseDir(id);
  const descendantPidFile = path.join(dir, "descendant-pid.json");

  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, [
      "--descendant",
      `--descendant-pid-file=${descendantPidFile}`,
      "--descendant-sleep-ms=20000",
      "--descendant-lifetime-ms=22000",
      "--sleep-ms=20000",
      "--max-lifetime-ms=22000",
    ]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    executionTimeoutMs: 1_500,
    cleanupBudgetMs: 3_000,
    handshakeTimeoutMs: 5_000,
  });
  const descendant = readJson(descendantPidFile);
  const descendantState = descendant ? await waitForPidGone(descendant.pid, 5_000) : null;
  recordResult(id, result, { descendant, descendantState });

  assert.equal(result.stopReason, "deadline");
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.job.barrierObserved, true);
  assert.equal(result.cleanup.terminateCalled, true);
  assert.equal(result.cleanup.terminateOk, true);
  assert.equal(result.cleanup.activeProcessesKnown, true);
  assert.equal(result.cleanup.activeProcessesFinal, 0);
  assert.equal(result.cleanup.state, "complete");
  assert.equal(result.ok, false, "a timeout is never an `ok` invocation");
  assert.ok(
    result.cleanup.totalTerminatedProcesses >= 3,
    `expected broker + root + descendant to be terminated, saw ${result.cleanup.totalTerminatedProcesses}`,
  );
  assert.ok(descendant, "the descendant never recorded its pid, so the tree case proved nothing");
  assert.equal(descendantState.gone, true, `descendant pid ${descendant.pid} survived job termination`);
});

test("baseline/05 a root that exits while a descendant holds its pipes still settles", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "baseline-05-drain-bound";
  const dir = caseDir(id);
  const descendantPidFile = path.join(dir, "descendant-pid.json");

  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, [
      "--descendant",
      "--descendant-hold-pipes",
      `--descendant-pid-file=${descendantPidFile}`,
      "--descendant-sleep-ms=15000",
      "--descendant-lifetime-ms=18000",
      "--exit-code=0",
      "--max-lifetime-ms=20000",
    ]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    executionTimeoutMs: 15_000,
    drainBudgetMs: 300,
    cleanupBudgetMs: 3_000,
    handshakeTimeoutMs: 5_000,
  });
  const descendant = readJson(descendantPidFile);
  const descendantState = descendant ? await waitForPidGone(descendant.pid, 5_000) : null;
  recordResult(id, result, { descendant, descendantState });

  assert.equal(result.stopReason, "root-exit");
  assert.equal(result.rootExitCode, 0);
  assert.equal(result.cleanup.state, "complete");
  assert.equal(result.cleanup.activeProcessesFinal, 0);
  // The bounded drain must be reported honestly rather than waited out forever.
  assert.equal(typeof result.job.rootDrainComplete, "boolean");
  assert.ok(
    result.timings.executionMs !== null && result.timings.executionMs < 15_000,
    "the invocation waited out the full execution budget instead of bounding the drain",
  );
  assert.ok(descendant, "the pipe-holding descendant never recorded its pid");
  assert.equal(descendantState.gone, true, `descendant pid ${descendant.pid} survived cleanup`);
});

test("baseline/06 fault-injection: a bootstrap that never reaches the barrier reports unknown, never success", { timeout: CASE_TIMEOUT_MS }, async () => {
  // brokerFaultMode=1 is a PRODUCT hook carried on the authenticated channel. It
  // models a broker that dies before self-assigning; it is not an attack path.
  const id = "baseline-06-no-barrier";
  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, ["--exit-code=0", "--max-lifetime-ms=15000"]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    brokerFaultMode: 1,
    executionTimeoutMs: 10_000,
    handshakeTimeoutMs: 4_000,
  });
  recordResult(id, result, { faultInjection: "brokerFaultMode=1 (product hook, post-authentication)" });

  assert.equal(result.job.barrierObserved, false);
  assert.equal(result.launchError, null);
  assert.equal(result.rootPid, null, "no payload may be launched without a barrier");
  assert.equal(result.cleanup.state, "unknown");
  assert.equal(
    result.cleanup.reason,
    "no-assignment-barrier",
    "an empty job that never had a member must not be read as proof of cleanup",
  );
  assert.equal(result.ok, false);
  assert.notEqual(result.error, null);
  assert.equal(result.broker.faultMode, 1);
});

test("baseline/07 fault-injection: a broker that dies after launch still leaves the job empty", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "baseline-07-broker-dies-after-launch";
  const dir = caseDir(id);
  const rootPidFile = path.join(dir, "root-pid.json");

  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, [
      `--pid-file=${rootPidFile}`,
      "--sleep-ms=12000",
      "--max-lifetime-ms=15000",
    ]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    brokerFaultMode: 2,
    executionTimeoutMs: 10_000,
    cleanupBudgetMs: 3_000,
    handshakeTimeoutMs: 4_000,
  });
  const rootPid = readJson(rootPidFile);
  const rootState = rootPid ? await waitForPidGone(rootPid.pid, 5_000) : null;
  recordResult(id, result, {
    rootPid,
    rootState,
    faultInjection: "brokerFaultMode=2 (product hook, post-authentication)",
  });

  assert.equal(result.job.barrierObserved, true);
  assert.equal(result.ok, false, "a broker that vanished mid-execution is not a clean invocation");
  assert.equal(result.cleanup.terminateCalled, true);
  assert.equal(result.cleanup.activeProcessesKnown, true);
  assert.equal(result.cleanup.activeProcessesFinal, 0);
  assert.equal(result.cleanup.state, "complete");
  if (rootPid) {
    assert.equal(rootState.gone, true, `payload root pid ${rootPid.pid} outlived its broker`);
  }
});

test("baseline/08 caller death closes the last job handle and reaps the tree", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "baseline-08-caller-death";
  const dir = caseDir(id);
  const rootPidFile = path.join(dir, "root-pid.json");
  const startedFile = path.join(dir, "started.json");
  const callerReport = path.join(dir, "caller-report.json");

  // The caller is a separate short-lived Node process precisely so that its death
  // is real. It imports the actual product wrapper; nothing is re-implemented.
  const caller = spawn(
    process.execPath,
    [
      FIXTURE,
      "--mode=caller-suicide",
      `--case=${id}`,
      `--wrapper=${WRAPPER}`,
      `--report-file=${callerReport}`,
      `--root-pid-file=${rootPidFile}`,
      `--started-file=${startedFile}`,
      `--cwd=${WORK}`,
      "--root-sleep-ms=20000",
      "--root-lifetime-ms=25000",
      "--kill-after-ms=2500",
      "--max-lifetime-ms=20000",
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: payloadEnv(id) },
  );
  let callerStderr = "";
  caller.stderr.setEncoding("utf8");
  caller.stderr.on("data", (chunk) => { callerStderr += chunk; });

  const rootPid = await waitForFile(rootPidFile, 15_000);
  const callerExit = await new Promise((resolve) => {
    caller.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const rootState = rootPid ? await waitForPidGone(rootPid.pid, 10_000) : null;
  const summary = {
    event: "case-result",
    case: id,
    callerExit,
    callerStderr: callerStderr.slice(0, 2000),
    callerReport: readJson(callerReport),
    started: readJson(startedFile),
    rootPid,
    rootState,
  };
  journal(summary);
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(summary, null, 2));

  assert.ok(rootPid, "the payload root never started, so caller death proved nothing");
  assert.ok(summary.callerReport?.killed, "the caller did not reach its own termination point");
  assert.equal(rootState.gone, true, `payload root pid ${rootPid.pid} survived the death of its caller`);
  assert.ok(
    rootState.elapsedMs < 20_000,
    `the root only disappeared after ${rootState.elapsedMs}ms, which is indistinguishable from its own self-imposed lifetime bound`,
  );
});

test("baseline/09 option validation and bootstrap-env isolation are inert invariants", { timeout: 20_000 }, async () => {
  const id = "baseline-09-validation";
  const base = {
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: [],
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
  };
  const refusals = [];
  const expectRefusal = async (label, patch) => {
    await assert.rejects(
      () => run({ ...base, ...patch }),
      (error) => {
        refusals.push({ label, code: error.code, name: error.name });
        return error.code === "ERR_OWNED_JOB_OPTIONS";
      },
      label,
    );
  };
  await expectRefusal("relative nodeExe", { nodeExe: "node" });
  await expectRefusal("relative binPath", { binPath: "peer.mjs" });
  await expectRefusal("NUL in args", { args: ["a\u0000b"] });
  await expectRefusal("env with = in key", { env: { "A=B": "c" } });
  await expectRefusal("negative timeout", { executionTimeoutMs: -1 });
  await expectRefusal("non-integer budget", { cleanupBudgetMs: 1.5 });

  // A loader hook or NODE_OPTIONS inherited into the bootstrap would execute
  // before ownership exists. The allowlist must exclude anything not named.
  const probeKey = "AIG_OWNED_BOOTSTRAP_PROBE";
  process.env[probeKey] = "synthetic-probe";
  // NODE_OPTIONS is deliberately not set by this suite: asserting that the
  // allowlist cannot carry it is the invariant, and injecting it into the test
  // process would change the runtime under test to make that point.
  try {
    const clean = __testing.bootstrapEnv();
    const keys = Object.keys(clean).sort();
    journal({ event: "case-result", case: id, refusals, bootstrapKeys: keys });
    fs.writeFileSync(
      path.join(caseDir(id), "result.json"),
      JSON.stringify({ refusals, bootstrapKeys: keys, allowlist: __testing.BOOTSTRAP_ALLOWLIST }, null, 2),
    );
    assert.equal(Object.prototype.hasOwnProperty.call(clean, probeKey), false);
    assert.equal(__testing.BOOTSTRAP_ALLOWLIST.includes("NODE_OPTIONS"), false);
    for (const key of keys) {
      assert.ok(__testing.BOOTSTRAP_ALLOWLIST.includes(key), `bootstrap env leaked ${key}`);
    }
  } finally {
    delete process.env[probeKey];
  }
});

// ---------------------------------------------------------------------------
// hypothesis reproductions
// ---------------------------------------------------------------------------

test("hypothesis/H1 the caller must not hand its identity or payload to an unverified connector", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "hypothesis-h1-unbound-connector";
  const dir = caseDir(id);
  const reportFile = path.join(dir, "root-report.json");
  const peer = startPeer(id, "payload");

  await peer.ready;

  let pipeName = null;
  let spawnedBrokerPid = null;
  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, [`--report-file=${reportFile}`, "--exit-code=0", "--max-lifetime-ms=15000"]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    executionTimeoutMs: 8_000,
    handshakeTimeoutMs: 2_000,
    cleanupBudgetMs: 2_000,
    onStarted: (started) => {
      // The name comes from the product's own hook. The harness does not enumerate
      // command lines or the pipe namespace to obtain it.
      pipeName = started.pipeName;
      spawnedBrokerPid = started.brokerPid;
      peer.release(started.pipeName);
    },
  });
  const collected = await peer.collect();
  const report = collected.report;
  const rootReport = readJson(reportFile);

  const verdict = report?.connected !== true
    ? "inconclusive-peer-never-connected"
    : report.payloadReceived
      ? "reproduced"
      : report.identReceived
        ? "partial-ident-only"
        : "safe";

  recordResult(id, result, {
    hypothesis: "H1",
    verdict,
    harnessAssisted: {
      pipeNameSource: "product onStarted hook",
      peerPreWarmed: true,
      note: "name disclosure and the connect-race bias are harness-supplied; the absence of caller-side client binding is not",
    },
    spawnedBrokerPid,
    pipeNameShape: typeof pipeName === "string" ? pipeName.replace(/[0-9a-f]{32}$/, "<32 hex>") : null,
    peerExit: collected.exit,
    peerReport: report,
    rootReport,
  });

  assert.notEqual(verdict, "inconclusive-peer-never-connected",
    `the competing peer never reached the control pipe (connectError=${report?.connectError}); this run is inconclusive for H1, not evidence of safety`);

  // Observed identity facts. On current source the connector's pid is recorded but
  // never compared with the pid of the broker the caller itself spawned.
  assert.notEqual(report.peerPid, spawnedBrokerPid, "harness error: the peer must not be the spawned broker");
  assert.equal(result.broker.observedPid, report.peerPid,
    "harness error: the caller did not observe the peer as its pipe client, so this case measured nothing");

  // The safe invariant, asserted as such. H1 predicts both of these fail.
  assert.equal(report.identReceived, false,
    `the caller disclosed IDENT (pid ${report.callerPid}, job handle ${report.jobHandleValue}) to pid ${report.peerPid}, which is not the broker it spawned (pid ${spawnedBrokerPid})`);
  assert.equal(report.payloadReceived, false,
    `the caller sent the PAYLOAD frame to unverified pid ${report.peerPid}; markerKeyPresent=${report.markerKeyPresent} markerValueMatched=${report.markerValueMatched} envKeys=${JSON.stringify(report.payloadEnvKeys)}`);
});

test("hypothesis/H2 a wire OWNED frame alone must not satisfy the barrier or the cleanup oracle", { timeout: CASE_TIMEOUT_MS }, async () => {
  const id = "hypothesis-h2-fabricated-lifetime";
  const dir = caseDir(id);
  const reportFile = path.join(dir, "root-report.json");
  const peer = startPeer(id, "complete");

  await peer.ready;

  let spawnedBrokerPid = null;
  const result = await run({
    nodeExe: process.execPath,
    binPath: FIXTURE,
    args: fixtureArgs(id, [`--report-file=${reportFile}`, "--exit-code=0", "--max-lifetime-ms=15000"]),
    cwd: WORK,
    env: payloadEnv(id),
    input: "",
    executionTimeoutMs: 8_000,
    handshakeTimeoutMs: 2_000,
    cleanupBudgetMs: 2_000,
    onStarted: (started) => {
      spawnedBrokerPid = started.brokerPid;
      peer.release(started.pipeName);
    },
  });
  const collected = await peer.collect();
  const report = collected.report;
  const rootReport = readJson(reportFile);

  const fabricated = result.ok === true && result.cleanup.state === "complete";
  const verdict = report?.connected !== true
    ? "inconclusive-peer-never-connected"
    : fabricated
      ? "reproduced"
      : "safe";

  recordResult(id, result, {
    hypothesis: "H2",
    verdict,
    harnessAssisted: {
      pipeNameSource: "product onStarted hook",
      peerPreWarmed: true,
      note: "the peer creates no job, assigns nothing and launches nothing; only wire frames are produced",
    },
    spawnedBrokerPid,
    peerExit: collected.exit,
    peerReport: report,
    // Positive evidence that nothing actually ran: the real payload never wrote a
    // report, because it was never launched by anything.
    rootReport,
  });

  assert.notEqual(verdict, "inconclusive-peer-never-connected",
    `the competing peer never reached the control pipe (connectError=${report?.connectError}); this run is inconclusive for H2, not evidence of safety`);
  assert.equal(report.ownedClaimSent, true);
  assert.equal(report.exitFabricated, true, "harness error: the peer did not complete the fabricated lifetime");
  assert.equal(rootReport, null, "harness error: a real payload ran, so this case did not test a fabricated lifetime");

  // The safe invariant. H2 predicts every one of these fails.
  assert.equal(result.job.barrierObserved, false,
    "a wire OWNED frame from an unverified peer set the ownership barrier with nothing assigned to the job");
  assert.notEqual(result.cleanup.state, "complete",
    `cleanup reported "${result.cleanup.state}" (${result.cleanup.reason}) for a job that never had a member; activeProcessesFinal=${result.cleanup.activeProcessesFinal} totalTerminated=${result.cleanup.totalTerminatedProcesses}`);
  assert.equal(result.ok, false,
    `the invocation reported ok=true with stopReason=${result.stopReason} and rootExitCode=${result.rootExitCode}, although no payload was ever launched`);
});
