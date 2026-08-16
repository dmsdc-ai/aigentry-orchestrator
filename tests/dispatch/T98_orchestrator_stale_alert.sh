#!/usr/bin/env bash
# T98 — the reconciler must notice that the ORCHESTRATOR ITSELF is down (#905).
#
# On 2026-08-16 the orchestrator's session went OWNER_DISCONNECTED_STALE for 3h20m and
# nothing said so. Every worker's report inject bounced `[STALE] Session is stale and
# awaiting cleanup`, and the reconciler — running every 60s the whole time — was silent,
# because the orchestrator sid is in PROTECTED_SIDS and therefore in gc_root, and the
# sweep skips gc_root before it looks at anything (session-reconciler.sh, `if sid in root
# ... continue`). Being exempt from being swept had quietly also meant being exempt from
# being LOOKED AT. This guard is the difference between those two.
#
# WARN-ONLY by construction: orchestrator lifecycle is user-actuated (#606), so the tick
# may never kill or delete here. The assertions below pin that too — a tick that starts
# remediating the orchestrator is a worse bug than the silence it replaced.
#
# Hermetic: stub telepty listing + curl + scheduler + cleanup, tmp state dir, frozen
# clock. Nothing real is contacted and no real sid appears.
#
# Asserts:
#   A) STALE longer than the threshold  → an alert naming the sid AND the remedy.
#   B) STALE but INSIDE the threshold   → silent (a bridge may still be reconnecting).
#   C) CONNECTED                        → silent.
#   D) threshold is configurable, and the same age flips the verdict either way.
#   E) the alert lands in alerts.log (durable), not only on the tick's stdout.
#   F) WARN-ONLY — no kill, no registry DELETE, on any of the above.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T98]: $*" >&2; exit 1; }

RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"
[ -x "$RECONCILER" ] || fail "bin/session-reconciler.sh missing or not executable"

NOW="2026-08-16T12:00:00Z"

# --- stubs ---------------------------------------------------------------------------
SCHED_STUB="$STUB_BIN/sched-noop.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$SCHED_STUB"; chmod +x "$SCHED_STUB"
CLEANUP_STUB="$STUB_BIN/cleanup-noop.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$CLEANUP_STUB"; chmod +x "$CLEANUP_STUB"

# The daemon-reachability probe seam (bin/lib/telepty-listing.sh). A non-empty listing
# is self-evidently authentic and never reaches the probe, but pinning it keeps this
# guard off 127.0.0.1:3848 unconditionally rather than by argument.
CURL_LOG="$T_TMP/curl-calls.log"; : > "$CURL_LOG"
CURL_STUB="$STUB_BIN/curl-recorder"
cat > "$CURL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
printf '200'
exit 0
EOF
chmod +x "$CURL_STUB"

KILL_LOG="$T_TMP/kill-calls.log"; : > "$KILL_LOG"
KILL_STUB="$STUB_BIN/kill-recorder"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$KILL_STUB"

ALERTS="$DISPATCH_STATE_DIR/alerts.log"

# seed <healthStatus> <minutes-since-last-seen>
seed() {
  local health="$1" mins="$2" last
  last="$(python3 -c '
import datetime,sys
t = datetime.datetime.fromisoformat(sys.argv[1].replace("Z","+00:00"))
print((t - datetime.timedelta(minutes=int(sys.argv[2]))).isoformat().replace("+00:00","Z"))
' "$NOW" "$mins")"
  printf '[{"id":"orchestrator","command":"claude","healthStatus":"%s","startedAt":"2026-07-25T09:00:00Z","lastSeenAt":"%s","active_clients":0}]' \
    "$health" "$last" > "$STUB_LIST_FILE"
}

run_tick() {
  : > "$ALERTS"; : > "$KILL_LOG"; : > "$CURL_LOG"
  RUN_LOG="$T_TMP/recon.log"
  AIGENTRY_BUS_BRIDGE=0 \
  RECONCILER_NOW="$NOW" \
  CURL="$CURL_STUB" \
  KILL_CMD="$KILL_STUB" \
  TELEPTY="$STUB_BIN/telepty" \
  SCHEDULER_SH="$SCHED_STUB" \
  CLEANUP_SH="$CLEANUP_STUB" \
  AIGENTRY_ROLE_SANDBOX_DIR="$T_TMP/no-such-sandbox" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
    env "$@" bash "$RECONCILER" > "$RUN_LOG" 2>&1 \
      || fail "reconciler tick exited non-zero:
$(cat "$RUN_LOG")"
}

alerted() { grep -q 'ORCHESTRATOR_STALE' "$ALERTS" 2>/dev/null; }

# --- A) STALE well past the threshold → alert ----------------------------------------
seed STALE 40
run_tick ORCH_STALE_ALERT_MIN=5
alerted || fail "A: orchestrator STALE for 40min raised no ORCHESTRATOR_STALE alert. alerts:
$(cat "$ALERTS")
--- tick ---
$(cat "$RUN_LOG")"
grep -q 'orchestrator' "$ALERTS" || fail "A: the alert does not name the sid: $(cat "$ALERTS")"
# The remedy has to be IN the alert. An alert that says something is wrong without
# saying what to run is how a 3h20m outage stays a 3h20m outage.
grep -q 'orchestrator-boot.sh' "$ALERTS" \
  || fail "A: the alert does not name the remedy (bin/orchestrator-boot.sh): $(cat "$ALERTS")"

# --- E) it is durable, not just stdout -----------------------------------------------
[ -s "$ALERTS" ] || fail "E: nothing was written to alerts.log"

# --- F) WARN-ONLY --------------------------------------------------------------------
[ -s "$KILL_LOG" ] && fail "F: the tick killed something while alerting on a STALE orchestrator: $(cat "$KILL_LOG")"
grep -q -- '-X DELETE' "$CURL_LOG" 2>/dev/null \
  && fail "F: the tick issued a registry DELETE — orchestrator lifecycle is user-actuated: $(cat "$CURL_LOG")"

# --- B) STALE but inside the threshold → silent --------------------------------------
seed STALE 2
run_tick ORCH_STALE_ALERT_MIN=5
alerted && fail "B: alerted at 2min with a 5min threshold (a reconnecting bridge would be reported as an outage). alerts:
$(cat "$ALERTS")"

# --- C) CONNECTED → silent -----------------------------------------------------------
seed CONNECTED 0
run_tick ORCH_STALE_ALERT_MIN=5
alerted && fail "C: alerted on a CONNECTED orchestrator. alerts:
$(cat "$ALERTS")"

# --- D) the threshold is configurable, and moves the verdict both ways ---------------
seed STALE 10
run_tick ORCH_STALE_ALERT_MIN=30
alerted && fail "D: 10min age alerted under a 30min threshold — the threshold is not being honoured. alerts:
$(cat "$ALERTS")"
run_tick ORCH_STALE_ALERT_MIN=1
alerted || fail "D: 10min age did NOT alert under a 1min threshold. alerts:
$(cat "$ALERTS")
--- tick ---
$(cat "$RUN_LOG")"

echo "T98 PASS"
