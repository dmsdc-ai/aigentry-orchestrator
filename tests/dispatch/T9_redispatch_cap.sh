#!/usr/bin/env bash
# T9 — re-dispatch cap=1; second STUCK_WELCOME triggers REDISPATCH_CAP, no further dispatch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/welcome.txt" "$STUB_SCREEN_FILE"
# no git commits — re-dispatch path qualifies (no new authored commit)
printf '' > "$STUB_GIT_LOG_FILE"

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP/no-git"

# First check → re_dispatched, count=1
TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null
t_assert_status sid-A re_dispatched
got=$(t_field sid-A re_dispatch_count)
if [ "$got" != "1" ]; then echo "FAIL: re_dispatch_count=$got, want 1" >&2; exit 1; fi
first_count=$(grep -c "^dispatch.sh" "$STUB_DISPATCH_LOG" || true)

# Force expected_report_by < now to retry; same fixture (still welcome)
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for e in d:
    if e["sid"]=="sid-A":
        e["expected_report_by"]="2026-05-12T11:30:00Z"
        e["status"]="re_dispatched"
json.dump(d,open(p,"w"))
PY

TRACKER_NOW="2026-05-12T13:00:00Z" t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "REDISPATCH_CAP sid=sid-A"
final_count=$(grep -c "^dispatch.sh" "$STUB_DISPATCH_LOG" || true)
if [ "$final_count" != "$first_count" ]; then
  echo "FAIL: cap=1 violated. before=$first_count after=$final_count" >&2; exit 1
fi
echo "T9 PASS"
