// Task1167 / release1171 — Windows owned-process facade (operation wn1167a-v1).
//
// The caller-side half of the owned-job prototype: it holds the job handle for the
// whole invocation, arms the native control thread BEFORE starting anything, and
// launches exactly one fixed trusted broker with a clean bootstrap environment.
//
// The broker is created by the addon (native.startBroker -> CreateProcessW), not
// by child_process. That is the producer/consumer binding the control channel
// authenticates against: the expected broker identity is a creation result plus
// an owned process handle, which exists before the channel is serviced and is
// therefore available to runSync, whose JavaScript is blocked for the whole call
// and can never hand a spawn result to the control thread mid-flight. The broker's
// stdio is pumped into bounded native buffers, so caller-facing stdout/stderr, the
// output cap and the ordering oracle are identical on both entry points.
// run() and runSync() keep their existing public contracts and result shape.
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
  108: "caller-protocol", 109: "caller-broker-identity", 110: "caller-barrier",
  111: "caller-broker-create",
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
      // An addon predating the owned-broker binding would load but could not
      // authenticate the control channel. Missing exports are an explicit
      // refusal, never a silent downgrade to the unbound path.
      const missing = ["createInvocation", "arm", "startBroker", "finish", "waitAsync", "output",
        "cancel", "snapshot", "dispose"].find((name) => typeof native?.[name] !== "function");
      if (missing) {
        lastError = new Error(`addon is missing ${missing}`);
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
  // runSync's published contract has always required explicit input; the caller
  // is blocked for the whole call and has no way to feed a stdin that is left
  // open. Unchanged on purpose — widening it here would be a public API change,
  // not a security correction.
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

// CreateProcessW takes an environment block, so the same allowlisted map is handed
// to the addon as KEY=VALUE strings. A NUL or a leading "=" would corrupt the block
// and is refused here rather than truncating it silently.
function bootstrapEnvPairs() {
  const pairs = [];
  for (const [key, value] of Object.entries(bootstrapEnv())) {
    if (!isCleanString(key) || key.length === 0 || key.includes("=") || !isCleanString(value)) {
      continue;
    }
    pairs.push(`${key}=${value}`);
  }
  return pairs;
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
    case "handshake-failure":
    // Refused before IDENT: whoever reached the control pipe was not the broker
    // this invocation created, so nothing was disclosed.
    case "broker-identity-mismatch":
    case "broker-identity-unavailable":
    // Refused before PAYLOAD: the caller could not observe its own job owning the
    // expected broker, so the wire's OWNED claim was not accepted.
    case "barrier-unverified": {
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
      brokerTerminated: Boolean(record?.brokerTerminated),
      settled: Boolean(record?.settled),
    },
    broker: {
      pid: brokerPid ?? (record?.brokerPid || null),
      exitCode: brokerExit ?? null,
      signal: brokerSignal ?? null,
      // The identity this invocation created, and the identity that actually
      // reached the control pipe. They are reported separately on purpose: a
      // mismatch is the H1 defect and must stay visible rather than be collapsed.
      expectedPid: record?.brokerPid || null,
      observedPid: record?.observedClientPid || null,
      identityVerified: Boolean(record?.brokerIdentityVerified),
      created: Boolean(record?.brokerCreated),
      createWinError: record?.brokerCreateWinError ?? null,
      faultMode: record?.brokerFaultMode ?? 0,
    },
    job: {
      flagsRequested: record?.jobFlagsRequested ?? null,
      flagsEffective: record?.jobFlagsEffective ?? null,
      flagsEffectiveKnown: Boolean(record?.jobFlagsEffectiveKnown),
      barrierObserved: Boolean(record?.barrier),
      // activeProcessesAtBarrier keeps its existing meaning: the count the broker
      // REPORTED on the wire. The caller's own measurements are the two fields
      // below, and they are what the barrier is actually gated on.
      activeProcessesAtBarrier: record?.barrier ? record.barrierActiveProcesses : null,
      reportedActiveProcessesAtBarrier: record?.barrierReportedActiveProcesses ?? null,
      observedActiveProcessesAtBarrier: record?.barrierObservedKnown
        ? record.barrierObservedActiveProcesses
        : null,
      observedActiveProcessesKnown: Boolean(record?.barrierObservedKnown),
      brokerInJobAtBarrier: record?.barrierBrokerInJobKnown
        ? Boolean(record.barrierBrokerInJob)
        : null,
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
// Shared invocation wiring
// ---------------------------------------------------------------------------
// run() and runSync() build the same native invocation and the same broker
// through these three helpers, so there is exactly one producer/consumer binding
// to audit rather than one per entry point.

function inputBuffer(input) {
  if (input === undefined) return undefined;
  return typeof input === "string" ? Buffer.from(input, "utf8") : input;
}

function invocationOptions(opts, stdinMode) {
  return {
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
    executionTimeoutMs: opts.executionTimeoutMs,
    cleanupBudgetMs: opts.cleanupBudgetMs,
    handoffHoldMs: opts.handoffHoldMs,
    brokerFaultMode: opts.brokerFaultMode,
    maxOutputBytes: opts.maxOutputBytes,
    // Present => the broker's stdin receives exactly these bytes followed by an
    // explicit EOF, empty input included. Absent => stdin stays open, which is
    // the async caller's "input undefined" contract.
    input: inputBuffer(opts.input),
    payloadFrame: payloadFrame(opts, stdinMode),
  };
}

function brokerOptions(opts, pipeName) {
  return {
    // Fixed absolute paths only: the caller's own interpreter and the in-tree
    // broker. The addon passes nodeExe as lpApplicationName, so no PATH search
    // and no command-line reinterpretation can select a different binary.
    nodeExe: process.execPath,
    script: BROKER_PATH,
    pipeName,
    cwd: here,
    handshakeTimeoutMs: opts.handshakeTimeoutMs,
    envPairs: bootstrapEnvPairs(),
  };
}

// Slack backstop only. The native control thread owns every real deadline; this
// just bounds the wait in case that thread itself fails. Clamped to the addon's
// accepted range so an out-of-range value can never silently collapse to the
// addon's much shorter default.
const MAX_NATIVE_WAIT_MS = 5_000_000;
function backstopMs(opts) {
  const total = opts.handshakeTimeoutMs + opts.handoffHoldMs + opts.executionTimeoutMs +
    opts.cleanupBudgetMs + 2_000;
  return Math.min(total, MAX_NATIVE_WAIT_MS);
}

// startBroker throwing means no broker process exists: nothing was owned and
// nothing was disclosed. The addon has already recorded the stage and unwound the
// armed control thread, so this settles the record and reports a bootstrap
// failure rather than an ownership result. The raw cause is preserved.
function brokerStartFailure(native, invocation, opts, startedAt, error) {
  let record = null;
  try {
    record = native.finish(invocation, opts.cleanupBudgetMs + 1_000);
  } catch {
    record = null;
  }
  const result = buildResult({
    record,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    brokerExit: null,
    brokerSignal: null,
    brokerPid: null,
    overflow: false,
    totalMs: Date.now() - startedAt,
    firstOutputAtMs: null,
    fallbackStop: "broker-spawn-error",
  });
  if (result.error && error) result.error.cause = error;
  return result;
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

  const created = native.createInvocation(invocationOptions(opts, opts.input === undefined ? "open" : "bytes"));
  const invocation = created.invocation;

  let abortListener = null;
  try {
    // Armed BEFORE the broker exists: every deadline from here on is enforced by
    // the native control thread, never by a JavaScript timer.
    native.arm(invocation);

    let broker = null;
    try {
      broker = native.startBroker(invocation, brokerOptions(opts, created.pipeName));
    } catch (error) {
      // The control thread has already been unwound natively; settle the record
      // rather than leaving an armed invocation behind.
      return brokerStartFailure(native, invocation, opts, startedAt, error);
    }

    if (opts.signal) {
      if (opts.signal.aborted) native.cancel(invocation, 1);
      abortListener = () => native.cancel(invocation, 1);
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }
    if (opts.onStarted) {
      opts.onStarted({
        brokerPid: broker.pid,
        pipeName: created.pipeName,
        snapshot: () => native.snapshot(invocation),
        cancel: () => native.cancel(invocation, 1),
      });
    }

    // Off the event loop, on a libuv thread; the deadline being honoured is still
    // the native control thread's. The budget is the same slack backstop the sync
    // path uses and is never the mechanism that bounds execution.
    await native.waitAsync(invocation, backstopMs(opts));
    const record = native.finish(invocation, opts.cleanupBudgetMs + 1_000);
    const io = native.output(invocation, opts.drainBudgetMs + 1_000);

    return buildResult({
      record,
      stdout: io.stdout,
      stderr: io.stderr,
      stdoutTruncated: io.stdoutTruncated,
      stderrTruncated: io.stderrTruncated,
      brokerExit: record?.brokerExitObserved ? record.brokerExitCode : null,
      brokerSignal: null,
      brokerPid: broker.pid,
      overflow: io.stdoutTruncated || io.stderrTruncated,
      totalMs: Date.now() - startedAt,
      // The inert ordering oracle, now measured natively at the first byte that
      // crossed the broker's stdout/stderr rather than at a JS "data" event.
      firstOutputAtMs: io.firstOutputAtMs,
      fallbackStop: null,
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

  const created = native.createInvocation(invocationOptions(opts, "bytes"));
  const invocation = created.invocation;

  try {
    native.arm(invocation);

    let broker = null;
    try {
      broker = native.startBroker(invocation, brokerOptions(opts, created.pipeName));
    } catch (error) {
      return brokerStartFailure(native, invocation, opts, startedAt, error);
    }

    if (opts.onStarted) {
      // Sync callers are blocked from here until the invocation settles, so this
      // hook can still only record intent — but the broker PID it records is now
      // the real one, because the addon created the process rather than waiting
      // for a spawnSync result that arrives only after completion.
      opts.onStarted({ brokerPid: broker.pid, pipeName: created.pipeName, snapshot: null, cancel: null });
    }

    // No JS timer participates in this call, and nothing here waits on the event
    // loop: finish() blocks on the native control thread's own completion event.
    // The budget is deliberately slack — it exists only in case that thread
    // itself fails, and it is never the mechanism that bounds execution.
    const record = native.finish(invocation, backstopMs(opts));
    const io = native.output(invocation, opts.drainBudgetMs + 1_000);

    return buildResult({
      record,
      stdout: io.stdout,
      stderr: io.stderr,
      stdoutTruncated: io.stdoutTruncated,
      stderrTruncated: io.stderrTruncated,
      brokerExit: record?.brokerExitObserved ? record.brokerExitCode : null,
      brokerSignal: null,
      brokerPid: broker.pid,
      overflow: io.stdoutTruncated || io.stderrTruncated,
      totalMs: Date.now() - startedAt,
      // Both paths now share one capture, so the ordering oracle is measured here
      // too instead of being unavailable on the synchronous path.
      firstOutputAtMs: io.firstOutputAtMs,
      fallbackStop: null,
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
  bootstrapEnvPairs,
  brokerOptions,
  invocationOptions,
  backstopMs,
  payloadFrame,
  validate,
  ROOT_EXIT_UNAVAILABLE,
});
