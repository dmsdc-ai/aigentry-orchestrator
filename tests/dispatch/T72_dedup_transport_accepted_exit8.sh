#!/usr/bin/env bash
# T72 — telepty#60 Stage A §"dedup contract" (3) / §8.3.12: a dispatch whose dedup
# key already carries transport_write_observed produces NO new delivery, appends
# dedup_suppressed to the existing record, and exits 8 — never 0. Exit 0 is
# reserved for a new transport write whose durable commit also succeeded, so an
# exit-code-only caller can never book suppression as a re-dispatch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2

ref="$T_TMP/ref.md"; printf 'the same payload\n' > "$ref"
h=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ref")

t_seed_dispatch sid-A dedup.ref_hash="$h" transport.result=write_observed \
  dispatch_id=disp-prior

set +e
out=$(t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
  --no-task "test-fixture T72" 2>&1)
rc=$?
set -e

[ "$rc" -eq 8 ] || { echo "FAIL: exit $rc, want 8 (DEDUPLICATED_NO_NEW_DELIVERY)" >&2; echo "$out" >&2; exit 1; }
if grep -q inject "$STUB_DISPATCH_LOG"; then
  echo "FAIL: telepty was called for a deduplicated dispatch" >&2; exit 1
fi

# discriminated response, naming the record it points at.
for needle in DISPATCH_DEDUPLICATED disp-prior '"new_delivery": false' '"prior_transport": "write_observed"' '"completion_fact": null'; do
  case "$out" in *"$needle"*) ;; *) echo "FAIL: response missing $needle; got: $out" >&2; exit 1;; esac
done

t_assert_observation sid-A dedup_suppressed
t_assert_outcome_unknown sid-A
t_assert_lifecycle sid-A delivery_attempt_started

# exactly one record — suppression appends, it never creates a second attempt.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
recs = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"]
assert len(recs) == 1, f"FAIL: want 1 record, got {len(recs)}"
PY

echo "T72 PASS"
