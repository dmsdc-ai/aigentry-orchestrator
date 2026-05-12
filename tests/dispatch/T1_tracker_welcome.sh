#!/usr/bin/env bash
# T1 — STUCK_WELCOME classification + alert + status transition.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight ""
cp "$HERE/fixtures/welcome.txt" "$STUB_SCREEN_FILE"

t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "STUCK_WELCOME sid=sid-A"
# Status transitions stuck_welcome → re_dispatched when cap not yet hit.
got=$(t_field sid-A status)
case "$got" in stuck_welcome|re_dispatched) ;; *)
  echo "FAIL: status=$got, want stuck_welcome or re_dispatched" >&2; exit 1;; esac
echo "T1 PASS"
