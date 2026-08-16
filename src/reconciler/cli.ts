// session-reconciler.sh's implementation, ported to TypeScript (#899 tranche 2c).
//
// This is a PORT, not a redesign (Rule 29 + Constitution Art. 1): every flag, exit
// code, log line, alert line and subprocess argv is the shell script's, preserved
// deliberately. bin/session-reconciler.sh is now an exec shim onto this file, so the
// launchd agent `com.aigentry.reconciler` (`/bin/bash …/session-reconciler.sh --loop`,
// KeepAlive) and the systemd unit are unchanged. The behavioural documentation lives
// in ./usage.ts (what --help prints) and in the shell script's git history.
//
// THE THREE LIBS THIS SCRIPT USED TO SOURCE, and what each became — no
// re-implementation anywhere, because every one of them is a rule that decides
// whether an absence may authorize destruction:
//
//   lib/workspace-host.sh   → bin/wh-cli.sh (#899 pre-tranche-2). wh_lookup /
//     wh_close / wh_alive / wh_focus / wh_prune_orphans / wh_set_status are reached
//     as the subprocess door built for exactly this, with the SAME exit codes and
//     the SAME stdout (tests/dispatch/T104 pins CLI == sourced function). The lib
//     itself is untouched and stays bash: it is #899's last item by design.
//   lib/telepty-listing.sh  → `bash -c '. <lib>; <fn> "$2"'`, the idiom
//     src/cleanup/cli.ts and src/tracker/cli.ts already use. The #835
//     corroborated-listing verdict and telepty_sid_live's THREE-VALUED answer
//     (0 live / 1 absent-and-trustworthy / 2 UNKNOWN) stay in one place. A TS copy
//     would be free to drift from the one src/cleanup/cli.ts calls.
//   lib/platform.sh         → same door, for platform::host_power_state,
//     platform::lid_closed and platform::session_pid. Rule 26: the OS primitive
//     lives in the platform lib. #909 moved the ps/awk of parent_pid_for_sid INTO
//     that lib precisely so open-session.sh's sleep assertion and this sweep resolve
//     the same pid; re-inlining it in TS would restore the drift that removed.
//
// NO `process.platform` BRANCH EXISTS HERE, because the shell had no OS arm.
// Enumerated candidates and where each actually lives: host power (pmset) →
// platform.sh; lid state (ioreg / /proc/acpi/button/lid) → platform.sh; the session
// pid walk (`ps -eo pid,command`, one column set on BSD and GNU) → platform.sh;
// `kill -0` → POSIX; launchd vs systemd → outside this file entirely.
//
// PATH HARDENING AND THE HOME RECOVERY STAY IN THE SHIM, in bash. They must apply
// to this process AND to every child it spawns, the shim is what launchd executes,
// and tests/workspace-host/prune-status.sh greps bin/session-reconciler.sh for the
// `HOME:=` idiom. See that file's header.
//
// THE ONE SEAM THAT CHANGED SHAPE (Rule 38): wh_prune_orphans reads `$DRY_RUN`
// (bin/lib/workspace-host.sh:209). The shell passed it as a plain shell variable of
// the same process; across the wh-cli.sh process boundary it has to be EXPORTED
// into the child's environment, and only into that child's (nothing else under bin/
// reads DRY_RUN from the environment — bin/orchestrator-bridge-auditor.sh:54 sets
// its own). Getting this wrong is silent and destructive: an operator's --dry-run
// would close real cmux workspaces. tests/dispatch/T112 pins it.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` — the repo's (or
// the init workspace's) bin/. The shim exports it so a symlinked entrypoint still
// locates bin/ helpers; the fallback keeps a direct
// `node dist/src/reconciler/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = env.DISPATCH_STATE_DIR || path.join(REPO_DIR, "state/dispatch");
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY || path.join(SCRIPT_DIR, "dispatch-registry.py");
const BACKOFF_JSON = path.join(STATE_DIR, "reconciler-backoff.json");
const RECONCILER_LOG = path.join(STATE_DIR, "reconciler.log");
// cmux orphan-prune seen-twice ledger (SPEC §2.2). Exported so the workspace-host
// adapter persists it under dispatch state rather than the /tmp default. It was
// `export` in the shell and it is an export here for the same reason: the reader is
// bin/lib/workspace-host.sh, now one process boundary away.
env.AIGENTRY_CMUX_ORPHAN_LEDGER =
  env.AIGENTRY_CMUX_ORPHAN_LEDGER || path.join(STATE_DIR, "cmux-orphan-ledger.json");
const SCHEDULER_SH = env.SCHEDULER_SH || path.join(SCRIPT_DIR, "dispatch-cleanup-scheduler.sh");
const CLEANUP_SH = env.CLEANUP_SH || path.join(SCRIPT_DIR, "session-cleanup.sh");
const DISPATCH_SH = env.DISPATCH_SH || path.join(SCRIPT_DIR, "dispatch.sh");
const TRACKER_SH = env.TRACKER_SH || path.join(SCRIPT_DIR, "dispatch-tracker.sh");
const COMMS_AUDITOR_SH = env.COMMS_AUDITOR_SH || path.join(SCRIPT_DIR, "session-comms-auditor.sh");
const BRIDGE_AUDITOR_SH = env.BRIDGE_AUDITOR_SH || path.join(SCRIPT_DIR, "orchestrator-bridge-auditor.sh");
const BUS_BRIDGE_SH = env.BUS_BRIDGE_SH || path.join(SCRIPT_DIR, "telepty-bus-bridge.sh");
const SESSION_PROBE_PY = env.SESSION_PROBE_PY || path.join(SCRIPT_DIR, "session-probe.py");
const POLICY_PY = env.POLICY_PY || path.join(SCRIPT_DIR, "policy.py");
// hitl.sh is #899 tranche 2d, NOT this one. It stays a subprocess behind its `-x`
// gate; its ADR amendment (#925) is still open and both callers must keep gating.
const HITL_SH = env.HITL_SH || path.join(SCRIPT_DIR, "hitl.sh");
const HITL_PENDING_DIR = path.join(env.HITL_STATE_DIR || path.join(REPO_DIR, "state/hitl"), "pending");
const TELEPTY = env.TELEPTY || "telepty";
const NOW_OVERRIDE = env.RECONCILER_NOW || "";
const SHADOW_LOG = env.RECONCILE_SHADOW_LOG || path.join(STATE_DIR, "reconcile-shadow.jsonl");
const ESCALATION_LOG = path.join(STATE_DIR, "verify-escalations.jsonl");
const ALERTS_LOG = path.join(STATE_DIR, "alerts.log");
// A literal, exactly as the shell's `PROTECTED_SIDS=(orchestrator)` was: overriding
// ORCHESTRATOR_SID moves the #905 stale check and the RESUME sender, but it has
// never moved which sid is unsweepable.
const PROTECTED_SIDS = ["orchestrator"];
// Hoisted from step 2a (#909): the RESUME actuator in the registry loop sends as the
// orchestrator, and that loop runs long before step 2a used to define this.
const ORCH_SID = env.ORCHESTRATOR_SID || "orchestrator";
const AGE_FLOOR_SECONDS = env.RECONCILER_AGE_FLOOR || "300";
const DISCONNECT_FLOOR_SECONDS = env.RECONCILER_DISCONNECT_FLOOR || "240";
const BACKOFF_INITIAL = env.RECONCILER_BACKOFF_INITIAL || "5";
const BACKOFF_MAX = env.RECONCILER_BACKOFF_MAX || "1000";
const SURFACE_ORPHANED_SRC = env.AIGENTRY_SURFACE_ORPHANED_SOURCE || path.join(STATE_DIR, "surface-orphaned.jsonl");
const SURFACE_MISMATCHED_SRC =
  env.AIGENTRY_SURFACE_MISMATCHED_SOURCE || path.join(STATE_DIR, "surface-mismatched.jsonl");
const RESUME_MARKER = env.AIGENTRY_SLEEP_RESUME_MARKER || path.join(STATE_DIR, "sleep-resume.json");
const RESUME_MAX_PER_HOUR = env.RECONCILER_RESUME_MAX_PER_HOUR || "3";
const SLEEP_QUEUE = env.AIGENTRY_SLEEP_TELEMETRY_QUEUE || path.join(STATE_DIR, "sleep-telemetry-queue.log");
const LID_LATCH = path.join(STATE_DIR, "lid-closed.latch");
const SLEEP_DIGEST_MAX_LINES = env.RECONCILER_SLEEP_DIGEST_MAX_LINES || "10";

const WH_CLI = path.join(SCRIPT_DIR, "wh-cli.sh");
const PLATFORM_SH = path.join(SCRIPT_DIR, "lib/platform.sh");
const TELEPTY_LISTING_SH = path.join(SCRIPT_DIR, "lib/telepty-listing.sh");

fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(BACKOFF_JSON)) fs.writeFileSync(BACKOFF_JSON, "{}\n");

// ── small process helpers ───────────────────────────────────────────────────
/** bash `$(cmd)`: command substitution strips every trailing newline. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

interface RunOpts {
  stdin?: string;
  /** stdout: "pipe" captures it, "ignore" is `>/dev/null`, "inherit" leaves it alone. */
  out?: "pipe" | "ignore" | "inherit";
  /** stderr: "ignore" is `2>/dev/null`, "inherit" is the shell default. */
  err?: "ignore" | "inherit";
  env?: NodeJS.ProcessEnv;
}

/** One spawn helper; each call site's redirections are the shell line's, verbatim. */
function run(cmd: string, args: string[], opts: RunOpts = {}): { status: number; stdout: string } {
  const stdin = opts.stdin === undefined ? "ignore" : "pipe";
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.stdin,
    stdio: [stdin, opts.out ?? "pipe", opts.err ?? "inherit"],
    env: opts.env ?? env,
  });
  // bash prints "command not found"/"Permission denied" and yields 127/126; the
  // callers all treat any non-zero the same way, so one code is enough.
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** `cmd >/dev/null 2>&1` — status only. */
function runQuiet(cmd: string, args: string[], childEnv?: NodeJS.ProcessEnv): number {
  return run(cmd, args, { out: "ignore", err: "ignore", ...(childEnv ? { env: childEnv } : {}) }).status;
}

/** `[ -x <path> ]` for a regular file. */
function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `command -v <cmd>`: an absolute/relative path is tested directly, a bare name on PATH. */
function commandExists(cmd: string): boolean {
  if (cmd.includes("/")) return executable(cmd);
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (dir && executable(path.join(dir, cmd))) return true;
  }
  return false;
}

/** `sleep <seconds>` — everything here is synchronous (spawnSync), so the wait is too. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * bash `IFS=$'\t' read -r a b c …`. TAB is IFS *whitespace*, so runs of tabs
 * collapse into ONE delimiter, leading/trailing tabs are stripped, and the LAST
 * variable absorbs the unsplit remainder with its delimiters intact. Measured, not
 * assumed: an empty middle field therefore shifts every later field left, and the
 * sweep's candidate list (which interpolates possibly-empty startedAt/health/
 * lastSeenAt) can produce one. Reproduced rather than "fixed" — the registry avoids
 * it by rendering absence as the literal "null" (dispatch-registry.py:render_cell),
 * and changing the reader would change which sessions this tick sweeps.
 */
function readTabFields(line: string, n: number): string[] {
  let rest = line.replace(/^\t+/, "").replace(/\t+$/, "");
  const out: string[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const idx = rest.indexOf("\t");
    if (idx < 0) {
      out.push(rest);
      rest = "";
      continue;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx).replace(/^\t+/, "");
  }
  out.push(rest);
  return out;
}

/**
 * bash `while read … done < file`: a final line with no terminating newline is
 * NOT yielded (read returns non-zero and the loop body never runs for it).
 */
function readLines(content: string): string[] {
  const parts = content.split("\n");
  parts.pop();
  return parts;
}

/** bash `done <<< "$var"`: a here-string always appends one newline, so "" yields ONE empty line. */
function hereStringLines(content: string): string[] {
  return readLines(content + "\n");
}

/** `case ",$csv," in *",$needle,"*)` — literal substring membership on a CSV. */
function csvHas(csv: string, needle: string): boolean {
  return `,${csv},`.includes(`,${needle},`);
}

/** `sort -u` over lines, then `tr '\n' ',' | sed 's/,$//'`. Byte order (LC_ALL=C), which is what the ASCII sids here produce either way. */
function sortUniqCsv(lines: string[]): string {
  const seen = [...new Set(lines.filter((l) => l !== ""))];
  seen.sort();
  return seen.join(",");
}

// ── Python-compatible JSON rendering ────────────────────────────────────────
/**
 * `json.dumps(..., ensure_ascii=False)`. Python's default separators are
 * `(', ', ': ')`, not JSON.stringify's `(',', ':')`, and `sort_keys=True` sorts
 * EVERY dict recursively. The shadow JSONL, the escalation JSONL and the two ledger
 * files are all read back by python and by operators, so the bytes are reproduced
 * rather than approximated.
 */
function pyJson(value: unknown, opts: { sort?: boolean; indent?: number; compact?: boolean } = {}): string {
  const compact = opts.compact === true;
  const indent = opts.indent;
  const keySep = compact ? ":" : ": ";
  const flatItemSep = compact ? "," : ", ";
  const enc = (x: unknown, depth: number): string => {
    if (x === null || x === undefined) return "null";
    if (typeof x === "string") return JSON.stringify(x);
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") return String(x);
    const pad = indent === undefined ? "" : "\n" + " ".repeat(indent * (depth + 1));
    const closePad = indent === undefined ? "" : "\n" + " ".repeat(indent * depth);
    const sep = indent === undefined ? flatItemSep : "," + pad;
    if (Array.isArray(x)) {
      if (x.length === 0) return "[]";
      return "[" + pad + x.map((v) => enc(v, depth + 1)).join(sep) + closePad + "]";
    }
    const obj = x as Record<string, unknown>;
    let keys = Object.keys(obj);
    if (opts.sort) keys = keys.sort();
    if (keys.length === 0) return "{}";
    return (
      "{" + pad + keys.map((k) => JSON.stringify(k) + keySep + enc(obj[k], depth + 1)).join(sep) + closePad + "}"
    );
  };
  return enc(value, 0);
}

/** `json.loads(x or "{}")` with the caller's fallback on failure — python's semantics, including "" ⇒ {}. */
function pyLoads(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return fallback;
  }
}

/**
 * `datetime.fromisoformat(s.replace("Z","+00:00"))` followed by arithmetic against
 * an aware `now`: a timestamp with no offset parses in python but raises on the
 * subtraction, and every call site catches that and falls back. Requiring an offset
 * here reproduces that outcome, and it also avoids JS's very different rule for a
 * bare `2026-08-16T12:00:00` (parsed as LOCAL time, which would silently shift
 * every age by the host's UTC offset).
 */
function parseIso(s: string): Date | null {
  if (!s) return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── clock, logs, atomic write ───────────────────────────────────────────────
function nowIso(): string {
  if (NOW_OVERRIDE) return NOW_OVERRIDE;
  // `isoformat(timespec="seconds")` + the "+00:00"→"Z" swap: no fractional part.
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** `printf … | tee -a <file> >&2` — the line lands in the log file AND on stderr. */
function teeLine(file: string, line: string): void {
  try {
    fs.appendFileSync(file, line);
  } catch {
    /* tee's own failure never silenced the stderr copy, and must not silence it here */
  }
  process.stderr.write(line);
}

function log(msg: string): void {
  teeLine(RECONCILER_LOG, `${nowIso()} ${msg}\n`);
}

function emitAlert(line: string): void {
  teeLine(ALERTS_LOG, `${nowIso()} ${line}\n`);
}

/** atomic_write_json <path> — tmp + mv. */
function atomicWriteJson(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}.${Math.floor(Math.random() * 1e6)}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function appendFile(file: string, content: string): void {
  fs.appendFileSync(file, content);
}

// ── the lib seams ───────────────────────────────────────────────────────────
/** A wh-cli.sh verb: 1:1 with the shell function this script used to source. */
function wh(args: string[], opts: RunOpts = {}): { status: number; stdout: string } {
  // DRY_RUN crosses the process boundary HERE and nowhere else — wh_prune_orphans
  // reads it (workspace-host.sh:209) and the shell handed it over as a same-process
  // shell variable. See this file's header.
  return run(WH_CLI, args, { ...opts, env: { ...env, DRY_RUN: String(DRY_RUN) } });
}

/** `platform::<fn>` from bin/lib/platform.sh, as a subprocess (src/tracker/cli.ts's idiom). */
function platform(fn: string, args: string[] = []): { status: number; stdout: string } {
  return run("bash", ["-c", `. "$1"; ${fn} "\${@:3}"`, "_", PLATFORM_SH, "_", ...args], { err: "inherit" });
}

/**
 * `telepty_sid_live <sid>` from bin/lib/telepty-listing.sh, as a subprocess.
 * THREE-VALUED and it stays that way: 0 live, 1 absent with a trustworthy listing,
 * 2 UNKNOWN. #835 — collapsing 2 into 1 is the same defect one layer up.
 */
function teleptySidLive(sid: string): number {
  return run("bash", ["-c", '. "$1"; telepty_sid_live "$2"', "_", TELEPTY_LISTING_SH, sid], {
    out: "ignore",
    err: "inherit",
  }).status;
}

/**
 * `telepty_listing_trusted <raw>`: 0 when <raw> may be used as evidence that a
 * session is ABSENT, 1 with the disqualifying verdict on stdout when it may not.
 * Only the EMPTY array pays for the corroboration probe — that is the lib's rule
 * and it is deliberately not restated in TypeScript.
 */
function listingTrusted(raw: string): { trusted: boolean; verdict: string } {
  const r = run("bash", ["-c", '. "$1"; telepty_listing_trusted "$2"', "_", TELEPTY_LISTING_SH, raw], {
    err: "inherit",
  });
  return { trusted: r.status === 0, verdict: chomp(r.stdout) };
}

// ── registry (telepty#60 Stage A: every access is a typed call) ─────────────
function registry(args: string[], opts: RunOpts = {}): { status: number; stdout: string } {
  return run(DISPATCH_REGISTRY_PY, args, opts);
}

function registrySetLifecycle(sid: string, state: string): void {
  if (!state) return;
  registry(["set-lifecycle", "--sid", sid, "--state", state, "--now", nowIso()], { out: "ignore" });
}

// ── shadow / escalation records ─────────────────────────────────────────────
const SHADOW_STATE_FALLBACK = {
  alive: false,
  ready: false,
  surface: "unknown",
  activity: "static",
  cli: "unknown",
  detail: { probe_error: "shadow state JSON parse failed" },
};

function appendShadowRecord(sid: string, status: string, stateJson: string, actionJson: string): void {
  const record = {
    ts: nowIso(),
    sid,
    status,
    state: pyLoads(stateJson, SHADOW_STATE_FALLBACK),
    action: pyLoads(actionJson, { action: "ESCALATE", reason: "shadow action JSON parse failed", status }),
  };
  appendFile(SHADOW_LOG, pyJson(record, { sort: true }) + "\n");
}

/**
 * `cur.get(part, "")` down a dotted path; anything that is not a dict on the way
 * short-circuits to "". Used only for the policy verdict's string fields
 * (action/key/status/reason), which is why String() is a faithful `print`.
 */
function jsonGet(jsonText: string, expr: string): string {
  let cur: unknown = pyLoads(jsonText, {});
  for (const part of expr.split(".")) {
    if (!part) continue;
    if (cur !== null && typeof cur === "object" && !Array.isArray(cur)) {
      const next = (cur as Record<string, unknown>)[part];
      cur = next === undefined ? "" : next;
    } else {
      cur = "";
      break;
    }
  }
  return cur === null || cur === undefined ? "" : String(cur);
}

function emitEscalation(sid: string, actionJson: string): void {
  const action = pyLoads(actionJson, { action: "ESCALATE", reason: "action JSON parse failed" });
  let detail: unknown = "reconciler escalation";
  if (action !== null && typeof action === "object" && !Array.isArray(action)) {
    const rec = action as Record<string, unknown>;
    if ("reason" in rec) detail = rec.reason;
  }
  appendFile(ESCALATION_LOG, pyJson({ sid, ts: nowIso(), rc: 6, detail }) + "\n");
}

// ── policy + probe ──────────────────────────────────────────────────────────
function policyDecide(status: string, stateJson: string): string {
  const r = run(POLICY_PY, ["--status", status, "--state", "-"], { stdin: stateJson + "\n", err: "ignore" });
  if (r.status !== 0) {
    return `{"action":"ESCALATE","reason":"policy failed","status":"${status}"}`;
  }
  return chomp(r.stdout);
}

const PROBE_FALLBACK =
  '{"alive":false,"ready":false,"surface":"unknown","activity":"static","cli":"unknown","detail":{"probe_error":"session-probe failed"}}';

function probeSession(sid: string): string {
  const r = run(SESSION_PROBE_PY, ["--sid", sid], { err: "ignore", env: { ...env, TELEPTY } });
  const state = chomp(r.stdout);
  return state === "" ? PROBE_FALLBACK : state;
}

// ── the HITL gate wrapper ───────────────────────────────────────────────────
/**
 * hitl_open <hitl.sh open args…> — open a gate, alerting (never aborting the tick)
 * if the CLI is missing or fails. The gate's own file-before-notify design is what
 * makes this safe to call from a level-triggered loop.
 *
 * #836 — every gate this loop opens names a subject session and offers the operator
 * an action ON that session. The subjects come from the DISPATCH registry, which
 * outlives the session: a record whose session was cleaned up still reaches here,
 * and the gate then asks a question nobody can answer.
 *
 * UNKNOWN liveness is NOT absence (#835): when the listing was refused or the
 * daemon did not answer, telepty_sid_live returns 2 and the gate OPENS. Suppressing
 * an escalation on an untrustworthy absence would be the same defect one layer up —
 * and unlike a surface close, a spurious gate destroys nothing.
 */
function hitlOpen(args: string[]): void {
  let subject = "";
  let wantSubject = false;
  for (const arg of args) {
    if (wantSubject) {
      subject = arg;
      wantSubject = false;
      continue;
    }
    if (arg === "--subject-sid") wantSubject = true;
  }
  if (subject) {
    if (teleptySidLive(subject) === 1) {
      emitAlert(
        `HITL_GATE_STALE subject-sid=${subject} is not in the live session registry — gate NOT opened (it would ask the operator to act on a session that no longer exists); args: ${args.join(" ")}`,
      );
      return;
    }
  }
  if (!executable(HITL_SH)) {
    emitAlert(`HITL_GATE_UNAVAILABLE ${HITL_SH} not executable — args: ${args.join(" ")}`);
    return;
  }
  if (runQuiet(HITL_SH, ["open", ...args]) !== 0) emitAlert(`HITL_GATE_OPEN_FAILED args: ${args.join(" ")}`);
}

// ── re-dispatch ─────────────────────────────────────────────────────────────
function maybeRedispatch(sid: string, refPath: string, rdcRaw: string): void {
  const rdc = Math.trunc(Number(rdcRaw || "0")) || 0;
  if (rdc >= 1) {
    // ADR 2026-07-26-hitl-gate-primitive producer (a): this line said "user gate
    // required" since 2026-06 — now the gate exists. Idempotent on gate-id, so a
    // 60s level-triggered tick opens it once and never re-notifies.
    // approve ⇒ re_dispatch_count=0 (next tick re-dispatches); reject ⇒ stuck_error.
    hitlOpen([
      "--source", "reconciler", "--subject-sid", sid, "--kind", "decision",
      "--resume", "registry-clear-redispatch",
      "--question", `re-dispatch cap reached (count=${rdc}) for ${sid}`,
      "--options", "approve=re-dispatch once more,reject=mark stuck_error",
      "--context-ref", refPath,
    ]);
    return;
  }
  if (!refPath || !fs.existsSync(refPath) || !fs.statSync(refPath).isFile()) {
    emitAlert(`REDISPATCH_FAILED sid=${sid} ref_missing=${refPath}`);
    return;
  }
  // Rule 34 task-gate (#736): same as the tracker's path — a re-dispatch replays
  // an already-registered task, so it takes the audited exemption.
  //
  // Only exit 0 means a new transport write happened. 8 (deduplicated) and 7
  // (delivery unknown) are "no new delivery", and advancing the counter on either
  // records an attempt that never occurred. The alert reports the outcome of the
  // call rather than the intention to make it.
  const rc = runQuiet(DISPATCH_SH, [
    "--target", sid, "--ref", refPath, "--verify-delivered", "--no-task", `reconciler-redispatch ${sid}`,
  ]);
  switch (rc) {
    case 0:
      registry(
        ["set-lifecycle", "--sid", sid, "--state", "re_dispatched", "--bump-re-dispatch-count",
         "--extend-minutes", "30", "--now", nowIso()],
        { out: "ignore" },
      );
      emitAlert(`REDISPATCH_OK sid=${sid} attempt=${rdc + 1} ref=${refPath}`);
      break;
    case 8:
      registry(
        ["observe", "--sid", sid, "--kind", "redispatch_suppressed_duplicate",
         "--field", `ref_path=${refPath}`, "--now", nowIso()],
        { out: "ignore" },
      );
      emitAlert(`REDISPATCH_SUPPRESSED sid=${sid} — identical ref already delivered; no new delivery`);
      // Without this the suppression would only ever repeat a HOLD: the counter
      // never reaches the cap, so the one-shot operator gate above is unreachable.
      hitlOpen([
        "--source", "reconciler", "--subject-sid", sid, "--kind", "decision",
        "--resume", "registry-clear-redispatch",
        "--question", `duplicate suppressed: ${sid} is already holding an identical delivered ref`,
        "--options", "approve=re-dispatch once more,reject=hand back to the operator",
        "--context-ref", refPath,
      ]);
      break;
    case 7:
      registry(
        ["observe", "--sid", sid, "--kind", "redispatch_held_delivery_unknown",
         "--field", `ref_path=${refPath}`, "--now", nowIso()],
        { out: "ignore" },
      );
      emitAlert(`REDISPATCH_HELD sid=${sid} — a prior attempt's delivery is unknown; not replayed`);
      break;
    default:
      emitAlert(`REDISPATCH_FAILED sid=${sid} rc=${rc}`);
  }
}

// --- #909 item (c): auto-RESUME a turn the host's sleep cut -------------------
//
// On 2026-08-16 three worker turns died to `API Error: Your computer went to sleep
// mid-response`, and each recovery was a human noticing telemetry silence and
// injecting RESUME by hand. The remedy needs no operator judgement, so this loop
// does it. Rule 30 bounds the autonomy at the actuator rather than trusting the
// classifier:
//
//   * LATCH — one RESUME per OCCURRENCE, not per tick. The latch is set before the
//     inject and cleared only by a later tick observing this sid on some OTHER
//     surface, i.e. by evidence the cut is over. A screen-hash was the obvious key
//     and is the wrong one: the RESUME text itself lands on the screen.
//   * RATE CAP — at most N per sid per rolling hour (default 3) even across
//     distinct occurrences.
//
// The inject is `--from $ORCH_SID` deliberately: a reconciler-named sender would be
// a non-orch↔non-orch peer inject, which session-comms-auditor.sh classifies
// out-of-policy and HOLDs to the orchestrator — one operator page per recovery.

interface ResumeRec {
  latched?: boolean;
  sent?: unknown;
}

/** resume_ledger <sid> <op> — op=claim prints SEND/SKIP_*, op=clear releases a latch. */
function resumeLedger(sid: string, op: "claim" | "clear"): string {
  const nowStr = nowIso();
  const now = parseIso(nowStr) ?? new Date();
  const cap = Number.parseInt(RESUME_MAX_PER_HOUR, 10) || 0;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(RESUME_MARKER, "utf8"));
    data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    data = {};
  }
  const raw = data[sid];
  const rec: ResumeRec =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as ResumeRec) : {};

  const fresh = (stamps: unknown): string[] => {
    const out: string[] = [];
    for (const ts of Array.isArray(stamps) ? stamps : []) {
      const at = parseIso(String(ts));
      if (!at) continue;
      const age = (now.getTime() - at.getTime()) / 1000;
      if (age >= 0 && age < 3600) out.push(String(ts));
    }
    return out;
  };

  const save = (): void => {
    const tmp = `${RESUME_MARKER}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, pyJson(data, { sort: true, indent: 2 }));
    fs.renameSync(tmp, RESUME_MARKER);
  };

  const sent = fresh(rec.sent);
  if (op === "clear") {
    // Only the latch is released. The hourly send log survives, or "resumed once,
    // cut again, resumed again…" would reset the cap on every bounce and the cap
    // would bound nothing.
    const unchanged = Array.isArray(rec.sent) && rec.sent.length === sent.length &&
      (rec.sent as unknown[]).every((v, i) => String(v) === sent[i]);
    if (rec.latched || !unchanged) {
      data[sid] = { latched: false, sent };
      save();
    }
    return "CLEARED";
  }
  if (rec.latched) return "SKIP_LATCHED";
  if (cap > 0 && sent.length >= cap) return `SKIP_RATE_CAP ${sent.length}`;
  sent.push(nowStr);
  data[sid] = { latched: true, sent };
  save();
  return `SEND ${sent.length}`;
}

/** resume_latch_clear <sid> — cheap no-op unless this sid has a ledger entry. */
function resumeLatchClear(sid: string): void {
  let body: string;
  try {
    body = fs.readFileSync(RESUME_MARKER, "utf8");
  } catch {
    return;
  }
  if (!body.includes(`"${sid}"`)) return;
  resumeLedger(sid, "clear");
}

const RESUME_MSG =
  "RESUME: your last turn was cut mid-response by host sleep (`API Error: Your computer went to sleep mid-response`) — nothing is wrong with the task. Re-read your dispatch ref, check what you already committed, and continue from there. Commit at every phase boundary so the next cut costs at most one phase.";

function resumeWorker(sid: string): void {
  const verdict = resumeLedger(sid, "claim");
  if (verdict.startsWith("SEND")) {
    if (
      !commandExists(TELEPTY) ||
      runQuiet(TELEPTY, ["inject", "--submit-force", "--from", ORCH_SID, sid, RESUME_MSG]) !== 0
    ) {
      emitAlert(
        `SLEEP_RESUME_FAILED sid=${sid} — inject did not go through; the worker is still holding a cut turn`,
      );
      return;
    }
    emitAlert(
      `SLEEP_RESUME sid=${sid} — host slept mid-response; one RESUME sent (${verdict.replace(/^SEND /, "")} in the last hour, cap ${RESUME_MAX_PER_HOUR})`,
    );
    return;
  }
  if (verdict === "SKIP_LATCHED") {
    log(`SLEEP_RESUME skip sid=${sid} — RESUME already sent for this occurrence (latched until the surface changes)`);
    return;
  }
  if (verdict.startsWith("SKIP_RATE_CAP")) {
    emitAlert(
      `SLEEP_RESUME_CAPPED sid=${sid} — ${verdict.replace(/^SKIP_RATE_CAP /, "")} RESUME(s) in the last hour reached the cap of ${RESUME_MAX_PER_HOUR}; not resending. The session is not coming back from a RESUME and needs a human.`,
    );
    return;
  }
  emitAlert(`SLEEP_RESUME_LEDGER_FAILED sid=${sid} verdict=${verdict || "<empty>"} — no RESUME sent`);
}

// ── the actuator ────────────────────────────────────────────────────────────
function applyAction(sid: string, status: string, refPath: string, rdc: string, actionJson: string): void {
  const act = jsonGet(actionJson, "action");
  const key = jsonGet(actionJson, "key");
  const nextStatus = jsonGet(actionJson, "status");
  switch (act) {
    case "NOOP":
      // Proper if-guard: the prior `[ ] && [ ] && cmd` chain returned 1 whenever
      // next_status == status (a no-op is the common case), which under the
      // caller's `set -euo pipefail` aborted the whole tick.
      if (nextStatus && nextStatus !== status) registrySetLifecycle(sid, nextStatus);
      break;
    case "RESUBMIT_ENTER":
    case "SEND_KEY": {
      const k = key || "enter";
      if (runQuiet(TELEPTY, ["send-key", sid, k]) !== 0) emitAlert(`SEND_KEY_FAILED sid=${sid} key=${k}`);
      break;
    }
    case "REDISPATCH":
      maybeRedispatch(sid, refPath, rdc);
      break;
    case "RESUME":
      resumeWorker(sid);
      break;
    case "AWAIT_USER":
      // ADR 2026-07-26-hitl-gate-primitive producer (b): policy.py returns this for
      // surface=error only — the 3.3% of escalations whose own text asks for an
      // operator. The gate owns the status (awaiting_user, prev stashed for resume),
      // so no lifecycle write here; the escalation line is still written so the
      // audit trail is unchanged.
      hitlOpen([
        "--source", "reconciler", "--subject-sid", sid, "--kind", "decision", "--resume", "none",
        "--question", `${sid}: ${jsonGet(actionJson, "reason")}`,
        "--options", "approve=resume the session as-is,reject=hand back to the operator",
        "--context-ref", refPath,
      ]);
      emitEscalation(sid, actionJson);
      break;
    case "RESPAWN":
      registrySetLifecycle(sid, nextStatus || "respawn_requested");
      emitAlert(`RESPAWN_REQUESTED sid=${sid} — spawn metadata unavailable; escalated`);
      emitEscalation(sid, actionJson);
      break;
    case "CLEANUP":
      if (runQuiet(CLEANUP_SH, [sid]) === 0) {
        log(`CLEANUP ok sid=${sid}`);
        backoffReset(sid);
      } else {
        log(`CLEANUP fail sid=${sid} — backoff`);
        backoffRecordFailure(sid);
      }
      break;
    default: // ESCALATE|*
      if (nextStatus && nextStatus !== status) registrySetLifecycle(sid, nextStatus);
      emitEscalation(sid, actionJson);
  }
}

// --- #909 item (d): sleep-aware telemetry gate + closed-lid page ---------------
//
// The gate itself lives in dispatch-tracker.sh, the only orchestrator-side forwarder
// of idle-worker telemetry. This half is the two things only a level-triggered tick
// can do: notice the host woke up and hand over what was withheld, and notice that
// the lid is shut with workers still running.

let hostPowerStateMemo = "";
/** Memoised for this tick, then exported so the tracker child inherits it instead of paying for a second ~1.2s pmset. */
function hostPowerState(): string {
  if (!hostPowerStateMemo) hostPowerStateMemo = chomp(platform("platform::host_power_state").stdout);
  return hostPowerStateMemo;
}

/**
 * deliver_sleep_digest — ONE inject for everything withheld while asleep, on the
 * first tick that sees the host awake. Delivery is the point: the tracker's
 * seen-ledger records a note as raised BEFORE it is sent, so a withheld note is
 * never re-raised and this digest is its only chance to reach a human.
 */
function deliverSleepDigest(): void {
  let queue: string;
  try {
    queue = fs.readFileSync(SLEEP_QUEUE, "utf8");
  } catch {
    return;
  }
  if (queue === "") return; // `[ -s ]`
  if (hostPowerState() === "asleep") return;
  const maxLines = Number.parseInt(SLEEP_DIGEST_MAX_LINES, 10) || 0;
  const total = (queue.match(/\n/g) || []).length; // `wc -l` counts NEWLINES
  const lines = readLines(queue);
  const field1 = (l: string | undefined): string => (l === undefined ? "" : l.split("\t")[0] ?? "");
  const first = field1(lines[0]);
  const last = field1(lines[lines.length - 1]);
  // One line: an inject is one line, and a queued note may not smuggle a newline
  // into the orchestrator's turn. `cut -f2-` prints a delimiter-less line whole.
  let body = lines
    .slice(0, maxLines)
    .map((l) => (l.includes("\t") ? l.slice(l.indexOf("\t") + 1) : l))
    .join("|");
  if (total > maxLines) body = `${body} | …and ${total - maxLines} more (full list: ${SLEEP_QUEUE})`;
  const msg =
    `SLEEP_DIGEST: ${total} idle-worker telemetry note(s) were withheld while this host was asleep (${first} → ${last}) and are delivered here as one turn instead of ${total}. ${body}`;
  if (commandExists(TELEPTY) && runQuiet(TELEPTY, ["inject", "--submit-force", "--from", ORCH_SID, ORCH_SID, msg]) === 0) {
    fs.rmSync(SLEEP_QUEUE, { force: true });
    log(`SLEEP_DIGEST delivered notes=${total}`);
  } else {
    // The queue is NOT drained on a failed delivery — an undelivered digest is the
    // only remaining record of notes the tracker has already marked as raised.
    emitAlert(
      `SLEEP_DIGEST_UNDELIVERED notes=${total} — ${SLEEP_QUEUE} still holds them; the tracker will not re-raise these`,
    );
  }
}

/**
 * check_lid — page ONCE per closed-lid episode while workers are live. Not an
 * actuator: a closed lid is the one sleep cause no userspace assertion overrides
 * (`caffeinate -i` included), so an operator opening the lid or plugging in an
 * external display is the only fix, and the alert says exactly that.
 */
function checkLid(live: number): void {
  const rc = platform("platform::lid_closed").status;
  if (rc !== 0) {
    // Open or unknown: the episode is over (or was never established).
    if (fs.existsSync(LID_LATCH)) {
      fs.rmSync(LID_LATCH, { force: true });
      log("LID_OPEN — closed-lid page re-armed");
    }
    return;
  }
  if (!(live > 0)) return;
  if (fs.existsSync(LID_LATCH)) return;
  fs.writeFileSync(LID_LATCH, "");
  emitAlert(
    `LID_CLOSED — the lid is shut with ${live} live worker(s); they will stall on the next sleep and NO sleep assertion can prevent it (clamshell sleep beats caffeinate -i without an external display). Remedy: open the lid, or attach an external display + keyboard.`,
  );
}

// ── the observe→decide→act loop ─────────────────────────────────────────────
let LIVE_DISPATCHES = 0;

function runRegistryLoop(act: number): void {
  // Open dispatches that are not waiting on a human. A corrupt/unavailable registry
  // fails the call, and `set -e` stopped the tick before any actuation — reproduced
  // here as an exit with the registry's own status.
  const snap = registry(["list", "--live", "--fields", "assigned.sid,lifecycle.state,ref_path,re_dispatch_count"]);
  if (snap.status !== 0) process.exit(snap.status);
  let processed = 0;
  for (const line of readLines(snap.stdout)) {
    const [sidRaw, statusRaw, refRaw, rdcRaw] = readTabFields(line, 4);
    const sid = sidRaw ?? "";
    if (!sid) continue;
    const status = statusRaw ?? "";
    const refPath = refRaw === "null" ? "" : refRaw ?? "";
    const rdc = rdcRaw === "null" ? "0" : rdcRaw ?? "";
    const stateJson = probeSession(sid);
    const actionJson = policyDecide(status, stateJson);
    appendShadowRecord(sid, status, stateJson, actionJson);
    if (act === 1 && DRY_RUN === 0) {
      // #909: the RESUME latch is level-triggered — a tick that sees this sid on any
      // other surface is the evidence its sleep-cut occurrence ended, and the next
      // cut is then a new occurrence rather than a deduplicated repeat.
      if (jsonGet(actionJson, "action") !== "RESUME") resumeLatchClear(sid);
      applyAction(sid, status, refPath, rdc, actionJson);
    }
    processed += 1;
  }
  // #909: how many dispatches this tick is holding open — the "workers are live"
  // input to the closed-lid page, taken from the pass that already counted them.
  LIVE_DISPATCHES = processed;
  log(`registry tick: processed=${processed} act=${act} dry_run=${DRY_RUN}`);
}

/**
 * compute_gc_root — one sid per line for every "live" session. `awaiting_user` is
 * LIVE (ADR 2026-07-26-hitl-gate-primitive M1): a session blocked on a HITL gate
 * drops out of the registry loop and the tracker scans by design, but it must NEVER
 * be swept while it waits for the human.
 */
function computeGcRoot(): string[] {
  const out = [...PROTECTED_SIDS];
  // Everything the registry has not retired, INCLUDING gated dispatches.
  const r = registry(["list", "--not-retired", "--fields", "assigned.sid"], { err: "ignore" });
  if (r.status === 0) out.push(...readLines(r.stdout));
  return out;
}

/** keep_alive_sids — sids with keep_alive=true (also exempt from sweep). */
function keepAliveSids(): string[] {
  const r = registry(["list", "--keep-alive", "--fields", "assigned.sid"], { err: "ignore" });
  return r.status === 0 ? readLines(r.stdout) : [];
}

/** `jq -e .` — valid JSON whose last output value is neither `null` nor `false`, and loud on empty input. */
function jqTruthyJson(raw: string): boolean {
  if (raw === "") return false;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return false;
  }
  return !(v === null || v === false);
}

/**
 * telepty_list_json — fail loudly on bad JSON (#400 lesson) and on an EMPTY list
 * the daemon will not corroborate (#835 lesson). The whole sweep hangs off this
 * listing, and step 2b prunes every role-sandbox workspace whose title is not in it
 * — so under a refusal an empty listing closes every live worker's surface on the
 * second tick (the ledger debounce buys exactly 60 seconds). "Refused" and
 * "unreachable" are not "there are no sessions"; abort the tick instead.
 */
function teleptyListJson(): string | null {
  const r = run(TELEPTY, ["list", "--json"], { err: "ignore" });
  if (r.status !== 0) {
    log("ERR telepty list non-zero");
    return null;
  }
  const raw = chomp(r.stdout);
  if (!jqTruthyJson(raw)) {
    log("ERR telepty list --json returned non-JSON (binary/daemon version mismatch?)");
    return null;
  }
  const { trusted, verdict } = listingTrusted(raw);
  if (!trusted) {
    log(
      `ERR telepty list --json returned [] but the daemon answered '${verdict}' — a refusal is not an absence; refusing to sweep or prune on it`,
    );
    return null;
  }
  return raw;
}

/** pid_alive <pid> — true if the process exists. */
function pidAlive(pid: string): boolean {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    // `kill -0` succeeds for a live process we may not signal (EPERM), as bash's does.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * parent_pid_for_sid <sid> — the parent telepty-allow PID or "". The ps/awk body
 * lives in platform::session_pid (#909) so open-session.sh's sleep assertion
 * resolves the same pid this sweep judges liveness by. Single-shot, as before.
 */
function parentPidForSid(sid: string): string {
  return chomp(platform("platform::session_pid", [sid]).stdout);
}

/** seconds_since_iso <iso> — int seconds (current - iso); 0 for anything unparseable. */
function secondsSinceIso(iso: string): number {
  const then = parseIso(iso);
  const now = parseIso(nowIso());
  if (!then || !now) return 0;
  return Math.trunc((now.getTime() - then.getTime()) / 1000);
}

// ── exponential backoff ─────────────────────────────────────────────────────
function loadBackoff(): Record<string, { count?: unknown; next_attempt_iso?: unknown }> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(BACKOFF_JSON, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, { count?: unknown; next_attempt_iso?: unknown }>)
      : {};
  } catch {
    return {};
  }
}

/** backoff_ready <sid> — true if the current attempt is allowed; false while waiting. */
function backoffReady(sid: string): boolean {
  const data = loadBackoff();
  const now = parseIso(nowIso());
  // An unparseable clock made the python exit non-zero, which the shell read as
  // "not ready". Same answer here rather than a guess at the operator's intent.
  if (!now) return false;
  const rec = data[sid];
  if (!rec) return true;
  const nxt = rec.next_attempt_iso;
  if (!nxt) return true;
  const at = parseIso(String(nxt));
  if (!at) return true;
  return now.getTime() >= at.getTime();
}

function backoffRecordFailure(sid: string): void {
  const data = loadBackoff() as Record<string, unknown>;
  const now = parseIso(nowIso()) ?? new Date();
  const init = Number.parseInt(BACKOFF_INITIAL, 10);
  const mx = Number.parseInt(BACKOFF_MAX, 10);
  const prev = data[sid];
  const prevCount =
    prev !== null && typeof prev === "object" && !Array.isArray(prev)
      ? Number.parseInt(String((prev as Record<string, unknown>).count ?? 0), 10) || 0
      : 0;
  const count = prevCount + 1;
  // exponential: init * 2^(count-1), capped at mx
  const delay = Math.min(mx, init * 2 ** (count - 1));
  const nxt = new Date(now.getTime() + delay * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  data[sid] = { count, delay_seconds: delay, next_attempt_iso: nxt };
  atomicWriteJson(BACKOFF_JSON, pyJson(data, { indent: 2 }) + "\n");
}

function backoffReset(sid: string): void {
  const data = loadBackoff() as Record<string, unknown>;
  delete data[sid];
  atomicWriteJson(BACKOFF_JSON, pyJson(data, { indent: 2 }) + "\n");
}

// ── the two bus-event consumers ─────────────────────────────────────────────
/** `jq -r '.<field> // empty'` on one JSONL line: "" for absent/null/false/unparseable. */
function jqField(line: string, field: string): string {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return "";
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return "";
  const v = (obj as Record<string, unknown>)[field];
  if (v === undefined || v === null || v === false || v === "") return "";
  return String(v);
}

/**
 * consume_surface_orphaned — event-driven complement to the wh_alive sweep (verdict
 * 2026-05-30 §5). Fed by bin/telepty-bus-bridge.sh (#847); absent file → no-op, so
 * actuation never depends on the bridge being up.
 * Two INV-17 gates before any close: (1) drop livenessVerdict=='unknown' (never
 * close on indeterminate liveness); (2) corroborate against gc_root/keep_alive
 * (never close a live/protected sid).
 */
function consumeSurfaceOrphaned(gcRoot: string, keepAlive: string): void {
  let body: string;
  try {
    body = fs.readFileSync(SURFACE_ORPHANED_SRC, "utf8");
  } catch {
    return; // dormant: no bridge yet → no-op
  }
  let processed = 0;
  for (const line of readLines(body)) {
    if (!line) continue;
    const sid = jqField(line, "sid");
    const verdict = jqField(line, "livenessVerdict");
    if (!sid) continue;
    if (verdict === "unknown") continue; // INV-17 gate 1
    if (csvHas(gcRoot, sid)) continue; // INV-17 gate 2 (live)
    if (csvHas(keepAlive, sid)) continue; // INV-17 gate 2 (keep_alive)
    if (DRY_RUN === 1) {
      log(`SURFACE_ORPHANED would-close sid=${sid} verdict=${verdict || "?"}`);
      processed += 1;
      continue;
    }
    const hostId = chomp(wh(["lookup", sid]).stdout);
    if (hostId) {
      if (wh(["close", hostId], { out: "inherit" }).status === 0) {
        log(`SURFACE_ORPHANED closed sid=${sid} host=${hostId}`);
      } else {
        log(`SURFACE_ORPHANED close non-zero sid=${sid} host=${hostId}`);
      }
    }
    processed += 1;
  }
  // Drain by REMOVING, and unconditionally (#847). Two reasons, both about the
  // bridge that now writes this file:
  //  * rm, not truncate: the bridge publishes a batch by renaming its spool into
  //    this path and only ever does so while the path is ABSENT.
  //  * unconditionally, not `processed > 0`: a line the INV-17 gates rejected is
  //    rejected FOREVER, and keeping those lines re-evaluated a dead judgement
  //    every tick and grew this file without bound.
  if (DRY_RUN === 0) {
    try {
      fs.rmSync(SURFACE_ORPHANED_SRC, { force: true });
    } catch {
      /* `|| true` */
    }
  }
  if (processed > 0) log(`surface_orphaned consumed=${processed}`);
}

/**
 * consume_surface_mismatched — re-bind a live session's workspace onto its real PTY
 * surface when telepty signals the surface is ALIVE-but-mismatched (task #507).
 * wh_focus is NON-DESTRUCTIVE (best-effort raise; always 0), so unlike orphan-close
 * it needs no INV-17 kill-corroboration — re-focusing a stray surface cannot lose
 * work. Single safety gate: the sid must resolve to a host_id.
 */
function consumeSurfaceMismatched(): void {
  let body: string;
  try {
    body = fs.readFileSync(SURFACE_MISMATCHED_SRC, "utf8");
  } catch {
    return; // dormant: no bridge yet → no-op
  }
  let processed = 0;
  for (const line of readLines(body)) {
    if (!line) continue;
    const sid = jqField(line, "sid");
    const exppty = jqField(line, "expectedPtyPid");
    if (!sid) continue;
    if (DRY_RUN === 1) {
      log(`SURFACE_MISMATCHED would-refocus sid=${sid} expectedPty=${exppty || "?"}`);
      processed += 1;
      continue;
    }
    const hostId = chomp(wh(["lookup", sid]).stdout);
    if (hostId) {
      if (wh(["focus", hostId], { out: "inherit" }).status === 0) {
        log(`SURFACE_MISMATCHED refocused sid=${sid} host=${hostId} expectedPty=${exppty || "?"}`);
      } else {
        log(`SURFACE_MISMATCHED refocus non-zero sid=${sid} host=${hostId}`);
      }
    }
    processed += 1;
  }
  // rm, and unconditional — same handoff with bin/telepty-bus-bridge.sh as
  // consumeSurfaceOrphaned's drain; the reasoning is written out there.
  if (DRY_RUN === 0) {
    try {
      fs.rmSync(SURFACE_MISMATCHED_SRC, { force: true });
    } catch {
      /* `|| true` */
    }
  }
  if (processed > 0) log(`surface_mismatched consumed=${processed}`);
}

/**
 * hitl_pause_gates — "PAUSE<TAB><gate-id>" for every pending gate that pauses
 * autonomous actions (ADR 2026-07-26-hitl-gate-primitive §3), and
 * "CORRUPT<TAB><path>" for every unparseable one. A corrupt gate is treated as
 * destructive: fail-safe, the same "never act when ambiguous" bias the loop's
 * ESCALATE default already has. Level-triggered — recomputed from the directory
 * each tick, so a daemon restart mid-gate needs no recovery logic.
 */
function hitlPauseGates(): string[] {
  let names: string[];
  try {
    if (!fs.statSync(HITL_PENDING_DIR).isDirectory()) return [];
    names = fs.readdirSync(HITL_PENDING_DIR);
  } catch {
    return [];
  }
  const out: string[] = [];
  // `glob.glob("*.json")` never matches a leading dot, and readdir does — a dotfile
  // must not be read as a gate (an unparseable one PAUSES the tick, fail-safe).
  const globbed = names.filter((n) => n.endsWith(".json") && !n.startsWith("."));
  for (const p of globbed.map((n) => path.join(HITL_PENDING_DIR, n)).sort()) {
    let gate: unknown;
    try {
      gate = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      out.push(`CORRUPT\t${p}`);
      continue;
    }
    if (gate !== null && typeof gate === "object" && (gate as Record<string, unknown>).kind === "destructive") {
      const id = (gate as Record<string, unknown>).id;
      out.push(`PAUSE\t${id ? String(id) : path.basename(p)}`);
    }
  }
  return out;
}

// ── argv ────────────────────────────────────────────────────────────────────
let DRY_RUN = 0;
let SHADOW = 0;
let LOOP = 0;

function usage(code: number): never {
  process.stdout.write(USAGE + "\n");
  process.exit(code);
}

function parseArgs(argv: string[]): void {
  for (const a of argv) {
    switch (a) {
      case "--dry-run": DRY_RUN = 1; break;
      case "--shadow": SHADOW = 1; break;
      case "--loop": LOOP = 1; break;
      case "--once": break;
      case "-h":
      case "--help": usage(0);
      // eslint-disable-next-line no-fallthrough
      default:
        process.stderr.write(`unknown: ${a}\n`);
        usage(4);
    }
  }
}

// ── the tick ────────────────────────────────────────────────────────────────
function main(argv: string[]): void {
  parseArgs(argv);

  // --loop: long-lived KeepAlive daemon. Re-exec a fresh `--once` tick every
  // interval (fresh process per tick → no in-process state leak). A crashing tick
  // never kills the loop; if the loop process itself dies, launchd KeepAlive
  // relaunches it. This is what makes the reconciler survive system sleep.
  //
  // The shell re-exec'd `"$0"`, i.e. this file's shim. Re-exec'ing the compiled
  // entrypoint directly is the same fresh process with the same argv and skips
  // re-prepending the shim's PATH once per tick — the loop process already carries
  // the hardened PATH and every child inherits it.
  if (LOOP === 1) {
    const interval = env.RECONCILER_LOOP_INTERVAL || "60";
    log(`loop mode start interval=${interval}s pid=${process.pid}`);
    const self = fileURLToPath(import.meta.url);
    const seconds = Number(interval);
    if (!Number.isFinite(seconds) || seconds < 0) {
      // bash: `sleep <garbage>` fails and errexit takes the loop down with it.
      process.stderr.write(`session-reconciler.sh: invalid RECONCILER_LOOP_INTERVAL: ${interval}\n`);
      process.exit(1);
    }
    for (;;) {
      const r = spawnSync(process.execPath, [self, "--once"], { stdio: "inherit" });
      if (r.error || (r.status ?? 1) !== 0) log("ERR loop tick non-zero (continuing)");
      sleepMs(seconds * 1000);
    }
  }

  if (SHADOW === 1) {
    runRegistryLoop(0); // run_shadow_loop
    process.exit(0);
  }

  // --- step 0a: HITL gates (ADR 2026-07-26-hitl-gate-primitive M3) ---
  // Reminder FIRST, pause second: a destructive gate pauses actions, but the 24h
  // reminder is the mitigation for a forgotten gate — it must survive its own
  // pause. An operator's explicit --dry-run still sends nothing.
  if (DRY_RUN === 0 && executable(HITL_SH)) {
    if (runQuiet(HITL_SH, ["remind"]) !== 0) log("ERR hitl remind non-zero (continuing)");
  }
  // Global pause = the existing --dry-run path: probe → policy → shadow record all
  // still run, every actuation is skipped. No new blocking mechanism.
  for (const line of hereStringLines(hitlPauseGates().join("\n"))) {
    const [kind, which] = readTabFields(line, 2);
    if (!kind) continue;
    if (kind === "CORRUPT") {
      log(`HITL_GATE_CORRUPT ${which} — unparseable gate, treating as destructive (fail-safe)`);
    } else {
      log(`HITL_PAUSE gate=${which} — autonomous actions paused (destructive gate pending)`);
    }
    DRY_RUN = 1;
  }

  // --- step 0: Dispatch Registry observe→decide→act loop ---
  runRegistryLoop(1);

  // --- step 0a2: host power (#909 item d) ---
  // Before the tracker runs, because the tracker is the forwarder being gated: it
  // inherits this tick's reading through the environment rather than paying for a
  // second ~1.2s pmset, and the digest of what the LAST sleep withheld goes out
  // ahead of anything this tick raises. Act-only. Best-effort: neither the digest
  // nor the lid page may abort a tick.
  if (DRY_RUN === 0) {
    env.AIGENTRY_HOST_POWER_STATE = hostPowerState();
    try {
      deliverSleepDigest();
    } catch {
      log("ERR sleep digest non-zero (continuing)");
    }
    try {
      checkLid(LIVE_DISPATCHES);
    } catch {
      log("ERR lid check non-zero (continuing)");
    }
  }

  // --- step 0b: tracker scan (#517) — the tracker polls every dispatch whose
  // expected_report_by elapsed and records what it measured. telepty#60 Stage A: it
  // emits HOLDs and evidence snapshots, never a completion.
  // Best-effort. Skipped under --dry-run because `check` mutates state and injects
  // to the orchestrator — emission is act-only. Idempotency lives in the tracker.
  if (executable(TRACKER_SH) && DRY_RUN === 0) {
    if (runQuiet(TRACKER_SH, ["check"]) !== 0) log("ERR tracker check non-zero (continuing)");
  }

  // --- step 0b2: report sweep (#904 + #743) — the PULL side of worker reporting.
  // `check` watches dispatches the orchestrator handed out; this watches what came
  // back. A worker's `inject --ref` can be silently dropped when the orchestrator is
  // busy (fl850: report written 22:07, noticed 22:48), so the ref is recovered from
  // ~/.telepty/shared through a durable cursor and copied into state/dispatch/inbox.
  // The NEW lines go through log() rather than /dev/null: a delivery nobody records
  // is the defect this closes. Act-only and best-effort, as step 0b.
  // AIGENTRY_REPORT_SWEEP=0 disables the call.
  //
  // The shell was `… 2>&1 | while read line; do log "$line"; done || log ERR`, whose
  // `||` reaches the tracker's own status only because of `set -o pipefail`. Captured
  // and replayed here in the same order: every line first, the ERR line after.
  if (executable(TRACKER_SH) && DRY_RUN === 0 && (env.AIGENTRY_REPORT_SWEEP || "1") !== "0") {
    const sweep = spawnSync(TRACKER_SH, ["report-sweep"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    for (const line of readLines((sweep.stdout ?? "") + (sweep.stderr ?? ""))) log(line);
    if (sweep.error || (sweep.status ?? 1) !== 0) log("ERR report-sweep non-zero (continuing)");
  }

  // --- step 0c: PEER-LANE comms auditor (#533 Phase 1) — tail telepty's peer-inject
  // log, classify each non-orch↔non-orch inject, reconcile round counters, and
  // escalate violations via an orchestrator HOLD (warn-mode). Act-only. ---
  if (executable(COMMS_AUDITOR_SH) && DRY_RUN === 0) {
    if (runQuiet(COMMS_AUDITOR_SH, [], { ...env, TELEPTY }) !== 0) log("ERR comms-auditor non-zero (continuing)");
  }

  // --- step 0d: orchestrator-bridge singleton belt (#620, #618 recurrence) —
  // detect a stale DUPLICATE `telepty allow --id orchestrator ` bridge and push a
  // HOLD inject naming the pids + the `kill -9` remedy. WARN-ONLY: never kills
  // (orchestrator bridge cleanup is USER-ONLY, #606). Act-only. ---
  if (executable(BRIDGE_AUDITOR_SH) && DRY_RUN === 0) {
    if (runQuiet(BRIDGE_AUDITOR_SH, [], { ...env, TELEPTY }) !== 0) log("ERR bridge-auditor non-zero (continuing)");
  }

  // --- step 0e: telepty bus→file bridge supervision (#847) — the two surface-event
  // consumers below read files only bin/telepty-bus-bridge.sh writes, so something
  // has to keep that bridge alive. This tick is that something. `--ensure` is a
  // pidfile check and nothing else when the bridge is up. Act-only, best-effort.
  // AIGENTRY_BUS_BRIDGE=0 is the kill switch; tests/dispatch/lib.sh sets it. ---
  if ((env.AIGENTRY_BUS_BRIDGE || "1") !== "0" && executable(BUS_BRIDGE_SH) && DRY_RUN === 0) {
    if (runQuiet(BUS_BRIDGE_SH, ["--ensure"], { ...env, TELEPTY }) !== 0) {
      log("ERR bus-bridge ensure non-zero (continuing)");
    }
  }

  // --- step 1: scheduler tick (Layer D fires due) ---
  // stdout/stderr are NOT redirected here, unlike every other child above.
  if (executable(SCHEDULER_SH) && DRY_RUN === 0) {
    if (run(SCHEDULER_SH, ["tick"], { out: "inherit" }).status !== 0) log("ERR scheduler tick non-zero");
  }

  // --- step 2: orphan sweep ---
  const listing = teleptyListJson();
  if (listing === null) {
    log("abort sweep — bad telepty list");
    process.exit(0);
  }
  const parsed: unknown = JSON.parse(listing);
  const sessions: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>)
    : [];
  const gcRoot = sortUniqCsv(computeGcRoot());
  const keepAlive = sortUniqCsv(keepAliveSids());

  // --- step 2a: is the ORCHESTRATOR ITSELF down? (#905) ---
  //
  // On 2026-08-16 the orchestrator's session sat OWNER_DISCONNECTED_STALE for 3h20m
  // while this tick ran every 60 seconds beside it and said nothing: the
  // orchestrator sid is in PROTECTED_SIDS, so it is in gc_root, and the candidate
  // loop skips gc_root before it examines anything. Being exempt from being SWEPT
  // had quietly also meant being exempt from being LOOKED AT.
  //
  // Placed here rather than beside the other 0d-style belts because it needs the
  // very listing step 2 has just fetched and had corroborated (#835).
  //
  // WARN-ONLY, permanently: orchestrator lifecycle is user-actuated (#606). The
  // alert cannot be an inject precisely BECAUSE of what it reports — the
  // orchestrator is the thing that is down, and a STALE session is exactly the one
  // that bounces `[STALE] Session is stale and awaiting cleanup`.
  const orchStaleAlertMin = env.ORCH_STALE_ALERT_MIN || "5";
  const orchRec = sessions.find((s) => s && s.id === ORCH_SID);
  if (orchRec) {
    const orchHealth = String(orchRec.healthStatus ?? orchRec.status ?? "");
    if (orchHealth === "STALE" || orchHealth === "DISCONNECTED") {
      const orchLast = String(orchRec.lastSeenAt ?? orchRec.last_seen ?? orchRec.disconnectedAt ?? "");
      const orchAge = secondsSinceIso(orchLast);
      // No timestamp → seconds_since_iso yields 0 → below any positive threshold →
      // no alert. Silence on a missing field is the right way round: this fires an
      // operator page, and crying wolf on an unparseable record would teach them to
      // ignore it.
      if (orchAge >= (Number.parseInt(orchStaleAlertMin, 10) || 0) * 60) {
        emitAlert(
          `ORCHESTRATOR_STALE sid=${ORCH_SID} health=${orchHealth} for ${orchAge}s (>= ${orchStaleAlertMin}m) — worker reports are bouncing '[STALE] Session is stale and awaiting cleanup' and nothing is reading them. Remedy: run bin/orchestrator-boot.sh (it reconciles the stale registry record, then re-claims the id). WARN-ONLY: this tick will not touch the orchestrator.`,
        );
      }
    }
  }

  // event-driven surface_orphaned consumer (dormant until a bus→file bridge exists)
  consumeSurfaceOrphaned(gcRoot, keepAlive);
  // event-driven surface_mismatched consumer — re-focus stray surfaces (#507, dormant)
  consumeSurfaceMismatched();

  const candidates: string[] = [];
  for (const s of sessions) {
    const sid = s?.id;
    if (!sid) continue;
    const sidStr = String(sid);
    if (csvHas(gcRoot, sidStr) || csvHas(keepAlive, sidStr)) continue;
    const started = String(s.startedAt ?? s.started_at ?? s.started ?? "");
    const health = String(s.healthStatus ?? s.status ?? "");
    const lastSeen = String(s.lastSeenAt ?? s.last_seen ?? s.disconnectedAt ?? "");
    candidates.push(`${sidStr}\t${started}\t${health}\t${lastSeen}`);
  }

  let swept = 0;
  for (const line of hereStringLines(candidates.join("\n"))) {
    const [sidRaw, startedRaw, healthRaw, lastSeenRaw] = readTabFields(line, 4);
    const sid = sidRaw ?? "";
    if (!sid) continue;
    if (!backoffReady(sid)) continue;
    const age = secondsSinceIso(startedRaw ?? "");
    if (age < (Number.parseInt(AGE_FLOOR_SECONDS, 10) || 0)) continue;
    const health = healthRaw ?? "";
    const reasons: string[] = [];
    const ppid = parentPidForSid(sid);
    if (ppid && !pidAlive(ppid)) reasons.push("pid_dead");
    if (!ppid) reasons.push("no_parent_pid");
    let discAge = 0;
    if (health === "DISCONNECTED") {
      discAge = secondsSinceIso(lastSeenRaw ?? "");
      if (discAge >= (Number.parseInt(DISCONNECT_FLOOR_SECONDS, 10) || 0)) reasons.push(`disconnected_${discAge}s`);
    }
    // surface_gone (workspace-host probe): the always-on consume of the
    // surface-orphan signal (verdict 2026-05-30 §5). A "gone" surface is a
    // CORROBORATING signal only — see the INV-17 guard below.
    const sidRec = sessions.find((x) => x && x.id === sid);
    const sidJson = sidRec ? JSON.stringify(sidRec) : "";
    const surfaceHostId = chomp(wh(["lookup", sid, sidJson]).stdout);
    if (surfaceHostId && wh(["alive", surfaceHostId], { out: "inherit" }).status !== 0) {
      reasons.push("surface_gone");
    }
    if (reasons.length === 0) continue;
    const stateJson = pyJson(
      {
        alive: health === "CONNECTED",
        ready: false,
        surface: "idle",
        activity: "static",
        cli: "unknown",
        detail: {
          health,
          cleanup: {
            age_seconds: age,
            disconnect_age_seconds: discAge,
            gc_root: false,
            keep_alive: false,
            reasons,
          },
        },
      },
      { compact: true },
    );
    const actionJson = policyDecide("orphaned", stateJson);
    appendShadowRecord(sid, "orphaned", stateJson, actionJson);
    if (jsonGet(actionJson, "action") !== "CLEANUP") {
      if (reasons.join(",") === "surface_gone") {
        log(`INV-17 skip sid=${sid} — surface_gone single-signal (no pid/disconnect corroboration)`);
      } else {
        log(`SWEEP skip sid=${sid} reason=${jsonGet(actionJson, "reason")}`);
      }
      continue;
    }
    log(`SWEEP candidate sid=${sid} age=${age}s health=${health} reasons=${reasons.join(",")}`);
    if (DRY_RUN === 1) continue;
    applyAction(sid, "orphaned", "", "0", actionJson);
    swept += 1;
  }

  // --- step 2b: cmux-adaptor sidebar keeping (SPEC 2026-06-06) ---
  // Best-effort, never blocks the sweep (wh_* always return 0). Honors DRY_RUN via
  // the wh-cli.sh child env (wh_prune_orphans reads $DRY_RUN; status push is
  // skipped here).
  //
  // §A prune — live_ids = telepty ids ∪ gc_root ∪ keep_alive (titles are sids, F4);
  // protected_refs = the orchestrator's own workspace ref when known
  // ($CMUX_WORKSPACE_ID; empty under launchd — the ownership gate already protects
  // the orchestrator, whose cwd is the repo dir, not the role-sandbox).
  const teleptyIds = sortUniqCsv(sessions.map((s) => (s?.id ? String(s.id) : "")));
  const liveIds = sortUniqCsv(`${teleptyIds},${gcRoot},${keepAlive}`.split(","));
  const protectedRefs = env.CMUX_WORKSPACE_ID || "";
  const pruneRes = wh(["prune-orphans", liveIds, protectedRefs], { err: "ignore" });
  const pruned = pruneRes.status === 0 ? chomp(pruneRes.stdout) : "0";

  // §B status push — one sidebar pill per live telepty session. Conservative default
  // (orchestrator decision 3): CONNECTED→idle, DISCONNECTED→disconnected; never emit
  // a false "working" (no richer activity signal wired this phase — Article 1).
  let statusPushed = 0;
  if (DRY_RUN === 0) {
    const rows = sessions
      .filter((s) => s && s.cmuxWorkspaceId !== null && s.cmuxWorkspaceId !== undefined && s.cmuxWorkspaceId !== "")
      .map((s) => `${String(s.cmuxWorkspaceId)}\t${String(s.healthStatus ?? s.status ?? "")}`);
    for (const line of readLines(rows.join("\n") + (rows.length ? "\n" : ""))) {
      const [hostId, health] = readTabFields(line, 2);
      if (!hostId) continue;
      wh(["set-status", hostId, health === "DISCONNECTED" ? "disconnected" : "idle"], { out: "inherit" });
      statusPushed += 1;
    }
  }

  log(
    `tick: gc_root=[${gcRoot}] keep_alive=[${keepAlive}] swept=${swept} pruned=${pruned || "0"} status_pushed=${statusPushed} dry_run=${DRY_RUN}`,
  );
}

main(process.argv.slice(2));
