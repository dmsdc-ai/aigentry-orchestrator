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
#
# SUPERSEDED BY #1170 (declared parity deviation): a textual REPORT is observation
# only, never cleanup authority — the port makes NO scheduler call and writes NO
# cleanup_scheduled_from_legacy_report_envelope observation. The D1 history above is
# kept; INJECT_PARITY_ORIGINAL=1 still asserts the original bash's D1 behaviour (as in
# T124 blocks J-M), the default asserts the port's.
set -euo pipefail
ORIGINAL="${INJECT_PARITY_ORIGINAL:-0}"
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

if [ "$ORIGINAL" = "1" ]; then
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
else
# (2) #1170 — no Layer-D cleanup from REPORT text, and no inference recorded for one.
[ ! -s "$SCHED_LOG" ] || {
  echo "FAIL: a textual REPORT reached the scheduler (#1170: observation only)" >&2; cat "$SCHED_LOG" >&2; exit 1; }
case "$out" in *"observation only, no cleanup scheduled"*) ;;
  *) echo "FAIL: handler stdout does not say observation only: $out" >&2; exit 1;; esac
case "$out" in *"scheduler armed"*) echo "FAIL: handler still claims a scheduler was armed: $out" >&2; exit 1;; esac
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rec = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"][0]
kinds = [o["kind"] for o in rec["observations"]]
assert "cleanup_scheduled_from_legacy_report_envelope" not in kinds, f"FAIL: cleanup inference recorded; observations={kinds}"
assert rec["outcome"]["state"] == "unknown" and rec["outcome"]["reported_value"] is None
PY
fi

# (3) #1170 — bounded REPORT shapes beyond (1)/(2), each delivered with --sid sid-A so
# the report arm is reached. No shape is cleanup authority: not a direct (stdin) body,
# not a whole unsubstituted template, not a body whose sid/task/attempt/operation
# disagree with --sid, and not even a fully filled template that agrees with it —
# nothing authenticates either the bytes or the --sid. Under INJECT_PARITY_ORIGINAL=1
# every shape characterizes the pre-#1170 D1 behaviour instead (one Layer-D schedule
# plus one basis observation per REPORT), so the unsafe action is measured, not assumed.
obs_count() {
  python3 - "$DISPATCH_STATE_DIR/active.json" "$1" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rec = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"][0]
print(sum(1 for o in rec["observations"] if o["kind"] == sys.argv[2]))
PY
}

scenario() {
  local name="$1" mode="$2" body="$T_TMP/report-$1.md" legacy0 legacy1 basis0 basis1 sout
  printf '%s\n' "$3" > "$body"
  : > "$SCHED_LOG"
  legacy0=$(obs_count legacy_report_envelope_observed)
  basis0=$(obs_count cleanup_scheduled_from_legacy_report_envelope)
  if [ "$mode" = stdin ]; then
    sout=$(SCHEDULER_SH="$SCHED_STUB" EMIT_TELEMETRY_MJS="$T_TMP/noop" \
      "$REPO_ROOT/bin/inject-handler.sh" --sid sid-A < "$body" 2>&1)
  else
    sout=$(SCHEDULER_SH="$SCHED_STUB" EMIT_TELEMETRY_MJS="$T_TMP/noop" \
      "$REPO_ROOT/bin/inject-handler.sh" --sid sid-A --body-file "$body" 2>&1)
  fi
  legacy1=$(obs_count legacy_report_envelope_observed)
  basis1=$(obs_count cleanup_scheduled_from_legacy_report_envelope)
  [ "$legacy1" = "$((legacy0 + 1))" ] \
    || { echo "FAIL[$name]: expected exactly one new legacy_report_envelope_observed ($legacy0 -> $legacy1): $sout" >&2; exit 1; }
  t_assert_outcome_unknown sid-A
  case "$sout" in *outcome_protocol_unavailable*) ;;
    *) echo "FAIL[$name]: handler did not name the missing outcome protocol: $sout" >&2; exit 1;; esac
  case "$sout" in *"reported"*) echo "FAIL[$name]: handler claimed the task was reported: $sout" >&2; exit 1;; esac
  if [ "$ORIGINAL" = "1" ]; then
    [ "$(cat "$SCHED_LOG")" = "schedule sid-A --grace-seconds 60 --source legacy-report-envelope" ] \
      || { echo "FAIL[$name] original: D1 Layer-D schedule argv differs" >&2; cat "$SCHED_LOG" >&2; exit 1; }
    [ "$basis1" = "$((basis0 + 1))" ] \
      || { echo "FAIL[$name] original: D1 basis observation not recorded ($basis0 -> $basis1)" >&2; exit 1; }
  else
    [ ! -s "$SCHED_LOG" ] \
      || { echo "FAIL[$name]: a textual REPORT reached the scheduler (#1170: observation only)" >&2; cat "$SCHED_LOG" >&2; exit 1; }
    [ "$basis1" = "0" ] \
      || { echo "FAIL[$name]: cleanup_scheduled_from_legacy_report_envelope recorded (count=$basis1)" >&2; exit 1; }
    case "$sout" in *"observation only, no cleanup scheduled"*) ;;
      *) echo "FAIL[$name]: handler stdout does not say observation only: $sout" >&2; exit 1;; esac
    case "$sout" in *"scheduler armed"*) echo "FAIL[$name]: handler still claims a scheduler was armed: $sout" >&2; exit 1;; esac
  fi
}

scenario direct-body stdin \
  'REPORT: sid-A-DONE | files=bin/dispatch.sh | build=green'
scenario full-template file \
  'REPORT: <track>-DONE | task:#<task> | sid:<sid> | attempt:<attempt> | operation:<operation> | file:output/REPORT.md | measured:<measured> | not-measured:<not-measured> | transport:controller-pull pending'
scenario mismatched-identity file \
  'REPORT: sid-B-DONE | task:#9999 | sid:sid-B | attempt:7 | operation:other-op-v9 | file:output/REPORT.md | transport:controller-pull pending'
scenario matched-identity file \
  'REPORT: sid-A-DONE | task:#1170 | sid:sid-A | attempt:1 | operation:sid-A-v1 | file:output/REPORT.md | transport:controller-pull pending'
scenario mismatched-stuck file \
  'REPORT: sid-A-STUCK | task:#1171 | sid:sid-A | attempt:unknown | operation:mismatched-op | file:output/REPORT.md'

echo "T83 PASS original=$ORIGINAL"
