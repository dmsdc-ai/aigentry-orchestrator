// dispatch.sh's implementation, ported to TypeScript (#899 tranche 1).
//
// This is a PORT, not a redesign (Rule 29 + Constitution Art. 1): every flag,
// exit code, stdout/stderr line and subprocess argv is the shell script's,
// preserved deliberately. bin/dispatch.sh is now a 4-line exec shim onto this
// file, so the PATH entrypoint, bin/init/manifest.mjs and every caller are
// unchanged. The behavioural documentation lives in ./usage.ts (what --help
// prints) and in the shell script's git history.
//
// Subprocesses stay subprocesses with identical argv — open-session.sh,
// boot-prepare.mjs, dispatch-registry.py, dispatch-verify.sh, session-probe.py,
// orchestrator-report-target.sh, emit-telemetry.mjs, telepty. Only the inline
// `python3 -c` computations (hashing, clock, JSON shaping) became TS: they were
// the shell-dialect fragility this tranche exists to remove, not a component.
import { spawn, spawnSync } from "node:child_process";
import crossSpawn from "cross-spawn";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { registryAvailable, registryEnvironment, registryInvocation } from "./registry-command.js";
export { registryInvocation } from "./registry-command.js";
import { parseInjectId } from "./inject-id.js";
export { parseInjectId } from "./inject-id.js";
import { mintRequest, renderRefTrailer, type ReportRequest } from "../report/envelope.js";

import { USAGE } from "./usage.js";
import { geminiBinary } from "../session/boot-adapter/gemini.js";
import { isCliKind, type LaunchConfig } from "../session/boot-adapter/types.js";
import { normalizeLaunch } from "../session/boot-adapter/launch-config.js";
import { loadWorkerScope, prepareWorkerSandbox, assertConfinedTarget, stageWorkerRef, assertNotCliWrapper, CONFINED_CLIS,
  readSandboxCurrent, readSealedManifest } from "../session/worker-sandbox.js";
import { CLAUDE_OAUTH_OPT_IN } from "../session/claude-worker-oauth.js";
import { validateSpawnDecision, type SpawnDecision } from "../session/model-decision.js";
import { bootCapabilitiesDocument } from "../orchestrator-boot/plan.js";
import { findTaskRows, TASK_QUEUE, taskQueueStatus } from "./task-queue-read.js";

// ── environment seams (identical names/defaults to the shell) ────────────────
// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` — the repo's
// bin/. The shim exports it so a symlinked entrypoint resolves exactly as bash
// did; the fallback keeps a direct `node dist/src/dispatch/cli.js` working.
const SCRIPT_DIR =
  process.env.DISPATCH_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");

const env = process.env;
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY || path.join(SCRIPT_DIR, "dispatch-registry.py");
const VERIFY_SH = path.join(SCRIPT_DIR, "dispatch-verify.sh");
const OPEN_SESSION_SH = env.OPEN_SESSION_SH || path.join(SCRIPT_DIR, "open-session.sh");
const SESSION_PROBE_PY = env.SESSION_PROBE_PY || path.join(SCRIPT_DIR, "session-probe.py");
const TELEPTY = env.TELEPTY || "telepty";
const EMIT_TELEMETRY_MJS = env.EMIT_TELEMETRY_MJS || path.join(SCRIPT_DIR, "emit-telemetry.mjs");
const REPORT_TARGET_SH = env.REPORT_TARGET_SH || path.join(SCRIPT_DIR, "orchestrator-report-target.sh");
const WH_CLI = path.join(SCRIPT_DIR, "wh-cli.sh");

const REGISTER_TIMEOUT_MS_DEFAULT = 180000;
const READINESS_CAPTURE_MAX_MS = 90_000;

// ── small process helpers ───────────────────────────────────────────────────
function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * stdout+status, stderr swallowed — the shell's `$(cmd 2>/dev/null || true)`.
 * #1293: `spawnError` is the errno code of any child error — a command that could not be STARTED
 * (a missing telepty is ENOENT) but also a timeout or an output overflow (ENOBUFS) of one that did
 * start — which a status of 127 cannot distinguish. `signal` is set when the child was killed by
 * one, which a status of 1 would otherwise hide (review F5). Purely additive: every existing caller
 * reads `status`/`stdout` and is unchanged.
 */
function capture(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv, timeoutMs?: number): { status: number; stdout: string; spawnError?: string; signal?: string } {
  const r = (process.platform === "win32" ? crossSpawn.sync : spawnSync)(cmd, args, {
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  if (r.error) return { status: 127, stdout: "", spawnError: (r.error as NodeJS.ErrnoException).code ?? "spawn error" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", ...(r.status === null && r.signal ? { signal: r.signal } : {}) };
}

/** stdout captured, stderr inherited — the shell's plain `out=$(cmd)`. */
function captureOut(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): { status: number; stdout: string } {
  const r = (process.platform === "win32" ? crossSpawn.sync : spawnSync)(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...env, ...extraEnv } });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** stdout+stderr both captured — the shell's `out=$(cmd 2>&1)`. */
function captureBoth(cmd: string, args: string[], childEnv?: NodeJS.ProcessEnv): { status: number; output: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...(childEnv ? { env: childEnv } : {}) });
  if (r.error) return { status: 127, output: String(r.error.message ?? "") };
  return { status: r.status ?? 1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Fully inherited stdio — the shell's bare `cmd`. */
function run(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): number {
  const r = (process.platform === "win32" ? crossSpawn.sync : spawnSync)(cmd, args, {
    stdio: "inherit",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (r.error) return 127;
  return r.status ?? 1;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(msg: string, code: number): never {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function nowMs(): number {
  return Date.now();
}

/** §9 독립: telemetry failure must NEVER block dispatch. */
function emitTelemetry(args: string[]): void {
  if (!isExecutable(EMIT_TELEMETRY_MJS)) return;
  try {
    (process.platform === "win32" ? crossSpawn.sync : spawnSync)(EMIT_TELEMETRY_MJS, args, { stdio: "ignore" });
  } catch {
    /* swallowed, exactly as `|| true` did */
  }
}

/**
 * bash `printf '%q'`. A word made only of shell-safe characters is emitted
 * BARE, exactly as bash does — the generated launcher is string-matched, not
 * just executed (T47 asserts the literal `exec -a codex `), so wrapping every
 * value in quotes is not a free equivalence. Anything else is single-quoted,
 * which re-parses to the same string as bash's backslash form.
 */
function shellQuote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/** `tr -c 'A-Za-z0-9_.-' '_'` */
function safeSessionComponent(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** #1170 N1: temp refs may hold a report challenge — unlinked on every process.exit path (die included). */
const tempFiles = new Set<string>();
let tempExitHook = false;

/**
 * A fresh private temp file holding `data`: O_CREAT|O_EXCL 0600 ("wx"), so an existing
 * file or a planted symlink at the name is refused, never followed; written through the fd.
 */
function mkTemp(prefix: string, data: string | Uint8Array): string {
  const dir = env.TMPDIR || "/tmp";
  const file = path.join(dir, `${prefix}.${randomBytes(16).toString("hex")}`);
  if (!tempExitHook) {
    tempExitHook = true;
    process.on("exit", () => { for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* already gone */ } } });
  }
  const fd = fs.openSync(file, "wx", 0o600);
  tempFiles.add(file);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

function rmTemp(file: string): void {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  tempFiles.delete(file);
}

// ── spawn-path helpers ──────────────────────────────────────────────────────
function installWorkerGitGuard(): string | null {
  const srcDir = env.AIGENTRY_GIT_HOOK_SOURCE_DIR || path.join(SCRIPT_DIR, "..", "git-hooks");
  const src = path.join(srcDir, "pre-push");
  const hooksDir = env.AIGENTRY_GIT_HOOKS_DIR || path.join(os.homedir(), ".aigentry", "git-hooks");
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    process.stderr.write(`dispatch.sh: worker git guard missing: ${src}\n`);
    return null;
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  const tmp = path.join(hooksDir, `pre-push.${process.pid}`);
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, path.join(hooksDir, "pre-push"));
  return hooksDir;
}

function writeWorkerLauncher(
  sid: string,
  displayCli: string,
  realCli: string,
  realFlags: string,
  hooksDir: string,
  spawnEnv: NodeJS.ProcessEnv,
): string {
  const sessionsRoot = env.AIGENTRY_SESSIONS_ROOT || path.join(os.homedir(), ".aigentry", "sessions");
  const launcherDir = path.join(sessionsRoot, safeSessionComponent(sid), "guard");
  const launcher = path.join(launcherDir, "worker-launcher.sh");
  fs.mkdirSync(launcherDir, { recursive: true });
  const lines = [
    "#!/usr/bin/env bash",
    "# Generated by dispatch.sh for worker-session push protection.",
    "set -euo pipefail",
    "export AIGENTRY_WORKER_SESSION=1",
    ...Object.entries(spawnEnv).map(([key, value]) => `export ${key}=${shellQuote(value!)}`),
    `export AIGENTRY_GIT_HOOKS_DIR=${shellQuote(hooksDir)}`,
    '_aigentry_git_config_count="${GIT_CONFIG_COUNT:-0}"',
    'case "$_aigentry_git_config_count" in',
    '  (*[!0-9]*|"") _aigentry_git_config_i=0 ;;',
    '  (*) _aigentry_git_config_i="$_aigentry_git_config_count" ;;',
    "esac",
    'export GIT_CONFIG_COUNT="$((_aigentry_git_config_i + 1))"',
    'export "GIT_CONFIG_KEY_${_aigentry_git_config_i}=core.hooksPath"',
    'export "GIT_CONFIG_VALUE_${_aigentry_git_config_i}=${AIGENTRY_GIT_HOOKS_DIR}"',
    realFlags
      ? `exec -a ${shellQuote(displayCli)} ${shellQuote(realCli)} ${realFlags} "$@"`
      : `exec -a ${shellQuote(displayCli)} ${shellQuote(realCli)} "$@"`,
  ];
  const tmp = `${launcher}.${process.pid}`;
  fs.writeFileSync(tmp, lines.join("\n") + "\n");
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, launcher);
  return launcher;
}

// ── readiness / registration ────────────────────────────────────────────────
/**
 * Look up the wrapped CLI ("claude"/"codex"/"gemini") for a sid; `kind` is "" if absent.
 *
 * #1293: it also reports the listing's child error code, if any (`capture`), so the caller can tell a
 * telepty COMMAND that could not be started from a session that is not listed. Both answers
 * used to be the same empty string, so a host with no telepty at all waited out the whole
 * registration budget and then blamed the timeout knob — see waitForRegistration.
 */
function cliOf(sid: string): { kind: string; spawnError: string | null } {
  const { stdout, spawnError } = capture(TELEPTY, ["list", "--json"]);
  const absent = { kind: "", spawnError: spawnError ?? null };
  try {
    const list = JSON.parse(stdout);
    if (!Array.isArray(list)) return absent;
    for (const s of list) {
      // #1084: a worker's command is its guard launcher; resolve the CLI kind so the
      // readiness probe and the codex ready-timeout see "codex", not a path. Unknown
      // commands still return raw (registration must stay truthy for them).
      if (s && s.id === sid) { const cmd = String(s.command || ""); return { kind: cliKindOf(cmd) || cmd, spawnError: null }; }
    }
  } catch {
    /* the python arm swallowed every parse error too */
  }
  return absent;
}

/**
 * Returns true if the wrapped CLI's REPL is past the welcome/boot screen.
 * The probe semantics live in session-probe.py and are deliberately untouched
 * (their false-negatives are known and documented) — this only reads its verdict.
 */
function isReady(sid: string, cliKind: string, timeoutMs = READINESS_CAPTURE_MAX_MS): boolean {
  const { stdout } = capture(SESSION_PROBE_PY, ["--sid", sid, "--cli", cliKind], { TELEPTY }, timeoutMs);
  if (!stdout) return false;
  try {
    return JSON.parse(stdout).ready === true;
  } catch {
    return false;
  }
}

/**
 * #1270: the fields session-probe.py ALREADY emits, for the one call site that has to
 * tell "busy and otherwise healthy" apart from modal/unsubmitted/unknown/probe-failed.
 * isReady() above stays the public boolean and `__probe is-ready` keeps answering
 * through its exit code only — the probe itself is untouched, and so is its verdict:
 * `ready` stays false for a qualified current-busy session. null = no usable verdict.
 */
interface ProbeState {
  alive: boolean;
  ready: boolean;
  surface: string;
  readyReason: string;
  /** r4 B1: `detail.tracker_class`, already emitted — the independent live-work signal. */
  trackerClass: string;
  probeError: boolean;
}

function probeState(sid: string, cliKind: string, timeoutMs = READINESS_CAPTURE_MAX_MS): ProbeState | null {
  const { stdout } = capture(SESSION_PROBE_PY, ["--sid", sid, "--cli", cliKind], { TELEPTY }, timeoutMs);
  if (!stdout) return null;
  try {
    const p = JSON.parse(stdout) as { alive?: unknown; ready?: unknown; surface?: unknown; detail?: unknown };
    const detail: Record<string, unknown> = p.detail !== null && typeof p.detail === "object" ? p.detail as Record<string, unknown> : {};
    return {
      alive: p.alive === true,
      ready: p.ready === true,
      surface: typeof p.surface === "string" ? p.surface : "",
      readyReason: typeof detail.ready_reason === "string" ? detail.ready_reason : "",
      trackerClass: typeof detail.tracker_class === "string" ? detail.tracker_class : "",
      probeError: detail.probe_error !== undefined,
    };
  } catch {
    return null;
  }
}

// ── #1162 agent metadata (never gates the spawn) ────────────────────────────
const PROBE_SURFACES = new Set(["working", "idle", "welcome", "unsubmitted", "modal", "sandbox_prompt", "error",
  "crash", "sleep_cut", "raw_shell", "thinking_block", "unknown"]);

/**
 * The status half of the sealed worker's metadata, each field from its own
 * evidence at read time: connection = verbatim telepty healthStatus; activity =
 * one session-probe surface, only from a current-viewport read without
 * probe_error; dispatch = registry live rows for this sid. Anything unmeasured
 * is unknown. CONNECTED is never activity, and dispatch is never completion.
 */
function agentStatus(sid: string, cliKind: string): Record<string, string | number> {
  let connection = "unknown";
  try {
    const list = JSON.parse(capture(TELEPTY, ["list", "--json"]).stdout);
    const rows = Array.isArray(list) ? list.filter(s => s && s.id === sid) : [];
    const health = rows.length === 1 ? rows[0].healthStatus : undefined;
    connection = health === "CONNECTED" ? "connected" : health === "DISCONNECTED" ? "disconnected" : "unknown";
  } catch { /* unreadable listing: unknown */ }
  let activity = "unknown", activitySource = "unknown";
  try {
    const p = JSON.parse(capture(SESSION_PROBE_PY, ["--sid", sid, "--cli", cliKind], { TELEPTY }, READINESS_CAPTURE_MAX_MS).stdout);
    const detail = p && typeof p.detail === "object" && p.detail !== null ? p.detail : {};
    if (detail.probe_error === undefined && typeof detail.screen_source === "string" &&
        detail.screen_source.endsWith(":current-viewport") && PROBE_SURFACES.has(p.surface)) {
      activity = p.surface;
      activitySource = "probe:current-viewport";
    }
  } catch { /* no probe verdict: unknown */ }
  let dispatch = "unknown";
  const live = registryOut(["list", "--live", "--fields", "assigned.sid,lifecycle.state"]);
  if (live.status === 0) {
    const states = live.stdout.split("\n").map(l => l.split("\t")).filter(f => f[0] === sid).map(f => f[1] ?? "");
    dispatch = states.length === 0 ? "none" : states.length > 1 ? "multiple"
      : states[0] !== "null" && /^[a-z_]{1,40}$/.test(states[0]!) ? states[0]! : "unknown";
  }
  return { connection, activity, activity_source: activitySource, dispatch, read_at: Math.floor(Date.now() / 1000) };
}

/** One best-effort agent-meta-set through the terminal adapter; the rc is logged, never mapped to success. */
function publishAgentMeta(sid: string, cliKind: string, stagingRoot: string): void {
  let rc: string;
  try {
    const status = JSON.stringify(agentStatus(sid, cliKind));
    const r = spawnSync(WH_CLI, ["agent-meta-set", sid, "--stage", stagingRoot, "--status-json", status],
      { stdio: ["ignore", "ignore", "inherit"], timeout: 15000 });
    rc = r.error ? "spawn-error" : String(r.status ?? r.signal);
  } catch {
    rc = "error";
  }
  if (rc !== "0") process.stderr.write(`dispatch.sh: WARNING agent-meta-set rc=${rc} for ${sid} (spawn not gated)\n`);
}

// ── registry seam (telepty#60 Stage A) ──────────────────────────────────────
// The registry component is the single typed writer of the dispatch registry.
// Its failure is the dispatch's failure.
function registryMissing(): boolean {
  if (registryAvailable(DISPATCH_REGISTRY_PY)) return false;
  process.stderr.write(
    `dispatch.sh: DISPATCH_NOT_RECORDED — registry component missing at ${DISPATCH_REGISTRY_PY}\n`,
  );
  return true;
}

/** `registry "$@"` with stdout+stderr captured (the check-dedup call site). */
function registryBoth(args: string[]): { status: number; output: string } {
  if (registryMissing()) return { status: 9, output: "" };
  const invocation = registryInvocation(DISPATCH_REGISTRY_PY, args, process.platform);
  return captureBoth(invocation.cmd, invocation.args, registryEnvironment());
}

/** `registry "$@"` with stdout captured, stderr passed through. */
function registryOut(args: string[]): { status: number; stdout: string } {
  if (registryMissing()) return { status: 9, stdout: "" };
  const invocation = registryInvocation(DISPATCH_REGISTRY_PY, args, process.platform);
  const r = spawnSync(invocation.cmd, invocation.args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: false, env: registryEnvironment(),
  });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** `registry "$@" >/dev/null` — status only. */
function registryQuiet(args: string[]): number {
  if (registryMissing()) return 9;
  const invocation = registryInvocation(DISPATCH_REGISTRY_PY, args, process.platform);
  const r = spawnSync(invocation.cmd, invocation.args, { stdio: ["ignore", "ignore", "inherit"], shell: false, env: registryEnvironment() });
  if (r.error) return 127;
  return r.status ?? 1;
}

// ── verify_delivered screen analysis (#835) ─────────────────────────────────
/**
 * Pure half of verify_delivered: given the post-inject screen and the ref's
 * first line, did the inject visibly land?
 */
export function screenShowsDelivery(post: string, firstLine: string): boolean {
  const lines = post.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  const tail = lines.length ? lines.slice(-10).join("\n") : "";
  const placeholder = /[❯›]\s+Try "[^"]+"/.test(tail);
  const echoed = firstLine.length > 0 && post.includes(firstLine.slice(0, 60));
  return !(placeholder && !echoed);
}

// ── CLI state ───────────────────────────────────────────────────────────────
// #1206: bin/model-router.mjs's TOKEN — a `--class` value and a profile effort token.
const ROUTE_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const validEffort = (c: object): boolean => !Object.hasOwn(c, "effort") ||
  (typeof (c as { effort?: unknown }).effort === "string" && ROUTE_TOKEN.test((c as { effort: string }).effort));

interface RouteCandidate { cli: string; model: string; label: string; effort?: string }

interface Opts {
  target: string;
  refFile: string;
  fromId: string;
  timeoutMs: number;
  timeoutExplicit: boolean;
  spawn: boolean;
  track: string;
  name: string;
  cwd: string;
  cli: string;
  route?: { label: string; model: string; decided_by: string; reason: string; candidates?: RouteCandidate[]; capped_cli?: string; effort?: string };
  worktree: string;
  verifyDelivered: boolean;
  verifyStarted: boolean;
  role: string;
  /** #1206: the role's task class (router `--class`); "" = the role row. */
  taskClass: string;
  keepAlive: boolean;
  taskId: string;
  noTask: boolean;
  noTaskReason: string;
  /** #1092: operator reason for retrying a delivery_state_unknown row; "" = no override. */
  retryUnknown: string;
  /** #1148: per-call operator observation files (negative launch outcomes), read by the resolver only. */
  observe: string[];
  /** #1148: the validated decision of a fresh confined claude/codex spawn. */
  decision?: SpawnDecision;
  /** #1172: optional declared-input snapshot triple; all three or none. */
  inputRoot: string;
  inputManifest: string;
  inputSha256: string;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    target: "",
    refFile: "",
    fromId: "",
    timeoutMs: 30000,
    timeoutExplicit: false,
    spawn: false,
    track: "",
    name: "",
    cwd: "",
    cli: "auto",
    worktree: "",
    verifyDelivered: false,
    // Rule 33: confirm session actually started working post-inject.
    verifyStarted: true,
    role: "",
    taskClass: "",
    keepAlive: false,
    taskId: "",
    noTask: false,
    noTaskReason: "",
    retryUnknown: "",
    observe: [],
    inputRoot: "",
    inputManifest: "",
    inputSha256: "",
  };
  let i = 0;
  // `shift 2` on a value flag reads $2 even when absent; bash's `set -u` makes
  // that an error, so a trailing value-flag is a usage error either way.
  const val = (flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) {
      process.stderr.write(`dispatch.sh: ${flag}: option requires an argument\n`);
      process.stderr.write(USAGE + "\n");
      process.exit(4);
    }
    return v;
  };
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case "--target": o.target = val(a); i += 2; break;
      case "--ref": o.refFile = val(a); i += 2; break;
      case "--from": o.fromId = val(a); i += 2; break;
      case "--timeout-ms": o.timeoutMs = Number(val(a)); o.timeoutExplicit = true; i += 2; break;
      case "--spawn-and-dispatch": o.spawn = true; i += 1; break;
      case "--track": o.track = val(a); i += 2; break;
      case "--name": o.name = val(a); i += 2; break;
      case "--cwd": o.cwd = val(a); i += 2; break;
      case "--worktree": o.worktree = val(a); i += 2; break;
      case "--cli": o.cli = val(a); i += 2; break;
      case "--role": o.role = val(a); i += 2; break;
      case "--task-class":
        o.taskClass = val(a); i += 2;
        if (!ROUTE_TOKEN.test(o.taskClass)) {
          process.stderr.write("dispatch.sh: --task-class: invalid class (want ^[a-z][a-z0-9-]{0,31}$)\n");
          process.exit(4);
        }
        break;
      case "--task": o.taskId = val(a); i += 2; break;
      case "--no-task": o.noTask = true; o.noTaskReason = val(a); i += 2; break;
      case "--verify-delivered": o.verifyDelivered = true; i += 1; break;
      case "--no-verify-started": o.verifyStarted = false; i += 1; break;
      case "--keep-alive": o.keepAlive = true; i += 1; break;
      case "--input-root": o.inputRoot = val(a); i += 2; break;
      case "--input-manifest": o.inputManifest = val(a); i += 2; break;
      case "--input-sha256": o.inputSha256 = val(a); i += 2; break;
      case "--observe":
        if (o.observe.length >= 4) {
          process.stderr.write("dispatch.sh: --observe may be given at most 4 times\n");
          process.exit(4);
        }
        o.observe.push(val(a)); i += 2;
        break;
      case "--retry-unknown":
        o.retryUnknown = val(a); i += 2;
        if (!o.retryUnknown.trim()) {
          process.stderr.write("dispatch.sh: --retry-unknown needs a non-empty reason\n");
          process.exit(4);
        }
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE + "\n");
        process.exit(0);
        break;
      default:
        process.stderr.write(`dispatch.sh: unknown arg: ${a}\n`);
        process.stderr.write(USAGE + "\n");
        process.exit(4);
    }
  }
  return o;
}

function resolveRoute(o: Opts, sid: string, skipPreparation: boolean): void {
  if (!o.spawn || skipPreparation) {
    o.cli = cliOf(sid).kind || "unknown";
    o.route = { label: "unknown", model: "unknown", decided_by: "existing",
      reason: "existing worker; command observed via telepty, model not reported" };
    return;
  }
  if (o.cli !== "auto") {
    const defaults: Record<string, string> = { claude: "claude-opus-5", codex: "gpt-6-astra", grok: "grok-4.6",
      gemini: geminiBinary() === "agy" ? "gemini-3.8-flash-high" : "gemini-2.5-flash" };
    const model = env[`AIGENTRY_${o.cli.toUpperCase()}_MODEL`] || defaults[o.cli] || "unknown";
    o.route = { label: model, model, decided_by: "explicit", reason: "explicit --cli override" };
    return;
  }
  // #1206 D7: no `--ref`, so the router never calls its classifier; the role (× task class) table decides.
  try {
    const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, "model-router.mjs"),
      "--role", o.role, ...(o.taskClass ? ["--class", o.taskClass] : []), "--candidates", "1", "--confined", "1"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 16000, killSignal: "SIGKILL",
    });
    if (result.error || result.status !== 0) throw new Error("router unavailable");
    const route = JSON.parse(result.stdout);
    if (!["claude", "codex", "grok", "gemini"].includes(route.cli) ||
      !["llm", "table"].includes(route.decided_by) || typeof route.model !== "string" ||
      typeof route.label !== "string" || typeof route.reason !== "string" ||
      !Array.isArray(route.candidates) || !validEffort(route) ||
      !route.candidates.every((c: unknown) => typeof c === "object" && c !== null && validEffort(c))) throw new Error("invalid router result");
    o.cli = route.cli;
    o.route = route;
  } catch {
    process.stderr.write("dispatch.sh: model router unavailable; using emergency table default\n");
    o.cli = EMERGENCY_ROUTE.cli;
    o.route = { label: EMERGENCY_ROUTE.label, model: EMERGENCY_ROUTE.model, decided_by: "table", reason: "router unavailable" };
  }
}

// ── #1084 per-CLI live cap ──────────────────────────────────────────────────
// Three Astra workers at xhigh drained the codex 5-hour window in ~10 min
// (2026-09-05). Live = what telepty lists right now: a worker's `command` is its
// guard launcher, whose `exec -a <cli>` line is the kind writeWorkerLauncher
// wrote; the orchestrator's own row is the bare CLI. The dispatch registry has
// no cli field, so it cannot serve here. Fail-open: an unreadable list caps
// nothing (§9 — a counter must never block dispatch).
// Keep in sync with emergency in bin/model-router.mjs.
const EMERGENCY_ROUTE: RouteCandidate = { cli: "claude", label: "opus-5", model: "claude-opus-5[1m]" };

function cliKindOf(command: string): string {
  const base = path.basename(command);
  if (["claude", "codex", "grok", "gemini"].includes(base)) return base;
  if (base === "agy") return "gemini";
  try { return /^exec -a (\S+)/m.exec(fs.readFileSync(command, "utf8"))?.[1] || ""; } catch { return ""; }
}

function liveCliCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    for (const s of JSON.parse(capture(TELEPTY, ["list", "--json"]).stdout)) {
      const kind = cliKindOf(String((s && s.command) || ""));
      if (kind) counts[kind] = (counts[kind] || 0) + 1;
    }
  } catch { /* fail-open */ }
  return counts;
}

/**
 * AIGENTRY_CLI_CAP_<CLI>: an opt-in count quota, and the ONLY source of one (#1148).
 *
 * Absent or empty (whitespace-only included) means no implicit ceiling, for every
 * CLI — the built-in `codex 2 / claude 4` table is gone. A host that never set the
 * knob used to hit a manufactured claude cap of 4 and get auto-routed to another
 * provider on the 5th live session; it no longer does.
 *
 * `unlimited` (case-insensitive) is the explicit literal that lifts a cap an
 * inherited environment still sets, without having to unset the variable.
 *
 * A finite number keeps its old meaning exactly, 0 (= never auto-route there)
 * included. Anything else is malformed and yields no ceiling, warned once per
 * knob rather than silently manufacturing a count (§9 — a counter must never
 * block dispatch, and a typo must never become a cap). The warning names the
 * knob but never echoes its value: an env value is untrusted bytes, and this
 * stream is an operator terminal and a log, so terminal escapes and anything
 * sensitive that was mis-set into the variable must not be replayed there.
 */
const CAP_UNLIMITED = "unlimited";
const warnedCapKnobs = new Set<string>();

function cliCap(cli: string): number {
  const knobName = `AIGENTRY_CLI_CAP_${cli.toUpperCase()}`;
  const raw = (env[knobName] || "").trim();
  if (!raw || raw.toLowerCase() === CAP_UNLIMITED) return Infinity;
  const knob = Number(raw);
  if (Number.isFinite(knob)) return knob;
  if (!warnedCapKnobs.has(knobName)) {
    warnedCapKnobs.add(knobName);
    process.stderr.write(`dispatch.sh: WARNING ${knobName} is set to an invalid value (not a count, not '${CAP_UNLIMITED}'); ignored, no cap applied\n`);
  }
  return Infinity;
}

// #1206 (PLAN §2.3): stat only, nothing is read or run. An executable the resolver would bind by name
// (`<cli>` in an absolute PATH dir); a declared AIGENTRY_<CLI>_EXECUTABLE is an explicit request the
// resolver judges itself, never substituted. A credential source seedAuth can copy: codex auth.json;
// claude's opted-in token handoff, its credentials file, or on darwin the login Keychain (not statable).
function executablePresent(cli: string): boolean {
  if (env[`AIGENTRY_${cli.toUpperCase()}_EXECUTABLE`]) return true;
  return (env.PATH || "").split(path.delimiter).some((dir) => path.isAbsolute(dir) && isExecutable(path.join(dir, cli)));
}

function credentialPresent(cli: string): boolean {
  const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (cli === "codex") return isFile(path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json"));
  return !!env[CLAUDE_OAUTH_OPT_IN] || process.platform === "darwin" || isFile(path.join(os.homedir(), ".claude", ".credentials.json"));
}

/**
 * Fresh spawn only: a routed CLI that is not routable (at cap, no executable, no credential) falls to the
 * first routable router candidate, in order; none left refuses (exit 78) — never an unconfined fallback.
 * An explicit --cli warns at cap and proceeds.
 */
function applyCliCap(o: Opts): void {
  if (!o.route || o.route.decided_by === "existing") return;
  const live = liveCliCounts();
  const atCap = (cli: string): boolean => (live[cli] || 0) >= cliCap(cli);
  const capStatus = (cli: string): string =>
    `${cli} at cap (${live[cli] || 0} live, AIGENTRY_CLI_CAP_${cli.toUpperCase()}=${cliCap(cli)})`;
  if (o.route.decided_by === "explicit") {
    if (atCap(o.cli)) process.stderr.write(`dispatch.sh: WARNING ${capStatus(o.cli)}; explicit --cli ${o.cli} spawns anyway\n`);
    return;
  }
  const unroutable = (cli: string): string | undefined =>
    !(CONFINED_CLIS as readonly string[]).includes(cli) ? `${cli} is not a confined CLI`
      : atCap(cli) ? capStatus(cli)
        : !executablePresent(cli) ? `${cli} has no executable on PATH`
          : !credentialPresent(cli) ? `${cli} has no credential file` : undefined;
  const status = unroutable(o.cli);
  if (!status) return;
  const pick = (o.route.candidates || []).find((c) => !unroutable(c.cli));
  if (!pick) {
    die(`dispatch.sh: ROUTE_CANDIDATES_EXHAUSTED: ${status}; no routable confined candidate after ` +
      `${printable(o.route.label)} (HOLD; no unconfined fallback); nothing was spawned`, 78);
  }
  process.stderr.write(`dispatch.sh: ${status}; ${o.route.label} -> ${pick.label} (${pick.cli})\n`);
  o.route = { label: pick.label, model: pick.model, decided_by: `${o.route.decided_by}-capped`,
    reason: `${status}; router chose ${o.route.label}: ${o.route.reason}`, capped_cli: o.cli,
    ...(pick.effort !== undefined ? { effort: pick.effort } : {}) };
  o.cli = pick.cli;
}

// ── #1148 managed spawn decision ────────────────────────────────────────────
// Every fresh confined claude/codex spawn — explicit --cli included — gets ONE
// task/sid-bound decision from the package's own resolver (never a copied control
// workspace), AFTER the cap fallback so a capped CLI re-resolves its whole tuple.
// The resolver makes no classifier/model call; the explicit path passes no route.
// Existing-target, dedup and retry paths never reach here. Any resolver failure
// (crash, timeout, invalid JSON, identity mismatch) refuses before any spawn effect.
const MODEL_ROUTER = fileURLToPath(new URL("../../../bin/model-router.mjs", import.meta.url));
const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, 600);

function resolveSpawnDecision(o: Opts, sid: string): void {
  if (!(CONFINED_CLIS as readonly string[]).includes(o.cli) || !o.role || !o.taskId || !o.route) return;
  const args = [MODEL_ROUTER, "--resolve", "--cli", o.cli, "--sid", sid, "--task", o.taskId, "--role", o.role];
  if (o.route.decided_by !== "explicit") {
    args.push("--route-json", JSON.stringify({ model: o.route.model, decided_by: o.route.decided_by,
      ...(o.route.effort !== undefined ? { effort: o.route.effort } : {}) }));
  }
  for (const file of o.observe) args.push("--observe", file);
  const r = spawnSync(process.execPath, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  });
  let out: { decision?: unknown; refusal?: { code?: unknown; reason?: unknown } } = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch { /* reported below */ }
  if (r.error || r.status !== 0) {
    const refused = r.status === 4 || r.status === 10;
    const code = refused && typeof out.refusal?.code === "string" ? out.refusal.code : "MODEL_RESOLVER_FAILED";
    const reason = refused && typeof out.refusal?.reason === "string" ? out.refusal.reason : `resolver exit ${r.status ?? "none"}`;
    die(`dispatch.sh: ${printable(code)}: ${printable(reason)}; nothing was spawned`, r.status === 4 ? 4 : 10);
  }
  try {
    o.decision = validateSpawnDecision(out.decision, { cli: o.cli, sid, task: o.taskId });
  } catch (e) {
    die(`dispatch.sh: MODEL_RESOLVER_FAILED: ${printable(String(e))}; nothing was spawned`, 10);
  }
  // #652: a resolved `#!` wrapper with no version evidence is refused here, before boot-prepare
  // or any staging; prepareWorkerSandbox repeats the check at the seal. Sandbox platforms only:
  // win32 seals nothing and keeps its SANDBOX_PLATFORM_UNSUPPORTED refusal.
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      assertNotCliWrapper(o.decision.executable);
    } catch (e) {
      die(`dispatch.sh: ${printable(e instanceof Error ? e.message : String(e))}; nothing was spawned`, 78);
    }
  }
  // The legacy route fields now name what the argv carries, not a literal default.
  o.route.model = o.decision.model ?? "omitted";
  if (o.route.decided_by === "explicit") o.route.label = o.route.model;
}

// ── #1172 declared worker inputs ────────────────────────────────────────────
// Caller wiring only: the package's own bin/worker-inputs.mjs verifies the
// snapshot before anything else in main() can have an effect. A point-in-time
// check of declared files, not a sandbox permission or a lock.
const WORKER_INPUTS = fileURLToPath(new URL("../../../bin/worker-inputs.mjs", import.meta.url));

function verifyWorkerInputs(o: Opts): void {
  const given = [o.inputRoot, o.inputManifest, o.inputSha256].filter((v) => v !== "").length;
  if (given === 0) return;
  if (given !== 3) die("dispatch.sh: --input-root, --input-manifest and --input-sha256 are all-or-none", 4);
  const r = spawnSync(process.execPath, [WORKER_INPUTS, "verify", "--root", o.inputRoot,
    "--manifest", o.inputManifest, "--sha256", o.inputSha256], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false, timeout: 120000, killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    const detail = (r.stderr || "").split("\n")[0] || `helper exit ${r.status ?? r.signal ?? "none"}`;
    die(`dispatch.sh: WORKER_INPUTS_UNVERIFIED: ${printable(detail)}; nothing was dispatched`, 4);
  }
}

/** requested / selected / observed, kept apart, for telemetry and the task ledger. */
function decisionAudit(d: SpawnDecision): Record<string, unknown> {
  return {
    requested: d.requested,
    selected: { cli: d.cli, model: d.model, effort: d.effort, executable: d.executable },
    observed: d.observed,
    decided_by: d.decided_by, evidence_label: d.evidence_label, rationale: d.rationale,
  };
}

// ── Rule 34 task-gate (#736) ────────────────────────────────────────────────
// Rule 34 requires every delegated work item to be registered in the task queue
// before dispatch. That relied on operator discipline and leaked, so the gate
// lives here — dispatch.sh is the actuation chokepoint every delegation flows
// through. It runs BEFORE any side effect so a violation can never leave a
// half-started worker behind.
const TASK_GATE_MODE = env.AIGENTRY_TASK_GATE || "hard";
const TASK_GATE_HINT =
  'register the task in state/task-queue.json first (--task <id>), or use --no-task "<reason>" for exempt work.';

function utcNow(): Date {
  return new Date();
}

function isoSeconds(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Audit trail for every gate exemption, so the escape hatch stays countable.
 * Best-effort: never fails the dispatch.
 */
function noTaskTelemetry(o: Opts, reason: string): void {
  try {
    const dir = path.join(os.homedir(), ".aigentry", "telemetry");
    fs.mkdirSync(dir, { recursive: true });
    let caller = env.AIGENTRY_DISPATCH_CALLER;
    if (caller === undefined) {
      caller = capture("ps", ["-o", "comm=", "-p", String(process.ppid)]).stdout;
    }
    const line =
      JSON.stringify({
        ts: isoSeconds(utcNow()),
        sid_or_target: o.target || (o.track ? `${o.track}-${o.name}` : ""),
        ref: o.refFile,
        reason,
        caller_env: caller.trim(),
      }) + "\n";
    fs.appendFileSync(path.join(dir, `dispatch-notask-${utcDate(utcNow())}.ndjson`), line);
  } catch {
    /* best-effort, exactly as the `|| true` chain was */
  }
}

/** hard → refuse (exit 4); warn → print + audit, then proceed; off → legacy silence. */
function taskGateReject(o: Opts, msg: string): void {
  if (TASK_GATE_MODE === "off") return;
  if (TASK_GATE_MODE === "warn") {
    process.stderr.write(`dispatch.sh: WARNING (AIGENTRY_TASK_GATE=warn) ${msg}\n`);
    noTaskTelemetry(o, `task-gate-warn: ${msg}`);
    return;
  }
  die(`dispatch.sh: ${msg}`, 4);
}

/**
 * #1110: both find sites word it the same way. `tasks.find(...)` answered with the first
 * match, so `--task 522` read a desc-less `pending` row while the row a human meant sat
 * two rows down, `done` — a gate answering a different question than the one asked.
 *
 * The two sites act on it differently, because they sit on opposite sides of the inject:
 * the GATE refuses (rc 5, in warn and off too — AIGENTRY_TASK_GATE chooses how strict the
 * gate is about a KNOWN row, it cannot choose WHICH of two rows was meant); the LEDGER
 * only warns, because by then the dispatch has already landed.
 */
function ambiguousTaskIdMessage(rows: unknown[], hits: number[], taskId: string): string {
  const where = hits
    .map((i) => `idx ${i} ("${String((rows[i] as { desc?: unknown } | undefined)?.desc ?? "").slice(0, 40)}")`)
    .join(" and ");
  return (
    `Rule 34 task-gate: task id '${taskId}' matches ${hits.length} rows in ${TASK_QUEUE} — ${where}. ` +
    `Ambiguous task id — not a gate mode decision. Rename one row (e.g. '${taskId}b') and dispatch the id you mean.`
  );
}

// Preserve the dispatch gate's exit codes and keep duplicate refusals outside gate mode policy.
function dispatchTaskQueueStatus(taskId: string): { rc: number; status: string } {
  const result = taskQueueStatus(taskId);
  switch (result.kind) {
    case "unreadable":
      return { rc: 2, status: "" };
    case "not-found":
      return { rc: 3, status: "" };
    case "archived":
      return { rc: 4, status: result.status };
    case "unique":
      return { rc: result.dispatchable ? 0 : result.terminal ? 4 : 5, status: result.status };
    case "duplicate":
      return die(`dispatch.sh: ${ambiguousTaskIdMessage(result.rows, result.hits, taskId)}`, 5);
  }
}

function taskGateCheck(o: Opts): void {
  if (o.taskId && o.noTask) {
    die("dispatch.sh: --task and --no-task are mutually exclusive", 4);
  }
  if (o.noTask) {
    // Usage errors are mode-independent: an unexplained exemption is never valid.
    if (!/\S/.test(o.noTaskReason)) {
      die("dispatch.sh: --no-task requires a non-empty reason", 4);
    }
    noTaskTelemetry(o, o.noTaskReason);
    return;
  }
  if (!o.taskId) {
    taskGateReject(o, `Rule 34 task-gate: ${TASK_GATE_HINT}`);
    return;
  }
  const { rc, status } = dispatchTaskQueueStatus(o.taskId);
  switch (rc) {
    case 0:
      return;
    case 2:
      taskGateReject(o, `Rule 34 task-gate: task queue unreadable at ${TASK_QUEUE} — ${TASK_GATE_HINT}`);
      return;
    case 3:
      taskGateReject(o, `Rule 34 task-gate: unknown task id '${o.taskId}' in ${TASK_QUEUE} — ${TASK_GATE_HINT}`);
      return;
    case 4:
      taskGateReject(
        o,
        `Rule 34 task-gate: task ${o.taskId} is already '${status}' — stale-id reuse. Register a NEW task for this work, or use --no-task "<reason>".`,
      );
      return;
    default:
      taskGateReject(
        o,
        `Rule 34 task-gate: task ${o.taskId} status '${status}' is not dispatchable (need pending|queued|in_progress|delegated|blocked-by-observation) — ${TASK_GATE_HINT}`,
      );
  }
}

/**
 * Auto-ledger: a confirmed dispatch writes itself into the task row, so the
 * queue reflects reality without operator discipline. Best-effort — the inject
 * already landed, so a queue-write failure must warn, never fail the dispatch.
 */
function taskLedgerUpdate(o: Opts, sid: string): void {
  if (!o.taskId) return;
  if (!fs.existsSync(TASK_QUEUE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(TASK_QUEUE, "utf8")) as { tasks?: unknown[] };
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const hits = findTaskRows(tasks, o.taskId);
    if (hits.length > 1) {
      // Unreachable while the gate stands (it refuses first, in every mode) — kept because
      // a first-match ledger WRITE is the worse half of #1110. Warns and skips instead of
      // refusing: the inject already landed, so this site must never fail the dispatch.
      const msg = ambiguousTaskIdMessage(tasks, hits, o.taskId);
      process.stderr.write(`dispatch.sh: WARNING ${msg} (ledger write skipped; dispatch already landed)\n`);
      noTaskTelemetry(o, `task-ledger-ambiguous: ${msg}`);
      return;
    }
    const task = (hits.length === 1 ? tasks[hits[0]!] : undefined) as Record<string, unknown> | undefined;
    if (task === undefined) throw new Error("task row vanished");
    const now = utcNow();
    // Only promote from a not-yet-started state; in_progress must never regress.
    if (task.status === "pending" || task.status === "queued") task.status = "delegated";
    task.updated_at = utcDate(now);
    const stamp = ` | dispatched ${isoSeconds(now)} sid=${sid} ref=${path.basename(o.refFile)} track=${o.track || "-"}` +
      ` cli=${o.cli}/${o.route?.model || "unknown"} by=${o.route?.decided_by || "explicit"}` +
      (o.route?.capped_cli ? ` capped_cli=${o.route.capped_cli}` : "");
    const note = (task.note as string) || "";
    task.note = note ? note + stamp : stamp.replace(/^[ |]+/, "");
    // #1148: the fresh spawn's decision, keyed by sid (requested/selected/observed apart).
    if (o.decision) {
      const prior = task.spawn_decisions;
      const bySid = prior && typeof prior === "object" && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
      bySid[sid] = { at: isoSeconds(now), ...decisionAudit(o.decision) };
      task.spawn_decisions = bySid;
    }
    // Atomic: same-dir temp + rename, so a crash can never truncate the live queue.
    const dir = path.dirname(path.resolve(TASK_QUEUE));
    const tmp = path.join(dir, `.task-queue.${process.pid}.${randomBytes(3).toString("hex")}`);
    const fd = fs.openSync(tmp, "w");
    try {
      // The shape the file is COMMITTED in — json.dumps(..., ensure_ascii=False, indent=2)
      // plus the trailing newline — so a dispatch touches only the row it ledgers. This
      // was indent=1 and newline-less while the orchestrator wrote indent=2: every other
      // commit re-serialised all 26k lines and buried the real change (#1110).
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, TASK_QUEUE);
    } catch (e) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      fs.unlinkSync(tmp);
      throw e;
    }
  } catch {
    process.stderr.write(
      `dispatch.sh: WARNING task-gate ledger update failed for task ${o.taskId} (dispatch already landed)\n`,
    );
  }
}

// ── delivery pipeline ───────────────────────────────────────────────────────
interface Delivery {
  refHash: string;
  effRef: string;
  tmpRef: string;
  transportInjectId: string;
  /**
   * The recipient-absolute `[context-ref]` message for a confined worker, set
   * once staging has verified where the bytes actually landed. Empty means the
   * delivery was never staged — see the refusal in main().
   */
  refPrompt: string;
  /** #1170: the envelope minted for this dispatch and the sealed attempt it is bound to. */
  report?: ReportRequest;
  reportBinding?: { attempt: string; hash: string };
}

/**
 * #1170: the sealed attempt a confined ref is staged into, read through the strict
 * sealed reader. null (with a named WARNING) when the target cannot carry an envelope
 * — e.g. a worker spawned before report outboxes existed: the record is then created
 * without a report binding and report-pump surfaces it as legacy_unbound.
 */
function pinReportAttempt(stage: string, sid: string): { attempt: string; hash: string } | null {
  try {
    const real = fs.realpathSync(stage);
    const current = readSandboxCurrent(real);
    const { m, root, stage: owner } = readSealedManifest(current.manifest, current.hash);
    const home = path.join(root, "home");
    if (owner !== real || m.sid !== sid) throw new Error("REPORT_ATTEMPT_IDENTITY");
    if (m.env.HOME !== home || m.env.AIGENTRY_REPORT_OUTBOX !== path.join(home, "report-outbox")) {
      throw new Error("REPORT_OUTBOX_UNSEALED");
    }
    return { attempt: m.attempt, hash: current.hash };
  } catch (e) {
    const why = String((e as Error)?.message ?? e).replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
    process.stderr.write(`dispatch.sh: WARNING REPORT_ENVELOPE_UNAVAILABLE for ${sid} (${why}) — no report envelope ` +
      "is bound; the record stays legacy_unbound and report-pump surfaces it\n");
    return null;
  }
}

/** #1170: the trailer goes into a private temp copy; o.refFile (dedup hash / verify) stays original. */
function appendRefTrailer(d: Delivery, trailer: string): void {
  // A new exclusive temp with base + trailer (never an in-place append by path); the old temp goes.
  const prev = d.tmpRef;
  d.tmpRef = mkTemp("dispatch-ref", Buffer.concat([fs.readFileSync(d.effRef), Buffer.from(trailer)]));
  d.effRef = d.tmpRef;
  if (prev) rmTemp(prev);
}

/**
 * telepty's own wording (shared-context.cjs buildSharedContextPrompt), built
 * here from the recipient-absolute staged path instead of the descriptor,
 * whose default promptPath is tilde-rooted against the HOST home.
 * The private staged file remains the content source; only its address travels.
 */
export function buildContextRefPrompt(stagedPath: string): string {
  return `[context-ref] Read ${stagedPath} and use it as the source of truth for this task.`;
}

function computeRefHash(refFile: string): string {
  return createHash("sha256").update(fs.readFileSync(refFile)).digest("hex");
}

/**
 * #690 (Rule 16): refs carry the {{ORCHESTRATOR_REPORT_TARGET}} placeholder so
 * workers are never handed a phantom/hardcoded orchestrator sid. Resolve the
 * real address into a temp copy — refFile (dedup hash / verify) stays original.
 *
 * Stage A keeps this OUT of doInject: no fallible preparation may run between
 * the durable begin-delivery commit and the transport call.
 */
function prepareEffectiveRef(o: Opts, d: Delivery): boolean {
  d.effRef = o.refFile;
  let body: string;
  try {
    body = fs.readFileSync(o.refFile, "utf8");
  } catch {
    return true; // `grep -q ... || return 0` — an unreadable ref is a passthrough here
  }
  if (!body.includes("{{ORCHESTRATOR_REPORT_TARGET}}")) return true;
  // Fail CLOSED. No fallback default: guessing the target is the bug being removed.
  let targetAddr = "";
  if (isExecutable(REPORT_TARGET_SH)) {
    const r = captureOut(REPORT_TARGET_SH, []);
    if (r.status === 0) targetAddr = r.stdout.replace(/\n+$/, "");
  }
  if (!targetAddr) {
    process.stderr.write(
      `dispatch.sh: could not resolve the orchestrator report target via ${REPORT_TARGET_SH} — refusing to inject a ref with an unresolved {{ORCHESTRATOR_REPORT_TARGET}} (#690)\n`,
    );
    return false;
  }
  d.tmpRef = mkTemp("dispatch-ref", body.split("{{ORCHESTRATOR_REPORT_TARGET}}").join(targetAddr));
  d.effRef = d.tmpRef;
  return true;
}

/**
 * tee, not capture. telepty's stdout is what the operator watches to see the
 * inject land; swallowing it to scrape one line would trade a visible dispatch
 * for an invisible one.
 *
 * Capturing the id must never be able to FAIL a dispatch, so a scratch buffer
 * problem degrades to "no id captured" — the already-supported
 * no_transport_inject_id path — rather than aborting a delivery the registry
 * has already authorized.
 */
function inject(o: Opts, d: Delivery, sid: string): Promise<number> {
  // Production (confined) delivery carries the staged absolute path as an inline
  // message: `telepty inject [flags] <session_id> "<prompt>"`. `--ref` is kept for
  // the unconfined __probe seam, where telepty derives its own tilde descriptor.
  const a = d.refPrompt
    ? ["inject", "--submit", "--no-submit-force", "--submit-retry", "0"]
    : ["inject", "--ref", d.effRef, "--submit", "--no-submit-force", "--submit-retry", "0"];
  if (o.fromId) a.push("--from", o.fromId);
  a.push(sid);
  // argv element, never a shell string: telepty joins args.slice(2) verbatim.
  if (d.refPrompt) a.push(d.refPrompt);
  return new Promise((resolve) => {
    let out = "";
    const child = (process.platform === "win32" ? crossSpawn : spawn)(TELEPTY, a, { stdio: ["inherit", "pipe", "inherit"] });
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      process.stdout.write(chunk);
    });
    const finish = (rc: number) => {
      d.transportInjectId = parseInjectId(out);
      if (d.tmpRef) rmTemp(d.tmpRef);
      resolve(rc); // preserve the inject's real exit code (callers gate on it)
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/** set-transport-result carrying the inject_id when telepty surfaced one. */
function recordTransport(d: Delivery, sid: string, result: string): number {
  const a = ["set-transport-result", "--sid", sid, "--result", result];
  if (d.transportInjectId) a.push("--inject-id", d.transportInjectId);
  return registryQuiet(a);
}

// ── #1270 bound busy delivery (caller half) ─────────────────────────────────
// A follow-up for a worker that is ALREADY WORKING can never satisfy the idle,
// empty-composer readiness wait below, so it used to time out with nothing
// delivered, recorded or staged. The daemon's `inject-bound-v1` verb takes a
// body+CR bound to one (session epoch, owner generation) pair and refuses if
// either moved; this is the caller half of that contract.
//
// NOTHING here proves the wrapped CLI queued, submitted or read the body.
// `accepted` means both frames were handed to the pinned owner bridge, so the
// durable record stays transport `unknown` plus ONE bounded observation —
// never `write_observed`, never a fresh VERIFIED, never a replay.
const BOUND_VERB = "inject-bound-v1";
const BOUND_CAPABILITY = "busy-input-v1";
// #1293 — this package declares NO dependency on @dmsdc-ai/aigentry-telepty: TELEPTY (:51) is the
// binary on PATH (or the operator's explicit override), a nested copy would never be executed here,
// and its postinstall WOULD still run on the host. The refusals below state what was observed and
// give advice that changes the host ONLY when a fact justifies it (r3): install advice when the
// normal PATH lookup finds no telepty, or when a telepty's capability document lacks the verb. A
// failing explicit TELEPTY override is the operator's to correct or unset — a reinstall would leave
// it failing (review R3-2). The CAPABILITY is what is checked; this version is only named, as the
// first published telepty declaring BOUND_VERB.
const TELEPTY_MIN_VERSION = "0.11.1";
const TELEPTY_INSTALL_COMMAND = "npm i -g @dmsdc-ai/aigentry-telepty@latest";
const TELEPTY_REQUIREMENT =
  "aigentry-orchestrator declares no dependency on @dmsdc-ai/aigentry-telepty and drives the telepty on PATH, " +
  `so nothing here installs, upgrades, starts, stops or restarts it: install @dmsdc-ai/aigentry-telepty ` +
  `${TELEPTY_MIN_VERSION} or later yourself with '${TELEPTY_INSTALL_COMMAND}', then dispatch again`;
/** True when TELEPTY names something other than the bare word the normal PATH lookup resolves. */
const TELEPTY_OVERRIDDEN = TELEPTY !== "telepty";

/** r3: the first PATH entry holding an executable telepty — the normal lookup — or null. r4 (review
 *  R4-4): a relative or empty entry is searched too, from this process's cwd, as the spawn does.
 *  r5 (review R5-3): `absent` is true only when PATH is set and EVERY candidate's lookup failed with
 *  ENOENT/ENOTDIR; a candidate that exists without being runnable, or any other error, leaves absence
 *  unestablished. POSIX entries are joined literally (`<entry>/telepty`), never normalised, so a
 *  `link/..` component resolves through the kernel as the spawn's own lookup does. */
function teleptyOnPath(): { readonly found: string | null; readonly absent: boolean } {
  const win = process.platform === "win32";
  const names = win
    ? (env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter((ext) => ext !== "").map((ext) => `telepty${ext.toLowerCase()}`)
    : ["telepty"];
  let absent = env.PATH !== undefined;
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    for (const name of names) {
      const file = win ? path.join(dir, name) : dir === "" ? name : `${dir}/${name}`;
      if (isExecutable(file)) return { found: file, absent: false };
      try {
        fs.statSync(file);
        absent = false;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") absent = false;
      }
    }
  }
  return { found: null, absent };
}

/**
 * r3 (review R3-2): the facts of a telepty command that could not be STARTED (ENOENT/EACCES), and
 * the one instruction they justify. An override is described by what its file is, and the operator
 * is told to correct or unset it, with no install command (r4); install advice only when there is no
 * override and the PATH lookup finds no telepty.
 */
function teleptyUnstartable(errno: string): string {
  const { found: onPath, absent } = teleptyOnPath();
  if (TELEPTY_OVERRIDDEN) {
    let what = `could not be started (${errno})`;
    if (path.isAbsolute(TELEPTY)) {
      try {
        // r4 (review R4-2): EACCES alone does not prove the file's own mode; its execute bit does.
        if (!fs.statSync(TELEPTY).isFile() || (errno === "EACCES" && !isExecutable(TELEPTY)))
          what = `is not an executable file (${errno})`;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") what = `does not exist (${errno})`;
      }
    }
    return `the TELEPTY override names ${TELEPTY}, which ${what}, so no session can be listed, registered or ` +
      "delivered to. Correct TELEPTY or unset it; " + (onPath !== null
      ? `the normal PATH lookup finds telepty at ${onPath}`
      // r4 (review R4-2): no install command here — the override, not PATH, is what dispatch runs.
      : "the normal PATH lookup finds no executable telepty either");
  }
  // EACCES from the PATH lookup means a telepty file IS there; only ENOENT with none found is "no telepty".
  if (onPath !== null || errno !== "ENOENT")
    return `the telepty on PATH${onPath !== null ? ` (${onPath})` : ""} could not be started (${errno}), so no ` +
      "session can be listed, registered or delivered to. Check that file's permissions and, for a script, its interpreter";
  // r5 (review R5-3): ENOENT with nothing found is "no telepty" only when the lookup ESTABLISHED absence.
  if (!absent)
    return `the telepty command could not be started (${errno}), and a look at PATH did not establish that no telepty ` +
      "is there, so no session can be listed, registered or delivered to. Check the PATH entries that dispatch searches";
  return `no telepty is on PATH (${errno}), so no session can be listed, registered or delivered to. ${TELEPTY_REQUIREMENT}`;
}
/**
 * The ONE refusal for a telepty that cannot run at all — exit 78, by name, before any wait.
 * 78 is this CLI's existing "a prerequisite this dispatch needs is unavailable; nothing was
 * transported" code (SANDBOX_PLATFORM_UNSUPPORTED at :2097, the exhausted router at usage.ts:37,
 * BOUND_INJECT_UNSUPPORTED at :1398), and `aigentry-orchestrator init` now promises exactly this
 * code for exactly this condition.
 */
const TELEPTY_UNAVAILABLE = "TELEPTY_CLI_UNAVAILABLE";
const BOUND_RESULT_SCHEMA = "telepty.bound-inject-result/v1";
const BOUND_LOOPBACK = "127.0.0.1";
// The frozen result vocabulary. Anything outside it is read as `unknown`, never coerced.
const BOUND_RESULT_STAGES = new Set(["refused", "accepted", "outcome_unknown"]);
const BOUND_FRAME_STAGES = new Set(["not_sent", "queued", "sent_to_bridge", "pty_written", "unknown"]);
/**
 * r1 M1: the verb's OWN classification vocabulary, closed like every sibling field, because
 * this value is persisted in the durable observation. Measured, not assumed — these five are
 * every value the shipped verb can print: `refused_locally` (inject-bound-v1.js:91,98),
 * `outcome_unknown` (:116 and the classifier default), and `accepted`/`refused`/
 * `unsupported` from classifyBoundResponse (bound-inject.js:139-144) via :120.
 */
const BOUND_TRANSPORTS = new Set(["accepted", "refused", "outcome_unknown", "refused_locally", "unsupported"]);
/** The contract's bounded reason code. */
const BOUND_REASON = /^[a-z0-9_]{1,64}$/;
/**
 * r1 M3: the DAEMON's shared rule for an opaque identity token, mirrored instead of a
 * narrower one of our own — non-empty, at most 256 UTF-8 BYTES, no control character
 * (telepty1270-bound3 `changes/src/protocol/bound-inject.js:35-39`, TOKEN_MAX_BYTES at :29;
 * the same function gates the request end, so a value this rejects could never be sent).
 * The contract types epoch and owner generation as OPAQUE, so the caller may not assume an
 * alphabet: the previous `[A-Za-z0-9._:-]{1,128}` refused a legitimate daemon-minted token
 * (`+`, `/`, `=`, a space, any non-ASCII, or over 128 UTF-16 units) at exit 78, before
 * beginDelivery, blaming the snapshot for the caller's own narrowness.
 *
 * The ONE property the caller adds is argv safety: a leading `-` could be read as a flag by
 * an argv consumer (the daemon CLI itself refuses a `--`-prefixed flag VALUE,
 * inject-bound-v1.js:58, and `--inject-id <token>` is argv for the registry). The value
 * stays a single argv element and never becomes a shell string.
 */
const BOUND_TOKEN_MAX_BYTES = 256;

function boundedToken(value: unknown): boolean {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= BOUND_TOKEN_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith("-");
}

/**
 * The pinned identity ONE snapshot published, and the capability it declared with it.
 * r6/n-A: no `cliKind` here — the admission's CLI kind lives on BusyAdmission, where it is
 * actually read (as the readiness-verdict reuse key); a copy on the binding was dead state.
 */
interface BoundBinding { epoch: string; ownerGeneration: string; busyInput: string }

/**
 * The daemon's closed result object, every field re-bounded on the way in. r1 M2 adds the
 * three identity fields the answer carries, so an acceptance can be checked against the
 * binding it was supposed to be about instead of being booked on the caller's assumption.
 */
interface BoundResult {
  stage: string;
  reason: string | null;
  injectId: string | null;
  sessionId: string | null;
  sessionEpoch: string | null;
  ownerGeneration: string | null;
  bodyStage: string;
  submitStage: string;
  bytesWritten: number | null;
}

/**
 * ONE current local snapshot. `telepty list --json` is the existing read verb that
 * carries the daemon's transport block (session-inspection serializeSession →
 * buildSessionTransportBlock), so id, host, epoch, owner generation and the busy
 * capability are read from the SAME row of the SAME read — a caller that took the
 * identity from an older view, a cache or a probe could bind a body to an owner
 * that is already gone. Exactly one matching row, or no snapshot at all.
 */
function boundSnapshot(sid: string): { cliKind: string; host: string; epoch: string; ownerGeneration: string; busyInput: string } | null {
  // r1 m1: the read's own verdict decides whether it has authority, exactly as its sibling
  // boundVerbVerdict does. A degraded or half-written listing that still happens to parse
  // may not supply the identity a body is bound to.
  const { status, stdout } = capture(TELEPTY, ["list", "--json"]);
  if (status !== 0) return null;
  let rows: unknown;
  try { rows = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const hits = rows.filter((s) => s !== null && typeof s === "object" && (s as { id?: unknown }).id === sid);
  if (hits.length !== 1) return null; // 0 = not listed; >1 = an identity nobody can resolve
  const row = hits[0] as Record<string, unknown>;
  const t: Record<string, unknown> = row.transport !== null && typeof row.transport === "object" ? row.transport as Record<string, unknown> : {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const command = str(row.command);
  return { cliKind: cliKindOf(command) || command, host: str(row.host), epoch: str(t.session_epoch),
    ownerGeneration: str(t.owner_generation), busyInput: str(t.busy_input) };
}

/**
 * The sealed local capability document (`telepty boot-capabilities`), purely local:
 * printing it starts, repairs or contacts nothing. An OLD CLI answers an unknown verb
 * with its help text and exit 0, and that is NOT support — so only a JSON object whose
 * `verbs` array names the verb counts. Prose, a non-zero exit or no output is refusal.
 * #1293 r3/r4: the refusal is `lacks` only when the CLI printed a telepty-boot-capabilities-v1 document whose `verbs`
 * omits the verb — the one answer that establishes an older telepty. A spawn error, a signal, a
 * non-zero exit, no output or prose is `inconclusive` (`detail` says which) and draws no upgrade advice.
 */
function boundVerbVerdict(): { kind: "ok" | "lacks" | "inconclusive"; detail: string } {
  const r = capture(TELEPTY, ["boot-capabilities"]);
  if (r.spawnError !== undefined) return { kind: "inconclusive", detail: `could not be run (${r.spawnError})` };
  if (r.signal !== undefined) return { kind: "inconclusive", detail: `was terminated by ${r.signal}` };
  if (r.status !== 0) return { kind: "inconclusive", detail: `exited ${r.status}` };
  try {
    const doc = JSON.parse(r.stdout) as { schema?: unknown; verbs?: unknown };
    if (doc !== null && typeof doc === "object" && Array.isArray(doc.verbs)) {
      if (doc.verbs.includes(BOUND_VERB)) return { kind: "ok", detail: "" };
      // r4 (review R4-3): only a well-formed telepty-boot-capabilities-v1 document ESTABLISHES the
      // lack; any other object with a verbs array is malformed, so inconclusive. Admission is unchanged.
      // r5 (review R5-2): "well-formed" is the boot door's own rule (plan.ts bootCapabilitiesDocument).
      if (bootCapabilitiesDocument(r.stdout) !== null) return { kind: "lacks", detail: "" };
      return { kind: "inconclusive", detail: `printed a verbs array without ${BOUND_VERB} outside a valid telepty-boot-capabilities-v1 document` };
    }
  } catch {
    /* prose, such as an older CLI's help text, or no output */
  }
  return { kind: "inconclusive", detail: "printed no JSON object with a verbs array (an unknown verb's help text and exit 0 is not support)" };
}

/**
 * What the admission measured: the binding when the bound path is taken, plus the ONE
 * readiness verdict it read. r1 m2: that verdict is handed to waitForReady as its FIRST
 * iteration instead of being thrown away, so an unchanged idle `--target` pays exactly
 * what it paid before this feature existed — one listing (resolveRoute's, already made)
 * and one probe.
 */
interface BusyAdmission {
  bound: BoundBinding | null;
  cliKind: string;
  probe: ProbeState | null;
  /** r4 m-C: when the admission's probe STARTED, so the readiness deadline can be anchored
   *  there and a `--target` dispatch's total wall budget stays exactly `--timeout-ms`. */
  startedAt: number;
  /** r7 m9: whether a probe was actually RUN (and so actually spent wall time). `probe` can
   *  be null for two different reasons — the admission returned before probing at all, or it
   *  probed and got no usable verdict — and only the second must come out of the readiness
   *  budget. `startedAt` is meaningful as an anchor exactly when this is true. */
  probed: boolean;
}

/**
 * r4 B1 — the admission predicate, derived from bin/session-probe.py (NOT edited) rather
 * than assumed. Three facts the real probe emits, each load-bearing:
 *
 *  1. `surface === "working"`. In the live path `classify_surface(..., current=True)` returns
 *     `working` only through its `current_busy_signal(controls)` arm (probe :538-540), and
 *     `observe()` RE-CLASSIFIES the surface on `controls` (:637-640), so a settled session
 *     whose only glyph row is a completed duration footer re-reads as `idle`, not `working`
 *     (#1136). The arms tested before it — thinking_block, sandbox_prompt, TRUST_MODAL,
 *     crash, sleep_cut, api_error, raw_shell, UNSUBMITTED — therefore cannot be `working`.
 *  2. the ONE busy ready_reason production can produce: `current-busy-or-modal` (r7 m2/m3).
 *     The probe has three busy spellings and only this one is live-reachable, so only this
 *     one is admitted — and because `probeState` never passes `--screen-file`, this single
 *     equality IS the guarantee that the verdict came from the live current viewport:
 *       • `current-working` is UNREACHABLE in BOTH modes: `surface === "working"` implies
 *         `current_busy_signal(controls)` is true, and `ready_by_current_screen` evaluates
 *         that same expression on the same input (:488-491) and returns
 *         `current-busy-or-modal` BEFORE its `surface == "working"` line (:492-493). r0-r3
 *         required exactly this dead value, which is what made the feature inert (B1).
 *       • `hard-negative` is the OFFLINE `--screen-file` answer (:366-374), and offline mode
 *         has NO composer guarantee at all — `ready_by_screen` never inspects the composer —
 *         so admitting it would admit a busy session whose composer already holds typed text.
 *         The third review measured exactly that (`hw_busy_typed_composer.txt`: offline
 *         `hard-negative` → would admit; live `no-empty-current-prompt` → refused).
 *     `no-empty-current-prompt` is NOT admitted: that reason IS the composer guarantee in
 *     the live path, where it is returned before any busy test (:489-490). It is the gate
 *     that actually carries the safety here, and it is the reason a live verdict is required.
 *  3. `detail.tracker_class` is one of the families that may be given input — an explicit
 *     ALLOW-list (r7 m4), so a class the probe gains later is refused by default rather than
 *     admitted into an input-writing path. r4 required `=== "active"` instead and
 *     CI measured the consequence: the canonical claude busy row
 *     `⏺ Working... (5s · esc to interrupt)` (tests/dispatch/fixtures/working_active.txt, the
 *     very row probe :415-421 calls measured) yields tracker_class **"blank"**, because
 *     `TRACKER_ACTIVE_TEXT` (:130) needs the parenthesis to wrap the phrase exactly —
 *     `\(esc to interrupt\)` does not match `(5s · esc to interrupt)` — and the row carries
 *     no braille spinner. So an inclusion on "active" refused a genuinely busy session: B1
 *     again, in a narrower form. `tracker_class` has exactly FIVE reachable returns —
 *     `blank` (:326), `error` (:329), `welcome` (:337), `active` (:339), `prompt_observed`
 *     (:345) and `blank` again (:346) — so this list and the r6 exclusion
 *     `∉ {welcome, error}` decide every screen identically today; the difference is which way
 *     a sixth class would fall. Each admitted member is live-reachable for a genuinely busy
 *     session, measured by the third review: `active` = active.txt, `prompt_observed` = a
 *     busy row with an empty composer, `blank` = a busy composer followed by a footer row.
 *     The two left out are left out for cause:
 *       • `"welcome"` is the approval/boot family — `TRACKER_WELCOME` (:129) is
 *         `Welcome back|Tips for getting started|Trust this folder|Press Enter to continue`,
 *         which is a DIFFERENT pattern family from `TRUST_MODAL` (:73), so it still catches an
 *         approval or welcome banner that the modal reader's line anchoring missed while
 *         `current_busy_signal`'s fourth arm (:427) matched a busy word. Measured: a busy row
 *         + `Welcome back` + an empty composer is refused by THIS guard alone.
 *       • `"error"` is `TRACKER_ERR` (:125-128) — an `error:`/`traceback`/`panic:`/
 *         `command not found`/`killed:`/`exited N` line, which `classify_surface` does not test
 *         for, so a broken session is not handed input either. Measured the same way: a busy
 *         row + `error: EACCES` + an empty composer is refused by THIS guard alone.
 *     `activity` is NOT usable for any of this: `observe()` derives it from the surface
 *     (`activity = "moving" if working_token …`, :645), so it carries no evidence the surface
 *     does not already carry.
 *
 * The modal/approval family's PRIMARY exclusion is conjunct 1: `classify_surface` tests
 * thinking_block, sandbox_prompt, TRUST_MODAL, crash, sleep_cut, api_error, raw_shell and
 * UNSUBMITTED before its working arm, so none of them can be `working`. CI measured that for
 * the trust modal and for a busy row carrying `Press Enter to continue`: both refused.
 *
 * The corrected truth table, with each row marked measured-by-CI or derived, is in
 * output/REPORT.md.
 */
/** r7 m2/m3: the one busy reason the LIVE probe can produce, and therefore the only one
 *  admitted. A verdict carrying any other spelling did not come from a live current viewport
 *  (or carries no composer guarantee), and is left to the readiness wait. */
const BOUND_BUSY_REASON = "current-busy-or-modal";
/** r7 m4: the tracker families that MAY be given input — an allow-list, so an unknown
 *  (future) class is refused by default instead of admitted. Equivalent today to r6's
 *  exclusion `∉ {welcome, error}`, since the probe emits exactly these five classes. */
const BOUND_TRACKER_ADMITTED = new Set(["blank", "active", "prompt_observed"]);

/**
 * Only a NON-SPAWNED `--target` whose current state is qualified busy may take the
 * bound path, and it takes it at once: a fresh spawn, a modal, an unsubmitted
 * composer, an unknown surface, a probe error and a missing verdict all stay exactly
 * as fail-closed as before, through the untouched readiness wait.
 *
 * Returns a null binding to leave that wait in charge. A session that IS qualified busy
 * but cannot carry a bound send is refused BY NAME right here — before beginDelivery,
 * with zero input effect of any kind.
 */
function admitBoundBusy(o: Opts, sid: string): BusyAdmission {
  const startedAt = nowMs();
  if (o.spawn || !o.target || o.retryUnknown) return { bound: null, cliKind: "", probe: null, startedAt, probed: false };
  // r1 m2: no listing of our own for the CLI kind. resolveRoute has just resolved this very
  // sid's wrapped CLI through cliOf() — the same `telepty list --json` row, the same
  // cliKindOf() resolution — so asking again would only duplicate it.
  const cliKind = o.cli && o.cli !== "unknown" ? o.cli : "";
  if (!cliKind) return { bound: null, cliKind: "", probe: null, startedAt, probed: false };
  // r4 m-D: the SAME per-probe ceiling waitForReady's own first iteration would use, codex
  // rule included, so no CLI kind's first readiness probe gets a shorter budget than in base;
  // r4 m-C anchors the readiness deadline at `startedAt`, so the total stays --timeout-ms.
  const budget = readinessTimeout(o, cliKind);
  const p = probeState(sid, cliKind, Math.max(1, Math.min(READINESS_CAPTURE_MAX_MS, budget)));
  const measured: BusyAdmission = { bound: null, cliKind, probe: p, startedAt, probed: true };
  // The three facts above, in the cheapest order. `ready` must be false: a ready session is
  // the legacy path's business, and the bound path is only for a session that cannot accept
  // a new task through the composer.
  if (p === null || !p.alive || p.probeError || p.ready || p.surface !== "working"
    || p.readyReason !== BOUND_BUSY_REASON || !BOUND_TRACKER_ADMITTED.has(p.trackerClass)) return measured;
  // Only NOW is one snapshot read worth taking: this session is qualified busy, so the
  // binding is about to be used. An unreadable listing leaves the readiness wait in charge
  // (the pre-feature behaviour for a busy target), rather than inventing a capability refusal.
  const snap = boundSnapshot(sid);
  if (!snap || !snap.cliKind) return measured;
  const refuse = (why: string): never =>
    die(`dispatch.sh: BOUND_INJECT_UNSUPPORTED for ${sid} — ${why}. Nothing was transported`, 78);
  if (snap.host !== BOUND_LOOPBACK) {
    refuse(`${BOUND_VERB} is ${BOUND_LOOPBACK}-only and this session is listed on host ${printable(snap.host || "unknown")}`);
  }
  if (!o.fromId) refuse(`${BOUND_VERB} requires an explicit --from sender`);
  if (!boundedToken(snap.epoch) || !boundedToken(snap.ownerGeneration)) {
    refuse(`the snapshot published no usable session_epoch/owner_generation to bind ${BOUND_VERB} to`);
  }
  if (snap.busyInput !== "supported") {
    refuse(`the bridge does not declare ${BOUND_CAPABILITY} for the current owner generation ` +
      `(transport.busy_input=${printable(snap.busyInput || "absent")}), so a busy worker cannot be given input`);
  }
  const boundVerb = boundVerbVerdict();
  if (boundVerb.kind === "lacks") {
    // An established fact. Through an override, installing another telepty would not change the CLI
    // dispatch runs, so the one instruction names the override instead (r3).
    refuse(`the local telepty CLI ${TELEPTY} does not advertise ${BOUND_VERB} in its boot-capabilities verbs — ` +
      (TELEPTY_OVERRIDDEN
        ? `TELEPTY names this CLI, so installing another telepty does not change it: point TELEPTY at ` +
          `@dmsdc-ai/aigentry-telepty ${TELEPTY_MIN_VERSION} or later, or unset it`
        : TELEPTY_REQUIREMENT));
  }
  if (boundVerb.kind === "inconclusive") {
    // Nothing about the CLI's version was established, so no upgrade is advised (r3, review R3-6).
    refuse(`'${TELEPTY} boot-capabilities' ${boundVerb.detail}, so ${BOUND_VERB} support is unknown and bound ` +
      `delivery to a busy worker cannot be admitted (${BOUND_VERB} is declared by @dmsdc-ai/aigentry-telepty ` +
      `${TELEPTY_MIN_VERSION} or later); run '${TELEPTY} boot-capabilities' to see its answer`);
  }
  return { bound: { epoch: snap.epoch, ownerGeneration: snap.ownerGeneration, busyInput: snap.busyInput },
    cliKind, probe: p, startedAt, probed: true };
}

/**
 * The frozen argv, complete and verbatim:
 *   telepty inject-bound-v1 --from F --expected-epoch E --expected-owner-generation G -- SID PROMPT
 * ONE send. No retry, no redelivery, no second submit, no legacy fallback and no key
 * write — win, lose or unknown. stdout is tee'd (the operator watches the dispatch
 * land, exactly as the legacy inject does) and kept for the daemon's closed answer.
 */
function injectBound(o: Opts, d: Delivery, sid: string, b: BoundBinding): Promise<{ rc: number; out: string }> {
  const a = [BOUND_VERB, "--from", o.fromId, "--expected-epoch", b.epoch,
    "--expected-owner-generation", b.ownerGeneration, "--", sid, d.refPrompt];
  return new Promise((resolve) => {
    let out = "";
    const child = (process.platform === "win32" ? crossSpawn : spawn)(TELEPTY, a, { stdio: ["inherit", "pipe", "inherit"] });
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      process.stdout.write(chunk);
    });
    const finish = (rc: number) => {
      if (d.tmpRef) rmTemp(d.tmpRef);
      resolve({ rc, out });
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * The verb's answer. It prints one bounded envelope `{transport, reason, result}` whose
 * `result` is the daemon's closed object verbatim; a bare closed object is read too, so
 * this binds the FACT rather than one wrapper's spelling. Every field is re-bounded here.
 *
 * A lost, truncated or non-schema answer yields no result, which is `outcome_unknown` —
 * it is NEVER read as zero bytes. Zero is authoritative only where the answer itself
 * proves it: a local/host refusal that opened no socket, the schema-less 404 that proves
 * the route is unregistered, or a closed `refused` result reporting 0.
 */
function parseBoundAnswer(out: string): { transport: string; cliReason: string | null; result: BoundResult | null } {
  const bounded = (value: unknown, allowed: Set<string>): string =>
    typeof value === "string" && allowed.has(value) ? value : "unknown";
  const token = (value: unknown): string | null => (boundedToken(value) ? value as string : null);
  const reasonCode = (value: unknown): string | null =>
    typeof value === "string" && BOUND_REASON.test(value) ? value : null;
  for (const line of out.replace(/\r/g, "").split("\n").reverse()) {
    if (!line.trim()) continue;
    let doc: unknown;
    try { doc = JSON.parse(line); } catch { continue; }
    if (doc === null || typeof doc !== "object") continue;
    const envelope = doc as Record<string, unknown>;
    // r1 M1: the raw value decides only whether this line IS the verb's answer; what travels
    // onward — into the decision and into the durable observation — is the bounded one.
    const raw = typeof envelope.transport === "string" ? envelope.transport : "";
    const transport = raw === "" || BOUND_TRANSPORTS.has(raw) ? raw : "unknown";
    const body: Record<string, unknown> = envelope.result !== null && typeof envelope.result === "object"
      ? envelope.result as Record<string, unknown> : envelope;
    const result: BoundResult | null = body.schema === BOUND_RESULT_SCHEMA ? {
      stage: bounded(body.stage, BOUND_RESULT_STAGES),
      reason: typeof body.reason === "string" && BOUND_REASON.test(body.reason) ? body.reason : null,
      injectId: token(body.inject_id),
      // r1 M2: the daemon reports its OWN current identity on every stage
      // (session-actions.js:1890-1899), so these are facts to check the pin against, not
      // echoes of the request. Absent/unbounded reads as null = "not asserted".
      sessionId: token(body.session_id),
      sessionEpoch: token(body.session_epoch),
      ownerGeneration: token(body.owner_generation),
      bodyStage: bounded(body.body_stage, BOUND_FRAME_STAGES),
      submitStage: bounded(body.submit_stage, BOUND_FRAME_STAGES),
      // r4 m-B (same family): a zero is read as zero only where a zero can be authoritative.
      // An `accepted` stage means both frames were handed over, so a 0 beside it contradicts
      // itself — the daemon's own builder nulls the count the moment a body may exist
      // (bound-inject.js:126). A contradicting field is degraded, never believed.
      bytesWritten: body.bytes_written === 0 && body.stage !== "accepted" ? 0 : null,
    } : null;
    if (raw === "" && result === null) continue; // not this verb's line
    // r2: the envelope's own bounded reason code, which for every shape WITHOUT a closed
    // result is the only cause available (inject-bound-v1.js:91,98,116,120). Read from the
    // envelope, never from the closed body, so the two reasons stay distinguishable.
    return { transport, cliReason: reasonCode(envelope.reason), result };
  }
  return { transport: "", cliReason: null, result: null };
}

/**
 * ONE exact bounded structured observation: schema, binding, inject_id and both frame
 * stages. The registry already accepts an arbitrary `observe --kind … --json {…}`, so
 * no registry or schema expansion is involved — and none would be authorized merely to
 * relabel a hand-off. `write_observed` is deliberately absent: only matching body+CR
 * PTY receipts could justify that word, and this answer is not one.
 *
 * r2: every field is nested under ONE `bound` object, and that nesting is load-bearing,
 * not cosmetic. `append_observation` stores only the fields whose value is not None
 * (`bin/dispatch-registry.py:513-516`, `if v is not None`), so a TOP-LEVEL `null` is
 * dropped and the key is simply absent from the durable record. For this unit that is a
 * correctness defect, not an aesthetic one: a reader of `bytes_written` that defaults an
 * absent key to 0 — `obs.get("bytes_written", 0)`, `Number(obs.bytes_written ?? 0)` —
 * would read "nothing was written" for a lost answer and for an accepted hand-off, which
 * is exactly the inference the frozen contract forbids ("never infer zero from a
 * timeout/lost response/queued frame"). The same filter was silently erasing `schema`,
 * `reason`, `reported` and `inject_id` on the shapes where each is legitimately null.
 * Inside a nested object nothing is filtered, so every explicit null survives verbatim;
 * the registry itself is untouched (its filter is shared by every other observation kind).
 */
function recordBoundObservation(sid: string, b: BoundBinding,
  answer: { transport: string; cliReason: string | null; result: BoundResult | null },
  rc: number, verdict: string): void {
  const r = answer.result;
  // r4 m-B: the same rule as the decision above — these two words are read only when the
  // daemon sent no closed result, so a contradicting envelope can neither free a ref nor
  // record a zero for a body the result says was accepted.
  const provenUnsent = r === null
    && (answer.transport === "refused_locally" || answer.transport === "unsupported");
  const bound = {
    verb: BOUND_VERB,
    schema: r === null ? null : BOUND_RESULT_SCHEMA,
    stage: r !== null ? r.stage : provenUnsent ? "refused" : "unknown",
    transport: answer.transport || null,
    reason: r === null ? null : r.reason,
    // The caller's pin, and (r1 M2) what the daemon itself said the answer was about, kept
    // apart: the first is an assumption, the second is the fact that was checked against it.
    // r6: exactly the three keys the contract's "exact bounded structured observation" names.
    // r4 recorded a fourth (`cli`) to close note n-A, which asked only that the then-dead
    // BoundBinding.cliKind be dropped OR used — no finding required a wider RECORD, and three
    // deepStrictEqual assertions measured the narrow shape. n-A is closed by removing the
    // field from BoundBinding instead (its interface and its one literal).
    binding: { session_epoch: b.epoch, owner_generation: b.ownerGeneration, busy_input: b.busyInput },
    reported: r === null ? null
      : { session_id: r.sessionId, session_epoch: r.sessionEpoch, owner_generation: r.ownerGeneration },
    verdict,
    inject_id: r === null ? null : r.injectId,
    body_stage: r === null ? "unknown" : r.bodyStage,
    submit_stage: r === null ? "unknown" : r.submitStage,
    // r1 n1: zero is authoritative for the two shapes that prove no socket was opened and no
    // route existed; it stays null everywhere a body may already exist.
    bytes_written: r !== null ? r.bytesWritten : provenUnsent ? 0 : null,
    consumption: "unknown",
    cli_exit: rc,
    // r2: the verb's OWN bounded reason code, which is the only reason a shape without a
    // closed result carries (`response_unavailable`, `response_unparseable`,
    // `route_unsupported`, or an argv/host refusal code). Without it a lost or locally
    // refused delivery left no diagnosable cause in the record at all.
    cli_reason: answer.cliReason,
  };
  if (registryQuiet(["observe", "--sid", sid, "--kind", "bound_inject_result", "--json", JSON.stringify({ bound })]) !== 0) {
    process.stderr.write(`dispatch.sh: WARNING the bound-inject observation for ${sid} could not be recorded ` +
      "(the transport result itself still is)\n");
  }
}

// ── #1270 the stranded composer, reported to the operator (CLEAR-DESIGN.md §7) ──
//
// When a bound body reached the composer but its CR did not, the daemon STRANDS that exact
// session instance: every later body and key from every producer is refused `composer_stranded`
// until an operator clears it. This helper only REPORTS that. It never runs
// `clear-strand-v1`, never sends a key, never retries, replays or reaches for another input
// route, for the three reasons CLEAR-DESIGN.md §7 gives:
//   1. the helper cannot see the composer, so its clear would be an assertion NOBODY made —
//      the audit line would name a machine as the asserting party;
//   2. an automatic clear turns the strand back into the silent corruption it exists to stop:
//      the next body would append to text that is still there and be submitted as one message;
//   3. the frozen contract: "No automatic operator-clear or recovery is added", and the
//      strand's own comment — "This unit refuses honestly; it does not invent a repair"
//      (telepty src/mailbox/delivery-runtime.js:163-165).
/**
 * THE classification table: every reason the DAEMON records a strand for, mapped to what its own
 * record implies about the BODY. An answer carrying one of these keys PROVES the pinned instance
 * is stranded; the value decides one printed line, and nothing else.
 *
 *   `true`  — the write RETURNED success before the failure, so the text IS in that composer
 *             (`bodyHanded`, delivery-runtime.js:1393);
 *   `false` — the write itself never resolved, so the body MAY be there and may not
 *             (`bodyAttempted` without `bodyHanded`, the distinction :1322-1332 draws).
 *
 * Sources, key by key: the four `strand()` returns after the body was handed over
 * (delivery-runtime.js:1400-1403, called at :1404, :1410, :1415, :1416), which travel to the
 * caller in the closed result's `reason` beside `stage: "outcome_unknown"` (:1402); the two catch
 * arms (:1428 after a handed body, :1429 after a bare attempt), which rethrow — so whichever code
 * the route puts on its 500 is the route's own and is not in this unit's inputs; and
 * `body_outcome_unknown` (:1389-1391), which is a strand ONLY AFTER the daemon change recorded as
 * STRAND_NOT_RECORDED below. An unlisted `outcome_unknown` reason is ASSUMED stranded, never
 * cleared, so a code this table has not met yet still reaches the operator.
 */
const STRAND_REASONS = new Map<string, boolean>([
  ["binding_changed_after_body", true],
  ["admission_changed_after_body", true],
  ["submit_refused_after_body", true],
  ["submit_outcome_unknown", true],
  ["delivery_threw_after_body", true],
  ["delivery_threw_during_body", false],
  // Task 1270 r1, Root decision CSR3-M1: the daemon is changed so that an uncertain BODY write
  // strands too, with this reason. Before that change the same answer installed no record.
  ["body_outcome_unknown", false],
]);
/**
 * `boundAdmissionRefusal`'s code for an instance that is ALREADY stranded
 * (delivery-runtime.js:1215). It is a pre-effect refusal with a provable zero
 * (`refuse()`, :1268), so the dispatch is unsent — re-dispatchable AFTER a clear, not before.
 */
const STRAND_REFUSED = "composer_stranded";
/**
 * `outcome_unknown` reasons that install NO strand record, so claiming "no input is admitted"
 * would state a refusal the daemon never made. EMPTY by Root decision CSR3-M1: the one member it
 * had, `body_outcome_unknown` (delivery-runtime.js:1389-1391 in the sources this unit was given),
 * moved into STRAND_REASONS above with `false`. This is the one-line seam back: if the daemon's r6
 * round does not seal that change, put `"body_outcome_unknown"` here and remove its table row.
 */
const STRAND_NOT_RECORDED = new Set<string>([]);
/** The honest, unverifiable-by-construction basis (clear-strand.js:38; CLEAR-DESIGN.md §2.2). */
const STRAND_BASIS = "composer_emptied_by_operator";
/** The literal `clear-strand-v1` accepts for "that strand carried no inject id" (clear-strand-v1.js:45). */
const STRAND_INJECT_NONE = "none";
/** The inject-id shape the strand record and the clear verb both bound (bound-inject.js:162,:192). */
const STRAND_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * shellQuote()'s own bare-word class (:135), reused as the paste gate. `boundedToken` bans
 * control characters but ADMITS `$ ` ` ; ' "` and a space, and the lines below are a command an
 * operator may paste: a value outside this class is replaced by a placeholder plus the read-only
 * lookup, so it can never reach a shell. The contract types epoch/generation as OPAQUE, so a
 * legitimate token can fail this (a space, `·`) — that costs a lookup, never a wrong command.
 */
const STRAND_ARGV_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** How well this answer knows the pinned instance is stranded, or null when it is not. */
type StrandKnowledge = "recorded" | "already" | "assumed";

/**
 * KNOW or ASSUME, decided on the daemon's own vocabulary and never on a guess:
 *  • `recorded` — the answer names a reason the delivery strands on, so the record exists;
 *  • `already`  — the answer is the strand's own refusal: nothing was transported;
 *  • `assumed`  — the outcome is unknown and nothing proves the strand path did NOT run (a lost
 *    or unparseable answer, the route's 500, an answer about another session). Fail-safe: the
 *    message says so in as many words and asks the operator to confirm in the view.
 * An ACCEPTED hand-off, every ordinary pre-effect refusal (`epoch_mismatch`,
 * `busy_input_unsupported`, …), the two shapes that prove no socket/route
 * (`refused_locally`/`unsupported`, bound-inject.js:140-142) and the one non-stranding
 * `outcome_unknown` are NOT strands and print nothing.
 */
function strandKnowledge(r: BoundResult | null, transport: string, accepted: boolean,
  otherSession: boolean): StrandKnowledge | null {
  if (accepted) return null;
  // An answer about another id is not about ours: its identity fields may not be printed, and
  // our own delivery's fate is exactly as unknown as a lost answer's.
  if (otherSession) return "assumed";
  if (r === null) return transport === "refused_locally" || transport === "unsupported" ? null : "assumed";
  // Reason first, stage second: the reason is the daemon's own name for the branch it took, and
  // the table is the only thing that decides whether that branch records a strand.
  if (r.reason !== null && STRAND_REASONS.has(r.reason)) return "recorded";
  if (r.reason === STRAND_REFUSED) return "already";
  if (r.stage !== "outcome_unknown" || (r.reason !== null && STRAND_NOT_RECORDED.has(r.reason))) return null;
  return "assumed";
}

/**
 * CLEAR-DESIGN.md §7's message block, with ONLY values this helper really has. Everything in it
 * is bounded (an opaque token is ≤256 bytes, a reason code ≤64, bound-inject.js:29-30) and
 * carries no prompt text, no screen text and no credential — there is no prompt on this door.
 *
 * Where a field is not in the answer the block prints the §7 step-3 READ-ONLY lookup instead of
 * inventing it; no new network call is made here, and the `--from` is left as
 * `<operator-sid>`, never this helper's own sender, so the daemon's audit line names the human
 * who asserted (§7, last paragraph).
 */
function strandAdvisory(sid: string, b: BoundBinding,
  answer: { transport: string; cliReason: string | null; result: BoundResult | null },
  knowledge: StrandKnowledge, why: string, otherSession: boolean): string {
  const r = answer.result;
  /** Validated for the suggested command: the file's own token rule PLUS the paste gate. */
  const safe = (value: string | null): string | null =>
    value !== null && boundedToken(value) && STRAND_ARGV_SAFE.test(value) ? value : null;
  // The strand's key IS the epoch this delivery pinned: delivery-runtime.js:1349 hands
  // `expectedEpoch` to strandComposer, which stores it as the record's `epoch` (:177), and the
  // clear must name that same record (`strand.epoch !== epoch` ⇒ no effect, :241). So the pin,
  // never the answer's possibly-newer current epoch.
  const epoch = safe(b.epoch);
  // The clear compares `--expected-owner-generation` against the LIVE
  // `session.interactionOwnerGeneration` (delivery-runtime.js:187-192; CLEAR-INTERFACE-V1 §5 step
  // 4.8), so the FRESHEST value the helper holds is the right one to suggest: the daemon's own
  // current generation, which the route reports on every stage (parseBoundAnswer :1470).
  // r1 CSR3-m2: the guard is `otherSession`, not `knowledge`. Those are two different facts — an
  // answer about ANOTHER session carries another session's generation and must be dropped, while
  // an answer about OURS whose reason is merely unlisted (the route's own 500 for the two
  // throw-strands) carries our current one, and that is exactly the case where a reclaim has made
  // the pin stale. Keying on `knowledge` printed the stale pin for it, and printed no lookup
  // either, because the value was non-null.
  const reported = otherSession || r === null || r.ownerGeneration === null ? null : r.ownerGeneration;
  const generation = safe(reported !== null ? reported : b.ownerGeneration);
  // Only the delivery that CAUSED the strand carries its id: the record's `inject_id` is the
  // same `injectId` the answer reports (delivery-runtime.js:178 ← :1349), nulled when it was not
  // a valid id — which is exactly `none`. A `composer_stranded` REFUSAL reports the fresh id of
  // THIS request instead (a new bound delivery mints a new one, CLEAR-DESIGN.md §3.5), so it is
  // never printed as the stranded id.
  const injectId = knowledge !== "recorded" || r === null ? null
    : r.injectId === null ? STRAND_INJECT_NONE
      : STRAND_UUID.test(r.injectId) ? r.injectId : null;
  // The strand's own reason, for the one shape that carries it: the delivery passes the same
  // string to strandComposer and to the result (delivery-runtime.js:1401-1402).
  const reason = knowledge === "recorded" && r !== null && r.reason !== null ? r.reason
    : knowledge === "already" ? STRAND_REFUSED : why;
  const target = safe(sid);
  const look = `telepty session ${target !== null ? target : "<sid>"}`;
  const ph = (value: string | null, name: string): string => (value !== null ? value : `<${name}>`);
  const headline = knowledge === "recorded"
    ? `STRANDED: ${printable(sid)} — the daemon recorded a stranded composer for this session instance.`
    : knowledge === "already"
      ? `STRANDED: ${printable(sid)} — this session instance was ALREADY stranded before this dispatch.`
      : `STRANDED (ASSUMED): ${printable(sid)} — this delivery's outcome is unknown, so this instance ` +
        "must be assumed stranded until the view says otherwise.";
  const fate = knowledge === "already"
    ? "  nothing was transported: my dispatch is provably UNSENT and may be re-dispatched AFTER a clear."
    : "  my dispatch is HELD and will not be replayed.";
  // r1 CSR3-M1, table-driven: the daemon strands on an uncertain body write too, and that record
  // does NOT mean the text arrived. Printed only where the table says the body was never
  // confirmed handed over, so the operator is never told to look for something that must be there.
  const bodyUncertain = knowledge === "recorded" && r !== null && r.reason !== null
    && STRAND_REASONS.get(r.reason) === false;
  const lines = [
    headline,
    "  no input is admitted for this session instance: every later body and key from every",
    "  producer is refused `composer_stranded` until an operator clears it.",
    `  session_epoch:      ${ph(epoch, "epoch")}`,
    `  owner_generation:   ${ph(generation, "generation")}`,
    `  stranded_inject_id: ${ph(injectId, "uuid")}   reason: ${printable(reason)}` +
      `   observed_at: ${isoSeconds(utcNow())}`,
    fate,
  ];
  if (bodyUncertain) {
    lines.push("  the body MAY be in the composer — the write was uncertain, so an empty composer is possible.");
  }
  if (epoch === null || generation === null || injectId === null) {
    lines.push("  every <…> above is NOT in this answer — read it (read-only, nothing is changed) with:",
      `    ${look}   → transport.session_epoch, transport.owner_generation,`,
      "        transport.stranded_composer.inject_id (`null` there ⇒ the literal `none`), .reason, .at");
  }
  lines.push(
    "  observed_at is this helper's own clock; the strand's own `at` is in that same view.",
    "",
    "Do NOT `telepty attach` and press Enter: while stranded your keystrokes are dropped, and after",
    "a clear they are not — a bare Enter would submit whatever is in the composer.",
    "",
    "To recover, in this order:",
    "  1. At the terminal where this worker's bridge runs, look at the composer and empty it",
    "     yourself (your own keyboard is the only input this session accepts right now).",
    `  2. telepty clear-strand-v1 --from <operator-sid> --expected-epoch ${ph(epoch, "epoch")} \\`,
    `       --expected-owner-generation ${ph(generation, "generation")} ` +
      `--stranded-inject-id ${ph(injectId, "uuid")} \\`,
    `       --basis ${STRAND_BASIS} -- ${target !== null ? target : "<sid>"}`,
    // r1 note CSR3-n3: four of the clear's own gates can refuse the very strand this block
    // describes (CLEAR-INTERFACE-V1 §5 steps 4.2, 4.3, 4.7, 4.9). Named here, in the block the
    // operator reads during the incident, rather than only in --help.
    "     Refused `session_closing`/`handoff_active`? that instance is on its way out or mid-handoff:",
    "     wait, re-read the view, and if its epoch has moved the strand is already inert. Refused",
    "     `owner_disconnected`/`owner_generation_unavailable`? the owner bridge is gone — reconnect it,",
    "     or take the alternative below.",
    `  3. Re-read \`${look}\`: transport.stranded_composer must be gone.`,
    "     If the next delivery is refused `composer_stranded` by the bridge, the bridge's own half",
    "     is engaged and only a new child clears it — restart the worker.",
    "Alternative: re-register the session (new epoch). This loses the conversation.",
    "This helper only PRINTS that command: it never clears, never sends a key and never replays.",
    "",
  );
  return lines.join("\n");
}

/**
 * The one bound send and everything that may follow it. Exits; never returns.
 *
 * An accepted hand-off is recorded as transport `unknown` plus the observation above and
 * reported as ACCEPTED_PENDING — a queued body is not a dispatched-and-verified worker,
 * so this path never prints the delivered line and never prints VERIFIED. A refusal the
 * answer proves unsent frees the ref to be re-dispatched; anything else is HELD unknown,
 * which is what prevents a replay of an identity whose fate nobody can answer for.
 */
async function completeBoundDelivery(o: Opts, d: Delivery, sid: string, b: BoundBinding): Promise<never> {
  const sent = await injectBound(o, d, sid, b);
  const answer = parseBoundAnswer(sent.out);
  const r = answer.result;
  // r1 M2 — the answer must be ABOUT what was pinned, and the two identity axes are NOT the
  // same question:
  //  • session_id is reported verbatim as the requested id on every stage
  //    (session-actions.js:1894), so a different one means this answer is about another
  //    session. That is a mix-up: never accepted, and never "provably unsent" either,
  //    because nothing it says about bytes is about OUR body.
  //  • session_epoch / owner_generation carry the DAEMON's CURRENT values (:1895-1896,
  //    deliberately "never the values the request claimed"). Equality is therefore required
  //    to ACCEPT, but a difference on a refusal is the normal, informative epoch_mismatch /
  //    owner_generation_mismatch answer (:1939-1940) — which is refused pre-effect, so it
  //    must stay re-dispatchable rather than being held forever.
  const otherSession = r !== null && r.sessionId !== null && r.sessionId !== sid;
  // r4 M-C: "the daemon never said which binding this was" is a different fact from "the
  // binding moved", and only the second is evidence about the pin. Root measured that the
  // route passes its current sessionEpoch/interactionOwnerGeneration into boundResult on
  // EVERY stage, so a null here means the session itself had no epoch — not a moved owner.
  const bindingAsserted = r !== null && r.sessionEpoch !== null && r.ownerGeneration !== null;
  const samePin = bindingAsserted && r !== null && r.sessionId === sid && r.sessionEpoch === b.epoch
    && r.ownerGeneration === b.ownerGeneration;
  const accepted = sent.rc === 0 && r !== null && r.stage === "accepted" && samePin
    && (answer.transport === "" || answer.transport === "accepted");
  // r4 m-B: a closed result OUTRANKS the envelope's transport word. The word is the CLI's
  // own classification of the answer; if the daemon sent a closed object, that object is the
  // answer, and `{transport:"refused_locally", result:{stage:"accepted"}}` must never free a
  // ref whose body was accepted. The two pre-daemon words are read ONLY when there is no
  // closed result at all.
  const unsent = !accepted && !otherSession && (r !== null
    ? (r.stage === "refused" && r.bytesWritten === 0)
    : (answer.transport === "refused_locally" || answer.transport === "unsupported"));
  // The named reason this verdict carries into the record and into the operator line. r2:
  // a shape with no closed result now names the verb's OWN reason code too — `reason=
  // outcome_unknown` was a restatement of the transport, not a cause an operator can act on.
  const why = otherSession ? "bound_session_identity_mismatch"
    : r === null ? [answer.transport || "none", answer.cliReason].filter((p) => p !== null).join(":")
      : r.stage === "accepted" && !bindingAsserted ? "bound_binding_not_asserted"
        : r.stage === "accepted" && !samePin ? "bound_binding_identity_mismatch"
          : r.reason !== null ? r.reason : r.stage;
  d.transportInjectId = r === null || r.injectId === null ? "" : r.injectId;
  recordBoundObservation(sid, b, answer, sent.rc, accepted ? "accepted" : unsent ? "proven_unsent" : `held:${why}`);
  // #1270 CLEAR-DESIGN.md §7 — ONE print site, after the record and before every exit below, so
  // every situation that knows or must assume the instance is stranded reports it with the exit
  // code and the marker it already had. The helper prints; the operator acts.
  const knowledge = strandKnowledge(r, answer.transport, accepted, otherSession);
  if (knowledge !== null) process.stderr.write(strandAdvisory(sid, b, answer, knowledge, why, otherSession));
  if (unsent) {
    if (recordTransport(d, sid, "not_delivered") !== 0) {
      die(`dispatch.sh: DELIVERY_UNKNOWN for ${sid} — ${BOUND_VERB} refused with nothing written, but that result ` +
        "could not be recorded", 7);
    }
    die(`dispatch.sh: BOUND_INJECT_REFUSED for ${sid} — ${BOUND_VERB} refused before any input reached the composer ` +
      `(reason=${printable(why)}); nothing was written, so this ref may be dispatched again`, 3);
  }
  if (recordTransport(d, sid, "unknown") !== 0) {
    die(`dispatch.sh: DELIVERY_UNKNOWN for ${sid} — the bound body may have been handed over but the transport ` +
      "result could not be recorded", 7);
  }
  if (!accepted) {
    die(`dispatch.sh: DELIVERY_UNKNOWN for ${sid} — ${BOUND_VERB} did not answer accepted ` +
      `(exit ${sent.rc}, transport=${printable(answer.transport || "none")}, ` +
      `stage=${printable(r === null ? "none" : r.stage)}, reason=${printable(why)}). Input may have been queued or ` +
      "written, so this identity is HELD: no replay, no Enter, review before retrying", 7);
  }
  taskLedgerUpdate(o, sid);
  emitTelemetry([
    "--helper", "dispatch",
    "--subtype", "dispatch_ack",
    "--payload-json", JSON.stringify({ target_sid: sid, verified: false, bound: true, stage: "accepted" }),
    "--correlation-id", sid,
  ]);
  if (o.verifyDelivered) {
    // A body that is queued behind a running turn is not on the screen yet, so the
    // post-inject screen read can neither corroborate nor refute it. It is skipped and
    // named, rather than answered wrongly in either direction (r1 m4: the NOTE says so in
    // as many words, because exit 0 here is the accepted-pending decision and must not be
    // mistaken for a screen that was read and found good).
    process.stderr.write(`dispatch.sh: NOTE delivery verification was NOT performed for ${sid}: --verify-delivered ` +
      "is a declared no-op on the bound busy path — a queued body is not visible on the screen, so no screen read " +
      "was attempted and nothing corroborates the hand-off. The record stays transport unknown\n");
  }
  // Accepted-pending-model, reported apart from started-working on purpose.
  // r4 n-B: daemon-supplied values reach the operator stream only through printable(), as
  // every sibling message in this file already does.
  process.stdout.write(`ACCEPTED_PENDING ${sid} — ${BOUND_VERB} accepted the bound body+CR for the pinned owner ` +
    `(epoch=${printable(b.epoch)} owner_generation=${printable(b.ownerGeneration)} ` +
    `inject_id=${printable(d.transportInjectId || "none")}); ` +
    "recorded transport unknown. A hand-off to the owner bridge is not a PTY write, not native queueing and not " +
    "model receipt\n");
  if (o.verifyStarted && isExecutable(VERIFY_SH)) {
    // Observe-only: a busy-admitted delivery must never be followed by a bare Enter or a
    // marker-triggered resubmit, and a spinner that may predate this body is not a receipt
    // for it. Legitimate idle recovery keeps its policy-controlled --resubmit path in the
    // legacy tail; this one observes and reports, and sends nothing.
    const vrc = run(VERIFY_SH, [sid, "--observe-only"], { TELEPTY });
    // r1 n4: an installed verifier that predates this flag answers its `-*` catch-all with
    // exit 4 (unknown arg). That is a SKIPPED observation, not a bad one, and it must not be
    // indistinguishable from a SUSPECT verdict in the record of what happened.
    if (vrc === 4) {
      process.stderr.write(`dispatch.sh: NOTE ${VERIFY_SH} does not understand --observe-only (exit 4), so ` +
        `started-working observation was SKIPPED for ${sid}; the accepted hand-off stands unchanged and no key ` +
        "was sent. Deploy bin/dispatch-verify.sh together with this cli.js\n");
    }
    emitTelemetry([
      "--helper", "dispatch",
      "--subtype", "dispatch_started_check",
      "--payload-json", JSON.stringify({ target_sid: sid, started: false, observe_only: true,
        observed: vrc === 0, verifier_rc: vrc, skipped: vrc === 4 }),
      "--correlation-id", sid,
    ]);
  }
  process.exit(0);
}

/**
 * 0 = the inject visibly landed, 1 = it visibly did not, 2 = it could not be
 * told either way. Called only when --verify-delivered is set.
 *
 * #835: a refused or unanswered read is not evidence of delivery; it is the
 * absence of evidence, and that is 2 — the caller maps it onto the existing
 * "delivery unknown" code rather than claiming either outcome.
 */
async function verifyDelivered(o: Opts, sid: string): Promise<number> {
  let firstLine = "";
  try {
    firstLine = fs.readFileSync(o.refFile, "utf8").split("\n")[0]!.replace(/\r/g, "");
  } catch {
    firstLine = "";
  }
  // The shell hard-coded `sleep 5` and the guards stubbed the `sleep` builtin to
  // skip it. That override cannot cross a process boundary, so the wait is an
  // honest env seam now (#899 tranche 1).
  const waitMs = Number(env.AIGENTRY_DISPATCH_VERIFY_SLEEP_MS ?? 5000);
  if (waitMs > 0) await sleepMs(waitMs);
  const r = capture(TELEPTY, ["read-screen", sid, "--lines", "30"]);
  if (r.status !== 0 || !r.stdout) {
    process.stderr.write(
      `dispatch.sh: read-screen for ${sid} returned nothing (rc=${r.status}) — delivery is UNVERIFIABLE, not verified\n`,
    );
    return 2;
  }
  return screenShowsDelivery(r.stdout, firstLine) ? 0 : 1;
}

/**
 * #1092: --retry-unknown was given but the registry's answer for this sid+ref is
 * not a held unknown attempt. Name what the row says (both axes) so the operator
 * sees why the override does not apply; the registry JSON is check-dedup's or
 * begin-delivery's.
 */
function retryRefused(sid: string, registryJson: string): string {
  let prior: { dispatch_id?: string; prior_lifecycle?: string; prior_transport?: string } = {};
  try { prior = JSON.parse(registryJson); } catch { /* not JSON: name only the absence */ }
  const what = prior.dispatch_id
    ? `prior ${prior.dispatch_id} is lifecycle=${prior.prior_lifecycle} transport=${prior.prior_transport}`
    : "no prior attempt for this sid+ref is held";
  return `dispatch.sh: DISPATCH_RETRY_REFUSED for ${sid} — --retry-unknown applies only to a delivery_state_unknown row; ${what}`;
}

/**
 * The authoritative write-before-delivery transaction. It re-runs the dedup
 * check atomically and, only for a new attempt, commits the durable unknown
 * record. Its `proceed` result is what authorizes the inject.
 * #718: a worker with a dedicated --worktree has its branch read there.
 */
function beginDelivery(o: Opts, d: Delivery, sid: string): { status: number; stdout: string } {
  let branch = "";
  const gitref = o.worktree || o.cwd;
  if (gitref) {
    branch = capture("git", ["-C", gitref, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.replace(/\n+$/, "");
  }
  const a = [
    "begin-delivery",
    "--sid", sid,
    "--ref-hash", d.refHash,
    "--ref-path", o.refFile,
    "--cwd", o.cwd,
    "--from", o.fromId,
    "--track", o.track,
    "--role", o.role,
    "--branch", branch,
  ];
  if (o.worktree) a.push("--worktree", o.worktree);
  if (o.keepAlive) a.push("--keep-alive");
  if (o.retryUnknown) a.push("--retry-unknown", o.retryUnknown);
  if (d.report && d.reportBinding) {
    a.push("--attempt", d.reportBinding.attempt, "--manifest-sha256", d.reportBinding.hash,
      "--report-request-id", d.report.request_id, "--report-challenge-sha256", d.report.challenge_sha256);
  }
  return registryOut(a);
}

// ── registration + readiness waits ──────────────────────────────────────────
/**
 * #727: presence wait, kept separate from waitForReady's REPL-ready wait
 * (telepty#18). Registration = "the bridge has published the session"; ready =
 * "its REPL is past the boot screen". Returns the wrapped CLI kind, or null.
 *
 * r4 m-E: it also reports whether it SLEPT before answering. A readiness verdict measured
 * before this wait cannot be that wait's answer, and only this function knows whether any
 * time passed (the --target default timeout is 0, but
 * AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS can make --target wait too).
 */
async function waitForRegistration(o: Opts, sid: string): Promise<{ kind: string; slept: boolean } | null> {
  let timeout: number;
  const knob = env.AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS;
  if (knob === undefined || knob === "") {
    // --target names a session that is supposed to exist already, so waiting
    // minutes there would only slow a genuine failure down. Only a fresh spawn
    // is worth the patience.
    timeout = o.spawn ? REGISTER_TIMEOUT_MS_DEFAULT : 0;
  } else {
    timeout = Number(knob);
  }
  const start = nowMs();
  const deadline = start + timeout;
  let notes = 0;
  let slept = false;
  for (;;) {
    const { kind, spawnError } = cliOf(sid);
    if (kind) return { kind, slept };
    // #1293: this is where dispatch first NEEDS telepty, and where a host without one used to spend
    // the whole budget (180000 ms for a spawn) before advising a longer timeout — advice that cannot
    // help, for a condition the very first listing had already proved. Refuse here instead, by name
    // and at once. Only a command that could not be STARTED lands here — ENOENT (no such file) or
    // EACCES (not executable): a telepty that runs and reports no such session, or overflows the
    // listing buffer (ENOBUFS, review F6), is the registration wait's business and is untouched.
    if (spawnError === "ENOENT" || spawnError === "EACCES") {
      // On the spawn path a workspace was already opened before this wait, so say so in exactly
      // the words the deadline branch below uses: the refusal is new, the operator's cleanup is not.
      die(`dispatch.sh: ${TELEPTY_UNAVAILABLE} for ${sid} — ${teleptyUnstartable(spawnError)}. ` +
        "Nothing was transported" +
        (o.spawn ? `\ndispatch.sh: the workspace opened for '${sid}' is still running; close it manually before retrying` : ""), 78);
    }
    const now = nowMs();
    if (now >= deadline) {
      process.stderr.write(
        `dispatch.sh: session '${sid}' never registered in telepty list after ${timeout}ms — raise AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS (default ${REGISTER_TIMEOUT_MS_DEFAULT} for --spawn-and-dispatch)\n`,
      );
      if (o.spawn) {
        process.stderr.write(
          `dispatch.sh: the workspace opened for '${sid}' is still running; close it manually before retrying\n`,
        );
      }
      return null;
    }
    const elapsed = Math.floor((now - start) / 1000);
    if (elapsed >= (notes + 1) * 30) {
      notes = Math.floor(elapsed / 30);
      process.stderr.write(`dispatch.sh: waiting for session registration… ${elapsed}s\n`);
    }
    // Cap the nap at what is left so the knob's value is also the worst-case wait.
    slept = true;
    await sleepMs(Math.min(deadline - now, 5000));
  }
}

/**
 * The readiness budget for one dispatch, by CLI kind. Extracted verbatim from waitForReady
 * (r4 m-D) so the busy admission's single probe is bounded by exactly the same number the
 * wait's own first iteration would use — including #557's codex ceiling — instead of a
 * second, shorter rule of its own.
 *
 * #557: codex reaches its interactive `›` REPL within seconds, but its 6 MCP servers can
 * take >30s to finish booting. Give codex a longer default ceiling (claude/gemini
 * unchanged). An explicit --timeout-ms always wins.
 */
function readinessTimeout(o: Opts, cliKind: string): number {
  if (cliKind === "codex" && !o.timeoutExplicit) return Number(env.AIGENTRY_CODEX_READY_TIMEOUT_MS || 90000);
  return o.timeoutMs;
}

/**
 * 0 ok, 1 ready-timeout, 6 never registered.
 *
 * `measured` (r1 m2) is the verdict the busy admission already read for this sid. When it
 * belongs to the same CLI kind this loop is about to probe AND the registration wait did not
 * sleep (r4 m-E — a verdict measured before a wait is not that wait's answer), it IS this
 * loop's first verdict, so the unchanged idle path performs exactly the one probe it always
 * did. Every later iteration probes afresh; a kind mismatch, a slept registration wait or an
 * absent admission reuses nothing.
 *
 * r4 m-C / r7 m9: the deadline is anchored at the admission's own start whenever an admission
 * probe RAN, so the time it spent comes OUT of this budget rather than being added to it. r4
 * anchored only on the reuse path, which left the overrun m-C named in the two cases where a
 * verdict is measured and then NOT reused — an explicit `--cli` disagreeing with the listing,
 * and a registration wait that slept. The probe precedes this wait in all three cases, so the
 * anchor is a property of having probed, not of reusing the answer.
 */
async function waitForReady(o: Opts, sid: string, measured?: BusyAdmission): Promise<number> {
  const registration = await waitForRegistration(o, sid);
  if (registration === null) return 6;
  const cliKind = registration.kind;
  let reused: ProbeState | null | undefined =
    measured !== undefined && measured.cliKind === cliKind && !registration.slept ? measured.probe : undefined;
  const effectiveTimeout = readinessTimeout(o, cliKind);
  const anchored = measured !== undefined && measured.probed;
  const deadline = (anchored ? measured!.startedAt : nowMs()) + effectiveTimeout;
  for (;;) {
    let ready: boolean;
    if (reused !== undefined) {
      ready = reused !== null && reused.ready;
      reused = undefined;
    } else {
      ready = isReady(sid, cliKind, Math.max(1, Math.min(READINESS_CAPTURE_MAX_MS, deadline - nowMs())));
    }
    if (ready) return 0;
    if (nowMs() >= deadline) {
      process.stderr.write(
        `dispatch.sh: timeout (${effectiveTimeout}ms) waiting for ${sid} REPL ready (cli=${cliKind})\n`,
      );
      return 1;
    }
    await sleepMs(500);
  }
}

// ── the spawn arm (#431 / #532) ─────────────────────────────────────────────
function spawnWorkspace(o: Opts, sid: string): void {
  const scope = loadWorkerScope(env.AIGENTRY_WORKER_SCOPE, o.taskId, sid);
  if (!o.role || !(CONFINED_CLIS as readonly string[]).includes(o.cli)) die(`dispatch.sh: SANDBOX_CLI_UNSUPPORTED: ${o.cli}; no unrestricted fallback`, 78);
  // #1167 P6: no OS sandbox runtime here (win32), so the confined spawn refuses now — after the routing/spawn
  // decision, before boot-prepare stages anything, the git guard is installed or a terminal opens. Same
  // predicate as prepareWorkerSandbox; darwin/linux never enter. The decision is named, non-ASCII escaped.
  if (!["darwin", "linux"].includes(process.platform)) {
    const decided = JSON.stringify({ cli: o.cli, model: o.route?.model ?? null, decided_by: o.route?.decided_by ?? null,
      ...(o.route?.capped_cli ? { capped_cli: o.route.capped_cli } : {}),
      ...(o.decision ? { effort: o.decision.effort.token, executable: o.decision.executable.path } : {}) })
      .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    die(`dispatch.sh: SANDBOX_PLATFORM_UNSUPPORTED: a confined worker needs the macOS/Linux OS sandbox and ` +
      `${process.platform} has none (documented limitation; no unrestricted fallback); decided ${decided}; ` +
      "nothing was spawned or registered (exit 78)", 78);
  }
  const spawnEnv: NodeJS.ProcessEnv = o.route && /^(llm|table)(-capped)?$/.test(o.route.decided_by) && o.decision?.model !== null
    ? { [`AIGENTRY_${o.cli.toUpperCase()}_MODEL`]: o.route.model } : {};
  // #1148: boot-prepare turns this ONE decision into argv; its launcher export dies at the runner (C3).
  if (o.decision) spawnEnv.AIGENTRY_SPAWN_DECISION = JSON.stringify(o.decision);
  const childEnv = { ...env, ...spawnEnv };
  // #431 (ADR 2026-05-12 enforcement) — hybrid (b-2)+(c) boot wiring.
  // A failed role boot must never fall back to an unrestricted CLI.
  let bootSpawnCli = "";
  let bootSpawnCwd = "";
  let bootArgv: string[] = [];
  let bootLaunch: LaunchConfig | undefined;
  // #532: boot-prepare role wiring covers claude (flag-based) + codex/gemini
  // (additive cwd context file + config-home shadow).
  const bootEligible = o.cli === "claude" || o.cli === "codex" || o.cli === "gemini" || o.cli === "grok";
  if (bootEligible && o.role) {
    // Resolve boot from this installed package, even when SCRIPT_DIR is a copied control workspace.
    const bootPrepare = fileURLToPath(new URL("../../../bin/boot-prepare.mjs", import.meta.url));
    if (isExecutable(bootPrepare)) {
      const r = captureOut("node", [bootPrepare, "--role", o.role, "--cwd", o.cwd, "--sid", sid, "--cli", o.cli, "--confined"],
        o.decision ? { ...spawnEnv, AIGENTRY_TASK_ID: o.taskId } : spawnEnv);
      let parsed: { spawn_cli?: unknown; spawn_cwd?: unknown; argv?: unknown; launch?: unknown; decision?: unknown } | null = null;
      if (r.status === 0 && r.stdout) {
        try {
          parsed = JSON.parse(r.stdout);
        } catch {
          parsed = null;
        }
      }
      if (parsed && parsed.spawn_cli !== undefined && parsed.spawn_cwd !== undefined &&
          Array.isArray(parsed.argv) && parsed.argv.every(a => typeof a === "string")) {
        // #1148: the boot must echo exactly this decision (a boot that ignored it is refused).
        if (o.decision && JSON.stringify(parsed.decision) !== JSON.stringify(o.decision)) {
          die("dispatch.sh: SANDBOX_BOOT_FAILED: boot-prepare did not apply the spawn decision; unrestricted fallback refused", 78);
        }
        bootSpawnCli = String(parsed.spawn_cli);
        bootSpawnCwd = String(parsed.spawn_cwd);
        bootArgv = parsed.argv;
        // #1162: typed configured metadata only; malformed/missing is explicit
        // unknown with a WARNING, never a spawn gate.
        if (isCliKind(o.cli)) {
          bootLaunch = normalizeLaunch(o.cli, parsed.launch);
          if (JSON.stringify(bootLaunch) !== JSON.stringify(parsed.launch)) {
            process.stderr.write(`dispatch.sh: WARNING boot-prepare launch metadata missing or invalid for sid=${sid}; model/effort unknown\n`);
          }
        }
      } else {
        process.stderr.write(
          `dispatch.sh: WARNING boot-prepare.mjs failed (exit ${r.status}) for sid=${sid} role=${o.role}\n`,
        );
        die("dispatch.sh: SANDBOX_BOOT_FAILED: unrestricted fallback refused", 78);
      }
    } else {
      die(`dispatch.sh: SANDBOX_BOOT_MISSING: ${bootPrepare}`, 78);
    }
  }
  const workerHooksDir = installWorkerGitGuard();
  if (workerHooksDir === null) {
    die("dispatch.sh: worker git guard install failed", 2);
  }
  let launcher: string;
  let spawnCwd: string;
  if (bootSpawnCli && bootSpawnCwd) {
    // Hybrid/additive path active. bootSpawnCli already encodes
    // AIGENTRY_TARGET_CWD export + the role delivery. Wrap it again at the
    // dispatch-owned layer so worker push protection is not dependent on
    // boot-prepare (#509). display_cli = o.cli (#532) so the guard wrapper's
    // `exec -a <cli>` and telepty visibility match the actual CLI.
    const protectedRoot = path.join(env.AIGENTRY_SESSIONS_ROOT || path.join(os.homedir(), ".aigentry", "sessions"), sid);
    // #1170 (RC6): the registry state (the registry's own default) and this control workspace.
    const stateDir = path.resolve(env.DISPATCH_STATE_DIR ||
      path.join(path.dirname(path.dirname(path.resolve(DISPATCH_REGISTRY_PY))), "state", "dispatch"));
    const sandbox = prepareWorkerSandbox(scope, o.cli, bootSpawnCwd, bootArgv, protectedRoot, o.cwd, workerHooksDir, bootLaunch,
      o.decision?.executable, { noAccess: [stateDir], noWrite: [path.resolve(SCRIPT_DIR, "..")] });
    launcher = writeWorkerLauncher(sid, o.cli, sandbox.launcher, "", workerHooksDir, spawnEnv);
    spawnCwd = bootSpawnCwd;
  } else {
    die("dispatch.sh: SANDBOX_BOOT_REQUIRED", 78);
  }
  // Empty --extra-flags so open-session.sh's claude-default flags do NOT apply
  // (we control the full argv via the launcher).
  const r = (process.platform === "win32" ? crossSpawn.sync : spawnSync)(
    OPEN_SESSION_SH,
    ["--track", o.track, "--name", o.name, "--cwd", spawnCwd, "--cli", launcher, "--extra-flags", " "],
    { stdio: ["inherit", "ignore", "inherit"], env: childEnv },
  );
  if (r.error || (r.status ?? 1) !== 0) {
    die("dispatch.sh: open-session.sh failed", 2);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main(argv: string[]): Promise<never> {
  const o = parseArgs(argv);

  if (!o.refFile) die("dispatch.sh: --ref required", 4);
  if (!fs.existsSync(o.refFile) || !fs.statSync(o.refFile).isFile()) {
    die(`dispatch.sh: ref file not found: ${o.refFile}`, 4);
  }

  verifyWorkerInputs(o);
  taskGateCheck(o);

  // controller-link v1 (task 1291, SPEC §10): a target with `@` names a peer CONTROLLER, never a
  // worker. Everything for it is inside this guard and every path in it exits. The controller-link
  // modules are loaded here by dynamic import, so a dispatch without `@` loads, reads, writes and
  // prints nothing it did not before. This branch creates no registry record, stages nothing and
  // never spawns, probes or cleans up anything on either machine: one telepty inject, recorded in
  // the controller-link outbox before it is sent.
  if (o.target.includes("@")) {
    const { LABEL_RE, REQUEST_ID_RE, TASK_ID_RE, normaliseBody, renderEnvelope } = await import("../controller-link/envelope.js");
    const { defaultProcessRunner, sendEnvelope, validPeerTarget } = await import("../controller-link/send.js");
    const { ControllerLinkStore, rawRef, resolveStoreRoot } = await import("../controller-link/store.js");
    type LinkRecordT = import("../controller-link/store.js").LinkRecord;
    type SendClassificationT = import("../controller-link/send.js").SendClassification;
    const packageRoot = path.resolve(SCRIPT_DIR, "..");
    const target = o.target;

    // SPEC §2 strict reader of the hand-written peer list. Any defect refuses the whole file.
    type PeerEntry = { label: string; target: string; link: string | null };
    const readPeers = (): { self: { label: string; controller_sid: string }; peers: PeerEntry[] } => {
      const override = env.AIGENTRY_CONTROLLER_PEERS;
      let file = path.join(packageRoot, "state", "controller-peers.json");
      if (override !== undefined && override !== "") {
        if (override.includes("\0") || override.split(/[/\\]/).includes("..") || !path.isAbsolute(override)) {
          throw new Error("AIGENTRY_CONTROLLER_PEERS must be an absolute path without '..' segments");
        }
        file = path.resolve(override);
      }
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { throw new Error("peer list missing or unreadable"); }
      if (!st.isFile() || st.size > 65536) throw new Error("peer list is not a regular file of at most 65536 bytes");
      let doc: unknown;
      try {
        doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)));
      } catch {
        throw new Error("peer list is not valid UTF-8 JSON");
      }
      const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
      const only = (v: Record<string, unknown>, allowed: readonly string[], where: string): void => {
        for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error(`unknown key in ${where}`);
      };
      if (!isObj(doc)) throw new Error("peer list is not a JSON object");
      only(doc, ["v", "self", "peers"], "the top level");
      if (doc.v !== 1) throw new Error("v must be 1");
      const self = doc.self;
      if (!isObj(self)) throw new Error("self missing or not an object");
      only(self, ["label", "controller_sid"], "self");
      const selfLabel = self.label, selfSid = self.controller_sid;
      if (typeof selfLabel !== "string" || !LABEL_RE.test(selfLabel)) throw new Error("self.label fails its pattern");
      if (typeof selfSid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(selfSid)) {
        throw new Error("self.controller_sid fails its pattern");
      }
      if (!isObj(doc.peers)) throw new Error("peers missing or not an object");
      const peers: PeerEntry[] = [];
      for (const [label, p] of Object.entries(doc.peers)) {
        if (!LABEL_RE.test(label)) throw new Error("a peer label fails its pattern");
        if (!isObj(p)) throw new Error(`peer ${label} is not an object`);
        only(p, ["target", "link"], `peer ${label}`);
        const peerTarget = p.target, link = p.link;
        if (typeof peerTarget !== "string" || !validPeerTarget(peerTarget)) throw new Error(`peer ${label} target is not <controller_sid>@<peer>`);
        if (link !== undefined && typeof link !== "string") throw new Error(`peer ${label} link is not a string`);
        if (peers.some((q) => q.target === peerTarget)) throw new Error(`peer ${label} repeats another peer's target`);
        peers.push({ label, target: peerTarget, link: typeof link === "string" ? link : null });
      }
      return { self: { label: selfLabel, controller_sid: selfSid }, peers };
    };
    let config: ReturnType<typeof readPeers>;
    try { config = readPeers(); } catch (e) {
      die(`dispatch.sh: PEER_CONFIG_INVALID: ${printable(String((e as Error)?.message ?? e))}; nothing sent`, 78);
    }
    // CL-16 (SPEC §10): a local alias names THIS machine, never a peer controller, so it is refused even
    // when the peer list names it. The host is normalised as a URL parser does (127.1, 0x7f.0.0.1,
    // LOCALHOST., [0:0:0:0:0:0:0:1], a :port suffix); a host no URL can hold is left to the list check.
    const urlHost = (h: string): string | null => {
      try { return new URL(`http://${h}/`).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
    };
    const peerHost = target.slice(target.lastIndexOf("@") + 1);
    const localAlias = [urlHost(peerHost), peerHost.startsWith("[") ? null : urlHost(`[${peerHost}]`)].some((h) => h !== null
      && (h === "localhost" || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "0.0.0.0"
        || h === "[::1]" || h === "[::]" || /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(h)));
    if (localAlias) {
      die(`dispatch.sh: PEER_TARGET_REFUSED: ${printable(target)} names this machine (a local alias), never a peer controller; nothing sent`, 78);
    }
    const peer = config.peers.find((p) => p.target === target && p.link === "v1");
    if (peer === undefined) {
      die(`dispatch.sh: PEER_TARGET_REFUSED: ${printable(target)} is not a listed peer controller with link "v1"; nothing sent`, 78);
    }

    // Flags that only make sense for a local worker (SPEC §10). argv is walked as parseArgs did.
    const VALUE_FLAGS = new Set(["--target", "--ref", "--from", "--timeout-ms", "--track", "--name", "--cwd", "--worktree", "--cli",
      "--role", "--task-class", "--task", "--no-task", "--input-root", "--input-manifest", "--input-sha256", "--observe", "--retry-unknown"]);
    const LOCAL_ONLY = new Set(["--spawn-and-dispatch", "--retry-unknown", "--worktree", "--verify-delivered", "--keep-alive", "--cli",
      "--role", "--task-class", "--observe", "--input-root", "--input-manifest", "--input-sha256", "--from"]);
    const unsupported: string[] = [];
    for (let i = 0; i < argv.length; i += VALUE_FLAGS.has(argv[i]!) ? 2 : 1) {
      if (LOCAL_ONLY.has(argv[i]!) && !unsupported.includes(argv[i]!)) unsupported.push(argv[i]!);
    }
    if (unsupported.length > 0) {
      die(`dispatch.sh: PEER_FLAG_UNSUPPORTED: ${unsupported.join(", ")} not supported for a peer controller target; nothing sent`, 4);
    }
    if (o.taskId && !TASK_ID_RE.test(o.taskId)) {
      die("dispatch.sh: PEER_FLAG_UNSUPPORTED: --task id not representable in the envelope; nothing sent", 4);
    }

    // The ref is read locally and becomes the envelope body (SPEC §3.3).
    if (fs.statSync(o.refFile).size > 262144) {
      die("dispatch.sh: PEER_BODY_TOO_LARGE: ref file larger than 262144 bytes; nothing sent", 4);
    }
    let refBytes: Buffer;
    try { refBytes = fs.readFileSync(o.refFile); } catch {
      die("dispatch.sh: PEER_BODY_INVALID: ref file unreadable; nothing sent", 4);
    }
    const body = normaliseBody(refBytes);
    if (!body.ok) {
      const at = body.error.line === null ? "" : ` (line ${body.error.line})`;
      die(`dispatch.sh: ${body.error.code}: ${printable(body.error.detail)}${at}; nothing sent`, 4);
    }
    if (body.body.includes("{{ORCHESTRATOR_REPORT_TARGET}}")) {
      die("dispatch.sh: PEER_REF_PLACEHOLDER: the ref contains {{ORCHESTRATOR_REPORT_TARGET}}, which names this machine's report target for local workers; nothing sent", 4);
    }

    const { randomUUID } = await import("node:crypto");
    const requestId = randomUUID();
    if (!REQUEST_ID_RE.test(requestId)) die("dispatch.sh: PEER_NOT_RECORDED: minted request id fails its pattern; nothing sent", 9);
    const senderTask = o.taskId || "-";
    const rendered = renderEnvelope({ kind: "REQUEST", id: requestId, seq: 1, ref: null, from: config.self.label, to: peer.label,
      sent_at: isoSeconds(utcNow()), sender_task: o.taskId || null, receiver_task: null, state: null, outcome: null, final: null,
      reason: null }, body.body);
    if (!rendered.ok) die(`dispatch.sh: ${rendered.error.code}: ${printable(rendered.error.detail)}; nothing sent`, 4);
    const envelope = rendered.envelope;

    // SPEC §6.1 step 1 + §10 de-duplication, in ONE store transaction: an open outbox record with the
    // same peer, sender task and body sha256 wins; otherwise the record is written (state `prepared`,
    // attempt `pending`) BEFORE anything is sent.
    const owner = `${process.pid}@${os.hostname()}`;
    const ref = { role: "sender" as const, requestId };
    const storeFailure = (e: unknown): string => printable(String((e as Error)?.message ?? e));
    const openStore = (): InstanceType<typeof ControllerLinkStore> => {
      try {
        return new ControllerLinkStore({ root: resolveStoreRoot(env, packageRoot), clock: { nowMs: () => Date.now() } });
      } catch (e) {
        return die(`dispatch.sh: PEER_NOT_RECORDED: ${storeFailure(e)}; nothing sent`, 9);
      }
    };
    const store = openStore();
    let duplicateOf: string | null;
    try {
      duplicateOf = await store.mutate<string | null>(ref, async (current, ctx) => {
        if (current !== null) throw new Error("request id already recorded");
        const open = await store.list({ role: "sender", peer: peer.label, open: true });
        const dup = open.find((r) => r.sender_task === senderTask && r.messages["REQUEST-1"]?.body_sha256 === envelope.body_sha256);
        if (dup !== undefined) return { write: null, value: dup.request_id };
        const record: LinkRecordT = {
          v: 1, role: "sender", request_id: requestId, peer: peer.label, peer_target: target, self_label: config.self.label,
          sender_task: senderTask, receiver_task: null, state: "prepared", state_at: ctx.nowIso,
          next_action: { code: "SEND", due_at: null, text: "dispatch is sending REQUEST-1" },
          messages: { "REQUEST-1": { sha256: envelope.sha256, body_sha256: envelope.body_sha256, raw: rawRef(envelope.sha256),
            sends: [{ n: 1, at: ctx.nowIso, owner, result: "pending" }] } },
          acks_in: {}, probes_out: { "REQUEST-1": { last_seq: 0, sends: [] } }, acks_out: { last_seq: 0, sends: [] },
          notices: { n: 0, last_at: null },
          history: [{ at: ctx.nowIso, event: "created", detail: "dispatch" }], history_dropped: 0,
        };
        return { write: record, raws: [{ sha256: envelope.sha256, bytes: Buffer.from(envelope.text, "utf8") }], value: null };
      });
    } catch (e) {
      die(`dispatch.sh: PEER_NOT_RECORDED: ${storeFailure(e)}; nothing sent`, 9);
    }
    if (duplicateOf !== null) {
      die(`dispatch.sh: PEER_REQUEST_DEDUPLICATED: open request ${duplicateOf} to ${target} has the same sender task and body; nothing sent`, 8);
    }

    // SPEC §6.1 steps 2–3 (U3), then step 4: the classified result goes into the same attempt.
    const sent = await sendEnvelope(target, envelope.text, { runner: defaultProcessRunner, bin: TELEPTY });
    const cls: SendClassificationT = sent.attempted ? sent.classification
      : { result: "unknown", submit: null, inject_id: null, detail: `not_started_${sent.code}` };
    const outcome = {
      handed_over: { state: "sent", code: "WAIT_ACK", min: cls.submit === "queued" ? 30 : 5, text: "wait for the peer's ACK; probe when due" },
      unknown: { state: "send_unknown", code: "PROBE", min: 5, text: "delivery unknown; probe the peer, never re-send blindly" },
      refused_definite: { state: "send_refused", code: "RESEND", min: 1, text: "definite refusal; re-send the same bytes on the back-off" },
    }[cls.result];
    let recorded = true;
    try {
      await store.mutate<null>(ref, (current, ctx) => {
        if (current === null) throw new Error("record vanished");
        const next = JSON.parse(JSON.stringify(current)) as LinkRecordT;
        const sends = next.messages["REQUEST-1"]?.sends ?? [];
        const attempt = sends[sends.length - 1];
        if (attempt === undefined || attempt.result !== "pending" || attempt.owner !== owner) throw new Error("attempt changed");
        attempt.result = cls.result;
        attempt.submit = cls.submit;
        attempt.inject_id = cls.inject_id;
        attempt.detail = cls.detail;
        // CL-02: only `prepared` (step 1 of THIS send) is moved by the result. An ACK or REPLY ingested
        // while telepty ran has already settled the record further; it is never moved backwards.
        if (next.state === "prepared") {
          next.state = outcome.state as LinkRecordT["state"];
          next.state_at = ctx.nowIso;
          next.next_action = { code: outcome.code, due_at: new Date(Date.parse(attempt.at) + outcome.min * 60_000).toISOString(), text: outcome.text };
        }
        next.history.push({ at: ctx.nowIso, event: "send", detail: `REQUEST-1 n=${attempt.n} ${cls.result}` });
        return { write: next, value: null };
      });
    } catch {
      recorded = false;
    }
    const why = cls.detail === null ? "" : ` (${printable(cls.detail)})`;
    const reconcile = "the pump reconciles this automatically; do not re-run dispatch";
    if (!recorded) {
      die(`dispatch.sh: PEER_DELIVERY_UNKNOWN: request ${requestId} to ${target} — result not recorded (telepty ${cls.result}${why}); ${reconcile}`, 7);
    }
    if (cls.result === "handed_over") {
      taskLedgerUpdate(o, target);
      process.stdout.write(`OK peer request ${requestId} to ${target} consumption=${cls.submit ?? "unknown"}\n`);
      process.exit(0);
    }
    if (cls.result === "refused_definite") {
      die(`dispatch.sh: PEER_NOT_DELIVERED: request ${requestId} to ${target} definitely refused${why}; ${reconcile}`, 11);
    }
    die(`dispatch.sh: PEER_DELIVERY_UNKNOWN: request ${requestId} to ${target}${why}; ${reconcile}`, 7);
  }

  let sid: string;
  if (o.spawn) {
    if (!o.track || !o.name || !o.cwd) {
      die("dispatch.sh: --track --name --cwd required for --spawn-and-dispatch", 4);
    }
    sid = `${o.track}-${o.name}`;
  } else if (o.target) {
    sid = o.target;
    try {
      assertConfinedTarget(path.join(env.AIGENTRY_SESSIONS_ROOT || path.join(os.homedir(), ".aigentry", "sessions"), sid), sid, o.taskId);
    } catch (e) {
      die(`dispatch.sh: SANDBOX_TARGET_UNVERIFIED: ${String(e)}; preserve artifacts and respawn`, 78);
    }
  } else {
    die("dispatch.sh: --target or --spawn-and-dispatch required", 4);
  }

  const d: Delivery = { refHash: "", effRef: "", tmpRef: "", transportInjectId: "", refPrompt: "" };

  // telepty#60 Stage A: the read-only dedup query runs BEFORE any side effect,
  // so a duplicate never spawns a workspace or waits for readiness. It creates
  // no record and no sidecar.
  d.refHash = computeRefHash(o.refFile);
  const dedup = registryBoth(["check-dedup", "--sid", sid, "--ref-hash", d.refHash]);
  let skipPreparation = false;
  if (dedup.status === 7 || dedup.status === 8) {
    skipPreparation = true; // duplicate/ambiguous: go straight to the atomic recheck
  } else if (dedup.status !== 0) {
    // The registry's own named result is the diagnosis; do not replace it with a
    // generic one, or a corrupt registry looks like a missing helper.
    if (dedup.output) process.stderr.write(dedup.output.replace(/\n?$/, "\n"));
    die(`dispatch.sh: DISPATCH_NOT_RECORDED — dedup query failed (rc=${dedup.status})`, 9);
  }
  if (o.retryUnknown) {
    // #1092: the override applies to a held unknown attempt and nothing else.
    // Refuse here, before any spawn or wait, so a misapplied flag has no side
    // effect; begin-delivery re-checks under the lock. A retry re-checks
    // readiness and re-prepares the ref like a first delivery, but the row it
    // supersedes proves the worker was spawned and ready, so it never opens a
    // second workspace and takes the existing worker's route.
    let prior: { prior_lifecycle?: string; prior_transport?: string } = {};
    try { prior = JSON.parse(dedup.output); } catch { /* malformed proof cannot authorize retry */ }
    if (dedup.status !== 7 || prior.prior_lifecycle !== "delivery_state_unknown" || prior.prior_transport !== "unknown") {
      process.stdout.write(dedup.output);
      die(retryRefused(sid, dedup.output), 4);
    }
    skipPreparation = false;
  }

  resolveRoute(o, sid, skipPreparation || o.retryUnknown !== "");
  const spawned = !skipPreparation && o.spawn && !o.retryUnknown;
  if (spawned) { applyCliCap(o); resolveSpawnDecision(o, sid); spawnWorkspace(o, sid); }

  emitTelemetry([
    "--helper", "dispatch",
    "--subtype", "dispatch_start",
    "--payload-json",
    JSON.stringify({
      target_sid: sid,
      mode: o.spawn ? "spawn-and-dispatch" : "target",
      cli: o.cli,
      role: o.role,
      route: o.route && { label: o.route.label, decided_by: o.route.decided_by, reason: o.route.reason, capped_cli: o.route.capped_cli },
      decision: o.decision && decisionAudit(o.decision),
    }),
    "--correlation-id", sid,
  ]);

  let bound: BoundBinding | null = null;
  if (!skipPreparation) {
    // #1270: a qualified current-busy nonspawned --target is admitted AT ONCE, because
    // its REPL will never show the idle, empty composer the wait below requires. Every
    // other not-ready state — and every fresh spawn — still goes through that wait.
    const admission = admitBoundBusy(o, sid);
    bound = admission.bound;
    if (!bound) {
      // #727: a registration/readiness timeout leaves nothing behind but the
      // workspace itself. No dedup mark is written any more, so the operator's
      // retry with the same ref reaches the delivery transaction.
      // r1 m2: the admission's one probe is this wait's first verdict, not an extra read.
      const rc = await waitForReady(o, sid, admission);
      if (rc !== 0) process.exit(rc);
      // #1162 G2b: after readiness, publish the sealed worker's metadata once.
      if (spawned) publishAgentMeta(sid, o.cli, path.join(env.AIGENTRY_SESSIONS_ROOT || path.join(os.homedir(), ".aigentry", "sessions"), sid));
    }
    if (!prepareEffectiveRef(o, d)) process.exit(3);
    const stage = path.join(env.AIGENTRY_SESSIONS_ROOT || path.join(os.homedir(), ".aigentry", "sessions"), sid);
    // #1170: mint the envelope and put its trailer in the ref BEFORE staging, so it lands
    // in the worker's read-only copy; refHash above stays the original ref's.
    const pinned = pinReportAttempt(stage, sid);
    if (pinned) {
      d.report = mintRequest();
      appendRefTrailer(d, renderRefTrailer(d.report, { task: o.taskId, sid, attempt: pinned.attempt }));
    }
    try {
      // Stage A, like prepareEffectiveRef: the message is built from the verified
      // staged path HERE, before the durable commit, so the transport call itself
      // stays infallible.
      const staged = stageWorkerRef(stage, sid, o.taskId, d.effRef);
      d.refPrompt = buildContextRefPrompt(staged);
      // #1170: the ref must have landed in the very attempt the envelope names.
      if (pinned) {
        const after = pinReportAttempt(stage, sid);
        if (!after || after.attempt !== pinned.attempt || after.hash !== pinned.hash) throw new Error("REPORT_ATTEMPT_CHANGED");
        d.reportBinding = after;
      }
    } catch (e) {
      die(`dispatch.sh: SANDBOX_REF_REFUSED: ${String(e)}`, 78);
    }
  }

  // Nothing fallible may run between this commit and the inject: a crash in
  // that window is conservatively delivery-unknown.
  const begin = beginDelivery(o, d, sid);
  if (begin.status === 4 && begin.stdout.includes('"DISPATCH_RETRY_REFUSED"')) {
    process.stdout.write(begin.stdout);
    die(retryRefused(sid, begin.stdout), 4);
  }
  switch (begin.status) {
    case 0:
      break;
    case 8:
      if (begin.stdout) process.stdout.write(begin.stdout);
      die(`dispatch.sh: DISPATCH_DEDUPLICATED for ${sid} — prior transport write observed, no new delivery`, 8);
      break;
    case 7:
      if (begin.stdout) process.stdout.write(begin.stdout);
      die(
        `dispatch.sh: DISPATCH_RETRY_HELD for ${sid} — a prior attempt's delivery is unknown; review before retrying`,
        7,
      );
      break;
    default:
      if (begin.stdout) process.stderr.write(begin.stdout);
      die(`dispatch.sh: DISPATCH_NOT_RECORDED for ${sid} — no delivery attempted`, 9);
  }

  // A success path must never fall back to telepty's tilde descriptor: that names
  // the HOST home, which the recipient's sandbox denies reading. Reachable only
  // when preparation was skipped as a duplicate yet the atomic recheck still said
  // proceed — so it must sit AFTER that recheck, or a genuine duplicate/held-unknown
  // would lose its authoritative 8/7 answer. The check itself is pure (no I/O, no
  // allocation), so it does not reintroduce a fallible step before the transport;
  // it refuses outright, and the committed row stays conservatively unknown because
  // nothing was handed to telepty.
  if (!d.refPrompt) {
    die(`dispatch.sh: SANDBOX_REF_UNSTAGED for ${sid} — no confined ref was staged; refusing a host-rooted ref. Nothing was transported`, 78);
  }

  // #1270: the busy-admitted delivery hands over through the bound verb instead, after
  // exactly the same pin/stage/re-pin/beginDelivery ordering. It never returns.
  if (bound) await completeBoundDelivery(o, d, sid, bound);

  if ((await inject(o, d, sid)) !== 0) {
    process.stderr.write(`dispatch.sh: telepty inject failed for ${sid}\n`);
    // A generic nonzero return is NOT proof that no bytes landed, so the record
    // says delivery-unknown rather than claiming a clean failure. The inject_id,
    // if telepty printed one before failing, is recorded HERE too: this is
    // exactly the dispatch whose fate nobody can otherwise answer for.
    try { recordTransport(d, sid, "unknown"); } catch { /* best-effort */ }
    process.exit(3);
  }

  // Exit 0 requires the transport result to be durable too — a caller that
  // cannot tell "delivered and recorded" from "delivered, bookkeeping lost"
  // will book the second as a successful re-dispatch.
  if (recordTransport(d, sid, "write_observed") !== 0) {
    die(
      `dispatch.sh: DELIVERY_UNKNOWN for ${sid} — bytes were handed to telepty but the transport result could not be recorded`,
      7,
    );
  }

  if (o.verifyDelivered) {
    const vrc = await verifyDelivered(o, sid);
    if (vrc === 2) {
      // #835 — "the screen could not be read" is not "the inject failed". Exit 7
      // is this repo's existing name for a delivery whose result is unknown.
      die(
        `dispatch.sh: DELIVERY_UNKNOWN for ${sid} — the inject was written but the screen could not be read back, so nothing corroborates it`,
        7,
      );
    } else if (vrc !== 0) {
      die(
        `dispatch.sh: DELIVERY_FAILED for ${sid} (placeholder untouched; registered for pull-fallback despite verify-FN)`,
        5,
      );
    }
  }
  taskLedgerUpdate(o, sid);

  emitTelemetry([
    "--helper", "dispatch",
    "--subtype", "dispatch_ack",
    "--payload-json", JSON.stringify({ target_sid: sid, verified: o.verifyDelivered }),
    "--correlation-id", sid,
  ]);
  process.stdout.write(`OK dispatched to ${sid}\n`);

  // Rule 33: post-dispatch START verification (default ON; non-fatal — the
  // inject already landed). SUSPECT means "delivered but not started as
  // intended"; the orchestrator must resolve the surface.
  if (o.verifyStarted && isExecutable(VERIFY_SH)) {
    // --resubmit: auto-recover the #412 codex submit race by re-sending Enter
    // once when the only fault is idle.
    const started = run(VERIFY_SH, [sid, "--resubmit"], { TELEPTY }) === 0;
    if (!started) {
      process.stderr.write(
        `dispatch.sh: ⚠️ Rule 33 — ${sid} did NOT verify as started-working (see SUSPECT above). Resolve before relying on the worker.\n`,
      );
    }
    emitTelemetry([
      "--helper", "dispatch",
      "--subtype", "dispatch_started_check",
      "--payload-json", JSON.stringify({ target_sid: sid, started }),
      "--correlation-id", sid,
    ]);
  }
  process.exit(0);
}

// ── __probe: the test seam that replaced `source dispatch.sh` ───────────────
// 12 guards used to source the script under DISPATCH_SH_NO_MAIN=1 and call its
// bash functions (is_ready, verify_delivered, prepare_effective_ref, do_inject)
// directly. An exec shim exports no shell functions, so those behaviours are
// reachable here instead — same fixtures, same stubs, same assertions, now
// measuring the code production actually runs. Internal surface: not a flag,
// not in --help, no caller outside tests/dispatch/.
async function probe(argv: string[]): Promise<never> {
  const sub = argv[0];
  if (sub === "is-ready") {
    // __probe is-ready <sid> <cli> [budget-ms]
    const budget = argv[3] === undefined ? READINESS_CAPTURE_MAX_MS : Number(argv[3]);
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > READINESS_CAPTURE_MAX_MS) die("dispatch.sh: invalid readiness probe budget", 4);
    process.exit(isReady(argv[1] ?? "", argv[2] ?? "", budget) ? 0 : 1);
  }
  if (sub === "verify-delivered") {
    // __probe verify-delivered --ref <file> <sid> → 0 landed / 1 did not / 2 unknown
    const o = parseArgs(argv.slice(1, argv.length - 1));
    process.exit(await verifyDelivered(o, argv[argv.length - 1] ?? ""));
  }
  if (sub === "dispatch-ref") {
    // __probe dispatch-ref --ref <file> [--from <id>] <sid>
    // prepare_effective_ref + do_inject, the pair T67 calls back to back.
    const o = parseArgs(argv.slice(1, argv.length - 1));
    // Unconfined probe: no staging, so refPrompt stays empty and inject keeps the
    // legacy `--ref` argv the 12 guards measure. Not the production path.
    const d: Delivery = { refHash: "", effRef: "", tmpRef: "", transportInjectId: "", refPrompt: "" };
    if (!prepareEffectiveRef(o, d)) process.exit(3);
    process.exit(await inject(o, d, argv[argv.length - 1] ?? ""));
  }
  process.stderr.write(`dispatch.sh: unknown __probe subcommand: ${String(sub)}\n`);
  process.exit(4);
}

const argv = process.argv.slice(2);
if (argv[0] === "__probe") {
  await probe(argv.slice(1));
} else {
  await main(argv);
}
