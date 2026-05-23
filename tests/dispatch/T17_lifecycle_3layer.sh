#!/usr/bin/env bash
# T17 — Lifecycle 3-layer integration. Covers four scenarios via stubs so the
# test runs in <2s and doesn't pollute the real telepty list.
#
#   (a1) Layer A success — worker emits CLEANUP_REQUEST inside grace → pending
#        cancelled, explicit-source schedule + immediate cleanup invocation.
#   (a2) Layer D timeout — REPORT received, no CLEANUP_REQUEST → tick AT grace
#        deadline invokes session-cleanup.sh once (idempotent on re-tick).
#   (a3) EXTEND_LIFETIME — worker pre-empts pending cleanup → deadline pushed,
#        no fire until new deadline reached.
#   (a4) Reconciler crash case — worker never REPORTs; sid not in active.json;
#        age_floor exceeded → reconciler sweep invokes cleanup once.
#
# Uses lib.sh harness + RECONCILER_AGE_FLOOR/DISCONNECT_FLOOR overrides to keep
# the reconciler scenario sub-second.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
SCHED="$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh"
RECON="$REPO_ROOT/bin/session-reconciler.sh"
HANDLER="$REPO_ROOT/bin/inject-handler.sh"

FAKE_CLEANUP="$T_TMP/fake-cleanup.sh"
CLEANUP_LOG="$T_TMP/cleanup-calls.log"
cat > "$FAKE_CLEANUP" <<EOF
#!/usr/bin/env bash
echo "cleanup \$1" >> "$CLEANUP_LOG"
exit 0
EOF
chmod +x "$FAKE_CLEANUP"
: > "$CLEANUP_LOG"

export SESSION_CLEANUP_SH="$FAKE_CLEANUP"
export CLEANUP_SH="$FAKE_CLEANUP"
export SCHEDULER_SH="$SCHED"

pending="$DISPATCH_STATE_DIR/cleanup-pending.json"

# Seed: worker sid-W1 (Layer A), sid-W2 (Layer D), sid-W3 (EXTEND), sid-W4 (crash).
"$REPO_ROOT/bin/dispatch-tracker.sh" append sid-W1 /tmp/r hash1 --from orchestrator
"$REPO_ROOT/bin/dispatch-tracker.sh" append sid-W2 /tmp/r hash2 --from orchestrator
"$REPO_ROOT/bin/dispatch-tracker.sh" append sid-W3 /tmp/r hash3 --from orchestrator
"$REPO_ROOT/bin/dispatch-tracker.sh" append sid-KA /tmp/r hashK --from orchestrator --keep-alive

# ---------------------------------------------------------------------------
# (a1) Layer A success path
# ---------------------------------------------------------------------------
export SCHEDULER_NOW="2026-05-23T12:00:00Z"
TRACKER_NOW="$SCHEDULER_NOW" "$REPO_ROOT/bin/dispatch-tracker.sh" mark-reported sid-W1
sched=$(python3 -c "import json;print(next(p for p in json.load(open('$pending')) if p['sid']=='sid-W1')['scheduled_cleanup_time'])")
[ "$sched" = "2026-05-23T12:01:00Z" ] || { echo "FAIL a1: schedule = $sched" >&2; exit 1; }

# Worker emits CLEANUP_REQUEST via inject-handler (markdown form).
cleanup_body="$T_TMP/cleanup-req.txt"
printf 'CLEANUP_REQUEST: sid-W1 | reason: task-complete\n' > "$cleanup_body"
"$HANDLER" --body-file "$cleanup_body" >/dev/null

# Pending should now have sid-W1 with source=explicit-request (re-scheduled),
# tick at new schedule fires cleanup.
src=$(python3 -c "import json;print(next(p for p in json.load(open('$pending')) if p['sid']=='sid-W1')['source'])")
[ "$src" = "explicit-request" ] || { echo "FAIL a1: source after CLEANUP_REQUEST = $src" >&2; exit 1; }

# Default grace from CLEANUP_REQUEST = 60s (no grace_seconds field).
export SCHEDULER_NOW="2026-05-23T12:01:00Z"
"$SCHED" tick >/dev/null
grep -q "cleanup sid-W1" "$CLEANUP_LOG" || { echo "FAIL a1: cleanup not invoked for sid-W1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# (a2) Layer D timeout path — sid-W2 reports, never sends CLEANUP_REQUEST
# ---------------------------------------------------------------------------
export SCHEDULER_NOW="2026-05-23T12:10:00Z"
TRACKER_NOW="$SCHEDULER_NOW" "$REPO_ROOT/bin/dispatch-tracker.sh" mark-reported sid-W2
export SCHEDULER_NOW="2026-05-23T12:11:00Z"
"$SCHED" tick >/dev/null
grep -q "cleanup sid-W2" "$CLEANUP_LOG" || { echo "FAIL a2: Layer D did not fire for sid-W2" >&2; exit 1; }
"$SCHED" tick >/dev/null
firings=$(grep -c "cleanup sid-W2" "$CLEANUP_LOG")
[ "$firings" = "1" ] || { echo "FAIL a2: Layer D re-fired (count=$firings) — not idempotent" >&2; exit 1; }

# Also: keep-alive sid-KA must NOT have been armed at all.
TRACKER_NOW="$SCHEDULER_NOW" "$REPO_ROOT/bin/dispatch-tracker.sh" mark-reported sid-KA
ka_count=$(python3 -c "import json;d=json.load(open('$pending'));print(sum(1 for p in d if p['sid']=='sid-KA'))")
[ "$ka_count" = "0" ] || { echo "FAIL a2: keep-alive sid-KA was armed (count=$ka_count)" >&2; exit 1; }

# ---------------------------------------------------------------------------
# (a3) EXTEND_LIFETIME path — sid-W3 reports, then defers
# ---------------------------------------------------------------------------
export SCHEDULER_NOW="2026-05-23T12:20:00Z"
TRACKER_NOW="$SCHEDULER_NOW" "$REPO_ROOT/bin/dispatch-tracker.sh" mark-reported sid-W3

extend_body="$T_TMP/extend.txt"
printf 'EXTEND_LIFETIME: sid-W3 | defer_minutes: 5 | reason: more-work\n' > "$extend_body"
"$HANDLER" --body-file "$extend_body" >/dev/null

new_sched=$(python3 -c "import json;print(next(p for p in json.load(open('$pending')) if p['sid']=='sid-W3')['scheduled_cleanup_time'])")
# defer is anchored to handler invocation time (real wallclock), not SCHEDULER_NOW
# — so we just verify source/reason flipped and there's still a pending record.
src3=$(python3 -c "import json;print(next(p for p in json.load(open('$pending')) if p['sid']=='sid-W3')['source'])")
reason3=$(python3 -c "import json;print(next(p for p in json.load(open('$pending')) if p['sid']=='sid-W3').get('preempt_reason',''))")
[ "$src3" = "explicit-request" ] || { echo "FAIL a3: EXTEND source=$src3" >&2; exit 1; }
[ "$reason3" = "more-work" ]     || { echo "FAIL a3: EXTEND reason=$reason3" >&2; exit 1; }
[ -n "$new_sched" ]              || { echo "FAIL a3: defer produced no scheduled time" >&2; exit 1; }

# Tick at the original 12:21 deadline must NOT fire sid-W3 because deferral pushed it.
export SCHEDULER_NOW="2026-05-23T12:21:00Z"
"$SCHED" tick >/dev/null
if grep -q "cleanup sid-W3" "$CLEANUP_LOG"; then
  echo "FAIL a3: sid-W3 fired despite EXTEND deferral" >&2; exit 1
fi

# EXTEND_LIFETIME without defer_minutes = cancel pending.
cancel_body="$T_TMP/cancel.txt"
printf 'EXTEND_LIFETIME: sid-W3\n' > "$cancel_body"
"$HANDLER" --body-file "$cancel_body" >/dev/null
post_count=$(python3 -c "import json;print(sum(1 for p in json.load(open('$pending')) if p['sid']=='sid-W3'))")
[ "$post_count" = "0" ] || { echo "FAIL a3: cancel-via-EXTEND did not drop pending (count=$post_count)" >&2; exit 1; }

# ---------------------------------------------------------------------------
# (a4) Reconciler crash sweep — sid-X never appended to active.json
# ---------------------------------------------------------------------------
# Fake telepty list: sid-X DISCONNECTED beyond floor, no parent PID, not in GC root.
cat > "$STUB_LIST_FILE" <<'EOF'
[
  {"id":"orchestrator","healthStatus":"CONNECTED","startedAt":"2026-05-23T10:00:00Z"},
  {"id":"sid-X","healthStatus":"DISCONNECTED","startedAt":"2026-05-23T11:30:00Z","lastSeenAt":"2026-05-23T11:55:00Z"}
]
EOF

# Low floors so the synthetic disconnect_age=300s easily passes; spawn age=1800s.
export RECONCILER_AGE_FLOOR=10
export RECONCILER_DISCONNECT_FLOOR=10
export RECONCILER_NOW="2026-05-23T12:00:00Z"
export TELEPTY="$STUB_BIN/telepty"

"$RECON" --once >/dev/null
grep -q "cleanup sid-X" "$CLEANUP_LOG" || { echo "FAIL a4: reconciler did not sweep sid-X" >&2; cat "$CLEANUP_LOG" >&2; exit 1; }

# Idempotent: rerun reconciler — should not re-fire (cleanup-pending already drained;
# session-cleanup.sh stub always 0 so backoff doesn't lock; but reconciler still has
# the same candidate — let me re-check). Fake cleanup returns 0 → backoff resets.
# Without removal from telepty list (real cleanup would remove it), reconciler WILL
# re-fire next tick — that's expected level-triggered behavior. We assert only the
# Layer D scheduler tick remains idempotent (drained pending list).
sched_count=$(python3 -c "import json;print(len(json.load(open('$pending'))))")
[ "$sched_count" = "0" ] || { echo "FAIL a4: scheduler pending not empty post-reconcile (count=$sched_count)" >&2; exit 1; }

echo "T17 PASS"
