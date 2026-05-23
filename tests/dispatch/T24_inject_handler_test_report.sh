#!/usr/bin/env bash
# T24 — inject-handler.sh writes state/test-reports/<date>/<sid>.json for
# both envelope-in-PTY and markdown TestReport bodies (R5a, task #436).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
HANDLER="$REPO_ROOT/bin/inject-handler.sh"

# Isolate state to T_TMP (handler writes under DISPATCH_STATE_DIR + TEST_REPORTS_DIR).
export DISPATCH_STATE_DIR="$T_TMP/state"
export TEST_REPORTS_DIR="$T_TMP/test-reports"
mkdir -p "$DISPATCH_STATE_DIR"

# Envelope-in-PTY body.
fenced="$T_TMP/fenced.txt"
cat > "$fenced" <<'EOF'
TEST_REPORT inbound.
```json aigentry-envelope/v1
{
  "schema_version": "1",
  "kind": "test-report",
  "payload": {
    "schema_version": "1",
    "session_id": "tester-7",
    "suite": "vitest/contract",
    "totals": { "total": 4, "passed": 4, "failed": 0, "skipped": 0 },
    "finished_at": "2026-05-23T13:50:00Z",
    "duration_ms": 42,
    "coverage_line_pct": 88.0
  }
}
```
EOF

"$HANDLER" --body-file "$fenced" >/dev/null

date_dir=$(date -u +%Y-%m-%d)
out="$TEST_REPORTS_DIR/$date_dir/tester-7.json"
[ -f "$out" ] || { echo "FAIL: $out not created" >&2; ls -R "$TEST_REPORTS_DIR" >&2 || true; exit 1; }
suite=$(python3 -c "import json;print(json.load(open('$out'))['suite'])")
transport=$(python3 -c "import json;print(json.load(open('$out'))['_transport'])")
total=$(python3 -c "import json;print(json.load(open('$out'))['totals']['total'])")
[ "$suite" = "vitest/contract" ] || { echo "FAIL: suite=$suite" >&2; exit 1; }
[ "$transport" = "json-fenced" ] || { echo "FAIL: transport=$transport" >&2; exit 1; }
[ "$total" = "4" ] || { echo "FAIL: total=$total" >&2; exit 1; }

# Markdown fallback body — same session id, overwrites the file atomically.
md="$T_TMP/md.txt"
cat > "$md" <<'EOF'
TEST_REPORT: tester-7 | suite=md-suite | total=2 | passed=2 | failed=0 | skipped=0 | duration_ms=99
EOF
"$HANDLER" --body-file "$md" >/dev/null
suite2=$(python3 -c "import json;print(json.load(open('$out'))['suite'])")
transport2=$(python3 -c "import json;print(json.load(open('$out'))['_transport'])")
[ "$suite2" = "md-suite" ] || { echo "FAIL: md suite=$suite2" >&2; exit 1; }
[ "$transport2" = "markdown-fallback" ] || { echo "FAIL: md transport=$transport2" >&2; exit 1; }

# Malformed (missing totals.total in fenced JSON) — handler must exit non-zero, no silent accept.
bad="$T_TMP/bad.txt"
cat > "$bad" <<'EOF'
```json aigentry-envelope/v1
{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"x","suite":"s","totals":{"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}
```
EOF
if "$HANDLER" --body-file "$bad" >/dev/null 2>&1; then
  echo "FAIL: malformed TestReport silently accepted" >&2
  exit 1
fi

echo "T24 PASS"
