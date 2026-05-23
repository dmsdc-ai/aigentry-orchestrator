#!/usr/bin/env bash
# T19 — dispatch-cleanup-scheduler.sh: schedule writes record, tick past deadline
# invokes session-cleanup.sh and drops the pending entry.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
SCHED="$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh"

# Capture session-cleanup invocations via a fake script.
FAKE_CLEANUP="$T_TMP/fake-cleanup.sh"
CLEANUP_LOG="$T_TMP/cleanup-calls.log"
cat > "$FAKE_CLEANUP" <<EOF
#!/usr/bin/env bash
echo "cleanup \$*" >> "$CLEANUP_LOG"
exit 0
EOF
chmod +x "$FAKE_CLEANUP"

export SESSION_CLEANUP_SH="$FAKE_CLEANUP"
export SCHEDULER_NOW="2026-05-23T12:00:00Z"

# schedule with 60s grace → scheduled_cleanup_time = 12:01:00Z
"$SCHED" schedule sid-X --grace-seconds 60 --source layer-d-timeout --reason test-report-received >/dev/null

pending="$DISPATCH_STATE_DIR/cleanup-pending.json"
[ -f "$pending" ] || { echo "FAIL: cleanup-pending.json not created" >&2; exit 1; }
target=$(python3 -c "import json;print(json.load(open('$pending'))[0]['sid'])")
sched=$(python3 -c "import json;print(json.load(open('$pending'))[0]['scheduled_cleanup_time'])")
src=$(python3 -c "import json;print(json.load(open('$pending'))[0]['source'])")
[ "$target" = "sid-X" ] || { echo "FAIL: sid recorded was '$target'" >&2; exit 1; }
[ "$sched" = "2026-05-23T12:01:00Z" ] || { echo "FAIL: scheduled time = '$sched'" >&2; exit 1; }
[ "$src" = "layer-d-timeout" ] || { echo "FAIL: source = '$src'" >&2; exit 1; }

# Tick BEFORE deadline → no fire.
export SCHEDULER_NOW="2026-05-23T12:00:30Z"
"$SCHED" tick >/dev/null
[ -f "$CLEANUP_LOG" ] && [ -s "$CLEANUP_LOG" ] && { echo "FAIL: tick fired pre-deadline" >&2; exit 1; }

# Tick AT deadline → fires.
export SCHEDULER_NOW="2026-05-23T12:01:00Z"
"$SCHED" tick >/dev/null
grep -q "cleanup sid-X" "$CLEANUP_LOG" || { echo "FAIL: cleanup-sh not invoked for sid-X" >&2; cat "$CLEANUP_LOG"; exit 1; }

# Pending should be empty after fire.
remaining=$(python3 -c "import json;print(len(json.load(open('$pending'))))")
[ "$remaining" = "0" ] || { echo "FAIL: pending not drained, count=$remaining" >&2; exit 1; }

echo "T19 PASS"
