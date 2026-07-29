#!/usr/bin/env bash
# T79 — telepty#60 Stage A §A2 / §8.3.6: a crash in the deliberately narrow window
# between the durable begin-delivery commit and the post-call transport commit is
# conservatively delivery-unknown. The record survives with outcome unknown, and a
# later retry is HELD (exit 7) rather than automatically replayed — bytes may
# already have landed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2

ref="$T_TMP/ref.md"; printf 'crash payload\n' > "$ref"

# telepty stub that kills dispatch.sh mid-delivery: the transport call happened,
# the post-call bookkeeping never did.
cat > "$STUB_BIN/telepty" <<EOF
#!/usr/bin/env bash
case "\$1" in
  list) shift; [ "\${1:-}" = "--json" ] && cat "$STUB_LIST_FILE";;
  inject)
    printf 'telepty inject %s\n' "\$*" >> "$STUB_DISPATCH_LOG"
    kill -9 \$PPID 2>/dev/null
    sleep 5;;
  *) echo "stub telepty \$*";;
esac
EOF
chmod +x "$STUB_BIN/telepty"

set +e
t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
  --no-task "test-fixture T79" >/dev/null 2>&1
set -e

grep -q inject "$STUB_DISPATCH_LOG" || { echo "FAIL: transport call never happened" >&2; exit 1; }

# the authoritative unknown survived the crash.
t_assert_outcome_unknown sid-A
t_assert_lifecycle sid-A delivery_attempt_started
t_assert_v2 sid-A transport.result unknown
t_assert_observation sid-A dispatch_tracking_started

# the identical retry is held, not replayed.
: > "$STUB_DISPATCH_LOG"
cp "$TEST_LIB_DIR/stubs/telepty" "$STUB_BIN/telepty"; chmod +x "$STUB_BIN/telepty"
set +e
out=$(t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
  --no-task "test-fixture T79 retry" 2>&1)
rc=$?
set -e
[ "$rc" -eq 7 ] || { echo "FAIL: retry exit $rc, want 7 (DELIVERY_UNKNOWN_RETRY_HELD)" >&2; echo "$out" >&2; exit 1; }
if grep -q inject "$STUB_DISPATCH_LOG"; then
  echo "FAIL: an ambiguous delivery was automatically replayed" >&2; exit 1
fi
t_assert_observation sid-A dedup_retry_held
t_assert_outcome_unknown sid-A

echo "T79 PASS"
