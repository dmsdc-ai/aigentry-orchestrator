#!/usr/bin/env bash
# T36 — REVERSED by telepty#60 Stage A. A 404 from the observation endpoint used
# to fall through to the screen/git chain and settle the dispatch as
# auto_reported. 404 is not a task state: it is named absence, so the tracker
# HOLDs, keeps polling, and takes NO evidence fallback — even though the worker
# here looks maximally "done" (prompt on screen plus an authored commit).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
cat /dev/null
printf '\n404'
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl"

# The strongest legacy "completion" evidence there is.
cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 3 files changed, 120 insertions(+), 10 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"

t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-111 \
  expected_report_by="2026-05-12T11:30:00Z"
mkdir -p "$T_TMP/.git"

t_run_tracker check >/dev/null

t_assert_observation sid-A tracking_unavailable
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'HOLD sid=sid-A'
t_refute_observation sid-A worktree_activity_observed
t_assert_outcome_unknown sid-A
t_assert_lifecycle sid-A delivery_attempt_started

echo "T36 PASS"
