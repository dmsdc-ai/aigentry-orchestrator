#!/usr/bin/env bash
# T30 — a dispatch record is created by the begin-delivery transaction with its
# full metadata, and an identical (sid, ref) re-run creates NO second record.
#
# telepty#60 Stage A retired `dispatch-tracker.sh append|register`: the record is
# now committed BEFORE the bytes are handed over, so a post-delivery upsert would
# be a second record-creation entrance for the single-writer proof to exclude.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_registry begin-delivery --sid sid-R --ref-hash h1 --ref-path /tmp/r \
  --track T7 --role coder --cwd /tmp/p --branch main --now "2026-05-12T11:00:00Z" >/dev/null

python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rows = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-R"]
assert len(rows) == 1, f"FAIL: want 1 sid-R record, got {len(rows)}"
rec = rows[0]
assert rec["outcome"]["state"] == "unknown", f"FAIL: outcome.state={rec['outcome']['state']!r}"
assert rec["outcome"]["reported_value"] is None, "FAIL: reported_value is not null"
assert rec["lifecycle"]["state"] == "delivery_attempt_started"
for k, v in (("track", "T7"), ("role", "coder"), ("cwd", "/tmp/p"), ("branch", "main")):
    assert rec.get(k) == v, f"FAIL: {k}={rec.get(k)!r}, want {v!r}"
assert rec.get("started_at"), "FAIL: started_at empty"
PY

# An identical (sid, ref_hash) is deduplicated, not upserted into a second record.
set +e
t_registry begin-delivery --sid sid-R --ref-hash h1 --ref-path /tmp/r >/dev/null
rc=$?
set -e
[ "$rc" -eq 7 ] || { echo "FAIL: duplicate begin-delivery rc=$rc, want 7 (attempt still unknown)" >&2; exit 1; }

python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rows = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-R"]
assert len(rows) == 1, f"FAIL: idempotency broken, {len(rows)} sid-R records"
PY

echo "T30 PASS"
