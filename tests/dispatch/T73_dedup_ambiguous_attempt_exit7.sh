#!/usr/bin/env bash
# T73 — telepty#60 Stage A §"dedup contract" (4) / §8.3.13: a matching record that
# is delivery_attempt_started or delivery_state_unknown is AMBIGUOUS — bytes may
# have landed. It is held explicitly (exit 7, dedup_retry_held) rather than
# replayed, and never reported as "OK already dispatched".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

ref="$T_TMP/ref.md"; printf 'ambiguous payload\n' > "$ref"
h=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ref")

for arm in delivery_attempt_started delivery_state_unknown; do
  t_init_v2
  : > "$STUB_DISPATCH_LOG"
  t_seed_dispatch sid-A dedup.ref_hash="$h" transport.result=unknown \
    lifecycle.state="$arm" dispatch_id="disp-$arm"

  set +e
  out=$(t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
    --no-task "test-fixture T73" 2>&1)
  rc=$?
  set -e

  [ "$rc" -eq 7 ] || { echo "FAIL($arm): exit $rc, want 7 (DELIVERY_UNKNOWN_RETRY_HELD)" >&2; echo "$out" >&2; exit 1; }
  if grep -q inject "$STUB_DISPATCH_LOG"; then
    echo "FAIL($arm): telepty was called for a held dispatch — bytes may already have landed" >&2; exit 1
  fi
  for needle in DISPATCH_RETRY_HELD "disp-$arm" '"new_delivery": false' '"prior_transport": "unknown"' '"completion_fact": null'; do
    case "$out" in *"$needle"*) ;; *) echo "FAIL($arm): response missing $needle; got: $out" >&2; exit 1;; esac
  done
  case "$out" in *"already dispatched"*) echo "FAIL($arm): held retry printed a success phrase" >&2; exit 1;; esac

  t_assert_observation sid-A dedup_retry_held
  t_assert_outcome_unknown sid-A
  t_assert_lifecycle sid-A "$arm"
done

echo "T73 PASS"
