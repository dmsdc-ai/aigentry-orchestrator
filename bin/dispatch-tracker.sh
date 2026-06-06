#!/usr/bin/env bash
# dispatch-tracker.sh — Orchestrator-side dispatch health-check + auto re-dispatch.
#
# Tracks every bin/dispatch.sh inject, polls stuck sessions, and (when configured)
# emits AUTO_REPORT entries by reading the screen and the session cwd's git log.
#
# See docs/specs/2026-05-12-dispatch-healthcheck.md (Rule 32 영구 fix for #113).
#
# Commands:
#   dispatch-tracker.sh append <sid> <ref_path> <ref_hash> [--cwd <p>] [--from <sid>]
#   dispatch-tracker.sh register <sid> [--track T] [--role R] [--cwd P] [--branch B] [--started-at TS]
#   dispatch-tracker.sh check                    — one-shot scan; alerts to stdout + log
#   dispatch-tracker.sh mark-reported <sid>      — orchestrator REPORT-receipt hook
#   dispatch-tracker.sh status [<sid>]
#   dispatch-tracker.sh prune
#   dispatch-tracker.sh --help
#
# Article 17: shell + Python stdlib only. macOS + Linux.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
ACTIVE_JSON="$STATE_DIR/active.json"
ALERTS_LOG="$STATE_DIR/alerts.log"
AUTO_REPORTS_LOG="$STATE_DIR/auto-reports.log"
AUTO_REPORTS_SEEN="$STATE_DIR/auto-reports.seen"
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
NOW_OVERRIDE="${TRACKER_NOW:-}"

mkdir -p "$STATE_DIR"
[ -f "$ACTIVE_JSON" ] || printf '[]\n' > "$ACTIVE_JSON"

usage() { sed -n '2,18p' "$0"; }

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

# --- _mutate_state <python-snippet>  — locks active.json, exposes `entries` list ---
# Snippet is exec'd with: entries (list), json, os, datetime modules pre-imported.
# Pass per-call data via env vars (SID=..., CLS=..., etc.).
_mutate_state() {
  local snippet="$1"
  ACTIVE_JSON="$ACTIVE_JSON" python3 - "$snippet" <<'PY'
import fcntl, json, os, sys, datetime
path = os.environ["ACTIVE_JSON"]
snippet = sys.argv[1]
with open(path, "r+") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    try:
        entries = json.load(f)
    except Exception:
        entries = []
    ns = {"entries": entries, "json": json, "os": os, "datetime": datetime}
    exec(snippet, ns)
    f.seek(0); f.truncate()
    json.dump(ns["entries"], f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

cmd_append() {
  local sid="$1" ref_path="$2" ref_hash="$3"; shift 3
  local cwd="" from="" keep_alive=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --cwd) cwd="$2"; shift 2;;
      --from) from="$2"; shift 2;;
      --keep-alive) keep_alive=1; shift;;
      *) echo "append: unknown $1" >&2; exit 4;;
    esac
  done
  local now; now=$(now_iso)
  ACTIVE_JSON="$ACTIVE_JSON" SID="$sid" RP="$ref_path" RH="$ref_hash" \
    CWD="$cwd" FROM="$from" NOW="$now" KEEPALIVE="$keep_alive" \
    python3 - <<'PY'
import fcntl, json, os, datetime
def plus30(iso):
    dt=datetime.datetime.fromisoformat(iso.replace("Z","+00:00"))
    return (dt+datetime.timedelta(minutes=30)).isoformat(timespec="seconds").replace("+00:00","Z")
path=os.environ["ACTIVE_JSON"]
with open(path,"r+") as f:
    fcntl.flock(f,fcntl.LOCK_EX)
    try: entries=json.load(f)
    except Exception: entries=[]
    entries=[e for e in entries if e.get("sid")!=os.environ["SID"] or e.get("status") in ("reported","auto_reported","stuck_error","delivery_failed")]
    entries.append({
        "sid":os.environ["SID"],
        "ref_path":os.environ["RP"],
        "ref_hash":os.environ["RH"],
        "dispatched_at":os.environ["NOW"],
        "expected_report_by":plus30(os.environ["NOW"]),
        "last_seen_at":os.environ["NOW"],
        "status":"in_flight",
        "classification_history":[],
        "cwd":os.environ.get("CWD",""),
        "from_sid":os.environ.get("FROM",""),
        "re_dispatch_count":0,
        "keep_alive": os.environ.get("KEEPALIVE","0") == "1",
    })
    f.seek(0); f.truncate()
    json.dump(entries,f,indent=2,ensure_ascii=False); f.write("\n")
PY
}

# register <sid> [--track T] [--role R] [--cwd P] [--branch B] [--started-at TS]
# Upserts the tracker registry entry for <sid> (idempotent on sid) via the same
# _mutate_state fcntl lock as every other writer — keeps active.json single-owner
# (#517: dispatch.sh never populated the registry, so `check` found nothing to
# AUTO_REPORT). Merges onto an existing entry (e.g. one already created by
# `append`) rather than clobbering it; creates a fresh in_flight entry otherwise.
cmd_register() {
  local sid="$1"; shift
  local track="" role="" cwd="" branch="" started_at=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --track) track="$2"; shift 2;;
      --role) role="$2"; shift 2;;
      --cwd) cwd="$2"; shift 2;;
      --branch) branch="$2"; shift 2;;
      --started-at) started_at="$2"; shift 2;;
      *) echo "register: unknown $1" >&2; exit 4;;
    esac
  done
  [ -n "$started_at" ] || started_at=$(now_iso)
  SID="$sid" TRACK="$track" ROLE="$role" CWD="$cwd" BRANCH="$branch" STARTED="$started_at" \
    _mutate_state "
sid = os.environ['SID']
fields = {
    'track': os.environ['TRACK'],
    'role': os.environ['ROLE'],
    'cwd': os.environ['CWD'],
    'branch': os.environ['BRANCH'],
    'started_at': os.environ['STARTED'],
}
found = None
for e in entries:
    if e.get('sid') == sid:
        found = e
        break
if found is None:
    entry = {'sid': sid, 'status': 'in_flight', 'reported': None}
    entry.update(fields)
    entries.append(entry)
else:
    found.update(fields)
    found.setdefault('reported', None)
    found.setdefault('status', 'in_flight')
"
}

cmd_mark_reported() {
  local sid="$1"
  SID="$sid" _mutate_state "
sid = os.environ['SID']
for e in entries:
    if e.get('sid') == sid and e.get('status') in ('in_flight','re_dispatched','auto_reported','stuck_welcome'):
        e['status'] = 'reported'
"
  # Layer D — schedule cleanup if scheduler script is available + sid is not keep-alive.
  # Scheduler internally skips when active.json has keep_alive=true for sid.
  local scheduler="${SCHEDULER_SH:-$SCRIPT_DIR/dispatch-cleanup-scheduler.sh}"
  if [ -x "$scheduler" ]; then
    "$scheduler" schedule "$sid" --grace-seconds 60 --source layer-d-timeout >/dev/null 2>&1 || true
  fi
}

# --- iterate entries needing a check, classify, act ---
cmd_check() {
  local now; now=$(now_iso)
  # snapshot candidate entries to a temp file (sid TAB cwd TAB ref_path TAB dispatched_at TAB rdc)
  local snap; snap=$(mktemp)
  ACTIVE_JSON="$ACTIVE_JSON" NOW="$now" python3 - > "$snap" <<'PY'
import fcntl,json,os,datetime
path=os.environ["ACTIVE_JSON"]; now=os.environ["NOW"]
ndt=datetime.datetime.fromisoformat(now.replace("Z","+00:00"))
with open(path,"r") as f:
    fcntl.flock(f,fcntl.LOCK_SH)
    try: entries=json.load(f)
    except Exception: entries=[]
for e in entries:
    if e.get("status") not in ("in_flight","re_dispatched"): continue
    exp=e.get("expected_report_by","")
    try:
        edt=datetime.datetime.fromisoformat(exp.replace("Z","+00:00"))
    except Exception:
        continue
    if ndt<=edt: continue
    print("\t".join([e["sid"],e.get("cwd",""),e.get("ref_path",""),e.get("dispatched_at",""),str(e.get("re_dispatch_count",0))]))
PY

  local processed=0
  while IFS=$'\t' read -r sid cwd ref_path dispatched_at rdc; do
    [ -z "$sid" ] && continue
    processed=$((processed+1))
    local hs; hs=$(session_disconnected "$sid")
    if [ "$hs" = "DISCONNECTED" ]; then
      printf '%s %s\n' "$(now_iso)" "DISCONNECTED $sid skip" >> "$DISCONNECTED_LOG"
      SID="$sid" NOW="$(now_iso)" _mutate_state "
sid, now = os.environ['SID'], os.environ['NOW']
for e in entries:
    if e.get('sid') == sid and e.get('status') in ('in_flight','re_dispatched'):
        e['status'] = 'disconnected'
        e['last_seen_at'] = now
"
      continue
    fi
    # #528 bus-event consumer: poll telepty's persistent pendingReports state for
    # this dispatch. On idle_notified (worker went idle after our inject but its
    # REPORT/HOLD push never landed — the "Enter 안눌림" bug) surface an AUTO_HOLD to
    # the FILE LOGS (the source of truth; the inject channel is the one that fails)
    # and `continue`. Any other outcome (404 cleared/dead, idle_notified:false,
    # curl fail) falls through to the existing stuck/active/#517-git chain below —
    # the existing branches are neither removed nor reordered.
    if _poll_pending_and_autohold "$sid" "$cwd" "$dispatched_at"; then
      continue
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
      _set_status "$sid" stuck_error
    elif [ "$action" = "REDISPATCH" ] && [ "$status" = "stuck_welcome" ]; then
        emit_alert "STUCK_WELCOME sid=$sid"
        _set_status "$sid" stuck_welcome
        _maybe_redispatch "$sid" "$cwd" "$ref_path" "$dispatched_at" "$rdc"
    elif [ "$class" = "active" ]; then
      _bump_expected "$sid"
    else
      if ! _git_check_and_autoreport "$sid" "$cwd" "$ref_path" "$dispatched_at" "$screen"; then
        : # no new commits → leave entry; alert already emitted by helper if applicable
      fi
    fi
  done < "$snap"
  rm -f "$snap"
  echo "tracker check: $processed entries processed"
}

_record_classification() {
  local sid="$1" cls="$2" now; now=$(now_iso)
  SID="$sid" CLS="$cls" NOW="$now" _mutate_state "
sid, cls, now = os.environ['SID'], os.environ['CLS'], os.environ['NOW']
for e in entries:
    if e.get('sid') == sid:
        e.setdefault('classification_history', []).append({'at': now, 'class': cls})
        e['last_seen_at'] = now
"
}

_set_status() {
  local sid="$1" st="$2"
  SID="$sid" ST="$st" _mutate_state "
sid, st = os.environ['SID'], os.environ['ST']
for e in entries:
    if e.get('sid') == sid and e.get('status') in ('in_flight','re_dispatched'):
        e['status'] = st
"
}

_bump_expected() {
  local sid="$1"
  SID="$sid" _mutate_state "
sid = os.environ['SID']
for e in entries:
    if e.get('sid') == sid and e.get('status') in ('in_flight','re_dispatched'):
        try:
            dt = datetime.datetime.fromisoformat(e['expected_report_by'].replace('Z','+00:00'))
            e['expected_report_by'] = (dt + datetime.timedelta(minutes=15)).isoformat(timespec='seconds').replace('+00:00','Z')
        except Exception: pass
"
}

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
  emit_alert "REDISPATCH sid=$sid attempt=1 ref=$ref_path"
  if "$DISPATCH_SH" --target "$sid" --ref "$ref_path" --verify-delivered >/dev/null 2>&1; then
    SID="$sid" NOW="$(now_iso)" _mutate_state "
sid, now = os.environ['SID'], os.environ['NOW']
for e in entries:
    if e.get('sid') == sid:
        e['status'] = 're_dispatched'
        e['re_dispatch_count'] = int(e.get('re_dispatch_count', 0)) + 1
        try:
            dt = datetime.datetime.fromisoformat(now.replace('Z','+00:00'))
            e['expected_report_by'] = (dt + datetime.timedelta(minutes=30)).isoformat(timespec='seconds').replace('+00:00','Z')
        except Exception: pass
"
  else
    emit_alert "REDISPATCH_FAILED sid=$sid"
  fi
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

_git_check_and_autoreport() {
  local sid="$1" cwd="$2" ref_path="$3" dispatched_at="$4" screen="$5"
  [ -n "$cwd" ] || return 0
  _has_new_commits "$cwd" "$dispatched_at" || return 0
  local head_sha files added removed test_signal
  head_sha=$("$GIT" -C "$cwd" rev-parse --short HEAD 2>/dev/null || echo unknown)
  if grep -qxF "$sid	$head_sha" "$AUTO_REPORTS_SEEN" 2>/dev/null; then
    return 0
  fi
  read -r files added removed < <(_git_shortstat "$cwd" "$dispatched_at")
  test_signal=$(printf '%s' "$screen" | python3 -c '
import sys,re
m=re.findall(r"(\d+ passed|\d+ failed|\d+ FAIL|ok \d+ tests?)", sys.stdin.read())
print(" / ".join(m) if m else "none")
')
  local now; now=$(now_iso)
  python3 - "$sid" "$now" "$head_sha" "$files" "$added" "$removed" "$test_signal" \
    >> "$AUTO_REPORTS_LOG" <<'PY'
import json,sys
sid,now,sha,fc,la,lr,ts=sys.argv[1:8]
print(json.dumps({"kind":"AUTO_REPORT","sid":sid,"emitted_at":now,"head_sha":sha,
                  "files_changed":int(fc or 0),"loc_added":int(la or 0),
                  "loc_removed":int(lr or 0),"test_signal":ts,"review_required":True}))
PY
  printf '%s\t%s\n' "$sid" "$head_sha" >> "$AUTO_REPORTS_SEEN"
  _set_status "$sid" auto_reported
  emit_alert "AUTO_REPORT sid=$sid sha=$head_sha files=$files +$added/-$removed tests=$test_signal — review required"
  if command -v "$TELEPTY" >/dev/null 2>&1; then
    "$TELEPTY" inject --from "$TRACKER_SID" "$ORCH_SID" \
      "AUTO_REPORT sid=$sid sha=$head_sha files=$files +$added/-$removed tests=$test_signal — review required" \
      >/dev/null 2>&1 || true
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

# --- #528: pendingReports poll + AUTO_HOLD ---------------------------------
# _poll_pending_and_autohold <sid> <cwd> <dispatched_at>
# Polls telepty GET /api/pendingReports/:sid (curl precedent: session-cleanup.sh).
# Returns 0 ONLY when a fresh AUTO_HOLD was surfaced (caller should `continue`).
# Returns 1 on every other outcome — curl fail (daemon down), 404 (cleared/dead),
# idle_notified:false, or already-seen — so the caller falls through to the
# existing #517 git chain. localhost is trusted, no token (http-auth.js) — §17:
# curl + the daemon are already in use, no new dependency.
_poll_pending_and_autohold() {
  local sid="$1" cwd="$2" dispatched_at="$3"
  local port="${TELEPTY_PORT:-3848}" resp http body
  if ! resp=$("$CURL" -s -w $'\n%{http_code}' \
        "http://127.0.0.1:${port}/api/pendingReports/${sid}" 2>/dev/null); then
    # daemon down — best-effort skip + log, fall through (reconciler posture).
    printf '%s %s\n' "$(now_iso)" "PENDING_POLL_SKIP sid=$sid curl_failed" >> "$DISCONNECTED_LOG"
    return 1
  fi
  http="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  [ "$http" = "200" ] || return 1            # 404 cleared/dead → #517 git path
  local idle; idle=$(json_get "$body" idle_notified)
  case "$idle" in True|true) ;; *) return 1;; esac   # idle_notified:false → NOOP
  local inject_id; inject_id=$(json_get "$body" inject_id)
  # Idempotency: one AUTO_HOLD per (dispatch, idle). New key form
  # `sid<TAB>IDLE<TAB>inject_id` (whole-line grep -qxF; never collides with the
  # AUTO_REPORT `sid<TAB>head_sha` form — shas are hex, never the literal IDLE).
  # A re-dispatch gets a new inject_id, so a genuinely new idle re-surfaces.
  if grep -qxF "$(printf '%s\tIDLE\t%s' "$sid" "$inject_id")" "$AUTO_REPORTS_SEEN" 2>/dev/null; then
    return 1
  fi
  local auto_summary idle_at idle_secs spec_path files added removed now
  auto_summary=$(json_get "$body" auto_summary)   # already daemon-redacted
  idle_at=$(json_get "$body" idle_at)
  now=$(now_iso)
  idle_secs=$(_idle_secs "$idle_at" "$now")
  spec_path=$(_spec_since "$cwd" "$dispatched_at")
  read -r files added removed < <(_git_shortstat "$cwd" "$dispatched_at")
  # auto-reports.log (JSON) — source of truth.
  SID="$sid" NOW="$now" IDLE="$idle_secs" SUMMARY="$auto_summary" SPEC="$spec_path" \
    FILES="$files" ADDED="$added" REMOVED="$removed" \
    python3 - >> "$AUTO_REPORTS_LOG" <<'PY'
import json,os
print(json.dumps({"kind":"AUTO_HOLD","sid":os.environ["SID"],
                  "emitted_at":os.environ["NOW"],
                  "idle_for_secs":int(os.environ.get("IDLE","0") or 0),
                  "summary":os.environ.get("SUMMARY",""),
                  "spec_path":os.environ.get("SPEC",""),
                  "files_changed":int(os.environ.get("FILES","0") or 0),
                  "loc_added":int(os.environ.get("ADDED","0") or 0),
                  "loc_removed":int(os.environ.get("REMOVED","0") or 0),
                  "review_required":True}, ensure_ascii=False))
PY
  printf '%s\tIDLE\t%s\n' "$sid" "$inject_id" >> "$AUTO_REPORTS_SEEN"
  emit_alert "AUTO_HOLD sid=$sid idle=${idle_secs}s spec=${spec_path:-none} — review/respond required"
  if command -v "$TELEPTY" >/dev/null 2>&1; then
    "$TELEPTY" inject --from "$TRACKER_SID" "$ORCH_SID" \
      "AUTO_HOLD sid=$sid idle=${idle_secs}s spec=${spec_path:-none} — review/respond required" \
      >/dev/null 2>&1 || true
  fi
  # Belt-and-suspenders: free daemon memory (fires a harmless TASK_DISMISSED we
  # ignore). The seen-ledger is the primary idempotency guard, not this DELETE.
  "$CURL" -s -o /dev/null -X DELETE \
    "http://127.0.0.1:${port}/api/pendingReports/${sid}" 2>/dev/null || true
  return 0
}

# _idle_secs <idle_at_iso|null|""> <now_iso> — whole seconds since idle_at (0 if absent).
_idle_secs() {
  IDLE_AT="$1" NOW="$2" python3 - <<'PY'
import os,datetime
def p(s):
    try: return datetime.datetime.fromisoformat((s or "").replace("Z","+00:00"))
    except Exception: return None
a=p(os.environ.get("IDLE_AT","")); n=p(os.environ.get("NOW",""))
print(max(0,int((n-a).total_seconds())) if a and n else 0)
PY
}

# _spec_since <cwd> <dispatched_at> — first docs/specs/*.md written since dispatch
# (SPEC FIRST evidence for an architect that wrote a spec but did not commit).
# Best-effort: empty when cwd has no docs/specs or nothing is newer.
_spec_since() {
  local cwd="$1" since="$2"
  [ -n "$cwd" ] && [ -d "$cwd/docs/specs" ] || { printf ''; return 0; }
  CWD="$cwd" SINCE="$since" python3 - <<'PY'
import os,glob,datetime
cwd=os.environ["CWD"]; since=os.environ.get("SINCE","")
try: sdt=datetime.datetime.fromisoformat(since.replace("Z","+00:00")).timestamp()
except Exception: sdt=0
hits=[]
for p in glob.glob(os.path.join(cwd,"docs","specs","*.md")):
    try:
        if os.path.getmtime(p) >= sdt: hits.append(os.path.relpath(p,cwd))
    except OSError: pass
hits.sort()
print(hits[0] if hits else "")
PY
}

cmd_status() {
  local sid="${1:-}"
  python3 - "$ACTIVE_JSON" "$sid" <<'PY'
import json,sys
path,sid=sys.argv[1],sys.argv[2]
try: entries=json.load(open(path))
except Exception: entries=[]
rows=entries if not sid else [e for e in entries if e.get("sid")==sid]
for e in rows:
    print(f"{e.get('sid','?'):40s} {e.get('status','?'):16s} exp={e.get('expected_report_by','?')} rdc={e.get('re_dispatch_count',0)}")
PY
}

cmd_prune() {
  _mutate_state "
keep = []
now = datetime.datetime.now(datetime.timezone.utc)
for e in entries:
    st = e.get('status', '')
    if st in ('reported','auto_reported','stuck_error','delivery_failed','disconnected'):
        try:
            ls = datetime.datetime.fromisoformat(e.get('last_seen_at','').replace('Z','+00:00'))
            if (now - ls).total_seconds() > 86400: continue
        except Exception: pass
    keep.append(e)
entries[:] = keep
"
}

main() {
  [ $# -eq 0 ] && { usage; exit 4; }
  local cmd="$1"; shift
  case "$cmd" in
    append)         cmd_append "$@";;
    register)       cmd_register "$@";;
    check)          cmd_check "$@";;
    mark-reported)  cmd_mark_reported "$@";;
    status)         cmd_status "$@";;
    prune)          cmd_prune "$@";;
    -h|--help)      usage;;
    *) echo "unknown: $cmd" >&2; usage >&2; exit 4;;
  esac
}

main "$@"
