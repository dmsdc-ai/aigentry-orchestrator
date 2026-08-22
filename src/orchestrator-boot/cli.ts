// orchestrator-boot — the STANDARD control-tower (orchestrator) boot wrapper (#539,
// #905), ported from bin/orchestrator-boot.sh by #899 tranche 5 (ob899).
//
// Spec:        docs/specs/2026-06-13-orchestrator-bridge-singleton-enforcement.md
// Runbook:     docs/runbooks/2026-08-16-orchestrator-restart.md
// Disposition: docs/reports/2026-08-18-899-t5-orchestrator-boot-disposition.md
//              (every measurement cited below was taken against the original bash
//              at b300875 with ps/kill/telepty/curl recorder stubs — no real pid was
//              ever listed or signalled and no real DELETE was ever issued)
//
// THE ORDER IS THE CONTRACT: reconcile the daemon's registry record, then SIGKILL
// stale bridge processes, then hand the exec argv back to bin/orchestrator-boot.sh
// so THE USER'S SHELL — not this process — becomes the bridge.
//
// ⚠️ FOUR INVARIANTS, none of them negotiable:
//
//   1. NEVER KILL SELF OR ANY ANCESTOR. #539's whole point. The bash had two belts
//      and both survive the port. TEMPORAL: the guard runs strictly before the exec,
//      so the bridge this boot becomes does not exist yet. ANCESTRY: the ppid chain
//      from SINGLETON_SELF_PID up is walked and every pid on it is skipped, so
//      restarting from INSIDE a live orchestrator cannot kill the session it was
//      launched from. The port's self pid is node's rather than the boot shell's
//      (§SINGLETON_SELF_PID below) and the walk therefore covers a STRICT SUPERSET
//      of what bash protected. tests/dispatch/T131 block N drives it with a `ps`
//      recorder whose rows are this process's OWN real ancestry, with a genuine
//      ancestor dressed as a bridge; T40 block A keeps the fixture version.
//   2. SIGKILL, NEVER SIGTERM. telepty's closeAllowSession runs on the SIGTERM
//      handler and DELETE-cascades a 'Session destroyed' close to every co-bound
//      client — which is how the LIVE orchestrator self-exited on 2026-06-07. The
//      only signal argument in this file is the literal "-9". T40 block E and T131
//      block P (a static scan of the compiled JS) both pin it.
//   3. THE EXEC STAYS A REAL PROCESS REPLACEMENT. Node has no execve, so this file
//      does NOT spawn `telepty allow`. It prints the argv on stdout, one element per
//      line, and bin/orchestrator-boot.sh — the process the user's terminal
//      launched — `exec`s it. Node has already exited by then, so the shell becomes
//      the bridge exactly as it did in bash and there is no node generation left in
//      the middle to swallow a signal or a TTY. T131 block Q pins the shim.
//   4. THE TOKEN IS NEVER LOGGED. It goes into the curl header argument and nowhere
//      else, exactly as bin/lib/telepty-auth.sh requires.
//
// STDOUT IS NOW A CONTRACT CHANNEL. The bash wrote nothing to stdout (every line
// went through `log()` to stderr) and the port keeps that for LOGS, but stdout now
// carries the exec argv. So no child of this process may inherit stdout: `kill`,
// `ps`, `curl`, `telepty` and the credential door are all captured or ignored below,
// never `inherit`. A stray byte on stdout would be exec'd. T131 block R asserts
// stdout is EXACTLY the argv lines and nothing else.
//
// WHAT CHANGED, and what was measured for it (Rule 38).
//
//   D1 NEW REFUSAL, on the orchestrator's GO — an ORCHESTRATOR_SID containing a
//      CONTROL CHARACTER is refused with exit 2 instead of booting. The argv crosses
//      back to the shim as newline-delimited text, so a sid containing a newline
//      would split one argv element into two and the shell would exec a corrupted
//      command line. bash had no such hazard (it exec'd its own array) and no such
//      check; the port needs one, and refusing is the only answer that cannot
//      produce a wrong exec. Tab and CR are refused with it because bash's
//      `awk -v s=…` expanded escapes and silently matched nothing (bridge-auditor
//      D4's third row) — a sid no marker can ever match is a disarmed singleton
//      guard, and this is the site where that means a duplicate bridge lives. Exit 2
//      shares its code with bin/lib/node-shim.sh's "dist not found"; the stderr line
//      names the field, which is what tells the two apart. T131 block S.
//
//   D2 DEVIATION, named — `jq` IS GONE, and with it a precondition on the DELETE.
//      The bash shelled out to `jq` four times; the port parses in-process. Measured
//      on the original with a PATH containing no `jq` and a listing that was STALE
//      with 0 clients: the bash printed "registry reconcile SKIPPED — the listing was
//      not JSON (daemon/CLI version mismatch?)" and issued NO DELETE. So on a
//      jq-less host the #905 remediation was unavailable AND the message blamed the
//      daemon. The port reconciles there. That is the outage class #905 exists to
//      end, and it is still a change to when a DELETE aimed at the orchestrator's own
//      id can fire, so it is named here rather than absorbed. T131 block T runs both
//      implementations with jq off PATH.
//      Four jq behaviours ARE reproduced, because they are semantics rather than
//      plumbing (all measured, disposition §7): a listing of literal `null` or
//      `false` fails `jq -e .` and is reported as "not JSON"; `.healthStatus //
//      .status` falls through on null AND false, not merely on absent; `tostring`
//      renders a null client count as the STRING "null", which lands in the
//      "N client(s) are attached" arm rather than the "no client count" one; and a
//      listing that is not an array yields "no record" (bash got there by way of a
//      jq error on `.id` of a non-object — see LISTING SHAPE below).
//
//   D3 FIXED — the sid is matched LITERALLY where bash built a DYNAMIC REGEX from it
//      (`awk -v s="$ORCH_SID" '$0 ~ ("telepty allow --id " s " ")'`). Measured on the
//      original against a 4-row fixture: `ORCHESTRATOR_SID=orch.tor` SIGKILLED THREE
//      PIDS — `orchXtor`, `orch1tor` and a process that merely mentioned the string —
//      and `ORCHESTRATOR_SID='orch['` died with `awk: nonterminated character class`
//      and then announced `singleton guard done: killed=0`, i.e. the duplicate-bridge
//      outcome #539 exists to prevent, reported as a success. At the bridge-auditor
//      the same defect costs a spurious warning (D4 there); here it costs `kill -9`
//      against processes that were never bridges, and a silently disarmed guard. The
//      literal comparison is what the marker MEANS and can only ever match narrower.
//      T131 block U pins both rows from both sides.
//
//   D4 FIXED, on the orchestrator's OVERRIDE — MENTION IS NO LONGER A BRIDGE. bash
//      tested the marker as a SUBSTRING OF THE WHOLE `pid ppid command` ROW, so any
//      process whose command line contained `telepty allow --id <sid> ` was SIGKILLed.
//      An operator running `pgrep -fl telepty` or a `grep` for the marker while
//      diagnosing a stuck orchestrator is exactly such a process, and the remedy
//      would have killed it. isOrchestratorBridge() below matches ARGV SHAPE instead:
//      the executable token must BE telepty (optionally behind a `node` interpreter
//      token — the shape the live bridge actually has, measured:
//      `node /…/bin/telepty allow --id orchestrator claude --dangerously-skip-…`),
//      its first argument must be `allow`, and `--id` must be followed by the sid as
//      a WHOLE TOKEN. A mention inside another program's arguments can never satisfy
//      the executable position. T131 block V is RED-first against the original: a
//      snapshot holding a real bridge, a `zsh -c grep` that mentions the marker and
//      an ancestor pid — the original kills two of the three, the port kills one.
//      SCOPE: this is the boot script's kill path ONLY. The two DETECT-ONLY sites
//      that share the marker — bin/session-reconciler.sh:415 and
//      src/bridge-auditor/cli.ts (T127 block H pins the false positive there) — are
//      unchanged and belong to #931.
//      The shape check is NARROWER in two enumerated ways, both safe-direction: an
//      interpreter other than node (`env telepty allow …`, `sudo telepty allow …`) is
//      not recognised, and `--id=<sid>` is not recognised (bash did not match it
//      either — its marker required the space). It is WIDER in exactly one: `--id`
//      need not sit immediately after `allow`, and the sid may be the final token
//      with no trailing space. Both only ever concern genuine `telepty allow`
//      invocations.
//
//   NOT CHANGED, on purpose: the reconcile still returns success on EVERY failure —
//      a pre-flight that cannot reach a verdict must never block the boot it exists
//      to enable, since that turns a recoverable outage into a permanent one; every
//      UNKNOWN (daemon silent, listing unparseable, client count absent) still
//      resolves to "do not delete" (#835); DISCONNECTED is still left alone because a
//      bridge that dropped seconds ago is likely mid-reconnect; the reconcile still
//      runs BEFORE the process guard; a failed `ps` still yields an empty snapshot and
//      a silent `killed=0`; and argv is still ignored on the boot path — the bash's
//      `main "$@"` took no positional parameter, so `orchestrator-boot.sh anything`
//      booted, and it still does.
//
// Article 17 (무의존): node stdlib. jq and awk are node-internal now; `ps`, `kill`,
// `telepty`, `curl` and the ONE sanctioned credential resolver
// (bin/lib/telepty-auth.sh, #824 — sourced through a bash door, never re-implemented,
// which is what keeps tests/dispatch/T87's "exactly one authToken reader under bin/"
// literally true) stay subprocesses with IDENTICAL argv.
//
// Rule 26: ZERO platform branches. Nothing to enumerate — `grep -nE
// 'uname|OSTYPE|Darwin|Linux|sw_vers'` over the bash matched nothing at all.
// `ps -eo pid,ppid,command` is the same argv on BSD/macOS and GNU/Linux, as
// src/cleanup/cli.ts:301 and bin/session-reconciler.sh already record.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE } from "./usage.js";

const env = process.env;

// ── the modes (#934) ────────────────────────────────────────────────────────
// THE INCIDENT: on 2026-08-18 the orchestrator ran `bin/orchestrator-boot.sh --help |
// head -2` as a smoke check and got the REAL boot — reconcile, SIGKILL guard, exec —
// because argv was not read on the boot path at all. Nothing was harmed that day and
// the original bash behaved identically, so the port was faithful; the footgun is the
// design. A script that SIGKILLs processes and DELETEs a registry record had no way to
// be LOOKED AT without acting.
//
// The fix is a shape, not a flag list. bin/orchestrator-boot.sh now execs node for ANY
// non-empty argv, so the boot path — the command substitution that reads the exec argv
// and the `exec` that runs it — is reachable only when argv is EMPTY. Adding a mode
// here therefore cannot regress into an accidental boot: falling through to the exec
// requires having no argv at all, which no mode has.
//
// `__probe` (below) keeps its own door for the same reason it always had one.
//
// Measured on 1088ad7 before this landed, with ps/kill/telepty/curl recorders:
// `--help`, `-h`, `--dry-run` and `--bogus-flag` all ran the reconcile, SIGKILLed the
// fixture bridge and exec'd, each exiting 0. There was no unknown-flag arm to preserve.
type Mode = "boot" | "probe" | "help" | "dry-run" | "unknown";
const CLI_ARGV = process.argv.slice(2);
// argv[0] alone, and only when it is the ONLY token: `--dry-run --help` is a refusal
// rather than a guess at which mode was meant. Nothing may be smuggled in behind a
// recognised flag on a script whose bare form SIGKILLs processes.
//
// `probe` is listed FIRST and keeps every boot-path behaviour but the exec: T40, T131
// and T132 drive the reconcile and the guard through it and read their stderr lines
// and their stdout argv, so it must not be swept into the no-exec stream change below.
const MODE: Mode =
  CLI_ARGV.length === 0
    ? "boot"
    : CLI_ARGV[0] === "__probe"
      ? "probe"
      : CLI_ARGV.length === 1 && (CLI_ARGV[0] === "--help" || CLI_ARGV[0] === "-h")
        ? "help"
        : CLI_ARGV.length === 1 && CLI_ARGV[0] === "--dry-run"
          ? "dry-run"
          : "unknown";
const DRY_RUN = MODE === "dry-run";
// Every mode but `boot` and `__probe`. Used for the stream choice and the EPIPE arm
// below, both of which must leave the boot path byte-identical.
const NO_EXEC = MODE === "help" || MODE === "dry-run" || MODE === "unknown";

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` (bash :61). The shim
// exports it so a symlinked entrypoint still locates bin/lib/telepty-auth.sh; the
// fallback keeps a direct `node dist/src/orchestrator-boot/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const TELEPTY_AUTH_SH = path.join(SCRIPT_DIR, "lib/telepty-auth.sh");

// Configurable orchestrator sid — same source as bin/dispatch-tracker.sh (Rule 16, no
// hardcode). `:-` semantics: an EMPTY value falls back to the default, as in bash.
const ORCH_SID = env.ORCHESTRATOR_SID || "orchestrator";

// Test seams (hermetic T40/T131): the process lister, the killer and the self pid, so
// the guard can be exercised with NO real process touched.
const KILL_CMD = env.KILL_CMD || "kill";
const SINGLETON_PS_CMD = env.SINGLETON_PS_CMD || "ps";
// bash defaulted this to `$$` — the boot shell, which then BECAME the bridge. Here it
// is node's pid, a CHILD of that shell, so the ppid walk covers node plus everything
// bash covered. Invariant 1 is therefore strictly stronger, never weaker.
const SINGLETON_SELF_PID = env.SINGLETON_SELF_PID || String(process.pid);
// Registry seams, named from the repo-wide env vars (bin/lib/telepty-listing.sh,
// bin/session-reconciler.sh) so a caller sets what it already knows.
const TELEPTY_CMD = env.TELEPTY || "telepty";
const CURL_CMD = env.CURL || "curl";
const TELEPTY_PORT = env.TELEPTY_PORT || "3848";

// fs.writeSync rather than process.stdout.write: writes to a pipe are asynchronous in
// node and this process exits explicitly, so a buffered argv line could be truncated
// on its way to the shim's command substitution. Both streams use it so ordering
// between them is the ordering of the calls.
function log(msg: string): void {
  writeOut(LOG_FD, `[orchestrator-boot] ${LOG_TAG}${msg}\n`);
}

// ── where a no-exec mode's output goes (#934) ───────────────────────────────
// On the boot path (and through `__probe`) this is fd 2 with no tag, byte for byte
// what it always was: stdout there is the exec-argv contract channel and a stray byte
// on it would be exec'd.
//
// In a no-exec mode stdout is NOT a contract channel — the shim exec'd node and reads
// nothing back — so the whole report goes to fd 1 in one ordered stream, which is what
// makes `--dry-run > report.txt` capture all of it.
//
// The `[dry-run] ` tag is why no message below needed a conditional rewrite: the
// reconcile's existing "Deleting it so this boot can claim the id." line is a verdict,
// and the tag is what keeps it honest when nothing is actually deleted.
const LOG_FD = NO_EXEC ? 1 : 2;
const LOG_TAG = DRY_RUN ? "[dry-run] " : "";

/**
 * fs.writeSync with ONE arm added: an EPIPE in a no-exec mode is not an error.
 *
 * `bin/orchestrator-boot.sh --help | head -2` is the literal command line from the
 * 2026-08-18 incident, and a usage that answers it with an uncaught EPIPE and a stack
 * trace has not really been made safe to look at.
 *
 * DELIBERATELY NOT ON THE BOOT PATH. `bin/orchestrator-boot.sh 2>&1 | head -1` today
 * kills node on the stderr EPIPE, `set -e` aborts the shim, and NOTHING is exec'd.
 * Swallowing it there would let the run continue, print the argv and boot — turning a
 * non-boot into a boot, which is this ticket's failure mode with the sign flipped.
 */
function writeOut(fd: number, s: string): void {
  try {
    fs.writeSync(fd, s);
  } catch (e) {
    if (!NO_EXEC || (e as NodeJS.ErrnoException)?.code !== "EPIPE") throw e;
  }
}

/** `$(...)`: strip ALL trailing newlines, as command substitution does. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

// ── D1: the sid crosses back to the shim as text ────────────────────────────
// A control character in the sid would either split the argv (newline) or make the
// marker unmatchable (tab — bash's `awk -v` expanded the escape and matched nothing,
// leaving the singleton guard armed against a sid no bridge can carry). Refusing is
// the only answer that cannot produce a wrong exec or a silent no-op.
// A regex would need an escaped range here; a code-point scan needs no escaping at
// all, which is one less thing for a copy of this file to get wrong.
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === undefined) continue;
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
// `--help` is exempt (#934) and nothing else is. It is what an operator runs when
// already confused, and refusing to PRINT TEXT because of an unrelated env var is the
// same family of footgun this refusal belongs to. `--dry-run` keeps it: it prints the
// sid and the would-exec argv, which is exactly the round trip D1 protects.
if (MODE !== "help" && hasControlChar(ORCH_SID)) {
  writeOut(
    LOG_FD,
    `[orchestrator-boot] ORCHESTRATOR_SID contains a control character — refusing to boot (the exec argv is handed back to the shim as text, and a sid that cannot survive that round trip cannot be exec'd correctly)\n`,
  );
  process.exit(2);
}

// ── the ps snapshot ─────────────────────────────────────────────────────────
type Row = { pid: string; ppid: string; cmd: string[] };

/**
 * `_ps_snapshot()` (bash :82-84) — "pid ppid command..." rows. The `-o` set is
 * portable across BSD/macOS and GNU/Linux. A lister that fails or is missing yields
 * an EMPTY snapshot and a silent `killed=0`, exactly as `|| true` did.
 */
function psSnapshot(): string {
  const r = spawnSync(SINGLETON_PS_CMD, ["-eo", "pid,ppid,command"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.stdout || "";
}

/** Split into rows, dropping the `PID PPID COMMAND` header the way a numeric-pid test does. */
function parseRows(snapshot: string): Row[] {
  const rows: Row[] = [];
  for (const line of snapshot.split("\n")) {
    const f = line.trim().split(/\s+/); // awk's default FS: runs of whitespace
    if (f.length < 2) continue;
    if (f[0] === "" || /[^0-9]/.test(f[0])) continue; // numeric pids only
    rows.push({ pid: f[0], ppid: f[1], cmd: f.slice(2) });
  }
  return rows;
}

/**
 * `_self_ancestry()` (bash :88-98) — SELF pid plus every ancestor pid, walking the
 * ppid chain up. Reproduced arm for arm: the pid is recorded BEFORE its ppid is
 * looked up; a pid missing from the snapshot ends the walk; a non-numeric or <= 1
 * pid ends it (bash's `[ "$pid" -gt 1 ] 2>/dev/null`); and the walk gives up after 64
 * hops so a ppid cycle cannot spin forever. awk's `exit` after the first match means
 * the FIRST row for a pid wins.
 */
function selfAncestry(rows: Row[]): Set<string> {
  const ppidOf = new Map<string, string>();
  for (const r of rows) if (!ppidOf.has(r.pid)) ppidOf.set(r.pid, r.ppid);

  const seen = new Set<string>();
  let pid = SINGLETON_SELF_PID;
  let hops = 0;
  while (pid !== "" && /^[0-9]+$/.test(pid) && Number(pid) > 1) {
    seen.add(pid);
    const pp = ppidOf.get(pid);
    if (pp === undefined || pp === "") break;
    pid = pp;
    hops += 1;
    if (hops > 64) break;
  }
  return seen;
}

/**
 * D4 — is this row's ARGV a `telepty allow --id <ORCH_SID>` invocation?
 *
 * bash asked whether the row CONTAINED the string `telepty allow --id <sid> `, which
 * an operator's own `pgrep -fl telepty` satisfies. This asks whether the process IS
 * the bridge:
 *
 *   [node] <…/>telepty allow … --id <sid> …
 *    ^opt   ^executable token   ^whole-token sid
 *
 * The `node` interpreter token is optional because that is the shape the live bridge
 * has on this host (`node /…/bin/telepty allow --id orchestrator …`) while a packaged
 * binary would be `telepty allow …` directly. The sid is compared as a WHOLE TOKEN,
 * which is what the trailing space in bash's marker was for: `orchestrator-2` is not
 * `orchestrator` (T57 block D, T40 block D).
 */
const INTERPRETERS = new Set(["node", "nodejs"]);

/**
 * A NEAR MISS, for --dry-run's skip lines only (#934) — never a kill criterion.
 *
 * This is deliberately the ORIGINAL bash's hazard, rebuilt as a reporting filter: any
 * row that mentions `telepty` anywhere in its argv is a row the pre-D4 substring
 * marker could have SIGKILLed, so it is exactly the row an operator wants to see
 * explained. Nothing downstream of this decides a signal.
 */
function mentionsTelepty(cmd: string[]): boolean {
  return cmd.some((t) => t.includes("telepty"));
}
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

/**
 * `orchestrator_singleton_guard()` (bash :103-124) — SIGKILL every
 * `telepty allow --id $ORCH_SID` process EXCEPT self and self's ancestors. Idempotent:
 * a no-op for zero bridges or a lone self bridge. MUST run BEFORE the new bridge
 * exists (temporal protection, invariant 1).
 *
 * `kill`'s stdio is fully ignored, not inherited: stdout belongs to the exec argv now.
 */
function orchestratorSingletonGuard(): void {
  const rows = parseRows(psSnapshot());
  const ancestry = selfAncestry(rows);
  let killed = 0;
  for (const r of rows) {
    if (!isOrchestratorBridge(r.cmd)) {
      // Silent on every path but --dry-run, where the near misses ARE the report: a
      // human reads a dry run to find out why the thing that looks like a bridge is
      // not one. Only rows that MENTION telepty get a line — those are exactly the
      // rows the original substring marker (D4) would have SIGKILLed, and a line per
      // row of the whole process table would be hundreds of lines of other programs'
      // argv, which is a new leak rather than a diagnostic.
      if (DRY_RUN && mentionsTelepty(r.cmd)) {
        log(
          `skip pid=${r.pid} — not a bridge: its argv is not '[node] telepty allow --id ${ORCH_SID}' (${r.cmd.join(" ")})`,
        );
      }
      continue;
    }
    if (ancestry.has(r.pid)) {
      log(`skip self/ancestor bridge pid=${r.pid} (${ORCH_SID})`);
      continue;
    }
    if (DRY_RUN) {
      // The guard is PROVEN, not bypassed: this row got here through the same shape
      // test and the same ancestry set a real run uses, and the two skips above have
      // already been printed by the same code. tests/dispatch/T134 block D drives the
      // dry run and a real run through ONE ps fixture and diffs the two pid sets.
      log(
        `would SIGKILL stale orchestrator bridge pid=${r.pid} (${ORCH_SID}) — argv matches 'telepty allow --id ${ORCH_SID}' and the pid is neither self nor an ancestor`,
      );
      killed += 1;
      continue;
    }
    // invariant 2: "-9" is the ONLY signal argument in this file.
    const k = spawnSync(KILL_CMD, ["-9", r.pid], { stdio: ["ignore", "ignore", "ignore"] });
    if (k.status === 0) {
      log(`SIGKILL stale orchestrator bridge pid=${r.pid} (${ORCH_SID})`);
      killed += 1;
    } else {
      log(`kill -9 pid=${r.pid} failed (already gone?)`);
    }
  }
  // The ONE message that changes word in a dry run. The `[dry-run] ` tag is enough for
  // every other line, but this is the summary a human skims, and a summary reading
  // `killed=1` on a run that killed nothing is the wrong thing to be ambiguous about
  // on a SIGKILL path. The boot path's bytes are untouched.
  log(
    DRY_RUN
      ? `singleton guard done: would_kill=${killed} stale bridge(s) for ${ORCH_SID}`
      : `singleton guard done: killed=${killed} stale bridge(s) for ${ORCH_SID}`,
  );
}

// ── the registry reconcile (#905) ───────────────────────────────────────────
/** jq's `//`: the first value that is neither null nor false (absent counts as null). */
function jqAlternative(...values: unknown[]): unknown {
  for (const v of values) if (v !== null && v !== false && v !== undefined) return v;
  return undefined;
}

/** jq `-r` / `tostring`: a string prints raw, everything else prints as compact JSON. */
function jqToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v) ?? "";
}

/**
 * The ONE sanctioned credential resolver (#824), called as the shell function it is —
 * identical to src/cleanup/cli.ts:129 and src/tracker/cli.ts. Degrades to "" (no
 * credential presented) exactly as the lib does, and the value is never logged.
 */
function teleptyAuthToken(): string {
  const r = spawnSync("bash", ["-c", '. "$1"; telepty_auth_token', "_", TELEPTY_AUTH_SH], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return chomp(r.stdout || "");
}

/**
 * `orchestrator_registry_reconcile()` (bash :141-189) — delete the daemon's record for
 * our own sid IF, and only if, it is a shell nobody owns: STALE (the daemon's own
 * verdict that the owner has been disconnected past the stale threshold —
 * daemon.js:1533 reports it as OWNER_DISCONNECTED_STALE) AND zero attached clients.
 *
 * Never throws and never blocks the boot. Every failure here is a reason to continue
 * to the exec, not to stop it: `telepty allow` reports its own error far better than a
 * guess made here, and refusing to boot because the pre-flight was inconclusive would
 * turn a recoverable outage into a permanent one — which is the failure mode this
 * whole function exists to end.
 *
 * LISTING SHAPE: the daemon returns an ARRAY. Anything else is reported as "no
 * record" rather than searched. bash reached the same place by accident — `.[] |
 * select(.id == $s)` errors on a non-object value, jq exits non-zero and its stderr
 * was discarded (measured: a bare object listing → "no record") — and it is the right
 * place on purpose, because an unrecognised listing shape is an UNKNOWN and an unknown
 * must never authorise a DELETE aimed at the orchestrator's own id (#835).
 */
function orchestratorRegistryReconcile(): void {
  const r = spawnSync(TELEPTY_CMD, ["list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) {
    log(
      `registry reconcile SKIPPED — '${TELEPTY_CMD} list --json' did not answer; continuing to exec (allow will report its own error)`,
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout || "");
  } catch {
    parsed = undefined;
  }
  // `jq -e .` exits non-zero when the input does not parse AND when the value is null
  // or false — all three are the same "not JSON" arm here, as they were in bash.
  if (parsed === undefined || parsed === null || parsed === false) {
    log(
      "registry reconcile SKIPPED — the listing was not JSON (daemon/CLI version mismatch?); continuing to exec",
    );
    return;
  }

  const rec = Array.isArray(parsed)
    ? (parsed.find(
        (x) => x !== null && typeof x === "object" && (x as Record<string, unknown>).id === ORCH_SID,
      ) as Record<string, unknown> | undefined)
    : undefined;
  if (rec === undefined) {
    log(`registry reconcile: no record for '${ORCH_SID}' — nothing to reconcile`);
    return;
  }

  const health = jqToString(jqAlternative(rec.healthStatus, rec.status, ""));
  // No default: an absent count must stay distinguishable from a zero one. `tostring`
  // is why a null count renders as the string "null" and lands in the "attached" arm.
  const clients = Object.prototype.hasOwnProperty.call(rec, "active_clients")
    ? jqToString(rec.active_clients)
    : Object.prototype.hasOwnProperty.call(rec, "activeClients")
      ? jqToString(rec.activeClients)
      : "";

  if (health !== "STALE") {
    // DISCONNECTED is deliberately NOT reconciled. A bridge that dropped seconds ago is
    // very likely mid-reconnect (cli.js scheduleReconnect, unconditional since
    // 2026-03-14), and deleting its record would race a session that is coming back.
    // STALE is the daemon saying that window has already closed.
    log(
      `registry reconcile: record for '${ORCH_SID}' is ${health} (clients=${clients || "unknown"}) — left alone; only a STALE record with 0 clients is reconciled`,
    );
    return;
  }
  if (clients === "") {
    log(
      `registry reconcile: record for '${ORCH_SID}' is STALE but the listing reports no client count — unknown is not zero, leaving it alone`,
    );
    return;
  }
  if (clients !== "0") {
    log(
      `registry reconcile: record for '${ORCH_SID}' is STALE but ${clients} client(s) are attached — leaving it alone`,
    );
    return;
  }

  log(
    `registry reconcile: '${ORCH_SID}' is STALE with 0 clients — a record whose owner is gone and whose owner token no new bridge can present (#815). Deleting it so this boot can claim the id.`,
  );
  if (DRY_RUN) {
    // The one arm that acts, reported and not taken. The verdict line above already
    // said WHY; this says what would go on the wire and that nothing did. The token is
    // not resolved here at all, let alone printed (invariant 4).
    log(
      `would DELETE http://127.0.0.1:${TELEPTY_PORT}/api/sessions/${ORCH_SID} — nothing was sent`,
    );
    return;
  }
  const c = spawnSync(
    CURL_CMD,
    [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-H",
      `x-telepty-token: ${teleptyAuthToken()}`,
      "-X",
      "DELETE",
      `http://127.0.0.1:${TELEPTY_PORT}/api/sessions/${ORCH_SID}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const http = chomp(c.stdout || "");
  if (http === "200") {
    log(`DELETE /api/sessions/${ORCH_SID} → 200 (stale record removed; the id is claimable)`);
  } else if (http === "404") {
    log(`DELETE /api/sessions/${ORCH_SID} → 404 (already gone — someone or something beat us to it)`);
  } else if (http === "401" || http === "403") {
    log(
      `DELETE /api/sessions/${ORCH_SID} → ${http} (daemon refused the credential — the STALE record STAYS and the exec below will very likely be refused the owner claim; check that authToken in ~/.telepty/config.json is readable)`,
    );
  } else if (http === "000" || http === "") {
    log(
      `DELETE /api/sessions/${ORCH_SID} → no answer from the daemon (the STALE record STAYS; nothing was removed)`,
    );
  } else {
    log(`DELETE /api/sessions/${ORCH_SID} → ${http} (unexpected; the record may still be there)`);
  }
}

// The exec argv, as data, so a guard can assert its shape without running it.
//
// --auto-restart, MEASURED (cli.js 0.8.0, not inferred): the flag is extracted by
// indexOf over the args after `allow` and spliced out before `command = allowArgs[0]`
// (cli.js:1837-1846), so it must precede the command word — which is also where every
// worker carries it. Its behaviour is referenced at exactly two places, cli.js:2576 and
// :2605, both inside attachChildExitHandler: when the WRAPPED CHILD exits abnormally the
// bridge respawns it with exponential backoff (1s→8s, capped, MAX_CRASHES, counter reset
// after 30s of survival) instead of tearing the session down.
//
// So it is worth having — without it a `claude` crash takes the whole orchestrator
// session with it, and workers have had that protection all along — but it is NOT what
// saved the workers on 2026-08-16, and it would not have prevented that incident. WS
// reconnect and re-register are unconditional and have nothing to do with this flag
// (cli.js:2224-2256, scheduleReconnect, landed 2026-03-14).
const ORCH_EXEC_ARGV = [
  "telepty",
  "allow",
  "--id",
  ORCH_SID,
  "--auto-restart",
  "claude",
  "--dangerously-skip-permissions",
  "--continue",
];

/**
 * Invariant 3 — hand the argv back to the shim, one element per line, and let the
 * SHELL exec it. This process must be gone before the bridge exists.
 */
function emitExecArgv(): void {
  writeOut(1, `${ORCH_EXEC_ARGV.join("\n")}\n`);
}

function main(): never {
  orchestratorRegistryReconcile();
  orchestratorSingletonGuard();
  log(`exec ${ORCH_EXEC_ARGV.join(" ")}`);
  emitExecArgv();
  process.exit(0);
}

// ── the no-exec modes (#934) ────────────────────────────────────────────────

function help(): never {
  writeOut(1, `${USAGE}\n`);
  process.exit(0);
}

/**
 * `--dry-run` — the read-only half of main(), in main()'s order, through main()'s
 * code. The two effect sites (the `curl -X DELETE`, the `kill -9`) are the ONLY
 * things replaced, each by the line that says what it would have done, which is what
 * makes "the dry run names what a real run kills" true by construction rather than by
 * a second implementation that can drift from this one.
 *
 * The exec argv comes last and every element is prefixed. On this path the shim has
 * exec'd node and reads nothing back, so there is no command substitution left to
 * confuse — the prefix is for the human and for any script that grew up reading this
 * output, neither of whom should ever find a bare `telepty` alone on a line here.
 */
function dryRun(): never {
  orchestratorRegistryReconcile();
  orchestratorSingletonGuard();
  log(`would exec ${ORCH_EXEC_ARGV.join(" ")} (one element per line below)`);
  for (const a of ORCH_EXEC_ARGV) writeOut(1, `[would-exec] ${a}\n`);
  process.exit(0);
}

function unknownFlag(): never {
  // Before #934 this arm did not exist: `orchestrator-boot.sh --bogus-flag` ran the
  // full boot and exited 0. Exit 2 is the code this file already uses for "refusing
  // to boot" (D1 above, and the shim's own empty-argv refusal).
  // stderr for both, unlike --help/--dry-run: this is a diagnostic about a failed
  // invocation, not the output the caller asked for, so `… --bogus > out` must leave
  // `out` empty rather than looking like it produced something.
  writeOut(2, `orchestrator-boot.sh: unknown argument: ${CLI_ARGV.join(" ")}\n`);
  writeOut(2, `${USAGE}\n`);
  process.exit(2);
}

// ── __probe: the test seam that replaced `source orchestrator-boot.sh` ──────
// tests/dispatch/T40 used to source this script and call orchestrator_singleton_guard
// / orchestrator_registry_reconcile as bash functions and read ORCH_EXEC_ARGV as a
// bash array. An exec shim exports no shell functions, so those behaviours are
// reachable here instead — same seams (SINGLETON_PS_CMD / KILL_CMD /
// SINGLETON_SELF_PID / TELEPTY / CURL), same fixtures, same assertions, now measuring
// the code production actually runs. Internal surface: not a flag, not documented,
// no caller outside tests/dispatch/. The shim routes `__probe` straight to node so a
// probe can never reach the exec.
function probe(argv: string[]): never {
  const sub = argv[0];
  if (sub === "singleton-guard") {
    orchestratorSingletonGuard();
    process.exit(0);
  }
  if (sub === "registry-reconcile") {
    orchestratorRegistryReconcile();
    process.exit(0);
  }
  if (sub === "exec-argv") {
    emitExecArgv();
    process.exit(0);
  }
  fs.writeSync(2, `orchestrator-boot.sh: unknown __probe subcommand: ${String(sub)}\n`);
  process.exit(4);
}

// The boot path takes no argument and never has: bash's `main "$@"` used no positional
// parameter, so `orchestrator-boot.sh anything` booted. #934 ENDS THAT — booting now
// requires an EMPTY argv, and every other shape lands somewhere that cannot exec. The
// shim enforces the same rule one layer up (it execs node for any non-empty argv), so
// the two halves agree even if this file is run directly.
switch (MODE) {
  case "probe":
    probe(CLI_ARGV.slice(1));
    break;
  case "help":
    help();
    break;
  case "dry-run":
    dryRun();
    break;
  case "unknown":
    unknownFlag();
    break;
  default:
    main();
}
