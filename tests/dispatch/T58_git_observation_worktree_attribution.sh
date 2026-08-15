#!/usr/bin/env bash
# T58 — the git evidence snapshot must NOT misattribute the shared cwd's main HEAD
# to a worker (#718). Observed live: worker in worktree ~/.aigentry/worktrees/fix716
# (branch fix/716-…, unpushed) was credited with sha=a0303a1 — the ORCHESTRATOR's
# own just-landed MERGE COMMIT ON MAIN in the shared checkout, not the worker's work.
#
# Root cause: the git check read `git -C <cwd> rev-parse HEAD`, and cwd pointed at
# the shared main checkout whose HEAD the orchestrator advances.
#
# FIX under test:
#   A) When the only resolvable git context is a mainline checkout (main/master),
#      OMIT the sha/files entirely and report screen-state only (honest degradation —
#      a worker never commits to main; see install_worker_git_guard).
#   B) A worker on its own (non-main) branch still records a sha (no over-omit).
#   C) A dispatch-recorded --worktree restores correct attribution even when cwd is on
#      main: the tracker reads the worker's HEAD in the worktree, not cwd's main HEAD.
#
# HERMETIC: git/telepty stubbed; commit qualifies via configured author email.
# TDD: RED before the guard exists (case A cites sha=abc1234, the main HEAD).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T58]: $*" >&2; exit 1; }

# Qualifying screen (done → reaches git path) + a claude-authored commit (the
# orchestrator's own merge commit, landed in the shared checkout).
cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'a0303a1\tclaude-bot@example.com\tchore(release): merge to main\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 4 files changed, 108 insertions(+), 27 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"
mkdir -p "$T_TMP/.git"

t_stub_v2_observations

reset_logs() {
  t_init_v2
  : > "$DISPATCH_STATE_DIR/observations.log"
  : > "$DISPATCH_STATE_DIR/observations.seen"
  : > "$DISPATCH_STATE_DIR/alerts.log"
}

# seed_wt <sid> <cwd> <worktree> — check-eligible open dispatch, optional worktree.
#
# #900 — the ${extra[@]+...} form is bash 3.2 compatibility, not style. Under `set -u`,
# bash 3.2 treats "${extra[@]}" on an EMPTY array as an unbound variable and aborts;
# 4.4+ expands it to nothing. macos-latest ships bash 3.2 as /bin/bash, so the first
# time this guard ran anywhere but a box with a modern bash first on PATH, it died at
# this line — case A calls seed_wt with no worktree.
seed_wt() {
  local -a extra=()
  [ -n "${3:-}" ] && extra=(worktree="$3")
  t_seed_dispatch "$1" cwd="$2" transport.inject_id="uuid-$1" \
    expected_report_by="2026-05-12T11:30:00Z" ${extra[@]+"${extra[@]}"}
}

# ── A) cwd on main, no worktree → sha OMITTED (never cite the orchestrator's HEAD) ──
reset_logs
STUB_GIT_BRANCH_FILE="$T_TMP/branch-main.txt"; printf 'main' > "$STUB_GIT_BRANCH_FILE"
export STUB_GIT_BRANCH_FILE
seed_wt sid-A "$T_TMP"
t_run_tracker check >/dev/null
if grep -q 'abc1234\|a0303a1' "$DISPATCH_STATE_DIR/observations.log" 2>/dev/null; then
  fail "A: snapshot cited a sha for a worker whose only context is cwd-on-main (misattribution). log:
$(cat "$DISPATCH_STATE_DIR/observations.log")"
fi
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"attribution": "omitted"'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'sha=omitted'
t_assert_observation sid-A worktree_activity_observed
t_assert_outcome_unknown sid-A

# ── B) worker on its OWN feature branch → AUTO_REPORT fires WITH sha (no over-omit) ──
reset_logs
printf 'fix/716-713-submit-path' > "$STUB_GIT_BRANCH_FILE"
seed_wt sid-B "$T_TMP"
t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"head_sha": "abc1234"'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'sha=abc1234'
t_assert_outcome_unknown sid-B

# ── C) cwd on main BUT --worktree recorded on a feature branch → attribution restored ──
reset_logs
unset STUB_GIT_BRANCH_FILE
mkdir -p "$T_TMP/wt/.git"
printf 'main' > "$T_TMP/.stub-branch"                       # shared cwd is on main
printf 'fix/716-713-submit-path' > "$T_TMP/wt/.stub-branch" # worker's worktree is on its branch
seed_wt sid-C "$T_TMP" "$T_TMP/wt"
t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/observations.log" '"head_sha": "abc1234"'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'sha=abc1234'
t_assert_outcome_unknown sid-C

# ── D) begin-delivery records the worktree on the record (dispatch plumbing) ──
reset_logs
t_registry begin-delivery --sid sid-D --ref-hash hD --ref-path /tmp/r --track T7 \
  --role coder --cwd /tmp/main --worktree /tmp/wt --branch fix/x >/dev/null
got=$(t_v2 sid-D worktree)
[ "$got" = "/tmp/wt" ] || fail "D: begin-delivery did not record worktree (got '$got', want /tmp/wt)"

echo "T58 PASS"
