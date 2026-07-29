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
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rec = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"][0]
obs = [o for o in rec["observations"] if o["kind"] == "welcome_surface_observed"][0]
assert obs.get("basis") == "screen_surface_classification", f"FAIL: basis={obs.get('basis')!r}"
assert obs.get("actuation") == "redispatch_attempted", f"FAIL: actuation={obs.get('actuation')!r}"
PY
# Lifecycle moves stuck_welcome → re_dispatched when the cap is not yet hit.
got=$(t_v2 sid-A lifecycle.state)
case "$got" in stuck_welcome|re_dispatched) ;; *)
  echo "FAIL: lifecycle=$got, want stuck_welcome or re_dispatched" >&2; exit 1;; esac
t_assert_outcome_unknown sid-A
echo "T1 PASS"
