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
#     The document arrives on stdin, from a quoted redirection of the harness's
#     own state file. No filesystem path is passed to the interpreter, so the
#     reader has no path argument to resolve and nothing to traverse. Code is a
#     literal -c argument precisely because stdin is carrying the JSON.
python3 -c '
import json, sys

doc = json.load(sys.stdin.buffer)
schema_version = doc.get("schema_version")
assert schema_version == 2, f"schema_version={schema_version!r}"
assert isinstance(doc.get("generation"), int), "generation must be an int"
recs = doc.get("dispatches")
assert isinstance(recs, list) and len(recs) == 2, f"dispatches={recs!r}"
REQUIRED = ("/outcome/state", "/outcome/reported_value", "/lifecycle/state",
            "/dedup/key", "/dedup/ref_hash")
for rec in recs:
    did = rec.get("dispatch_id")
    for pointer in REQUIRED:
        cur, missing = rec, False
        for part in pointer.strip("/").split("/"):
            if not isinstance(cur, dict) or part not in cur:
                missing = True
                break
            cur = cur[part]
        assert not missing, f"missing pointer {pointer} in {did}"
    outcome_state = rec["outcome"]["state"]
    assert outcome_state == "unknown", f"outcome.state={outcome_state!r}"
    assert rec["outcome"]["reported_value"] is None, "outcome.reported_value must be null"
    assert rec["lifecycle"]["state"] == "delivery_attempt_started"
    assert rec["dedup"]["key"], "dedup.key must be non-empty"
ids = [r["dispatch_id"] for r in recs]
assert len(set(ids)) == 2, f"dispatch_id not unique: {ids}"
' < "$DISPATCH_STATE_DIR/active.json"

# (2) the operation table IS the enforcement surface — pin it exactly, so adding a
#     terminal mutation op has to change this test on purpose.
ops=$(t_registry --list-ops | tr '\n' ' ' | sed 's/ *$//')
# report-event/report-list joined the table with the #1170 report obligation
# (6578dfa) and are admitted here BY NAME, never derived from the table under
# test. Section (5) is what earns them the entry: neither is an outcome writer.
want="archive-sidecars begin-delivery check-dedup get list migrate observe prune report-event report-list set-gate set-lifecycle set-transport-result snapshot"
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

# (5) the two report operations are evidence entrances, not outcome entrances.
#     report-event writes the record's `report` subtree only; report-list reads.
#     If either ever grows a path to the outcome axis, this section fails before
#     the allowlist in (2) can make it look intentional.
did=$(t_v2 sid-A dispatch_id)

# Field rejection is probed BEFORE the capture below, and only ever with the
# capture's own otherwise-valid argv. After a legacy capture exists the repeat
# is DEDUPLICATED(8) on its own, which would mask an accepted field behind a
# nonzero exit — green by construction, the exact bug this file was born from.
for bad in --outcome --state; do
  if t_registry report-event --dispatch-id "$did" --kind legacy --item legacy \
      "$bad" complete >/dev/null 2>&1; then
    echo "FAIL: report-event accepted an outcome field '$bad'" >&2; exit 1
  fi
  if t_registry report-list "$bad" complete >/dev/null 2>&1; then
    echo "FAIL: report-list accepted an outcome field '$bad'" >&2; exit 1
  fi
done
t_assert_outcome_unknown sid-A

t_registry report-event --dispatch-id "$did" --kind legacy --item legacy \
  --now "2026-05-12T11:02:00Z" >/dev/null
t_assert_outcome_unknown sid-A

# `seen` is the only verdict a legacy subject takes, and it is as far as the
# evidence in this fixture goes: it derives report.resolution=legacy_seen. The
# free-form --field channel carries an outcome-shaped key alongside it here on
# purpose. Reported evidence is still not completion: the outcome axis does not
# move for the strongest review this subject can carry.
t_registry report-event --dispatch-id "$did" --kind reviewed --item legacy \
  --sha256 "$(t_v2 sid-A report.legacy.subject_sha256)" \
  --field verdict=seen --field outcome=complete --now "2026-05-12T11:03:00Z" >/dev/null
t_assert_outcome_unknown sid-A

# report-list observes; a reader may not bump the generation it reads.
gen_of() {
  python3 -c 'import json,sys; print(json.load(sys.stdin.buffer)["generation"])' \
    < "$DISPATCH_STATE_DIR/active.json"
}
gen_before=$(gen_of)
t_registry report-list >/dev/null
gen_after=$(gen_of)
[ "$gen_before" = "$gen_after" ] || {
  echo "FAIL: report-list wrote a generation ($gen_before -> $gen_after)" >&2; exit 1; }
t_assert_outcome_unknown sid-A

echo "T68 PASS"
