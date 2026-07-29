#!/usr/bin/env bash
# T71 — telepty#60 Stage A §3-item-3 / §8.3.4: "fail the dispatch, not the record".
# A missing registry helper or a failed durable commit must abort BEFORE telepty is
# called, with a named nonzero result — the reverse of today's best-effort hooks,
# which swallow every registry failure and leave a delivered task unrecorded.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2

ref="$T_TMP/ref.md"; printf 'payload\n' > "$ref"

# (a) registry helper missing entirely.
set +e
out=$(DISPATCH_REGISTRY_PY="$T_TMP/does-not-exist.py" \
  t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
    --no-task "test-fixture T71a" 2>&1)
rc=$?
set -e
[ "$rc" -eq 9 ] || { echo "FAIL(a): exit $rc, want 9 (DISPATCH_NOT_RECORDED)" >&2; echo "$out" >&2; exit 1; }
case "$out" in *DISPATCH_NOT_RECORDED*) ;; *) echo "FAIL(a): no DISPATCH_NOT_RECORDED in output: $out" >&2; exit 1;; esac
if grep -q inject "$STUB_DISPATCH_LOG"; then
  echo "FAIL(a): telepty was called despite an unrecorded dispatch" >&2; exit 1
fi

# (b) the durable commit itself fails (rename fault) — same contract.
set +e
out=$(AIGENTRY_REGISTRY_FAULT=rename \
  t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
    --no-task "test-fixture T71b" 2>&1)
rc=$?
set -e
[ "$rc" -eq 9 ] || { echo "FAIL(b): exit $rc, want 9" >&2; echo "$out" >&2; exit 1; }
if grep -q inject "$STUB_DISPATCH_LOG"; then
  echo "FAIL(b): telepty was called after a failed registry commit" >&2; exit 1
fi

# (c) no accepted dispatch, and no legacy sidecar left to poison the retry.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc.get("dispatches") == [], f"FAIL: registry gained a record: {doc.get('dispatches')}"
PY
if [ -e "$T_TMP/home/.aigentry/dispatch-helper/sid-A" ]; then
  echo "FAIL(c): a dedup sidecar was written by a failed dispatch" >&2; exit 1
fi

echo "T71 PASS"
