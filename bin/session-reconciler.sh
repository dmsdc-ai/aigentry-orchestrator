#!/usr/bin/env bash
# session-reconciler.sh — 60s level-triggered safety net (ADR 2026-05-20 Layer R).
#
# Single cron-style tick. Two responsibilities, executed in order:
#
#   1) Layer D fire-due — invoke dispatch-cleanup-scheduler.sh tick. Any sid
#      whose scheduled_cleanup_time has passed gets session-cleanup.sh.
#
#   2) Orphan sweep — compute GC root from the dispatch registry
#      (sessions with an in-flight dispatch) ∪ {orchestrator} (PROTECTED).
#      For every telepty session NOT in the root and not in PROTECTED:
#        - age_since_spawn > 5min (anti-spawn-race floor)
#        - keep_alive flag on the dispatch record: skipped (preserves long-lived workers)
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
#   session-reconciler.sh --shadow  # observe+decide only; append shadow JSONL
#   session-reconciler.sh --once    # alias for default
#   session-reconciler.sh --loop    # long-lived daemon: re-exec `--once` every
#                                    #   RECONCILER_LOOP_INTERVAL (default 60s).
#                                    #   For launchd KeepAlive (survives sleep,
#                                    #   unlike StartInterval which does not re-arm
#                                    #   after battery/clamshell maintenance-sleep).
#   session-reconciler.sh --help

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# launchd does NOT propagate HOME to this daemon (verified: `launchctl print
# gui/<uid>/com.aigentry.reconciler` env has PATH but no HOME). With HOME empty,
# the cmux-prune ownership gate (workspace-host.sh: sandbox=$HOME/.aigentry/
# role-sandbox) resolves to "/.aigentry/role-sandbox" and matches NO real
# workspace cwd → wh_prune_orphans records 0 candidates → orphans never prune
# (regression in 2c12619). Recover HOME from the passwd db — bash `~` expansion
# works even when HOME is unset (getpwuid fallback), so this stays pure-shell (§17).
: "${HOME:=$(cd ~ 2>/dev/null && pwd -P)}"
export HOME

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
DISPATCH_REGISTRY_PY="${DISPATCH_REGISTRY_PY:-$SCRIPT_DIR/dispatch-registry.py}"
BACKOFF_JSON="$STATE_DIR/reconciler-backoff.json"
RECONCILER_LOG="$STATE_DIR/reconciler.log"
# cmux orphan-prune seen-twice ledger (SPEC §2.2). Exported so the workspace-host
# adapter persists it under dispatch state rather than the /tmp default.
export AIGENTRY_CMUX_ORPHAN_LEDGER="${AIGENTRY_CMUX_ORPHAN_LEDGER:-$STATE_DIR/cmux-orphan-ledger.json}"
SCHEDULER_SH="${SCHEDULER_SH:-$SCRIPT_DIR/dispatch-cleanup-scheduler.sh}"
CLEANUP_SH="${CLEANUP_SH:-$SCRIPT_DIR/session-cleanup.sh}"
DISPATCH_SH="${DISPATCH_SH:-$SCRIPT_DIR/dispatch.sh}"
TRACKER_SH="${TRACKER_SH:-$SCRIPT_DIR/dispatch-tracker.sh}"
COMMS_AUDITOR_SH="${COMMS_AUDITOR_SH:-$SCRIPT_DIR/session-comms-auditor.sh}"
BRIDGE_AUDITOR_SH="${BRIDGE_AUDITOR_SH:-$SCRIPT_DIR/orchestrator-bridge-auditor.sh}"
BUS_BRIDGE_SH="${BUS_BRIDGE_SH:-$SCRIPT_DIR/telepty-bus-bridge.sh}"
SESSION_PROBE_PY="${SESSION_PROBE_PY:-$SCRIPT_DIR/session-probe.py}"
POLICY_PY="${POLICY_PY:-$SCRIPT_DIR/policy.py}"
HITL_SH="${HITL_SH:-$SCRIPT_DIR/hitl.sh}"
HITL_PENDING_DIR="${HITL_STATE_DIR:-$REPO_DIR/state/hitl}/pending"
TELEPTY="${TELEPTY:-telepty}"
NOW_OVERRIDE="${RECONCILER_NOW:-}"
SHADOW_LOG="${RECONCILE_SHADOW_LOG:-$STATE_DIR/reconcile-shadow.jsonl}"
ESCALATION_LOG="$STATE_DIR/verify-escalations.jsonl"
ALERTS_LOG="$STATE_DIR/alerts.log"
PROTECTED_SIDS=(orchestrator)
AGE_FLOOR_SECONDS="${RECONCILER_AGE_FLOOR:-300}"
DISCONNECT_FLOOR_SECONDS="${RECONCILER_DISCONNECT_FLOOR:-240}"
BACKOFF_INITIAL="${RECONCILER_BACKOFF_INITIAL:-5}"
BACKOFF_MAX="${RECONCILER_BACKOFF_MAX:-1000}"
# surface_orphaned event source (verdict 2026-05-30 §5). telepty emits
# surface_orphaned on its WS bus (broadcastSessionEvent), not to a file;
# bin/telepty-bus-bridge.sh (#847, step 0e) subscribes and writes this JSONL, so
# the consumer below is live whenever that bridge is. Bridge down ⇒ absent file ⇒
# the consumer no-ops exactly as it did while dormant, and the wh_alive sweep
# (step 2) remains the always-on actuation path. Override the source via env.
SURFACE_ORPHANED_SRC="${AIGENTRY_SURFACE_ORPHANED_SOURCE:-$STATE_DIR/surface-orphaned.jsonl}"
# surface_mismatched event source (task #507, verdict 2026-05-30 §4 focus-actuation
# = orchestrator). Same shape as surface_orphaned: telepty (probe+
# signal owner) emits `surface_mismatched` on its WS bus when a session's bound
# surface is ALIVE but foregrounding a PTY ≠ session.ptyPid (stray shell after cmux
# restart/surface reassign — the codex-on-ttysNNN vs workspace-shows-ttysMMM case).
# bin/telepty-bus-bridge.sh (#847) populates this JSONL from the bus; with the
# bridge down the file is absent and the consumer no-ops, as it did while dormant.
# Event contract (one JSONL object per line):
#   {sid, backend, cmuxWorkspaceId, expectedPtyPid, observedSurface, mismatchSeconds}
SURFACE_MISMATCHED_SRC="${AIGENTRY_SURFACE_MISMATCHED_SOURCE:-$STATE_DIR/surface-mismatched.jsonl}"

# shellcheck source=lib/workspace-host.sh
. "$SCRIPT_DIR/lib/workspace-host.sh"
# #835 — an empty `telepty list --json` is also what a REFUSED list request looks
# like, and this tick treats absent sids as authorization to prune their workspaces
# and to open gates about them.
# shellcheck source=lib/telepty-listing.sh
. "$SCRIPT_DIR/lib/telepty-listing.sh"

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

append_shadow_record() {
  local sid="$1" status="$2" state_json="$3" action_json="$4" now
  now=$(now_iso)
  SHADOW_LOG="$SHADOW_LOG" NOW="$now" SID="$sid" STATUS="$status" \
    STATE_JSON="$state_json" ACTION_JSON="$action_json" python3 - <<'PY'
import json, os

path = os.environ["SHADOW_LOG"]
try:
    state = json.loads(os.environ.get("STATE_JSON", "") or "{}")
except Exception:
    state = {"alive": False, "ready": False, "surface": "unknown", "activity": "static", "cli": "unknown", "detail": {"probe_error": "shadow state JSON parse failed"}}
try:
    action = json.loads(os.environ.get("ACTION_JSON", "") or "{}")
except Exception:
    action = {"action": "ESCALATE", "reason": "shadow action JSON parse failed", "status": os.environ.get("STATUS", "")}
record = {
    "ts": os.environ["NOW"],
    "sid": os.environ["SID"],
    "status": os.environ.get("STATUS", ""),
    "state": state,
    "action": action,
}
with open(path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
PY
}

json_get() {
  local json_text="$1" expr="$2"
  JSON_TEXT="$json_text" EXPR="$expr" python3 - <<'PY'
import json, os

try:
    data = json.loads(os.environ.get("JSON_TEXT", "") or "{}")
except Exception:
    data = {}
cur = data
for part in os.environ.get("EXPR", "").split("."):
    if not part:
        continue
    if isinstance(cur, dict):
        cur = cur.get(part, "")
    else:
        cur = ""
        break
print(cur if cur is not None else "")
PY
}

# telepty#60 Stage A: the reconciler no longer opens the registry file. Every
# access is a typed call to the one transactional component, and none of the
# operations it may call can move the outcome axis.
registry() { "$DISPATCH_REGISTRY_PY" "$@"; }

registry_set_lifecycle() {
  local sid="$1" state="$2"
  [ -n "$state" ] || return 0
  registry set-lifecycle --sid "$sid" --state "$state" --now "$(now_iso)" >/dev/null
}

emit_alert() {
  local line="$1"
  printf '%s %s\n' "$(now_iso)" "$line" | tee -a "$ALERTS_LOG" >&2
}

emit_escalation() {
  local sid="$1" action_json="$2"
  TS="$(now_iso)" SID="$sid" ACTION_JSON="$action_json" python3 - <<'PY' >> "$ESCALATION_LOG"
import json, os

try:
    action = json.loads(os.environ.get("ACTION_JSON", "") or "{}")
except Exception:
    action = {"action": "ESCALATE", "reason": "action JSON parse failed"}
print(json.dumps({
    "sid": os.environ["SID"],
    "ts": os.environ["TS"],
    "rc": 6,
    "detail": action.get("reason", "reconciler escalation"),
}, ensure_ascii=False))
PY
}

policy_decide() {
  local status="$1" state_json="$2"
  printf '%s\n' "$state_json" | "$POLICY_PY" --status "$status" --state - 2>/dev/null || \
    printf '%s\n' '{"action":"ESCALATE","reason":"policy failed","status":"'"$status"'"}'
}

probe_session() {
  local sid="$1" state
  state=$(TELEPTY="$TELEPTY" "$SESSION_PROBE_PY" --sid "$sid" 2>/dev/null || true)
  if [ -z "$state" ]; then
    printf '%s\n' '{"alive":false,"ready":false,"surface":"unknown","activity":"static","cli":"unknown","detail":{"probe_error":"session-probe failed"}}'
  else
    printf '%s\n' "$state"
  fi
}

# hitl_open <hitl.sh open args…> — open a gate, alerting (never aborting the
# tick) if the CLI is missing or fails. The gate's own file-before-notify design
# is what makes this safe to call from a level-triggered loop.
#
# #836 — every gate this loop opens names a subject session and offers the operator
# an action ON that session ("re-dispatch once more", "resume the session as-is").
# The subjects come from the DISPATCH registry, which outlives the session: a record
# whose session was cleaned up still reaches here, and the gate then asks a question
# nobody can answer. Two such gates fired this month, each costing an operator a
# verification round. So the subject is verified against the live session registry
# first, and an absent one is recorded as stale rather than escalated.
#
# UNKNOWN liveness is NOT absence (#835): when the listing was refused or the daemon
# did not answer, telepty_sid_live returns 2 and the gate OPENS. Suppressing an
# escalation on an untrustworthy absence would be the same defect one layer up — and
# unlike a surface close, a spurious gate destroys nothing.
hitl_open() {
  local arg subject="" want_subject=0 live=0
  for arg in "$@"; do
    if [ "$want_subject" -eq 1 ]; then subject="$arg"; want_subject=0; continue; fi
    [ "$arg" = "--subject-sid" ] && want_subject=1
  done
  if [ -n "$subject" ]; then
    telepty_sid_live "$subject" || live=$?
    if [ "$live" -eq 1 ]; then
      emit_alert "HITL_GATE_STALE subject-sid=$subject is not in the live session registry — gate NOT opened (it would ask the operator to act on a session that no longer exists); args: $*"
      return 0
    fi
  fi
  if [ ! -x "$HITL_SH" ]; then
    emit_alert "HITL_GATE_UNAVAILABLE $HITL_SH not executable — args: $*"
    return 0
  fi
  "$HITL_SH" open "$@" >/dev/null 2>&1 || emit_alert "HITL_GATE_OPEN_FAILED args: $*"
}

maybe_redispatch() {
  local sid="$1" ref_path="$2" rdc="${3:-0}"
  [ -z "$rdc" ] && rdc=0
  if [ "$rdc" -ge 1 ]; then
    # ADR 2026-07-26-hitl-gate-primitive producer (a): this line said "user gate
    # required" since 2026-06 — now the gate exists. Idempotent on gate-id, so a
    # 60s level-triggered tick opens it once and never re-notifies.
    # approve ⇒ re_dispatch_count=0 (next tick re-dispatches); reject ⇒ stuck_error.
    hitl_open --source reconciler --subject-sid "$sid" --kind decision \
      --resume registry-clear-redispatch \
      --question "re-dispatch cap reached (count=$rdc) for $sid" \
      --options "approve=re-dispatch once more,reject=mark stuck_error" \
      --context-ref "$ref_path"
    return 0
  fi
  if [ -z "$ref_path" ] || [ ! -f "$ref_path" ]; then
    emit_alert "REDISPATCH_FAILED sid=$sid ref_missing=$ref_path"
    return 0
  fi
  # Rule 34 task-gate (#736): same as the tracker's path — a re-dispatch replays
  # an already-registered task, so it takes the audited exemption.
  #
  # Only exit 0 means a new transport write happened. 8 (deduplicated) and 7
  # (delivery unknown) are "no new delivery", and advancing the counter on either
  # records an attempt that never occurred. The alert reports the outcome of the
  # call rather than the intention to make it.
  local rc=0
  "$DISPATCH_SH" --target "$sid" --ref "$ref_path" --verify-delivered \
    --no-task "reconciler-redispatch $sid" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0)
      registry set-lifecycle --sid "$sid" --state re_dispatched \
        --bump-re-dispatch-count --extend-minutes 30 --now "$(now_iso)" >/dev/null
      emit_alert "REDISPATCH_OK sid=$sid attempt=$((rdc + 1)) ref=$ref_path"
      ;;
    8)
      registry observe --sid "$sid" --kind redispatch_suppressed_duplicate \
        --field "ref_path=$ref_path" --now "$(now_iso)" >/dev/null
      emit_alert "REDISPATCH_SUPPRESSED sid=$sid — identical ref already delivered; no new delivery"
      # Without this the suppression would only ever repeat a HOLD: the counter
      # never reaches the cap, so the one-shot operator gate below is unreachable.
      hitl_open --source reconciler --subject-sid "$sid" --kind decision \
        --resume registry-clear-redispatch \
        --question "duplicate suppressed: $sid is already holding an identical delivered ref" \
        --options "approve=re-dispatch once more,reject=hand back to the operator" \
        --context-ref "$ref_path"
      ;;
    7)
      registry observe --sid "$sid" --kind redispatch_held_delivery_unknown \
        --field "ref_path=$ref_path" --now "$(now_iso)" >/dev/null
      emit_alert "REDISPATCH_HELD sid=$sid — a prior attempt's delivery is unknown; not replayed"
      ;;
    *)
      emit_alert "REDISPATCH_FAILED sid=$sid rc=$rc"
      ;;
  esac
}

apply_action() {
  local sid="$1" status="$2" ref_path="$3" rdc="$4" action_json="$5"
  local act key next_status
  act=$(json_get "$action_json" action)
  key=$(json_get "$action_json" key)
  next_status=$(json_get "$action_json" status)
  case "$act" in
    NOOP)
      # Proper if-guard: the prior `[ ] && [ ] && cmd` chain returned 1 whenever
      # next_status == status (a no-op is the common case), which under the
      # caller's `set -euo pipefail` aborted the whole tick. An if-statement makes
      # "nothing to do" exit 0. (Pre-existing bug, distinct from cmux-adaptor scope.)
      if [ -n "$next_status" ] && [ "$next_status" != "$status" ]; then
        registry_set_lifecycle "$sid" "$next_status"
      fi
      ;;
    RESUBMIT_ENTER|SEND_KEY)
      [ -n "$key" ] || key=enter
      "$TELEPTY" send-key "$sid" "$key" >/dev/null 2>&1 || emit_alert "SEND_KEY_FAILED sid=$sid key=$key"
      ;;
    REDISPATCH)
      maybe_redispatch "$sid" "$ref_path" "$rdc"
      ;;
    AWAIT_USER)
      # ADR 2026-07-26-hitl-gate-primitive producer (b): policy.py returns this for
      # surface=error only — the 3.3% of escalations whose own text asks for an
      # operator. The gate owns the status (awaiting_user, prev stashed for resume),
      # so no lifecycle write here; the escalation line is still written so
      # the audit trail is unchanged.
      hitl_open --source reconciler --subject-sid "$sid" --kind decision --resume none \
        --question "$sid: $(json_get "$action_json" reason)" \
        --options "approve=resume the session as-is,reject=hand back to the operator" \
        --context-ref "$ref_path"
      emit_escalation "$sid" "$action_json"
      ;;
    RESPAWN)
      registry_set_lifecycle "$sid" "${next_status:-respawn_requested}"
      emit_alert "RESPAWN_REQUESTED sid=$sid — spawn metadata unavailable; escalated"
      emit_escalation "$sid" "$action_json"
      ;;
    CLEANUP)
      if "$CLEANUP_SH" "$sid" >/dev/null 2>&1; then
        log "CLEANUP ok sid=$sid"
        backoff_reset "$sid"
      else
        log "CLEANUP fail sid=$sid — backoff"
        backoff_record_failure "$sid"
      fi
      ;;
    ESCALATE|*)
      [ -n "$next_status" ] && [ "$next_status" != "$status" ] && registry_set_lifecycle "$sid" "$next_status"
      emit_escalation "$sid" "$action_json"
      ;;
  esac
}

run_registry_loop() {
  local act="$1" snap processed sid status ref_path rdc state_json action_json
  snap=$(mktemp)
  # Open dispatches that are not waiting on a human. A corrupt/unavailable
  # registry fails the call, and errexit stops the tick before any actuation.
  registry list --live --fields assigned.sid,lifecycle.state,ref_path,re_dispatch_count > "$snap"
  processed=0
  while IFS=$'\t' read -r sid status ref_path rdc; do
    [ -z "$sid" ] && continue
    [ "$ref_path" = "null" ] && ref_path=""
    [ "$rdc" = "null" ] && rdc=0
    state_json=$(probe_session "$sid")
    action_json=$(policy_decide "$status" "$state_json")
    append_shadow_record "$sid" "$status" "$state_json" "$action_json"
    if [ "$act" = "1" ] && [ "$DRY_RUN" -eq 0 ]; then
      apply_action "$sid" "$status" "$ref_path" "$rdc" "$action_json"
    fi
    processed=$((processed + 1))
  done < "$snap"
  rm -f "$snap"
  log "registry tick: processed=$processed act=$act dry_run=$DRY_RUN"
}

run_shadow_loop() {
  run_registry_loop 0
}

# compute_gc_root — print one sid per line for every "live" session.
# `awaiting_user` is LIVE (ADR 2026-07-26-hitl-gate-primitive M1): a session
# blocked on a HITL gate drops out of the registry loop and the tracker scans by
# design, but it must NEVER be swept while it waits for the human.
compute_gc_root() {
  local p
  for p in "${PROTECTED_SIDS[@]}"; do printf '%s\n' "$p"; done
  # Everything the registry has not retired, INCLUDING gated dispatches: a
  # session waiting on a human must never be swept out from under them.
  registry list --not-retired --fields assigned.sid 2>/dev/null || true
}

# keep_alive_sids — print sids with keep_alive=true (also exempt from sweep).
keep_alive_sids() {
  registry list --keep-alive --fields assigned.sid 2>/dev/null || true
}

# telepty_list_json — fail loudly on bad JSON (#400 lesson) and on an EMPTY list
# the daemon will not corroborate (#835 lesson). The whole sweep hangs off this
# listing, and step 2b prunes every role-sandbox workspace whose title is not in
# it — so under a refusal an empty listing closes every live worker's surface on
# the second tick (the ledger debounce buys exactly 60 seconds). "Refused" and
# "unreachable" are not "there are no sessions"; abort the tick instead.
telepty_list_json() {
  local raw verdict
  raw=$("$TELEPTY" list --json 2>/dev/null) || { log "ERR telepty list non-zero"; return 1; }
  if ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    log "ERR telepty list --json returned non-JSON (binary/daemon version mismatch?)"
    return 1
  fi
  if ! verdict=$(telepty_listing_trusted "$raw"); then
    log "ERR telepty list --json returned [] but the daemon answered '$verdict' — a refusal is not an absence; refusing to sweep or prune on it"
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
# (verdict 2026-05-30 §5). Fed by bin/telepty-bus-bridge.sh (#847); absent file →
# no-op, so actuation never depends on the bridge being up.
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
  # Drain by REMOVING, and unconditionally (#847). Two reasons, both about the
  # bridge that now writes this file:
  #  * rm, not `: >`: the bridge publishes a batch by renaming its spool into this
  #    path and only ever does so while the path is ABSENT. Truncating leaves the
  #    path present forever, which would wedge every later batch in the spool; and
  #    the truncate races the bridge's append into silent loss, which the
  #    rename+rm handoff has no window for (bin/telepty-bus-bridge.sh header).
  #  * unconditionally, not `processed > 0`: a line the INV-17 gates rejected is
  #    rejected FOREVER — livenessVerdict=='unknown' is never actionable, and a
  #    sid that is live or keep_alive must not be closed now or later on evidence
  #    this stale. Keeping those lines re-evaluated a dead judgement every tick
  #    and, with a bridge appending, grew this file without bound.
  if [ "$DRY_RUN" -eq 0 ]; then
    rm -f "$SURFACE_ORPHANED_SRC" 2>/dev/null || true
  fi
  [ "$processed" -gt 0 ] && log "surface_orphaned consumed=$processed"
  return 0
}

# consume_surface_mismatched — re-bind a live session's workspace onto its real PTY
# surface when telepty signals the surface is ALIVE-but-mismatched (task #507).
# Verdict 2026-05-30 §4: surface focus/select actuation = orchestrator (conductor's
# call); telepty owns only the read-only probe + the signal. So this consumer
# actuates `wh_focus` (re-bind), the dual of consume_surface_orphaned's `wh_close`.
# Fed by bin/telepty-bus-bridge.sh (#847); absent SURFACE_MISMATCHED_SRC → no-op,
# so actuation never depends on the bridge being up.
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
  # rm, and unconditional — same handoff with bin/telepty-bus-bridge.sh as
  # consume_surface_orphaned's drain; the reasoning is written out there.
  if [ "$DRY_RUN" -eq 0 ]; then
    rm -f "$SURFACE_MISMATCHED_SRC" 2>/dev/null || true
  fi
  [ "$processed" -gt 0 ] && log "surface_mismatched consumed=$processed"
  return 0
}

# hitl_pause_gates — print "PAUSE<TAB><gate-id>" for every pending gate that
# pauses autonomous actions (ADR 2026-07-26-hitl-gate-primitive §3), and
# "CORRUPT<TAB><path>" for every unparseable one. A corrupt gate is treated as
# destructive: fail-safe, the same "never act when ambiguous" bias the loop's
# ESCALATE default already has. Level-triggered — recomputed from the directory
# each tick, so a daemon restart mid-gate needs no recovery logic.
hitl_pause_gates() {
  [ -d "$HITL_PENDING_DIR" ] || return 0
  PENDING_DIR="$HITL_PENDING_DIR" python3 - <<'PY'
import glob, json, os

for path in sorted(glob.glob(os.path.join(os.environ["PENDING_DIR"], "*.json"))):
    try:
        gate = json.load(open(path, encoding="utf-8"))
    except Exception:
        print("CORRUPT\t%s" % path)
        continue
    if gate.get("kind") == "destructive":
        print("PAUSE\t%s" % (gate.get("id") or os.path.basename(path)))
PY
}

DRY_RUN=0
SHADOW=0
LOOP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    --shadow)  SHADOW=1; shift;;
    --loop)    LOOP=1; shift;;
    --once)    shift;;
    -h|--help) usage 0;;
    *) echo "unknown: $1" >&2; usage 4;;
  esac
done

# --loop: long-lived KeepAlive daemon. Re-exec a fresh `--once` tick every
# interval (fresh process per tick → no in-process state leak). A crashing tick
# never kills the loop (|| log); if the loop process itself dies, launchd
# KeepAlive relaunches it. This is what makes the reconciler survive system sleep.
if [ "$LOOP" -eq 1 ]; then
  log "loop mode start interval=${RECONCILER_LOOP_INTERVAL:-60}s pid=$$"
  while :; do
    "$0" --once || log "ERR loop tick non-zero (continuing)"
    sleep "${RECONCILER_LOOP_INTERVAL:-60}"
  done
fi

if [ "$SHADOW" -eq 1 ]; then
  run_shadow_loop
  exit 0
fi

# --- step 0a: HITL gates (ADR 2026-07-26-hitl-gate-primitive M3) ---
# Reminder FIRST, pause second: a destructive gate pauses actions, but the 24h
# reminder is the mitigation for a forgotten gate — it must survive its own
# pause. An operator's explicit --dry-run still sends nothing.
if [ "$DRY_RUN" -eq 0 ] && [ -x "$HITL_SH" ]; then
  "$HITL_SH" remind >/dev/null 2>&1 || log "ERR hitl remind non-zero (continuing)"
fi
# Global pause = the existing --dry-run path: probe → policy → shadow record all
# still run, every actuation is skipped. No new blocking mechanism.
hitl_gates=$(hitl_pause_gates || true)
while IFS=$'\t' read -r kind which; do
  [ -z "$kind" ] && continue
  case "$kind" in
    CORRUPT) log "HITL_GATE_CORRUPT $which — unparseable gate, treating as destructive (fail-safe)";;
    *)       log "HITL_PAUSE gate=$which — autonomous actions paused (destructive gate pending)";;
  esac
  DRY_RUN=1
done <<< "$hitl_gates"

# --- step 0: Dispatch Registry observe→decide→act loop ---
run_registry_loop 1

# --- step 0b: tracker scan (#517) — the tracker polls every dispatch whose
# expected_report_by elapsed and records what it measured. telepty#60 Stage A: it
# emits HOLDs and evidence snapshots, never a completion.
# Best-effort: a non-zero scan never blocks the sweep. Skipped under --dry-run
# because `check` mutates state (auto-reports.seen / status) and injects to the
# orchestrator — emission is act-only. Idempotency lives in the tracker.
if [ -x "$TRACKER_SH" ] && [ "$DRY_RUN" -eq 0 ]; then
  "$TRACKER_SH" check >/dev/null 2>&1 || log "ERR tracker check non-zero (continuing)"
fi

# --- step 0c: PEER-LANE comms auditor (#533 Phase 1) — tail telepty's peer-inject
# log, classify each non-orch↔non-orch inject (sanctioned envelope vs out-of-policy),
# reconcile round counters, and escalate violations via an orchestrator HOLD
# (warn-mode; never hard-blocks in-band — daemon hard-block is Phase 2 / telepty#18).
# Best-effort: a non-zero pass never blocks the tick. Act-only (skipped under
# --dry-run) — it injects HOLDs + mutates the round-counter state. ---
if [ -x "$COMMS_AUDITOR_SH" ] && [ "$DRY_RUN" -eq 0 ]; then
  TELEPTY="$TELEPTY" "$COMMS_AUDITOR_SH" >/dev/null 2>&1 || log "ERR comms-auditor non-zero (continuing)"
fi

# --- step 0d: orchestrator-bridge singleton belt (#620, #618 recurrence) — detect
# a stale DUPLICATE `telepty allow --id orchestrator ` bridge (raw restart that
# bypassed orchestrator-boot.sh) and push a HOLD inject naming the pids + the
# `kill -9` remedy. WARN-ONLY: never kills (orchestrator bridge cleanup is
# USER-ONLY, #606). Best-effort: a non-zero pass never blocks the tick. Act-only
# (skipped under --dry-run) — the HOLD inject is the action. ---
if [ -x "$BRIDGE_AUDITOR_SH" ] && [ "$DRY_RUN" -eq 0 ]; then
  TELEPTY="$TELEPTY" "$BRIDGE_AUDITOR_SH" >/dev/null 2>&1 || log "ERR bridge-auditor non-zero (continuing)"
fi

# --- step 0e: telepty bus→file bridge supervision (#847) — the two surface-event
# consumers below read files only bin/telepty-bus-bridge.sh writes, so something
# has to keep that bridge alive. This tick is that something: it already runs every
# 60s under launchd KeepAlive, already survives sleep and session restarts, and
# already owns this state dir — a second launchd plist would duplicate all of it,
# and a child of this tick would die with the tick. `--ensure` is a pidfile check
# and nothing else when the bridge is up; when it is not, the bridge is back within
# one tick and reconciler.log names the window nothing was bridged.
# Act-only (skipped under --dry-run): the spawn is the action. Best-effort: a
# non-zero ensure never blocks the tick — the consumers no-op on an absent file, so
# a bridge that will not start degrades to exactly the pre-#847 behaviour.
# AIGENTRY_BUS_BRIDGE=0 is the kill switch; tests/dispatch/lib.sh sets it, because
# a hermetic tick must not leave a long-lived process behind. ---
if [ "${AIGENTRY_BUS_BRIDGE:-1}" != "0" ] && [ -x "$BUS_BRIDGE_SH" ] && [ "$DRY_RUN" -eq 0 ]; then
  TELEPTY="$TELEPTY" "$BUS_BRIDGE_SH" --ensure >/dev/null 2>&1 || log "ERR bus-bridge ensure non-zero (continuing)"
fi

# --- step 1: scheduler tick (Layer D fires due) ---
if [ -x "$SCHEDULER_SH" ] && [ "$DRY_RUN" -eq 0 ]; then
  "$SCHEDULER_SH" tick || log "ERR scheduler tick non-zero"
fi

# --- step 2: orphan sweep ---
listing=$(telepty_list_json) || { log "abort sweep — bad telepty list"; exit 0; }
gc_root=$(compute_gc_root | sort -u | tr '\n' ',' | sed 's/,$//')
keep_alive=$(keep_alive_sids | sort -u | tr '\n' ',' | sed 's/,$//')

# --- step 2a: is the ORCHESTRATOR ITSELF down? (#905) ---
#
# On 2026-08-16 the orchestrator's session sat OWNER_DISCONNECTED_STALE for 3h20m while
# this tick ran every 60 seconds beside it and said nothing. The reason is one line
# below in the sweep: the orchestrator sid is in PROTECTED_SIDS, so it is in gc_root, and
# the candidate loop skips gc_root before it examines anything. Being exempt from being
# SWEPT had quietly also meant being exempt from being LOOKED AT. This is the difference
# between those two, and it is deliberately the ONLY thing that changes about gc_root —
# the sid stays unsweepable.
#
# Placed here rather than beside the other 0d-style belts because it needs the very
# listing that step 2 has just fetched and had corroborated (#835). A second query would
# be a second HTTP call and a second failure mode for an answer already in hand; and if
# the listing were untrustworthy the tick has already aborted above, which is correct —
# an unreachable daemon is not evidence that the orchestrator is down.
#
# WARN-ONLY, permanently: orchestrator lifecycle is user-actuated (#606). No kill, no
# DELETE, no inject. The alert cannot be an inject precisely BECAUSE of what it reports —
# the orchestrator is the thing that is down, and a STALE session is exactly the one that
# bounces `[STALE] Session is stale and awaiting cleanup`. So it goes to alerts.log via
# emit_alert, which also tees to this tick's stderr and thus into reconciler.log under
# launchd. That is where a human looks after noticing their injects bouncing, and it is
# the same channel every other operator-actionable finding here already uses.
ORCH_SID="${ORCHESTRATOR_SID:-orchestrator}"
ORCH_STALE_ALERT_MIN="${ORCH_STALE_ALERT_MIN:-5}"
orch_rec=$(printf '%s' "$listing" | jq -c --arg s "$ORCH_SID" '.[] | select(.id == $s)' 2>/dev/null | head -1)
if [ -n "$orch_rec" ]; then
  orch_health=$(printf '%s' "$orch_rec" | jq -r '.healthStatus // .status // ""' 2>/dev/null)
  case "$orch_health" in
    STALE|DISCONNECTED)
      orch_last=$(printf '%s' "$orch_rec" | jq -r '.lastSeenAt // .last_seen // .disconnectedAt // ""' 2>/dev/null)
      orch_age=$(seconds_since_iso "$orch_last")
      # No timestamp → seconds_since_iso yields 0 → below any positive threshold → no
      # alert. Silence on a missing field is the right way round: this fires an operator
      # page, and crying wolf on an unparseable record would teach them to ignore it.
      if [ "$orch_age" -ge $((ORCH_STALE_ALERT_MIN * 60)) ]; then
        emit_alert "ORCHESTRATOR_STALE sid=$ORCH_SID health=$orch_health for ${orch_age}s (>= ${ORCH_STALE_ALERT_MIN}m) — worker reports are bouncing '[STALE] Session is stale and awaiting cleanup' and nothing is reading them. Remedy: run bin/orchestrator-boot.sh (it reconciles the stale registry record, then re-claims the id). WARN-ONLY: this tick will not touch the orchestrator."
      fi
      ;;
  esac
fi

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
  disc_age=0
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
  state_json=$(SID="$sid" HEALTH="$health" AGE="$age" REASONS="$reasons" DISC_AGE="$disc_age" python3 - <<'PY'
import json, os

health = os.environ.get("HEALTH", "")
cleanup = {
    "age_seconds": int(os.environ.get("AGE") or 0),
    "disconnect_age_seconds": int(os.environ.get("DISC_AGE") or 0),
    "gc_root": False,
    "keep_alive": False,
    "reasons": [part for part in os.environ.get("REASONS", "").split(",") if part],
}
print(json.dumps({
    "alive": health == "CONNECTED",
    "ready": False,
    "surface": "idle",
    "activity": "static",
    "cli": "unknown",
    "detail": {"health": health, "cleanup": cleanup},
}, separators=(",", ":")))
PY
)
  action_json=$(policy_decide orphaned "$state_json")
  append_shadow_record "$sid" orphaned "$state_json" "$action_json"
  if [ "$(json_get "$action_json" action)" != "CLEANUP" ]; then
    if [ "$reasons" = "surface_gone" ]; then
      log "INV-17 skip sid=$sid — surface_gone single-signal (no pid/disconnect corroboration)"
    else
      log "SWEEP skip sid=$sid reason=$(json_get "$action_json" reason)"
    fi
    continue
  fi
  log "SWEEP candidate sid=$sid age=${age}s health=$health reasons=$reasons"
  if [ "$DRY_RUN" -eq 1 ]; then continue; fi
  apply_action "$sid" orphaned "" 0 "$action_json"
  swept=$((swept + 1))
done <<< "$candidates"

# --- step 2b: cmux-adaptor sidebar keeping (SPEC 2026-06-06) ---
# Best-effort, never blocks the sweep (wh_* always return 0). Honors DRY_RUN via
# the exported flag (wh_prune_orphans reads $DRY_RUN; status push is skipped here).
#
# §A prune — live_ids = telepty ids ∪ gc_root ∪ keep_alive (titles are sids, F4);
# protected_refs = the orchestrator's own workspace ref when known ($CMUX_WORKSPACE_ID;
# empty under launchd — the ownership gate already protects the orchestrator, whose
# cwd is the repo dir, not the role-sandbox). DRY_RUN is honored inside the adapter.
telepty_ids=$(printf '%s' "$listing" | jq -r '.[].id // empty' 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//')
live_ids=$(printf '%s,%s,%s' "$telepty_ids" "$gc_root" "$keep_alive" | tr ',' '\n' | sed '/^$/d' | sort -u | tr '\n' ',' | sed 's/,$//')
protected_refs="${CMUX_WORKSPACE_ID:-}"
# DRY_RUN is visible to the adapter via the inherited shell var (read as $DRY_RUN).
pruned=$(wh_prune_orphans "$live_ids" "$protected_refs" 2>/dev/null || echo 0)

# §B status push — one sidebar pill per live telepty session. Conservative default
# (orchestrator decision 3): CONNECTED→idle, DISCONNECTED→disconnected; never emit
# a false "working" (no richer activity signal wired this phase — Article 1).
status_pushed=0
if [ "$DRY_RUN" -eq 0 ]; then
  while IFS=$'\t' read -r host_id health; do
    [ -z "$host_id" ] && continue
    case "$health" in
      DISCONNECTED) wh_set_status "$host_id" disconnected ;;
      CONNECTED|*)  wh_set_status "$host_id" idle ;;
    esac
    status_pushed=$((status_pushed + 1))
  done < <(printf '%s' "$listing" | jq -r '.[] | select(.cmuxWorkspaceId != null and .cmuxWorkspaceId != "") | [.cmuxWorkspaceId, (.healthStatus // .status // "")] | @tsv' 2>/dev/null)
fi

log "tick: gc_root=[$gc_root] keep_alive=[$keep_alive] swept=$swept pruned=${pruned:-0} status_pushed=$status_pushed dry_run=$DRY_RUN"
