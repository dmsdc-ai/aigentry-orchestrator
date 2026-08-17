// bin/telepty-bus-bridge.sh's implementation, ported to TypeScript (#899 tranche 4).
//
// This is a PORT, not a redesign (Rule 29 + Constitution Art. 1): every flag, exit
// code, log line, health-file key, state-dir path and subprocess argv is the shell
// script's, preserved deliberately. bin/telepty-bus-bridge.sh is now an exec shim
// onto this file, so the reconciler's per-tick `BUS_BRIDGE_SH --ensure`
// (src/reconciler/cli.ts:1309) is unchanged. What the bridge IS — the two event
// kinds, the drain race and why there is no lock, the honest lossiness of a
// reconnect — is documented in that shim's header and in the shell script's git
// history, and none of it changed here.
//
// THE ONE LIB THIS SCRIPT USED TO SOURCE, and what it became:
//
//   lib/telepty-listing.sh → `bash -c '. "$1"; telepty_listing_verdict'`, the idiom
//     src/cleanup/cli.ts:139 and src/reconciler/cli.ts already use. The verdict is
//     the gate that keeps this bridge from ever starting a daemon (the shim header
//     explains why that matters), and lib/telepty-auth.sh — sourced by the listing
//     lib — stays the ONE token read in this repo, which tests/dispatch/T87
//     asserts. A TypeScript copy of either would be a second place for that rule to
//     drift. `CURL` and `TELEPTY_PORT` reach the lib by environment inheritance,
//     so tests/dispatch/T95's curl-200 stub still redirects the probe.
//
// bin/lib/workspace-host.sh is NOT reached by this script and is untouched (T3b
// declined). bin/dispatch-registry.py, policy.py and session-probe.py are not
// reached by this script either.
//
// NO `process.platform` BRANCH EXISTS HERE, because the shell had no OS arm.
// Enumerated candidates and where each landed: `date -u +…` (POSIX) → Date;
// `kill -0` (POSIX) → process.kill(pid, 0); `wc -l` / `tail -n` / `mv` / `rm -f` /
// `mkdir -p` (this script's own logic) → node:fs; `mkfifo` → GONE with the FIFO
// (see the shim header); `ps -p <pid> -o command=` → kept as a subprocess with the
// identical flag set, which is spelled the same on BSD and GNU.
//
// TWO BYTE-LEVEL SHAPES THE PORT MAY NOT NORMALISE, both pinned by T118:
//
//   * bus-bridge-health.json was written by `json.dump(cur, fh, ensure_ascii=False,
//     sort_keys=True)` — python's DEFAULT separators, which are ", " and ": " with
//     a space, sorted keys, and a trailing newline. tests/dispatch/T95:253 greps
//     `'"state": "connected"'` WITH that space. JSON.stringify emits no spaces, so
//     the serializer below is python-shaped on purpose, not by accident.
//   * the projected event line was `jq -rc '… | tostring'` — COMPACT (no spaces),
//     the field order written in the filter, and `null` for a key the event does
//     not carry (jq's `{sid}` semantics on a missing key). T95:125-129 greps the
//     compact forms.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` — the repo's (or
// the init workspace's) bin/. The shim exports it so a symlinked entrypoint still
// locates bin/ helpers; the fallback keeps a direct
// `node dist/src/bus-bridge/cli.js` working.
const SELF_JS = fileURLToPath(import.meta.url);
const SCRIPT_DIR = env.AIGENTRY_SHIM_SCRIPT_DIR || path.resolve(SELF_JS, "../../../../bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");
const STATE_DIR = env.DISPATCH_STATE_DIR || path.join(REPO_DIR, "state/dispatch");
// The SAME two env names the reconciler resolves its sources with, so a test that
// redirects one end redirects both (src/reconciler/cli.ts).
const SURFACE_ORPHANED_SRC =
  env.AIGENTRY_SURFACE_ORPHANED_SOURCE || path.join(STATE_DIR, "surface-orphaned.jsonl");
const SURFACE_MISMATCHED_SRC =
  env.AIGENTRY_SURFACE_MISMATCHED_SOURCE || path.join(STATE_DIR, "surface-mismatched.jsonl");
const PIDFILE = path.join(STATE_DIR, "bus-bridge.pid");
const HEALTH = path.join(STATE_DIR, "bus-bridge-health.json");
const ERRLOG = path.join(STATE_DIR, "bus-bridge.err");
const LOG = path.join(STATE_DIR, "reconciler.log"); // the log an operator already reads
const TELEPTY = env.TELEPTY || "telepty";
const TELEPTY_LISTING_SH = path.join(SCRIPT_DIR, "lib/telepty-listing.sh");

/** `${VAR:-default}` for a numeric knob: unset OR empty falls back, as bash does. */
function numEnv(name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

const READ_TIMEOUT = numEnv("BUS_BRIDGE_READ_TIMEOUT", 15);
const HEARTBEAT_SECONDS = numEnv("BUS_BRIDGE_HEARTBEAT_SECONDS", 60);
const BACKOFF_INITIAL = numEnv("BUS_BRIDGE_BACKOFF_INITIAL", 5);
const BACKOFF_MAX = numEnv("BUS_BRIDGE_BACKOFF_MAX", 300);
const SPOOL_MAX = numEnv("BUS_BRIDGE_SPOOL_MAX", 1000);
const ERRLOG_MAX_BYTES = numEnv("BUS_BRIDGE_ERRLOG_MAX", 65536);

// The whole filter, and the whole projection. Two kinds pass; each is cut down to
// the field set the consumer documents, plus the daemon's own timestamp so a reader
// can tell a fresh event from one that waited out a drain. `extra` is spread at the
// top level of a bus event (daemon.js buildSessionEvent), so these are top-level
// reads, not a nested payload. Field ORDER is the jq filter's and is load-bearing:
// it is the byte order of the line the consumer reads.
const PROJECTION: Record<string, readonly string[]> = {
  surface_orphaned: ["sid", "backend", "cmuxWorkspaceId", "surfaceGoneSeconds", "livenessVerdict", "timestamp"],
  surface_mismatched: [
    "sid",
    "backend",
    "cmuxWorkspaceId",
    "expectedPtyPid",
    "observedSurface",
    "mismatchSeconds",
    "timestamp",
  ],
};

// ── small shell equivalents ─────────────────────────────────────────────────
function capture(cmd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.error) return { status: 127, stdout: "" };
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `[ -s <p> ]` — exists and is non-empty. */
function nonEmpty(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` — no sub-second field, as the shell had none. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `date +%s`, and the origin for the heartbeat clock the shell read from $SECONDS. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** `printf … | tee -a "$LOG" >&2` — the operator's log AND stderr, in that order. */
function log(msg: string): void {
  const line = `${nowIso()} ${msg}\n`;
  try {
    fs.appendFileSync(LOG, line);
  } catch {
    /* tee's own failure never stopped the bridge from saying it on stderr */
  }
  process.stderr.write(line);
}

// ── bus-bridge-health.json ──────────────────────────────────────────────────
/**
 * python's `json.dump(obj, ensure_ascii=False, sort_keys=True)`: ", " and ": "
 * separators, keys sorted, non-ASCII left raw. See the header — T95 greps the
 * space, so this shape is contract, not style.
 */
function pyDump(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(pyDump).join(", ")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}: ${pyDump(o[k])}`)
      .join(", ")}}`;
  }
  return JSON.stringify(v);
}

function readHealth(): Record<string, unknown> {
  try {
    const cur: unknown = JSON.parse(fs.readFileSync(HEALTH, "utf8"));
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return {};
    return cur as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * health_update <set> [inc] — merge into bus-bridge-health.json. One object,
 * rewritten atomically: a status file, never a ledger. Every failure is swallowed,
 * exactly as the shell's `2>/dev/null || true` did: a health file that cannot be
 * written must never take the bridge down.
 */
function healthUpdate(set: Record<string, unknown>, inc: Record<string, number> = {}): void {
  try {
    const cur = readHealth();
    Object.assign(cur, set);
    for (const [key, delta] of Object.entries(inc)) {
      // python: `(cur.get(key) or 0) + delta`, and a TypeError from a non-numeric
      // existing value fell through to `cur[key] = delta`. JS would have silently
      // concatenated a string instead, which is why the type is checked.
      const base = cur[key] ? cur[key] : 0;
      cur[key] = typeof base === "number" ? base + delta : delta;
    }
    const tmp = `${HEALTH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${pyDump(cur)}\n`);
    fs.renameSync(tmp, HEALTH);
  } catch {
    /* status file, best effort */
  }
}

/** health_field <key> — the value as the shell's `$(…)` saw it, or "". */
function healthField(key: string): string {
  const val = readHealth()[key];
  return val === undefined || val === null ? "" : String(val);
}

// ── the singleton ───────────────────────────────────────────────────────────
/**
 * bridge_pid — the pid of a LIVE bridge, or "". The pid is corroborated against the
 * process's own command line: a recycled pid is how a stale pidfile convinces every
 * future instance that a bridge it cannot see is running.
 *
 * THE CORROBORATION SUBSTRING IS THE ONE CONTRACT CHANGE THIS PORT MAKES (Rule 38).
 * The shell matched the literal `telepty-bus-bridge`, which was its own argv. A
 * ported bridge runs as `node …/dist/src/bus-bridge/cli.js --run` and does NOT carry
 * that literal, so an unchanged check would report "no bridge" for a bridge that is
 * genuinely alive — and the reconciler's per-tick `--ensure` would start a second
 * one every 60s, which is precisely the duplicate-writer scar (#539/#618) the
 * singleton exists to prevent. Both literals are accepted, and only those two: a
 * bare `bus-bridge` would corroborate any recycled pid that merely happened to
 * carry those characters in its cwd or arguments, which is the failure the ps
 * cross-check is here to refuse. `telepty-bus-bridge` keeps the ORIGINAL bash at
 * e2c3a36 corroborating too, which is what lets T118 run against both.
 */
const BRIDGE_ARGV_MARKERS = ["telepty-bus-bridge", "bus-bridge/cli.js"] as const;

function bridgePid(): string {
  let raw: string;
  try {
    if (!fs.statSync(PIDFILE).isFile()) return "";
    raw = fs.readFileSync(PIDFILE, "utf8");
  } catch {
    return "";
  }
  // `$(cat …)` strips trailing newlines; the case arm then refused empty or any
  // non-digit, a newline in the middle included.
  const pid = raw.replace(/\n+$/, "");
  if (!/^[0-9]+$/.test(pid)) return "";
  try {
    process.kill(Number(pid), 0); // kill -0: EPERM counts as "not ours", as in bash
  } catch {
    return "";
  }
  const cmd = capture("ps", ["-p", pid, "-o", "command="]).stdout;
  if (!BRIDGE_ARGV_MARKERS.some((m) => cmd.includes(m))) return "";
  return pid;
}

/**
 * acquire_singleton — #539/#618: two bridges writing one spool is the duplicate-
 * writer scar this ecosystem already wears. The second instance says so and exits 0;
 * a losing instance is a normal outcome, not a failure.
 */
function acquireSingleton(): boolean {
  const other = bridgePid();
  if (other) {
    log(`BUS_BRIDGE already running pid=${other} — this instance exits (single-writer, #539/#618)`);
    return false;
  }
  try {
    fs.rmSync(PIDFILE, { force: true });
  } catch {
    /* rm -f */
  }
  // `set -C; : > "$PIDFILE"` — noclobber create, i.e. O_CREAT|O_EXCL.
  let fd: number;
  try {
    fd = fs.openSync(PIDFILE, "wx");
  } catch {
    log("BUS_BRIDGE lost the pidfile race — this instance exits (single-writer, #539/#618)");
    return false;
  }
  fs.closeSync(fd);
  fs.writeFileSync(PIDFILE, `${process.pid}\n`);
  return true;
}

// ── the spool, and the rename-install that makes the drain race safe ────────
/**
 * install_spool <src> — publish the spooled batch as <src> by rename, but only when
 * the consumer has drained the previous one. See the drain-race note in the shim
 * header: the "absent" test is what makes the rename safe, so it is not an
 * optimisation.
 */
function installSpool(src: string): void {
  const spool = `${src}.spool`;
  if (!nonEmpty(spool)) return;
  if (exists(src)) return;
  try {
    fs.renameSync(spool, src);
  } catch {
    /* `mv … || true` */
  }
}

/** `wc -l` — a count of newlines, which is a count of records because every append ends in one. */
function countLines(p: string): number {
  try {
    const body = fs.readFileSync(p, "utf8");
    let n = 0;
    for (let i = 0; i < body.length; i++) if (body[i] === "\n") n++;
    return n;
  } catch {
    return 0;
  }
}

/**
 * spool_append <src> <json> — the only write path. Capped: if the reconciler stops
 * draining, this must not grow without bound, and a drop must be counted rather
 * than absorbed.
 */
function spoolAppend(src: string, json: string): void {
  const spool = `${src}.spool`;
  fs.appendFileSync(spool, `${json}\n`);
  const lines = countLines(spool);
  if (lines > SPOOL_MAX) {
    const drops = lines - SPOOL_MAX;
    try {
      // `tail -n "$SPOOL_MAX" > "$spool.trim" && mv`
      const kept = fs.readFileSync(spool, "utf8").split("\n");
      if (kept[kept.length - 1] === "") kept.pop();
      fs.writeFileSync(`${spool}.trim`, `${kept.slice(-SPOOL_MAX).join("\n")}\n`);
      fs.renameSync(`${spool}.trim`, spool);
      healthUpdate({}, { events_dropped: drops });
      log(
        `BUS_BRIDGE spool cap (${SPOOL_MAX}) hit for ${path.basename(src)} — dropped ${drops} oldest event(s); nothing is draining ${path.basename(src)}`,
      );
    } catch {
      /* the shell's `if tail … ; then` — a failed trim leaves the spool alone */
    }
  }
  installSpool(src);
  healthUpdate({ last_event_at: nowIso() }, { events_bridged: 1 });
}

/** bridge_line <raw> — one line off the bus. */
function bridgeLine(line: string): void {
  if (!line.startsWith("{")) return; // the CLI's own banner, colour codes
  let ev: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    ev = parsed as Record<string, unknown>;
  } catch {
    return; // jq's `2>/dev/null || true` on a line it cannot parse
  }
  const kind = typeof ev.type === "string" ? ev.type : "";
  const fields = PROJECTION[kind];
  if (!fields) return;
  const proj: Record<string, unknown> = {};
  for (const k of fields) proj[k] = ev[k] === undefined ? null : ev[k]; // jq: `{sid}` on a missing key is null
  const payload = JSON.stringify(proj); // jq -c | tostring: compact, this field order
  if (kind === "surface_orphaned") spoolAppend(SURFACE_ORPHANED_SRC, payload);
  else spoolAppend(SURFACE_MISMATCHED_SRC, payload);
}

/**
 * bridge_tick — run after EVERY read, event or timeout, and paced by wall clock.
 * Two jobs:
 *   * retry the install — a batch spooled behind an undrained file would otherwise
 *     wait for the next event, which may never come;
 *   * heartbeat, so "connected and silent" and "wedged" do not look alike.
 * Measured, not assumed: an earlier version ticked only on the read TIMEOUT, and a
 * 90s subscription to the real bus never ticked once — session_activity_observation
 * arrives faster than the timeout, so the busiest bus was the one that never
 * heartbeated. install_spool is two stat() calls, cheap enough for every line.
 */
let lastBeat = 0;
function bridgeTick(): void {
  installSpool(SURFACE_ORPHANED_SRC);
  installSpool(SURFACE_MISMATCHED_SRC);
  if (nowSec() - lastBeat >= HEARTBEAT_SECONDS) {
    lastBeat = nowSec();
    healthUpdate({ heartbeat_at: nowIso() });
  }
}

// ── the subscription ────────────────────────────────────────────────────────
/**
 * `telepty_listing_verdict` from bin/lib/telepty-listing.sh, as a subprocess. The
 * lib decides reachability; this file does not re-derive it. CURL and TELEPTY_PORT
 * are inherited, which is what keeps T95's stub seam working.
 */
function listingVerdict(): string {
  return capture("bash", ["-c", '. "$1"; telepty_listing_verdict', "_", TELEPTY_LISTING_SH]).stdout;
}

/**
 * subscribe — one connected lifetime. Resolves when the listener dies; the caller
 * owns the reconnect.
 *
 * THE FIFO IS GONE (#899 tranche 4, decided at the disposition gate — see the shim
 * header). The shell needed `mkfifo` + `exec 3<>` because a bash PIPELINE leaves the
 * listener orphaned holding a bus socket and gives no pid to end deterministically,
 * and because a write-only open would block. child_process.spawn has all three
 * properties natively, so `$STATE_DIR/bus-bridge.fifo` is no longer created and the
 * shell's "cannot create <fifo> — not subscribing" arm no longer has a way to fire.
 *
 * The read discipline is unchanged and is load-bearing: liveness is checked on the
 * TIMEOUT path only, never straight after a read. A listener that emitted three
 * events and then died must have all three drained out of the pipe first — which is
 * why the queue below is emptied before `ended` is allowed to break the loop.
 */
let listenChild: ReturnType<typeof spawn> | null = null;

async function subscribe(): Promise<void> {
  if (exists(ERRLOG)) {
    try {
      if (fs.statSync(ERRLOG).size > ERRLOG_MAX_BYTES) fs.writeFileSync(ERRLOG, "");
    } catch {
      /* `: > "$ERRLOG"` */
    }
  }
  const errFd = fs.openSync(ERRLOG, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(TELEPTY, ["listen"], { stdio: ["ignore", "pipe", errFd] });
  } catch {
    fs.closeSync(errFd);
    return;
  }
  listenChild = child;

  const queue: string[] = [];
  let buf = "";
  let ended = false;
  let exited = false;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      queue.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    signal();
  });
  child.stdout?.on("end", () => {
    ended = true;
    signal();
  });
  child.stdout?.on("error", () => {
    ended = true;
    signal();
  });
  child.on("exit", () => {
    exited = true;
    signal();
  });
  child.on("error", () => {
    // ENOENT on the telepty binary: the listener never lived. The shell reported
    // this into $ERRLOG via the redirection and saw the subshell exit at once.
    exited = true;
    ended = true;
    signal();
  });

  healthUpdate({
    state: "connected",
    connected_at: nowIso(),
    listen_pid: child.pid ?? 0,
    note: "",
  });

  for (;;) {
    const line = queue.shift();
    if (line !== undefined) {
      bridgeLine(line);
      bridgeTick();
      continue;
    }
    if (ended) break; // the pipe closed AFTER everything in it was drained
    const timedOut = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve(true);
      }, READ_TIMEOUT * 1000);
      wake = () => {
        clearTimeout(t);
        resolve(false);
      };
    });
    if (!timedOut) continue;
    if (exited) break; // the timeout path's `kill -0 "$listen_pid" || break`
    bridgeTick();
  }

  child.stdout?.destroy(); // `exec 3<&-`
  if (!exited) {
    child.kill(); // SIGTERM, as the shell's bare `kill` sent
    await new Promise<void>((resolve) => {
      if (exited) return resolve();
      child.once("exit", () => resolve()); // `wait "$listen_pid"`
    });
  }
  listenChild = null;
  try {
    fs.closeSync(errFd);
  } catch {
    /* already gone */
  }
}

/**
 * bridge_cleanup — the listener is OUR child and holds a bus socket; a bridge that
 * is signalled away without ending it leaves a subscriber nobody supervises, which
 * the next --ensure would then double.
 */
let cleaned = false;
function bridgeCleanup(): void {
  if (cleaned) return;
  cleaned = true;
  if (listenChild) {
    try {
      listenChild.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    fs.rmSync(PIDFILE, { force: true });
  } catch {
    /* rm -f */
  }
}

// ── the two verbs ───────────────────────────────────────────────────────────
async function runBridge(): Promise<never> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!acquireSingleton()) process.exit(0);
  process.on("exit", bridgeCleanup); // trap bridge_cleanup EXIT
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      bridgeCleanup();
      process.exit(0);
    });
  }
  let backoff = BACKOFF_INITIAL;
  let downAt = 0;
  lastBeat = nowSec();
  healthUpdate({ pid: process.pid, started_at: nowIso(), state: "starting" });
  log(
    `BUS_BRIDGE started pid=${process.pid} src=${path.basename(SURFACE_ORPHANED_SRC)},${path.basename(SURFACE_MISMATCHED_SRC)}`,
  );
  for (;;) {
    // A vanished state dir means the tree this bridge was writing into is gone
    // (hermetic test teardown, or a wiped state). Exit rather than recreate it.
    try {
      if (!fs.statSync(STATE_DIR).isDirectory()) process.exit(0);
    } catch {
      process.exit(0);
    }
    const verdict = listingVerdict();
    if (verdict !== "ok") {
      healthUpdate({ state: "degraded", note: `daemon ${verdict}`, checked_at: nowIso() });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
      continue;
    }
    if (downAt) {
      const gap = nowSec() - downAt;
      healthUpdate({ last_gap_seconds: gap, reconnected_at: nowIso() }, { gap_seconds_total: gap });
      log(
        `BUS_BRIDGE reconnected after ${gap}s — surface events emitted in that window are LOST and are not replayed; the wh_alive sweep is what covers them`,
      );
      downAt = 0;
    }
    const upAt = nowSec();
    try {
      await subscribe(); // `subscribe || true`
    } catch {
      /* a failed subscription is a disconnect, not a crash */
    }
    downAt = nowSec();
    healthUpdate({ state: "disconnected", disconnected_at: nowIso() }, { disconnects: 1 });
    // A listener that did not even stay up for one read window is failing, not
    // flapping — respawning it every BACKOFF_INITIAL would be a tight loop against
    // whatever is refusing (a rotated token, a CLI that cannot run). Back off on
    // that; reset only after a subscription that actually lived.
    if (downAt - upAt < READ_TIMEOUT) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    } else {
      await sleep(BACKOFF_INITIAL);
      backoff = BACKOFF_INITIAL;
    }
  }
}

/**
 * ensure_bridge — the supervision step, idempotent, cheap, and silent when the
 * bridge is already up. Called once per reconcile tick, so a bridge that died is
 * back within one tick and the dead window is named in reconciler.log.
 *
 * `nohup "$SCRIPT_SELF" --run >> "$ERRLOG" 2>&1 &` became a detached spawn of THIS
 * module: the shell re-executed itself, and the compiled module is what "itself" is
 * now. detached + unref is nohup's disposition — a new process group, so the child
 * outlives the reconciler tick that started it. Its argv is
 * `node …/dist/src/bus-bridge/cli.js --run`, which is the second marker bridgePid()
 * corroborates against.
 */
function ensureBridge(): void {
  const other = bridgePid();
  if (other) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const last = healthField("heartbeat_at") || healthField("started_at");
  const fd = fs.openSync(ERRLOG, "a");
  const child = spawn(process.execPath, [SELF_JS, "--run"], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  log(
    `BUS_BRIDGE not running — started (last seen alive: ${last || "never"}; surface events since then were never bridged)`,
  );
}

function usage(code: number): never {
  process.stdout.write(`${USAGE}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "--help"; // `case "${1:---help}"`
  switch (arg) {
    case "--ensure":
      ensureBridge();
      return;
    case "--run":
      await runBridge();
      return;
    case "-h":
    case "--help":
      return usage(0);
    default:
      process.stderr.write(`unknown argument: ${arg}\n`);
      return usage(2);
  }
}

await main();
