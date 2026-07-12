#!/usr/bin/env bash
# T58 — pull-fallback AUTO_REPORT must NOT misattribute the shared cwd's main HEAD to
# a worker (#718). Observed live: worker in worktree ~/.aigentry/worktrees/fix716
# (branch fix/716-…, unpushed) got AUTO_REPORT sha=a0303a1 — the ORCHESTRATOR's own
# just-landed MERGE COMMIT ON MAIN in the shared checkout, not the worker's work.
#
# Root cause: _git_check_and_autoreport read `git -C <cwd> rev-parse HEAD`, and cwd
# pointed at the shared main checkout whose HEAD the orchestrator advances.
#
# FIX under test:
#   A) When the only resolvable git context is a mainline checkout (main/master),
#      OMIT the sha/files entirely and report screen-state only (honest degradation —
#      a worker never commits to main; see install_worker_git_guard).
#   B) A worker on its own (non-main) branch still AUTO_REPORTs WITH a sha (no over-omit).
#   C) A dispatch-recorded --worktree restores correct attribution even when cwd is on
#      main: the tracker reads the worker's HEAD in the worktree, not cwd's main HEAD.
#
# HERMETIC: git/telepty stubbed; commit qualifies via configured author email.
# TDD: RED before the guard exists (case A AUTO_REPORTs sha=abc1234, the main HEAD).
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

reset_logs() {
  printf '[]\n' > "$DISPATCH_STATE_DIR/active.json"
  : > "$DISPATCH_STATE_DIR/auto-reports.log"
  : > "$DISPATCH_STATE_DIR/auto-reports.seen"
  : > "$DISPATCH_STATE_DIR/alerts.log"
}

# seed_wt <sid> <cwd> <worktree> — check-eligible in_flight entry, optional worktree.
seed_wt() {
  python3 - "$DISPATCH_STATE_DIR/active.json" "$1" "$2" "${3:-}" <<'PY'
import json,sys
path,sid,cwd,wt=sys.argv[1:5]
data=json.load(open(path))
e={"sid":sid,"ref_path":"/tmp/r","ref_hash":"x",
   "dispatched_at":"2026-05-12T11:00:00Z","expected_report_by":"2026-05-12T11:30:00Z",
   "last_seen_at":"2026-05-12T11:00:00Z","status":"in_flight",
   "classification_history":[],"cwd":cwd,"from_sid":"orchestrator","re_dispatch_count":0}
if wt: e["worktree"]=wt
data.append(e)
json.dump(data,open(path,"w"),indent=2)
PY
}

# ── A) cwd on main, no worktree → sha OMITTED (never cite the orchestrator's HEAD) ──
reset_logs
STUB_GIT_BRANCH_FILE="$T_TMP/branch-main.txt"; printf 'main' > "$STUB_GIT_BRANCH_FILE"
export STUB_GIT_BRANCH_FILE
seed_wt sid-A "$T_TMP"
t_run_tracker check >/dev/null
if grep -q 'abc1234\|a0303a1' "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null; then
  fail "A: AUTO_REPORT cited a sha for a worker whose only context is cwd-on-main (misattribution). log:
$(cat "$DISPATCH_STATE_DIR/auto-reports.log")"
fi
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"attribution": "omitted"'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'sha=omitted'
t_assert_status sid-A auto_reported

# ── B) worker on its OWN feature branch → AUTO_REPORT fires WITH sha (no over-omit) ──
reset_logs
printf 'fix/716-713-submit-path' > "$STUB_GIT_BRANCH_FILE"
seed_wt sid-B "$T_TMP"
t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"head_sha": "abc1234"'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'sha=abc1234'
t_assert_status sid-B auto_reported

# ── C) cwd on main BUT --worktree recorded on a feature branch → attribution restored ──
reset_logs
unset STUB_GIT_BRANCH_FILE
mkdir -p "$T_TMP/wt/.git"
printf 'main' > "$T_TMP/.stub-branch"                       # shared cwd is on main
printf 'fix/716-713-submit-path' > "$T_TMP/wt/.stub-branch" # worker's worktree is on its branch
seed_wt sid-C "$T_TMP" "$T_TMP/wt"
t_run_tracker check >/dev/null
t_assert_contains "$DISPATCH_STATE_DIR/auto-reports.log" '"head_sha": "abc1234"'
t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" 'sha=abc1234'
t_assert_status sid-C auto_reported

# ── D) `register --worktree` records the worktree onto the entry (dispatch plumbing) ──
reset_logs
t_run_tracker register sid-D --track T7 --role coder --cwd /tmp/main --worktree /tmp/wt --branch fix/x >/dev/null
got=$(t_field sid-D worktree)
[ "$got" = "/tmp/wt" ] || fail "D: register did not record worktree (got '$got', want /tmp/wt)"

echo "T58 PASS"
