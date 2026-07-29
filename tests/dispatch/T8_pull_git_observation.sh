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

# --- the scraped test result names what it scraped, and can actually see it ---
# A3 (#810): the field measures "a runner summary on the visible screen", not
# "what the commit contains". It was blind to BOTH runners this ecosystem uses,
# so it reported the equivalent of "no tests" on three real test-carrying commits
# in one day. Each form below must be matched, and no match must read as
# `unmatched` rather than as a claim about the change.
scrape() {
  local screen="$1" want="$2"
  t_init_v2
  : > "$DISPATCH_STATE_DIR/observations.log"; : > "$DISPATCH_STATE_DIR/observations.seen"
  printf '%s\n' "$screen" > "$STUB_SCREEN_FILE"
  printf '\n\u276f\n' >> "$STUB_SCREEN_FILE"     # prompt, so the git arm is reached
  t_seed_dispatch sid-S cwd="$T_TMP" transport.inject_id=uuid-1 \
    expected_report_by="2026-05-12T11:30:00Z"
  t_run_tracker check >/dev/null
  local got
  got=$(python3 -c '
import json, sys
rec = [r for r in json.load(open(sys.argv[1]))["dispatches"]
       if r["assigned"]["sid"] == "sid-S"][0]
obs = [o for o in rec["observations"] if o["kind"] == "worktree_activity_observed"]
print(obs[0].get("test_result_scraped", "<missing>") if obs else "<no-snapshot>")
' "$DISPATCH_STATE_DIR/active.json")
  [ "$got" = "$want" ] || {
    echo "FAIL: test_result_scraped=$got, want $want (screen: $screen)" >&2; exit 1; }
}

scrape 'passed: 68  failed: 0' 'passed: 68  failed: 0'   # tests/dispatch/run-all.sh
scrape '# pass 68'             '# pass 68'               # node --test TAP
scrape '# fail 0'              '# fail 0'                # node --test TAP
scrape '9 passed, 0 failed'    '9 passed / 0 failed'     # vitest / jest
scrape 'Implementation done.'  'unmatched'               # nothing to scrape

echo "T8 PASS"
