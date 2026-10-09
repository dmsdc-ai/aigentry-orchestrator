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
#   1. the poll sends `x-telepty-token` — on curl's stdin (`-H @-`), never in its argv (#1214);
#   2. a 401 maps to `observation_poll_unauthorized`, NOT `observation_endpoint_absent`;
#   3. the outcome is still nobody's to assert (unknown), and the dispatch keeps being polled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

CURL_LOG="$T_TMP/curl.log"
CURL_STDIN_LOG="$T_TMP/curl-stdin.log"
# #1214: a private HOME with a KNOWN token, so the value on the wire is asserted — and the
# operator's real credential is never read.
mkdir -p "$T_TMP/home/.telepty"
printf '%s' '{"authToken":"tok-T88-445566"}' > "$T_TMP/home/.telepty/config.json"
export HOME="$T_TMP/home"
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
# Like real curl, stdin is read only when told to (`-H @-`) — the credential's channel.
for a in "$@"; do [ "$a" = "@-" ] && { cat >> "$CURL_STDIN_LOG"; break; }; done
# What a credential-checking daemon answers an unauthenticated caller: a refusal, with no body of
# the schema-v2 shape at all.
printf '%s' '{"success":false,"code":"UNAUTHORIZED","error":"missing or invalid token"}'
printf '\n401'
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl" CURL_LOG CURL_STDIN_LOG

t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-401 \
  expected_report_by="2026-05-12T11:30:00Z"

t_run_tracker check >/dev/null

# (1) The poll presents the daemon token. Without this the fix is cosmetic. #1214: on
# curl's stdin, never in its argv, where any same-uid process can read it.
if ! grep -qx 'x-telepty-token: tok-T88-445566' "$CURL_STDIN_LOG" 2>/dev/null; then
  echo "FAIL: the observation poll did not send x-telepty-token on curl's stdin (-H @-)" >&2
  echo "--- curl invocations ---" >&2; cat "$CURL_LOG" >&2
  exit 1
fi
if grep -qiE 'x-telepty-token|tok-T88-445566' "$CURL_LOG"; then
  echo "FAIL: the observation poll put the credential into curl's argv (#1214)" >&2
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
