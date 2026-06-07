#!/usr/bin/env bash
# T46 (#533 Phase 1, Scenario S3) — the 3-round cap TRIPS on the 4th round and
# auto-escalates; the channel routes upward instead of silently dropping; the
# thread is resettable (close → counter cleared → fresh round allowed). Also
# covers the --conflict fast-path (immediate deliberation escalation regardless
# of round).
#
# HERMETIC: telepty stubbed; state under $T_TMP. TDD: RED before bin/ask.sh
# implements the cap + escalation.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
ASK="$REPO_ROOT/bin/ask.sh"

fail() { echo "FAIL[T46]: $*" >&2; exit 1; }

export SESSION_COMMS_DIR="$T_TMP/session-comms"
export ASK_NOW="2026-06-07T12:00:00Z"
STATE_FILE="$SESSION_COMMS_DIR/coder-A__coder-B__t2.json"
TELE="$SESSION_COMMS_DIR/telemetry.jsonl"

jf() { python3 - "$1" "$2" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))
PY
}

# ── rounds 1..3: each allowed ──
for r in 1 2 3; do
  "$ASK" --from coder-A --to coder-B --thread t2 --round "$r" request "q$r" >/dev/null 2>&1 \
    || fail "round $r request should be allowed"
done
[ "$(jf "$STATE_FILE" "d['rounds']")" = "3" ] || fail "rounds != 3 after three requests"

# count of ask-request envelopes actually injected to coder-B so far == 3
sends_before=$(grep -c "ask-request" "$STUB_DISPATCH_LOG" 2>/dev/null || echo 0)
[ "$sends_before" -eq 3 ] || fail "expected 3 envelopes injected before cap, got $sends_before"

# ── round 4: REFUSED + escalated to orchestrator ──
set +e
"$ASK" --from coder-A --to coder-B --thread t2 --round 4 request "q4" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "4th round must exit non-zero (refused)"
[ "$(jf "$STATE_FILE" "d['rounds']")" = "3" ] || fail "counter must stay 3 (4th refused, not counted)"
[ "$(jf "$STATE_FILE" "d['escalated']")" = "True" ] || fail "escalated must be True after cap trip"
t_assert_contains "$TELE" "peer_cap_tripped"
t_assert_contains "$TELE" "peer_escalated_orchestrator"

# the 4th envelope was NOT sent to the peer (no new ask-request inject to coder-B)
sends_after=$(grep -c "ask-request" "$STUB_DISPATCH_LOG" 2>/dev/null || echo 0)
[ "$sends_after" -eq 3 ] || fail "4th round must NOT inject to peer (got $sends_after sends)"
# escalation routed upward: a HOLD landed in the orchestrator inbox
t_assert_contains "$STUB_DISPATCH_LOG" "orchestrator"
t_assert_contains "$STUB_DISPATCH_LOG" "HOLD"

# ── reset via explicit close → counter cleared, thread closed ──
"$ASK" --from coder-A --to coder-B --thread t2 close >/dev/null 2>&1 \
  || fail "close should exit zero"
[ "$(jf "$STATE_FILE" "d['status']")" = "closed" ] || fail "status != closed after close"
[ "$(jf "$STATE_FILE" "d['rounds']")" = "0" ] || fail "rounds must reset to 0 after close"
t_assert_contains "$TELE" "peer_thread_closed"

# ── after reset, a fresh round on the same thread is allowed again ──
"$ASK" --from coder-A --to coder-B --thread t2 --round 1 request "fresh" >/dev/null 2>&1 \
  || fail "fresh round after reset should be allowed"
[ "$(jf "$STATE_FILE" "d['rounds']")" = "1" ] || fail "fresh round should set rounds=1"
[ "$(jf "$STATE_FILE" "d['status']")" = "open" ] || fail "thread should reopen on fresh round"

# ── --conflict fast-path: immediate deliberation escalation regardless of round ──
"$ASK" --from coder-A --to coder-B --thread t9 --round 1 --conflict reply "we disagree" >/dev/null 2>&1 \
  && fail "--conflict reply must exit non-zero (escalated)" || true
t_assert_contains "$TELE" "peer_escalated_deliberation"

echo "T46 PASS"
