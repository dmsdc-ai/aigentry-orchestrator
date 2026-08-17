// bin/open-session.sh's implementation, ported to TypeScript (#899 tranche 3a,
// under docs/specs/2026-08-16-workspace-host-port.md — option (i), the T3a row of
// §5, decided by the user on 2026-08-17: T3a go, T3b declined).
//
// THIS IS THE LIVE SPAWN PATH. `bin/dispatch.sh --spawn-and-dispatch` →
// boot-prepare → this. Every flag, exit code, stdout byte, stderr line, log line
// and subprocess argv below is the shell script's, preserved deliberately (Rule 29
// + Constitution Art. 1). bin/open-session.sh is an exec shim onto this file.
//
// THE TWO LIBS THIS SCRIPT USED TO SOURCE, and what each became — no
// re-implementation of either, because the adapter STAYS BASH by decision (T3b
// declined) and the OS primitive lives in the platform lib by Rule 26:
//
//   lib/workspace-host.sh → bin/wh-cli.sh, the subprocess door built for exactly
//     this (c83ebc4, pre-tranche-2). EXACTLY THREE SYMBOLS are reached, measured
//     rather than assumed: detect_terminal (the shell's :201 and :272) →
//     `detect-terminal`, wh_open (:231) → `open`, wh_set_status (:239) →
//     `set-status`. tests/dispatch/T104 pins CLI result == sourced-function result
//     (exit code + stdout) for all 11 verbs, so the door cannot drift from the lib.
//     _wh_adapter and _wh_fallback_spawn appear in the shell's COMMENTS only
//     (:141-144) and are NOT doors — T104 part F pins that set at 11 so a 12th
//     cannot appear unmeasured.
//   lib/platform.sh → `bash -c '. <lib>; <fn> "${@:3}"'`, the idiom
//     src/reconciler/cli.ts:340 and src/tracker/cli.ts already run in production,
//     for platform::session_pid and platform::hold_awake (the shell's :283-285).
//     #909 moved the ps/awk of the session-pid walk INTO that lib precisely so this
//     script's sleep assertion and the reconciler's sweep resolve the same pid;
//     re-inlining it in TS would restore the drift that removed.
//
// NO `process.platform` BRANCH EXISTS HERE, because the shell had no OS arm.
// Enumerated candidates and where each actually lives: the sleep assertion
// (caffeinate vs systemd-inhibit) and the session-pid walk (ps column sets) →
// platform.sh; which terminal is hosting us → the workspace-host registry, behind
// wh-cli.sh; `mkdir -p`/`date -u` → node stdlib, OS-independent. Zero branches.
//
// WHAT STAYS IN THE SHIM, IN BASH, and why: the PATH hardening (it must apply to
// this process AND to every child — T56's comment turns on open-session prepending
// the real cmux) and the symlink-resolving SCRIPT_DIR (`_resolve_src`, the shell's
// :37-49, which exists because the entrypoint has been a symlink and `cd + pwd`
// alone does not follow one). See bin/open-session.sh's header.
//
// TWO PRE-EXISTING INJECTION SITES ARE REPRODUCED, NOT FIXED. `eval cwd="$cwd"`
// (the shell's :118, evalCwd below) and the unquoted `bash -c 'cd $cwd && …'` in
// the legacy arm (:212, ./legacy-spawn.ts) are recorded as [MEDIUM] G in
// docs/reports/2026-07-02-ecosystem-deep-analysis.md:87. This is a port, not a fix:
// the parity guard's whole job is proving old and new produce identical bytes, and
// a fix inside the port makes that unprovable. Separate ticket; see the REPORT.
//
// DELIBERATE DEVIATIONS (Rule 38 — everything measured, nothing else changed):
//   * A flag with no value (`--track` as the last argv) was `"$2"` under `set -u`:
//     bash printed a LOCALE-DEPENDENT "$2: unbound variable" and exited 1. The exit
//     code is the contract and it is reproduced; the message is this file's own,
//     because a localized shell diagnostic is not a contract anyone can assert.
//   * The two config reads were `jq -r '…' file 2>/dev/null || echo <alt>`. They are
//     JSON.parse here — the same removal of an external JSON tool from the script's
//     OWN logic that tranche 2d did to hitl's python3 heredocs. jq is NOT otherwise
//     dropped from the spawn path: bin/lib/workspace-host.sh still uses it behind
//     wh-cli.sh, and src/cleanup/cli.ts:163 still requires it on PATH. Same
//     `// empty` / `// false` alternative semantics (null and false take the
//     alternative), same `$( )` trailing-newline strip, same "unreadable or
//     unparseable ⇒ the alternative" outcome.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { LEGACY_CMUX_SPAWN } from "./legacy-spawn.js";
import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR was the shell's symlink-resolved `cd "$(dirname …)" && pwd -P`. The
// shim exports it already resolved; the fallback keeps a direct
// `node dist/src/session/open-session/cli.js` working from the repo tree.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "bin");
// cleanup_on_exit resolved session-cleanup.sh off `dirname "${BASH_SOURCE[0]}"` —
// the path the script was INVOKED by, symlinks unresolved, which is not always
// SCRIPT_DIR. The shim exports that raw path so the difference survives the port.
const INVOKED_DIR = path.dirname(env.AIGENTRY_SHIM_SCRIPT_PATH || path.join(SCRIPT_DIR, "open-session.sh"));
const WH_CLI = path.join(SCRIPT_DIR, "wh-cli.sh");
const PLATFORM_SH = path.join(SCRIPT_DIR, "lib/platform.sh");
const HOME = env.HOME || "";
const CONFIG_FILE = env.AIGENTRY_CONFIG || path.join(HOME, ".aigentry/config.json");

// ── small process helpers (src/reconciler/cli.ts's, same shapes) ─────────────
/** bash `$(cmd)`: command substitution strips every trailing newline. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

interface RunOpts {
  /** stdout: "pipe" captures it, "ignore" is `>/dev/null`, "inherit" leaves it alone. */
  out?: "pipe" | "ignore" | "inherit";
  /** stderr: "ignore" is `2>/dev/null`, "inherit" is the shell default. */
  err?: "ignore" | "inherit";
  env?: NodeJS.ProcessEnv;
}

/** One spawn helper; each call site's redirections are the shell line's, verbatim. */
function run(cmd: string, args: string[], opts: RunOpts = {}): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", opts.out ?? "pipe", opts.err ?? "inherit"],
    env: opts.env ?? env,
  });
  // bash prints "command not found"/"Permission denied" and yields 127/126; the
  // callers all treat any non-zero the same way, so one code is enough.
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** `[ -x <path> ]`. */
function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `jq -r --arg r "$role" '.<a>.<b>.<c> // <alt>' "$file" 2>/dev/null || echo <alt>`,
 * then `$( )`'s trailing-newline strip. Both call sites, one helper: an unreadable
 * or unparseable file, a missing key, `null` and `false` all yield <alt>; `jq -r`
 * prints a string raw and anything else as JSON.
 */
function jqField(file: string, keys: string[], alt: string): string {
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return alt;
  }
  for (const k of keys) {
    if (v === null || typeof v !== "object") return alt;
    v = (v as Record<string, unknown>)[k];
  }
  if (v === undefined || v === null || v === false) return alt;
  return chomp(typeof v === "string" ? v : JSON.stringify(v));
}

// ── the lib seams ───────────────────────────────────────────────────────────
/** A bin/wh-cli.sh verb: 1:1 with the shell function this script used to source. */
function wh(args: string[], opts: RunOpts = {}): { status: number; stdout: string } {
  return run(WH_CLI, args, opts);
}

/** `platform::<fn>` from bin/lib/platform.sh, as a subprocess (src/reconciler/cli.ts's idiom). */
function platform(fn: string, args: string[] = [], opts: RunOpts = {}): { status: number; stdout: string } {
  return run("bash", ["-c", `. "$1"; ${fn} "\${@:3}"`, "_", PLATFORM_SH, "_", ...args], { err: "inherit", ...opts });
}

// ── argv (the shell's :60-96) ───────────────────────────────────────────────
const argv = process.argv.slice(2);

let track = "";
let name = "";
let role = "";
let task = "";
let cli = "claude";
let cwdOverride = "";
let extraFlags = "";
let sid = "";
let autoCleanup = 0;

let ai = 0;
/** bash `"$2"` under `set -u`: a flag with no value was a fatal, exit 1. */
function flagValue(flag: string): string {
  const v = argv[ai + 1];
  if (v === undefined) {
    process.stderr.write(`open-session.sh: ${flag}: unbound variable\n`);
    process.exit(1);
  }
  return v;
}

while (ai < argv.length) {
  const a = argv[ai] as string;
  switch (a) {
    case "--track":
      track = flagValue(a);
      ai += 2;
      break;
    case "--name":
      name = flagValue(a);
      ai += 2;
      break;
    case "--role":
      role = flagValue(a);
      ai += 2;
      break;
    case "--task":
      task = flagValue(a);
      ai += 2;
      break;
    case "--cli":
      cli = flagValue(a);
      ai += 2;
      break;
    case "--cwd":
      cwdOverride = flagValue(a);
      ai += 2;
      break;
    case "--extra-flags":
      extraFlags = flagValue(a);
      ai += 2;
      break;
    case "--auto-cleanup-on-exit":
      autoCleanup = 1;
      ai += 1;
      break;
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      process.exit(0);
    // eslint-disable-next-line no-fallthrough
    default:
      process.stderr.write(`ERR unknown arg: ${a}\n`);
      process.exit(1);
  }
}

if (!track) {
  process.stderr.write("ERR --track required\n");
  process.exit(1);
}

// Resolve name: explicit --name wins, else {role}-{task}, else error
if (!name) {
  if (role && task) {
    name = `${role}-${task}`;
  } else {
    process.stderr.write("ERR need either --name or (--role + --task)\n");
    process.exit(1);
  }
}

// Resolve cwd: explicit --cwd wins, else lookup ~/.aigentry/config.json by --role
let cwd = "";
let cliFlagsFromConfig = "";
if (cwdOverride) {
  cwd = cwdOverride;
} else if (role && fs.existsSync(CONFIG_FILE) && fs.statSync(CONFIG_FILE).isFile()) {
  cwd = jqField(CONFIG_FILE, ["roles", role, "path"], "");
  cliFlagsFromConfig = jqField(CONFIG_FILE, ["roles", role, "cli_flags"], "");
  const cliFromConfig = jqField(CONFIG_FILE, ["roles", role, "cli"], "");
  if (cliFromConfig) cli = cliFromConfig;
}

if (!cwd) {
  process.stderr.write("ERR cwd unresolved. Options:\n");
  process.stderr.write("  1. Pass --cwd PATH explicitly\n");
  process.stderr.write(
    `  2. Configure role in ${CONFIG_FILE} (see docs/session-conventions.md in @dmsdc-ai/aigentry-devkit)\n`,
  );
  process.exit(1);
}

/**
 * `eval cwd="$cwd"` — homedir shortcut expansion (the shell's :118).
 *
 * A PRE-EXISTING INJECTION SITE, REPRODUCED RATHER THAN FIXED (see this file's
 * header). It runs in bash because that is the only way to reproduce it: the
 * expansion set is bash's own (tilde, parameter, command substitution, quote
 * removal), and so is the failure mode. fd 3 carries the resolved value back so an
 * injected command's own stdout still lands on THIS process's stdout, exactly where
 * the shell put it, instead of being swallowed into the variable.
 */
function evalCwd(raw: string): string {
  const r = spawnSync("bash", ["-c", 'eval cwd="$1"; printf "%s" "$cwd" >&3', "_", raw], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit", "pipe"],
  });
  if (r.error) {
    process.stderr.write(`open-session.sh: cannot resolve cwd: ${String(r.error)}\n`);
    process.exit(1);
  }
  // `set -e`: a failing eval aborted the script with the eval's status.
  if (r.status !== 0) process.exit(r.status ?? 1);
  return (r.output[3] as unknown as string) ?? "";
}
cwd = evalCwd(cwd);

if (!(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) {
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch (e) {
    // `set -e` on a failing `mkdir -p`: the shell aborted with mkdir's status (1).
    process.stderr.write(`mkdir: ${cwd}: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

// Trust check warning (claude only)
const trustStatus = jqField(path.join(HOME, ".claude.json"), ["projects", cwd, "hasTrustDialogAccepted"], "false");
if (trustStatus !== "true" && cli === "claude") {
  process.stderr.write(`WARN: ${cwd} not in ~/.claude.json trust list — claude will show trust prompt\n`);
  process.stderr.write(`      run: aigentry-devkit/bin/trust-path.sh ${cwd}\n`);
}

const title = `${track}-${name}`;
sid = title; // SID convention = title (track-name)

// CLI flags: --extra-flags arg > config > defaults
if (!extraFlags && cliFlagsFromConfig) {
  extraFlags = cliFlagsFromConfig;
}
switch (cli) {
  case "claude":
    if (!extraFlags) {
      extraFlags = `--model ${env.AIGENTRY_CLAUDE_MODEL || "claude-opus-4-8"} --effort ${
        env.AIGENTRY_CLAUDE_EFFORT || "xhigh"
      } --permission-mode bypassPermissions`;
    }
    break;
  case "codex":
    if (!extraFlags) {
      extraFlags = "-c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox";
    }
    break;
  case "gemini":
    if (!extraFlags) {
      extraFlags = `-m ${env.AIGENTRY_GEMINI_MODEL || "gemini-2.5-flash"} --approval-mode yolo`;
    }
    break;
  default:
    break;
}

// EXIT trap — best-effort session-lifecycle hook (Plan A Task 8 integration).
// Calls ctx-router on-session-end so journal/handoff state is flushed if this
// script itself terminates abnormally before the spawn completes.
//
// It is a FUNCTION CALLED AT EVERY EXIT PATH BELOW rather than a process-level
// hook, because that is what `trap … EXIT` at the shell's :264 actually was: it
// covered the exits AFTER it, and nothing before it. The arg-parse failures, the
// --help arm and the cwd/eval/mkdir failures above are all pre-trap in the shell
// and they stay pre-trap here — a port that flushed a session-end journal for
// `--track` typo would be inventing a lifecycle event.
function cleanupOnExit(ec: number): never {
  const ctxRouter = env.CTX_ROUTER_PATH || path.join(HOME, "projects/aigentry-devkit/bin/ctx-router.sh");
  if (executable(ctxRouter) && sid) {
    run(ctxRouter, ["on-session-end", sid], { out: "ignore", err: "ignore" });
  } else if (sid) {
    process.stderr.write(
      `open-session.sh: ctx-router not found at ${ctxRouter} — session-end journal/handoff flush skipped (set CTX_ROUTER_PATH to point at it)\n`,
    );
  }
  // Extended (#304): if --auto-cleanup-on-exit, also run session-cleanup.sh
  // so PTY + cmux workspace + orchestrator pid mutex all get torn down.
  if (autoCleanup === 1 && sid) {
    const sc = path.join(INVOKED_DIR, "session-cleanup.sh");
    if (executable(sc)) run(sc, [sid], { out: "ignore", err: "ignore" });
  }
  process.exit(ec);
}

/**
 * Open session in the detected terminal (ADR §7 Phase 3, D1/D2). Always wraps in
 * `telepty allow --id <sid>` so the daemon registers it (visible to `telepty list`
 * + inject targets). A THIN dispatch: detect-terminal names the adapter, `open`
 * spawns through the single Workspace Host seam. BC4-a: AIGENTRY_WH_LEGACY_SPAWN=1
 * still forces the original inline cmux path for an immediate revert if the cmux
 * seam regresses (live daemon 3848 protection) — see ./legacy-spawn.ts.
 */
function openInTerminal(): string {
  const term = chomp(wh(["detect-terminal"]).stdout);
  const cliCmd = `${cli} ${extraFlags}`;

  if (term === "cmux" && env.AIGENTRY_WH_LEGACY_SPAWN === "1") {
    const r = spawnSync("bash", ["-c", LEGACY_CMUX_SPAWN, "_", cwd, sid, cliCmd, title], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    // The arm's own `exit 2` / `exit 3` (and `set -e`) are the shell's; they
    // reached the trap through the enclosing `ref=$(open_in_terminal)`, and they
    // reach it here the same way.
    if (r.error) cleanupOnExit(127);
    if (r.status !== 0) cleanupOnExit(r.status ?? 1);
    return chomp(r.stdout ?? "");
  }

  // Phase 3 single dispatch (D1/D2): the detected terminal IS the adapter. Force it
  // so `open` routes to _wh_<term>_open (env-force beats _wh_adapter auto-detect,
  // which only auto-selects cmux/headless). Adapter exit codes propagate verbatim —
  // e.g. the cmux contract: 2 = spawn failure, 3 = ready-timeout with the workspace
  // closed, 64 = no such adapter.
  const opened = wh(["open", sid, cwd, cliCmd], { env: { ...env, AIGENTRY_WORKSPACE_HOST: term } });
  if (opened.status !== 0) cleanupOnExit(opened.status);
  const ref = chomp(opened.stdout);

  // #616 (사용자확정 옵션2 = 사이드바): surface the freshly-spawned worker as a
  // ⚡working pill in the cmux sidebar immediately — visibility WITHOUT focus theft
  // (the orchestrator keeps its surface; NO select-workspace). `set-status` routes
  // via _wh_adapter (cmux in the live orchestrator, where cmux is on PATH); it is a
  // degraded-noop on non-cmux adapters (§17). Best-effort — never gates the spawn,
  // never writes to stdout (the ref must be the sole stdout line). DELIBERATELY NOT
  // env-forced, exactly as the shell left it: T56's header records that the
  // auto-detect fallthrough here is what that guard is measuring.
  wh(["set-status", ref, "working"], { out: "ignore", err: "ignore" });

  return ref;
}

// Spawn the session (the ref/sid is this process's sole stdout line)
const ref = openInTerminal();

// Log
const logFile = path.join(HOME, ".aigentry/open-session.log");
fs.mkdirSync(path.dirname(logFile), { recursive: true });
// `date -u +%FT%TZ` — seconds, no fraction.
const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
fs.appendFileSync(
  logFile,
  `${stamp} term=${chomp(wh(["detect-terminal"]).stdout)} ref=${ref} sid=${sid} title=${title} cwd=${cwd} cli=${cli} flags=${extraFlags}\n`,
);

// Per-worker sleep assertion (#909). On 2026-08-16 three worker turns on this host
// were cut mid-response by `API Error: Your computer went to sleep mid-response`
// (33m, 1h7m and 31m of work; the 1h7m was uncommitted). The assertion is bound to
// THIS worker's `telepty allow` pid, so it is released the moment the worker exits —
// never a global or indefinite caffeinate. Best-effort and never gating: an
// unresolved pid or an absent primitive announces itself on stderr and the spawn
// proceeds unchanged. AIGENTRY_SLEEP_GUARD=0 is the kill switch (the dispatch guard
// suite sets it, so no test can assert on the real host's power state).
if ((env.AIGENTRY_SLEEP_GUARD ?? "1") !== "0") {
  const pid = chomp(platform("platform::session_pid", [sid, env.AIGENTRY_SLEEP_GUARD_PID_TIMEOUT_MS || "3000"]).stdout);
  platform("platform::hold_awake", [pid, `aigentry worker ${sid}`], { out: "ignore" });
}

process.stdout.write(`${ref}\n`);
cleanupOnExit(0);
