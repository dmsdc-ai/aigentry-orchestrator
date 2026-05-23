#!/usr/bin/env bash
# T18 — TestReport (R5a) handoff integration. End-to-end:
#   tester emits TestReport envelope → inject-handler.sh parses + writes to
#   state/test-reports/<YYYY-MM-DD>/<sid>.json with correct schema fields.
#
# Exercises both transports:
#   (1) envelope-in-PTY (fenced JSON, ssot @aigentry/ssot/contracts/handoff shape)
#   (2) markdown TEST_REPORT line (backward compat)
#
# Plus negative path: malformed envelope must NOT silently succeed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
HANDLER="$REPO_ROOT/bin/inject-handler.sh"

export DISPATCH_STATE_DIR="$T_TMP/state"
export TEST_REPORTS_DIR="$T_TMP/test-reports"
mkdir -p "$DISPATCH_STATE_DIR"

# Ensure parser is compiled. The handler error path covers absence too.
[ -f "$REPO_ROOT/dist/src/session/inject-parser.js" ] || {
  echo "T18: dist/src/session/inject-parser.js missing — run tsc first" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# transport 1 — envelope-in-PTY (fenced JSON, ssot handoff shape)
# ---------------------------------------------------------------------------
fenced="$T_TMP/fenced.txt"
cat > "$fenced" <<'EOF'
TEST_REPORT incoming, ssot envelope below.
```json aigentry-envelope/v1
{
  "schema_version": "1",
  "kind": "test-report",
  "payload": {
    "schema_version": "1",
    "session_id": "tester-9",
    "suite": "vitest/contract-roundtrip",
    "totals": { "total": 24, "passed": 23, "failed": 1, "skipped": 0 },
    "finished_at": "2026-05-23T13:50:00Z",
    "duration_ms": 4321,
    "failures": ["contract.roundtrip.spec.ts:bad-version-rejected"],
    "coverage_line_pct": 91.2
  }
}
```
EOF
"$HANDLER" --body-file "$fenced" >/dev/null

date_dir=$(date -u +%Y-%m-%d)
out="$TEST_REPORTS_DIR/$date_dir/tester-9.json"
[ -f "$out" ] || { echo "FAIL t1: $out not created" >&2; exit 1; }
suite=$(python3 -c "import json;print(json.load(open('$out'))['suite'])")
[ "$suite" = "vitest/contract-roundtrip" ] || { echo "FAIL t1: suite=$suite" >&2; exit 1; }
transport=$(python3 -c "import json;print(json.load(open('$out'))['_transport'])")
[ "$transport" = "json-fenced" ] || { echo "FAIL t1: transport=$transport" >&2; exit 1; }
total=$(python3 -c "import json;print(json.load(open('$out'))['totals']['total'])")
passed=$(python3 -c "import json;print(json.load(open('$out'))['totals']['passed'])")
[ "$total" = "24" ] && [ "$passed" = "23" ] || { echo "FAIL t1: totals mismatch ($total/$passed)" >&2; exit 1; }
cov=$(python3 -c "import json;print(json.load(open('$out'))['coverage_line_pct'])")
[ "$cov" = "91.2" ] || { echo "FAIL t1: coverage=$cov" >&2; exit 1; }
fail_count=$(python3 -c "import json;print(len(json.load(open('$out'))['failures']))")
[ "$fail_count" = "1" ] || { echo "FAIL t1: failures len=$fail_count" >&2; exit 1; }

# ---------------------------------------------------------------------------
# transport 2 — markdown TEST_REPORT (different sid, distinct output file)
# ---------------------------------------------------------------------------
md="$T_TMP/md.txt"
printf 'TEST_REPORT: tester-md | suite=runner-py | total=3 | passed=3 | failed=0 | skipped=0 | duration_ms=88\n' > "$md"
"$HANDLER" --body-file "$md" >/dev/null
out_md="$TEST_REPORTS_DIR/$date_dir/tester-md.json"
[ -f "$out_md" ] || { echo "FAIL t2: $out_md not created" >&2; exit 1; }
transport_md=$(python3 -c "import json;print(json.load(open('$out_md'))['_transport'])")
[ "$transport_md" = "markdown-fallback" ] || { echo "FAIL t2: transport=$transport_md" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Negative — malformed JSON (missing totals.total) must NOT silently succeed
# ---------------------------------------------------------------------------
bad="$T_TMP/bad.txt"
cat > "$bad" <<'EOF'
```json aigentry-envelope/v1
{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"y","suite":"s","totals":{"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}
```
EOF
if "$HANDLER" --body-file "$bad" >/dev/null 2>&1; then
  echo "FAIL neg: malformed envelope silently accepted" >&2
  exit 1
fi
if [ -f "$TEST_REPORTS_DIR/$date_dir/y.json" ]; then
  echo "FAIL neg: malformed envelope wrote a file" >&2
  exit 1
fi

echo "T18 PASS"
