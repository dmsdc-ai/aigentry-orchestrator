#!/usr/bin/env bash
# T45 (#533 Phase 1, Scenario S2) — work-delegation attempted peer→peer is
# FLAGGED (warn-mode) and ROUTED via the orchestrator (HITL path), never
# peer-executed. The reconcile-tick auditor tails the peer-inject log and
# classifies each non-orch↔non-orch inject with the structural envelope
# predicate. Out-of-policy injects (no envelope / malformed work-order) →
# peer_inject_out_of_policy telemetry + a HOLD pushed to the orchestrator inbox
# naming {from,to,excerpt}. The orchestrator lane is ignored. Phase 1 is
# warn-only — the auditor detects/counts/escalates, never hard-blocks.
#
# HERMETIC: telepty stubbed; peer-inject log is a fixture file; state under
# $T_TMP. TDD: RED before bin/session-comms-auditor.sh exists.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
AUDITOR="$REPO_ROOT/bin/session-comms-auditor.sh"

fail() { echo "FAIL[T45]: $*" >&2; exit 1; }

export SESSION_COMMS_DIR="$T_TMP/session-comms"
export AUDITOR_NOW="2026-06-07T12:00:00Z"
export AIGENTRY_PEER_INJECT_LOG="$T_TMP/peer-injects.jsonl"
TELE="$SESSION_COMMS_DIR/telemetry.jsonl"

# Fixture peer-inject log (one JSON object per line):
#   (a) raw work-delegation, NO envelope            → out-of-policy
#   (b) malformed ask-request that is a work-order  → out-of-policy (no thread/round/question)
#   (c) orchestrator-lane inject                    → IGNORED (not the peer lane)
#   (d) well-formed ask-request                     → in-policy (reconciled, NOT flagged)
{
  printf '%s\n' '{"ts":"2026-06-07T11:59:00Z","from":"coder-A","to":"coder-B","body":"go implement X in file Y and push"}'
  printf '%s\n' '{"ts":"2026-06-07T11:59:10Z","from":"coder-A","to":"coder-B","body":"```json\n{\"kind\":\"ask-request\",\"from\":\"coder-A\",\"to\":\"coder-B\",\"do\":\"implement X and open a PR\"}\n```"}'
  printf '%s\n' '{"ts":"2026-06-07T11:59:20Z","from":"orchestrator","to":"coder-B","body":"dispatch: go do real work"}'
  printf '%s\n' '{"ts":"2026-06-07T11:59:30Z","from":"coder-A","to":"coder-B","body":"```json\n{\"kind\":\"ask-request\",\"from\":\"coder-A\",\"to\":\"coder-B\",\"thread_id\":\"ctx1\",\"round\":1,\"question\":\"gate API sig?\",\"reply_to\":\"coder-A\"}\n```"}'
} > "$AIGENTRY_PEER_INJECT_LOG"

"$AUDITOR" >/dev/null 2>&1 || fail "auditor exited non-zero"

# (a) + (b) → two out-of-policy events
n_oop=$(grep -c "peer_inject_out_of_policy" "$TELE" 2>/dev/null || echo 0)
[ "$n_oop" -eq 2 ] || fail "expected 2 out-of-policy events, got $n_oop. telemetry:
$(cat "$TELE" 2>/dev/null)"

# a HOLD was pushed to the orchestrator inbox naming {from,to,excerpt}
t_assert_contains "$STUB_DISPATCH_LOG" "orchestrator"
t_assert_contains "$STUB_DISPATCH_LOG" "HOLD"
t_assert_contains "$STUB_DISPATCH_LOG" "coder-A"
t_assert_contains "$STUB_DISPATCH_LOG" "coder-B"

# (c) orchestrator-lane inject must NOT be flagged
grep -q "dispatch: go do real work" "$TELE" 2>/dev/null \
  && fail "orchestrator-lane inject was wrongly classified"

# (d) well-formed ask-request was reconciled (counted), NOT flagged
t_assert_contains "$TELE" "peer_ask_reconciled"
RECON_STATE="$SESSION_COMMS_DIR/coder-A__coder-B__ctx1.json"
[ -f "$RECON_STATE" ] || fail "reconciled in-policy ask-request did not create/update state"

# warn-mode: the auditor never deleted/blocked the peer inject log in-band
[ -s "$AIGENTRY_PEER_INJECT_LOG" ] || fail "Phase 1 must NOT consume/clear the peer inject log (warn-only)"

echo "T45 PASS"
