#!/usr/bin/env bash
# T8 — a prompt-like screen plus a new authored commit produces a nonterminal
# EVIDENCE SNAPSHOT, not a completion. telepty#60 Stage A: this path used to
# write the terminal status auto_reported, attributing an uncorrelated commit in
# a directory to a session that never reported anything.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 3 files changed, 120 insertions(+), 10 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"

t_stub_v2_observations
t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-1 \
  expected_report_by="2026-05-12T11:30:00Z"
# cwd doesn't need to be a real repo because the git stub responds.
mkdir -p "$T_TMP/.git"

t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"kind": "WORKTREE_ACTIVITY"'
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"sid": "sid-A"'
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"completion_fact": null'
t_assert_observation sid-A worktree_activity_observed
# The dispatch is NOT settled and is NOT taken out of the poll set.
t_assert_outcome_unknown sid-A
t_assert_lifecycle sid-A delivery_attempt_started
echo "T8 PASS"
