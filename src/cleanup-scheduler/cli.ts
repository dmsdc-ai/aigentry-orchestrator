// dispatch-cleanup-scheduler.sh's implementation, ported to TypeScript (#899 t4).
//
// This is a PORT, not a redesign (Rule 29 + Constitution Art. 1): every flag, exit
// code, stdout/stderr line and subprocess argv is the shell script's, preserved
// deliberately. bin/dispatch-cleanup-scheduler.sh is now an exec shim onto this
// file, so the reconciler's Layer-D step (src/reconciler/cli.ts:1318, `tick` every
// 60s from launchd) and bin/inject-handler.sh's four call shapes (`schedule` at :119
// and :134, `defer` at :147, `cancel` at :153) are unchanged. What `--help` prints
// lives in ./usage.ts.
//
// THIS SCRIPT SOURCED NOTHING. Measured before the port: zero `.`/`source` lines, so
// unlike tranches 2a/2c/3a there is no `bash -c '. lib; fn'` door and no wh-cli.sh
// verb here. It also talks to no daemon — no telepty, no curl, no jq — which is why
// no test of it can leak an inject to :3848. Its only two children stay children:
//
//   bin/dispatch-registry.py  → `get --sid <sid> --pointer keep_alive`, identical
//     argv, stderr dropped. BOTH fail-CLOSED arms are preserved verbatim: not
//     executable ⇒ treated as keep_alive, non-zero exit ⇒ treated as keep_alive.
//     That is telepty#60 Stage A (docs/designs/2026-07-30-…:274) — a registry it
//     cannot read must never be read as permission to clean a session up.
//   bin/session-cleanup.sh    → `<sid>`, identical argv, stdio inherited, behind the
//     same `[ -x ]` gate, with the same non-fatal arm. It is itself a TS shim now
//     (tranche 2a); in-process would fork the Rule 28 protected-sid refusal.
//
// The five python3 heredocs are the scheduler's OWN logic — clock, ISO arithmetic,
// record shaping, one comparison — and become in-process TS. python3 stops being a
// direct dependency and stays a transitive one through dispatch-registry.py's
// shebang, which is why the PATH hardening stays in the shim (see its header).
//
// NO `process.platform` BRANCH EXISTS HERE, because the shell had no OS arm:
// `grep -nE 'uname|os_type|Darwin|Linux|pmset|ioreg'` matched nothing. The only
// macOS-shaped thing in the file was the `/opt/homebrew/bin` PATH prefix, which is a
// string, not a branch, and it stays in the shim byte-identical. Article 17 holds
// with no branch to name — same as tranches 1, 1b, 2a, 2c, 3a.
//
// THE TWO DEVIATIONS FROM THE BASH (Rule 38 — both pre-existing defects, both
// decided by the orchestrator rather than by me; see
// docs/reports/2026-08-17-899-t4-scheduler-disposition.md §7):
//
//   D1  A non-numeric `--grace-seconds` / `--minutes` used to TRUNCATE
//       state/dispatch/cleanup-pending.json to zero bytes. `python3 - <<PY |
//       atomic_write_json` runs the writer half regardless of the producer's fate:
//       `cat` saw EOF, wrote an empty tmpfile, and `mv` committed it; `pipefail`
//       reported the failure only after the damage. Every later read then hit
//       `except Exception: pending = []`, so the entire fleet's pending Layer-D
//       queue was gone silently and no worker was ever retired again.
//       bin/inject-handler.sh:130-134 builds `--grace-seconds "$grace"` from
//       `payload.grace_seconds` of an unauthenticated inject envelope and calls it
//       `>/dev/null 2>&1 || true`, so one CLEANUP_REQUEST carrying
//       `grace_seconds: "soon"` did it with no operator-visible trace.
//       NOW: the integer is parsed BEFORE the file is touched. rc stays 1, stdout
//       stays empty, one stderr line names the flag and the value, and the queue
//       file is byte-unchanged. Pinned by tests/dispatch/T120 block I. Validating
//       the payload at the trust boundary is inject-handler's own ticket, not this
//       port's (Rule 29).
//   D2  `list` had never worked on any CPython: `cmd_list` put `\"`-escaped quotes
//       inside an f-string expression in `python3 -c '…'`, which is a compile-time
//       SyntaxError, so the verb failed even on an empty queue. Broken since the
//       file was created (b7829ec, ADR 2026-05-20) with zero callers in tests/,
//       src/ or bin/. NOW: it prints the format the code obviously intended and
//       exits 0. Pinned by T120 block J so it cannot rot again.
//
// Timestamps that are not the `…Z` form this script itself writes are out of
// contract: the port treats a stamp with no zone as UTC and normalizes any explicit
// offset to `Z`, where python's `fromisoformat`/`isoformat` would have kept a
// non-UTC offset (and raised on comparing an aware stamp with a naive one). Nothing
// produces such a stamp — `now_iso`, SCHEDULER_NOW in all four guards, and every
// record this file writes are `…Z`.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` — the repo's (or
// the init workspace's) bin/. The shim exports it so a symlinked entrypoint still
// locates bin/ helpers; the fallback keeps a direct
// `node dist/src/cleanup-scheduler/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = env.DISPATCH_STATE_DIR || path.join(REPO_DIR, "state/dispatch");
const PENDING_JSON = path.join(STATE_DIR, "cleanup-pending.json");
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY || path.join(SCRIPT_DIR, "dispatch-registry.py");
const SESSION_CLEANUP_SH = env.SESSION_CLEANUP_SH || path.join(SCRIPT_DIR, "session-cleanup.sh");
const NOW_OVERRIDE = env.SCHEDULER_NOW || "";

// Load-time, exactly as the shell: both run BEFORE argv is looked at, so `--help`
// and an unknown verb also create the state dir and seed the empty queue.
fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(PENDING_JSON)) fs.writeFileSync(PENDING_JSON, "[]\n");

/** One pending record. Unknown keys are preserved: `defer` mutated the record in place. */
type Rec = Record<string, unknown> & { sid?: unknown };

// ── helpers ─────────────────────────────────────────────────────────────────
/** bash `$(cmd)`: command substitution strips every trailing newline. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

/** bash `[ -x path ]` — false for a path that does not exist. */
function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function die(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}

function usage(code: number): never {
  console.log(USAGE);
  process.exit(code);
}

/** `now_iso()`: SCHEDULER_NOW verbatim, else `isoformat(timespec="seconds")` + Z. */
function nowIso(): string {
  if (NOW_OVERRIDE) return NOW_OVERRIDE;
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** `datetime.fromisoformat(s.replace("Z","+00:00"))`. null where python would have raised. */
function parseStamp(s: string): { ms: number; zoned: boolean } | null {
  if (!s) return null;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  const ms = Date.parse(zoned ? s : `${s}Z`);
  return Number.isNaN(ms) ? null : { ms, zoned };
}

/** `(dt + delta).isoformat(timespec="seconds").replace("+00:00","Z")`. */
function fmtStamp(ms: number, zoned: boolean): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "") + (zoned ? "Z" : "");
}

/** `atomic_write_json`: tmpfile in the same dir + rename, so a crash cannot leave a partial queue (pattern #114). */
function writePending(pending: Rec[]): void {
  // python's `json.dumps(indent=2, ensure_ascii=False)` for an array of flat
  // string-valued records is byte-identical to this, trailing `print` newline
  // included. T120 block G pins the bytes.
  const tmp = `${PENDING_JSON}.tmp.${process.pid}.${Math.floor(Math.random() * 1e6)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`);
  fs.renameSync(tmp, PENDING_JSON);
}

/**
 * `try: pending = json.load(open(path))` / `except Exception: pending = []`.
 *
 * Unreadable or malformed bytes read as an empty queue, exactly as all five heredocs
 * did. Valid JSON that is not an array was NOT covered by that `try` — it raised an
 * AttributeError inside the comprehension and, pre-D1, took the file with it. It is
 * refused here instead: the queue file is state this process owns, and D1's rule is
 * that a failure leaves it byte-unchanged.
 */
function readPending(verb: string): Rec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(PENDING_JSON, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    die(`${verb}: ${PENDING_JSON} is not a JSON array — refusing to overwrite it`, 1);
  }
  return parsed as Rec[];
}

/**
 * `int(os.environ[...])`, moved ahead of every write. See D1 in this file's header.
 *
 * Narrower than python's `int()` on garbage only: `1_000` and non-ASCII digit forms,
 * which python accepted, are refused here. Nothing emits either.
 */
function requireInt(verb: string, flag: string, raw: string): number {
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    die(`${verb}: ${flag} expects an integer, got '${raw}'`, 1);
  }
  return parseInt(raw.trim(), 10);
}

/**
 * `x="$2"; shift 2` under `set -u`. A flag with no value was a locale-dependent
 * `$2: unbound variable` and exit 1 — the code and the fact of a message are the
 * contract, the wording is the implementation's (T116's precedent, block B there).
 */
function value(verb: string, args: string[], i: number): string {
  const v = args[i + 1];
  if (v === undefined) die(`${verb}: ${args[i]} requires a value`, 1);
  return v;
}

// ── the registry door ───────────────────────────────────────────────────────
/** `is_keep_alive <sid>` — true when the dispatch opted out of automatic cleanup, AND on every failure. */
function isKeepAlive(sid: string): boolean {
  if (!executable(DISPATCH_REGISTRY_PY)) return true;
  const r = spawnSync(DISPATCH_REGISTRY_PY, ["get", "--sid", sid, "--pointer", "keep_alive"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error || (r.status ?? 1) !== 0) return true;
  return chomp(r.stdout ?? "") === "true";
}

// ── the five verbs ──────────────────────────────────────────────────────────
function cmdSchedule(args: string[]): void {
  const sid = args[0] ?? "";
  if (sid === "") die("schedule: <sid> required", 4);
  let grace = "60";
  let source = "layer-d-timeout";
  let reason = "";
  for (let i = 1; i < args.length; i += 2) {
    switch (args[i]) {
      case "--grace-seconds":
        grace = value("schedule", args, i);
        break;
      case "--source":
        source = value("schedule", args, i);
        break;
      case "--reason":
        reason = value("schedule", args, i);
        break;
      default:
        die(`schedule: unknown ${args[i]}`, 4);
    }
  }
  // The keep_alive gate runs BEFORE the grace parse, as in the shell: a keep_alive
  // sid with a bad --grace-seconds is skipped, not refused.
  if (isKeepAlive(sid)) {
    console.log(`[scheduler] keep_alive=true for ${sid} — skipping Layer D schedule`);
    return;
  }
  const graceN = requireInt("schedule", "--grace-seconds", grace);
  const reportTime = nowIso();
  const rt = parseStamp(reportTime);
  if (!rt) die(`schedule: cannot parse report time '${reportTime}'`, 1);
  const rec: Rec = {
    sid,
    report_time: reportTime,
    scheduled_cleanup_time: fmtStamp(rt.ms + graceN * 1000, rt.zoned),
    source,
  };
  if (reason) rec.preempt_reason = reason;
  // Idempotent on sid: the existing record is replaced, not duplicated.
  const pending = readPending("schedule").filter((p) => p.sid !== sid);
  pending.push(rec);
  writePending(pending);
  // `${grace}` is the RAW argument, as `$grace` was: `--grace-seconds 060` logs 060s.
  console.log(`[scheduler] scheduled cleanup sid=${sid} in ${grace}s (source=${source})`);
}

function cmdCancel(args: string[]): void {
  const sid = args[0] ?? "";
  if (sid === "") die("cancel: <sid> required", 4);
  writePending(readPending("cancel").filter((p) => p.sid !== sid));
  console.log(`[scheduler] cancelled pending cleanup for ${sid}`);
}

function cmdDefer(args: string[]): void {
  const sid = args[0] ?? "";
  if (sid === "") die("defer: <sid> required", 4);
  let minutes = "";
  let reason = "";
  for (let i = 1; i < args.length; i += 2) {
    switch (args[i]) {
      case "--minutes":
        minutes = value("defer", args, i);
        break;
      case "--reason":
        reason = value("defer", args, i);
        break;
      default:
        die(`defer: unknown ${args[i]}`, 4);
    }
  }
  if (minutes === "") die("defer: --minutes required", 4);
  const mins = requireInt("defer", "--minutes", minutes);
  const now = nowIso();
  const ndt = parseStamp(now);
  if (!ndt) die(`defer: cannot parse now '${now}'`, 1);
  const newSched = fmtStamp(ndt.ms + mins * 60_000, ndt.zoned);
  const pending = readPending("defer");
  const existing = pending.find((p) => p.sid === sid);
  if (existing) {
    // In place, so any other field the record carries survives — as the shell did.
    existing.scheduled_cleanup_time = newSched;
    existing.source = "explicit-request";
    if (reason) existing.preempt_reason = reason;
  } else {
    const rec: Rec = { sid, report_time: now, scheduled_cleanup_time: newSched, source: "explicit-request" };
    if (reason) rec.preempt_reason = reason;
    pending.push(rec);
  }
  writePending(pending);
  console.log(`[scheduler] deferred cleanup for ${sid} by ${minutes}m`);
}

function cmdTick(): void {
  const now = nowIso();
  const ndt = parseStamp(now);
  if (!ndt) die(`tick: cannot parse now '${now}'`, 1);
  // The due set is a SNAPSHOT taken before the first cleanup runs, as the shell's
  // tmpfile was; each fired sid is then dropped by its own read-modify-write, so a
  // crash mid-tick leaves the already-cleaned sids dropped and the rest pending.
  const due: string[] = [];
  readPending("tick").forEach((p, i) => {
    const sdt = parseStamp(typeof p.scheduled_cleanup_time === "string" ? p.scheduled_cleanup_time : "");
    if (!sdt) return; // python's `except Exception: continue` — the record is kept
    if (ndt.ms < sdt.ms) return;
    // `print(p["sid"])` was a KeyError here: a due record with no sid aborted the
    // tick and touched nothing. Kept loud rather than skipped silently — a queue
    // this file did not write is state corruption, and a tick that quietly steps
    // over it would hide that forever.
    if (typeof p.sid !== "string") {
      die(`tick: ${PENDING_JSON} record ${i} is due and has no sid — refusing to run`, 1);
    }
    due.push(p.sid);
  });
  let fired = 0;
  for (const sid of due) {
    if (sid === "") continue;
    if (executable(SESSION_CLEANUP_SH)) {
      const r = spawnSync(SESSION_CLEANUP_SH, [sid], { stdio: "inherit" });
      if (r.error || (r.status ?? 1) !== 0) console.log(`[scheduler] cleanup non-zero for ${sid}`);
    } else {
      console.error(`[scheduler] session-cleanup.sh not executable at ${SESSION_CLEANUP_SH}`);
    }
    // `cmd_cancel "$sid" >/dev/null`: re-read, drop, rewrite — one write per fired
    // sid, and the record goes even when the cleanup did not.
    writePending(readPending("tick").filter((p) => p.sid !== sid));
    fired += 1;
  }
  console.log(`[scheduler] tick fired=${fired}`);
}

function cmdList(): void {
  // D2: the format `cmd_list`'s f-string was written to produce. `:40s` is a
  // left-justified pad with no truncation.
  for (const p of readPending("list")) {
    const sid = typeof p.sid === "string" ? p.sid : "?";
    const sched = typeof p.scheduled_cleanup_time === "string" ? p.scheduled_cleanup_time : "?";
    const src = typeof p.source === "string" ? p.source : "?";
    const pr = typeof p.preempt_reason === "string" ? p.preempt_reason : "";
    console.log(`${sid.padEnd(40)} scheduled=${sched} src=${src}${pr ? ` reason=${pr}` : ""}`);
  }
}

function main(argv: string[]): void {
  if (argv.length === 0) usage(4);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case "schedule":
      cmdSchedule(rest);
      break;
    case "cancel":
      cmdCancel(rest);
      break;
    case "defer":
      cmdDefer(rest);
      break;
    case "tick":
      cmdTick();
      break;
    case "list":
      cmdList();
      break;
    case "-h":
    case "--help":
      usage(0);
      break;
    default:
      console.error(`unknown: ${cmd}`);
      usage(4);
  }
}

main(process.argv.slice(2));
