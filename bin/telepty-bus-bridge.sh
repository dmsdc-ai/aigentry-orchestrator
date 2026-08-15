#!/usr/bin/env bash
# telepty-bus-bridge.sh — the bus→file bridge the surface-event consumers wait for
# (#847). telepty 0.8.0 signals, this repo actuates: the daemon broadcasts
# `surface_orphaned` / `surface_mismatched` on ws://127.0.0.1:3848/api/bus and
# stops there (BOUNDARY: telepty signals, the orchestrator acts). The reconciler's
# consume_surface_orphaned / consume_surface_mismatched read JSONL files nobody
# wrote, so both were dormant. This subscribes to the bus and writes exactly those
# two event kinds, one JSON object per line, into exactly those files.
#
# Usage:
#   telepty-bus-bridge.sh --ensure  # start it if it is not running (reconciler tick)
#   telepty-bus-bridge.sh --run     # the bridge itself; foreground, long-lived
#   telepty-bus-bridge.sh --help
#
# WHAT IT DOES NOT DO, deliberately:
#
# * It never starts, stops or restarts the daemon. `telepty listen` calls the CLI's
#   ensureDaemonRunning(), which STARTS a daemon it cannot reach (cli.js:4136), so
#   every connect is gated on telepty_listing_verdict() == ok first — an already-up
#   daemon makes that call a no-op. Daemon down ⇒ this backs off and stays down too.
# * It never mirrors the bus. The bus carries session_activity_observation at PTY
#   rate; a bridge that wrote all of it would build the second unbounded ledger this
#   ecosystem just spent a release removing. Two event kinds, projected down to the
#   documented consumer contract, and nothing else.
# * It never fabricates or replays. If the socket drops, events emitted during the
#   gap are LOST — telepty's `alreadySignalled` latch means a missed surface_orphaned
#   is never re-emitted (daemon.js:5959). That is honest degradation, not a defect:
#   the reconciler's always-on wh_alive sweep (step 2) covers exactly this window,
#   which is why the event path is allowed to be lossy and the sweep is not. Every
#   gap is counted and timestamped in bus-bridge-health.json and announced as one
#   line in reconciler.log, because a silent gap would be the dishonest version.
#
# THE DRAIN RACE, and why there is no lock.
#
# The consumers drain what they read. The naive bridge appends to the same file the
# consumer truncates, and any event appended between the consumer's last read and
# its truncate is lost with no trace. So the two never share a mutable file:
#
#   bridge  → appends ONLY to <src>.spool, and is the ONLY writer of it (singleton).
#   bridge  → installs the spool as <src> by rename(2), and ONLY when <src> is absent.
#   consumer→ reads <src>, then REMOVES it (rm, not truncate — see the reconciler
#             change that accompanies this file). It is the only remover.
#
# <src> exists for the whole of the consumer's read (the rm comes after), so the
# bridge's "absent?" test cannot pass mid-read, so the rename cannot land under a
# reader; and the consumer never removes a file it has not fully read. Lossless in
# both directions with no lock, no lock staleness, and no blocking of a tick — which
# matters because there is no flock(1) on macOS and a shell mutex would need stale-
# holder recovery of its own.
#
# Cost of that choice: an event that arrives while an undrained batch is still
# pending waits in the spool for at most one reconcile tick. The consumers are
# tick-driven anyway (60s), so this adds no latency the actuation path can feel.
#
# Article 17: shell + jq + curl + the telepty CLI. No npm runtime deps, no WS client
# of our own — `telepty listen` (cli.js) already is one, and it resolves the daemon
# token internally, so this script never reads, holds, or passes a credential on a
# command line (ps-visible). The one token read in this repo stays in
# bin/lib/telepty-auth.sh, which lib/telepty-listing.sh sources for the reachability
# probe (T87 asserts there is exactly one).

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Same launchd recovery the reconciler does (session-reconciler.sh:40-45): this can
# be spawned from a reconciler tick that launchd started with no HOME, and the token
# resolver builds its path from $HOME.
: "${HOME:=$(cd ~ 2>/dev/null && pwd -P)}"
export HOME

SCRIPT_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_SELF")"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
# The SAME two env names the reconciler resolves its sources with, so a test that
# redirects one end redirects both (session-reconciler.sh:84,93).
SURFACE_ORPHANED_SRC="${AIGENTRY_SURFACE_ORPHANED_SOURCE:-$STATE_DIR/surface-orphaned.jsonl}"
SURFACE_MISMATCHED_SRC="${AIGENTRY_SURFACE_MISMATCHED_SOURCE:-$STATE_DIR/surface-mismatched.jsonl}"
PIDFILE="$STATE_DIR/bus-bridge.pid"
HEALTH="$STATE_DIR/bus-bridge-health.json"
FIFO="$STATE_DIR/bus-bridge.fifo"
ERRLOG="$STATE_DIR/bus-bridge.err"
LOG="$STATE_DIR/reconciler.log"   # the log an operator already reads
TELEPTY="${TELEPTY:-telepty}"
READ_TIMEOUT="${BUS_BRIDGE_READ_TIMEOUT:-15}"
HEARTBEAT_SECONDS="${BUS_BRIDGE_HEARTBEAT_SECONDS:-60}"
BACKOFF_INITIAL="${BUS_BRIDGE_BACKOFF_INITIAL:-5}"
BACKOFF_MAX="${BUS_BRIDGE_BACKOFF_MAX:-300}"
SPOOL_MAX="${BUS_BRIDGE_SPOOL_MAX:-1000}"
ERRLOG_MAX_BYTES="${BUS_BRIDGE_ERRLOG_MAX:-65536}"

# The reachability probe + the one credential resolver it sources (#824).
# shellcheck source=lib/telepty-listing.sh
. "$SCRIPT_DIR/lib/telepty-listing.sh"

# The whole filter, and the whole projection. Two kinds pass; each is cut down to
# the field set the consumer documents, plus the daemon's own timestamp so a reader
# can tell a fresh event from one that waited out a drain. `extra` is spread at the
# top level of a bus event (daemon.js buildSessionEvent), so these are top-level
# reads, not a nested payload. Output is "<kind><TAB><compact json>".
BRIDGE_FILTER='
  select(.type == "surface_orphaned" or .type == "surface_mismatched")
  | .type + "\t" + (
      if .type == "surface_orphaned" then
        {sid, backend, cmuxWorkspaceId, surfaceGoneSeconds, livenessVerdict, timestamp}
      else
        {sid, backend, cmuxWorkspaceId, expectedPtyPid, observedSurface, mismatchSeconds, timestamp}
      end | tostring)
'

usage() { sed -n '9,13p' "$0"; exit "${1:-0}"; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log() { printf '%s %s\n' "$(now_iso)" "$*" | tee -a "$LOG" >&2; }

# health_update <set-json> [inc-json] — merge into bus-bridge-health.json. One
# object, rewritten atomically: a status file, never a ledger.
health_update() {
  local inc="${2:-}"
  [ -n "$inc" ] || inc='{}'
  HB_SET="$1" HB_INC="$inc" HB_PATH="$HEALTH" python3 - <<'PY' 2>/dev/null || true
import json, os, tempfile
path = os.environ["HB_PATH"]
try:
    with open(path, encoding="utf-8") as fh:
        cur = json.load(fh)
    if not isinstance(cur, dict):
        cur = {}
except Exception:
    cur = {}
cur.update(json.loads(os.environ["HB_SET"]))
for key, delta in json.loads(os.environ["HB_INC"]).items():
    try:
        cur[key] = (cur.get(key) or 0) + delta
    except TypeError:
        cur[key] = delta
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".")
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    json.dump(cur, fh, ensure_ascii=False, sort_keys=True)
    fh.write("\n")
os.replace(tmp, path)
PY
}

health_field() {  # health_field <key> — print it, or nothing
  HB_PATH="$HEALTH" HB_KEY="$1" python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    with open(os.environ["HB_PATH"], encoding="utf-8") as fh:
        val = json.load(fh).get(os.environ["HB_KEY"])
except Exception:
    val = None
print("" if val is None else val)
PY
}

# bridge_pid — the pid of a LIVE bridge, or nothing. The pid is corroborated
# against the process's own command line: a recycled pid is how a stale pidfile
# convinces every future instance that a bridge it cannot see is running.
bridge_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 0
  pid=$(cat "$PIDFILE" 2>/dev/null || true)
  case "$pid" in ''|*[!0-9]*) return 0;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  ps -p "$pid" -o command= 2>/dev/null | grep -q 'telepty-bus-bridge' || return 0
  printf '%s' "$pid"
}

# acquire_singleton — #539/#618: two bridges writing one spool is the duplicate-
# writer scar this ecosystem already wears. The second instance says so and exits 0;
# a losing instance is a normal outcome, not a failure.
acquire_singleton() {
  local other
  other=$(bridge_pid)
  if [ -n "$other" ]; then
    log "BUS_BRIDGE already running pid=$other — this instance exits (single-writer, #539/#618)"
    return 1
  fi
  rm -f "$PIDFILE"
  set -C
  if ! : > "$PIDFILE" 2>/dev/null; then
    set +C
    log "BUS_BRIDGE lost the pidfile race — this instance exits (single-writer, #539/#618)"
    return 1
  fi
  set +C
  printf '%s\n' "$$" > "$PIDFILE"
  return 0
}

# install_spool <src> — publish the spooled batch as <src> by rename, but only when
# the consumer has drained the previous one. See the drain-race note in the header:
# the "absent" test is what makes the rename safe, so it is not an optimisation.
install_spool() {
  local src="$1" spool="$1.spool"
  [ -s "$spool" ] || return 0
  [ -e "$src" ] && return 0
  mv "$spool" "$src" 2>/dev/null || true
}

# spool_append <src> <json> — the only write path. Capped: if the reconciler stops
# draining, this must not grow without bound, and a drop must be counted rather
# than absorbed.
spool_append() {
  local src="$1" json="$2" spool="$1.spool" lines drops
  printf '%s\n' "$json" >> "$spool"
  lines=$(wc -l < "$spool" 2>/dev/null | tr -d ' ')
  if [ "${lines:-0}" -gt "$SPOOL_MAX" ]; then
    drops=$((lines - SPOOL_MAX))
    if tail -n "$SPOOL_MAX" "$spool" > "$spool.trim" 2>/dev/null; then
      mv "$spool.trim" "$spool"
      health_update '{}' "{\"events_dropped\": $drops}"
      log "BUS_BRIDGE spool cap ($SPOOL_MAX) hit for $(basename "$src") — dropped $drops oldest event(s); nothing is draining $(basename "$src")"
    fi
  fi
  install_spool "$src"
  health_update "{\"last_event_at\": \"$(now_iso)\"}" '{"events_bridged": 1}'
}

# bridge_line <raw> — one line off the bus.
bridge_line() {
  local line="$1" out kind payload
  case "$line" in '{'*) ;; *) return 0;; esac   # the CLI's own banner, colour codes
  out=$(printf '%s' "$line" | jq -rc "$BRIDGE_FILTER" 2>/dev/null || true)
  [ -z "$out" ] && return 0
  kind=${out%%$'\t'*}
  payload=${out#*$'\t'}
  case "$kind" in
    surface_orphaned)   spool_append "$SURFACE_ORPHANED_SRC" "$payload" ;;
    surface_mismatched) spool_append "$SURFACE_MISMATCHED_SRC" "$payload" ;;
  esac
}

# bridge_tick — run after EVERY read, event or timeout, and paced by wall clock
# (bash's own $SECONDS, so no fork per bus line). Two jobs:
#   * retry the install — a batch spooled behind an undrained file would otherwise
#     wait for the next event, which may never come;
#   * heartbeat, so "connected and silent" and "wedged" do not look alike.
# Measured, not assumed: an earlier version ticked only on the read TIMEOUT, and a
# 90s subscription to the real bus never ticked once — session_activity_observation
# arrives faster than the timeout, so the busiest bus was the one that never
# heartbeated. install_spool is two `[ -s ]` tests, cheap enough for every line.
LAST_BEAT=0
bridge_tick() {
  install_spool "$SURFACE_ORPHANED_SRC"
  install_spool "$SURFACE_MISMATCHED_SRC"
  if [ $(( SECONDS - LAST_BEAT )) -ge "$HEARTBEAT_SECONDS" ]; then
    LAST_BEAT=$SECONDS
    health_update "{\"heartbeat_at\": \"$(now_iso)\"}"
  fi
}

# subscribe — one connected lifetime. Returns when the listener dies; the caller
# owns the reconnect. A FIFO rather than a pipeline so the listener has a pid we
# can end deterministically (a pipeline leaves it orphaned holding a bus socket),
# opened read-write so the open never blocks and liveness is decided by kill -0
# rather than by an EOF this end would also have to wait for.
LISTEN_PID=""
subscribe() {
  local listen_pid rc line
  rm -f "$FIFO"
  mkfifo "$FIFO" 2>/dev/null || { log "BUS_BRIDGE cannot create $FIFO — not subscribing"; return 1; }
  if [ -f "$ERRLOG" ] && [ "$(wc -c < "$ERRLOG" | tr -d ' ')" -gt "$ERRLOG_MAX_BYTES" ]; then
    : > "$ERRLOG"
  fi
  "$TELEPTY" listen > "$FIFO" 2>> "$ERRLOG" &
  listen_pid=$!
  LISTEN_PID="$listen_pid"
  exec 3<> "$FIFO"
  health_update "{\"state\": \"connected\", \"connected_at\": \"$(now_iso)\", \"listen_pid\": $listen_pid, \"note\": \"\"}"
  # Liveness is checked on the TIMEOUT path only, never straight after a read: a
  # listener that emitted three events and then died must have all three drained
  # out of the pipe first. Timeout means the pipe is empty, and only then does the
  # listener being gone mean there is nothing left to lose.
  while :; do
    rc=0
    IFS= read -r -t "$READ_TIMEOUT" line <&3 || rc=$?
    if [ "$rc" -eq 0 ]; then bridge_line "$line"; bridge_tick; continue; fi
    if [ "$rc" -le 128 ]; then break; fi     # not a timeout: the fifo is gone
    kill -0 "$listen_pid" 2>/dev/null || break
    bridge_tick
  done
  exec 3<&-
  kill "$listen_pid" 2>/dev/null || true
  wait "$listen_pid" 2>/dev/null || true
  LISTEN_PID=""
  rm -f "$FIFO"
  return 0
}

# bridge_cleanup — the listener is OUR child and holds a bus socket; a bridge that
# is signalled away without ending it leaves a subscriber nobody supervises, which
# the next --ensure would then double.
bridge_cleanup() {
  [ -n "$LISTEN_PID" ] && kill "$LISTEN_PID" 2>/dev/null
  rm -f "$PIDFILE" "$FIFO"
  return 0
}

run_bridge() {
  mkdir -p "$STATE_DIR"
  acquire_singleton || exit 0
  trap bridge_cleanup EXIT
  trap 'trap - EXIT; bridge_cleanup; exit 0' INT TERM
  local backoff="$BACKOFF_INITIAL" verdict gap down_at="" up_at=""
  LAST_BEAT=$SECONDS
  health_update "{\"pid\": $$, \"started_at\": \"$(now_iso)\", \"state\": \"starting\"}"
  log "BUS_BRIDGE started pid=$$ src=$(basename "$SURFACE_ORPHANED_SRC"),$(basename "$SURFACE_MISMATCHED_SRC")"
  while :; do
    # A vanished state dir means the tree this bridge was writing into is gone
    # (hermetic test teardown, or a wiped state). Exit rather than recreate it.
    [ -d "$STATE_DIR" ] || exit 0
    verdict=$(telepty_listing_verdict)
    if [ "$verdict" != "ok" ]; then
      health_update "{\"state\": \"degraded\", \"note\": \"daemon $verdict\", \"checked_at\": \"$(now_iso)\"}"
      sleep "$backoff"
      backoff=$(( backoff * 2 )); [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff="$BACKOFF_MAX"
      continue
    fi
    if [ -n "$down_at" ]; then
      gap=$(( $(date +%s) - down_at ))
      health_update "{\"last_gap_seconds\": $gap, \"reconnected_at\": \"$(now_iso)\"}" \
                    "{\"gap_seconds_total\": $gap}"
      log "BUS_BRIDGE reconnected after ${gap}s — surface events emitted in that window are LOST and are not replayed; the wh_alive sweep is what covers them"
      down_at=""
    fi
    up_at=$(date +%s)
    subscribe || true
    down_at=$(date +%s)
    health_update "{\"state\": \"disconnected\", \"disconnected_at\": \"$(now_iso)\"}" '{"disconnects": 1}'
    # A listener that did not even stay up for one read window is failing, not
    # flapping — respawning it every BACKOFF_INITIAL would be a tight loop against
    # whatever is refusing (a rotated token, a CLI that cannot run). Back off on
    # that; reset only after a subscription that actually lived.
    if [ $(( down_at - up_at )) -lt "$READ_TIMEOUT" ]; then
      sleep "$backoff"
      backoff=$(( backoff * 2 )); [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff="$BACKOFF_MAX"
    else
      sleep "$BACKOFF_INITIAL"
      backoff="$BACKOFF_INITIAL"
    fi
  done
}

# ensure_bridge — the supervision step, idempotent, cheap, and silent when the
# bridge is already up. Called once per reconcile tick, so a bridge that died is
# back within one tick and the dead window is named in reconciler.log.
ensure_bridge() {
  local other last
  other=$(bridge_pid)
  [ -n "$other" ] && return 0
  mkdir -p "$STATE_DIR"
  last=$(health_field heartbeat_at)
  [ -n "$last" ] || last=$(health_field started_at)
  nohup "$SCRIPT_SELF" --run >> "$ERRLOG" 2>&1 &
  log "BUS_BRIDGE not running — started (last seen alive: ${last:-never}; surface events since then were never bridged)"
  return 0
}

case "${1:---help}" in
  --ensure) ensure_bridge ;;
  --run)    run_bridge ;;
  -h|--help) usage 0 ;;
  *) printf 'unknown argument: %s\n' "$1" >&2; usage 2 ;;
esac
