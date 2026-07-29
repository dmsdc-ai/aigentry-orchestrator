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
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rec = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"][0]
obs = [o for o in rec["observations"] if o["kind"] == "session_disconnected_observed"][0]
assert obs.get("basis") == "telepty_list_health", f"FAIL: basis={obs.get('basis')!r}"
assert obs.get("actuation") == "lifecycle_disconnected", f"FAIL: actuation={obs.get('actuation')!r}"
PY

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

# neither path may mark anything terminal, and each surviving operational
# actuation must carry its BASIS — what was inferred, from what, and whether the
# observation ledger was even answering at the time. An inference that is written
# down is a known limitation; an undocumented one is the defect being removed.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
for rec in doc["dispatches"]:
    for obs in rec["observations"]:
        assert obs.get("terminal") is False, f"FAIL: terminal observation {obs['kind']!r}"
recs = {r["assigned"]["sid"]: r for r in doc["dispatches"]}
err = [o for o in recs["sid-B"]["observations"] if o["kind"] == "error_surface_observed"][0]
assert err.get("basis") == "screen_surface_classification", f"FAIL: error basis={err.get('basis')!r}"
assert err.get("actuation") == "lifecycle_stuck_error", f"FAIL: error actuation={err.get('actuation')!r}"
assert err.get("observation_ledger") in ("available", "unavailable"), \
    f"FAIL: error observation_ledger={err.get('observation_ledger')!r}"
PY

echo "T84 PASS"
