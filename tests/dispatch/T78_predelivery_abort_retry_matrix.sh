#!/usr/bin/env bash
# T78 — telepty#60 Stage A §"dedup contract" (2) / §8.3.11 (finding F2). Every
# pre-delivery abort — task gate, registration timeout, readiness timeout — must
# leave NO mark: no dedup sidecar, no accepted dispatch record. An identical retry
# must then reach begin-delivery and actually deliver. Today the sidecar is
# written before readiness and cleared only on the registration-timeout arm, so a
# readiness timeout turns the operator's retry into a silent exit-0 no-op.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

ref="$T_TMP/ref.md"; printf 'retry payload\n' > "$ref"

assert_no_trace() {
  local name="$1"
  python3 - "$DISPATCH_STATE_DIR/active.json" "$name" <<'PY'
import json, sys
path, name = sys.argv[1:3]
doc = json.load(open(path, encoding="utf-8"))
recs = doc.get("dispatches", [])
assert recs == [], f"FAIL({name}): a pre-delivery abort created a record: {recs}"
PY
  if [ -e "$T_TMP/home/.aigentry/dispatch-helper/sid-A" ]; then
    echo "FAIL($name): a pre-delivery abort left a dedup sidecar" >&2; exit 1
  fi
  if grep -q inject "$STUB_DISPATCH_LOG"; then
    echo "FAIL($name): telepty was called on a pre-delivery abort" >&2; exit 1
  fi
}

# --- (a) Rule 34 task gate rejection --------------------------------------
t_init_v2; : > "$STUB_DISPATCH_LOG"
set +e
t_run_dispatch --target sid-A --ref "$ref" --no-verify-started >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 4 ] || { echo "FAIL(task_gate): exit $rc, want 4" >&2; exit 1; }
assert_no_trace task_gate

# --- (b) session never registers (telepty list empty) ----------------------
t_init_v2; : > "$STUB_DISPATCH_LOG"
printf '%s' '[]' > "$STUB_LIST_FILE"
set +e
t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
  --no-task "test-fixture T78b" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 6 ] || { echo "FAIL(registration): exit $rc, want 6" >&2; exit 1; }
assert_no_trace registration

# --- (c) REPL never becomes ready -----------------------------------------
t_init_v2; : > "$STUB_DISPATCH_LOG"
printf '%s' '[{"id":"sid-A","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
NOTREADY="$T_TMP/probe-notready.sh"
cat > "$NOTREADY" <<'SH'
#!/usr/bin/env bash
echo '{"ready":false}'
SH
chmod +x "$NOTREADY"
set +e
HOME="$T_TMP/home" AIGENTRY_SESSIONS_ROOT="$T_TMP/sessions" \
SESSION_PROBE_PY="$NOTREADY" EMIT_TELEMETRY_MJS="$T_TMP/noop" \
TELEPTY="$STUB_BIN/telepty" \
  "$REPO_ROOT/bin/dispatch.sh" --target sid-A --ref "$ref" --timeout-ms 300 \
    --no-verify-started --no-task "test-fixture T78c" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 1 ] || { echo "FAIL(readiness): exit $rc, want 1" >&2; exit 1; }
assert_no_trace readiness

# --- (d) the identical retry now delivers ---------------------------------
set +e
t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
  --no-task "test-fixture T78d" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "FAIL(retry): exit $rc, want 0 — the retry was swallowed" >&2; exit 1; }
grep -q inject "$STUB_DISPATCH_LOG" || { echo "FAIL(retry): telepty never called" >&2; exit 1; }
t_assert_outcome_unknown sid-A
t_assert_v2 sid-A transport.result write_observed

echo "T78 PASS"
