#!/usr/bin/env bash
# T44 (#533 Phase 1, Scenario S1) — info-request via bin/ask.sh is ALLOWED and
# the round is counted. The sanctioned PEER channel (sender ≠ orchestrator AND
# target ≠ orchestrator) stamps an ask-request envelope, increments the
# per-pairkey__thread counter, injects to the peer, and emits telemetry. A reply
# on the same round does NOT bump the counter and triggers no escalation.
#
# HERMETIC: telepty stubbed (records injects to STUB_DISPATCH_LOG); state under
# $T_TMP. No live session. TDD: RED before bin/ask.sh exists.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
ASK="$REPO_ROOT/bin/ask.sh"

fail() { echo "FAIL[T44]: $*" >&2; exit 1; }

export SESSION_COMMS_DIR="$T_TMP/session-comms"
export ASK_NOW="2026-06-07T12:00:00Z"
STATE_FILE="$SESSION_COMMS_DIR/coder-A__coder-B__t1.json"
TELE="$SESSION_COMMS_DIR/telemetry.jsonl"

jf() { # jf <file> <python-expr-over-`d`>  → prints result
  python3 - "$1" "$2" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))
PY
}

# ── 1) request round 1 (coder-A → coder-B): ALLOWED + counted ──
"$ASK" --from coder-A --to coder-B --thread t1 --round 1 request \
  "what's the gate API signature?" >/dev/null 2>&1 \
  || fail "request exited non-zero (should be allowed)"

[ -f "$STATE_FILE" ] || fail "state file not created at $STATE_FILE"
[ "$(jf "$STATE_FILE" "d['rounds']")" = "1" ] || fail "rounds != 1 after first request"
[ "$(jf "$STATE_FILE" "d['status']")" = "open" ] || fail "status != open"
[ "$(jf "$STATE_FILE" "d['escalated']")" = "False" ] || fail "escalated should be False"
[ "$(jf "$STATE_FILE" "d['pairkey']")" = "coder-A__coder-B" ] || fail "pairkey wrong"
[ "$(jf "$STATE_FILE" "sorted(d['parties'])==['coder-A','coder-B']")" = "True" ] || fail "parties wrong"

# the envelope was injected to the peer with --from sender
t_assert_contains "$STUB_DISPATCH_LOG" "ask-request"
t_assert_contains "$STUB_DISPATCH_LOG" "coder-B"
t_assert_contains "$STUB_DISPATCH_LOG" "--from coder-A"
t_assert_contains "$STUB_DISPATCH_LOG" "t1"

# telemetry recorded the request
t_assert_contains "$TELE" "peer_ask_request_sent"

# ── 2) reply on SAME round 1 (coder-B → coder-A): pairkey shared, no bump ──
"$ASK" --from coder-B --to coder-A --thread t1 --round 1 reply \
  "enforceSpawn(req: SpawnRequest)" >/dev/null 2>&1 \
  || fail "reply exited non-zero (should be allowed)"

[ "$(jf "$STATE_FILE" "d['rounds']")" = "1" ] || fail "reply must NOT bump rounds (still round 1)"
t_assert_contains "$TELE" "peer_ask_reply_sent"

# no escalation / no out-of-policy on the happy path
grep -q "peer_cap_tripped"        "$TELE" && fail "unexpected cap trip on happy path"
grep -q "peer_escalated"          "$TELE" && fail "unexpected escalation on happy path"
grep -q "peer_inject_out_of_policy" "$TELE" && fail "unexpected out-of-policy on happy path"

echo "T44 PASS"
