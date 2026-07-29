#!/usr/bin/env bash
# T64 — hitl.sh approve: pending→decided, gate cleared, resume hook fires, second
# approve exits non-zero (ADR 2026-07-26 hitl-gate-primitive).
#
# telepty#60 Stage A: the gate is its own axis, so approval CLEARS the gate rather
# than restoring a stashed status string. There is no window in which a restore
# could resurrect a dispatch, and no path by which a gate decision touches outcome.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export HITL_STATE_DIR="$T_TMP/hitl"
HITL="$REPO_ROOT/bin/hitl.sh"

t_seed_dispatch sid-A dispatched_at="2026-07-26T03:00:00Z" \
  expected_report_by="2026-07-26T03:30:00Z"

id=$(RECONCILER_NOW="2026-07-26T04:00:00Z" "$HITL" open \
  --source sid-A --subject-sid sid-A --kind decision --resume reinject \
  --question "Phase A complete — land as-is or amend scope?" \
  --options "approve=land,reject=amend")

# open --subject-sid blocks the worker in the registry on the gate axis.
t_assert_gate sid-A awaiting_user
t_assert_lifecycle sid-A delivery_attempt_started
if [ ! -f "$HITL_STATE_DIR/pending/$id.json" ]; then
  echo "FAIL: no pending gate file for $id" >&2; exit 1
fi
prev=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("prev_status"))' \
  "$HITL_STATE_DIR/pending/$id.json")
if [ "$prev" != "delivery_attempt_started" ]; then
  echo "FAIL: gate.prev_status = $prev, want delivery_attempt_started" >&2; exit 1
fi

RECONCILER_NOW="2026-07-26T05:00:00Z" "$HITL" approve "$id" --note "go ahead" >/dev/null

if [ -f "$HITL_STATE_DIR/pending/$id.json" ]; then
  echo "FAIL: gate still in pending/ after approve" >&2; exit 1
fi
if [ ! -f "$HITL_STATE_DIR/decided/$id.json" ]; then
  echo "FAIL: gate not in decided/ after approve" >&2; exit 1
fi
python3 - "$HITL_STATE_DIR/decided/$id.json" <<'PY'
import json,sys
g=json.load(open(sys.argv[1]))
want={"status":"approved","decision":"approve","decided_at":"2026-07-26T05:00:00Z",
      "note":"go ahead","resume_error":None}
for k,v in want.items():
    if g.get(k)!=v:
        print(f"FAIL: decided.{k} = {g.get(k)!r}, want {v!r}", file=sys.stderr); sys.exit(1)
PY

# Approval clears the gate; the lifecycle underneath was never disturbed.
t_assert_gate sid-A null
t_assert_lifecycle sid-A delivery_attempt_started
t_assert_outcome_unknown sid-A
# resume=reinject → the gated worker is told the verdict.
t_assert_contains "$STUB_DISPATCH_LOG" "[APPROVED] gate $id"
t_assert_contains "$STUB_DISPATCH_LOG" "go ahead"

# Second decider loses the atomic mv → non-zero, and does not touch the registry.
set +e
out=$(RECONCILER_NOW="2026-07-26T05:01:00Z" "$HITL" approve "$id" 2>&1)
rc=$?
set -e
if [ "$rc" = "0" ]; then
  echo "FAIL: second approve exited 0 (want non-zero). out=$out" >&2; exit 1
fi
case "$out" in *"already decided"*) ;; *)
  echo "FAIL: second approve message = $out (want 'already decided')" >&2; exit 1;; esac
t_assert_gate sid-A null
t_assert_lifecycle sid-A delivery_attempt_started

# --- resume=registry-clear-redispatch — both arms of the reconciler cap gate ---
for sid in sid-B sid-C; do
  t_seed_dispatch "$sid" lifecycle.state=re_dispatched re_dispatch_count=1 \
    dispatched_at="2026-07-26T03:00:00Z" expected_report_by="2026-07-26T03:30:00Z"
done

for sid in sid-B sid-C; do
  gid=$(RECONCILER_NOW="2026-07-26T06:00:00Z" "$HITL" open \
    --source reconciler --subject-sid "$sid" --kind decision \
    --resume registry-clear-redispatch \
    --question "re-dispatch cap reached (count=1) for $sid")
  t_assert_gate "$sid" awaiting_user
  case "$sid" in
    sid-B) RECONCILER_NOW="2026-07-26T06:10:00Z" "$HITL" approve "$gid" >/dev/null;;
    sid-C) RECONCILER_NOW="2026-07-26T06:10:00Z" "$HITL" reject  "$gid" >/dev/null;;
  esac
done

# approve → counter cleared, gate released ⇒ next tick may re-dispatch once more.
t_assert_gate sid-B null
t_assert_lifecycle sid-B re_dispatched
got=$(t_v2 sid-B re_dispatch_count)
if [ "$got" != "0" ]; then echo "FAIL: sid-B re_dispatch_count=$got, want 0" >&2; exit 1; fi
# reject → the resume hook parks it on an error LIFECYCLE. Even a human rejecting
# a gate cannot assert a task outcome — only that this dispatch is not resuming.
t_assert_gate sid-C null
t_assert_lifecycle sid-C stuck_error
t_assert_outcome_unknown sid-B
t_assert_outcome_unknown sid-C

echo "T64 PASS"
