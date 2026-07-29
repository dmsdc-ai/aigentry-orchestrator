#!/usr/bin/env bash
# T74 — telepty#60 Stage A §B2 / §8.3.16 + carry-in corrections 2 and 3.
# Both automatic re-dispatch callers must branch on the exit code:
#   exit 0 → advance re_dispatch_count, lifecycle and deadline
#   exit 8 → suppressed duplicate: advance NOTHING, and open the human gate
#            (freezing the counter otherwise makes the one-shot operator gate
#             unreachable, so a stuck dispatch would only ever repeat a HOLD)
#   exit 7 → held/delivery-unknown: advance nothing
# The counter is asserted before AND after, because the exit code alone is what
# the old callers were already getting right by accident.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export HITL_STATE_DIR="$T_TMP/hitl"
ref="$T_TMP/ref.md"; printf 'redispatch ref\n' > "$ref"

# dispatch.sh stub with a settable exit code.
cat > "$STUB_BIN/dispatch.sh" <<'SH'
#!/usr/bin/env bash
printf 'dispatch.sh %s\n' "$*" >> "${STUB_DISPATCH_LOG:-/dev/null}"
exit "${STUB_DISPATCH_EXIT:-0}"
SH
chmod +x "$STUB_BIN/dispatch.sh"

NOOP="$T_TMP/noop.sh"; printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$NOOP"; chmod +x "$NOOP"
PROBE="$T_TMP/probe-rawshell.sh"
cat > "$PROBE" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"alive":true,"ready":false,"surface":"raw_shell","activity":"static","cli":"claude","detail":{}}'
SH
chmod +x "$PROBE"

# --- arm 1: dispatch-tracker.sh (welcome screen + no commits → REDISPATCH) -----
tracker_arm() {
  local code="$1" want_count="$2" want_lifecycle="$3"
  t_init_v2
  : > "$STUB_DISPATCH_LOG"; : > "$DISPATCH_STATE_DIR/alerts.log"
  rm -rf "$HITL_STATE_DIR"
  cp "$HERE/fixtures/welcome.txt" "$STUB_SCREEN_FILE"
  printf '' > "$STUB_GIT_LOG_FILE"
  t_seed_dispatch sid-A ref_path="$ref" cwd="$T_TMP/no-git" \
    expected_report_by="2026-05-12T11:30:00Z"

  local before after
  before=$(t_v2 sid-A re_dispatch_count)
  [ "$before" = "0" ] || { echo "FAIL(tracker/$code): seeded count=$before" >&2; exit 1; }

  STUB_DISPATCH_EXIT="$code" HITL_SH="$REPO_ROOT/bin/hitl.sh" \
    TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null

  after=$(t_v2 sid-A re_dispatch_count)
  [ "$after" = "$want_count" ] || { echo "FAIL(tracker/$code): re_dispatch_count $before→$after, want $want_count" >&2; exit 1; }
  t_assert_lifecycle sid-A "$want_lifecycle"
  t_assert_outcome_unknown sid-A
  grep -q "^dispatch.sh " "$STUB_DISPATCH_LOG" || { echo "FAIL(tracker/$code): dispatch.sh was never invoked" >&2; exit 1; }
}

# stuck_welcome is a LIFECYCLE fact the screen really did produce; what must not
# move is the attempt counter, the deadline and the outcome.
tracker_arm 8 0 stuck_welcome
t_assert_observation sid-A redispatch_suppressed_duplicate
t_assert_v2 sid-A expected_report_by "2026-05-12T11:30:00Z"
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "REDISPATCH_SUPPRESSED sid=sid-A"
# carry-in correction 2: exit 8 must reach the one-shot operator gate.
ls "$HITL_STATE_DIR/pending/"*.json >/dev/null 2>&1 || {
  echo "FAIL(tracker/8): no HITL gate opened — human escalation path is closed" >&2; exit 1; }
# carry-in correction 3: the alert reports the outcome, not the intent.
if grep -q "REDISPATCH sid=sid-A attempt=1" "$DISPATCH_STATE_DIR/alerts.log"; then
  echo "FAIL(tracker/8): pre-call REDISPATCH intent alert still emitted" >&2; exit 1
fi

tracker_arm 7 0 stuck_welcome
t_assert_observation sid-A redispatch_held_delivery_unknown
t_assert_v2 sid-A expected_report_by "2026-05-12T11:30:00Z"
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "REDISPATCH_HELD sid=sid-A"

tracker_arm 0 1 re_dispatched
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "REDISPATCH_OK sid=sid-A"
newdl=$(t_v2 sid-A expected_report_by)
[ "$newdl" != "2026-05-12T11:30:00Z" ] || { echo "FAIL(tracker/0): deadline not extended" >&2; exit 1; }

# --- arm 2: session-reconciler.sh (surface=raw_shell → REDISPATCH) -------------
reconciler_arm() {
  local code="$1" want_count="$2" want_lifecycle="$3"
  t_init_v2
  : > "$STUB_DISPATCH_LOG"; : > "$DISPATCH_STATE_DIR/alerts.log"
  rm -rf "$HITL_STATE_DIR"
  t_seed_dispatch sid-A ref_path="$ref"

  STUB_DISPATCH_EXIT="$code" \
  DISPATCH_SH="$STUB_BIN/dispatch.sh" SESSION_PROBE_PY="$PROBE" \
  TELEPTY="$STUB_BIN/telepty" CLEANUP_SH="$NOOP" SCHEDULER_SH="$NOOP" \
  TRACKER_SH="$NOOP" COMMS_AUDITOR_SH="$NOOP" BRIDGE_AUDITOR_SH="$NOOP" \
  RECONCILER_NOW="2026-05-12T12:00:00Z" \
    "$REPO_ROOT/bin/session-reconciler.sh" --once >/dev/null 2>&1

  local after; after=$(t_v2 sid-A re_dispatch_count)
  [ "$after" = "$want_count" ] || { echo "FAIL(reconciler/$code): re_dispatch_count=$after, want $want_count" >&2; exit 1; }
  t_assert_lifecycle sid-A "$want_lifecycle"
  t_assert_outcome_unknown sid-A
  grep -q "^dispatch.sh " "$STUB_DISPATCH_LOG" || { echo "FAIL(reconciler/$code): dispatch.sh was never invoked" >&2; exit 1; }
}

reconciler_arm 8 0 delivery_attempt_started
t_assert_observation sid-A redispatch_suppressed_duplicate
ls "$HITL_STATE_DIR/pending/"*.json >/dev/null 2>&1 || {
  echo "FAIL(reconciler/8): no HITL gate opened" >&2; exit 1; }

reconciler_arm 7 0 delivery_attempt_started
t_assert_observation sid-A redispatch_held_delivery_unknown

reconciler_arm 0 1 re_dispatched

echo "T74 PASS"
