#!/usr/bin/env bash
# T52 — session-cleanup.sh must refuse to SIGTERM a parent telepty-allow PID that
# lives in the orchestrator's OWN process tree (#606, cleanup-side of #539).
#
# Root cause (2026-06-13 pub-063): a worker spawned surface-less (forbidden) has
# its `telepty allow --id <sid>` process inside the control tower's process tree.
# kill_parent_telepty_allow SIGTERMed it unconditionally → the DELETE 'Session
# destroyed' cascade hit the live orchestrator. The PROTECTED_SID string guard
# only matched the literal sid "orchestrator", never PID lineage.
#
# FIX under test: pid_is_self_or_ancestor() + a kill-time guard. ps + kill + self
# pid are injected via seams (CLEANUP_PS_CMD / KILL_CMD / CLEANUP_SELF_PID), so
# NO real process is ever signalled (Rule: 실프로세스 kill 테스트 금지).
#
# TDD: RED before the helper + seams + guard exist.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"

fail() { echo "FAIL[T52]: $*" >&2; exit 1; }

# ── kill recorder seam: logs every `kill` invocation, never signals anything ──
KILL_LOG="$T_TMP/kill-calls.log"; : > "$KILL_LOG"
KILL_STUB="$STUB_BIN/kill-recorder.sh"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$KILL_STUB"

# ── ps snapshot seam: prints a controlled "pid ppid command" table from a file ──
PS_SNAP="$T_TMP/ps-snapshot.txt"
PS_STUB="$STUB_BIN/ps-recorder.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
cat "$PS_SNAP"
EOF
chmod +x "$PS_STUB"

# Source the script (NOT execute) to call functions directly. Requires the
# sourceable guard at the bottom of session-cleanup.sh.
# shellcheck source=/dev/null
CLEANUP_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB" source "$CLEANUP"

run_kill() {
  # run_kill <self_pid> <sid> — exercise kill_parent_telepty_allow with seams.
  : > "$KILL_LOG"
  CLEANUP_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB" CLEANUP_SELF_PID="$1" \
    kill_parent_telepty_allow "$2" >/dev/null 2>&1
}

# ── (a) SELF: the allow PID equals the cleanup process itself → refuse kill ──
cat > "$PS_SNAP" <<'EOF'
100 1 /sbin/launchd
200 100 telepty allow --id self-sid claude --continue
EOF
run_kill 200 self-sid \
  || fail "a: kill_parent_telepty_allow returned non-zero (should skip & continue)"
[ ! -s "$KILL_LOG" ] \
  || fail "a: SIGTERM fired on SELF allow PID 200 — guard failed. kill log: $(cat "$KILL_LOG")"

# ── (b) ANCESTOR: the allow PID is an ancestor of self → refuse kill ──
cat > "$PS_SNAP" <<'EOF'
100 1 /sbin/launchd
200 100 telepty allow --id anc-sid claude --continue
400 200 bash session-cleanup.sh
EOF
run_kill 400 anc-sid \
  || fail "b: kill_parent_telepty_allow returned non-zero (should skip & continue)"
[ ! -s "$KILL_LOG" ] \
  || fail "b: SIGTERM fired on ANCESTOR allow PID 200 — guard failed. kill log: $(cat "$KILL_LOG")"

# ── (c) UNRELATED: a normal cmux-spawned worker outside the tree → normal kill ──
cat > "$PS_SNAP" <<'EOF'
100 1 /sbin/launchd
200 100 claude (orchestrator)
400 200 bash session-cleanup.sh
999 100 cmux-pane-host
600 999 telepty allow --id ok-sid claude --continue
EOF
run_kill 400 ok-sid \
  || fail "c: kill_parent_telepty_allow returned non-zero on the normal kill path"
grep -qx -- "-TERM 600" "$KILL_LOG" \
  || fail "c: normal worker allow PID 600 NOT killed — guard over-blocks (regression). kill log: $(cat "$KILL_LOG")"

# ── (d) ENV bridge PID: explicitly supplied orchestrator bridge PID → refuse ──
cat > "$PS_SNAP" <<'EOF'
100 1 /sbin/launchd
200 100 claude (orchestrator)
400 200 bash session-cleanup.sh
999 100 cmux-pane-host
600 999 telepty allow --id ok-sid claude --continue
EOF
: > "$KILL_LOG"
CLEANUP_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB" CLEANUP_SELF_PID="400" \
  ORCHESTRATOR_BRIDGE_PIDS="600" \
  kill_parent_telepty_allow ok-sid >/dev/null 2>&1 \
  || fail "d: kill_parent_telepty_allow returned non-zero (should skip & continue)"
[ ! -s "$KILL_LOG" ] \
  || fail "d: SIGTERM fired on env-declared bridge PID 600 — guard failed. kill log: $(cat "$KILL_LOG")"

# ── helper unit checks: pid_is_self_or_ancestor classification ──
cat > "$PS_SNAP" <<'EOF'
100 1 /sbin/launchd
200 100 claude (orchestrator)
400 200 bash session-cleanup.sh
EOF
CLEANUP_PS_CMD="$PS_STUB" CLEANUP_SELF_PID="400" pid_is_self_or_ancestor 400 \
  || fail "helper: self pid 400 not classified as self/ancestor"
CLEANUP_PS_CMD="$PS_STUB" CLEANUP_SELF_PID="400" pid_is_self_or_ancestor 200 \
  || fail "helper: ancestor pid 200 not classified as self/ancestor"
if CLEANUP_PS_CMD="$PS_STUB" CLEANUP_SELF_PID="400" pid_is_self_or_ancestor 777; then
  fail "helper: unrelated pid 777 misclassified as self/ancestor"
fi

echo "T52 PASS"
