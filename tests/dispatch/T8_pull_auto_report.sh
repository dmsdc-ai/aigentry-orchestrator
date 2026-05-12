#!/usr/bin/env bash
# T8 — done class + new authored commit triggers AUTO_REPORT log entry.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

# done state on screen
cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
# git log: one commit by configured user email → qualifies
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 3 files changed, 120 insertions(+), 10 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"
# cwd doesn't need to be a real repo because the git stub responds.
mkdir -p "$T_TMP/.git"

t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"kind": "AUTO_REPORT"'
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"sid": "sid-A"'
t_assert_status sid-A auto_reported
echo "T8 PASS"
