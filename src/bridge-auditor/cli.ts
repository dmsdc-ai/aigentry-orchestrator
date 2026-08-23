// orchestrator-bridge-auditor — warn-only duplicate orchestrator-bridge detector
// (tq#620, the belt for the #618 recurrence), ported from
// bin/orchestrator-bridge-auditor.sh by #899 tranche 5 (ba899).
//
// Spec:        docs/specs/2026-06-13-orchestrator-bridge-singleton-enforcement.md
// Disposition: docs/reports/2026-08-18-899-t5-bridge-auditor-disposition.md
//              (every measurement cited below, 27 hermetic rows against the
//              original bash at c95fb34)
//
// One audit pass. It DETECTS more than one live `telepty allow --id <ORCH_SID> `
// bridge in a `ps` snapshot and pushes ONE HOLD inject to the orchestrator naming
// every bridge pid with its `etime` age, flagging the oldest as the LIKELY-stale
// candidate, plus the `kill -9` remedy. Runs on the existing reconcile tick
// (src/reconciler/cli.ts:1300-1301, step 0d — no new daemon, §1 경량).
//
// ⚠️ HARD CONSTRAINT, WARN AND NEVER KILL (#606). Orchestrator bridge cleanup is
// USER-ONLY: a background reconcile process is neither the user nor an ancestor of
// either bridge, so it cannot apply boot.sh's self/ancestor protection and could
// kill the LIVE one. THIS FILE CONTAINS NO KILL PATH AND MUST NEVER GROW ONE —
// no `kill`, no `process.kill`, no SIGTERM/SIGKILL, no signal argument anywhere.
// `kill -9` appears in exactly one place, inside the HOLD text a HUMAN reads. The
// two children below are `ps` and `telepty inject`, and that is the whole set.
// tests/dispatch/T127 asserts this twice: a `kill` recorder stub that must stay
// empty, and a static scan of this file's COMPILED output for signal primitives.
// tests/dispatch/T57 block E is the original assertion and still passes.
//
// WHAT CHANGED, and what was measured for it (Rule 38).
//
//   D1 FIXED on the orchestrator's GO — an unwritable state dir used to SUPPRESS
//      the duplicate-bridge HOLD entirely. The bash `emit_alert` was
//      `printf … | tee -a "$ALERTS_LOG" >&2`, and while its `mkdir -p` was
//      best-effort (`2>/dev/null || true`) the `tee` was NOT: under
//      `set -euo pipefail` a tee that cannot open alerts.log fails the pipeline and
//      kills the script at bash :119 — FIVE LINES BEFORE the inject at :124.
//      Measured (disposition row 24, `DISPATCH_STATE_DIR` under a regular file, two
//      bridges): `rc=1`, `tee: …/alerts.log: Not a directory`, and NO INJECT. The
//      detector had already succeeded; only the escalation was lost. In production
//      that is invisible: `runQuiet` at src/reconciler/cli.ts:1301 discards both
//      stdio streams, so the sole surviving signal is one
//      `ERR bridge-auditor non-zero (continuing)` line, indistinguishable from any
//      other non-zero — the #618 belt silently gone while the tick logs success.
//      Now: the alerts.log append is best-effort like the mkdir already was, the
//      stderr copy is emitted either way, and THE PASS CONTINUES TO THE INJECT.
//      Row 24 becomes rc 0 + the alert on stderr + the HOLD delivered. Every other
//      row is byte-unchanged. tests/dispatch/T127 block J measures it from both
//      sides (BRIDGE_PARITY_ORIGINAL=1 asserts the original's rc 1 + no inject).
//
//   D2 REPRODUCED VERBATIM — `--help` was `sed -n '30,40p' "$0"`, a slice of the
//      script's own comment header, which after the port has no source to slice.
//      The 498 bytes moved to ./usage.ts unchanged, INCLUDING the two warts that
//      hardcoded line range carries (it opens on a dangling sentence fragment and
//      ends one line early, hiding the `TELEPTY` seam). See usage.ts.
//
//   D3 FIXED BY #931 (was: REPRODUCED, named for a ticket). The marker was tested
//      against the WHOLE `command` column, so a process that merely MENTIONS
//      `telepty allow --id <sid> ` was counted as a bridge, printed as one, and
//      could be named `likely-stale=oldest=` in a HOLD that tells the operator to
//      `kill -9` it. Measured in the wild, not only in a fixture: on the port host,
//      `ps -eo pid,etime,command` piped into a grep for the marker returned 3 hits
//      where a clean snapshot returned 1 — the two extras were the measuring shell
//      itself (`/bin/zsh -c '… awk '\''$0 ~ ("telepty allow --id orchestrator ")…'`),
//      real live processes whose only sin was naming the marker in their own argv.
//      The snapshot-then-parse split (bash :74-79, kept below) prevented this
//      process from matching ITSELF, and nothing else.
//
//      Why it mattered more than a miscount: with those extras counted the pass
//      fires a duplicate HOLD, and `likely-stale=oldest` then resolves to the OLDEST
//      member of the set — the genuine long-lived bridge, because the false
//      positives are short-lived wrappers. The one line an operator acts on named
//      the LIVE bridge as the one to kill.
//
//      The fix is an argv-SHAPE match (see isOrchestratorBridge below), adopted from
//      src/orchestrator-boot/cli.ts where the same matcher already guards the KILL
//      site. Of the three sites D3 named, bin/session-reconciler.sh:415 no longer
//      carries the marker at all (the reconciler port left only a descriptive
//      comment at src/reconciler/cli.ts:1297), so the two that still decide anything
//      now share one definition of "is this a bridge". T127 block H asserts the
//      decision and keeps an ORIGINAL arm recording what the bash did; H2 reproduces
//      the wild 3-hits-for-1-bridge measurement and the live-bridge misidentification
//      it caused; H3 pins that a REAL duplicate is still caught, including a bridge
//      with no `node` token and an absolute telepty path.
//
//      STILL WARN-ONLY (#606). #931 narrowed detection and added no kill path.
//
//   D4 DEVIATION — `ORCHESTRATOR_SID` IS MATCHED LITERALLY HERE, and the bash
//      matched it AS A REGEX. `awk -v s="$ORCH_SID"` then `$0 ~ ("telepty allow
//      --id " s " ")` is a DYNAMIC regex, so the sid went through two layers of
//      interpretation. Measured on the original, three bridges with sids
//      `orchXtor`/`orchYtor`/`orch.tor`:
//        * `ORCHESTRATOR_SID=orch.tor` → `count=3`, a spurious HOLD naming all
//          three pids and `likely_stale=333`. A single `.` — plausible in any
//          hostname-shaped sid — over-matches every sibling.
//        * `ORCHESTRATOR_SID='orch['` → the whole auditor DIED, `rc=2`,
//          `awk: nonterminated character class` on stderr. rc 2 now collides with
//          bin/lib/node-shim.sh's own "dist not found" code.
//        * `ORCHESTRATOR_SID='orch\ttor'` → `-v` expanded the escape to a TAB, so
//          the marker matched nothing and the pass exited 0 in silence.
//      A literal `includes()` is what the marker MEANS, and the deviation only ever
//      matches NARROWER: a real bridge's command line contains the sid literally
//      (telepty is invoked with it), so no genuine duplicate can be missed, no new
//      false positive is possible, and the rc-2 crash arm disappears. Reproducing
//      awk's ERE-from-config in node would import both the over-match and the
//      crash for the sake of byte-identity on a config value no operator sets that
//      way. Named rather than silent (Rule 38); T127 block I pins all three rows
//      from both sides. Reversing it is one line if the orchestrator wants the
//      regex back.
//
//   NOT CHANGED, on purpose: `emit_alert` still runs its mkdir on EVERY call
//      rather than once (two under `--dry-run`), the oldest-of tie still resolves
//      to the FIRST of equal `etime` (`ss[i] > maxs`, strict), a `<defunct>` line
//      is still skipped, a non-numeric pid column (the `PID ELAPSED COMMAND`
//      header) is still dropped, and every child failure is still swallowed to
//      exit 0 — a missing `telepty` included. All measured, all reproduced.
//
// Article 17 (무의존): node stdlib + telepty. The one `python3 -c` was a CLOCK READ
// (`datetime.now(utc).isoformat(timespec="seconds")` + `Z`, with a `date -u`
// fallback), so python3 stops being a dependency of this script entirely and no
// `.py` child is left behind — the bash header's "pure bash + telepty, no python"
// claim becomes true. awk, sed, tee, mkdir and printf are node-internal now; `ps`
// and `telepty inject` stay subprocesses with IDENTICAL argv.
//
// Rule 26: ZERO platform branches. There was nothing to enumerate —
// `grep -nE 'uname|os_type|Darwin|Linux|pmset|ioreg|sw_vers|OSTYPE'` over the bash
// matched only a COMMENT asserting the cross-OS property (:29). `ps -eo
// pid,etime,command` is the same argv on BSD/macOS and GNU/Linux, and the
// `[[DD-]HH:]MM:SS` parser below exists precisely so no `ps` dialect needs a branch.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR / REPO_DIR were `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` and
// `$SCRIPT_DIR/..` (bash :49-50). The shim exports SCRIPT_DIR so a symlinked
// entrypoint still resolves — and, load-bearing here, so a control workspace writes
// its OWN state/dispatch/alerts.log: `init` copies bin/ out of the package and
// leaves dist/ behind, so a REPO_DIR derived from THIS file's location would point
// at the installed PACKAGE root and every workspace would alert into it while its
// own alerts.log stayed empty. tests/dispatch/T128 pins that. The fallback keeps a
// direct `node dist/src/bridge-auditor/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");

const ORCH_SID = env.ORCHESTRATOR_SID || "orchestrator";
const SINGLETON_PS_CMD = env.SINGLETON_PS_CMD || "ps";
const TELEPTY = env.TELEPTY || "telepty";
const STATE_DIR = env.DISPATCH_STATE_DIR || path.join(REPO_DIR, "state/dispatch");
const ALERTS_LOG = path.join(STATE_DIR, "alerts.log");

/**
 * `now_iso()` (bash :63-67): AUDITOR_NOW verbatim when non-empty, else the current
 * UTC time at SECONDS precision with a `Z` suffix — what python's
 * `isoformat(timespec="seconds").replace("+00:00","Z")` and the `date -u
 * +%Y-%m-%dT%H:%M:%SZ` fallback both produced. `toISOString()` carries
 * milliseconds, so they are sliced off rather than rounded, exactly as
 * `timespec="seconds"` truncates.
 */
function nowIso(): string {
  if (env.AUDITOR_NOW) return env.AUDITOR_NOW;
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/**
 * `emit_alert()` (bash :69-72). The line goes to alerts.log AND to stderr, which is
 * what `| tee -a … >&2` did.
 *
 * BOTH WRITES ARE BEST-EFFORT, and that is D1: the bash's `tee` was the one
 * un-guarded command in the script, so a state dir that could not be written aborted
 * the pass before the HOLD inject. A detector that cannot write its log must still
 * be able to raise the alarm.
 */
function emitAlert(msg: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    /* best-effort, exactly as `mkdir -p … 2>/dev/null || true` was */
  }
  const line = `${nowIso()} ${msg}\n`;
  try {
    fs.appendFileSync(ALERTS_LOG, line);
  } catch {
    /* D1: the log is a record, not a precondition for escalating */
  }
  try {
    process.stderr.write(line);
  } catch {
    /* a closed stderr must not abort a pass either */
  }
}

/**
 * awk's numeric coercion of a field: the leading numeric prefix, else 0. `"08"` is
 * 8 (not octal), `""` and `"abc"` are 0. Used only by etimeSecs below.
 */
function awkNum(s: string): number {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * `etime_secs()` (bash :81-88) — `[[DD-]HH:]MM:SS` to seconds, so the oldest bridge
 * is found portably across `ps` dialects. Reproduced arm for arm, INCLUDING the
 * shapes that are not real `etime` values: a value with two `-` separators keeps
 * `t = e` (the day part is only taken when there is exactly one), and a value with
 * no `:` at all is read as bare seconds (`42` → 42, measured in row 20).
 */
function etimeSecs(e: string): number {
  let d = 0;
  let t = e;
  const dash = e.split("-");
  if (dash.length === 2) {
    d = awkNum(dash[0]);
    t = dash[1];
  }
  const c = t.split(":");
  if (c.length === 3) return d * 86400 + awkNum(c[0]) * 3600 + awkNum(c[1]) * 60 + awkNum(c[2]);
  if (c.length === 2) return d * 86400 + awkNum(c[0]) * 60 + awkNum(c[1]);
  return d * 86400 + awkNum(c[0]);
}

// --- argv (bash :54-61). `-h`/`--help` wins wherever it appears; anything else is
// `unknown: <arg>` on stderr and exit 4, INCLUDING an empty argv element (row 13
// measured `unknown: ` with its trailing space). The whole of argv is consumed
// before `ps` is ever run, so `--dry-run bogus` exits 4 having emitted no alert
// (row 10). DRY_RUN IS ARGV-ONLY AND MUST STAY THAT WAY: bash :54 is a plain
// `DRY_RUN=0` assignment, never an env read, and src/reconciler/cli.ts:45 documents
// that this script "sets its own". The reconciler takes its own DRY_RUN from argv
// alone (cli.ts:1154,1166), so `DRY_RUN=1 bin/session-reconciler.sh` — no
// `--dry-run` — leaves it acting AND puts DRY_RUN=1 into the `{ ...env, TELEPTY }`
// it hands step 0d. Reading env here would silently downgrade the #618 HOLD to a
// log line on that host, forever. Measured on the original: the inject is still
// sent. tests/dispatch/T127 block G pins it. ---
let DRY_RUN = 0;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--dry-run") {
    DRY_RUN = 1;
  } else if (a === "-h" || a === "--help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`unknown: ${a}\n`);
    process.exit(4);
  }
}

// --- Snapshot once, then parse the captured string (bash :74-99). Snapshotting
// first is what stops this process's own pipeline from matching the marker; it does
// nothing about OTHER processes that mention it (D3). `ps`'s own stderr is
// discarded and its exit status ignored — a lister that fails or is missing yields
// an empty snapshot and a silent exit 0 (rows 21, 23). ---
const ps = spawnSync(SINGLETON_PS_CMD, ["-eo", "pid,etime,command"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const snapshot = ps.stdout || "";

/**
 * #931 — is this row's ARGV a `telepty allow --id <ORCH_SID>` invocation?
 *
 * This USED to be `line.includes("telepty allow --id <sid> ")`, i.e. a substring test
 * against the whole `command` column, which made any process that merely MENTIONS the
 * marker a bridge (D3). Measured in the wild on this host: two `zsh -c` measurement
 * wrappers were counted alongside the real bridge, and since the HOLD names
 * `likely-stale=oldest=` and an operator's `ps` snapshot outlives a short-lived
 * wrapper, the oldest of that set was the LIVE two-day-old bridge — the one line in
 * the alert an operator acts on pointed at the process they must not kill.
 *
 * A substring match is not a process identity. This asks whether the process IS the
 * bridge:
 *
 *   [node] <…/>telepty allow … --id <sid> …
 *    ^opt   ^executable token   ^whole-token sid
 *
 * Adopted VERBATIM from src/orchestrator-boot/cli.ts:376's isOrchestratorBridge — the
 * same matcher that already landed at the KILL site, which is the one place where
 * getting this wrong is fatal. Two detectors of "is this a bridge" that disagree is
 * the actual hazard; this is the third site named in D3
 * (bin/orchestrator-boot.sh:88, bin/session-reconciler.sh:415, here).
 *
 * The whole-token sid comparison is what the marker's trailing space was for
 * (`orchestrator-2` is not `orchestrator`, T57 block D), and it keeps D4's literal
 * semantics: no regex, so `orch.tor` still matches only `orch.tor` (T127 block I).
 *
 * WARN-ONLY IS UNCHANGED (#606). This narrows what is DETECTED; it adds no kill path,
 * and the confirm-live-pid hedge in the HOLD text stays exactly as it was.
 */
const INTERPRETERS = new Set(["node", "nodejs"]);
function isOrchestratorBridge(cmd: string[]): boolean {
  if (cmd.length === 0) return false;
  let i = 0;
  if (INTERPRETERS.has(path.basename(cmd[0]))) i = 1;
  if (i >= cmd.length) return false;
  if (path.basename(cmd[i]) !== "telepty") return false;
  if (cmd[i + 1] !== "allow") return false;
  for (let j = i + 2; j + 1 < cmd.length; j++) {
    if (cmd[j] === "--id" && cmd[j + 1] === ORCH_SID) return true;
  }
  return false;
}

const bridges: { pid: string; etime: string; secs: number }[] = [];
for (const line of snapshot.split("\n")) {
  if (line.includes("<defunct>")) continue; // skip zombies
  const f = line.trim().split(/\s+/); // awk's default FS: runs of whitespace
  if (/[^0-9]/.test(f[0])) continue; // numeric pids only — drops the ps header row
  // `ps` has already flattened argv into one column, so the tokens are recovered by
  // the same whitespace split — lossy for an argument containing a space, but every
  // token this matcher looks at (the executable, `allow`, `--id`, the sid) is one
  // shell word by construction.
  if (!isOrchestratorBridge(f.slice(2))) continue;
  bridges.push({ pid: f[0], etime: f[1], secs: etimeSecs(f[1]) });
}

// count <= 1 → the normal case. Silent no-op (must not be noisy on every tick).
const count = bridges.length;
if (count <= 1) process.exit(0);

// Duplicate: build "pid(etime)" list + the oldest (likely-stale) pid. `>` is strict,
// so a tie of equal etime flags the FIRST (row 19).
let oldest = bridges[0];
for (const b of bridges) if (b.secs > oldest.secs) oldest = b;
const pidsStr = bridges.map((b) => `${b.pid}(${b.etime})`).join(", ");

const msg =
  `HOLD: orchestrator-bridge DUPLICATE | N=${count} bridges (expected 1) | ` +
  `pids: ${pidsStr} | likely-stale=oldest=${oldest.pid} | remedy: confirm the ` +
  "live-TUI pid, then `kill -9 <stale-pid>` — USER-ONLY (automation must NOT kill). " +
  "ref #618";

emitAlert(
  `ORCH_BRIDGE_DUPLICATE count=${count} pids=[${pidsStr}] ` +
    `likely_stale=${oldest.pid} dry_run=${DRY_RUN}`,
);

// Act-only: the HOLD inject is skipped under --dry-run (mirrors the reconciler's
// act-only auditor wiring). Best-effort — the alert above already recorded it, and
// a refused or missing transport must not turn a detected duplicate into a non-zero
// exit (row 25). The HOLD text is ONE argv element, so a pid list can never become
// a flag or a word split.
if (DRY_RUN === 0) {
  spawnSync(TELEPTY, ["inject", "--submit", ORCH_SID, msg], { stdio: "ignore" });
} else {
  emitAlert(`ORCH_BRIDGE_DUPLICATE would-HOLD (dry-run) → ${ORCH_SID}`);
}

process.exit(0);
