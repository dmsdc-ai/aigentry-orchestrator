#!/usr/bin/env bash
# dispatch-tracker.sh — Orchestrator-side dispatch health-check + auto re-dispatch.
#
# Polls every dispatch the registry is still holding open and records what it
# measured. telepty#60 Stage A: it can no longer settle anything. Screen state,
# git commits, disconnects, errors and cleanups became observations; the outcome
# axis is created "unknown" by the registry and has no writer at all in 0.8.0.
# The honest answer for most dispatches is "no completion fact observed", and a
# repeating HOLD is what surfaces that to a human.
#
# See docs/specs/2026-05-12-dispatch-healthcheck.md (Rule 32 영구 fix for #113).
#
# Commands:
#   dispatch-tracker.sh check                    — one-shot scan; alerts to stdout + log
#   dispatch-tracker.sh status [<sid>]
#   dispatch-tracker.sh prune
#   dispatch-tracker.sh --help
#
# Records are created by bin/dispatch.sh's begin-delivery transaction BEFORE the
# bytes are handed over, so there is no append/register hook here — a second
# record-creation entrance is exactly what the single-writer proof would have to
# keep excluding forever.
#
# Article 17: shell + Python stdlib only. macOS + Linux.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
ALERTS_LOG="$STATE_DIR/alerts.log"
OBSERVATIONS_LOG="$STATE_DIR/observations.log"
OBSERVATIONS_SEEN="$STATE_DIR/observations.seen"
DISCONNECTED_LOG="$STATE_DIR/disconnected.log"

ORCH_SID="${ORCHESTRATOR_SID:-orchestrator}"
TRACKER_SID="${TRACKER_FROM_SID:-dispatch-tracker}"

# Test seams (override in tests via env)
TELEPTY="${TELEPTY:-telepty}"
CURL="${CURL:-curl}"
GIT="${GIT:-git}"
DISPATCH_SH="${DISPATCH_SH:-$SCRIPT_DIR/dispatch.sh}"
SESSION_PROBE_PY="${SESSION_PROBE_PY:-$SCRIPT_DIR/session-probe.py}"
POLICY_PY="${POLICY_PY:-$SCRIPT_DIR/policy.py}"
DISPATCH_REGISTRY_PY="${DISPATCH_REGISTRY_PY:-$SCRIPT_DIR/dispatch-registry.py}"
HITL_SH="${HITL_SH:-$SCRIPT_DIR/hitl.sh}"
NOW_OVERRIDE="${TRACKER_NOW:-}"

mkdir -p "$STATE_DIR"

usage() { sed -n '2,22p' "$0"; }

# Every registry access is a typed call to the one transactional component.
# There is no local read/write path, so there is nothing here to fail open on a
# corrupt registry: the component fails closed and this script inherits that.
registry() { "$DISPATCH_REGISTRY_PY" "$@"; }

now_iso() {
  if [ -n "$NOW_OVERRIDE" ]; then printf '%s' "$NOW_OVERRIDE"; return; fi
  python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"))'
}

emit_alert() {
  local line="$1"
  printf '%s %s\n' "$(now_iso)" "$line" | tee -a "$ALERTS_LOG"
}

read_screen() {
  local sid="$1" lines="${2:-60}"
  "$TELEPTY" read-screen "$sid" --lines "$lines" 2>/dev/null || true
}

session_disconnected() {
  local sid="$1" listing
  listing=$("$TELEPTY" list --json 2>/dev/null || true)
  SID="$sid" LISTING="$listing" python3 - <<'PY'
import json, os
sid = os.environ.get("SID","")
listing = os.environ.get("LISTING","")
try:
    for s in json.loads(listing):
        if s.get("id") == sid:
            print(s.get("healthStatus") or s.get("status") or "")
            break
except Exception:
    pass
PY
}

probe_from_screen() {
  local sid="$1" screen="$2" tmp state
  tmp=$(mktemp)
  printf '%s' "$screen" > "$tmp"
  state=$(TELEPTY="$TELEPTY" "$SESSION_PROBE_PY" --sid "$sid" --screen-file "$tmp" 2>/dev/null || true)
  rm -f "$tmp"
  if [ -z "$state" ]; then
    printf '%s\n' '{"alive":false,"ready":false,"surface":"unknown","activity":"static","cli":"unknown","detail":{"probe_error":"session-probe failed","tracker_class":"blank"}}'
  else
    printf '%s\n' "$state"
  fi
}

policy_for_tracker() {
  local state_json="$1"
  printf '%s\n' "$state_json" | "$POLICY_PY" --status tracker_check --state - 2>/dev/null || \
    printf '%s\n' '{"action":"ESCALATE","reason":"policy failed","status":"stuck_error"}'
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

# _json_sub <json-text> <key> — the named sub-object as JSON ("{}" when absent).
_json_sub() {
  JSON_TEXT="$1" KEY="$2" python3 - <<'PY'
import json, os
try:
    data = json.loads(os.environ.get("JSON_TEXT", "") or "{}")
except Exception:
    data = {}
sub = data.get(os.environ["KEY"])
print(json.dumps(sub if isinstance(sub, dict) else {}, ensure_ascii=False))
PY
}

# --- iterate dispatches needing a check, classify, act ---
cmd_check() {
  local now; now=$(now_iso)
  # Candidates: still-open dispatches whose expected_report_by has elapsed. A
  # corrupt/unavailable registry makes this call fail, and errexit stops the tick
  # before any actuation — fail-closed by construction.
  local snap; snap=$(mktemp)
  registry list --live --due-before "$now" \
    --fields assigned.sid,cwd,ref_path,dispatched_at,re_dispatch_count,transport.inject_id,dispatch_id > "$snap"

  local processed=0
  while IFS=$'\t' read -r sid cwd ref_path dispatched_at rdc inject_id dispatch_id; do
    [ -z "$sid" ] && continue
    # `null` is the registry's literal for an absent/empty field.
    [ "$cwd" = "null" ] && cwd=""
    [ "$ref_path" = "null" ] && ref_path=""
    [ "$rdc" = "null" ] && rdc=0
    processed=$((processed+1))
    local hs; hs=$(session_disconnected "$sid")
    if [ "$hs" = "DISCONNECTED" ]; then
      printf '%s %s\n' "$(now_iso)" "DISCONNECTED $sid skip" >> "$DISCONNECTED_LOG"
      # Connectivity, not outcome: a session that went away has said nothing
      # about whether the assigned work finished.
      registry observe --sid "$sid" --kind session_disconnected_observed --now "$(now_iso)"
      registry set-lifecycle --sid "$sid" --state disconnected --now "$(now_iso)"
      continue
    fi
    # Poll telepty's per-inject observation ledger. Anything that is not a valid
    # schema-v2 observation — absent endpoint, legacy body, dead daemon, or no
    # transport inject_id at all — is named absence: HOLD and keep polling. This
    # path is what the whole maintenance window runs on while the telepty half is
    # still unreleased.
    #
    # Named absence blocks the git-evidence fallback below (§8.3.2: the tracker
    # HOLDs and continues, it does not fall back to screen/git as a substitute
    # answer). It does NOT stop the operational branches — a disconnect, an error
    # surface or a stuck welcome screen still need actuating, and none of them
    # settles anything.
    local evidence_blocked=0
    if _poll_observations_and_hold "$sid" "$dispatch_id" "$inject_id"; then
      evidence_blocked=1
    fi
    local screen state_json action_json class action status
    screen=$(read_screen "$sid" 60)
    state_json=$(probe_from_screen "$sid" "$screen")
    action_json=$(policy_for_tracker "$state_json")
    class=$(json_get "$state_json" detail.tracker_class)
    [ -n "$class" ] || class=blank
    action=$(json_get "$action_json" action)
    status=$(json_get "$action_json" status)
    _record_classification "$sid" "$class"

    if [ "$status" = "stuck_error" ]; then
      emit_alert "STUCK_ERROR sid=$sid"
      registry observe --sid "$sid" --kind error_surface_observed --field "class=$class" --now "$(now_iso)"
      registry set-lifecycle --sid "$sid" --state stuck_error --now "$(now_iso)"
    elif [ "$action" = "REDISPATCH" ] && [ "$status" = "stuck_welcome" ]; then
        emit_alert "STUCK_WELCOME sid=$sid"
        registry observe --sid "$sid" --kind welcome_surface_observed --now "$(now_iso)"
        registry set-lifecycle --sid "$sid" --state stuck_welcome --now "$(now_iso)"
        _maybe_redispatch "$sid" "$cwd" "$ref_path" "$dispatched_at" "$rdc"
    elif [ "$class" = "active" ]; then
      _bump_expected "$sid"
    elif [ "$evidence_blocked" -eq 0 ]; then
      _git_check_and_observe "$sid" "$cwd" "$ref_path" "$dispatched_at" "$screen" || true
    fi
  done < "$snap"
  rm -f "$snap"
  echo "tracker check: $processed entries processed"
}

_record_classification() {
  local sid="$1" cls="$2"
  registry observe --sid "$sid" --kind screen_class_observed --field "class=$cls" --now "$(now_iso)"
}

_bump_expected() {
  local sid="$1"
  registry set-lifecycle --sid "$sid" --extend-minutes 15 --now "$(now_iso)"
}

# _maybe_redispatch — only dispatch exit 0 may advance the attempt counter, the
# lifecycle and the deadline. Exits 8 (deduplicated) and 7 (delivery unknown)
# mean NO new delivery happened; booking either as a re-dispatch is how the
# ledger came to record attempts that never occurred.
_maybe_redispatch() {
  local sid="$1" cwd="$2" ref_path="$3" dispatched_at="$4" rdc="${5:-0}"
  [ -z "$rdc" ] && rdc=0
  if [ "$rdc" -ge 1 ]; then
    emit_alert "REDISPATCH_CAP sid=$sid count=$rdc — user gate required"
    return 0
  fi
  if [ -n "$cwd" ] && _has_new_commits "$cwd" "$dispatched_at"; then
    emit_alert "REDISPATCH_SKIP sid=$sid — new commits present, deferring to git path"
    return 0
  fi
  # Rule 34 task-gate (#736): a re-dispatch re-actuates work already registered
  # under the original dispatch's task, so it takes the audited exemption.
  local rc=0
  "$DISPATCH_SH" --target "$sid" --ref "$ref_path" --verify-delivered \
    --no-task "tracker-redispatch $sid" >/dev/null 2>&1 || rc=$?
  # The alert reports the OUTCOME of the call, not the intention to make it.
  case "$rc" in
    0)
      registry set-lifecycle --sid "$sid" --state re_dispatched \
        --bump-re-dispatch-count --extend-minutes 30 --now "$(now_iso)"
      emit_alert "REDISPATCH_OK sid=$sid attempt=$((rdc + 1)) ref=$ref_path"
      ;;
    8)
      registry observe --sid "$sid" --kind redispatch_suppressed_duplicate \
        --field "ref_path=$ref_path" --now "$(now_iso)"
      emit_alert "REDISPATCH_SUPPRESSED sid=$sid — identical ref already delivered; no new delivery"
      # Freezing the counter would make the one-shot operator gate unreachable,
      # leaving a stuck dispatch surfaced only by a repeating HOLD. Open it here.
      _open_redispatch_gate "$sid" "$ref_path" "duplicate suppressed: $sid is already holding an identical delivered ref"
      ;;
    7)
      registry observe --sid "$sid" --kind redispatch_held_delivery_unknown \
        --field "ref_path=$ref_path" --now "$(now_iso)"
      emit_alert "REDISPATCH_HELD sid=$sid — a prior attempt's delivery is unknown; not replayed"
      ;;
    *)
      emit_alert "REDISPATCH_FAILED sid=$sid rc=$rc"
      ;;
  esac
}

_open_redispatch_gate() {
  local sid="$1" ref_path="$2" question="$3"
  [ -x "$HITL_SH" ] || { emit_alert "HITL_GATE_UNAVAILABLE $HITL_SH not executable — sid=$sid"; return 0; }
  "$HITL_SH" open --source dispatch-tracker --subject-sid "$sid" --kind decision \
    --resume registry-clear-redispatch --question "$question" \
    --options "approve=re-dispatch once more,reject=hand back to the operator" \
    --context-ref "$ref_path" >/dev/null 2>&1 || emit_alert "HITL_GATE_OPEN_FAILED sid=$sid"
}

_has_new_commits() {
  local cwd="$1" since="$2" email log
  [ -d "$cwd" ] || return 1
  "$GIT" -C "$cwd" rev-parse --git-dir >/dev/null 2>&1 || return 1
  email=$("$GIT" -C "$cwd" config user.email 2>/dev/null || true)
  log=$("$GIT" -C "$cwd" log --since="$since" --pretty=format:'%H%x09%ae%x09%B%x1e' HEAD 2>/dev/null || true)
  EMAIL="$email" LOG="$log" python3 - <<'PY'
import os, sys
email = os.environ.get("EMAIL","").strip().lower()
data  = os.environ.get("LOG","")
rows = [r for r in data.split("\x1e") if r.strip()]
if not rows: sys.exit(1)
for r in rows:
    parts = r.strip().split("\t", 2)
    if len(parts) < 3: continue
    sha, ae, body = parts
    if email and ae.strip().lower() == email: sys.exit(0)
    bl = body.lower()
    if "claude" in bl and "co-authored-by:" in bl: sys.exit(0)
sys.exit(1)
PY
}

# _shared_cwd_branch_ambiguous <sid> <cwd> — exit 0 (AMBIGUOUS) when 2+ still-open
# dispatches share <cwd> AND the branch recorded for <sid>; exit 1 otherwise.
# #541: a single commit cannot be attributed to one sid when sessions collide on
# (cwd, branch) — same cwd+author+branch yields no discriminator — so the git
# evidence snapshot must skip rather than misattribute.
_shared_cwd_branch_ambiguous() {
  local sid="$1" cwd="$2" branch rows
  branch=$(registry get --sid "$sid" --pointer branch)
  [ "$branch" = "null" ] && branch=""
  rows=$(registry list --live --fields cwd,branch)
  ROWS="$rows" CWD="$cwd" BRANCH="$branch" python3 - <<'PY'
import os
rows = [r for r in os.environ.get("ROWS", "").splitlines() if r]
cwd, branch = os.environ["CWD"], os.environ["BRANCH"]
n = 0
for row in rows:
    parts = row.split("\t")
    row_cwd = "" if parts[0] == "null" else parts[0]
    row_branch = "" if len(parts) < 2 or parts[1] == "null" else parts[1]
    if row_cwd == cwd and row_branch == branch:
        n += 1
raise SystemExit(0 if n > 1 else 1)
PY
}

# _worker_git_dir <sid> <cwd> — the directory whose git HEAD reflects THIS worker's
# work: the dispatch-recorded `worktree` when present + a valid git dir, else <cwd>.
# #718: a worker often commits in a dedicated worktree while the record's cwd points
# at the shared main checkout, so `git -C cwd rev-parse HEAD` reads the orchestrator's
# own just-landed main commit and misattributes it. Prefer the worktree.
_worker_git_dir() {
  local sid="$1" cwd="$2" wt
  wt=$(registry get --sid "$sid" --pointer worktree)
  [ "$wt" = "null" ] && wt=""
  if [ -n "$wt" ] && "$GIT" -C "$wt" rev-parse --git-dir >/dev/null 2>&1; then
    printf '%s' "$wt"
  else
    printf '%s' "$cwd"
  fi
}

# _on_protected_branch <git_dir> — exit 0 when <git_dir>'s CURRENT branch is the
# shared mainline (main/master). #718: a worker's isolated work never lives on main
# (install_worker_git_guard blocks worker pushes to it), so a mainline HEAD in the
# only resolvable context is the orchestrator's commit, not the worker's — git
# attribution must then degrade to screen-state-only and never cite that sha.
_on_protected_branch() {
  local gdir="$1" br
  br=$("$GIT" -C "$gdir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  case "$br" in main|master) return 0;; *) return 1;; esac
}

# _git_check_and_observe — a new authored commit in the worker's git context is
# EVIDENCE FOR A HUMAN, not a completion. It records a nonterminal
# worktree_activity_observed snapshot with review_required, leaves the outcome
# untouched, and does not stop the dispatch being polled. The old version wrote
# a terminal status here: a commit in a directory is not a report
# from a session, and nothing in this path correlates the two.
_git_check_and_observe() {
  local sid="$1" cwd="$2" ref_path="$3" dispatched_at="$4" screen="$5"
  [ -n "$cwd" ] || return 0
  # #718: attribute against the WORKER's git context (its worktree if recorded),
  # never the shared cwd HEAD.
  local gdir; gdir=$(_worker_git_dir "$sid" "$cwd")
  _has_new_commits "$gdir" "$dispatched_at" || return 0
  # #541 — ambiguous-attribution guard: when 2+ open dispatches share this sid's
  # (cwd, branch), skip the snapshot rather than crediting another session's commit.
  _shared_cwd_branch_ambiguous "$sid" "$cwd" && return 0
  local head_sha files added removed test_signal now seen_key
  test_signal=$(printf '%s' "$screen" | python3 -c '
import sys,re
m=re.findall(r"(\d+ passed|\d+ failed|\d+ FAIL|ok \d+ tests?)", sys.stdin.read())
print(" / ".join(m) if m else "none")
')
  now=$(now_iso)
  # #718 honest degradation: when the only resolvable git context is a mainline
  # checkout (main/master), the worker's work is NOT here — record screen-state
  # only and never cite the (orchestrator's) HEAD sha.
  if _on_protected_branch "$gdir"; then
    head_sha=""
    seen_key=$(printf '%s\tNOSHA' "$sid")
  else
    head_sha=$("$GIT" -C "$gdir" rev-parse --short HEAD 2>/dev/null || echo unknown)
    seen_key=$(printf '%s\t%s' "$sid" "$head_sha")
  fi
  grep -qxF "$seen_key" "$OBSERVATIONS_SEEN" 2>/dev/null && return 0
  read -r files added removed < <(_git_shortstat "$gdir" "$dispatched_at")

  local -a obs=(observe --sid "$sid" --kind worktree_activity_observed
                --field review_required=true --field "test_signal=$test_signal"
                --field "files_changed=$files" --field "loc_added=$added"
                --field "loc_removed=$removed" --now "$now")
  if [ -n "$head_sha" ]; then
    obs+=(--field "head_sha=$head_sha")
  else
    obs+=(--field attribution=omitted --field reason=cwd_on_protected_branch)
  fi
  registry "${obs[@]}"

  SID="$sid" NOW="$now" SHA="$head_sha" FILES="$files" ADDED="$added" \
    REMOVED="$removed" TS="$test_signal" python3 - >> "$OBSERVATIONS_LOG" <<'PY'
import json, os
sha = os.environ.get("SHA") or None
print(json.dumps({"kind": "WORKTREE_ACTIVITY", "sid": os.environ["SID"],
                  "emitted_at": os.environ["NOW"], "head_sha": sha,
                  "attribution": "omitted" if sha is None else "worker_git_dir",
                  "files_changed": int(os.environ.get("FILES") or 0),
                  "loc_added": int(os.environ.get("ADDED") or 0),
                  "loc_removed": int(os.environ.get("REMOVED") or 0),
                  "test_signal": os.environ.get("TS", ""),
                  "completion_fact": None, "review_required": True}))
PY
  printf '%s\n' "$seen_key" >> "$OBSERVATIONS_SEEN"
  local note="WORKTREE_ACTIVITY sid=$sid sha=${head_sha:-omitted} files=$files +$added/-$removed tests=$test_signal — evidence only, no completion fact, review required"
  emit_alert "$note"
  if command -v "$TELEPTY" >/dev/null 2>&1; then
    "$TELEPTY" inject --from "$TRACKER_SID" "$ORCH_SID" "$note" >/dev/null 2>&1 || true
  fi
}

_git_shortstat() {
  local cwd="$1" since="$2"
  local first
  first=$("$GIT" -C "$cwd" log --since="$since" --pretty=format:'%H' HEAD 2>/dev/null | tail -1)
  [ -n "$first" ] || { echo "0 0 0"; return; }
  "$GIT" -C "$cwd" diff --shortstat "${first}~1..HEAD" 2>/dev/null | python3 -c '
import sys,re
t=sys.stdin.read()
f=re.search(r"(\d+) files? changed", t); a=re.search(r"(\d+) insertions?", t); d=re.search(r"(\d+) deletions?", t)
print((f.group(1) if f else "0"), (a.group(1) if a else "0"), (d.group(1) if d else "0"))
'
}

# --- telepty#60 Stage A: per-inject observation poll + HOLD -----------------
# _poll_observations_and_hold <sid> <dispatch_id> <inject_id>
#
# Polls telepty GET /api/inject-observations/:inject_id, which returns a
# discriminated schema-v2 body and never uses 404 as a task-state signal.
# Returns 0 when the result is named ABSENCE (caller `continue`s: HOLD emitted,
# dispatch keeps being polled, nothing settled). Returns 1 only when a valid
# schema-v2 observation was recorded, so the caller may go on to collect
# screen/git evidence.
#
# There is deliberately no DELETE here. The old code deleted the daemon's
# pending record after surfacing a hold, which threw away the very history the
# next poll needs — and a record the orchestrator does not own is not its to
# discard. Idempotency lives in the seen-ledger.
#
# Every non-v2 shape is absence, including the legacy pre-v2 poll body: its
# idle_notified flag is the PTY-derived false authority Stage A exists to remove,
# so it is never read as evidence. This is the path the whole cutover window
# runs on, because 0.7.1 has neither this endpoint nor a CLI-visible inject_id.
_poll_observations_and_hold() {
  local sid="$1" dispatch_id="$2" inject_id="$3"
  local port="${TELEPTY_PORT:-3848}" reason="" body="" http="" resp=""

  if [ -z "$inject_id" ] || [ "$inject_id" = "null" ]; then
    reason=no_transport_inject_id
  elif ! resp=$("$CURL" -s -w $'\n%{http_code}' \
        "http://127.0.0.1:${port}/api/inject-observations/${inject_id}" 2>/dev/null); then
    printf '%s %s\n' "$(now_iso)" "OBSERVATION_POLL_SKIP sid=$sid curl_failed" >> "$DISCONNECTED_LOG"
    reason=observation_poll_failed
  else
    http="${resp##*$'\n'}"
    body="${resp%$'\n'*}"
    if [ "$http" != "200" ]; then
      reason=observation_endpoint_absent
    elif [ "$(json_get "$body" schema_version)" != "2" ]; then
      reason=unknown_observation_schema
    elif [ "$(json_get "$body" tracking_state)" = "unavailable" ]; then
      reason=$(json_get "$body" reason)
      [ -n "$reason" ] || reason=tracking_state_unavailable
    else
      local kind sub
      kind=$(json_get "$body" observation.kind)
      [ -n "$kind" ] || kind=unmapped_transition_cause
      sub=$(_json_sub "$body" observation)
      # Recorded verbatim as an observation. Consumption evidence is data here,
      # never a licence: nothing downstream may read it as a stronger fact than
      # the daemon's own screen-derived whitelist already allows.
      registry observe --sid "$sid" --kind "$kind" --json "$sub" \
        --field "consumption=$(json_get "$body" consumption.status)" \
        --field "inject_id=$inject_id" --now "$(now_iso)"
      return 1
    fi
  fi

  registry observe --sid "$sid" --kind tracking_unavailable \
    --field "reason=$reason" --field "inject_id=${inject_id:-null}" --now "$(now_iso)"

  # One HOLD per (dispatch, reason): a level-triggered loop keeps polling, but a
  # human is told once per distinct absence rather than every 60 seconds.
  local seen_key; seen_key=$(printf '%s\tHOLD\t%s\t%s' "$sid" "$dispatch_id" "$reason")
  if grep -qxF "$seen_key" "$OBSERVATIONS_SEEN" 2>/dev/null; then
    return 0
  fi
  SID="$sid" NOW="$(now_iso)" REASON="$reason" DID="$dispatch_id" \
    python3 - >> "$OBSERVATIONS_LOG" <<'PY'
import json, os
print(json.dumps({"kind": "HOLD", "sid": os.environ["SID"],
                  "dispatch_id": os.environ["DID"],
                  "emitted_at": os.environ["NOW"],
                  "reason": os.environ["REASON"],
                  "completion_fact": None,
                  "outcome": "unknown",
                  "review_required": True}, ensure_ascii=False))
PY
  printf '%s\n' "$seen_key" >> "$OBSERVATIONS_SEEN"
  local note="HOLD sid=$sid reason=$reason — no completion fact observed; outcome unknown, still polling"
  emit_alert "$note"
  if command -v "$TELEPTY" >/dev/null 2>&1; then
    "$TELEPTY" inject --from "$TRACKER_SID" "$ORCH_SID" "$note" >/dev/null 2>&1 || true
  fi
  return 0
}

cmd_status() {
  local sid="${1:-}"
  local -a a=(list --fields assigned.sid,outcome.state,lifecycle.state,gate.state,expected_report_by,re_dispatch_count)
  if [ -n "$sid" ]; then
    printf '%-40s %-8s %-26s %-14s %s\n' "$sid" \
      "$(registry get --sid "$sid" --pointer outcome.state)" \
      "$(registry get --sid "$sid" --pointer lifecycle.state)" \
      "$(registry get --sid "$sid" --pointer gate.state)" \
      "exp=$(registry get --sid "$sid" --pointer expected_report_by)"
    return 0
  fi
  registry "${a[@]}" | while IFS=$'\t' read -r s outcome lifecycle gate exp rdc; do
    printf '%-40s %-8s %-26s %-14s exp=%s rdc=%s\n' "$s" "$outcome" "$lifecycle" "$gate" "$exp" "$rdc"
  done
}

# Retired lifecycles age out after a day. A dispatch whose outcome is still
# unknown is never pruned: its record is the only evidence the work was handed
# out at all, and 0.8.0 has no way to learn it finished.
cmd_prune() {
  registry prune --older-than-seconds 86400
}

main() {
  [ $# -eq 0 ] && { usage; exit 4; }
  local cmd="$1"; shift
  case "$cmd" in
    check)          cmd_check "$@";;
    status)         cmd_status "$@";;
    prune)          cmd_prune "$@";;
    -h|--help)      usage;;
    *) echo "unknown: $cmd" >&2; usage >&2; exit 4;;
  esac
}

main "$@"
