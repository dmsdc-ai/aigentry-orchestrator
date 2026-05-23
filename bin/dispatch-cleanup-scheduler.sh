#!/usr/bin/env bash
# dispatch-cleanup-scheduler.sh — Layer D timeout fallback (ADR 2026-05-20).
#
# Maintains state/dispatch/cleanup-pending.json — an array of records:
#
#   {
#     "sid": "<session-id>",
#     "report_time": "<iso8601>",
#     "scheduled_cleanup_time": "<iso8601>",
#     "source": "layer-d-timeout" | "reconciler" | "explicit-request",
#     "preempt_reason": "<optional, set when EXTEND_LIFETIME deferred>"
#   }
#
# Atomic writes via tmpfile+mv (avoids partial state on crash — pattern #114).
#
# Commands:
#   dispatch-cleanup-scheduler.sh schedule <sid> [--grace-seconds N] [--source S] [--reason TEXT]
#       Append a pending record. Default grace 60s. Default source layer-d-timeout.
#       Idempotent on sid: replaces existing pending record for the same sid.
#       Skips if active.json entry has keep_alive=true.
#
#   dispatch-cleanup-scheduler.sh cancel <sid>
#       Remove any pending record for sid. Used when EXTEND_LIFETIME arrives.
#
#   dispatch-cleanup-scheduler.sh defer <sid> --minutes N [--reason TEXT]
#       Push scheduled_cleanup_time by N minutes. Creates record if absent.
#
#   dispatch-cleanup-scheduler.sh tick
#       For each pending record past scheduled_cleanup_time, invoke
#       bin/session-cleanup.sh <sid> and drop the record.
#
#   dispatch-cleanup-scheduler.sh list
#       Pretty-print current pending records.
#
# Exit codes: 0 OK, 4 usage.

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
PENDING_JSON="$STATE_DIR/cleanup-pending.json"
ACTIVE_JSON="$STATE_DIR/active.json"
SESSION_CLEANUP_SH="${SESSION_CLEANUP_SH:-$SCRIPT_DIR/session-cleanup.sh}"
NOW_OVERRIDE="${SCHEDULER_NOW:-}"

mkdir -p "$STATE_DIR"
[ -f "$PENDING_JSON" ] || printf '[]\n' > "$PENDING_JSON"

usage() { sed -n '2,38p' "$0"; exit "${1:-0}"; }

now_iso() {
  if [ -n "$NOW_OVERRIDE" ]; then printf '%s' "$NOW_OVERRIDE"; return; fi
  python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"))'
}

# atomic_write_json <path> — read stdin as the new content; write tmp + mv.
atomic_write_json() {
  local path="$1" tmp
  tmp=$(mktemp "${path}.tmp.XXXXXX")
  cat > "$tmp"
  mv "$tmp" "$path"
}

is_keep_alive() {
  local sid="$1"
  [ -f "$ACTIVE_JSON" ] || return 1
  ACTIVE_JSON="$ACTIVE_JSON" SID="$sid" python3 - <<'PY' >/dev/null 2>&1
import json, os, sys
try:
    entries = json.load(open(os.environ["ACTIVE_JSON"]))
except Exception:
    sys.exit(1)
sid = os.environ["SID"]
for e in entries:
    if e.get("sid") == sid and e.get("keep_alive") is True:
        sys.exit(0)
sys.exit(1)
PY
}

cmd_schedule() {
  local sid="" grace=60 source="layer-d-timeout" reason="" report_time
  [ "${1:-}" = "" ] && { echo "schedule: <sid> required" >&2; exit 4; }
  sid="$1"; shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --grace-seconds) grace="$2"; shift 2;;
      --source) source="$2"; shift 2;;
      --reason) reason="$2"; shift 2;;
      *) echo "schedule: unknown $1" >&2; exit 4;;
    esac
  done
  if is_keep_alive "$sid"; then
    echo "[scheduler] keep_alive=true for $sid — skipping Layer D schedule"
    return 0
  fi
  report_time=$(now_iso)
  SID="$sid" REPORT_TIME="$report_time" GRACE="$grace" SRC="$source" REASON="$reason" \
    PENDING_JSON="$PENDING_JSON" python3 - <<'PY' | atomic_write_json "$PENDING_JSON"
import json, os, datetime
path = os.environ["PENDING_JSON"]
try: pending = json.load(open(path))
except Exception: pending = []
sid = os.environ["SID"]
rt  = os.environ["REPORT_TIME"]
g   = int(os.environ["GRACE"])
src = os.environ["SRC"]
reason = os.environ["REASON"]
dt = datetime.datetime.fromisoformat(rt.replace("Z","+00:00"))
sched = (dt + datetime.timedelta(seconds=g)).isoformat(timespec="seconds").replace("+00:00","Z")
pending = [p for p in pending if p.get("sid") != sid]
rec = {"sid": sid, "report_time": rt, "scheduled_cleanup_time": sched, "source": src}
if reason: rec["preempt_reason"] = reason
pending.append(rec)
print(json.dumps(pending, indent=2, ensure_ascii=False))
PY
  echo "[scheduler] scheduled cleanup sid=$sid in ${grace}s (source=$source)"
}

cmd_cancel() {
  local sid="${1:-}"
  [ -z "$sid" ] && { echo "cancel: <sid> required" >&2; exit 4; }
  SID="$sid" PENDING_JSON="$PENDING_JSON" python3 - <<'PY' | atomic_write_json "$PENDING_JSON"
import json, os
try: pending = json.load(open(os.environ["PENDING_JSON"]))
except Exception: pending = []
sid = os.environ["SID"]
pending = [p for p in pending if p.get("sid") != sid]
print(json.dumps(pending, indent=2, ensure_ascii=False))
PY
  echo "[scheduler] cancelled pending cleanup for $sid"
}

cmd_defer() {
  local sid="${1:-}" minutes="" reason=""
  [ -z "$sid" ] && { echo "defer: <sid> required" >&2; exit 4; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --minutes) minutes="$2"; shift 2;;
      --reason) reason="$2"; shift 2;;
      *) echo "defer: unknown $1" >&2; exit 4;;
    esac
  done
  [ -z "$minutes" ] && { echo "defer: --minutes required" >&2; exit 4; }
  local now; now=$(now_iso)
  SID="$sid" MIN="$minutes" REASON="$reason" NOW="$now" PENDING_JSON="$PENDING_JSON" \
    python3 - <<'PY' | atomic_write_json "$PENDING_JSON"
import json, os, datetime
path = os.environ["PENDING_JSON"]
try: pending = json.load(open(path))
except Exception: pending = []
sid = os.environ["SID"]
mins = int(os.environ["MIN"])
now = os.environ["NOW"]
reason = os.environ["REASON"]
existing = next((p for p in pending if p.get("sid") == sid), None)
ndt = datetime.datetime.fromisoformat(now.replace("Z","+00:00"))
new_sched = (ndt + datetime.timedelta(minutes=mins)).isoformat(timespec="seconds").replace("+00:00","Z")
if existing:
    existing["scheduled_cleanup_time"] = new_sched
    existing["source"] = "explicit-request"
    if reason: existing["preempt_reason"] = reason
else:
    rec = {"sid": sid, "report_time": now, "scheduled_cleanup_time": new_sched, "source": "explicit-request"}
    if reason: rec["preempt_reason"] = reason
    pending.append(rec)
print(json.dumps(pending, indent=2, ensure_ascii=False))
PY
  echo "[scheduler] deferred cleanup for $sid by ${minutes}m"
}

cmd_tick() {
  local now; now=$(now_iso)
  local fired=0
  local snap; snap=$(mktemp)
  PENDING_JSON="$PENDING_JSON" NOW="$now" python3 - > "$snap" <<'PY'
import json, os, datetime, sys
try: pending = json.load(open(os.environ["PENDING_JSON"]))
except Exception: pending = []
now = os.environ["NOW"]
ndt = datetime.datetime.fromisoformat(now.replace("Z","+00:00"))
for p in pending:
    sched = p.get("scheduled_cleanup_time","")
    try:
        sdt = datetime.datetime.fromisoformat(sched.replace("Z","+00:00"))
    except Exception:
        continue
    if ndt >= sdt:
        print(p["sid"])
PY
  while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    if [ -x "$SESSION_CLEANUP_SH" ]; then
      "$SESSION_CLEANUP_SH" "$sid" || echo "[scheduler] cleanup non-zero for $sid"
    else
      echo "[scheduler] session-cleanup.sh not executable at $SESSION_CLEANUP_SH" >&2
    fi
    cmd_cancel "$sid" >/dev/null
    fired=$((fired + 1))
  done < "$snap"
  rm -f "$snap"
  echo "[scheduler] tick fired=$fired"
}

cmd_list() {
  python3 -c '
import json,sys
try: pending = json.load(open(sys.argv[1]))
except Exception: pending = []
for p in pending:
    src = p.get("source","?")
    pr  = p.get("preempt_reason","")
    extra = f" reason={pr}" if pr else ""
    print(f"{p.get(\"sid\",\"?\"):40s} scheduled={p.get(\"scheduled_cleanup_time\",\"?\")} src={src}{extra}")
' "$PENDING_JSON"
}

main() {
  [ $# -eq 0 ] && usage 4
  local cmd="$1"; shift
  case "$cmd" in
    schedule)   cmd_schedule "$@";;
    cancel)     cmd_cancel "$@";;
    defer)      cmd_defer "$@";;
    tick)       cmd_tick "$@";;
    list)       cmd_list "$@";;
    -h|--help)  usage 0;;
    *) echo "unknown: $cmd" >&2; usage 4;;
  esac
}

main "$@"
