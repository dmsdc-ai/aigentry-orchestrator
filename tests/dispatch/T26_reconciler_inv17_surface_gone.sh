#!/usr/bin/env bash
# T26 — session-reconciler.sh INV-17 double-gate (verdict 2026-05-30 §5):
#   * surface_gone ALONE -> candidate SKIPPED (no close; no mass-kill).
#   * surface_gone CORROBORATED by disconnect -> close fires (gate is real,
#     not a blanket "never close").
#   * DORMANT surface_orphaned JSONL consumer: source file ABSENT -> no-op,
#     reconciler runs clean (default + --dry-run).
# Stubs telepty/cmux/scheduler/cleanup; spawns ONE real alive process whose
# cmdline matches `telepty allow --id <sid> ` so the parent-PID probe finds a
# LIVE parent, isolating surface_gone as the sole sweep reason. NO prod edits.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown; [ -n "${ORPHAN_PID:-}" ] && kill "$ORPHAN_PID" 2>/dev/null || true' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"

fail() { echo "FAIL[T26]: $*" >&2; exit 1; }

NOW="2026-05-30T12:00:00Z"          # fixed clock
STARTED="2026-05-30T11:50:00Z"      # 600s old > 300s age floor
DISC_SEEN="2026-05-30T11:54:00Z"    # 360s disconnect age > 240s floor
SID="sid-orphan"

# --- stubs (reconciler prepends /usr/bin to PATH, so use env-injected paths) ---
SCHED_STUB="$STUB_BIN/sched-noop.sh"
cat > "$SCHED_STUB" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCHED_STUB"

CLEANUP_CALLS="$T_TMP/cleanup-calls.log"; : > "$CLEANUP_CALLS"
CLEANUP_STUB="$STUB_BIN/cleanup-stub.sh"
cat > "$CLEANUP_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CLEANUP_CALLS"
exit 0
EOF
chmod +x "$CLEANUP_STUB"

# cmux stub: list-workspaces --json returns [] -> ws-gone is NOT present ->
# _wh_cmux_alive(ws-gone) == gone (surface_gone signal).
cat > "$STUB_BIN/cmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  list-workspaces) [ "${2:-}" = "--json" ] && echo '[]';;
  *) exit 0;;
esac
EOF
chmod +x "$STUB_BIN/cmux"

# Spawn ONE real, alive process whose ps cmdline contains the parent marker, so
# parent_pid_for_sid finds it and pid_alive==true (=> no pid_dead/no_parent_pid).
( exec -a "telepty allow --id $SID keepalive" sleep 600 ) &
ORPHAN_PID=$!
# settle so ps can see it. NOTE: capture ps to a var then match via here-string —
# `ps | grep -q` under `set -o pipefail` reports failure (grep -q early-exit
# SIGPIPEs the still-writing ps) even on a match.
seen_parent() {
  local psout; psout=$(ps -eo pid,command 2>/dev/null || true)
  grep -q "telepty allow --id $SID " <<<"$psout"
}
for _ in 1 2 3 4 5 6 7 8 9 10; do
  seen_parent && break
  sleep 0.1
done
seen_parent \
  || fail "could not observe the spawned parent process in ps (cannot isolate surface_gone)"

write_list() { printf '%s' "$1" > "$STUB_LIST_FILE"; }

run_reconciler() { # $@ = extra args; writes combined log to $RUN_LOG
  RUN_LOG="$T_TMP/recon-run.log"; : > "$RUN_LOG"
  : > "$DISPATCH_STATE_DIR/reconciler.log" 2>/dev/null || true
  AIGENTRY_WORKSPACE_HOST=cmux \
  RECONCILER_NOW="$NOW" \
  TELEPTY="$STUB_BIN/telepty" \
  SCHEDULER_SH="$SCHED_STUB" \
  CLEANUP_SH="$CLEANUP_STUB" \
  AIGENTRY_SURFACE_ORPHANED_SOURCE="$T_TMP/no-such-surface-orphaned.jsonl" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
    bash "$RECONCILER" "$@" >"$RUN_LOG" 2>&1 || fail "reconciler exited non-zero ($*):
$(cat "$RUN_LOG")"
}

# active.json already [] from t_setup -> sid-orphan NOT in gc_root.

# ===========================================================================
# A) surface_gone ALONE -> SKIP. CONNECTED (no disconnect), parent alive
#    (no pid reason) -> surface_gone is the only reason -> INV-17 skip.
# ===========================================================================
write_list "[{\"id\":\"$SID\",\"healthStatus\":\"CONNECTED\",\"cmuxWorkspaceId\":\"ws-gone\",\"startedAt\":\"$STARTED\"}]"
run_reconciler
grep -q "INV-17 skip sid=$SID" "$RUN_LOG" \
  || fail "expected 'INV-17 skip sid=$SID' (surface_gone single-signal); log:
$(cat "$RUN_LOG")"
[ -s "$CLEANUP_CALLS" ] && fail "MASS-KILL REGRESSION: cleanup was invoked on a surface_gone-ALONE candidate:
$(cat "$CLEANUP_CALLS")"
grep -q "swept=0" "$RUN_LOG" || fail "expected swept=0 on surface_gone-alone sweep; log:
$(cat "$RUN_LOG")"
# DORMANT JSONL consumer: absent source -> consumer never logged consumption.
grep -q "surface_orphaned consumed" "$RUN_LOG" \
  && fail "surface_orphaned consumer acted despite ABSENT source file (should be dormant no-op)"

# ===========================================================================
# B) surface_gone CORROBORATED by disconnect -> close FIRES. Proves the gate
#    is a genuine double-gate (corroboration opens it), not "never close".
# ===========================================================================
: > "$CLEANUP_CALLS"
write_list "[{\"id\":\"$SID\",\"healthStatus\":\"DISCONNECTED\",\"lastSeenAt\":\"$DISC_SEEN\",\"cmuxWorkspaceId\":\"ws-gone\",\"startedAt\":\"$STARTED\"}]"
run_reconciler
grep -q "SWEEP candidate sid=$SID" "$RUN_LOG" \
  || fail "expected corroborated SWEEP candidate for $SID (disconnect+surface_gone); log:
$(cat "$RUN_LOG")"
grep -q "reasons=disconnected" "$RUN_LOG" \
  || fail "expected disconnect corroboration in reasons; log:
$(cat "$RUN_LOG")"
grep -q "^$SID$" "$CLEANUP_CALLS" \
  || fail "expected cleanup invoked for $SID on corroborated candidate; calls:
$(cat "$CLEANUP_CALLS")"

# ===========================================================================
# C) --dry-run clean with ABSENT JSONL source -> exit 0, no actuation.
# ===========================================================================
: > "$CLEANUP_CALLS"
write_list "[{\"id\":\"$SID\",\"healthStatus\":\"CONNECTED\",\"cmuxWorkspaceId\":\"ws-gone\",\"startedAt\":\"$STARTED\"}]"
run_reconciler --dry-run
[ -s "$CLEANUP_CALLS" ] && fail "--dry-run actuated cleanup (must be report-only):
$(cat "$CLEANUP_CALLS")"
grep -q "dry_run=1" "$RUN_LOG" || fail "--dry-run did not record dry_run=1; log:
$(cat "$RUN_LOG")"
grep -q "surface_orphaned consumed" "$RUN_LOG" \
  && fail "--dry-run consumed surface_orphaned despite ABSENT source (should be dormant)"

echo "T26 PASS"
