#!/usr/bin/env bash
# T20 — EXTEND_LIFETIME paths: cancel drops the record; defer pushes deadline.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
SCHED="$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh"
pending="$DISPATCH_STATE_DIR/cleanup-pending.json"

export SCHEDULER_NOW="2026-05-23T12:00:00Z"
"$SCHED" schedule sid-A --grace-seconds 60 >/dev/null
"$SCHED" schedule sid-B --grace-seconds 60 >/dev/null

# cancel sid-A → only sid-B remains.
"$SCHED" cancel sid-A >/dev/null
remaining=$(python3 -c "import json;print([p['sid'] for p in json.load(open('$pending'))])")
[ "$remaining" = "['sid-B']" ] || { echo "FAIL: after cancel = $remaining" >&2; exit 1; }

# defer sid-B by 5 minutes from now (12:05:00).
"$SCHED" defer sid-B --minutes 5 --reason more-work >/dev/null
sched=$(python3 -c "import json;print(json.load(open('$pending'))[0]['scheduled_cleanup_time'])")
src=$(python3 -c "import json;print(json.load(open('$pending'))[0]['source'])")
reason=$(python3 -c "import json;print(json.load(open('$pending'))[0].get('preempt_reason',''))")
[ "$sched" = "2026-05-23T12:05:00Z" ] || { echo "FAIL: defer sched = '$sched'" >&2; exit 1; }
[ "$src" = "explicit-request" ] || { echo "FAIL: defer source = '$src'" >&2; exit 1; }
[ "$reason" = "more-work" ] || { echo "FAIL: defer reason = '$reason'" >&2; exit 1; }

echo "T20 PASS"
