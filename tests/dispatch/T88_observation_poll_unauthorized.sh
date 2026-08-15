#!/usr/bin/env bash
# T88 — a daemon that REFUSES the poll is not a daemon that lacks the endpoint.
#
# The per-inject observation poll used to be token-less, and it worked only because the telepty
# daemon trusted loopback before checking any credential. telepty#820/#823 removes that trust, so
# every poll would start getting 401 — and the tracker folded any non-200 into
# `observation_endpoint_absent`. The result would have been a tracker reporting "the observation
# endpoint is absent" while the endpoint was present and merely refusing an unauthenticated
# caller: evidence-blind, with a plausible-looking reason in the log that nobody would re-read.
#
# That is exactly the class of defect telepty#60 exists to remove — a name claiming more than its
# measurement — so it gets a distinct reason and a test.
#
# Asserts:
#   1. the poll sends `x-telepty-token`;
#   2. a 401 maps to `observation_poll_unauthorized`, NOT `observation_endpoint_absent`;
#   3. the outcome is still nobody's to assert (unknown), and the dispatch keeps being polled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

CURL_LOG="$T_TMP/curl.log"
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
# What a credential-checking daemon answers an unauthenticated caller: a refusal, with no body of
# the schema-v2 shape at all.
printf '%s' '{"success":false,"code":"UNAUTHORIZED","error":"missing or invalid token"}'
printf '\n401'
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl" CURL_LOG

t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-401 \
  expected_report_by="2026-05-12T11:30:00Z"

t_run_tracker check >/dev/null

# (1) The poll presents the daemon token. Without this the fix is cosmetic.
if ! grep -q 'x-telepty-token' "$CURL_LOG"; then
  echo "FAIL: the observation poll did not send x-telepty-token" >&2
  echo "--- curl invocations ---" >&2; cat "$CURL_LOG" >&2
  exit 1
fi

# (2) The refusal is named as a refusal.
t_assert_observation sid-A tracking_unavailable
if ! grep -q 'observation_poll_unauthorized' "$DISPATCH_STATE_DIR/observations.log"; then
  echo "FAIL: a 401 was not recorded as observation_poll_unauthorized" >&2
  grep -o '"reason": "[^"]*"' "$DISPATCH_STATE_DIR/observations.log" >&2 || true
  exit 1
fi
if grep -q 'observation_endpoint_absent' "$DISPATCH_STATE_DIR/observations.log"; then
  echo "FAIL: a 401 was folded into observation_endpoint_absent — the endpoint is present, it refused us" >&2
  exit 1
fi

# (3) Still unknown, still polled, still surfaced to a human once.
t_assert_outcome_unknown sid-A
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'HOLD sid=sid-A'
printf 'sid-A\tHOLD\tdisp-sid-A\tobservation_poll_unauthorized\n' > "$T_TMP/want-seen.txt"
t_assert_contains "$DISPATCH_STATE_DIR/observations.seen" "$(cat "$T_TMP/want-seen.txt")"

echo "PASS T88"
