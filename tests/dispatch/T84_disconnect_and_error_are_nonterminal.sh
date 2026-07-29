#!/usr/bin/env bash
# T84 — telepty#60 Stage A §8.5.9: a disconnect sets connectivity and an error
# surface sets an error observation. Neither is a task outcome — a session that
# went away or printed an error has told us nothing about whether the assigned
# work finished — so both keep outcome unknown / reported_value null and both keep
# the dispatch pollable.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

# --- (a) DISCONNECTED health --------------------------------------------------
t_init_v2
t_seed_dispatch sid-A expected_report_by="2026-05-12T11:30:00Z"
printf '%s' '[{"id":"sid-A","command":"claude","healthStatus":"DISCONNECTED"}]' > "$STUB_LIST_FILE"

TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null

t_assert_lifecycle sid-A disconnected
t_assert_observation sid-A session_disconnected_observed
t_assert_outcome_unknown sid-A

# --- (b) error surface --------------------------------------------------------
t_init_v2
t_seed_dispatch sid-B expected_report_by="2026-05-12T11:30:00Z"
printf '%s' '[{"id":"sid-B","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
cp "$HERE/fixtures/error.txt" "$STUB_SCREEN_FILE"

TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null

t_assert_lifecycle sid-B stuck_error
t_assert_observation sid-B error_surface_observed
t_assert_outcome_unknown sid-B
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "STUCK_ERROR sid=sid-B"

# neither path may mark anything terminal.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
for rec in doc["dispatches"]:
    for obs in rec["observations"]:
        assert obs.get("terminal") is False, f"FAIL: terminal observation {obs['kind']!r}"
PY

echo "T84 PASS"
