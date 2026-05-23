#!/usr/bin/env bash
# T21 — schedule MUST skip when active.json marks the sid keep_alive=true.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
SCHED="$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh"
pending="$DISPATCH_STATE_DIR/cleanup-pending.json"

# Seed active.json with keep_alive=true for sid-KA.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json,sys
p=sys.argv[1]
json.dump([{"sid":"sid-KA","status":"in_flight","keep_alive":True,
            "ref_path":"/tmp/r","ref_hash":"x","dispatched_at":"2026-05-23T12:00:00Z",
            "expected_report_by":"2026-05-23T12:30:00Z","last_seen_at":"2026-05-23T12:00:00Z",
            "classification_history":[],"cwd":"","from_sid":"orchestrator","re_dispatch_count":0}],
          open(p,"w"))
PY

export SCHEDULER_NOW="2026-05-23T12:10:00Z"
out=$("$SCHED" schedule sid-KA --grace-seconds 60 2>&1)
echo "$out" | grep -q "keep_alive=true" || { echo "FAIL: expected keep_alive skip log, got: $out" >&2; exit 1; }

count=$(python3 -c "import json;print(len(json.load(open('$pending'))))")
[ "$count" = "0" ] || { echo "FAIL: pending should be empty for keep_alive, got count=$count" >&2; exit 1; }

# Without keep_alive, schedule MUST land.
"$SCHED" schedule sid-OTHER --grace-seconds 60 >/dev/null
count=$(python3 -c "import json;print(len(json.load(open('$pending'))))")
[ "$count" = "1" ] || { echo "FAIL: non-keep_alive schedule didn't land, count=$count" >&2; exit 1; }

echo "T21 PASS"
