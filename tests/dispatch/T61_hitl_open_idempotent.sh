#!/usr/bin/env bash
# T61 — hitl.sh open is idempotent on gate-id (ADR 2026-07-26 hitl-gate-primitive).
# Two identical `open` calls ⇒ exactly 1 file in pending/ and exactly 1 notify inject.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export HITL_STATE_DIR="$T_TMP/hitl"
HITL="$REPO_ROOT/bin/hitl.sh"
Q="re-dispatch cap reached (count=1) for sid-A"

id1=$(RECONCILER_NOW="2026-07-26T04:00:00Z" "$HITL" open \
  --source reconciler --kind decision --resume registry-clear-redispatch \
  --question "$Q" --options "approve=re-dispatch once more,reject=mark stuck_error")
# Level-triggered producer: same source|kind|question one tick later.
id2=$(RECONCILER_NOW="2026-07-26T04:01:00Z" "$HITL" open \
  --source reconciler --kind decision --resume registry-clear-redispatch \
  --question "$Q" --options "approve=re-dispatch once more,reject=mark stuck_error")

if [ "$id1" != "$id2" ]; then
  echo "FAIL: gate-id not deterministic: $id1 != $id2" >&2; exit 1
fi
# id = <kind>-<source>-<sha256(source|kind|question)[0:12]>
if ! printf '%s' "$id1" | grep -Eq '^decision-reconciler-[0-9a-f]{12}$'; then
  echo "FAIL: gate-id shape: $id1" >&2; exit 1
fi

n=$(find "$HITL_STATE_DIR/pending" -name '*.json' | wc -l | tr -d ' ')
if [ "$n" != "1" ]; then
  echo "FAIL: pending gate files = $n, want 1" >&2
  ls -la "$HITL_STATE_DIR/pending" >&2 || true
  exit 1
fi

injects=$(grep -c 'HITL_GATE' "$STUB_DISPATCH_LOG" || true)
if [ "$injects" != "1" ]; then
  echo "FAIL: notify injects = $injects, want 1 (no re-notify on idempotent open)" >&2
  cat "$STUB_DISPATCH_LOG" >&2 || true
  exit 1
fi
t_assert_contains "$STUB_DISPATCH_LOG" "--submit-force"
t_assert_contains "$STUB_DISPATCH_LOG" "HITL_GATE $id1"

# Record content per the ADR file-format section; created_at keeps the FIRST open's time.
python3 - "$HITL_STATE_DIR/pending/$id1.json" "$id1" <<'PY'
import json,sys
g=json.load(open(sys.argv[1]))
want={"id":sys.argv[2],"dedupe_key":sys.argv[2].rsplit("-",1)[1],"source":"reconciler",
      "kind":"decision","resume":"registry-clear-redispatch","status":"pending",
      "subject_sid":None,"decision":None,"decided_at":None,
      "created_at":"2026-07-26T04:00:00Z","notified_at":"2026-07-26T04:00:00Z"}
for k,v in want.items():
    if g.get(k)!=v:
        print(f"FAIL: gate.{k} = {g.get(k)!r}, want {v!r}", file=sys.stderr); sys.exit(1)
if g.get("options")!=["approve=re-dispatch once more","reject=mark stuck_error"]:
    print(f"FAIL: gate.options = {g.get('options')!r}", file=sys.stderr); sys.exit(1)
PY

echo "T61 PASS"
