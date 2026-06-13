#!/usr/bin/env bash
# T57 (#620, #618 recurrence) — bin/orchestrator-bridge-auditor.sh detect-and-WARN.
#
# The belt of the two-layer singleton defense. A raw orchestrator restart (bare
# `telepty allow`, bypassing bin/orchestrator-boot.sh) leaves a stale duplicate
# `--id orchestrator` bridge alive; telepty's idempotent --id register keeps
# routing every inject to the stale registered-first owner → worker REPORTs
# vanish silently (#618). This auditor, wired into the reconcile tick (step 0d),
# DETECTS >1 live bridge and pushes a HOLD inject to the orchestrator naming the
# bridge PIDs + the `kill -9` remedy. It NEVER kills (orchestrator bridge
# cleanup is USER-ONLY, #606) — warn-mode, mirroring session-comms-auditor.sh.
#
# HERMETIC: process lister STUBBED (SINGLETON_PS_CMD → fixture table); telepty
# STUBBED (inject captured to $STUB_DISPATCH_LOG); state under $T_TMP. NO real
# process is ever listed or killed. TDD: RED before the auditor exists.
#
# Asserts:
#   A) two bridges → exactly ONE HOLD inject to orchestrator naming BOTH pids +
#      `kill -9`; the oldest pid is flagged likely-stale.
#   B) one bridge  → silent no-op (no inject).
#   C) zero bridges → no-op.
#   D) sid precision → `--id orchestrator-2 ` does NOT count as `orchestrator`.
#   E) warn-NOT-kill → a kill recorder stub records ZERO calls (#606 invariant).
#   F) act-only → under --dry-run, detection logs but NO inject is sent.
#   G) ORCH_SID configurable (ORCHESTRATOR_SID) → only matching sid counted.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
AUDITOR="$REPO_ROOT/bin/orchestrator-bridge-auditor.sh"

fail() { echo "FAIL[T57]: $*" >&2; exit 1; }

# --- stub: process lister. Ignores args, prints the fixture table file. --------
PS_TABLE="$T_TMP/ps-table.txt"
PS_STUB="$STUB_BIN/ps-stub.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
cat "$PS_TABLE"
EOF
chmod +x "$PS_STUB"

# --- stub: kill recorder. Must stay EMPTY — the auditor never kills (E/#606). --
KILL_LOG="$T_TMP/kill-calls.log"
KILL_STUB="$STUB_BIN/kill"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$KILL_STUB"
: > "$KILL_LOG"

export SINGLETON_PS_CMD="$PS_STUB"
# `telepty` + STUB_DISPATCH_LOG come from lib.sh; auditor uses $TELEPTY.

B="node telepty allow --id orchestrator claude --dangerously-skip-permissions --continue"

run() { : > "$STUB_DISPATCH_LOG"; "$AUDITOR" "$@"; }

# ===========================================================================
# A) two orchestrator bridges (50349 = 2-day-old STALE, 74838 = fresh live) →
#    exactly ONE HOLD inject naming both pids + kill -9; oldest (50349) flagged.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
99999 01:02:03 node some-unrelated-daemon
EOF
run >/dev/null 2>&1 || fail "A: auditor exited non-zero"
t_assert_contains "$STUB_DISPATCH_LOG" "orchestrator"
t_assert_contains "$STUB_DISPATCH_LOG" "HOLD"
t_assert_contains "$STUB_DISPATCH_LOG" "50349"
t_assert_contains "$STUB_DISPATCH_LOG" "74838"
t_assert_contains "$STUB_DISPATCH_LOG" "kill -9"
# exactly ONE inject line for the duplicate (not one-per-pid)
n_inj=$(grep -c "telepty inject" "$STUB_DISPATCH_LOG" 2>/dev/null || echo 0)
[ "$n_inj" -eq 1 ] || fail "A: expected exactly 1 HOLD inject, got $n_inj; log: $(cat "$STUB_DISPATCH_LOG")"
# oldest pid flagged as the likely-stale candidate
grep -Eq "(stale|oldest)[^0-9]*50349|50349[^0-9]*(stale|oldest)" "$STUB_DISPATCH_LOG" \
  || fail "A: oldest pid 50349 not flagged as likely-stale; log: $(cat "$STUB_DISPATCH_LOG")"

# ===========================================================================
# B) one bridge → silent no-op (no inject).
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 00:05:23 $B
99999 01:02:03 node unrelated
EOF
run >/dev/null 2>&1 || fail "B: auditor exited non-zero"
[ -s "$STUB_DISPATCH_LOG" ] && fail "B: lone bridge produced an inject (must no-op); log: $(cat "$STUB_DISPATCH_LOG")"

# ===========================================================================
# C) zero bridges → no-op.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
8888 1-00:00:00 bash
9999 00:00:01 node unrelated
EOF
run >/dev/null 2>&1 || fail "C: auditor exited non-zero"
[ -s "$STUB_DISPATCH_LOG" ] && fail "C: inject with zero bridges; log: $(cat "$STUB_DISPATCH_LOG")"

# ===========================================================================
# D) sid precision: one `--id orchestrator ` + one `--id orchestrator-2 ` →
#    counts as ONE orchestrator bridge (trailing-space marker) → no inject.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 00:05:23 $B
60001 00:01:00 node telepty allow --id orchestrator-2 claude --continue
EOF
run >/dev/null 2>&1 || fail "D: auditor exited non-zero"
[ -s "$STUB_DISPATCH_LOG" ] && fail "D: orchestrator-2 wrongly counted (sid match too loose); log: $(cat "$STUB_DISPATCH_LOG")"

# ===========================================================================
# E) warn-NOT-kill: with two bridges, the auditor NEVER invokes kill (#606).
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF
: > "$KILL_LOG"
run >/dev/null 2>&1 || fail "E: auditor exited non-zero"
[ -s "$KILL_LOG" ] && fail "E: auditor invoked kill (orchestrator bridge cleanup is USER-ONLY); log: $(cat "$KILL_LOG")"

# ===========================================================================
# F) act-only: under --dry-run, duplicate is detected/logged but NO inject sent.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF
run --dry-run >/dev/null 2>&1 || fail "F: auditor --dry-run exited non-zero"
[ -s "$STUB_DISPATCH_LOG" ] && fail "F: --dry-run sent an inject (must be act-only); log: $(cat "$STUB_DISPATCH_LOG")"

# ===========================================================================
# G) configurable sid: ORCHESTRATOR_SID=custom-orch → count only custom-orch
#    bridges; the default `orchestrator` bridge is ignored.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
70001 01:00:00 node telepty allow --id custom-orch claude --continue
70002 00:10:00 node telepty allow --id custom-orch claude --continue
50349 00:05:23 $B
EOF
ORCHESTRATOR_SID="custom-orch" run >/dev/null 2>&1 || fail "G: auditor exited non-zero"
t_assert_contains "$STUB_DISPATCH_LOG" "70001"
t_assert_contains "$STUB_DISPATCH_LOG" "70002"
grep -qw 50349 "$STUB_DISPATCH_LOG" && fail "G: non-matching sid bridge 50349 named (sid override leaked)"

echo "T57 PASS"
