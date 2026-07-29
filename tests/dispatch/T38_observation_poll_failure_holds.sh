#!/usr/bin/env bash
# T38 — a dead daemon (curl failure) is absence, not permission. The poll failure
# is logged, a HOLD is surfaced, the tick completes cleanly, and nothing settles.
# The old behaviour treated it as best-effort and fell through to the inference
# chain, which is how a down daemon could produce a "completed" dispatch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl"

cp "$HERE/fixtures/active.txt" "$STUB_SCREEN_FILE"
t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-333 \
  expected_report_by="2026-05-12T11:30:00Z"

out=$(t_run_tracker check)        # must NOT crash the tick

t_assert_contains "$DISPATCH_STATE_DIR/disconnected.log" 'OBSERVATION_POLL_SKIP sid=sid-A'
t_assert_observation sid-A tracking_unavailable
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'HOLD sid=sid-A'
case "$out" in
  *"tracker check: 1 entries processed"*) ;;
  *) echo "FAIL: tick did not complete cleanly: $out" >&2; exit 1;;
esac
t_assert_outcome_unknown sid-A
t_assert_lifecycle sid-A delivery_attempt_started

echo "T38 PASS"
