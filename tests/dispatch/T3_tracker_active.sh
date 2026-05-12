#!/usr/bin/env bash
# T3 — active class bumps expected_report_by by 15m; status untouched.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z"
cp "$HERE/fixtures/active.txt" "$STUB_SCREEN_FILE"

t_run_tracker check >/dev/null
t_assert_status sid-A in_flight
got=$(t_field sid-A expected_report_by)
if [ "$got" != "2026-05-12T11:45:00Z" ]; then
  echo "FAIL: expected_report_by = $got, want 2026-05-12T11:45:00Z" >&2; exit 1
fi
echo "T3 PASS"
