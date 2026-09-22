#!/usr/bin/env node
// Task1167 / release1171 — trusted Windows owned-job bootstrap (operation wn1167a-v1).
//
// This is the ONLY thing the caller launches. It runs before ownership exists, so
// it must stay small, import nothing but node: builtins plus the sibling addon,
// and never touch user-supplied data until the ownership barrier has passed.
//
// Order is enforced by owned-job.cc, not by politeness here:
//   1. connect to the caller's private control pipe (random one-instance name);
//   2. authenticate the caller by pipe-server PID *and* process creation time;
//   3. duplicate the caller's job handle, self-assign, close the duplicate  <- BARRIER
//   4. only now read the PAYLOAD frame, parse it, and launch the payload.
// A caller that dies inside step 3 makes the native watchdog drop the duplicate,
// so the job's last handle closes and KILL_ON_JOB_CLOSE runs instead of leaving a
// stranded holder. Nothing here can move step 4 ahead of step 3.
//
// This process writes NOTHING of its own to stdout/stderr: those two pipes carry
// the payload's raw bytes and nothing else. Broker diagnostics travel on the
// control channel as FAULT frames, plus the exit codes below. Broker exit is a
// diagnostic for the caller and is NEVER the CLI's exit code; the root exit is
// reported separately over the control channel.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXIT_USAGE = 90;
const EXIT_ADDON = 91;
const EXIT_OWNERSHIP = 92;
const EXIT_PAYLOAD = 93;
const EXIT_LAUNCH = 94;
const EXIT_INTERNAL = 95;
const EXIT_TEST_FAULT_BEFORE_BARRIER = 97;
const EXIT_TEST_FAULT_AFTER_LAUNCH = 98;
const EXIT_REPORTED = 0;

// JS-side FAULT stage codes. 1..9 are reserved for owned-job.cc's native stages.
const STAGE_PAYLOAD_DECODE = 20;
const STAGE_PAYLOAD_VALIDATE = 21;
const STAGE_SPAWN_THREW = 22;
const STAGE_INTERNAL = 23;

const ROOT_EXIT_UNAVAILABLE = 4294967295; // sentinel: root exit code not observable
const CONTROL_SEND_MS = 1000;
const FLUSH_MARGIN_MS = 200;

const here = path.dirname(fileURLToPath(import.meta.url));
const started = Date.now();
const since = () => Date.now() - started;

// Fixed, in-tree addon locations only. No env var selects the binary: an
// attacker-chosen addon path would execute native code before ownership.
const ADDON_CANDIDATES = [
  path.join(here, "..", "native", "windows-owned-job", "build", "Release", "owned_job.node"),
  path.join(here, "..", "native", "windows-owned-job", "prebuilt", "win32-x64", "owned_job.node"),
];

let control = null;
function send(line) {
  if (control === null) return;
  try { native.controlSend(control, line, CONTROL_SEND_MS); } catch { /* caller deadline covers a dead channel */ }
}
// Exits without touching stdout/stderr. Pre-barrier there is no control channel,
// so the exit code plus the native FAULT frame are the whole diagnostic.
function quit(code, stage) {
  if (stage !== undefined) send(`AIGJOB1 FAULT ${stage} 0 ${since()}`);
  process.exit(code);
}

if (process.platform !== "win32") quit(EXIT_USAGE);
// argv: [node, thisFile, pipeName, handshakeTimeoutMs?]. Anything else is refused;
// this process never parses flags and never accepts a command string.
if (process.argv.length < 3 || process.argv.length > 4) quit(EXIT_USAGE);
const pipeName = process.argv[2];
let connectTimeoutMs = 5000;
if (process.argv.length === 4) {
  const raw = Number(process.argv[3]);
  if (!Number.isInteger(raw) || raw < 1 || raw > 600000) quit(EXIT_USAGE);
  connectTimeoutMs = raw;
}

const require = createRequire(import.meta.url);
let native = null;
for (const candidate of ADDON_CANDIDATES) {
  try {
    native = require(candidate);
    break;
  } catch { /* try the next fixed location */ }
}
// Fail closed: a missing or incompatible addon is an explicit Windows refusal,
// never a POSIX-style fallback launch.
if (!native || typeof native.acquireOwnership !== "function") quit(EXIT_ADDON);

// --- barrier -----------------------------------------------------------------
let owned;
try {
  owned = native.acquireOwnership(pipeName, connectTimeoutMs);
} catch (error) {
  // acquireOwnership already emitted a FAULT frame carrying the raw GetLastError.
  quit(error?.code === "ERR_OWNED_JOB_TEST_FAULT" ? EXIT_TEST_FAULT_BEFORE_BARRIER : EXIT_OWNERSHIP);
}
if (!owned?.assigned) quit(EXIT_OWNERSHIP);
control = owned.control;

// --- payload frame (first user data, strictly after the barrier) --------------
let payload;
try {
  payload = JSON.parse(Buffer.from(owned.payloadFrame, "base64").toString("utf8"));
} catch {
  quit(EXIT_PAYLOAD, STAGE_PAYLOAD_DECODE);
}

const ALLOWED_KEYS = new Set([
  "protocol", "nodeExe", "binPath", "args", "cwd", "env", "stdinMode", "drainBudgetMs", "label",
]);
const isPlainString = (v) => typeof v === "string" && !v.includes("\u0000");
function invalid() { quit(EXIT_PAYLOAD, STAGE_PAYLOAD_VALIDATE); }

if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid();
for (const key of Object.keys(payload)) if (!ALLOWED_KEYS.has(key)) invalid();
if (payload.protocol !== 1) invalid();
if (!isPlainString(payload.nodeExe) || !path.isAbsolute(payload.nodeExe)) invalid();
if (!isPlainString(payload.binPath) || !path.isAbsolute(payload.binPath)) invalid();
if (!Array.isArray(payload.args) || !payload.args.every(isPlainString)) invalid();
if (!isPlainString(payload.cwd) || !path.isAbsolute(payload.cwd)) invalid();
if (!payload.env || typeof payload.env !== "object" || Array.isArray(payload.env)) invalid();
for (const [key, value] of Object.entries(payload.env)) {
  if (!isPlainString(key) || key.length === 0 || key.includes("=") || !isPlainString(value)) invalid();
}
if (payload.stdinMode !== "bytes" && payload.stdinMode !== "open") invalid();
const drainBudgetMs = payload.drainBudgetMs ?? 200;
if (!Number.isInteger(drainBudgetMs) || drainBudgetMs < 0 || drainBudgetMs > 60000) invalid();

function errnoTag(error) {
  switch (error?.code) {
    case "ENOENT": return 1;
    case "EACCES": return 2;
    case "EPERM": return 3;
    case "EINVAL": return 4;
    case "E2BIG": return 5;
    default: return 6;
  }
}

// --- payload launch ----------------------------------------------------------
// Node's own default Windows argument handling, shell:false, the exact argv array
// as received, the caller's exact intended env. No handwritten quoting, no
// cross-spawn, no command string, no PID-tree helper.
let child;
try {
  child = spawn(payload.nodeExe, [payload.binPath, ...payload.args], {
    cwd: payload.cwd,
    env: payload.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch {
  quit(EXIT_LAUNCH, STAGE_SPAWN_THREW);
}

let settled = false;
let launchFailed = false;
let stdoutBytes = 0;
let stderrBytes = 0;
let pendingWrites = 0;
let flushWaiter = null;

// Raw byte passthrough. The caller sees exactly the payload's bytes on exactly the
// stream that produced them; no framing shares these pipes, so the caller's own
// output cap is never reduced by control overhead.
function forward(source, sink, count) {
  const done = new Promise((resolve) => {
    source.on("end", resolve);
    source.on("close", resolve);
    source.on("error", resolve);
  });
  source.on("data", (chunk) => {
    count(chunk.length);
    pendingWrites++;
    sink.write(chunk, () => {
      pendingWrites--;
      if (pendingWrites === 0 && flushWaiter) flushWaiter();
    });
  });
  return done;
}

const stdoutDone = forward(child.stdout, process.stdout, (n) => { stdoutBytes += n; });
const stderrDone = forward(child.stderr, process.stderr, (n) => { stderrBytes += n; });

// stdin: exact original bytes with explicit EOF (including empty input), or left
// open when the caller's contract is "stdin undefined".
child.stdin.on("error", () => { /* EPIPE when the payload exits before reading */ });
if (payload.stdinMode === "bytes") {
  process.stdin.on("error", () => { /* caller closed early; the payload still sees EOF */ });
  process.stdin.pipe(child.stdin);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function flushOutbound(budgetMs) {
  if (pendingWrites === 0) return true;
  const flushed = new Promise((resolve) => { flushWaiter = resolve; });
  const ok = await Promise.race([flushed.then(() => true), wait(budgetMs).then(() => false)]);
  flushWaiter = null;
  return ok;
}

// 'spawn' and 'error' are mutually exclusive, so LAUNCHED/LAUNCHERR is reported
// exactly once and the caller's execution budget starts at the real launch rather
// than at bootstrap.
child.on("spawn", () => {
  send(`AIGJOB1 LAUNCHED ${child.pid ?? 0} ${since()}`);
  if (owned.brokerFaultMode === 2) process.exit(EXIT_TEST_FAULT_AFTER_LAUNCH);
});

child.on("error", (error) => {
  if (settled) return;
  settled = true;
  launchFailed = true;
  // Node does not surface GetLastError for a failed spawn; the raw libuv errno and
  // code are the raw cause and are preserved rather than flattened to ENOENT.
  send(`AIGJOB1 LAUNCHERR ${Math.abs(Number(error?.errno) || 0)} ${errnoTag(error)} ${since()}`);
  process.exit(EXIT_LAUNCH);
});

child.on("exit", async (code) => {
  if (settled || launchFailed) return;
  settled = true;

  // Bounded drain: descendants may still hold the payload's pipe write ends, so
  // waiting for EOF is capped and reported, never allowed to postpone the report.
  const drained = await Promise.race([
    Promise.all([stdoutDone, stderrDone]).then(() => true),
    wait(drainBudgetMs).then(() => false),
  ]);
  // Flush our own copies before asking for termination: the caller must not lose
  // bytes still sitting in this process's stream buffers when the job is killed.
  await flushOutbound(drainBudgetMs + FLUSH_MARGIN_MS);

  const reported = code === null || code === undefined ? ROOT_EXIT_UNAVAILABLE : code >>> 0;
  send(`AIGJOB1 EXIT ${reported} ${since()} ${stdoutBytes} ${stderrBytes} ${drained ? 1 : 0}`);
  // The caller's native control thread now terminates the job, which includes this
  // process. Exiting on our own is the harmless race-loser.
  try { native.controlClose(control); } catch { /* channel already gone */ }
  process.exit(EXIT_REPORTED);
});

process.on("uncaughtException", () => { quit(EXIT_INTERNAL, STAGE_INTERNAL); });
