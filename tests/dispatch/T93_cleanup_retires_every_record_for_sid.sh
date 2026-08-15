#!/usr/bin/env bash
# T93 (#853) — session-cleanup.sh must take EVERY live record for the sid out of
# the pollers' way, not one.
#
# A sid accumulates one dispatch record per dispatch. `find_by_sid` is singular —
# it returns `(live or matches)[-1]` — and session-cleanup.sh:74 called
# set-lifecycle once, so cleaning a session that had received N dispatches
# retired exactly ONE record and left N-1 in the `--live` set forever. Those
# ghosts are polled on every reconcile tick for a session that no longer exists,
# and each one emits a HOLD. Measured on the live ledger: 43 hand-driven
# `session_absent_observed` observations across 25 sids, which is the orchestrator
# draining ghosts one invocation at a time because the tool would not.
#
# The RED here is the count: seed N live records for one sid, run the cleanup
# path once, and count what is still live. Before the fix: N-1. After: 0.
#
# HERMETIC: real registry component against a temp state dir; curl/list stubbed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T93]: $*" >&2; exit 1; }

# DELETE backup curl stub (offline).
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo 404
EOF
chmod +x "$STUB_BIN/curl"

# live_count <sid> — records for the sid whose lifecycle is NOT retired, i.e.
# exactly what `dispatch-registry.py list --live` keeps feeding the pollers.
live_count() {
  local sid="$1"
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" python3 - "$DISPATCH_STATE_DIR/active.json" "$sid" <<'PY'
import json, sys
RETIRED = {"cleaned", "cutover_retired", "delivery_failed", "not_delivered"}
doc = json.load(open(sys.argv[1], encoding="utf-8"))
sid = sys.argv[2]
print(sum(1 for r in doc["dispatches"]
          if r["assigned"]["sid"] == sid
          and r["lifecycle"]["state"] not in RETIRED))
PY
}

# ── A) five dispatches to one sid → cleanup once → ZERO live records left ──
SID="chatty-sid-T93"
N=5
for i in $(seq 1 "$N"); do
  # Distinct dispatch_id (schema rejects duplicates) and distinct ref_hash, so
  # each record is a genuinely separate dispatch the way repeated delegation
  # to one worker produces them.
  t_seed_dispatch "$SID" "dispatch_id=disp-$SID-$i" "dedup.ref_hash=hash-$i"
done
[ "$(live_count "$SID")" = "$N" ] || fail "A: fixture seeded $(live_count "$SID") live records, want $N"

printf '%s' '[{"id":"someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
"$BASH_BIN" "$CLEANUP" "$SID" >/dev/null 2>&1 \
  || fail "A: cleanup exited non-zero"

left=$(live_count "$SID")
[ "$left" = "0" ] || fail "A: $left of $N records are STILL live after cleanup — every one is polled forever and HOLDs on every tick (#853)"

# Every record must be individually cleaned, and cleanup is still LIFECYCLE-only:
# a session vanishing is not a task completing (telepty#60 Stage A).
DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" python3 - "$DISPATCH_STATE_DIR/active.json" "$SID" "$N" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
sid, want = sys.argv[2], int(sys.argv[3])
recs = [r for r in doc["dispatches"] if r["assigned"]["sid"] == sid]
assert len(recs) == want, f"FAIL[T93]: {len(recs)} records for {sid}, want {want} (none may be dropped)"
for r in recs:
    did = r["dispatch_id"]
    assert r["lifecycle"]["state"] == "cleaned", \
        f"FAIL[T93]: {did} lifecycle={r['lifecycle']['state']!r}, want 'cleaned'"
    assert r["outcome"]["state"] == "unknown", \
        f"FAIL[T93]: {did} outcome.state={r['outcome']['state']!r} — cleanup may not move outcome"
    assert r["outcome"]["reported_value"] is None, \
        f"FAIL[T93]: {did} outcome.reported_value must stay null"
    kinds = [o.get("kind") for o in r.get("observations", [])]
    assert "session_absent_observed" in kinds, \
        f"FAIL[T93]: {did} carries no session_absent_observed; got {kinds}"
PY

# ── B) already-retired records are not disturbed, and the run is idempotent ──
# A second cleanup of the same sid must stay exit 0 and change nothing that is
# already retired — the reconciler re-runs this path routinely.
gen_before=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generation"])' "$DISPATCH_STATE_DIR/active.json")
"$BASH_BIN" "$CLEANUP" "$SID" >/dev/null 2>&1 \
  || fail "B: second cleanup exited non-zero (must be idempotent)"
[ "$(live_count "$SID")" = "0" ] || fail "B: a second cleanup resurrected live records"
gen_after=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generation"])' "$DISPATCH_STATE_DIR/active.json")
[ "$gen_after" -ge "$gen_before" ] || fail "B: generation went backwards"

# ── C) one sid's cleanup must not touch another sid's live records ──
OTHER="bystander-sid-T93"
t_seed_dispatch "$OTHER" "dispatch_id=disp-$OTHER-1"
t_seed_dispatch "$OTHER" "dispatch_id=disp-$OTHER-2" "dedup.ref_hash=hash-2"
"$BASH_BIN" "$CLEANUP" "$SID" >/dev/null 2>&1 || fail "C: cleanup exited non-zero"
[ "$(live_count "$OTHER")" = "2" ] \
  || fail "C: cleaning $SID retired $((2 - $(live_count "$OTHER"))) of the bystander's records"

# ── D) a sid with NO record at all is still a clean exit 0 ──
printf '%s' '[{"id":"someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
"$BASH_BIN" "$CLEANUP" "never-dispatched-T93" >/dev/null 2>&1 \
  || fail "D: cleanup of a sid with no dispatch record must not fail"

echo "T93 PASS"
