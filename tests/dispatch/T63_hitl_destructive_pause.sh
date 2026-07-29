#!/usr/bin/env bash
# T63 — a pending `destructive` gate pauses the tick's ACTIONS but not its
# OBSERVATION (ADR 2026-07-26-hitl-gate-primitive §3 + M3).
#
#   phase 1: destructive gate pending ⇒ zero actions (no dispatch / cleanup /
#            scheduler / tracker) but reconcile-shadow.jsonl still grows
#   phase 2: corrupt gate file ⇒ fail-safe — still paused, HITL_GATE_CORRUPT logged
#   phase 3: nothing pending ⇒ the same tick DOES act (proves the pause caused it)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export HITL_STATE_DIR="$T_TMP/hitl"
HITL="$REPO_ROOT/bin/hitl.sh"
RECON="$REPO_ROOT/bin/session-reconciler.sh"
NOW="2026-07-26T12:00:00Z"
SHADOW_LOG="$T_TMP/reconcile-shadow.jsonl"
RECON_LOG="$DISPATCH_STATE_DIR/reconciler.log"

# sid-A is at a welcome prompt ⇒ policy REDISPATCH ⇒ dispatch.sh, unless paused.
# sid-orphan is a textbook sweep candidate ⇒ CLEANUP, unless paused.
REF="$T_TMP/ref.md"; printf 'ref\n' > "$REF"
t_seed_dispatch sid-A ref_path="$REF" dispatched_at="2026-07-26T11:00:00Z" \
  expected_report_by="2026-07-26T12:30:00Z" last_seen_at="2026-07-26T11:00:00Z"
# maybe_redispatch requires the context-ref to exist, else it alerts instead of acting.
REF="$T_TMP/ref.md"; printf 'ref\n' > "$REF"
cat > "$STUB_LIST_FILE" <<'EOF'
[
  {"id":"orchestrator","healthStatus":"CONNECTED","startedAt":"2026-07-26T10:00:00Z"},
  {"id":"sid-orphan","healthStatus":"DISCONNECTED","startedAt":"2026-07-26T11:00:00Z","lastSeenAt":"2026-07-26T11:50:00Z"}
]
EOF

PROBE_STUB="$T_TMP/probe-stub.sh"
cat > "$PROBE_STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"alive":true,"ready":true,"surface":"welcome","activity":"static","cli":"claude","detail":{}}'
EOF

CLEANUP_LOG="$T_TMP/cleanup.log"; : > "$CLEANUP_LOG"
CLEANUP_STUB="$T_TMP/cleanup-stub.sh"
cat > "$CLEANUP_STUB" <<EOF
#!/usr/bin/env bash
printf 'cleanup %s\n' "\$1" >> "$CLEANUP_LOG"
exit 0
EOF

ACT_LOG="$T_TMP/act.log"; : > "$ACT_LOG"
ACT_STUB="$T_TMP/act-stub.sh"   # stands in for scheduler + tracker + auditors
cat > "$ACT_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ACT_LOG"
exit 0
EOF
chmod +x "$PROBE_STUB" "$CLEANUP_STUB" "$ACT_STUB"

run_tick() {
  RECONCILER_NOW="$NOW" SESSION_PROBE_PY="$PROBE_STUB" CLEANUP_SH="$CLEANUP_STUB" \
    SCHEDULER_SH="$ACT_STUB" TRACKER_SH="$ACT_STUB" \
    COMMS_AUDITOR_SH="$ACT_STUB" BRIDGE_AUDITOR_SH="$ACT_STUB" \
    RECONCILE_SHADOW_LOG="$SHADOW_LOG" "$RECON" --once >/dev/null
}
dispatch_calls() { grep -c '^dispatch.sh' "$STUB_DISPATCH_LOG" 2>/dev/null || true; }

# --- phase 1: destructive gate pending ⇒ actions paused, observation continues ---
gid=$(RECONCILER_NOW="$NOW" "$HITL" open --source operator --kind destructive \
  --resume none --question "push feat/740-hitl-wiring to origin?")
run_tick

n=$(dispatch_calls)
if [ "${n:-0}" != "0" ]; then
  echo "FAIL: destructive gate pending but dispatch.sh ran ($n calls)" >&2
  cat "$STUB_DISPATCH_LOG" >&2; exit 1
fi
if [ -s "$CLEANUP_LOG" ]; then
  echo "FAIL: destructive gate pending but the sweep cleaned up" >&2
  cat "$CLEANUP_LOG" >&2; exit 1
fi
if [ -s "$ACT_LOG" ]; then
  echo "FAIL: destructive gate pending but scheduler/tracker/auditor ran" >&2
  cat "$ACT_LOG" >&2; exit 1
fi
if [ ! -s "$SHADOW_LOG" ]; then
  echo "FAIL: observation stopped too — reconcile-shadow.jsonl is empty" >&2; exit 1
fi
python3 - "$SHADOW_LOG" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
# Both loops keep observing under the pause: the registry loop decided REDISPATCH
# for sid-A and the sweep decided CLEANUP for sid-orphan — neither was applied.
got = {(r["sid"], r["action"].get("action")) for r in rows}
want = {("sid-A", "REDISPATCH"), ("sid-orphan", "CLEANUP")}
if got != want:
    raise SystemExit(f"FAIL: shadow decisions={sorted(got)}, want {sorted(want)}")
PY
t_assert_contains "$RECON_LOG" "HITL_PAUSE gate=$gid"
t_assert_contains "$RECON_LOG" "dry_run=1"
t_assert_lifecycle sid-A delivery_attempt_started   # REDISPATCH never applied
t_assert_outcome_unknown sid-A

# --- phase 2: corrupt gate file ⇒ fail-safe (still paused, logged loudly) ---
"$HITL" approve "$gid" >/dev/null
printf 'not json {' > "$HITL_STATE_DIR/pending/decision-broken-000000000000.json"
: > "$RECON_LOG"; : > "$SHADOW_LOG"
run_tick

n=$(dispatch_calls)
if [ "${n:-0}" != "0" ]; then
  echo "FAIL: corrupt gate file did not fail safe — dispatch.sh ran ($n calls)" >&2; exit 1
fi
t_assert_contains "$RECON_LOG" "HITL_GATE_CORRUPT"
t_assert_contains "$RECON_LOG" "dry_run=1"

# --- phase 3: control — nothing pending ⇒ the very same tick acts ---
rm -f "$HITL_STATE_DIR/pending"/*.json
: > "$RECON_LOG"
run_tick

n=$(dispatch_calls)
if [ "${n:-0}" = "0" ]; then
  echo "FAIL: no gate pending but the tick still took no action (test is vacuous)" >&2
  cat "$RECON_LOG" >&2; exit 1
fi
if ! grep -q "cleanup sid-orphan" "$CLEANUP_LOG"; then
  echo "FAIL: no gate pending but the sweep did not run" >&2; exit 1
fi
t_assert_lifecycle sid-A re_dispatched
t_assert_outcome_unknown sid-A

echo "T63 PASS"
