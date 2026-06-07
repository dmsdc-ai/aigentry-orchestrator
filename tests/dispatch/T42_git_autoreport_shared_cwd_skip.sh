#!/usr/bin/env bash
# T42 — git-poll AUTO_REPORT must NOT fire when 2+ active (in_flight/re_dispatched)
# entries share the same (cwd, branch) (#541). Root cause (confirmed in logs):
# canary-a-probe AUTO_REPORTed sha=7a8165a, but that commit was fix-a's work —
# `_has_new_commits` + `_git_check_and_autoreport` map commit→session by
# cwd + author-email/claude-trailer + rev-parse HEAD, with NO per-session key, so
# when 2 sessions share cwd AND author AND branch none can be discriminated.
#
# FIX under test (PRIMARY, surgical): before attribution count active.json entries
# sharing this sid's (cwd, branch); if >1, SKIP the git-AUTO_REPORT (no-op). The
# pendingReports/idle path is unaffected.
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

reset_logs() {
  printf '[]\n' > "$DISPATCH_STATE_DIR/active.json"
  : > "$DISPATCH_STATE_DIR/auto-reports.log"
  : > "$DISPATCH_STATE_DIR/auto-reports.seen"
}

# seed_entry_branch <sid> <cwd> <branch> — like t_seed_entry but with a branch field.
seed_entry_branch() {
  python3 - "$DISPATCH_STATE_DIR/active.json" "$1" "$2" "$3" <<'PY'
import json,sys
path,sid,cwd,branch=sys.argv[1:5]
data=json.load(open(path))
data.append({"sid":sid,"ref_path":"/tmp/r","ref_hash":"x",
             "dispatched_at":"2026-05-12T11:00:00Z","expected_report_by":"2026-05-12T11:30:00Z",
             "last_seen_at":"2026-05-12T11:00:00Z","status":"in_flight",
             "classification_history":[],"cwd":cwd,"branch":branch,
             "from_sid":"orchestrator","re_dispatch_count":0})
json.dump(data,open(path,"w"),indent=2)
PY
}

# ── A) AMBIGUOUS: two in_flight entries, same cwd + same (empty) branch → NO AUTO_REPORT ──
reset_logs
t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"
t_seed_entry sid-B "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"
t_run_tracker check >/dev/null
if grep -q '"kind": "AUTO_REPORT"' "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null; then
  fail "A: AUTO_REPORT emitted despite 2 sessions sharing cwd (misattribution). log:
$(cat "$DISPATCH_STATE_DIR/auto-reports.log")"
fi
t_assert_status sid-A in_flight
t_assert_status sid-B in_flight

# ── B) CONTROL (single session, same cwd) → AUTO_REPORT MUST fire (no over-skip) ──
reset_logs
t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"
t_run_tracker check >/dev/null
grep -q '"kind": "AUTO_REPORT"' "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null \
  || fail "B: AUTO_REPORT did NOT fire for a single unambiguous session (over-skip). log:
$(cat "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null || true)"
t_assert_status sid-A auto_reported

# ── C) DISTINCT BRANCHES, same cwd → NOT ambiguous → AUTO_REPORT fires (key includes branch) ──
reset_logs
seed_entry_branch sid-A "$T_TMP" feature/a
seed_entry_branch sid-B "$T_TMP" feature/b
t_run_tracker check >/dev/null
grep -q '"kind": "AUTO_REPORT"' "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null \
  || fail "C: AUTO_REPORT did NOT fire for same-cwd but DISTINCT-branch sessions (branch not in key). log:
$(cat "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null || true)"

echo "T42 PASS"
