// session-cleanup.sh's implementation, ported to TypeScript (#899 tranche 2a).
//
// This is a PORT, not a redesign (Rule 29 + Constitution Art. 1): every flag, exit
// code, stdout/stderr line and subprocess argv is the shell script's, preserved
// deliberately. bin/session-cleanup.sh is now an exec shim onto this file, so
// bin/session-reconciler.sh's scheduled cleanup, bin/dispatch-cleanup-scheduler.sh,
// bin/open-session.sh --auto-cleanup-on-exit and the operator's own hand-run
// (Rule 28) are unchanged. The behavioural documentation lives in ./usage.ts (what
// --help prints) and in the shell script's git history.
//
// THE THREE LIBS THIS SCRIPT USED TO SOURCE, and what each became:
//
//   lib/workspace-host.sh   → bin/wh-cli.sh (#899 pre-tranche-2). A TS process
//     cannot source bash, so wh_lookup / wh_close / wh_close_for_sid are reached
//     as the subprocess door built for exactly this, with the SAME exit codes and
//     the SAME stdout (tests/dispatch/T104 pins CLI == sourced function). The lib
//     itself is untouched and stays bash: it is #899's last item by design.
//   lib/telepty-auth.sh     → invoked as the shell function it is, the same way
//     src/tracker/cli.ts does. tests/dispatch/T87 asserts there is exactly ONE
//     `authToken` reader under bin/, and re-implementing the config read here is
//     precisely the second copy it exists to forbid.
//   lib/telepty-listing.sh  → same subprocess door. The #835 corroborated-listing
//     verdict is ALSO sourced by bin/session-reconciler.sh, which stays bash until
//     tranche 2c; a TS re-implementation would be a second copy of the one rule
//     that decides whether an absence may authorize destruction, free to drift
//     from the reconciler's copy. One implementation, two callers, no drift.
//
// NO `process.platform` BRANCH EXISTS HERE, because the shell had no OS arm. The
// one place an OS difference could have lived — the ps/kill ancestry walk — was
// already written portable: `ps -eo pid,ppid,command` is the same column set on
// BSD/macOS and GNU/Linux (session-cleanup.sh:190, same as orchestrator-boot.sh:48),
// and `kill -TERM` is POSIX. Article 17 holds without a branch to name.
//
// PATH IS DELIBERATELY NOT OVERRIDDEN — see the shim's header. A hardcoded
// PATH here would re-open task #400 (stale homebrew telepty vs running daemon).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE } from "./usage.js";

const env = process.env;

const PROTECTED_SID = env.ORCHESTRATOR_SID || "orchestrator";

// Test seams (#606, mirrors orchestrator-boot.sh:40-42): override the process
// lister + killer + self pid so the self/ancestor guard is exercisable with NO
// real process touched. Same names, same defaults as the shell.
const CLEANUP_PS_CMD = env.CLEANUP_PS_CMD || "ps";
const KILL_CMD = env.KILL_CMD || "kill";
const CLEANUP_SELF_PID = env.CLEANUP_SELF_PID || String(process.pid); // `$$`

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` — the repo's (or
// the init workspace's) bin/. The shim exports it so a symlinked entrypoint still
// locates bin/ helpers; the fallback keeps a direct
// `node dist/src/cleanup/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");

// Test seam (#540): the registry component is called to take a cleaned session out
// of the pollers' way. telepty#60 Stage A — lifecycle only; there is no operation
// here that could mark a dispatch reported, because a session vanishing is not a
// task completing.
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY || path.join(SCRIPT_DIR, "dispatch-registry.py");

const WH_CLI = path.join(SCRIPT_DIR, "wh-cli.sh");
const TELEPTY_AUTH_SH = path.join(SCRIPT_DIR, "lib/telepty-auth.sh");
const TELEPTY_LISTING_SH = path.join(SCRIPT_DIR, "lib/telepty-listing.sh");

// ── small process helpers (the tracker's, unchanged) ────────────────────────
/** bash `$(cmd)`: command substitution strips every trailing newline. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

/** stdout captured, stderr discarded (`2>/dev/null`). Status 127 for an unrunnable command, as bash. */
function capture(cmd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/** `cmd >/dev/null 2>&1` — status only. */
function runQuiet(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
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

/**
 * `sleep 0.5` — the brief settle between the parent kill and the registry DELETE,
 * so the daemon has noticed the parent's death before the backup fires. Everything
 * in this file is synchronous (spawnSync), so the wait is too; no guard overrides
 * it, unlike dispatch.sh's `sleep 5`, so it stays a literal half second.
 */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ── the three lib seams ─────────────────────────────────────────────────────
/**
 * The ONE credential resolver, called as the shell function it is
 * (bin/lib/telepty-auth.sh) — identical to src/tracker/cli.ts. Degrades to ""
 * (no credential presented) exactly as the lib does, which is what keeps a
 * teardown working instead of aborting it.
 */
function teleptyAuthToken(): string {
  return chomp(capture("bash", ["-c", '. "$1"; telepty_auth_token', "_", TELEPTY_AUTH_SH]).stdout);
}

/**
 * `telepty_listing_trusted <raw>` from bin/lib/telepty-listing.sh, as a subprocess:
 * 0 when <raw> may be used as evidence that a session is ABSENT, 1 with the
 * disqualifying verdict on stdout when it may not. Only the EMPTY array pays for
 * the corroboration probe — that is the lib's rule and it is not restated here.
 */
function listingTrusted(raw: string): { trusted: boolean; verdict: string } {
  const r = capture("bash", ["-c", '. "$1"; telepty_listing_trusted "$2"', "_", TELEPTY_LISTING_SH, raw]);
  return { trusted: r.status === 0, verdict: chomp(r.stdout) };
}

/** A wh-cli.sh verb: 1:1 with the shell function the script used to source. */
function wh(args: string[]): { status: number; stdout: string } {
  return capture(WH_CLI, args);
}

// ── output ──────────────────────────────────────────────────────────────────
function err(msg: string): void {
  process.stderr.write(`ERR ${msg}\n`);
}

function log(msg: string): void {
  process.stdout.write(`[session-cleanup] ${msg}\n`);
}

function usage(code: number): never {
  process.stdout.write(USAGE + "\n");
  process.exit(code);
}

function requireDeps(): void {
  for (const c of ["telepty", "jq"]) {
    // jq is no longer used by THIS file (JSON.parse replaced it), but it is still
    // used by bin/lib/telepty-listing.sh below and by bin/wh-cli.sh's adapters, and
    // the exit-2 contract is the same either way. Dropping the check would turn a
    // named missing dependency into an unexplained empty verdict two layers down.
    if (!commandExists(c)) {
      err(`${c} not found in PATH`);
      process.exit(2);
    }
  }
}

// ── the single choke point for this script's evidence ───────────────────────
/**
 * `telepty list --json`, fail-fast if the result is not parseable JSON. Prevents
 * silent "session not found" reports when the real cause is a contaminated stdout
 * (e.g. a daemon-version-mismatch banner from the wrong telepty binary on PATH —
 * task #400 root cause).
 *
 * It is also the SINGLE choke point for this script's evidence: killParent,
 * closeWorkspaceFor, wh close-for-sid and deleteSessionRegistry are all downstream
 * of it, on both the single-sid and the batch paths. That is why the #835 trust
 * check belongs here and nowhere else — one guard covers every destructive step,
 * and no path can reach a teardown without passing it.
 *
 * `telepty` is invoked bare, as the shell did: PATH is the seam (this script does
 * not harden it), which is what lets the guards put a stub in front.
 */
function teleptyListJson(): string {
  const r = spawnSync("telepty", ["list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || (r.status ?? 1) !== 0) {
    err("telepty list --json exited non-zero");
    process.exit(3);
  }
  const raw = chomp(r.stdout ?? "");
  if (!isJson(raw)) {
    err("telepty list --json returned non-JSON output (telepty binary/daemon version mismatch?)");
    err("first 200 bytes of stdout:");
    process.stderr.write(Buffer.from(raw, "utf8").subarray(0, 200).toString("utf8"));
    process.stderr.write("\n");
    err(`PATH=${env.PATH ?? ""}`);
    err(`which telepty: ${whichTelepty()}`);
    process.exit(3);
  }
  // `jq -e .` is loud on empty input (exit 4) but exits 0 on `[]`, so the check
  // above passes a refusal straight through — the #400 guard was built for the
  // THROW-shaped failure and an auth refusal is not that shape. An empty list is
  // the only ambiguous answer, and it is precisely the answer that authorizes
  // destruction, so it has to be corroborated before it is believed.
  const { trusted, verdict } = listingTrusted(raw);
  if (!trusted) {
    err(
      `telepty list --json returned [] but the daemon answered '${verdict}' — that is a refusal/failure, not an absence, and an absence is the only thing that may authorize closing a surface or deleting a registry entry. Refusing to clean anything.`,
    );
    switch (verdict) {
      case "unauthorized":
        err("the daemon rejected the credential — check authToken in ~/.telepty/config.json is readable, then re-run");
        break;
      case "unreachable":
        err(
          `no answer from the daemon on 127.0.0.1:${env.TELEPTY_PORT || "3848"} — every live session is its child, so 'unreachable' is not evidence that any session is gone`,
        );
        break;
      case "broken":
        err("the daemon answered with an error status — treat the listing as unusable, not as empty");
        break;
      default:
        break;
    }
    process.exit(3);
  }
  return raw;
}

/** `jq -e .` — valid JSON of any type, and loud (false) on empty input. */
function isJson(raw: string): boolean {
  if (raw === "") return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/** `command -v telepty || echo NOT_FOUND`, for the #400 diagnostic. */
function whichTelepty(): string {
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (dir && executable(path.join(dir, "telepty"))) return path.join(dir, "telepty");
  }
  return "NOT_FOUND";
}

/** The parsed listing, or [] for any shape that is not an array (jq `.[]` on a non-array yields nothing). */
function listing(): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(teleptyListJson());
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
}

/** session_info <sid> → the record's JSON (empty string if not in telepty list). */
function sessionInfo(sid: string): string {
  for (const s of listing()) {
    if (s && s.id === sid) return JSON.stringify(s);
  }
  return "";
}

/** disconnected_sids → DISCONNECTED sessions, excluding PROTECTED. */
function disconnectedSids(): string[] {
  return listing()
    .filter((s) => s && s.healthStatus === "DISCONNECTED" && s.id !== PROTECTED_SID)
    .map((s) => String(s.id));
}

// ── the destructive steps ───────────────────────────────────────────────────
/**
 * Routes through the Workspace Host adapter seam, now via bin/wh-cli.sh.
 * Adapters: cmux / warp / headless(no-op). ADR 2026-05-20. Per verdict 2026-05-30
 * this is the SOLE surface-close path — telepty no longer actuates surface close
 * (it probes liveness + emits surface_orphaned only). The adapter's wh_close is
 * idempotent, so a transient double-close during the telepty-side rollout is
 * harmless (re-probe → already-gone → 0).
 */
function closeWorkspaceFor(sid: string, json: string): void {
  const hostId = chomp(wh(["lookup", sid, json]).stdout);
  if (!hostId) {
    log(`no workspace host id mapped for ${sid}; skipping`);
    return;
  }
  if (wh(["close", hostId]).status === 0) {
    log(`workspace host closed: ${sid} (${hostId})`);
  } else {
    log(`workspace host close non-zero for ${sid} (already closed?)`);
  }
}

/**
 * `ps -eo pid,ppid,command` rows. The -o set is portable across BSD/macOS +
 * GNU/Linux (same columns as orchestrator-boot.sh:48 / session-reconciler.sh) —
 * this is the one place an OS branch could have lived and the shell did not need
 * one either. Routed through CLEANUP_PS_CMD so tests can inject a fixed table
 * without touching the real process list.
 */
function psSnapshot(): string {
  return capture(CLEANUP_PS_CMD, ["-eo", "pid,ppid,command"]).stdout;
}

/** awk's default field splitting: runs of whitespace, leading whitespace ignored. */
function fields(line: string): string[] {
  return line.trim().split(/\s+/);
}

/**
 * SELF pid plus every ancestor pid (walk the ppid chain up to pid 1). Mirrors
 * orchestrator-boot.sh:54 (#539): used to never SIGTERM the bridge we are running
 * inside. The 64-hop cap is the shell's cycle / runaway guard.
 */
function selfAncestry(snap: string): string[] {
  const rows = snap.split("\n");
  const out: string[] = [];
  let pid = CLEANUP_SELF_PID;
  let hops = 0;
  while (pid !== "" && Number(pid) > 1) {
    out.push(pid);
    let ppid = "";
    for (const row of rows) {
      const f = fields(row);
      if (f[0] === pid) {
        ppid = f[1] ?? "";
        break;
      }
    }
    if (ppid === "") break;
    pid = ppid;
    hops += 1;
    if (hops > 64) break;
  }
  return out;
}

/**
 * True when <pid> is the cleanup process itself, one of its ancestors, or an
 * explicitly env-provided orchestrator bridge PID (ORCHESTRATOR_BRIDGE_PIDS,
 * comma/space separated). #606 (cleanup side of #539): SIGTERMing such a PID fires
 * inside the orchestrator's own process tree and cascades a DELETE 'Session
 * destroyed' close to the live control tower. This happens when <sid> was spawned
 * surface-less (forbidden) so its `telepty allow` process is a sibling/child under
 * the tower.
 */
function pidIsSelfOrAncestor(pid: string): boolean {
  if (!pid) return false;
  if (/[^0-9]/.test(pid)) return false; // numeric pids only
  if (selfAncestry(psSnapshot()).includes(pid)) return true;
  // `${bridge_pids//,/ }` then word-splitting: commas AND whitespace separate.
  for (const bp of (env.ORCHESTRATOR_BRIDGE_PIDS || "").split(/[,\s]+/)) {
    if (bp && pid === bp) return true;
  }
  return false;
}

/**
 * Find the `node ... telepty allow --id <sid> ...` process and SIGTERM it. Its
 * child wrapped CLI (claude/codex/gemini/...) dies with it.
 *
 * The shell matched with awk's `$0 ~ ("telepty allow --id " s " ")`, which builds
 * an ERE from the sid. This is a LITERAL substring match instead: identical for
 * every sid without a regex metacharacter, and strictly NARROWER for one that has
 * a `.` — where the ERE could select a different session's process. Narrower is
 * the safe direction on a kill selector: a miss falls through to the existing
 * "already exited?" arm and the surface close + registry DELETE still run, whereas
 * an over-match SIGTERMs the wrong session.
 */
function killParentTeleptyAllow(sid: string): void {
  const needle = `telepty allow --id ${sid} `;
  let pid = "";
  for (const row of psSnapshot().split("\n")) {
    if (row.includes(needle)) {
      pid = fields(row)[0] ?? "";
      break;
    }
  }
  if (!pid) {
    log(`no parent telepty-allow process for ${sid} (already exited?)`);
    return;
  }
  // #606/#539 self/ancestor guard — refuse to SIGTERM a PID inside the
  // orchestrator's own process tree. Skip the kill ONLY; cleanupOne still runs the
  // surface close + registry DELETE. Applies regardless of --force, because force
  // only gates the PROTECTED_SID string check in cleanupOne, never this kill — so
  // no force path can ever signal our own tree.
  if (pidIsSelfOrAncestor(pid)) {
    err(
      `refusing to SIGTERM PID ${pid} for ${sid} — it is in the orchestrator's own process tree; this session was spawned surface-less (forbidden). Close it from the user's terminal.`,
    );
    return;
  }
  if (runQuiet(KILL_CMD, ["-TERM", pid]) === 0) {
    log(`killed parent telepty-allow PID ${pid} for ${sid}`);
  } else {
    log(`kill -TERM PID ${pid} failed for ${sid} (may be exiting)`);
  }
}

/**
 * DELETE /api/sessions/<sid> on the local daemon (daemon.js:2367).
 * 200 = removed, 404 = already gone (after parent kill).
 */
function deleteSessionRegistry(sid: string): void {
  const port = env.TELEPTY_PORT || "3848";
  // The status is discarded, the bytes are not — bash's `$(curl … || true)`. NOT
  // `|| echo "000"`: with -w '%{http_code}' curl prints `000` on a connect failure
  // and ALSO exits non-zero, so the echo idiom appended a second copy and produced
  // `000000` — matching no arm and reaching the catch-all. That is why the
  // no-answer case never had a voice here even after it was given one.
  const http = chomp(
    capture("curl", [
      "-s", "-o", "/dev/null", "-w", "%{http_code}",
      // With no token the header carries no content, and curl DROPS such a header
      // rather than sending an empty one — degraded means "no credential
      // presented", never "empty credential presented as if it were valid".
      "-H", `x-telepty-token: ${teleptyAuthToken()}`,
      "-X", "DELETE", `http://127.0.0.1:${port}/api/sessions/${sid}`,
    ]).stdout,
  );
  switch (http) {
    case "200":
      log(`DELETE /api/sessions/${sid} → 200 (removed from registry)`);
      break;
    case "404":
      log(`DELETE /api/sessions/${sid} → 404 (already gone — parent kill propagated)`);
      break;
    // A refusal is not an unexpected status. Folded into the catch-all it read as
    // "unexpected; manual verify", which says nothing about what to verify — while
    // the actual consequence is a session left in the daemon registry forever,
    // accumulating exactly the way the 21 stale entries of 2026-05-17 did. Named
    // separately, and on stderr, because the operator has to act on it.
    case "401":
    case "403":
      err(
        `DELETE /api/sessions/${sid} → ${http} (daemon refused the credential — the entry STAYS in the daemon registry; check authToken in ~/.telepty/config.json is readable, then re-run)`,
      );
      break;
    // curl's own failure lands here as the literal "000" it printed before exiting
    // non-zero. It shares the refusal's consequence — the entry stays in the
    // registry — but not its cause, and "unexpected" told the operator neither. (#835)
    case "000":
      err(
        `DELETE /api/sessions/${sid} → no answer from the daemon (the entry STAYS in the daemon registry; nothing was removed — re-run once the daemon answers)`,
      );
      break;
    default:
      log(`DELETE /api/sessions/${sid} → ${http} (unexpected; manual verify)`);
  }
}

/**
 * Best-effort: a cleaned session often has no dispatch record at all (a
 * hand-spawned or already-pruned one), and that must not fail the cleanup.
 *
 * --all (#853): a sid carries ONE RECORD PER DISPATCH, and this is a fact about the
 * SESSION — it is gone, so every live record for it is gone. Without --all the
 * registry's singular lookup retired exactly one and left the rest in the --live
 * set permanently, polled forever and HOLDing on every reconcile tick. The more a
 * worker was talked to, the more ghosts its cleanup left behind; the only way to
 * drain them was to re-run this by hand, once per ghost.
 */
function registryCleaned(sid: string): void {
  if (!executable(DISPATCH_REGISTRY_PY)) return;
  if (runQuiet(DISPATCH_REGISTRY_PY, ["observe", "--sid", sid, "--kind", "session_absent_observed", "--all"]) !== 0) {
    return;
  }
  runQuiet(DISPATCH_REGISTRY_PY, ["set-lifecycle", "--sid", sid, "--state", "cleaned", "--all"]);
}

/** 0 on success (including the idempotent no-op), 1 on the Rule 28 protected refusal. */
function cleanupOne(sid: string, force: boolean): number {
  if (sid === PROTECTED_SID && !force) {
    err(`refusing to clean protected session '${PROTECTED_SID}' (pass --force to override)`);
    return 1;
  }
  const info = sessionInfo(sid);
  if (!info) {
    // telepty-orphan: gone from telepty but the terminal surface may still be
    // alive (idle worker deregistered → cmux workspace lingers, #323/#340). Step 4
    // requires BOTH surfaces cleaned regardless of telepty state. `info` is EMPTY
    // here, so close BY SID (close-for-sid) — closeWorkspaceFor(sid, "") would
    // silent-no-op. DELETE backup still runs to drop any registry residue.
    log(`session not in telepty list: ${sid} (already cleaned or never registered); closing terminal surface by sid`);
    wh(["close-for-sid", sid]);
    deleteSessionRegistry(sid);
    // #540 — take the cleaned session out of the pollers' way. telepty#60 Stage A:
    // this is LIFECYCLE only. A session disappearing is not a task completing, so
    // the outcome stays unknown and the record keeps its history.
    registryCleaned(sid);
    return 0;
  }
  // Step 1 — kill parent (load-bearing; auto-deregisters most cases)
  killParentTeleptyAllow(sid);
  // Step 2 — workspace host close via adapter seam (best-effort)
  closeWorkspaceFor(sid, info);
  // Brief settle so daemon notices parent death
  sleepMs(500);
  // Step 3 — DELETE registry (force-remove residue)
  deleteSessionRegistry(sid);
  // #540 — same lifecycle-only mark on the normal kill+close+DELETE path.
  registryCleaned(sid);
  return 0;
}

function cleanupAllDisconnected(): void {
  const sids = disconnectedSids();
  if (sids.length === 0) {
    process.stdout.write("cleaned: 0 disconnected sessions\n");
    return;
  }
  let count = 0;
  for (const sid of sids) {
    if (!sid) continue;
    cleanupOne(sid, false); // `|| true`
    count += 1;
  }
  process.stdout.write(`cleaned: ${count} disconnected sessions\n`);
}

/**
 * jq's `[.id] | inside($keep)` is `$keep | contains([.id])`, and for STRINGS
 * jq's `contains` is SUBSTRING containment, not equality — measured:
 * `["foo"] | inside(["foobar"])` is `true`. So `--keep foobar` also protects the
 * sid `foo`. Reproduced rather than tightened: tightening it to equality would
 * make this port kill sessions the shell script kept, which is the one direction
 * a cleanup tool may not drift in.
 */
function keptByList(id: string, keep: string[]): boolean {
  return keep.some((k) => k.includes(id));
}

/** Every session not in the keep-list and not protected. */
function cleanupAllUnused(keepCsv: string): void {
  const keep = keepCsv.split(",").filter((s) => s.length > 0);
  const sids = listing()
    .filter((s) => s && s.id !== PROTECTED_SID && !keptByList(String(s.id), keep))
    .map((s) => String(s.id));
  if (sids.length === 0) {
    process.stdout.write("cleaned: 0 unused sessions\n");
    return;
  }
  let count = 0;
  for (const sid of sids) {
    if (!sid) continue;
    cleanupOne(sid, false); // `|| true`
    count += 1;
  }
  process.stdout.write(`cleaned: ${count} unused sessions\n`);
}

function main(argv: string[]): void {
  if (argv.length === 0) usage(1);
  requireDeps();

  let modeAllDisc = false;
  let modeAllUnused = false;
  let force = false;
  let sid = "";
  let keepList = "";
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") usage(0);
    else if (a === "--all-disconnected") { modeAllDisc = true; i += 1; }
    else if (a === "--all-unused") { modeAllUnused = true; i += 1; }
    else if (a === "--keep") {
      if (argv.length - i < 2) { err("--keep requires <sid>"); process.exit(1); }
      keepList = (keepList ? keepList + "," : "") + argv[i + 1]!;
      i += 2;
    } else if (a === "--force") { force = true; i += 1; }
    else if (a.startsWith("--")) { err(`unknown flag: ${a}`); process.exit(1); }
    else {
      if (sid) { err(`unexpected positional arg: ${a}`); process.exit(1); }
      sid = a;
      i += 1;
    }
  }

  // Worker-guard (#524, Defense in Depth): session lifecycle (spawn + de-spawn) is
  // the orchestrator's exclusive domain. A spawned worker carries
  // AIGENTRY_WORKER_SESSION=1 (dispatch.sh:97); refuse fail-fast before any
  // kill/close so a worker can never mass-kill peers via --all-unused. The
  // orchestrator and the autonomous reconciler daemon run WITHOUT this marker, so
  // both pass. Precedent: dispatch.sh:70 install_worker_git_guard.
  if (env.AIGENTRY_WORKER_SESSION) {
    err(
      "session-cleanup.sh is orchestrator-only — refusing to run from a worker session (AIGENTRY_WORKER_SESSION set). Session lifecycle is the orchestrator's domain.",
    );
    process.exit(4);
  }

  if (modeAllDisc) {
    if (sid) { err("--all-disconnected does not take a sid argument"); process.exit(1); }
    cleanupAllDisconnected();
    process.exit(0);
  }

  if (modeAllUnused) {
    if (sid) { err("--all-unused does not take a sid argument"); process.exit(1); }
    cleanupAllUnused(keepList);
    process.exit(0);
  }

  if (!sid) { err("<sid> required (or use --all-disconnected / --all-unused)"); usage(1); }
  // `set -e` on the shell's last statement: a protected refusal (1) is the
  // script's exit status.
  process.exit(cleanupOne(sid, force));
}

// ── __probe: the test seam that replaced `source session-cleanup.sh` ────────
// tests/dispatch/T52 used to source this script and call kill_parent_telepty_allow
// / pid_is_self_or_ancestor as bash functions. An exec shim exports no shell
// functions, so those behaviours are reachable here instead — same seams
// (CLEANUP_PS_CMD / KILL_CMD / CLEANUP_SELF_PID), same fixtures, same assertions,
// now measuring the code production actually runs. Internal surface: not a flag,
// not in --help, no caller outside tests/dispatch/.
function probe(argv: string[]): never {
  const sub = argv[0];
  if (sub === "kill-parent") {
    // __probe kill-parent <sid> — always 0, as the shell function was.
    killParentTeleptyAllow(argv[1] ?? "");
    process.exit(0);
  }
  if (sub === "pid-is-self-or-ancestor") {
    // __probe pid-is-self-or-ancestor <pid> → 0 self/ancestor/bridge, 1 unrelated.
    process.exit(pidIsSelfOrAncestor(argv[1] ?? "") ? 0 : 1);
  }
  process.stderr.write(`session-cleanup.sh: unknown __probe subcommand: ${String(sub)}\n`);
  process.exit(4);
}

const argv = process.argv.slice(2);
if (argv[0] === "__probe") {
  probe(argv.slice(1));
} else {
  main(argv);
}
