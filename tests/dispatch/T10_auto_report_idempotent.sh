#!/usr/bin/env bash
# T10 — AUTO_REPORT idempotent per (sid, head_sha): rerun adds no new line.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 1 files changed, 5 insertions(+), 1 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"
mkdir -p "$T_TMP/.git"

t_run_tracker check >/dev/null
first=$(wc -l < "$DISPATCH_STATE_DIR/auto-reports.log")

# Re-arm: bump expected back and reset status so check loop revisits it.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p))
for e in d:
    if e["sid"]=="sid-A":
        e["expected_report_by"]="2026-05-12T11:30:00Z"
        e["status"]="in_flight"
json.dump(d,open(p,"w"))
PY

t_run_tracker check >/dev/null
second=$(wc -l < "$DISPATCH_STATE_DIR/auto-reports.log")
if [ "$first" != "$second" ]; then
  echo "FAIL: AUTO_REPORT not idempotent (was $first, now $second)" >&2; exit 1
fi
echo "T10 PASS"
