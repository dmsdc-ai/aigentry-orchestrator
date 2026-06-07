#!/usr/bin/env bash
# T40 — bin/orchestrator-boot.sh singleton guard (#539).
# HERMETIC: the guard is sourced (main NOT exec'd) and driven with a STUBBED
# process lister (SINGLETON_PS_CMD → fixture table), a STUBBED killer (KILL_CMD →
# call recorder) and an overridable SINGLETON_SELF_PID. NO real process is ever
# listed or killed. Asserts:
#   A) two bridges (one self-ancestor + one stale) → ONLY the non-self one is
#      kill -9'd; ancestor bridge (grandparent) survives (kill-self belt).
#   B) zero bridges → no-op.
#   C) one bridge == self → no-op.
#   D) ORCH_SID configurable (ORCHESTRATOR_SID) → only the matching sid killed.
#   E) signal is ALWAYS -9, NEVER -TERM/-15.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BOOT="$REPO_ROOT/bin/orchestrator-boot.sh"

fail() { echo "FAIL[T40]: $*" >&2; exit 1; }

# --- stub: process lister. Ignores args, prints the fixture table file. --------
PS_TABLE="$T_TMP/ps-table.txt"
PS_STUB="$STUB_BIN/ps-stub.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
cat "$PS_TABLE"
EOF
chmod +x "$PS_STUB"

# --- stub: kill recorder. Appends args, exits 0 (simulates successful kill). ---
KILL_LOG="$T_TMP/kill-calls.log"
KILL_STUB="$STUB_BIN/kill-stub.sh"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$KILL_STUB"

# Source the guard once (main does NOT run when sourced).
SINGLETON_PS_CMD="$PS_STUB"
KILL_CMD="$KILL_STUB"
# shellcheck disable=SC1090
source "$BOOT"
# Re-pin the seams to our stubs (the script set them from env at source time).
SINGLETON_PS_CMD="$PS_STUB"
KILL_CMD="$KILL_STUB"

run_guard() { : > "$KILL_LOG"; orchestrator_singleton_guard; }

B="node telepty allow --id orchestrator claude --dangerously-skip-permissions --continue"

# ===========================================================================
# A) two bridges: 1111 is a SELF ANCESTOR (grandparent), 4444 is STALE.
#    ancestry(3333) = 3333→2222→1111. Only 4444 must be SIGKILLed.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
3333 2222 bash $BOOT
2222 1111 node claude
1111 1 $B
4444 1 $B
5555 1 node some-unrelated-daemon
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="3333"
run_guard
grep -qw 4444 "$KILL_LOG" || fail "A: stale bridge 4444 not killed; log: $(cat "$KILL_LOG")"
grep -qw 1111 "$KILL_LOG" && fail "A: self-ANCESTOR bridge 1111 was killed (kill-self belt broken!)"
grep -qw 5555 "$KILL_LOG" && fail "A: unrelated process 5555 killed (over-match)"
grep -q -- '-9' "$KILL_LOG" || fail "A: signal not -9; log: $(cat "$KILL_LOG")"
[ "$(grep -c . "$KILL_LOG")" = "1" ] || fail "A: expected exactly 1 kill; log: $(cat "$KILL_LOG")"

# ===========================================================================
# B) zero bridges → no kill.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
9999 1 bash
8888 1 node unrelated
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="9999"
run_guard
[ -s "$KILL_LOG" ] && fail "B: kill invoked with zero bridges; log: $(cat "$KILL_LOG")"

# ===========================================================================
# C) one bridge == self → no kill.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
1111 1 $B
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="1111"
run_guard
[ -s "$KILL_LOG" ] && fail "C: self bridge killed (must no-op); log: $(cat "$KILL_LOG")"

# ===========================================================================
# D) configurable sid: ORCH_SID=custom-orch → kill ONLY the custom-orch bridge,
#    leave the default 'orchestrator' bridge untouched (Rule 16).
# ===========================================================================
cat > "$PS_TABLE" <<EOF
4444 1 node telepty allow --id custom-orch claude --continue
5555 1 node telepty allow --id orchestrator claude --continue
EOF
ORCH_SID="custom-orch"; SINGLETON_SELF_PID="9999"
run_guard
grep -qw 4444 "$KILL_LOG" || fail "D: custom-orch bridge 4444 not killed; log: $(cat "$KILL_LOG")"
grep -qw 5555 "$KILL_LOG" && fail "D: non-matching sid bridge 5555 killed (sid match too loose)"

# ===========================================================================
# E) signal is ALWAYS -9, NEVER -TERM/-15 (re-run A and inspect every call).
# ===========================================================================
cat > "$PS_TABLE" <<EOF
4444 1 $B
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="9999"
run_guard
grep -qE -- '-TERM|-15|-SIGTERM' "$KILL_LOG" && fail "E: SIGTERM used (cascades DELETE!); log: $(cat "$KILL_LOG")"
grep -q -- '-9' "$KILL_LOG" || fail "E: SIGKILL (-9) not used; log: $(cat "$KILL_LOG")"

echo "T40 PASS"
