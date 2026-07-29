#!/usr/bin/env bash
# T75 — telepty#60 Stage A §"dedup contract" (7) / §8.3.15: the pre-ledger sidecar
# at $HOME/.aigentry/dispatch-helper/<sid> loses ALL decision authority. A sidecar
# with no matching v2 record means nothing and cannot suppress a dispatch — today
# it exits 0 before any registry write or telepty call, i.e. an accepted dispatch
# that was never delivered and never recorded.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2

ref="$T_TMP/ref.md"; printf 'sidecar payload\n' > "$ref"
h=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ref")

# a stale sidecar claiming this exact (sid, ref) was already dispatched.
mkdir -p "$T_TMP/home/.aigentry/dispatch-helper"
printf '%s\n' "$h" > "$T_TMP/home/.aigentry/dispatch-helper/sid-A"

set +e
out=$(t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
  --no-task "test-fixture T75" 2>&1)
rc=$?
set -e

[ "$rc" -eq 0 ] || { echo "FAIL: exit $rc, want 0 (sidecar must not suppress)" >&2; echo "$out" >&2; exit 1; }
grep -q inject "$STUB_DISPATCH_LOG" || {
  echo "FAIL: the stale sidecar suppressed the delivery" >&2; echo "$out" >&2; exit 1; }

t_assert_outcome_unknown sid-A
t_assert_v2 sid-A transport.result write_observed
t_assert_observation sid-A dispatch_tracking_started

# and a fresh dispatch writes no sidecar at all — the file is neither read nor
# written after activation.
printf '%s' '[{"id":"sid-B","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
ref2="$T_TMP/ref2.md"; printf 'second payload\n' > "$ref2"
t_run_dispatch --target sid-B --ref "$ref2" --no-verify-started \
  --no-task "test-fixture T75b" >/dev/null 2>&1
if [ -e "$T_TMP/home/.aigentry/dispatch-helper/sid-B" ]; then
  echo "FAIL: dispatch still writes dedup sidecars" >&2; exit 1
fi
t_assert_outcome_unknown sid-B

echo "T75 PASS"
