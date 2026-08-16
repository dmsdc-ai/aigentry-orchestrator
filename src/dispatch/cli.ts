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
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE } from "./usage.js";

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

const REGISTER_TIMEOUT_MS_DEFAULT = 180000;

// ── small process helpers ───────────────────────────────────────────────────
function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** stdout+status, stderr swallowed — the shell's `$(cmd 2>/dev/null || true)`. */
function capture(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** stdout captured, stderr inherited — the shell's plain `out=$(cmd)`. */
function captureOut(cmd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** stdout+stderr both captured — the shell's `out=$(cmd 2>&1)`. */
function captureBoth(cmd: string, args: string[]): { status: number; output: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) return { status: 127, output: String(r.error.message ?? "") };
  return { status: r.status ?? 1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Fully inherited stdio — the shell's bare `cmd`. */
function run(cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd, args, {
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
    spawnSync(EMIT_TELEMETRY_MJS, args, { stdio: "ignore" });
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

function defaultCliFlags(cli: string): string {
  switch (cli) {
    case "claude":
      return `--model "${env.AIGENTRY_CLAUDE_MODEL || "claude-opus-5"}" --effort "${env.AIGENTRY_CLAUDE_EFFORT || "xhigh"}" --permission-mode bypassPermissions`;
    case "codex":
      return "-c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox";
    case "gemini":
      return `-m "${env.AIGENTRY_GEMINI_MODEL || "gemini-2.5-flash"}" --approval-mode yolo`;
    default:
      return "";
  }
}

/** `tr -c 'A-Za-z0-9_.-' '_'` */
function safeSessionComponent(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function mkTemp(prefix: string): string {
  const dir = env.TMPDIR || "/tmp";
  return path.join(dir, `${prefix}.${randomBytes(3).toString("hex")}`);
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
/** Look up the wrapped CLI ("claude"/"codex"/"gemini") for a sid, "" if absent. */
function cliOf(sid: string): string {
  const { stdout } = capture(TELEPTY, ["list", "--json"]);
  try {
    const list = JSON.parse(stdout);
    if (!Array.isArray(list)) return "";
    for (const s of list) {
      if (s && s.id === sid) return String(s.command || "");
    }
  } catch {
    /* the python arm swallowed every parse error too */
  }
  return "";
}

/**
 * Returns true if the wrapped CLI's REPL is past the welcome/boot screen.
 * The probe semantics live in session-probe.py and are deliberately untouched
 * (their false-negatives are known and documented) — this only reads its verdict.
 */
function isReady(sid: string, cliKind: string): boolean {
  const { stdout } = capture(SESSION_PROBE_PY, ["--sid", sid, "--cli", cliKind], { TELEPTY });
  if (!stdout) return false;
  try {
    return JSON.parse(stdout).ready === true;
  } catch {
    return false;
  }
}

// ── registry seam (telepty#60 Stage A) ──────────────────────────────────────
// The registry component is the single typed writer of the dispatch registry.
// Its failure is the dispatch's failure.
function registryMissing(): boolean {
  if (isExecutable(DISPATCH_REGISTRY_PY)) return false;
  process.stderr.write(
    `dispatch.sh: DISPATCH_NOT_RECORDED — registry component missing at ${DISPATCH_REGISTRY_PY}\n`,
  );
  return true;
}

/** `registry "$@"` with stdout+stderr captured (the check-dedup call site). */
function registryBoth(args: string[]): { status: number; output: string } {
  if (registryMissing()) return { status: 9, output: "" };
  return captureBoth(DISPATCH_REGISTRY_PY, args);
}

/** `registry "$@"` with stdout captured, stderr passed through. */
function registryOut(args: string[]): { status: number; stdout: string } {
  if (registryMissing()) return { status: 9, stdout: "" };
  return captureOut(DISPATCH_REGISTRY_PY, args);
}

/** `registry "$@" >/dev/null` — status only. */
function registryQuiet(args: string[]): number {
  if (registryMissing()) return 9;
  const r = spawnSync(DISPATCH_REGISTRY_PY, args, { stdio: ["ignore", "ignore", "inherit"] });
  if (r.error) return 127;
  return r.status ?? 1;
}

// ── inject_id scraping (#872) ───────────────────────────────────────────────
/**
 * The transport id telepty printed, or "" (#872).
 *
 * telepty 0.8.0 prints it on its own undecorated line so a caller can scrape it
 * without parsing the decorated success line. That is still human-facing stdout,
 * not a machine contract, so this reads conservatively: the whole line must be
 * the prefix plus the exact UUID shape crypto.randomUUID() emits, anchored at
 * both ends. Anything else yields NO id — transport.inject_id stays null and
 * dispatch-tracker.sh fires its existing no_transport_inject_id HOLD, which is
 * the honest answer. A guessed id would send the tracker to poll a DIFFERENT
 * dispatch's observation record.
 */
export function parseInjectId(text: string): string {
  const hex = "[0-9a-fA-F]";
  const re = new RegExp(
    `^[ \\t]*inject_id:[ \\t]+(${hex}{8}-${hex}{4}-${hex}{4}-${hex}{4}-${hex}{12})[ \\t]*$`,
  );
  const ids = new Set<string>();
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const m = re.exec(line);
    if (m) ids.add(m[1]!);
  }
  // Exactly one DISTINCT id, or none. Two different ids in one inject's output
  // is ambiguity, not a menu.
  return ids.size === 1 ? [...ids][0]! : "";
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
  worktree: string;
  verifyDelivered: boolean;
  verifyStarted: boolean;
  role: string;
  keepAlive: boolean;
  taskId: string;
  noTask: boolean;
  noTaskReason: string;
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
    cli: "claude",
    worktree: "",
    verifyDelivered: false,
    // Rule 33: confirm session actually started working post-inject.
    verifyStarted: true,
    role: "",
    keepAlive: false,
    taskId: "",
    noTask: false,
    noTaskReason: "",
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
      case "--task": o.taskId = val(a); i += 2; break;
      case "--no-task": o.noTask = true; o.noTaskReason = val(a); i += 2; break;
      case "--verify-delivered": o.verifyDelivered = true; i += 1; break;
      case "--no-verify-started": o.verifyStarted = false; i += 1; break;
      case "--keep-alive": o.keepAlive = true; i += 1; break;
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

// ── Rule 34 task-gate (#736) ────────────────────────────────────────────────
// Rule 34 requires every delegated work item to be registered in the task queue
// before dispatch. That relied on operator discipline and leaked, so the gate
// lives here — dispatch.sh is the actuation chokepoint every delegation flows
// through. It runs BEFORE any side effect so a violation can never leave a
// half-started worker behind.
const TASK_QUEUE = env.AIGENTRY_TASK_QUEUE || path.join(SCRIPT_DIR, "..", "state", "task-queue.json");
const TASK_GATE_MODE = env.AIGENTRY_TASK_GATE || "hard";
const TASK_GATE_HINT =
  'register the task in state/task-queue.json first (--task <id>), or use --no-task "<reason>" for exempt work.';

const ALLOWED_STATUS = new Set(["pending", "in_progress", "delegated", "queued", "blocked-by-observation"]);
const TERMINAL_STATUS = new Set(["done", "completed", "superseded", "cancelled", "closed"]);

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

/** The queue lookup — rc mirrors the retired python block's exit codes. */
function taskQueueStatus(taskId: string): { rc: number; status: string } {
  let data: { tasks?: unknown[]; completed?: unknown[] };
  try {
    data = JSON.parse(fs.readFileSync(TASK_QUEUE, "utf8"));
  } catch {
    return { rc: 2, status: "" };
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const task = tasks.find((t) => t && String((t as { id?: unknown }).id) === taskId) as
    | { status?: unknown }
    | undefined;
  if (task === undefined) {
    // completed[] is the archive tail — a hit there is a stale id, not an unknown one.
    const completed = Array.isArray(data.completed) ? data.completed : [];
    if (completed.some((t) => t && String((t as { id?: unknown }).id) === taskId)) {
      return { rc: 4, status: "completed" };
    }
    return { rc: 3, status: "" };
  }
  const status = String(task.status || "");
  if (ALLOWED_STATUS.has(status)) return { rc: 0, status };
  const terminal = TERMINAL_STATUS.has(status) || status.startsWith("done") || status.startsWith("completed");
  return { rc: terminal ? 4 : 5, status };
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
  const { rc, status } = taskQueueStatus(o.taskId);
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
    const task = tasks.find((t) => t && String((t as { id?: unknown }).id) === o.taskId) as
      | Record<string, unknown>
      | undefined;
    if (task === undefined) throw new Error("task row vanished");
    const now = utcNow();
    // Only promote from a not-yet-started state; in_progress must never regress.
    if (task.status === "pending" || task.status === "queued") task.status = "delegated";
    task.updated_at = utcDate(now);
    const stamp = ` | dispatched ${isoSeconds(now)} sid=${sid} ref=${path.basename(o.refFile)} track=${o.track || "-"}`;
    const note = (task.note as string) || "";
    task.note = note ? note + stamp : stamp.replace(/^[ |]+/, "");
    // Atomic: same-dir temp + rename, so a crash can never truncate the live queue.
    const dir = path.dirname(path.resolve(TASK_QUEUE));
    const tmp = path.join(dir, `.task-queue.${process.pid}.${randomBytes(3).toString("hex")}`);
    const fd = fs.openSync(tmp, "w");
    try {
      // json.dumps(data, ensure_ascii=False, indent=1) — same shape as the
      // retired python arm, so the queue file's diff stays reviewable.
      fs.writeFileSync(fd, JSON.stringify(data, null, 1));
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
    const r = capture(REPORT_TARGET_SH, []);
    if (r.status === 0) targetAddr = r.stdout.replace(/\n+$/, "");
  }
  if (!targetAddr) {
    process.stderr.write(
      `dispatch.sh: could not resolve the orchestrator report target via ${REPORT_TARGET_SH} — refusing to inject a ref with an unresolved {{ORCHESTRATOR_REPORT_TARGET}} (#690)\n`,
    );
    return false;
  }
  d.tmpRef = mkTemp("dispatch-ref");
  fs.writeFileSync(d.tmpRef, body.split("{{ORCHESTRATOR_REPORT_TARGET}}").join(targetAddr));
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
  const a = ["inject", "--ref", d.effRef, "--submit", "--submit-retry", "2"];
  if (o.fromId) a.push("--from", o.fromId);
  a.push(sid);
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(TELEPTY, a, { stdio: ["inherit", "pipe", "inherit"] });
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      process.stdout.write(chunk);
    });
    const finish = (rc: number) => {
      d.transportInjectId = parseInjectId(out);
      if (d.tmpRef) {
        try { fs.unlinkSync(d.tmpRef); } catch { /* already gone */ }
      }
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
  return registryOut(a);
}

// ── registration + readiness waits ──────────────────────────────────────────
/**
 * #727: presence wait, kept separate from waitForReady's REPL-ready wait
 * (telepty#18). Registration = "the bridge has published the session"; ready =
 * "its REPL is past the boot screen". Returns the wrapped CLI kind, or null.
 */
async function waitForRegistration(o: Opts, sid: string): Promise<string | null> {
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
  for (;;) {
    const kind = cliOf(sid);
    if (kind) return kind;
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
    await sleepMs(Math.min(deadline - now, 5000));
  }
}

/** 0 ok, 1 ready-timeout, 6 never registered. */
async function waitForReady(o: Opts, sid: string): Promise<number> {
  const cliKind = await waitForRegistration(o, sid);
  if (cliKind === null) return 6;
  let effectiveTimeout = o.timeoutMs;
  // #557: codex reaches its interactive `›` REPL within seconds, but its 6 MCP
  // servers can take >30s to finish booting. Give codex a longer default
  // ceiling (claude/gemini unchanged). An explicit --timeout-ms always wins.
  if (cliKind === "codex" && !o.timeoutExplicit) {
    effectiveTimeout = Number(env.AIGENTRY_CODEX_READY_TIMEOUT_MS || 90000);
  }
  const deadline = nowMs() + effectiveTimeout;
  for (;;) {
    if (isReady(sid, cliKind)) return 0;
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
  // #431 (ADR 2026-05-12 enforcement) — hybrid (b-2)+(c) boot wiring.
  // boot-prepare.mjs failure = stderr WARNING + legacy spawn (not silent fail).
  let bootSpawnCli = "";
  let bootSpawnCwd = "";
  // #532: boot-prepare role wiring covers claude (flag-based) + codex/gemini
  // (additive cwd context file + config-home shadow).
  const bootEligible = o.cli === "claude" || o.cli === "codex" || o.cli === "gemini";
  if (bootEligible && o.role) {
    const bootPrepare = path.join(SCRIPT_DIR, "boot-prepare.mjs");
    if (isExecutable(bootPrepare)) {
      const r = captureOut("node", [bootPrepare, "--role", o.role, "--cwd", o.cwd, "--sid", sid, "--cli", o.cli]);
      let parsed: { spawn_cli?: unknown; spawn_cwd?: unknown } | null = null;
      if (r.status === 0 && r.stdout) {
        try {
          parsed = JSON.parse(r.stdout);
        } catch {
          parsed = null;
        }
      }
      if (parsed && parsed.spawn_cli !== undefined && parsed.spawn_cwd !== undefined) {
        bootSpawnCli = String(parsed.spawn_cli);
        bootSpawnCwd = String(parsed.spawn_cwd);
      } else {
        process.stderr.write(
          `dispatch.sh: WARNING boot-prepare.mjs failed (exit ${r.status}) for sid=${sid} role=${o.role}\n`,
        );
        process.stderr.write(
          "dispatch.sh: WARNING falling back to legacy open-session.sh path; cwd CLAUDE.md auto-load risk active (#431)\n",
        );
      }
    } else {
      process.stderr.write(
        `dispatch.sh: WARNING boot-prepare.mjs not executable at ${SCRIPT_DIR}; legacy path active (#431)\n`,
      );
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
    launcher = writeWorkerLauncher(sid, o.cli, bootSpawnCli, "", workerHooksDir);
    spawnCwd = bootSpawnCwd;
  } else {
    // The dispatch-owned launcher is the CLI so codex/claude/gemini all receive
    // AIGENTRY_WORKER_SESSION + Git env-config without editing open-session.sh.
    launcher = writeWorkerLauncher(sid, o.cli, o.cli, defaultCliFlags(o.cli), workerHooksDir);
    spawnCwd = o.cwd;
  }
  // Empty --extra-flags so open-session.sh's claude-default flags do NOT apply
  // (we control the full argv via the launcher).
  const r = spawnSync(
    OPEN_SESSION_SH,
    ["--track", o.track, "--name", o.name, "--cwd", spawnCwd, "--cli", launcher, "--extra-flags", " "],
    { stdio: ["inherit", "ignore", "inherit"] },
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

  taskGateCheck(o);

  let sid: string;
  if (o.spawn) {
    if (!o.track || !o.name || !o.cwd) {
      die("dispatch.sh: --track --name --cwd required for --spawn-and-dispatch", 4);
    }
    sid = `${o.track}-${o.name}`;
  } else if (o.target) {
    sid = o.target;
  } else {
    die("dispatch.sh: --target or --spawn-and-dispatch required", 4);
  }

  const d: Delivery = { refHash: "", effRef: "", tmpRef: "", transportInjectId: "" };

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

  if (!skipPreparation && o.spawn) spawnWorkspace(o, sid);

  emitTelemetry([
    "--helper", "dispatch",
    "--subtype", "dispatch_start",
    "--payload-json",
    JSON.stringify({
      target_sid: sid,
      mode: o.spawn ? "spawn-and-dispatch" : "target",
      cli: o.cli,
      role: o.role,
    }),
    "--correlation-id", sid,
  ]);

  if (!skipPreparation) {
    // #727: a registration/readiness timeout leaves nothing behind but the
    // workspace itself. No dedup mark is written any more, so the operator's
    // retry with the same ref reaches the delivery transaction.
    const rc = await waitForReady(o, sid);
    if (rc !== 0) process.exit(rc);
    if (!prepareEffectiveRef(o, d)) process.exit(3);
  }

  // Nothing fallible may run between this commit and the inject: a crash in
  // that window is conservatively delivery-unknown.
  const begin = beginDelivery(o, d, sid);
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
    // __probe is-ready <sid> <cli>
    process.exit(isReady(argv[1] ?? "", argv[2] ?? "") ? 0 : 1);
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
    const d: Delivery = { refHash: "", effRef: "", tmpRef: "", transportInjectId: "" };
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
