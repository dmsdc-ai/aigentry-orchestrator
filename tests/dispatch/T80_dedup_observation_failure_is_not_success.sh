#!/usr/bin/env bash
# T80 — telepty#60 Stage A §"dedup contract" (5) / §8.3.14: "a dedup decision is
# never a print-only success". If the dedup observation cannot be appended durably,
# the caller gets a named registry failure and telepty is not called — the decision
# does not silently become an exit-8 suppression with nothing on disk to show it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2

ref="$T_TMP/ref.md"; printf 'payload\n' > "$ref"
h=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ref")
t_seed_dispatch sid-A dedup.ref_hash="$h" transport.result=write_observed

set +e
out=$(AIGENTRY_REGISTRY_FAULT=rename \
  t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
    --no-task "test-fixture T80" 2>&1)
rc=$?
set -e

[ "$rc" -eq 9 ] || { echo "FAIL: exit $rc, want 9 — a failed dedup append must not read as suppression (8) or success (0)" >&2; echo "$out" >&2; exit 1; }
if grep -q inject "$STUB_DISPATCH_LOG"; then
  echo "FAIL: telepty was called after a failed dedup append" >&2; exit 1
fi
t_refute_observation sid-A dedup_suppressed
t_assert_outcome_unknown sid-A

echo "T80 PASS"
