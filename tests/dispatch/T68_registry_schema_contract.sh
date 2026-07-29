#!/usr/bin/env bash
# T68 — telepty#60 Stage A, design §"writer inventory and structural enforcement" (1).
# The single-writer proof is only non-vacuous if the outcome fields are GUARANTEED
# to exist. A previous revision guarded a field name that did not exist and was
# green by construction; this test binds to JSON pointers on every created record
# and to the registry's actual operation table.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

t_init_v2
t_registry begin-delivery --sid sid-A --ref-hash h1 --ref-path /tmp/r \
  --cwd /tmp/w --from orchestrator --now "2026-05-12T11:00:00Z" >/dev/null
t_registry begin-delivery --sid sid-B --ref-hash h2 --ref-path /tmp/r2 \
  --now "2026-05-12T11:01:00Z" >/dev/null

# (1) envelope + required pointers on EVERY record.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys

doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc.get("schema_version") == 2, f"schema_version={doc.get('schema_version')!r}"
assert isinstance(doc.get("generation"), int), "generation must be an int"
recs = doc.get("dispatches")
assert isinstance(recs, list) and len(recs) == 2, f"dispatches={recs!r}"
REQUIRED = ("/outcome/state", "/outcome/reported_value", "/lifecycle/state",
            "/dedup/key", "/dedup/ref_hash")
for rec in recs:
    for pointer in REQUIRED:
        cur, missing = rec, False
        for part in pointer.strip("/").split("/"):
            if not isinstance(cur, dict) or part not in cur:
                missing = True
                break
            cur = cur[part]
        assert not missing, f"missing pointer {pointer} in {rec.get('dispatch_id')}"
    assert rec["outcome"]["state"] == "unknown", f"outcome.state={rec['outcome']['state']!r}"
    assert rec["outcome"]["reported_value"] is None, "outcome.reported_value must be null"
    assert rec["lifecycle"]["state"] == "delivery_attempt_started"
    assert rec["dedup"]["key"], "dedup.key must be non-empty"
ids = [r["dispatch_id"] for r in recs]
assert len(set(ids)) == 2, f"dispatch_id not unique: {ids}"
PY

# (2) the operation table IS the enforcement surface — pin it exactly, so adding a
#     terminal mutation op has to change this test on purpose.
ops=$(t_registry --list-ops | tr '\n' ' ' | sed 's/ *$//')
want="archive-sidecars begin-delivery check-dedup get list migrate observe prune set-gate set-lifecycle set-transport-result snapshot"
[ "$ops" = "$want" ] || { echo "FAIL: op table = [$ops], want [$want]" >&2; exit 1; }

# (3) there is no outcome-mutation entrance, by any of its historical names.
for bad in record-outcome mark-reported set-outcome settle; do
  if t_registry "$bad" --sid sid-A --state complete >/dev/null 2>&1; then
    echo "FAIL: registry accepted a terminal operation '$bad'" >&2; exit 1
  fi
done
t_assert_outcome_unknown sid-A

# (4) unknown FIELD names fail closed too (not just unknown ops).
if t_registry set-lifecycle --sid sid-A --state re_dispatched --outcome complete >/dev/null 2>&1; then
  echo "FAIL: set-lifecycle accepted an --outcome field" >&2; exit 1
fi
t_assert_outcome_unknown sid-A

echo "T68 PASS"
