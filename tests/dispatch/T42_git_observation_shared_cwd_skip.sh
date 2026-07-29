#!/usr/bin/env bash
# T42 — the git evidence snapshot must NOT fire when 2+ open dispatches share the
# same (cwd, branch) (#541). Root cause (confirmed in logs): canary-a-probe was
# credited with sha=7a8165a, but that commit was fix-a's work — commit→session is
# mapped by cwd + author-email/claude-trailer + rev-parse HEAD, with NO
# per-session key, so when 2 sessions share cwd AND author AND branch none can be
# discriminated.
#
# FIX under test (PRIMARY, surgical): before attribution, count open dispatches
# sharing this sid's (cwd, branch); if >1, SKIP the snapshot (no-op). telepty#60
# Stage A additionally strips this path of any outcome authority — it is now
# evidence for a human either way.
#
# HERMETIC: git/telepty stubbed; commit qualifies via configured author email.
# TDD: RED before the guard exists (both shared-cwd entries get AUTO_REPORTed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T42]: $*" >&2; exit 1; }

# Qualifying screen (done, not active → reaches the git path) + a real authored commit.
cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 3 files changed, 120 insertions(+), 10 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"
mkdir -p "$T_TMP/.git"
# Both sessions appear CONNECTED so neither is short-circuited as DISCONNECTED.
printf '%s' '[{"id":"sid-A","healthStatus":"CONNECTED"},{"id":"sid-B","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"

# The daemon half must answer properly, or named absence blocks the evidence
# chain before the ambiguity guard is ever reached.
t_stub_v2_observations

reset_logs() {
  t_init_v2
  : > "$DISPATCH_STATE_DIR/observations.log"
  : > "$DISPATCH_STATE_DIR/observations.seen"
}

# seed_entry_branch <sid> <cwd> <branch>
seed_entry_branch() {
  t_seed_dispatch "$1" cwd="$2" branch="$3" transport.inject_id="uuid-$1" \
    expected_report_by="2026-05-12T11:30:00Z"
}

# ── A) AMBIGUOUS: two open dispatches, same cwd + same (empty) branch → NO snapshot ──
reset_logs
seed_entry_branch sid-A "$T_TMP" ""
seed_entry_branch sid-B "$T_TMP" ""
t_run_tracker check >/dev/null
if grep -q '"kind": "WORKTREE_ACTIVITY"' "$DISPATCH_STATE_DIR/observations.log" 2>/dev/null; then
  fail "A: evidence snapshot emitted despite 2 sessions sharing cwd (misattribution). log:
$(cat "$DISPATCH_STATE_DIR/observations.log")"
fi
t_assert_outcome_unknown sid-A
t_assert_outcome_unknown sid-B

# ── B) CONTROL (single session, same cwd) → snapshot MUST fire (no over-skip) ──
reset_logs
seed_entry_branch sid-A "$T_TMP" ""
t_run_tracker check >/dev/null
grep -q '"kind": "WORKTREE_ACTIVITY"' "$DISPATCH_STATE_DIR/observations.log" 2>/dev/null \
  || fail "B: snapshot did NOT fire for a single unambiguous session (over-skip). log:
$(cat "$DISPATCH_STATE_DIR/observations.log" 2>/dev/null || true)"
t_assert_observation sid-A worktree_activity_observed
t_assert_outcome_unknown sid-A

# ── C) DISTINCT BRANCHES, same cwd → NOT ambiguous → snapshot fires (key includes branch) ──
reset_logs
seed_entry_branch sid-A "$T_TMP" feature/a
seed_entry_branch sid-B "$T_TMP" feature/b
t_run_tracker check >/dev/null
grep -q '"kind": "WORKTREE_ACTIVITY"' "$DISPATCH_STATE_DIR/observations.log" 2>/dev/null \
  || fail "C: snapshot did NOT fire for same-cwd but DISTINCT-branch sessions (branch not in key). log:
$(cat "$DISPATCH_STATE_DIR/observations.log" 2>/dev/null || true)"

echo "T42 PASS"
