#!/usr/bin/env bash
# T64 — hitl.sh approve: pending→decided, compare-and-set status restore, resume
# hook fires, second approve exits non-zero (ADR 2026-07-26 hitl-gate-primitive).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export HITL_STATE_DIR="$T_TMP/hitl"
HITL="$REPO_ROOT/bin/hitl.sh"

t_seed_entry sid-A "2026-07-26T03:00:00Z" "2026-07-26T03:30:00Z" in_flight

id=$(RECONCILER_NOW="2026-07-26T04:00:00Z" "$HITL" open \
  --source sid-A --subject-sid sid-A --kind decision --resume reinject \
  --question "Phase A complete — land as-is or amend scope?" \
  --options "approve=land,reject=amend")

# open --subject-sid blocks the worker in the registry, stashing prev_status.
t_assert_status sid-A awaiting_user
if [ ! -f "$HITL_STATE_DIR/pending/$id.json" ]; then
  echo "FAIL: no pending gate file for $id" >&2; exit 1
fi
prev=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("prev_status"))' \
  "$HITL_STATE_DIR/pending/$id.json")
if [ "$prev" != "in_flight" ]; then
  echo "FAIL: gate.prev_status = $prev, want in_flight" >&2; exit 1
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

# Compare-and-set restore: awaiting_user → prev_status.
t_assert_status sid-A in_flight
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
t_assert_status sid-A in_flight

# --- resume=registry-clear-redispatch — both arms of the reconciler cap gate ---
t_seed_entry sid-B "2026-07-26T03:00:00Z" "2026-07-26T03:30:00Z" re_dispatched
t_seed_entry sid-C "2026-07-26T03:00:00Z" "2026-07-26T03:30:00Z" re_dispatched
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for e in d:
    if e["sid"] in ("sid-B","sid-C"): e["re_dispatch_count"]=1
json.dump(d,open(p,"w"),indent=2)
PY

for sid in sid-B sid-C; do
  gid=$(RECONCILER_NOW="2026-07-26T06:00:00Z" "$HITL" open \
    --source reconciler --subject-sid "$sid" --kind decision \
    --resume registry-clear-redispatch \
    --question "re-dispatch cap reached (count=1) for $sid")
  t_assert_status "$sid" awaiting_user
  case "$sid" in
    sid-B) RECONCILER_NOW="2026-07-26T06:10:00Z" "$HITL" approve "$gid" >/dev/null;;
    sid-C) RECONCILER_NOW="2026-07-26T06:10:00Z" "$HITL" reject  "$gid" >/dev/null;;
  esac
done

# approve → counter cleared, status restored ⇒ next tick may re-dispatch once more.
t_assert_status sid-B re_dispatched
got=$(t_field sid-B re_dispatch_count)
if [ "$got" != "0" ]; then echo "FAIL: sid-B re_dispatch_count=$got, want 0" >&2; exit 1; fi
# reject → terminal; the resume hook overrides the restored prev_status.
t_assert_status sid-C stuck_error

echo "T64 PASS"
