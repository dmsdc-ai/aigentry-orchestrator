#!/usr/bin/env bash
# T37 — a VALID schema-v2 observation is recorded as itself and raises no HOLD:
# there is nothing absent to report. The worker is visibly working, so the
# existing `active` branch still bumps the deadline and touches nothing else.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_stub_v2_observations output_observed

cp "$HERE/fixtures/active.txt" "$STUB_SCREEN_FILE"
t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-222 \
  expected_report_by="2026-05-12T11:30:00Z"

t_run_tracker check >/dev/null

# The daemon's observation is recorded verbatim; no absence, so no HOLD.
t_assert_observation sid-A output_observed
t_refute_observation sid-A tracking_unavailable
if grep -qF 'HOLD' "$DISPATCH_STATE_DIR/observations.log" 2>/dev/null \
   || grep -qF 'HOLD' "$DISPATCH_STATE_DIR/alerts.log" 2>/dev/null; then
  echo "FAIL: a valid observation must not raise a HOLD" >&2; exit 1
fi
# The `active` branch still runs; the outcome is still nobody's to assert.
t_assert_lifecycle sid-A delivery_attempt_started
t_assert_outcome_unknown sid-A
got=$(t_v2 sid-A expected_report_by)
if [ "$got" != "2026-05-12T12:15:00Z" ]; then
  echo "FAIL: expected_report_by = $got, want 2026-05-12T12:15:00Z (active bump)" >&2; exit 1
fi

echo "T37 PASS"
