#!/usr/bin/env bash
# T62 — a gated session is blocked, not probed, and NOT swept
# (ADR 2026-07-26-hitl-gate-primitive §2 + M1).
#
#   open --subject-sid ⇒ active.json status = awaiting_user
#   reconciler tick    ⇒ probe count 0 (dropped out of the registry LIVE set)
#   compute_gc_root    ⇒ still contains the sid ⇒ the orphan sweep leaves it alone
#                        ← the regression that matters: without the gc_root entry
#                          the sweep GCs the very session waiting on the human.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export HITL_STATE_DIR="$T_TMP/hitl"
HITL="$REPO_ROOT/bin/hitl.sh"
RECON="$REPO_ROOT/bin/session-reconciler.sh"
NOW="2026-07-26T12:00:00Z"

# sid-A: dispatched, in flight, and (per telepty) long-disconnected — i.e. a
# textbook sweep candidate the moment it falls out of the GC root.
t_seed_entry sid-A "2026-07-26T11:00:00Z" "2026-07-26T12:30:00Z" in_flight ""
cat > "$STUB_LIST_FILE" <<'EOF'
[
  {"id":"orchestrator","healthStatus":"CONNECTED","startedAt":"2026-07-26T10:00:00Z"},
  {"id":"sid-A","healthStatus":"DISCONNECTED","startedAt":"2026-07-26T11:00:00Z","lastSeenAt":"2026-07-26T11:50:00Z"}
]
EOF

gid=$(RECONCILER_NOW="$NOW" "$HITL" open --source worker-sid-A --subject-sid sid-A \
  --kind decision --resume reinject --question "phase boundary: land as-is or amend scope?")
t_assert_status sid-A awaiting_user
prev=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("prev_status"))' \
  "$HITL_STATE_DIR/pending/$gid.json")
if [ "$prev" != "in_flight" ]; then
  echo "FAIL: gate.prev_status = $prev, want in_flight" >&2; exit 1
fi

PROBE_LOG="$T_TMP/probe.log"; : > "$PROBE_LOG"
PROBE_STUB="$T_TMP/probe-stub.sh"
cat > "$PROBE_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PROBE_LOG"
printf '%s\n' '{"alive":true,"ready":true,"surface":"idle","activity":"static","cli":"claude","detail":{}}'
EOF

CLEANUP_LOG="$T_TMP/cleanup.log"; : > "$CLEANUP_LOG"
CLEANUP_STUB="$T_TMP/cleanup-stub.sh"
cat > "$CLEANUP_STUB" <<EOF
#!/usr/bin/env bash
printf 'cleanup %s\n' "\$1" >> "$CLEANUP_LOG"
exit 0
EOF

NOOP_STUB="$T_TMP/noop-stub.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$NOOP_STUB"
chmod +x "$PROBE_STUB" "$CLEANUP_STUB" "$NOOP_STUB"

RECONCILER_NOW="$NOW" SESSION_PROBE_PY="$PROBE_STUB" CLEANUP_SH="$CLEANUP_STUB" \
  SCHEDULER_SH="$NOOP_STUB" TRACKER_SH="$NOOP_STUB" \
  COMMS_AUDITOR_SH="$NOOP_STUB" BRIDGE_AUDITOR_SH="$NOOP_STUB" \
  "$RECON" --once >/dev/null

if [ -s "$PROBE_LOG" ]; then
  echo "FAIL: gated session was probed (registry LIVE set still contains it)" >&2
  cat "$PROBE_LOG" >&2; exit 1
fi
if grep -q "cleanup sid-A" "$CLEANUP_LOG"; then
  echo "FAIL: gated session was SWEPT — awaiting_user missing from compute_gc_root" >&2
  cat "$CLEANUP_LOG" >&2; exit 1
fi
t_assert_contains "$DISPATCH_STATE_DIR/reconciler.log" "gc_root=[orchestrator,sid-A]"
# The tick must not have touched the gated entry either.
t_assert_status sid-A awaiting_user

# Belt (ADR §2): a worker that reports out-of-band while gated is not dropped.
TRACKER_NOW="$NOW" t_run_tracker mark-reported sid-A >/dev/null
t_assert_status sid-A reported

echo "T62 PASS"
