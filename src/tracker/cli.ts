// dispatch-tracker.sh's implementation, ported to TypeScript (#899 tranche 1b).
//
// This is a PORT, not a redesign (Rule 29 + Constitution Art. 1): every
// subcommand, exit code, stdout/stderr line, log line and subprocess argv is the
// shell script's, preserved deliberately. bin/dispatch-tracker.sh is now an exec
// shim onto this file, so bin/session-reconciler.sh's 60s tick, bin/init's
// manifest and every caller are unchanged. The behavioural documentation lives
// in ./usage.ts (what --help prints) and in the shell script's git history.
//
// Subprocesses stay subprocesses with identical argv — dispatch-registry.py
// (the single transactional writer), session-probe.py, policy.py, dispatch.sh,
// hitl.sh, telepty, curl, git, and bin/lib/telepty-auth.sh (the ONE credential
// resolver, tests/dispatch/T87; it is invoked as the shell function it is
// instead of being re-implemented here, because a second copy of credential
// resolution is exactly what T87 exists to prevent). Only the inline
// `python3 -c` computations — JSON field reads, the clock, the test-summary
// scrape, the commit-attribution filter — became TS: they were the
// shell-dialect fragility this tranche exists to remove, not a component.
//
// No process.platform branch exists here because the shell had no OS arm: it was
// already "shell + Python stdlib only, macOS + Linux" (Article 17).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` — the repo's (or
// the init workspace's) bin/. The shim exports it so a symlinked entrypoint
// still locates bin/ helpers; the fallback keeps a direct
// `node dist/src/tracker/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = env.DISPATCH_STATE_DIR || path.join(REPO_DIR, "state", "dispatch");
const ALERTS_LOG = path.join(STATE_DIR, "alerts.log");
const OBSERVATIONS_LOG = path.join(STATE_DIR, "observations.log");
const OBSERVATIONS_SEEN = path.join(STATE_DIR, "observations.seen");
const DISCONNECTED_LOG = path.join(STATE_DIR, "disconnected.log");

const ORCH_SID = env.ORCHESTRATOR_SID || "orchestrator";
const TRACKER_SID = env.TRACKER_FROM_SID || "dispatch-tracker";

// Test seams (override in tests via env) — identical names/defaults to the shell.
const TELEPTY = env.TELEPTY || "telepty";
const CURL = env.CURL || "curl";
const GIT = env.GIT || "git";
const DISPATCH_SH = env.DISPATCH_SH || path.join(SCRIPT_DIR, "dispatch.sh");
const SESSION_PROBE_PY = env.SESSION_PROBE_PY || path.join(SCRIPT_DIR, "session-probe.py");
const POLICY_PY = env.POLICY_PY || path.join(SCRIPT_DIR, "policy.py");
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY || path.join(SCRIPT_DIR, "dispatch-registry.py");
const HITL_SH = env.HITL_SH || path.join(SCRIPT_DIR, "hitl.sh");
const NOW_OVERRIDE = env.TRACKER_NOW || "";
const TELEPTY_AUTH_SH = path.join(SCRIPT_DIR, "lib/telepty-auth.sh");

fs.mkdirSync(STATE_DIR, { recursive: true });

// ── small process helpers ───────────────────────────────────────────────────
/** bash `$(cmd)`: command substitution strips every trailing newline. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

interface RunOpts {
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** "inherit" mirrors a bare call; "ignore" mirrors `2>/dev/null`. */
  stderr?: "inherit" | "ignore";
}

/** stdout captured; stderr per opts. Status 127 for an unrunnable command, as bash. */
function capture(cmd: string, args: string[], opts: RunOpts = {}): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    ...(opts.input === undefined ? {} : { input: opts.input }),
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", opts.stderr === "inherit" ? "inherit" : "ignore"],
  });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** `cmd >/dev/null 2>&1` — status only. */
function runQuiet(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
  if (r.error) return 127;
  return r.status ?? 1;
}

/** Fully inherited stdio — a bare `cmd`. */
function runInherit(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) return 127;
  return r.status ?? 1;
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

function mkTemp(prefix: string): string {
  const dir = env.TMPDIR || "/tmp";
  return path.join(dir, `${prefix}.${randomBytes(6).toString("hex")}`);
}

/**
 * python's `json.dumps(...)` default separators (", " / ": "), which the guards
 * grep for literally (`'"kind": "WORKTREE_ACTIVITY"'`, `'"head_sha": "abc1234"'`).
 * JSON.stringify emits no separator spaces, so the emitted evidence lines would
 * stop matching the very asserts that pin them.
 */
function pyDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyDumps).join(", ") + "]";
  return (
    "{" +
    Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => JSON.stringify(k) + ": " + pyDumps(x))
      .join(", ") +
    "}"
  );
}

function nowIso(): string {
  if (NOW_OVERRIDE) return NOW_OVERRIDE;
  // datetime.now(timezone.utc).isoformat(timespec="seconds") + Z
  return new Date().toISOString().slice(0, 19) + "Z";
}

// ── registry seam ───────────────────────────────────────────────────────────
// Every registry access is a typed call to the one transactional component.
// There is no local read/write path, so there is nothing here to fail open on a
// corrupt registry: the component fails closed and this file inherits that.
function registryCapture(args: string[]): { status: number; stdout: string } {
  return capture(DISPATCH_REGISTRY_PY, args, { stderr: "inherit" });
}

/**
 * A registry call the shell made with errexit ACTIVE: its failure ended the tick
 * before any further actuation. Ported literally — a failed write stops the tick
 * rather than silently continuing past a registry that just refused a mutation.
 */
function registryOrDie(args: string[]): void {
  const rc = runInherit(DISPATCH_REGISTRY_PY, args);
  if (rc !== 0) process.exit(rc);
}

/**
 * A registry call the shell made with errexit SUPPRESSED — inside a function
 * invoked as an `if` condition or with `|| true`, where bash ignores the status.
 * Same rule here: status observed, not fatal.
 */
function registryRun(args: string[]): number {
  return runInherit(DISPATCH_REGISTRY_PY, args);
}

// ── JSON field reads (the retired `json_get` / `_json_sub` python blocks) ────
function parseOrEmpty(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

/** Dotted-path lookup; "" for anything absent, exactly as the python arm printed. */
function jsonGet(jsonText: string, expr: string): string {
  let cur: unknown = parseOrEmpty(jsonText);
  for (const part of expr.split(".")) {
    if (!part) continue;
    if (cur !== null && typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[part] ?? "";
    } else {
      cur = "";
      break;
    }
  }
  if (cur === null || cur === undefined) return "";
  if (typeof cur === "string") return cur;
  if (typeof cur === "number") return String(cur);
  if (typeof cur === "boolean") return cur ? "True" : "False"; // python `print(True)`
  return pyDumps(cur);
}

/** The named sub-object as JSON ("{}" when absent or not an object). */
function jsonSub(jsonText: string, key: string): string {
  const data = parseOrEmpty(jsonText);
  const sub =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)[key]
      : undefined;
  return pyDumps(sub !== null && typeof sub === "object" && !Array.isArray(sub) ? sub : {});
}

// ── observation / alert emission ────────────────────────────────────────────
function emitAlert(line: string): void {
  const text = `${nowIso()} ${line}\n`;
  process.stdout.write(text); // `tee -a`: the operator's screen AND the log
  fs.appendFileSync(ALERTS_LOG, text);
}

/** `grep -qxF "$key" "$file"` — whole-line fixed match, absent file = no match. */
function seenContains(key: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(OBSERVATIONS_SEEN, "utf8");
  } catch {
    return false;
  }
  return text.split("\n").includes(key);
}

// ── telepty / probe / policy seams ──────────────────────────────────────────
function readScreen(sid: string, lines = 60): string {
  return chomp(capture(TELEPTY, ["read-screen", sid, "--lines", String(lines)]).stdout);
}

function sessionDisconnected(sid: string): string {
  const listing = chomp(capture(TELEPTY, ["list", "--json"]).stdout);
  const parsed = (() => {
    try {
      return JSON.parse(listing);
    } catch {
      return null; // the python arm swallowed every parse error too
    }
  })();
  if (!Array.isArray(parsed)) return "";
  for (const s of parsed) {
    if (s && s.id === sid) return String(s.healthStatus || s.status || "");
  }
  return "";
}

const PROBE_FALLBACK =
  '{"alive":false,"ready":false,"surface":"unknown","activity":"static","cli":"unknown","detail":{"probe_error":"session-probe failed","tracker_class":"blank"}}';

function probeFromScreen(sid: string, screen: string): string {
  const tmp = mkTemp("tracker-screen");
  fs.writeFileSync(tmp, screen);
  const r = capture(SESSION_PROBE_PY, ["--sid", sid, "--screen-file", tmp], { env: { TELEPTY } });
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* already gone */
  }
  // `$(… 2>/dev/null || true)`: the status is discarded, the bytes are not.
  return chomp(r.stdout) || PROBE_FALLBACK;
}

const POLICY_FALLBACK = '{"action":"ESCALATE","reason":"policy failed","status":"stuck_error"}';

function policyForTracker(stateJson: string): string {
  const r = capture(POLICY_PY, ["--status", "tracker_check", "--state", "-"], { input: stateJson + "\n" });
  return r.status === 0 ? chomp(r.stdout) : POLICY_FALLBACK;
}

/**
 * The ONE credential resolver, called as the shell function it is
 * (bin/lib/telepty-auth.sh). Re-implementing the config read here would create
 * the second copy tests/dispatch/T87 exists to forbid — a divergent copy of a
 * credential is how the two ends stop agreeing about who is calling. Degrades to
 * "" (no credential presented) exactly as the lib does.
 */
function teleptyAuthToken(): string {
  return chomp(capture("bash", ["-c", '. "$1"; telepty_auth_token', "_", TELEPTY_AUTH_SH]).stdout);
}

// ── git evidence helpers ────────────────────────────────────────────────────
/** A new commit in <cwd> since <since> that is attributable to the worker. */
function hasNewCommits(cwd: string, since: string): boolean {
  let isDir = false;
  try {
    isDir = fs.statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return false;
  if (capture(GIT, ["-C", cwd, "rev-parse", "--git-dir"]).status !== 0) return false;
  const email = chomp(capture(GIT, ["-C", cwd, "config", "user.email"]).stdout).trim().toLowerCase();
  const log = chomp(
    capture(GIT, ["-C", cwd, "log", `--since=${since}`, "--pretty=format:%H%x09%ae%x09%B%x1e", "HEAD"]).stdout,
  );
  const rows = log.split("\x1e").filter((r) => r.trim() !== "");
  for (const row of rows) {
    const parts = row.trim().split("\t");
    if (parts.length < 3) continue;
    const ae = parts[1]!;
    const body = parts.slice(2).join("\t"); // python's split("\t", 2)
    if (email && ae.trim().toLowerCase() === email) return true;
    const bl = body.toLowerCase();
    if (bl.includes("claude") && bl.includes("co-authored-by:")) return true;
  }
  return false;
}

/**
 * #541: 2+ still-open dispatches sharing (cwd, branch) cannot be discriminated —
 * same cwd + author + branch yields no per-session key — so the git evidence
 * snapshot must skip rather than misattribute.
 */
function sharedCwdBranchAmbiguous(sid: string, cwd: string): boolean {
  let branch = chomp(registryCapture(["get", "--sid", sid, "--pointer", "branch"]).stdout);
  if (branch === "null") branch = "";
  const rows = chomp(registryCapture(["list", "--live", "--fields", "cwd,branch"]).stdout);
  let n = 0;
  for (const row of rows.split("\n")) {
    if (!row) continue;
    const parts = row.split("\t");
    const rowCwd = parts[0] === "null" ? "" : parts[0] ?? "";
    const rowBranch = parts.length < 2 || parts[1] === "null" ? "" : parts[1]!;
    if (rowCwd === cwd && rowBranch === branch) n += 1;
  }
  return n > 1;
}

/**
 * #718: a worker often commits in a dedicated worktree while the record's cwd
 * points at the shared main checkout, so `git -C cwd rev-parse HEAD` reads the
 * orchestrator's own just-landed main commit and misattributes it.
 */
function workerGitDir(sid: string, cwd: string): string {
  let wt = chomp(registryCapture(["get", "--sid", sid, "--pointer", "worktree"]).stdout);
  if (wt === "null") wt = "";
  if (wt && capture(GIT, ["-C", wt, "rev-parse", "--git-dir"]).status === 0) return wt;
  return cwd;
}

/** #718: a mainline HEAD in the only resolvable context is not the worker's work. */
function onProtectedBranch(gitDir: string): boolean {
  const br = chomp(capture(GIT, ["-C", gitDir, "rev-parse", "--abbrev-ref", "HEAD"]).stdout);
  return br === "main" || br === "master";
}

function gitShortstat(cwd: string, since: string): [string, string, string] {
  const log = chomp(capture(GIT, ["-C", cwd, "log", `--since=${since}`, "--pretty=format:%H", "HEAD"]).stdout);
  const lines = log.split("\n");
  const first = lines.length ? lines[lines.length - 1]! : "";
  if (!first) return ["0", "0", "0"];
  const t = capture(GIT, ["-C", cwd, "diff", "--shortstat", `${first}~1..HEAD`]).stdout;
  const f = /(\d+) files? changed/.exec(t);
  const a = /(\d+) insertions?/.exec(t);
  const d = /(\d+) deletions?/.exec(t);
  return [f ? f[1]! : "0", a ? a[1]! : "0", d ? d[1]! : "0"];
}

/**
 * A3 (#810): this field must not claim more than it measured. It scrapes the
 * VISIBLE SCREEN for a test-runner summary line — it does not know what the
 * commit contains. No match is `unmatched`, which is a statement about the
 * scrape, not about the change.
 */
const TEST_SUMMARY_PATTERNS = [
  /passed:\s*\d+\s+failed:\s*\d+/gi, // tests/dispatch/run-all.sh
  /#\s*(?:pass|fail)\s+\d+/gi, //       node --test TAP summary
  /\d+\s+(?:passed|failed)/gi, //       vitest / jest
  /\d+\s+FAIL/gi,
  /ok\s+\d+\s+tests?/gi,
];

export function scrapeTestResult(screen: string): string {
  // Most specific form first, and stop at the first that matches: the forms
  // overlap, so scanning them all reports one summary line three ways.
  for (const pattern of TEST_SUMMARY_PATTERNS) {
    const hits = screen.match(pattern);
    if (hits && hits.length) return [...new Set(hits)].join(" / ");
  }
  return "unmatched";
}

// ── the check loop's branches ───────────────────────────────────────────────
function recordClassification(sid: string, cls: string): void {
  registryOrDie(["observe", "--sid", sid, "--kind", "screen_class_observed", "--field", `class=${cls}`, "--now", nowIso()]);
}

function bumpExpected(sid: string): void {
  registryOrDie(["set-lifecycle", "--sid", sid, "--extend-minutes", "15", "--now", nowIso()]);
}

function openRedispatchGate(sid: string, refPath: string, question: string): void {
  if (!executable(HITL_SH)) {
    emitAlert(`HITL_GATE_UNAVAILABLE ${HITL_SH} not executable — sid=${sid}`);
    return;
  }
  const rc = runQuiet(HITL_SH, [
    "open", "--source", "dispatch-tracker", "--subject-sid", sid, "--kind", "decision",
    "--resume", "registry-clear-redispatch", "--question", question,
    "--options", "approve=re-dispatch once more,reject=hand back to the operator",
    "--context-ref", refPath,
  ]);
  if (rc !== 0) emitAlert(`HITL_GATE_OPEN_FAILED sid=${sid}`);
}

/**
 * Only dispatch exit 0 may advance the attempt counter, the lifecycle and the
 * deadline. Exits 8 (deduplicated) and 7 (delivery unknown) mean NO new delivery
 * happened; booking either as a re-dispatch is how the ledger came to record
 * attempts that never occurred.
 */
function maybeRedispatch(sid: string, cwd: string, refPath: string, dispatchedAt: string, rdcText: string): void {
  const rdc = Number(rdcText || "0");
  if (rdc >= 1) {
    emitAlert(`REDISPATCH_CAP sid=${sid} count=${rdcText} — user gate required`);
    return;
  }
  if (cwd && hasNewCommits(cwd, dispatchedAt)) {
    emitAlert(`REDISPATCH_SKIP sid=${sid} — new commits present, deferring to git path`);
    return;
  }
  // Rule 34 task-gate (#736): a re-dispatch re-actuates work already registered
  // under the original dispatch's task, so it takes the audited exemption.
  const rc = runQuiet(DISPATCH_SH, [
    "--target", sid, "--ref", refPath, "--verify-delivered", "--no-task", `tracker-redispatch ${sid}`,
  ]);
  // The alert reports the OUTCOME of the call, not the intention to make it.
  switch (rc) {
    case 0:
      registryOrDie([
        "set-lifecycle", "--sid", sid, "--state", "re_dispatched",
        "--bump-re-dispatch-count", "--extend-minutes", "30", "--now", nowIso(),
      ]);
      emitAlert(`REDISPATCH_OK sid=${sid} attempt=${rdc + 1} ref=${refPath}`);
      break;
    case 8:
      registryOrDie([
        "observe", "--sid", sid, "--kind", "redispatch_suppressed_duplicate",
        "--field", `ref_path=${refPath}`, "--now", nowIso(),
      ]);
      emitAlert(`REDISPATCH_SUPPRESSED sid=${sid} — identical ref already delivered; no new delivery`);
      // Freezing the counter would make the one-shot operator gate unreachable,
      // leaving a stuck dispatch surfaced only by a repeating HOLD. Open it here.
      openRedispatchGate(sid, refPath, `duplicate suppressed: ${sid} is already holding an identical delivered ref`);
      break;
    case 7:
      registryOrDie([
        "observe", "--sid", sid, "--kind", "redispatch_held_delivery_unknown",
        "--field", `ref_path=${refPath}`, "--now", nowIso(),
      ]);
      emitAlert(`REDISPATCH_HELD sid=${sid} — a prior attempt's delivery is unknown; not replayed`);
      break;
    default:
      emitAlert(`REDISPATCH_FAILED sid=${sid} rc=${rc}`);
  }
}

/**
 * A new authored commit in the worker's git context is EVIDENCE FOR A HUMAN, not
 * a completion. It records a nonterminal worktree_activity_observed snapshot with
 * review_required, leaves the outcome untouched, and does not stop the dispatch
 * being polled.
 */
function gitCheckAndObserve(sid: string, cwd: string, dispatchedAt: string, screen: string): void {
  if (!cwd) return;
  // #718: attribute against the WORKER's git context (its worktree if recorded),
  // never the shared cwd HEAD.
  const gdir = workerGitDir(sid, cwd);
  if (!hasNewCommits(gdir, dispatchedAt)) return;
  // #541 — ambiguous-attribution guard.
  if (sharedCwdBranchAmbiguous(sid, cwd)) return;
  const testResult = scrapeTestResult(screen);
  const now = nowIso();
  // #718 honest degradation: when the only resolvable git context is a mainline
  // checkout (main/master), the worker's work is NOT here — record screen-state
  // only and never cite the (orchestrator's) HEAD sha.
  let headSha = "";
  let seenKey: string;
  if (onProtectedBranch(gdir)) {
    seenKey = `${sid}\tNOSHA`;
  } else {
    headSha = chomp(capture(GIT, ["-C", gdir, "rev-parse", "--short", "HEAD"]).stdout) || "unknown";
    seenKey = `${sid}\t${headSha}`;
  }
  if (seenContains(seenKey)) return;
  const [files, added, removed] = gitShortstat(gdir, dispatchedAt);

  const obs = [
    "observe", "--sid", sid, "--kind", "worktree_activity_observed",
    "--field", "review_required=true", "--field", `test_result_scraped=${testResult}`,
    "--field", `files_changed=${files}`, "--field", `loc_added=${added}`,
    "--field", `loc_removed=${removed}`, "--now", now,
  ];
  if (headSha) {
    obs.push("--field", `head_sha=${headSha}`);
  } else {
    obs.push("--field", "attribution=omitted", "--field", "reason=cwd_on_protected_branch");
  }
  registryRun(obs);

  fs.appendFileSync(
    OBSERVATIONS_LOG,
    pyDumps({
      kind: "WORKTREE_ACTIVITY",
      sid,
      emitted_at: now,
      head_sha: headSha || null,
      attribution: headSha ? "worker_git_dir" : "omitted",
      files_changed: Number(files || 0),
      loc_added: Number(added || 0),
      loc_removed: Number(removed || 0),
      test_result_scraped: testResult,
      completion_fact: null,
      review_required: true,
    }) + "\n",
  );
  fs.appendFileSync(OBSERVATIONS_SEEN, seenKey + "\n");
  const note =
    `WORKTREE_ACTIVITY sid=${sid} sha=${headSha || "omitted"} files=${files} +${added}/-${removed}` +
    ` test_result_scraped=${testResult} — evidence only, no completion fact, review required`;
  emitAlert(note);
  if (commandExists(TELEPTY)) {
    runQuiet(TELEPTY, ["inject", "--from", TRACKER_SID, ORCH_SID, note]);
  }
}

/**
 * telepty#60 Stage A: per-inject observation poll + HOLD.
 *
 * Polls telepty GET /api/inject-observations/:inject_id, which returns a
 * discriminated schema-v2 body and never uses 404 as a task-state signal.
 * Returns TRUE when the result is named ABSENCE (caller skips the git evidence
 * chain: HOLD emitted, dispatch keeps being polled, nothing settled). Returns
 * FALSE only when a valid schema-v2 observation was recorded.
 *
 * There is deliberately no DELETE here: a record the orchestrator does not own is
 * not its to discard, and idempotency lives in the seen-ledger.
 */
function pollObservationsAndHold(sid: string, dispatchId: string, injectId: string): boolean {
  const port = env.TELEPTY_PORT || "3848";
  let reason = "";

  if (!injectId || injectId === "null") {
    reason = "no_transport_inject_id";
  } else {
    const r = capture(CURL, [
      "-s", "-w", "\n%{http_code}",
      "-H", `x-telepty-token: ${teleptyAuthToken()}`,
      `http://127.0.0.1:${port}/api/inject-observations/${injectId}`,
    ]);
    if (r.status !== 0) {
      fs.appendFileSync(DISCONNECTED_LOG, `${nowIso()} OBSERVATION_POLL_SKIP sid=${sid} curl_failed\n`);
      reason = "observation_poll_failed";
    } else {
      const resp = chomp(r.stdout);
      const cut = resp.lastIndexOf("\n");
      const http = cut >= 0 ? resp.slice(cut + 1) : resp;
      const body = cut >= 0 ? resp.slice(0, cut) : resp;
      if (http === "401" || http === "403") {
        // A refusal is NOT an absence (#820/#823). Folding it into
        // `observation_endpoint_absent` would report "the endpoint is absent"
        // about an endpoint that is present and merely refusing an
        // unauthenticated caller — the same overclaim-beyond-the-measurement
        // defect telepty#60 exists to remove.
        reason = "observation_poll_unauthorized";
      } else if (http !== "200") {
        reason = "observation_endpoint_absent";
      } else if (jsonGet(body, "schema_version") !== "2") {
        reason = "unknown_observation_schema";
      } else if (jsonGet(body, "tracking_state") === "unavailable") {
        reason = jsonGet(body, "reason") || "tracking_state_unavailable";
      } else {
        const kind = jsonGet(body, "observation.kind") || "unmapped_transition_cause";
        // Recorded verbatim as an observation. Consumption evidence is data here,
        // never a licence.
        registryRun([
          "observe", "--sid", sid, "--kind", kind, "--json", jsonSub(body, "observation"),
          "--field", `consumption=${jsonGet(body, "consumption.status")}`,
          "--field", `inject_id=${injectId}`, "--now", nowIso(),
        ]);
        return false;
      }
    }
  }

  registryRun([
    "observe", "--sid", sid, "--kind", "tracking_unavailable",
    "--field", `reason=${reason}`, "--field", `inject_id=${injectId || "null"}`, "--now", nowIso(),
  ]);

  // One HOLD per (dispatch, reason): a level-triggered loop keeps polling, but a
  // human is told once per distinct absence rather than every 60 seconds.
  const seenKey = `${sid}\tHOLD\t${dispatchId}\t${reason}`;
  if (seenContains(seenKey)) return true;
  fs.appendFileSync(
    OBSERVATIONS_LOG,
    pyDumps({
      kind: "HOLD",
      sid,
      dispatch_id: dispatchId,
      emitted_at: nowIso(),
      reason,
      completion_fact: null,
      outcome: "unknown",
      review_required: true,
    }) + "\n",
  );
  fs.appendFileSync(OBSERVATIONS_SEEN, seenKey + "\n");
  const note = `HOLD sid=${sid} reason=${reason} — no completion fact observed; outcome unknown, still polling`;
  emitAlert(note);
  if (commandExists(TELEPTY)) {
    runQuiet(TELEPTY, ["inject", "--from", TRACKER_SID, ORCH_SID, note]);
  }
  return true;
}

// ── subcommands ─────────────────────────────────────────────────────────────
function cmdCheck(): void {
  const now = nowIso();
  // Candidates: still-open dispatches whose expected_report_by has elapsed. A
  // corrupt/unavailable registry makes this call fail, and the tick stops before
  // any actuation — fail-closed by construction.
  const listed = registryCapture([
    "list", "--live", "--due-before", now,
    "--fields", "assigned.sid,cwd,ref_path,dispatched_at,re_dispatch_count,transport.inject_id,dispatch_id",
  ]);
  if (listed.status !== 0) process.exit(listed.status);

  let processed = 0;
  for (const row of listed.stdout.split("\n")) {
    const f = row.split("\t");
    const sid = f[0] ?? "";
    if (!sid) continue;
    // `null` is the registry's literal for an absent/empty field.
    const cwd = f[1] === "null" ? "" : f[1] ?? "";
    const refPath = f[2] === "null" ? "" : f[2] ?? "";
    const dispatchedAt = f[3] ?? "";
    const rdc = !f[4] || f[4] === "null" ? "0" : f[4];
    const injectId = f[5] ?? "";
    const dispatchId = f[6] ?? "";
    processed += 1;

    if (sessionDisconnected(sid) === "DISCONNECTED") {
      fs.appendFileSync(DISCONNECTED_LOG, `${nowIso()} DISCONNECTED ${sid} skip\n`);
      // Connectivity, not outcome: a session that went away has said nothing
      // about whether the assigned work finished. Every operational actuation
      // below records WHAT it inferred and FROM WHAT.
      registryOrDie([
        "observe", "--sid", sid, "--kind", "session_disconnected_observed",
        "--field", "basis=telepty_list_health", "--field", "actuation=lifecycle_disconnected",
        "--now", nowIso(),
      ]);
      registryOrDie(["set-lifecycle", "--sid", sid, "--state", "disconnected", "--now", nowIso()]);
      continue;
    }

    // Named absence blocks the git-evidence fallback below (§8.3.2). It does NOT
    // stop the operational branches — a disconnect, an error surface or a stuck
    // welcome screen still need actuating, and none of them settles anything.
    let evidenceBlocked = false;
    let ledger = "available";
    if (pollObservationsAndHold(sid, dispatchId, injectId)) {
      evidenceBlocked = true;
      ledger = "unavailable";
    }
    const screen = readScreen(sid, 60);
    const stateJson = probeFromScreen(sid, screen);
    const actionJson = policyForTracker(stateJson);
    const cls = jsonGet(stateJson, "detail.tracker_class") || "blank";
    const action = jsonGet(actionJson, "action");
    const status = jsonGet(actionJson, "status");
    recordClassification(sid, cls);

    if (status === "stuck_error") {
      emitAlert(`STUCK_ERROR sid=${sid}`);
      registryOrDie([
        "observe", "--sid", sid, "--kind", "error_surface_observed", "--field", `class=${cls}`,
        "--field", "basis=screen_surface_classification", "--field", "actuation=lifecycle_stuck_error",
        "--field", `observation_ledger=${ledger}`, "--now", nowIso(),
      ]);
      registryOrDie(["set-lifecycle", "--sid", sid, "--state", "stuck_error", "--now", nowIso()]);
    } else if (action === "REDISPATCH" && status === "stuck_welcome") {
      emitAlert(`STUCK_WELCOME sid=${sid}`);
      registryOrDie([
        "observe", "--sid", sid, "--kind", "welcome_surface_observed",
        "--field", "basis=screen_surface_classification", "--field", "actuation=redispatch_attempted",
        "--field", `observation_ledger=${ledger}`, "--now", nowIso(),
      ]);
      registryOrDie(["set-lifecycle", "--sid", sid, "--state", "stuck_welcome", "--now", nowIso()]);
      maybeRedispatch(sid, cwd, refPath, dispatchedAt, rdc);
    } else if (cls === "active") {
      registryOrDie([
        "observe", "--sid", sid, "--kind", "deadline_extended",
        "--field", "basis=screen_surface_classification", "--field", "actuation=expected_report_by_plus_15m",
        "--field", `observation_ledger=${ledger}`, "--now", nowIso(),
      ]);
      bumpExpected(sid);
    } else if (!evidenceBlocked) {
      gitCheckAndObserve(sid, cwd, dispatchedAt, screen);
    }
  }
  process.stdout.write(`tracker check: ${processed} entries processed\n`);
}

/** `%-Ns` — left-justified, minimum width N, never truncated. */
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function cmdStatus(sid: string): void {
  const get = (pointer: string): string => chomp(registryCapture(["get", "--sid", sid, "--pointer", pointer]).stdout);
  if (sid) {
    process.stdout.write(
      `${pad(sid, 40)} ${pad(get("outcome.state"), 8)} ${pad(get("lifecycle.state"), 26)} ` +
        `${pad(get("gate.state"), 14)} exp=${get("expected_report_by")}\n`,
    );
    return;
  }
  const listed = registryCapture([
    "list", "--fields", "assigned.sid,outcome.state,lifecycle.state,gate.state,expected_report_by,re_dispatch_count",
  ]);
  for (const row of listed.stdout.split("\n")) {
    if (!row) continue;
    const c = row.split("\t");
    process.stdout.write(
      `${pad(c[0] ?? "", 40)} ${pad(c[1] ?? "", 8)} ${pad(c[2] ?? "", 26)} ${pad(c[3] ?? "", 14)}` +
        ` exp=${c[4] ?? ""} rdc=${c[5] ?? ""}\n`,
    );
  }
  // pipefail: a failed listing is the command's failure, not an empty table.
  if (listed.status !== 0) process.exit(listed.status);
}

/**
 * Retired lifecycles age out after a day. A dispatch whose outcome is still
 * unknown is never pruned: its record is the only evidence the work was handed
 * out at all, and 0.8.0 has no way to learn it finished.
 */
function cmdPrune(): void {
  process.exit(runInherit(DISPATCH_REGISTRY_PY, ["prune", "--older-than-seconds", "86400"]));
}

function usage(stream: NodeJS.WriteStream): void {
  stream.write(USAGE + "\n");
}

function main(argv: string[]): void {
  if (argv.length === 0) {
    usage(process.stdout);
    process.exit(4);
  }
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case "check":
      cmdCheck();
      return;
    case "status":
      cmdStatus(rest[0] ?? "");
      return;
    case "prune":
      cmdPrune();
      return;
    case "-h":
    case "--help":
      usage(process.stdout);
      return;
    default:
      process.stderr.write(`unknown: ${cmd}\n`);
      usage(process.stderr);
      process.exit(4);
  }
}

main(process.argv.slice(2));
