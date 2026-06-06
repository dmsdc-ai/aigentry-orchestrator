#!/usr/bin/env bash
# T30 — dispatch-tracker.sh register upserts an in-flight entry into active.json
#        and is idempotent on sid (#517: registry was never populated).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

# First registration → entry appears with status=in_flight, reported=null.
t_run_tracker register sid-R --track T7 --role coder --cwd /tmp/p --branch main >/dev/null

t_assert_status sid-R in_flight

python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
rows = [e for e in data if e.get("sid") == "sid-R"]
assert len(rows) == 1, f"FAIL: want 1 sid-R entry, got {len(rows)}"
e = rows[0]
assert e.get("status") == "in_flight", f"FAIL: status={e.get('status')!r}"
assert e.get("reported", "MISSING") is None, f"FAIL: reported={e.get('reported','MISSING')!r}, want null"
for k, v in (("track","T7"),("role","coder"),("cwd","/tmp/p"),("branch","main")):
    assert e.get(k) == v, f"FAIL: {k}={e.get(k)!r}, want {v!r}"
assert e.get("started_at"), "FAIL: started_at empty"
PY

# Second registration with the same sid → idempotent (no duplicate entry).
t_run_tracker register sid-R --track T7 --role coder --cwd /tmp/p --branch main >/dev/null

python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
rows = [e for e in data if e.get("sid") == "sid-R"]
assert len(rows) == 1, f"FAIL: idempotency broken, {len(rows)} sid-R entries"
PY

echo "T30 PASS"
