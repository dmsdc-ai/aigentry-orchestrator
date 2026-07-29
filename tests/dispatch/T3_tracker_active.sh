#!/usr/bin/env bash
# T3 — active class bumps expected_report_by by 15m; lifecycle and outcome untouched.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_seed_dispatch sid-A expected_report_by="2026-05-12T11:30:00Z"
cp "$HERE/fixtures/active.txt" "$STUB_SCREEN_FILE"

t_run_tracker check >/dev/null
t_assert_lifecycle sid-A delivery_attempt_started
t_assert_outcome_unknown sid-A
t_assert_observation sid-A screen_class_observed
got=$(t_v2 sid-A expected_report_by)
if [ "$got" != "2026-05-12T12:15:00Z" ]; then
  echo "FAIL: expected_report_by = $got, want 2026-05-12T12:15:00Z" >&2; exit 1
fi
echo "T3 PASS"
