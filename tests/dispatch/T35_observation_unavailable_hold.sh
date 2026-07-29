#!/usr/bin/env bash
# T35 — a dispatch the daemon cannot answer for is surfaced as a HOLD to the FILE
# LOGS (the inject channel is the one that fails), and the HOLD is idempotent per
# (dispatch, reason): a second tick on the same absence adds no duplicate.
#
# telepty#60 Stage A replaced the AUTO_HOLD-and-DELETE shape: the daemon's record
# is not the orchestrator's to discard, and suppression of a repeat notification
# must never suppress the polling itself.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

CURL_LOG="$T_TMP/curl.log"
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
cat /dev/null
printf '\n404'
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl" CURL_LOG

t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-111 \
  expected_report_by="2026-05-12T11:30:00Z"

t_run_tracker check >/dev/null

# (1) HOLD surfaced to both file logs, and to the orchestrator inject.
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"kind": "HOLD"'
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"sid": "sid-A"'
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"completion_fact": null'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'HOLD sid=sid-A'
t_assert_contains "$STUB_DISPATCH_LOG" 'HOLD sid=sid-A'
t_assert_observation sid-A tracking_unavailable
t_assert_outcome_unknown sid-A
printf 'sid-A\tHOLD\tdisp-sid-A\tobservation_endpoint_absent\n' > "$T_TMP/want-seen.txt"
t_assert_contains "$DISPATCH_STATE_DIR/observations.seen" "$(cat "$T_TMP/want-seen.txt")"

first=$(wc -l < "$DISPATCH_STATE_DIR/observations.log")
polls=$(wc -l < "$CURL_LOG")

# (2) 2nd tick, same absence → no duplicate HOLD, but polling CONTINUES.
t_registry set-lifecycle --sid sid-A --expected-report-by "2026-05-12T11:30:00Z" >/dev/null
TRACKER_NOW="2026-05-12T13:00:00Z" t_run_tracker check >/dev/null
second=$(wc -l < "$DISPATCH_STATE_DIR/observations.log")
polls2=$(wc -l < "$CURL_LOG")
if [ "$first" != "$second" ]; then
  echo "FAIL: HOLD not idempotent (was $first, now $second)" >&2; exit 1
fi
if [ "$polls2" -le "$polls" ]; then
  echo "FAIL: suppressing the repeat HOLD also stopped the polling" >&2; exit 1
fi
if grep -q DELETE "$CURL_LOG"; then
  echo "FAIL: tracker deleted the daemon's record" >&2; exit 1
fi

echo "T35 PASS"
