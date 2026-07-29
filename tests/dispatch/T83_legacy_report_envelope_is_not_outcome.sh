#!/usr/bin/env bash
# T83 — telepty#60 Stage A §3-item-6 / §8.5.11: 0.8.0 has no outcome protocol, so a
# syntactically valid legacy REPORT envelope is an ordinary message. It cannot call
# a terminal tracker operation and cannot move either outcome field.
#
# D1 (approved with condition): the Layer-D cleanup arm SURVIVES as a lifecycle
# action, because removing it would silently end automatic worker retirement for
# the whole fleet. It is an inference, so it is written down with its basis —
# cleanup_scheduled_from_legacy_report_envelope — for whoever replaces this path
# when #816/#817 land.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2
t_seed_dispatch sid-A

SCHED_LOG="$T_TMP/scheduler.log"; : > "$SCHED_LOG"
SCHED_STUB="$T_TMP/scheduler-stub.sh"
cat > "$SCHED_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SCHED_LOG"
exit 0
EOF
chmod +x "$SCHED_STUB"

ENVELOPE="$T_TMP/report.md"
cat > "$ENVELOPE" <<'EOF'
REPORT: sid-A-DONE | files=bin/dispatch.sh | build=green
EOF

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$T_TMP/noop"; chmod +x "$T_TMP/noop"
out=$(SCHEDULER_SH="$SCHED_STUB" EMIT_TELEMETRY_MJS="$T_TMP/noop" \
  "$REPO_ROOT/bin/inject-handler.sh" --sid sid-A --body-file "$ENVELOPE" 2>&1)

# (1) no outcome authority — the whole point.
t_assert_outcome_unknown sid-A
t_assert_observation sid-A legacy_report_envelope_observed
case "$out" in *outcome_protocol_unavailable*) ;;
  *) echo "FAIL: handler did not name the missing outcome protocol: $out" >&2; exit 1;; esac
case "$out" in *"reported"*) echo "FAIL: handler claimed the task was reported: $out" >&2; exit 1;; esac

# (2) D1 condition — the surviving lifecycle inference is recorded WITH its basis.
grep -q "^schedule sid-A" "$SCHED_LOG" || {
  echo "FAIL: Layer-D cleanup arm was dropped (D1 said keep it)" >&2; cat "$SCHED_LOG" >&2; exit 1; }
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rec = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"][0]
obs = [o for o in rec["observations"]
       if o["kind"] == "cleanup_scheduled_from_legacy_report_envelope"]
assert obs, ("FAIL: the surviving lifecycle inference is invisible; observations="
             f"{[o['kind'] for o in rec['observations']]}")
assert obs[0].get("basis") == "legacy_report_envelope", f"FAIL: basis={obs[0].get('basis')!r}"
assert obs[0].get("terminal") is False, "FAIL: marked terminal"
assert rec["outcome"]["state"] == "unknown" and rec["outcome"]["reported_value"] is None
PY

echo "T83 PASS"
