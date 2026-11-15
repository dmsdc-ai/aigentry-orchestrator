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
t_setup; trap 't_teardown; for _p in ${ORPHAN_PID:-} ${V_PIDS:-}; do kill "$_p" 2>/dev/null || true; done' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"

fail() { echo "FAIL[T26]: $*" >&2; exit 1; }

NOW="2026-05-30T12:00:00Z"          # fixed clock
STARTED="2026-05-30T11:50:00Z"      # 600s old > 300s age floor
DISC_SEEN="2026-05-30T11:54:00Z"    # 360s disconnect age > 240s floor
SID="sid-orphan"
# F7/F9 surface_gone fixture: a well-formed but ABSENT cmux workspace UUID. The
# liveness probe is now `sidebar-state --workspace <id>` (SPEC 2026-06-06), which
# FAILS for an unknown handle and prints exactly `Error: ERROR: Tab not found` on
# stderr => _wh_cmux_alive reports gone. Per #1162(c) both halves are required:
# a zero-exit reply that merely CONTAINS that text is a probe without an answer
# and stays INDETERMINATE->alive. A non-UUID placeholder (e.g. "ws-gone") is
# instead loosely resolved by a real cmux to the focused workspace (alive), so it
# can no longer signal gone.
WS_GONE="00000000-DEAD-BEEF-0000-000000000000"

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

# cmux stub (F9 contract). Used only where cmux is ABSENT (e.g. CI); on a dev box
# the real cmux shadows it via the reconciler's PATH hardening (line "export
# PATH=/opt/homebrew/bin:..."), but BOTH paths agree on "gone" for $WS_GONE:
#   * `sidebar-state` on the absent UUID exits non-zero with exactly
#     `Error: ERROR: Tab not found` on stderr (F7, #1162c) => _wh_cmux_alive
#     reports gone — the surface_gone signal under test. Emitting that text on a
#     SUCCESSFUL probe would be indeterminate, not gone, so the exit code and the
#     exact-whole-reply match are both load-bearing here.
#   * `--json list-workspaces` (flag first, F2) returns an empty workspace set so
#     the step-2b prune never finds a candidate (no real workspace is touched).
cat > "$STUB_BIN/cmux" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "--json" ] && [ "$2" = "list-workspaces" ]; then
  echo '{"workspaces":[]}'; exit 0
fi
case "$1" in
  sidebar-state) echo "Error: ERROR: Tab not found" >&2; exit 1;;
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
  AIGENTRY_ROLE_SANDBOX_DIR="$T_TMP/no-such-sandbox" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
    bash "$RECONCILER" "$@" >"$RUN_LOG" 2>&1 || fail "reconciler exited non-zero ($*):
$(cat "$RUN_LOG")"
}

# active.json already [] from t_setup -> sid-orphan NOT in gc_root.

# ===========================================================================
# A) surface_gone ALONE -> SKIP. CONNECTED (no disconnect), parent alive
#    (no pid reason) -> surface_gone is the only reason -> INV-17 skip.
# ===========================================================================
write_list "[{\"id\":\"$SID\",\"healthStatus\":\"CONNECTED\",\"cmuxWorkspaceId\":\"$WS_GONE\",\"startedAt\":\"$STARTED\"}]"
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
write_list "[{\"id\":\"$SID\",\"healthStatus\":\"DISCONNECTED\",\"lastSeenAt\":\"$DISC_SEEN\",\"cmuxWorkspaceId\":\"$WS_GONE\",\"startedAt\":\"$STARTED\"}]"
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
write_list "[{\"id\":\"$SID\",\"healthStatus\":\"CONNECTED\",\"cmuxWorkspaceId\":\"$WS_GONE\",\"startedAt\":\"$STARTED\"}]"
run_reconciler --dry-run
[ -s "$CLEANUP_CALLS" ] && fail "--dry-run actuated cleanup (must be report-only):
$(cat "$CLEANUP_CALLS")"
grep -q "dry_run=1" "$RUN_LOG" || fail "--dry-run did not record dry_run=1; log:
$(cat "$RUN_LOG")"
grep -q "surface_orphaned consumed" "$RUN_LOG" \
  && fail "--dry-run consumed surface_orphaned despite ABSENT source (should be dormant)"

# ===========================================================================
# V) Task 1270 — a LIVE bridge started with the boot's versioned create-only verb
#    (`telepty allow-create-v1 --id <sid>`) is a live parent: platform::session_pid
#    finds it, so the sweep has no false no_parent_pid. Each fixture is ONE owned,
#    disposable `sleep` renamed via exec -a (the same technique as above), reaped by
#    the EXIT trap. Nothing else is signalled.
# ===========================================================================
SIDV="sid-v1270"
( exec -a "telepty allow-create-v1 --id $SIDV keepalive" sleep 600 ) &
VPID=$!; V_PIDS="$VPID"
( exec -a "telepty allow-create-v2 --id sid-w1270 keepalive" sleep 600 ) &
V_PIDS="$V_PIDS $!"
seen_marker() { local psout; psout=$(ps -eo pid,command 2>/dev/null || true); grep -qF -- "$1" <<<"$psout"; }
for _ in 1 2 3 4 5 6 7 8 9 10; do
  seen_marker "telepty allow-create-v1 --id $SIDV " && seen_marker "telepty allow-create-v2 --id sid-w1270 " && break
  sleep 0.1
done
seen_marker "telepty allow-create-v1 --id $SIDV " \
  || fail "V: could not observe the spawned versioned parent process in ps"
seen_marker "telepty allow-create-v2 --id sid-w1270 " \
  || fail "V: could not observe the spawned wrong-verb process in ps"
# V1: live versioned parent + surface_gone ALONE → INV-17 skip, no cleanup. A false
#     no_parent_pid would corroborate surface_gone and policy.py would CLEANUP it.
: > "$CLEANUP_CALLS"
write_list "[{\"id\":\"$SIDV\",\"healthStatus\":\"CONNECTED\",\"cmuxWorkspaceId\":\"$WS_GONE\",\"startedAt\":\"$STARTED\"}]"
run_reconciler
grep -q "INV-17 skip sid=$SIDV" "$RUN_LOG" \
  || fail "V1: a LIVE allow-create-v1 parent was not found (false no_parent_pid); expected 'INV-17 skip sid=$SIDV'; log:
$(cat "$RUN_LOG")"
[ -s "$CLEANUP_CALLS" ] && fail "V1: cleanup was invoked on a live versioned bridge:
$(cat "$CLEANUP_CALLS")"
# V2: platform::session_pid literal boundaries, called directly.
spid() { bash -c 'source "$1/bin/lib/platform.sh" && platform::session_pid "$2"' _ "$REPO_ROOT" "$1"; }
[ "$(spid "$SIDV")" = "$VPID" ] || fail "V2: session_pid $SIDV != live versioned pid $VPID: '$(spid "$SIDV")'"
[ -z "$(spid sid-v127)" ]  || fail "V2: a sid PREFIX matched the versioned bridge: '$(spid sid-v127)'"
[ -z "$(spid sid.v1270)" ] || fail "V2: the versioned match must be literal, '.' matched: '$(spid sid.v1270)'"
[ -z "$(spid sid-w1270)" ] || fail "V2: allow-create-v2 is not the versioned verb, yet it matched: '$(spid sid-w1270)'"
[ "$(spid "$SID")" = "$ORPHAN_PID" ] || fail "V2: the legacy parent lookup changed: '$(spid "$SID")' != $ORPHAN_PID"
# V3: once the owned versioned fixture is gone, the parent is absent again.
kill "$VPID" 2>/dev/null || true; wait "$VPID" 2>/dev/null || true
[ -z "$(spid "$SIDV")" ] || fail "V3: an exited versioned parent is still reported: '$(spid "$SIDV")'"

echo "T26 PASS"
