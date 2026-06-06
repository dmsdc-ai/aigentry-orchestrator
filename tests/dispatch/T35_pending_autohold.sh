#!/usr/bin/env bash
# T35 — #528 bus-event consumer: an alive worker that went idle after our inject
# (its REPORT/HOLD push never landed — the "Enter 안눌림" bug) is surfaced as an
# AUTO_HOLD by polling telepty GET /api/pendingReports/:sid. The FILE LOGS are the
# source of truth (the inject channel is the one that fails). Idempotent per
# (sid, IDLE, inject_id): a 2nd tick on the same inject_id adds no duplicate.
# Hermetic — NO live daemon: a `curl` shim returns a canned pendingReports body.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

# --- curl shim: stubs telepty GET/DELETE /api/pendingReports/:id (no live daemon) ---
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
# Env-driven stub for the pendingReports poll:
#   STUB_CURL_FAIL=1   -> exit nonzero (daemon down)
#   STUB_PENDING_FILE  -> body for GET /api/pendingReports/:id
#   STUB_PENDING_HTTP  -> http code (default 200)
# GET form    : curl -s -w '\n%{http_code}' <url>      -> body + "\n" + code
# DELETE form : curl -s -o /dev/null -X DELETE <url>   -> (no body)
[ "${STUB_CURL_FAIL:-0}" = "1" ] && exit 7
for a in "$@"; do [ "$a" = "DELETE" ] && exit 0; done
cat "${STUB_PENDING_FILE:-/dev/null}"
printf '\n%s' "${STUB_PENDING_HTTP:-200}"
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl"

# pendingReports body: alive worker idle_notified, no commit (architect SPEC FIRST).
PEND="$T_TMP/pending.json"
printf '%s' '{"session_id":"sid-A","source":"orchestrator","inject_id":"uuid-111","injected_at":"2026-05-12T11:00:00Z","idle_notified":true,"idle_at":"2026-05-12T11:45:00Z","awaiting_report":true,"submit_expected":false,"auto_summary":"spec written; HOLD attempted but Enter 안눌림"}' > "$PEND"
export STUB_PENDING_FILE="$PEND"

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"

t_run_tracker check >/dev/null

# (1) AUTO_HOLD surfaced to BOTH file logs (the source of truth) + inject attempted.
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"kind": "AUTO_HOLD"'
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"sid": "sid-A"'
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"idle_for_secs": 900'
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" 'Enter 안눌림'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'AUTO_HOLD sid=sid-A'
# seen-ledger: new key form sid<TAB>IDLE<TAB>inject_id (whole-line).
printf 'sid-A\tIDLE\tuuid-111\n' > "$T_TMP/want-seen.txt"
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.seen" "$(cat "$T_TMP/want-seen.txt")"
# best-effort inject attempted (logged by telepty stub).
t_assert_contains "$STUB_DISPATCH_LOG" 'AUTO_HOLD sid=sid-A'

first=$(wc -l < "$DISPATCH_STATE_DIR/auto-reports.log")

# (2) 2nd tick, SAME inject_id -> idempotent, NO duplicate AUTO_HOLD.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for e in d:
    if e["sid"]=="sid-A":
        e["expected_report_by"]="2026-05-12T11:30:00Z"
        e["status"]="in_flight"
json.dump(d,open(p,"w"))
PY
t_run_tracker check >/dev/null
second=$(wc -l < "$DISPATCH_STATE_DIR/auto-reports.log")
if [ "$first" != "$second" ]; then
  echo "FAIL: AUTO_HOLD not idempotent (was $first, now $second)" >&2; exit 1
fi

echo "T35 PASS"
