#!/usr/bin/env bash
# T70 — telepty#60 Stage A §A2 / §8.3.5: the durable unknown record MUST be
# committed before telepty is handed any bytes. Today dispatch.sh injects first
# and calls best-effort tracker hooks afterwards, so a crash in between leaves a
# delivered task with no record at all — silence, which is the defect.
# Proof by ordering: the telepty stub snapshots the registry at the moment it is
# called; the snapshot must already contain the record.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2

SNAP="$T_TMP/registry-at-inject.json"
cat > "$STUB_BIN/telepty" <<EOF
#!/usr/bin/env bash
case "\$1" in
  list) shift; [ "\${1:-}" = "--json" ] && cat "$STUB_LIST_FILE";;
  inject)
    cp "$DISPATCH_STATE_DIR/active.json" "$SNAP" 2>/dev/null || true
    printf 'telepty inject %s\n' "\$*" >> "$STUB_DISPATCH_LOG"
    echo "stub inject OK";;
  *) echo "stub telepty \$*";;
esac
EOF
chmod +x "$STUB_BIN/telepty"

ref="$T_TMP/ref.md"; printf 'payload for sid-A\n' > "$ref"

set +e
t_run_dispatch --target sid-A --ref "$ref" --from orchestrator \
  --no-verify-started --no-task "test-fixture T70" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "FAIL: dispatch exit $rc, want 0" >&2; exit 1; }

[ -f "$SNAP" ] || { echo "FAIL: telepty inject was never called" >&2; exit 1; }

python3 - "$SNAP" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
recs = [r for r in doc.get("dispatches", []) if r.get("assigned", {}).get("sid") == "sid-A"]
assert recs, "FAIL: no dispatch record existed when telepty inject was called"
rec = recs[-1]
assert rec["outcome"]["state"] == "unknown", f"FAIL: outcome.state={rec['outcome']['state']!r}"
assert rec["outcome"]["reported_value"] is None, "FAIL: outcome.reported_value must be null"
assert rec["lifecycle"]["state"] == "delivery_attempt_started", \
    f"FAIL: lifecycle.state={rec['lifecycle']['state']!r} at inject time"
kinds = [o.get("kind") for o in rec.get("observations", [])]
assert "dispatch_tracking_started" in kinds, f"FAIL: observations={kinds}"
PY

# After a successful transport call the result is recorded — and it is a transport
# fact, never consumption or completion.
t_assert_v2 sid-A transport.result write_observed
t_assert_outcome_unknown sid-A

echo "T70 PASS"
