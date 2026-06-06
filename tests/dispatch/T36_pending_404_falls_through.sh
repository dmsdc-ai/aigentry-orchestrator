#!/usr/bin/env bash
# T36 — #528: a 404 from GET /api/pendingReports/:sid (pending cleared/dead —
# e.g. TASK_DEAD_NO_REPORT deletes before broadcast, or the report landed) yields
# NO AUTO_HOLD and falls through to the existing #517 git path. Here the worker is
# gone+committed → AUTO_REPORT still fires. Hermetic — curl shim returns 404.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_CURL_FAIL:-0}" = "1" ] && exit 7
for a in "$@"; do [ "$a" = "DELETE" ] && exit 0; done
cat "${STUB_PENDING_FILE:-/dev/null}"
printf '\n%s' "${STUB_PENDING_HTTP:-200}"
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl"
export STUB_PENDING_HTTP=404
export STUB_PENDING_FILE=/dev/null

# #517 preconditions: done screen + an authored commit so the git path qualifies.
cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 3 files changed, 120 insertions(+), 10 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"

t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"
mkdir -p "$T_TMP/.git"

t_run_tracker check >/dev/null

# 404 → no AUTO_HOLD …
if grep -qF 'AUTO_HOLD' "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null; then
  echo "FAIL: 404 must not produce AUTO_HOLD" >&2; cat "$DISPATCH_STATE_DIR/auto-reports.log" >&2; exit 1
fi
# … but the #517 git path STILL runs.
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"kind": "AUTO_REPORT"'
t_assert_status sid-A auto_reported

echo "T36 PASS"
