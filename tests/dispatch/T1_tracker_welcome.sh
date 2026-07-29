#!/usr/bin/env bash
# T1 — STUCK_WELCOME classification + alert + LIFECYCLE transition. telepty#60
# Stage A: a welcome screen is a lifecycle fact, never an outcome.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_seed_dispatch sid-A expected_report_by="2026-05-12T11:30:00Z"
cp "$HERE/fixtures/welcome.txt" "$STUB_SCREEN_FILE"

t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "STUCK_WELCOME sid=sid-A"
t_assert_observation sid-A welcome_surface_observed
# Lifecycle moves stuck_welcome → re_dispatched when the cap is not yet hit.
got=$(t_v2 sid-A lifecycle.state)
case "$got" in stuck_welcome|re_dispatched) ;; *)
  echo "FAIL: lifecycle=$got, want stuck_welcome or re_dispatched" >&2; exit 1;; esac
t_assert_outcome_unknown sid-A
echo "T1 PASS"
