// Task1167 / release1171 — Windows owned-process facade (operation wn1167a-v1).
//
// The caller-side half of the owned-job prototype: it holds the job handle for the
// whole invocation, arms the native control thread BEFORE spawning anything, and
// launches exactly one fixed trusted broker with a clean bootstrap environment.
//
// This .mjs hosts the testable async+sync core so the prototype needs no new TS
// toolchain. Later approved production callers (spawner.ts, bin/model-router.mjs)
// must REUSE this core once it is qualified, not fork it.
//
// Scope limits that this file deliberately does not paper over:
//   * Windows only. There is no POSIX emulation path here; POSIX callers keep
//     their existing code paths and never load the addon.
//   * A missing or incompatible addon is an explicit refusal, not a fallback.
//   * Nonzero root exit codes (including 23) are ordinary results, not errors.
//   * Broker exit is a diagnostic only and is never the CLI's exit code.
//   * cleanup.state is "complete" only when an assignment barrier was observed
//     AND the job was seen empty AND the broker handle was seen exited. An empty
//     job that never had a member reports "unknown", never success.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const OWNED_JOB_PROTOCOL = 1;

const DEFAULTS = Object.freeze({
  executionTimeoutMs: 5_000,   // spawner.run's existing default; router passes 15_000
  cleanupBudgetMs: 500,        // measured separately, never deducted from execution
  handshakeTimeoutMs: 2_000,   // bootstrap only: connect, authenticate, self-assign
  drainBudgetMs: 200,          // bounded root-output drain after root exit
  maxOutputBytes: 1024 * 1024, // per stream; the router's 1MiB payload limit
});

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKER_PATH = path.join(here, "..", "..", "bin", "windows-owned-broker.mjs");
// Fixed, in-tree addon locations only. No env var may select the binary.
const ADDON_CANDIDATES = Object.freeze([
  path.join(here, "build", "Release", "owned_job.node"),
  path.join(here, "prebuilt", "win32-x64", "owned_job.node"),
]);

// Wire codes -> names. Kept here so independent tests can decode a record without
// re-deriving the protocol.
export const BROKER_FAULT_STAGES = Object.freeze({
  1: "connect", 2: "hello", 3: "ident-read", 4: "identity", 5: "duplicate",
  6: "handoff-aborted", 7: "assign", 8: "membership", 9: "payload-read",
  20: "payload-decode", 21: "payload-validate", 22: "spawn-threw", 23: "broker-internal",
  101: "caller-connect", 102: "caller-hello", 103: "caller-ident-write", 104: "caller-owned",
  105: "caller-payload-write", 106: "caller-launch", 107: "caller-execution",
  108: "caller-protocol",
});
export const LAUNCH_ERRNO_TAGS = Object.freeze({
  1: "ENOENT", 2: "EACCES", 3: "EPERM", 4: "EINVAL", 5: "E2BIG", 6: "UNKNOWN",
});
const ROOT_EXIT_UNAVAILABLE = 4294967295;

const require = createRequire(import.meta.url);
let addonState = null;

function loadAddon() {
  if (addonState) return addonState;
  if (process.platform !== "win32") {
    addonState = { native: null, addonPath: null, reason: "unsupported-platform" };
    return addonState;
  }
  let lastError = null;
  for (const candidate of ADDON_CANDIDATES) {
    try {
      const native = require(candidate);
      if (typeof native?.createInvocation !== "function") {
        lastError = new Error("addon is missing createInvocation");
        continue;
      }
      addonState = { native, addonPath: candidate, reason: null };
      return addonState;
    } catch (error) { lastError = error; }
  }
  addonState = {
    native: null,
    addonPath: null,
    reason: "addon-unavailable",
    detail: lastError?.code || lastError?.message || "unknown",
  };
  return addonState;
}

export function isSupported() {
  return loadAddon().native !== null;
}

// Build/qualification metadata for receipts. Never a claim that the addon works.
export function inspect() {
  const state = loadAddon();
  let describe = null;
  try { describe = state.native?.describe?.() ?? null; } catch { describe = null; }
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    brokerPath: BROKER_PATH,
    addonPath: state.addonPath,
    addonCandidates: [...ADDON_CANDIDATES],
    unavailableReason: state.reason,
    unavailableDetail: state.detail ?? null,
    describe,
    protocol: OWNED_JOB_PROTOCOL,
  };
}

// ---------------------------------------------------------------------------
// Option validation — every field crosses a process boundary, so nothing here is
// trusted just because it came from our own caller.
// ---------------------------------------------------------------------------

class OwnedProcessError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "OwnedProcessError";
  }
}

const isCleanString = (v) => typeof v === "string" && !v.includes("\u0000");

function budget(value, fallback, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", `${field} must be an integer in [0, ${max}]`);
  }
  return value;
}

function validate(options, mode) {
  if (!options || typeof options !== "object") {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "options object is required");
  }
  const { nodeExe, binPath, args = [], cwd, env, input, signal } = options;
  if (!isCleanString(nodeExe) || !path.isAbsolute(nodeExe)) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "nodeExe must be an absolute path");
  }
  if (!isCleanString(binPath) || !path.isAbsolute(binPath)) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "binPath must be an absolute path");
  }
  if (!Array.isArray(args) || !args.every(isCleanString)) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "args must be an array of NUL-free strings");
  }
  if (!isCleanString(cwd) || !path.isAbsolute(cwd)) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "cwd must be an absolute path");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "env must be an object of strings");
  }
  for (const [key, value] of Object.entries(env)) {
    if (!isCleanString(key) || key.length === 0 || key.includes("=") || !isCleanString(value)) {
      throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", `env[${key}] is not a clean string`);
    }
  }
  if (input !== undefined && typeof input !== "string" && !Buffer.isBuffer(input)) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "input must be a string, Buffer or undefined");
  }
  // The sync path cannot express "leave stdin open": spawnSync always closes the
  // child's stdin. Say so rather than silently changing the stdin contract.
  if (mode === "sync" && input === undefined) {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "runSync requires input (use an empty string for explicit EOF)");
  }
  if (signal !== undefined && typeof signal?.addEventListener !== "function") {
    throw new OwnedProcessError("ERR_OWNED_JOB_OPTIONS", "signal must be an AbortSignal");
  }
  return {
    nodeExe,
    binPath,
    args: [...args],
    cwd,
    env: { ...env },
    input,
    signal,
    executionTimeoutMs: budget(options.executionTimeoutMs, DEFAULTS.executionTimeoutMs, 3_600_000, "executionTimeoutMs"),
    cleanupBudgetMs: budget(options.cleanupBudgetMs, DEFAULTS.cleanupBudgetMs, 600_000, "cleanupBudgetMs"),
    handshakeTimeoutMs: budget(options.handshakeTimeoutMs, DEFAULTS.handshakeTimeoutMs, 600_000, "handshakeTimeoutMs"),
    drainBudgetMs: budget(options.drainBudgetMs, DEFAULTS.drainBudgetMs, 60_000, "drainBudgetMs"),
    maxOutputBytes: budget(options.maxOutputBytes, DEFAULTS.maxOutputBytes, 64 * 1024 * 1024, "maxOutputBytes"),
    // Test hooks. Both travel only over the authenticated control channel, both are
    // echoed back in the record, and neither can let a payload start before the
    // ownership barrier: handoffHoldMs only widens the pre-barrier window and
    // brokerFaultMode only makes the broker exit.
    handoffHoldMs: budget(options.handoffHoldMs, 0, 5_000, "handoffHoldMs"),
    brokerFaultMode: budget(options.brokerFaultMode, 0, 2, "brokerFaultMode"),
    onStarted: typeof options.onStarted === "function" ? options.onStarted : null,
    label: isCleanString(options.label) ? options.label : "",
  };
}

// Clean bootstrap environment, built by allowlist rather than by deletion, so no
// inherited NODE_OPTIONS, loader hook or user module can execute before ownership.
// The payload's own intended env travels separately in the control frame.
const BOOTSTRAP_ALLOWLIST = Object.freeze([
  "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "COMSPEC",
]);

function bootstrapEnv() {
  const clean = Object.create(null);
  for (const key of BOOTSTRAP_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string") clean[key] = value;
  }
  return clean;
}

function payloadFrame(opts, stdinMode) {
  const frame = {
    protocol: OWNED_JOB_PROTOCOL,
    nodeExe: opts.nodeExe,
    binPath: opts.binPath,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    stdinMode,
    drainBudgetMs: opts.drainBudgetMs,
    label: opts.label,
  };
  return Buffer.from(JSON.stringify(frame), "utf8").toString("base64");
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function refusal(reason, detail) {
  const state = loadAddon();
  return {
    ok: false,
    stopReason: reason,
    rootExitCode: null,
    rootSignal: null,
    rootPid: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    launchError: null,
    error: new OwnedProcessError(
      reason === "unsupported-platform" ? "ERR_OWNED_JOB_UNSUPPORTED_PLATFORM" : "ERR_OWNED_JOB_ADDON_UNAVAILABLE",
      detail,
    ),
    cleanup: { state: "unknown", reason: "never-started", elapsedMs: 0, activeProcessesFinal: null, activeProcessesKnown: false, terminateCalled: false },
    broker: { pid: null, exitCode: null, signal: null },
    job: { flagsRequested: null, flagsEffective: null, flagsEffectiveKnown: false, activeProcessesAtBarrier: null },
    timings: { handshakeMs: null, executionMs: null, cleanupMs: null, totalMs: 0, firstOutputAtMs: null, barrierAtMs: null, launchedAtMs: null },
    record: null,
    addonPath: state.addonPath,
    protocol: OWNED_JOB_PROTOCOL,
  };
}

function primaryError(stopReason, record, overflow) {
  if (overflow) {
    return Object.assign(new Error("owned-job: output exceeded maxOutputBytes"), { code: "ENOBUFS" });
  }
  switch (stopReason) {
    case "root-exit":
      return null;
    case "deadline":
      return Object.assign(new Error("owned-job: execution deadline exceeded"), { code: "ETIMEDOUT" });
    case "cancel": {
      const error = new Error("owned-job: invocation aborted");
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      return error;
    }
    case "buffer-overflow":
      return Object.assign(new Error("owned-job: output exceeded maxOutputBytes"), { code: "ENOBUFS" });
    case "launch-error": {
      const tag = LAUNCH_ERRNO_TAGS[record?.launchErrnoTag] || "UNKNOWN";
      return Object.assign(new Error(`owned-job: payload launch failed (${tag})`), {
        code: tag === "UNKNOWN" ? "ERR_OWNED_JOB_LAUNCH" : tag,
        errno: record?.launchWinError ? -Math.abs(record.launchWinError) : undefined,
        syscall: "spawn",
      });
    }
    case "broker-refusal":
    case "broker-fault":
    case "control-fault":
    case "handshake-timeout":
    case "handshake-failure": {
      const stage = BROKER_FAULT_STAGES[record?.faultStage] || `stage-${record?.faultStage ?? 0}`;
      return new OwnedProcessError(
        "ERR_OWNED_JOB_OWNERSHIP",
        `${stopReason} at ${stage} (GetLastError=${record?.faultWinError ?? 0})`,
      );
    }
    case "broker-spawn-error":
      return new OwnedProcessError("ERR_OWNED_JOB_BOOTSTRAP", "the trusted broker could not be started");
    default:
      return new OwnedProcessError("ERR_OWNED_JOB_UNKNOWN", `unclassified stop reason "${stopReason || "none"}"`);
  }
}

function buildResult({ record, stdout, stderr, stdoutTruncated, stderrTruncated, brokerExit, brokerSignal, brokerPid, overflow, totalMs, firstOutputAtMs, fallbackStop }) {
  const stopReason = overflow ? "buffer-overflow" : (record?.stopReason || fallbackStop || "unknown");
  const rootExitCode = record?.hasRootExit
    ? (record.rootExitCode === ROOT_EXIT_UNAVAILABLE ? null : record.rootExitCode)
    : null;
  const cleanupState = record?.cleanupState || "unknown";
  const error = primaryError(stopReason, record, overflow);
  return {
    // "ok" means the root ran under proven ownership and cleanup was proven —
    // it says nothing about the CLI's own exit code.
    ok: stopReason === "root-exit" && cleanupState === "complete",
    stopReason,
    rootExitCode,
    // Windows has no POSIX signals for the root; the field exists so the shared
    // result shape matches the POSIX paths, and stays null here.
    rootSignal: null,
    rootPid: record?.launched ? record.rootPid : null,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    launchError: record?.hasLaunchError
      ? { code: LAUNCH_ERRNO_TAGS[record.launchErrnoTag] || "UNKNOWN", rawErrno: record.launchWinError, syscall: "spawn" }
      : null,
    error,
    cleanup: {
      state: cleanupState,
      reason: record?.cleanupReason || "not-started",
      elapsedMs: record?.cleanupElapsedMs ?? null,
      activeProcessesFinal: record?.activeProcessesKnown ? record.activeProcessesFinal : null,
      activeProcessesKnown: Boolean(record?.activeProcessesKnown),
      totalTerminatedProcesses: record?.totalTerminatedProcesses ?? null,
      terminateCalled: Boolean(record?.terminateCalled),
      terminateOk: Boolean(record?.terminateOk),
      terminateWinError: record?.terminateWinError ?? null,
      brokerExitObserved: Boolean(record?.brokerExitObserved),
      settled: Boolean(record?.settled),
    },
    broker: {
      pid: brokerPid ?? (record?.brokerPid || null),
      exitCode: brokerExit ?? null,
      signal: brokerSignal ?? null,
      observedPid: record?.brokerPid || null,
      faultMode: record?.brokerFaultMode ?? 0,
    },
    job: {
      flagsRequested: record?.jobFlagsRequested ?? null,
      flagsEffective: record?.jobFlagsEffective ?? null,
      flagsEffectiveKnown: Boolean(record?.jobFlagsEffectiveKnown),
      barrierObserved: Boolean(record?.barrier),
      activeProcessesAtBarrier: record?.barrier ? record.barrierActiveProcesses : null,
      rootDrainComplete: Boolean(record?.rootDrainComplete),
      rootStdoutBytes: record?.rootStdoutBytes ?? null,
      rootStderrBytes: record?.rootStderrBytes ?? null,
    },
    timings: {
      handshakeMs: record?.handshakeElapsedMs ?? null,
      executionMs: record?.executionElapsedMs ?? null,
      cleanupMs: record?.cleanupElapsedMs ?? null,
      totalMs,
      // The inert ordering oracle: no payload byte may predate the barrier.
      firstOutputAtMs,
      barrierAtMs: record?.barrier ? record.barrierAtMs : null,
      launchedAtMs: record?.launched ? record.launchedAtMs : null,
    },
    record: record ?? null,
    addonPath: loadAddon().addonPath,
    protocol: OWNED_JOB_PROTOCOL,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Async owned invocation. Resolves exactly once with a result; runtime outcomes
 * (timeout, cancel, nonzero root exit, refusal) are reported in the result rather
 * than thrown, so a test can assert on them without racing rejections. Only
 * option validation throws.
 */
export async function run(options) {
  const state = loadAddon();
  if (!state.native) {
    return refusal(state.reason === "unsupported-platform" ? "unsupported-platform" : "addon-unavailable",
      state.detail ? `owned_job addon unavailable (${state.detail})` : "owned-job is Windows-only");
  }
  const opts = validate(options, "async");
  const native = state.native;
  const startedAt = Date.now();

  const created = native.createInvocation({
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
    executionTimeoutMs: opts.executionTimeoutMs,
    cleanupBudgetMs: opts.cleanupBudgetMs,
    handoffHoldMs: opts.handoffHoldMs,
    brokerFaultMode: opts.brokerFaultMode,
    payloadFrame: payloadFrame(opts, opts.input === undefined ? "open" : "bytes"),
  });
  const invocation = created.invocation;

  let abortListener = null;
  try {
    // Armed BEFORE the spawn: every deadline from here on is enforced by the
    // native control thread, never by a JavaScript timer.
    native.arm(invocation);

    const child = spawn(process.execPath, [BROKER_PATH, created.pipeName, String(opts.handshakeTimeoutMs)], {
      cwd: here,
      env: bootstrapEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (opts.signal) {
      if (opts.signal.aborted) native.cancel(invocation, 1);
      abortListener = () => native.cancel(invocation, 1);
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }
    if (opts.onStarted) {
      opts.onStarted({
        brokerPid: child.pid ?? null,
        pipeName: created.pipeName,
        snapshot: () => native.snapshot(invocation),
        cancel: () => native.cancel(invocation, 1),
      });
    }

    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let overflow = false;
    let firstOutputAtMs = null;

    const collect = (stream, key) => {
      stream?.on("data", (chunk) => {
        if (firstOutputAtMs === null) firstOutputAtMs = Date.now() - startedAt;
        if (truncated[key]) return;
        if (sizes[key] + chunk.length > opts.maxOutputBytes) {
          truncated[key] = true;
          overflow = true;
          // Stop the invocation through the native path; a JS-side kill would only
          // reach the broker, not the owned tree.
          native.cancel(invocation, 2);
          return;
        }
        sizes[key] += chunk.length;
        chunks[key].push(chunk);
      });
      stream?.on("error", () => { /* pipe teardown races job termination */ });
    };
    collect(child.stdout, "stdout");
    collect(child.stderr, "stderr");

    if (opts.input !== undefined) {
      child.stdin?.on("error", () => { /* EPIPE if the broker died first */ });
      child.stdin?.end(typeof opts.input === "string" ? Buffer.from(opts.input, "utf8") : opts.input);
    }

    const closed = await new Promise((resolve) => {
      let done = false;
      const settle = (value) => { if (!done) { done = true; resolve(value); } };
      child.on("error", (error) => settle({ spawnError: error, code: null, signal: null }));
      child.on("close", (code, signal) => settle({ spawnError: null, code, signal }));
    });

    // Bounded: the control thread has already run its own cleanup budget by the
    // time the broker's pipes closed, so this normally returns immediately.
    const record = closed.spawnError ? null : native.finish(invocation, opts.cleanupBudgetMs + 1_000);

    return buildResult({
      record,
      stdout: Buffer.concat(chunks.stdout, sizes.stdout),
      stderr: Buffer.concat(chunks.stderr, sizes.stderr),
      stdoutTruncated: truncated.stdout,
      stderrTruncated: truncated.stderr,
      brokerExit: closed.code,
      brokerSignal: closed.signal,
      brokerPid: child.pid ?? null,
      overflow,
      totalMs: Date.now() - startedAt,
      firstOutputAtMs,
      fallbackStop: closed.spawnError ? "broker-spawn-error" : null,
    });
  } finally {
    if (abortListener && opts.signal) opts.signal.removeEventListener("abort", abortListener);
    // Closing the caller's job handle is the last line of defence: whatever the
    // control thread concluded, KILL_ON_JOB_CLOSE fires here.
    native.dispose(invocation);
  }
}

/**
 * Synchronous owned invocation for the classifier path. The caller's JavaScript is
 * blocked for the whole call; every deadline is enforced by the native control
 * thread, which is why this does not and must not rely on a JS timer.
 */
export function runSync(options) {
  const state = loadAddon();
  if (!state.native) {
    return refusal(state.reason === "unsupported-platform" ? "unsupported-platform" : "addon-unavailable",
      state.detail ? `owned_job addon unavailable (${state.detail})` : "owned-job is Windows-only");
  }
  const opts = validate(options, "sync");
  const native = state.native;
  const startedAt = Date.now();

  const created = native.createInvocation({
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
    executionTimeoutMs: opts.executionTimeoutMs,
    cleanupBudgetMs: opts.cleanupBudgetMs,
    handoffHoldMs: opts.handoffHoldMs,
    brokerFaultMode: opts.brokerFaultMode,
    payloadFrame: payloadFrame(opts, "bytes"),
  });
  const invocation = created.invocation;

  try {
    native.arm(invocation);
    if (opts.onStarted) {
      // Sync callers are blocked from here until the child closes, so this hook can
      // only record intent; it cannot observe or cancel mid-flight.
      opts.onStarted({ brokerPid: null, pipeName: created.pipeName, snapshot: null, cancel: null });
    }

    // No JS timer participates in this call. `timeout` below is Node's sync-loop
    // backstop (implemented in the spawnSync C++ loop, not on the JS event loop)
    // and is deliberately slack: it exists only in case the native control thread
    // itself fails, and it is never the mechanism that bounds execution.
    const backstopMs = opts.handshakeTimeoutMs + opts.handoffHoldMs + opts.executionTimeoutMs +
      opts.cleanupBudgetMs + 2_000;
    const res = spawnSync(process.execPath, [BROKER_PATH, created.pipeName, String(opts.handshakeTimeoutMs)], {
      cwd: here,
      env: bootstrapEnv(),
      shell: false,
      input: typeof opts.input === "string" ? Buffer.from(opts.input, "utf8") : opts.input,
      maxBuffer: opts.maxOutputBytes,
      timeout: backstopMs,
      killSignal: "SIGKILL",
    });

    const overflow = res.error?.code === "ENOBUFS";
    const record = native.finish(invocation, opts.cleanupBudgetMs + 1_000);

    return buildResult({
      record,
      stdout: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.alloc(0),
      stderr: Buffer.isBuffer(res.stderr) ? res.stderr : Buffer.alloc(0),
      stdoutTruncated: overflow,
      stderrTruncated: false,
      brokerExit: res.status,
      brokerSignal: res.signal,
      brokerPid: res.pid ?? null,
      overflow,
      totalMs: Date.now() - startedAt,
      // spawnSync buffers everything, so per-chunk arrival times do not exist on
      // this path; the barrier ordering oracle here is the native record alone.
      firstOutputAtMs: null,
      fallbackStop: res.error && !overflow ? "broker-spawn-error" : null,
    });
  } finally {
    native.dispose(invocation);
  }
}

export const __testing = Object.freeze({
  DEFAULTS,
  BROKER_PATH,
  ADDON_CANDIDATES,
  BOOTSTRAP_ALLOWLIST,
  bootstrapEnv,
  payloadFrame,
  validate,
  ROOT_EXIT_UNAVAILABLE,
});
