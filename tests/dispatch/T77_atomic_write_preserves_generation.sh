#!/usr/bin/env bash
# T77 — telepty#60 Stage A §3-item-2/6 / §8.3.8: the registry is replaced with
# same-dir temp → fsync(file) → rename → fsync(dir). Fail at any of those four
# points and recovery must see either the complete OLD generation or the complete
# NEW one — never empty or partial JSON. The forbidden shape is the `r+ →
# truncate → json.dump` path every current writer uses, where a crash mid-dump
# leaves valid-looking but truncated state.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

for fault in temp_write fsync rename dir_fsync; do
  t_init_v2
  t_seed_dispatch sid-A lifecycle.state=delivery_attempt_started
  before=$(t_v2 sid-A lifecycle.state)
  gen_before=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["generation"])' "$DISPATCH_STATE_DIR/active.json")

  set +e
  AIGENTRY_REGISTRY_FAULT="$fault" \
    t_registry set-lifecycle --sid sid-A --state re_dispatched >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "FAIL($fault): a faulted write reported success" >&2; exit 1; }

  python3 - "$DISPATCH_STATE_DIR/active.json" "$fault" "$before" "$gen_before" <<'PY'
import json, sys
path, fault, before, gen_before = sys.argv[1:5]
try:
    doc = json.load(open(path, encoding="utf-8"))
except Exception as exc:
    raise SystemExit(f"FAIL({fault}): registry is not complete JSON after the fault: {exc}")
assert doc.get("schema_version") == 2, f"FAIL({fault}): envelope lost"
recs = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"]
assert len(recs) == 1, f"FAIL({fault}): want 1 record, got {len(recs)}"
state = recs[0]["lifecycle"]["state"]
assert state in (before, "re_dispatched"), f"FAIL({fault}): lifecycle={state!r} is neither generation"
gen = doc["generation"]
assert gen in (int(gen_before), int(gen_before) + 1), f"FAIL({fault}): generation={gen}"
assert recs[0]["outcome"]["state"] == "unknown", f"FAIL({fault}): outcome moved"
PY

  # no temp litter left behind in the state dir.
  if ls "$DISPATCH_STATE_DIR"/active.json.*.tmp >/dev/null 2>&1; then
    echo "FAIL($fault): temp file left in the state directory" >&2; exit 1
  fi
done

# control: with no fault the write lands and the generation advances.
t_registry set-lifecycle --sid sid-A --state re_dispatched >/dev/null
t_assert_lifecycle sid-A re_dispatched
t_assert_outcome_unknown sid-A

echo "T77 PASS"
