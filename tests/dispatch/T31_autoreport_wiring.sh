#!/usr/bin/env bash
# T31 — session-reconciler tick wires the pull-AUTO_REPORT scan (#517).
# SCOPE: the reconciler-tick -> tracker-invocation SEAM ONLY. A spy stub records
# that `dispatch-tracker.sh check` was invoked; the tracker's emission logic is
# owned by T8 and is NOT re-tested here. Also asserts --dry-run skips the call
# (the scan mutates state / injects, so it is act-only).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"

# Spy tracker: records every invocation's args.
SPY_LOG="$T_TMP/tracker-spy.log"; : > "$SPY_LOG"
SPY="$STUB_BIN/tracker-spy.sh"
cat > "$SPY" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SPY_LOG"
exit 0
EOF
chmod +x "$SPY"

# No-op scheduler/cleanup; empty telepty list so the orphan sweep is a no-op.
SCHED_STUB="$STUB_BIN/sched-noop.sh"; printf '#!/usr/bin/env bash\nexit 0\n' > "$SCHED_STUB"; chmod +x "$SCHED_STUB"
CLEANUP_STUB="$STUB_BIN/cleanup-noop.sh"; printf '#!/usr/bin/env bash\nexit 0\n' > "$CLEANUP_STUB"; chmod +x "$CLEANUP_STUB"
printf '%s' '[]' > "$STUB_LIST_FILE"

run_tick() {
  RECONCILER_NOW="2026-06-06T12:00:00Z" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
  TELEPTY="$STUB_BIN/telepty" \
  TRACKER_SH="$SPY" \
  SCHEDULER_SH="$SCHED_STUB" \
  CLEANUP_SH="$CLEANUP_STUB" \
    "$RECONCILER" "$@" >/dev/null 2>&1 || true
}

# Act tick → the tracker check seam fires.
run_tick --once
t_assert_contains "$SPY_LOG" "check"

# --dry-run → the scan is skipped (honors DRY_RUN).
: > "$SPY_LOG"
run_tick --dry-run
if [ -s "$SPY_LOG" ]; then
  echo "FAIL: --dry-run invoked tracker check" >&2
  cat "$SPY_LOG" >&2
  exit 1
fi

echo "T31 PASS"
