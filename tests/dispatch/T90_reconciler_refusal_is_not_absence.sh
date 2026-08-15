#!/usr/bin/env bash
# T90 — the reconciler tick, on a refusal that looks like an empty world (#835),
# and the gates it opens about sessions that no longer exist (#836).
#
# PART A (#835). Step 2b prunes every role-sandbox workspace whose title is not in
# `telepty list --json` (session-reconciler.sh:773→777). A 401 makes that listing
# `[]` with exit 0, so `live_ids` collapses to gc_root+keep_alive and every live
# worker's workspace becomes a prune candidate — the seen-twice ledger debounce
# buys exactly one 60s tick before they are closed. The listing guard must reject
# an uncorroborated `[]` and abort the tick BEFORE step 2b runs at all.
#
# PART B (#836). Every gate this loop opens names a subject session and offers the
# operator an action on it ("resume the session as-is"). The subjects come from the
# DISPATCH registry, which outlives the session, so a record whose session was
# cleaned up still opens a gate nobody can answer — two fired this month, each
# costing an operator a verification round. The subject must be verified live
# first. But an UNKNOWN answer is not an absence: when the listing itself was
# refused, the gate must still open, or #836's fix reintroduces #835's defect one
# layer up.
#
# Hermetic: every external the tick reaches is stubbed or pointed at a temp path;
# CLEANUP_SH is a stub that fails the test if it is ever called.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"

fail() { echo "FAIL[T90]: $*" >&2; exit 1; }

NOW="2026-08-01T12:00:00Z"
export HITL_STATE_DIR="$T_TMP/hitl"
PENDING="$HITL_STATE_DIR/pending"
CURL_LOG="$T_TMP/curl.log"; export CURL_LOG

# curl stub — the corroboration probe (and nothing else on this path). Injected by
# ENV ($CURL, the dispatch-tracker seam) rather than PATH: session-reconciler.sh:39
# prepends /usr/bin, which shadows anything the harness puts on PATH. TELEPTY_PORT
# is pinned to 1 as a second belt — if the seam ever regressed, the fallback would
# hit a closed port rather than the operator's live daemon.
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
echo "${STUB_HTTP:-200}"
EOF

# A cleanup that is never allowed to run: this tick must not tear anything down.
CLEANUP_CALLS="$T_TMP/cleanup-calls.log"; : > "$CLEANUP_CALLS"
cat > "$STUB_BIN/cleanup-stub.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CLEANUP_CALLS"
exit 0
EOF

cat > "$STUB_BIN/noop.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# session-probe stub: alive with surface=error ⇒ policy.py returns AWAIT_USER,
# the gate producer under test in part B (see T66 for that mapping).
cat > "$STUB_BIN/probe-error.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s' '{"alive":true,"ready":false,"surface":"error","activity":"static","cli":"claude","detail":{}}'
EOF
chmod +x "$STUB_BIN"/curl "$STUB_BIN"/cleanup-stub.sh "$STUB_BIN"/noop.sh "$STUB_BIN"/probe-error.sh

FAKE_HOME="$T_TMP/home"; mkdir -p "$FAKE_HOME/.telepty"
printf '%s' '{"authToken":"tok-T90"}' > "$FAKE_HOME/.telepty/config.json"

RUN_LOG="$T_TMP/recon.log"
# run_tick <probe-http> — one reconciler tick; never aborts the test itself.
run_tick() {
  : > "$RUN_LOG"; : > "$CURL_LOG"
  local rc=0
  set +e
  STUB_HTTP="$1" \
  CURL="$STUB_BIN/curl" \
  TELEPTY_PORT=1 \
  HOME="$FAKE_HOME" \
  AIGENTRY_WORKSPACE_HOST=headless \
  RECONCILER_NOW="$NOW" \
  TELEPTY="$STUB_BIN/telepty" \
  SCHEDULER_SH="$STUB_BIN/noop.sh" \
  CLEANUP_SH="$STUB_BIN/cleanup-stub.sh" \
  TRACKER_SH="$T_TMP/no-tracker" \
  COMMS_AUDITOR_SH="$T_TMP/no-auditor" \
  BRIDGE_AUDITOR_SH="$T_TMP/no-bridge-auditor" \
  SESSION_PROBE_PY="$STUB_BIN/probe-error.sh" \
  AIGENTRY_SURFACE_ORPHANED_SOURCE="$T_TMP/no-surface-orphaned.jsonl" \
  AIGENTRY_SURFACE_MISMATCHED_SOURCE="$T_TMP/no-surface-mismatched.jsonl" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
    bash "$RECONCILER" > "$RUN_LOG" 2>&1
  rc=$?
  set -e
  return "$rc"
}
gates() { find "$PENDING" -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }

# ===========================================================================
# PART A (#835) — an uncorroborated [] aborts the tick before step 2b
# ===========================================================================
printf '%s' '[]' > "$STUB_LIST_FILE"

for probe in 401 403 500 000; do
  run_tick "$probe" || fail "the tick must not crash on a refused listing (probe=$probe): $(cat "$RUN_LOG")"
  grep -q 'abort sweep' "$RUN_LOG" \
    || fail "probe=$probe: the sweep was not aborted on an uncorroborated empty listing; log:
$(cat "$RUN_LOG")"
  grep -q 'a refusal is not an absence' "$RUN_LOG" \
    || fail "probe=$probe: the abort did not name what actually happened; log:
$(cat "$RUN_LOG")"
  # step 2b's summary line is the proof the prune ran; it must never be reached.
  if grep -q 'pruned=' "$RUN_LOG"; then
    fail "probe=$probe: step 2b (workspace prune) ran on an untrustworthy empty listing — that is the path that closes every live worker's surface; log:
$(cat "$RUN_LOG")"
  fi
  [ -s "$CLEANUP_CALLS" ] && fail "probe=$probe: session-cleanup was invoked on a refused listing:
$(cat "$CLEANUP_CALLS")"
done

# Positive control: [] the daemon DOES corroborate is a genuinely empty world, and
# the tick completes normally through step 2b.
run_tick 200 || fail "a corroborated empty listing must still tick: $(cat "$RUN_LOG")"
grep -q 'abort sweep' "$RUN_LOG" \
  && fail "a corroborated empty listing was refused — the guard must cost nothing when the daemon really is empty; log:
$(cat "$RUN_LOG")"
grep -q 'pruned=' "$RUN_LOG" \
  || fail "the tick did not reach step 2b on a corroborated empty listing; log:
$(cat "$RUN_LOG")"

# ===========================================================================
# PART B (#836) — a gate about a session that does not exist is not opened
# ===========================================================================
# One open dispatch whose probe says surface=error ⇒ AWAIT_USER ⇒ hitl_open.
t_seed_dispatch t90-sid dispatched_at="2026-08-01T11:00:00Z" \
  expected_report_by="2026-08-01T11:30:00Z" last_seen_at="2026-08-01T11:00:00Z"

# B1 — subject ABSENT from a listing the daemon corroborates ⇒ stale, no gate.
printf '%s' '[{"id":"t90-someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
rm -rf "$PENDING"
run_tick 200 || fail "tick failed on B1: $(cat "$RUN_LOG")"
[ "$(gates)" = "0" ] \
  || { find "$PENDING" -name '*.json' -exec cat {} \; >&2
       fail "a gate was opened about t90-sid, which is not a live session — the operator would have to verify it only to dismiss it"; }
grep -q 'HITL_GATE_STALE subject-sid=t90-sid' "$DISPATCH_STATE_DIR/alerts.log" \
  || fail "the suppressed gate was not recorded as stale; alerts:
$(cat "$DISPATCH_STATE_DIR/alerts.log" 2>/dev/null)"

# B2 — subject LIVE ⇒ the gate still opens (the guard is a filter, not an off switch).
printf '%s' '[{"id":"t90-sid","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
rm -rf "$PENDING"; : > "$DISPATCH_STATE_DIR/alerts.log"
run_tick 200 || fail "tick failed on B2: $(cat "$RUN_LOG")"
[ "$(gates)" = "1" ] \
  || fail "the gate for a LIVE subject was suppressed — gates=$(gates); log:
$(cat "$RUN_LOG")"

# B3 — liveness UNKNOWN (the listing itself was refused) ⇒ the gate OPENS.
# Suppressing an escalation on an untrustworthy absence is #835 one layer up, and
# unlike a surface close a spurious gate destroys nothing. A FRESH sid, because
# B2's dispatch is now parked on the gate axis and the loop would skip it — which
# would make this assertion pass while proving nothing.
t_init_v2
t_seed_dispatch t90-unknown dispatched_at="2026-08-01T11:00:00Z" \
  expected_report_by="2026-08-01T11:30:00Z" last_seen_at="2026-08-01T11:00:00Z"
printf '%s' '[]' > "$STUB_LIST_FILE"
rm -rf "$PENDING"; : > "$DISPATCH_STATE_DIR/alerts.log"
run_tick 401 || fail "tick failed on B3: $(cat "$RUN_LOG")"
if grep -q 'HITL_GATE_STALE' "$DISPATCH_STATE_DIR/alerts.log" 2>/dev/null; then
  fail "the gate was suppressed on an UNKNOWN liveness answer — a refused listing is not evidence that the subject is gone; alerts:
$(cat "$DISPATCH_STATE_DIR/alerts.log")"
fi
[ "$(gates)" = "1" ] \
  || fail "no gate was opened when liveness was UNKNOWN — gates=$(gates); an escalation dropped on an untrustworthy absence is the same defect one layer up; log:
$(cat "$RUN_LOG")"

echo "T90 PASS"
