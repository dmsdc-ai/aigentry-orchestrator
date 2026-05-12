#!/usr/bin/env bash
# T2 — STUCK_ERROR classification + alert + no auto-retry.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z"
cp "$HERE/fixtures/error.txt" "$STUB_SCREEN_FILE"

t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "STUCK_ERROR sid=sid-A"
t_assert_status sid-A stuck_error
if grep -q "dispatch.sh" "$STUB_DISPATCH_LOG"; then
  echo "FAIL: error class should never trigger re-dispatch" >&2; exit 1
fi
echo "T2 PASS"
