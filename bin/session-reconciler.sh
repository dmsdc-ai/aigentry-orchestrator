#!/usr/bin/env bash
# session-reconciler.sh — 60s level-triggered safety net (ADR 2026-05-20 Layer R).
#
# Single cron-style tick. Two responsibilities, executed in order:
#
#   1) Layer D fire-due — invoke dispatch-cleanup-scheduler.sh tick. Any sid
#      whose scheduled_cleanup_time has passed gets session-cleanup.sh.
#
#   2) Orphan sweep — compute GC root from state/dispatch/active.json
#      (sessions with an in-flight dispatch) ∪ {orchestrator} (PROTECTED).
#      For every telepty session NOT in the root and not in PROTECTED:
#        - age_since_spawn > 5min (anti-spawn-race floor)
#        - keep_alive flag in active.json: skipped (preserves long-lived workers)
#        - PID_dead OR
#          (telepty.healthStatus == DISCONNECTED AND disconnect_age > 4min) OR
#          workspace_host_orphan (wh_lookup empty AND telepty stale)
#      Matches are cleaned via bin/session-cleanup.sh.
#
# Idempotent: session-cleanup.sh's DELETE→404 is the "already gone" signal.
# Exponential backoff: per-sid retry counter at state/dispatch/reconciler-backoff.json.
# Initial 5s, max 1000s (controller-runtime defaults).
#
# Article 17 (무의존): shell + python3 stdlib + jq + telepty. No npm runtime deps.
# Cross-platform: POSIX bash; works on macOS (launchd-driven) + Linux (systemd-driven).
#
# Usage:
#   session-reconciler.sh           # one tick
#   session-reconciler.sh --dry-run # report what would happen, don't act
#   session-reconciler.sh --once    # alias for default
#   session-reconciler.sh --help

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
ACTIVE_JSON="$STATE_DIR/active.json"
BACKOFF_JSON="$STATE_DIR/reconciler-backoff.json"
RECONCILER_LOG="$STATE_DIR/reconciler.log"
SCHEDULER_SH="${SCHEDULER_SH:-$SCRIPT_DIR/dispatch-cleanup-scheduler.sh}"
CLEANUP_SH="${CLEANUP_SH:-$SCRIPT_DIR/session-cleanup.sh}"
TELEPTY="${TELEPTY:-telepty}"
NOW_OVERRIDE="${RECONCILER_NOW:-}"
PROTECTED_SIDS=(orchestrator)
AGE_FLOOR_SECONDS="${RECONCILER_AGE_FLOOR:-300}"
DISCONNECT_FLOOR_SECONDS="${RECONCILER_DISCONNECT_FLOOR:-240}"
BACKOFF_INITIAL="${RECONCILER_BACKOFF_INITIAL:-5}"
BACKOFF_MAX="${RECONCILER_BACKOFF_MAX:-1000}"
# surface_orphaned event source (verdict 2026-05-30 §5). DORMANT by default:
# telepty emits surface_orphaned on its WS bus (broadcastSessionEvent), not to a
# file, so this JSONL does not exist yet — a future bus→file bridge would
# populate it. Until then the consumer is a no-op and the wh_alive sweep (step 2)
# is the always-on actuation path. Override the source via env.
SURFACE_ORPHANED_SRC="${AIGENTRY_SURFACE_ORPHANED_SOURCE:-$STATE_DIR/surface-orphaned.jsonl}"
# surface_mismatched event source (task #507, verdict 2026-05-30 §4 focus-actuation
# = orchestrator). DORMANT by default, same as surface_orphaned: telepty (probe+
# signal owner) will emit `surface_mismatched` on its WS bus when a session's bound
# surface is ALIVE but foregrounding a PTY ≠ session.ptyPid (stray shell after cmux
# restart/surface reassign — the codex-on-ttysNNN vs workspace-shows-ttysMMM case).
# A future bus→file bridge populates this JSONL; until then the consumer is a no-op.
# Event contract (one JSONL object per line):
#   {sid, backend, cmuxWorkspaceId, expectedPtyPid, observedSurface, mismatchSeconds}
SURFACE_MISMATCHED_SRC="${AIGENTRY_SURFACE_MISMATCHED_SOURCE:-$STATE_DIR/surface-mismatched.jsonl}"

# shellcheck source=lib/workspace-host.sh
. "$SCRIPT_DIR/lib/workspace-host.sh"

mkdir -p "$STATE_DIR"
[ -f "$BACKOFF_JSON" ] || printf '{}\n' > "$BACKOFF_JSON"

usage() { sed -n '2,32p' "$0"; exit "${1:-0}"; }

now_iso() {
  if [ -n "$NOW_OVERRIDE" ]; then printf '%s' "$NOW_OVERRIDE"; return; fi
  python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"))'
}

log() {
  printf '%s %s\n' "$(now_iso)" "$*" | tee -a "$RECONCILER_LOG" >&2
}

# atomic_write_json <path> — read stdin as content; tmp + mv.
atomic_write_json() {
  local path="$1" tmp
  tmp=$(mktemp "${path}.tmp.XXXXXX")
  cat > "$tmp"
  mv "$tmp" "$path"
}

# compute_gc_root — print one sid per line for every "live" session.
compute_gc_root() {
  local p
  for p in "${PROTECTED_SIDS[@]}"; do printf '%s\n' "$p"; done
  if [ -f "$ACTIVE_JSON" ]; then
    python3 -c '
import json,sys
try: entries = json.load(open(sys.argv[1]))
except Exception: entries = []
LIVE = {"in_flight","re_dispatched","auto_reported","disconnected","stuck_welcome"}
for e in entries:
    if e.get("status") in LIVE:
        sid = e.get("sid")
        if sid: print(sid)
' "$ACTIVE_JSON"
  fi
}

# keep_alive_sids — print sids with keep_alive=true (also exempt from sweep).
keep_alive_sids() {
  [ -f "$ACTIVE_JSON" ] || return 0
  python3 -c '
import json,sys
try: entries = json.load(open(sys.argv[1]))
except Exception: entries = []
for e in entries:
    if e.get("keep_alive") is True and e.get("sid"):
        print(e["sid"])
' "$ACTIVE_JSON"
}

# telepty_list_json — fail loudly on bad JSON (#400 lesson).
telepty_list_json() {
  local raw
  raw=$("$TELEPTY" list --json 2>/dev/null) || { log "ERR telepty list non-zero"; return 1; }
  if ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    log "ERR telepty list --json returned non-JSON (binary/daemon version mismatch?)"
    return 1
  fi
  printf '%s' "$raw"
}

# pid_alive <pid> — 0 if process exists.
pid_alive() {
  local pid="${1:-}"
  [ -z "$pid" ] && return 1
  kill -0 "$pid" 2>/dev/null
}

# parent_pid_for_sid <sid> — print the parent telepty-allow PID or "".
parent_pid_for_sid() {
  local sid="$1"
  ps -eo pid,command 2>/dev/null \
    | awk -v s="$sid" '$0 ~ ("telepty allow --id " s " ") {print $1; exit}' || true
}

# seconds_since_iso <iso> — int seconds (current - iso).
seconds_since_iso() {
  local iso="$1" now; now=$(now_iso)
  python3 -c '
import datetime,sys
def parse(s): return datetime.datetime.fromisoformat(s.replace("Z","+00:00"))
try:
    print(int((parse(sys.argv[2]) - parse(sys.argv[1])).total_seconds()))
except Exception:
    print(0)
' "$iso" "$now"
}

# backoff_ready <sid> — 0 if current attempt is allowed; 1 if waiting.
backoff_ready() {
  local sid="$1" now; now=$(now_iso)
  SID="$sid" NOW="$now" BACKOFF_JSON="$BACKOFF_JSON" python3 - <<'PY' >/dev/null 2>&1
import json, os, datetime, sys
try: data = json.load(open(os.environ["BACKOFF_JSON"]))
except Exception: data = {}
sid = os.environ["SID"]
now = datetime.datetime.fromisoformat(os.environ["NOW"].replace("Z","+00:00"))
rec = data.get(sid)
if not rec: sys.exit(0)
nxt = rec.get("next_attempt_iso")
if not nxt: sys.exit(0)
try:
    if now >= datetime.datetime.fromisoformat(nxt.replace("Z","+00:00")):
        sys.exit(0)
except Exception:
    sys.exit(0)
sys.exit(1)
PY
}

backoff_record_failure() {
  local sid="$1" now; now=$(now_iso)
  SID="$sid" NOW="$now" INIT="$BACKOFF_INITIAL" MAX="$BACKOFF_MAX" BACKOFF_JSON="$BACKOFF_JSON" \
    python3 - <<'PY' | atomic_write_json "$BACKOFF_JSON"
import json, os, datetime
path = os.environ["BACKOFF_JSON"]
try: data = json.load(open(path))
except Exception: data = {}
sid = os.environ["SID"]
now = datetime.datetime.fromisoformat(os.environ["NOW"].replace("Z","+00:00"))
init = int(os.environ["INIT"]); mx = int(os.environ["MAX"])
prev = data.get(sid, {"count": 0})
count = int(prev.get("count", 0)) + 1
# exponential: init * 2^(count-1), capped at mx
delay = min(mx, init * (2 ** (count - 1)))
nxt = (now + datetime.timedelta(seconds=delay)).isoformat(timespec="seconds").replace("+00:00","Z")
data[sid] = {"count": count, "delay_seconds": delay, "next_attempt_iso": nxt}
print(json.dumps(data, indent=2, ensure_ascii=False))
PY
}

backoff_reset() {
  local sid="$1"
  SID="$sid" BACKOFF_JSON="$BACKOFF_JSON" python3 - <<'PY' | atomic_write_json "$BACKOFF_JSON"
import json, os
try: data = json.load(open(os.environ["BACKOFF_JSON"]))
except Exception: data = {}
data.pop(os.environ["SID"], None)
print(json.dumps(data, indent=2, ensure_ascii=False))
PY
}

# consume_surface_orphaned — event-driven complement to the wh_alive sweep
# (verdict 2026-05-30 §5). DORMANT until a telepty bus→file bridge populates
# SURFACE_ORPHANED_SRC; absent file → no-op, so actuation never depends on it.
# Each JSONL line: {sid, backend, cmuxWorkspaceId, surfaceGoneSeconds, livenessVerdict}.
# Two INV-17 gates before any close: (1) drop livenessVerdict=='unknown' (telepty
# already filters these probe-side — never close on indeterminate liveness);
# (2) corroborate against gc_root/keep_alive (never close a live/protected sid).
# Requires globals gc_root, keep_alive, DRY_RUN to be set before invocation.
consume_surface_orphaned() {
  [ -f "$SURFACE_ORPHANED_SRC" ] || return 0 # dormant: no bridge yet → no-op
  local processed=0 line sid verdict host_id
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    sid=$(printf '%s' "$line" | jq -r '.sid // empty' 2>/dev/null || true)
    verdict=$(printf '%s' "$line" | jq -r '.livenessVerdict // empty' 2>/dev/null || true)
    [ -z "$sid" ] && continue
    [ "$verdict" = "unknown" ] && continue           # INV-17 gate 1
    case ",$gc_root,"    in *",$sid,"*) continue;; esac # INV-17 gate 2 (live)
    case ",$keep_alive," in *",$sid,"*) continue;; esac # INV-17 gate 2 (keep_alive)
    if [ "$DRY_RUN" -eq 1 ]; then
      log "SURFACE_ORPHANED would-close sid=$sid verdict=${verdict:-?}"
      processed=$((processed + 1)); continue
    fi
    host_id=$(wh_lookup "$sid")
    if [ -n "$host_id" ]; then
      if wh_close "$host_id"; then
        log "SURFACE_ORPHANED closed sid=$sid host=$host_id"
      else
        log "SURFACE_ORPHANED close non-zero sid=$sid host=$host_id"
      fi
    fi
    processed=$((processed + 1))
  done < "$SURFACE_ORPHANED_SRC"
  if [ "$DRY_RUN" -eq 0 ] && [ "$processed" -gt 0 ]; then
    : > "$SURFACE_ORPHANED_SRC" 2>/dev/null || true # drain consumed events
  fi
  [ "$processed" -gt 0 ] && log "surface_orphaned consumed=$processed"
  return 0
}

# consume_surface_mismatched — re-bind a live session's workspace onto its real PTY
# surface when telepty signals the surface is ALIVE-but-mismatched (task #507).
# Verdict 2026-05-30 §4: surface focus/select actuation = orchestrator (conductor's
# call); telepty owns only the read-only probe + the signal. So this consumer
# actuates `wh_focus` (re-bind), the dual of consume_surface_orphaned's `wh_close`.
# DORMANT until a telepty bus→file bridge populates SURFACE_MISMATCHED_SRC; absent
# file → no-op, so actuation never depends on it.
# wh_focus is NON-DESTRUCTIVE (best-effort raise; never throws/blocks, always 0), so
# unlike orphan-close it needs no INV-17 kill-corroboration — re-focusing a stray
# surface cannot lose work. Single safety gate: the sid must resolve to a host_id
# (wh_lookup non-empty) — i.e. a real workspace still exists to re-bind.
# Requires globals DRY_RUN to be set before invocation.
consume_surface_mismatched() {
  [ -f "$SURFACE_MISMATCHED_SRC" ] || return 0 # dormant: no bridge yet → no-op
  local processed=0 line sid host_id exppty
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    sid=$(printf '%s' "$line" | jq -r '.sid // empty' 2>/dev/null || true)
    exppty=$(printf '%s' "$line" | jq -r '.expectedPtyPid // empty' 2>/dev/null || true)
    [ -z "$sid" ] && continue
    if [ "$DRY_RUN" -eq 1 ]; then
      log "SURFACE_MISMATCHED would-refocus sid=$sid expectedPty=${exppty:-?}"
      processed=$((processed + 1)); continue
    fi
    host_id=$(wh_lookup "$sid")
    if [ -n "$host_id" ]; then
      if wh_focus "$host_id"; then
        log "SURFACE_MISMATCHED refocused sid=$sid host=$host_id expectedPty=${exppty:-?}"
      else
        log "SURFACE_MISMATCHED refocus non-zero sid=$sid host=$host_id"
      fi
    fi
    processed=$((processed + 1))
  done < "$SURFACE_MISMATCHED_SRC"
  if [ "$DRY_RUN" -eq 0 ] && [ "$processed" -gt 0 ]; then
    : > "$SURFACE_MISMATCHED_SRC" 2>/dev/null || true # drain consumed events
  fi
  [ "$processed" -gt 0 ] && log "surface_mismatched consumed=$processed"
  return 0
}

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    --once)    shift;;
    -h|--help) usage 0;;
    *) echo "unknown: $1" >&2; usage 4;;
  esac
done

# --- step 1: scheduler tick (Layer D fires due) ---
if [ -x "$SCHEDULER_SH" ] && [ "$DRY_RUN" -eq 0 ]; then
  "$SCHEDULER_SH" tick || log "ERR scheduler tick non-zero"
fi

# --- step 2: orphan sweep ---
listing=$(telepty_list_json) || { log "abort sweep — bad telepty list"; exit 0; }
gc_root=$(compute_gc_root | sort -u | tr '\n' ',' | sed 's/,$//')
keep_alive=$(keep_alive_sids | sort -u | tr '\n' ',' | sed 's/,$//')

# event-driven surface_orphaned consumer (dormant until a bus→file bridge exists)
consume_surface_orphaned
# event-driven surface_mismatched consumer — re-focus stray surfaces (#507, dormant)
consume_surface_mismatched

candidates=$(printf '%s' "$listing" | LISTING_GC="$gc_root" LISTING_KA="$keep_alive" python3 -c '
import json,os,sys
listing = json.load(sys.stdin)
root = set(filter(None, os.environ.get("LISTING_GC","").split(",")))
ka   = set(filter(None, os.environ.get("LISTING_KA","").split(",")))
for s in listing:
    sid = s.get("id")
    if not sid: continue
    if sid in root or sid in ka: continue
    started = s.get("startedAt") or s.get("started_at") or s.get("started") or ""
    health  = s.get("healthStatus") or s.get("status") or ""
    last_seen = s.get("lastSeenAt") or s.get("last_seen") or s.get("disconnectedAt") or ""
    print(f"{sid}\t{started}\t{health}\t{last_seen}")
')

swept=0
while IFS=$'\t' read -r sid started health last_seen; do
  [ -z "$sid" ] && continue
  if ! backoff_ready "$sid"; then
    continue
  fi
  age=$(seconds_since_iso "$started")
  if [ "$age" -lt "$AGE_FLOOR_SECONDS" ]; then
    continue
  fi
  reasons=""
  ppid=$(parent_pid_for_sid "$sid")
  if [ -n "$ppid" ] && ! pid_alive "$ppid"; then reasons="pid_dead"; fi
  if [ -z "$ppid" ]; then reasons="${reasons:+$reasons,}no_parent_pid"; fi
  if [ "$health" = "DISCONNECTED" ]; then
    disc_age=$(seconds_since_iso "$last_seen")
    if [ "$disc_age" -ge "$DISCONNECT_FLOOR_SECONDS" ]; then
      reasons="${reasons:+$reasons,}disconnected_${disc_age}s"
    fi
  fi
  # surface_gone (workspace-host probe): the always-on consume of the surface-
  # orphan signal (verdict 2026-05-30 §5). Look up this sid's host_id and probe
  # the adapter via wh_alive. A "gone" surface is a CORROBORATING signal only —
  # see the INV-17 guard below.
  sid_json=$(printf '%s' "$listing" | jq -c --arg s "$sid" '.[] | select(.id == $s)' 2>/dev/null | head -1 || true)
  surface_host_id=$(wh_lookup "$sid" "$sid_json")
  if [ -n "$surface_host_id" ] && ! wh_alive "$surface_host_id"; then
    reasons="${reasons:+$reasons,}surface_gone"
  fi
  if [ -z "$reasons" ]; then continue; fi
  # INV-17 (#486 non-regression): surface_gone ALONE is NEVER sufficient. A
  # cmux/warp app quit or restart vanishes ALL surfaces at once → every sid
  # would probe "gone" → mass-kill. Require corroboration by a PID/disconnect
  # signal; skip when surface_gone is the only reason (no single-signal close).
  if [ "$reasons" = "surface_gone" ]; then
    log "INV-17 skip sid=$sid — surface_gone single-signal (no pid/disconnect corroboration)"
    continue
  fi
  log "SWEEP candidate sid=$sid age=${age}s health=$health reasons=$reasons"
  if [ "$DRY_RUN" -eq 1 ]; then continue; fi
  if "$CLEANUP_SH" "$sid" >/dev/null 2>&1; then
    log "SWEEP ok sid=$sid"
    backoff_reset "$sid"
  else
    log "SWEEP fail sid=$sid — backoff"
    backoff_record_failure "$sid"
  fi
  swept=$((swept + 1))
done <<< "$candidates"

log "tick: gc_root=[$gc_root] keep_alive=[$keep_alive] swept=$swept dry_run=$DRY_RUN"
