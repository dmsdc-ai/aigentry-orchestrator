#!/usr/bin/env bash
# T9 — re-dispatch cap=1; a second STUCK_WELCOME trips REDISPATCH_CAP and makes
# no further dispatch call.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/welcome.txt" "$STUB_SCREEN_FILE"
# no git commits — the re-dispatch path qualifies (no new authored commit)
printf '' > "$STUB_GIT_LOG_FILE"

t_seed_dispatch sid-A cwd="$T_TMP/no-git" expected_report_by="2026-05-12T11:30:00Z"

# First check → re_dispatched, count=1 (the stub dispatch.sh exits 0, which is
# the ONLY code that may advance the counter).
TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null
t_assert_lifecycle sid-A re_dispatched
got=$(t_v2 sid-A re_dispatch_count)
if [ "$got" != "1" ]; then echo "FAIL: re_dispatch_count=$got, want 1" >&2; exit 1; fi
t_assert_outcome_unknown sid-A
first_count=$(grep -c "^dispatch.sh" "$STUB_DISPATCH_LOG" || true)

# Re-arm the deadline so the check loop revisits it; same fixture (still welcome).
t_registry set-lifecycle --sid sid-A --expected-report-by "2026-05-12T11:30:00Z" >/dev/null

TRACKER_NOW="2026-05-12T13:00:00Z" t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "REDISPATCH_CAP sid=sid-A"
final_count=$(grep -c "^dispatch.sh" "$STUB_DISPATCH_LOG" || true)
if [ "$final_count" != "$first_count" ]; then
  echo "FAIL: cap=1 violated. before=$first_count after=$final_count" >&2; exit 1
fi
echo "T9 PASS"
