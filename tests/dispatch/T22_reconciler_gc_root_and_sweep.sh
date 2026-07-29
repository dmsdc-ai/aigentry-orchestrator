#!/usr/bin/env bash
# T22 — Reconciler:
#   - GC root = every non-retired dispatch ∪ {orchestrator} ∪ keep_alive ⇒ never sweeps
#   - Candidate = telepty session not in root, age > floor, no parent PID ⇒ swept
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
RECON="$REPO_ROOT/bin/session-reconciler.sh"
SCHED="$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh"

# Capture cleanup invocations via a fake script.
FAKE_CLEANUP="$T_TMP/fake-cleanup.sh"
CLEANUP_LOG="$T_TMP/cleanup-calls.log"
cat > "$FAKE_CLEANUP" <<EOF
#!/usr/bin/env bash
echo "cleanup \$1" >> "$CLEANUP_LOG"
exit 0
EOF
chmod +x "$FAKE_CLEANUP"
: > "$CLEANUP_LOG"

# Fake telepty list:
#  - orchestrator (PROTECTED — never sweep)
#  - sid-live    (in active.json in_flight — never sweep)
#  - sid-ka      (in active.json keep_alive — never sweep)
#  - sid-orphan  (not in active.json, age > 5min, DISCONNECTED for > 4min — SWEEP)
#  - sid-young   (not in active.json, age < 5min — never sweep, age floor)
NOW="2026-05-23T12:00:00Z"
cat > "$STUB_LIST_FILE" <<EOF
[
  {"id":"orchestrator","healthStatus":"CONNECTED","startedAt":"2026-05-23T10:00:00Z"},
  {"id":"sid-live","healthStatus":"CONNECTED","startedAt":"2026-05-23T11:00:00Z"},
  {"id":"sid-ka","healthStatus":"CONNECTED","startedAt":"2026-05-23T11:00:00Z"},
  {"id":"sid-orphan","healthStatus":"DISCONNECTED","startedAt":"2026-05-23T11:00:00Z","lastSeenAt":"2026-05-23T11:50:00Z"},
  {"id":"sid-young","healthStatus":"DISCONNECTED","startedAt":"2026-05-23T11:58:00Z","lastSeenAt":"2026-05-23T11:59:30Z"}
]
EOF

# Seed: sid-live is an open dispatch; sid-ka opted out of automatic cleanup.
t_seed_dispatch sid-live dispatched_at="2026-05-23T11:00:00Z" \
  expected_report_by="2026-05-23T12:30:00Z" last_seen_at="2026-05-23T11:00:00Z"
t_seed_dispatch sid-ka keep_alive=true dispatched_at="2026-05-23T11:00:00Z" \
  expected_report_by="2026-05-23T12:30:00Z" last_seen_at="2026-05-23T11:00:00Z"

export TELEPTY="$STUB_BIN/telepty"
export CLEANUP_SH="$FAKE_CLEANUP"
export SCHEDULER_SH="$SCHED"
export RECONCILER_NOW="$NOW"
export RECONCILER_AGE_FLOOR=300
export RECONCILER_DISCONNECT_FLOOR=240

# `ps` on the test host won't show "telepty allow --id sid-orphan" — so
# parent_pid_for_sid returns empty → reasons=no_parent_pid. Combined with
# disconnect_age>240s, sid-orphan should be swept.

"$RECON" --once >/dev/null

if ! grep -q "cleanup sid-orphan" "$CLEANUP_LOG"; then
  echo "FAIL: sid-orphan was not swept" >&2
  echo "--- cleanup log ---" >&2; cat "$CLEANUP_LOG" >&2 || true
  exit 1
fi
for sid in orchestrator sid-live sid-ka sid-young; do
  if grep -q "cleanup $sid" "$CLEANUP_LOG"; then
    echo "FAIL: $sid was swept but is in GC root / under age floor" >&2
    exit 1
  fi
done
echo "T22 PASS"
