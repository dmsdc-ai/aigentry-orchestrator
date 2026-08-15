#!/usr/bin/env bash
# T95 — bin/telepty-bus-bridge.sh, the bus→file bridge that ends the dormancy of
# consume_surface_orphaned / consume_surface_mismatched (#847).
#
# A) FILTER + ROUTING. The bus carries far more than these two kinds; a bridge
#    that mirrored it would build a second unbounded ledger. A stubbed `telepty
#    listen` emits one session_activity_observation, one surface_orphaned and one
#    surface_mismatched: only the last two are written, each to its own file, each
#    projected down to the field set its consumer documents.
# B) SINGLETON (#539/#618). A second instance finds the first and exits 0 without
#    taking the pidfile — two writers on one spool is the duplicate-writer scar.
# C) THE DRAIN HANDOFF. The reconciler consumes what the bridge wrote with NO
#    change to the consumers' decision logic, and drains by REMOVING the file —
#    the bridge installs a batch by rename and only while the path is absent, so
#    a truncate-drain would wedge every later batch in the spool forever.
# D) NO GATED-EVENT LEAK. A line the INV-17 gates reject (livenessVerdict
#    'unknown') actuates nothing AND is still drained; keeping it re-decided a
#    dead judgement every tick and grew the file without bound once a bridge fed it.
# E) LIVE SUBSCRIBE. Against a REAL telepty daemon on a temp HOME and an ephemeral
#    port (never :3848), the bridge reaches state=connected over the token-gated
#    WS bus. Emitting a real surface_orphaned needs a cmux workspace GC tick, so
#    the transport is proven live here and the write path is proven in A.
#
# Hermetic: temp state, stub PATH, stub curl for the daemon-reachability probe,
# a daemon of our own on a port we picked. Nothing touches :3848 or prod state.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"

# BEFORE t_setup puts a stub telepty on PATH — part E needs the real CLI.
REAL_TELEPTY="$(command -v telepty 2>/dev/null || true)"

t_setup
DAEMON_PID=""; BRIDGE_PIDS=""
cleanup() {
  local p
  for p in $BRIDGE_PIDS; do kill "$p" 2>/dev/null || true; done
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  t_teardown
}
trap cleanup EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BRIDGE="$REPO_ROOT/bin/telepty-bus-bridge.sh"
RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"
ORPHANED="$DISPATCH_STATE_DIR/surface-orphaned.jsonl"
MISMATCHED="$DISPATCH_STATE_DIR/surface-mismatched.jsonl"

fail() { echo "FAIL[T95]: $*" >&2; exit 1; }

# wait_for <seconds> <cmd...> — poll at 0.2s until the command succeeds.
wait_for() {
  local limit="$1"; shift
  local tries=$(( limit * 5 ))
  while [ "$tries" -gt 0 ]; do
    if "$@"; then return 0; fi
    sleep 0.2
    tries=$(( tries - 1 ))
  done
  return 1
}

[ -x "$BRIDGE" ] || fail "no bridge at bin/telepty-bus-bridge.sh"

# ===========================================================================
# A) filter + routing
# ===========================================================================
# The daemon-reachability probe seam: lib/telepty-listing.sh calls "${CURL:-curl}"
# with -w '%{http_code}', so a stub that prints 200 is a reachable daemon. It is an
# env seam, not a PATH one, because the bridge hardens PATH the way the reconciler
# does and a PATH stub would be shadowed by the real binary.
cat > "$STUB_BIN/curl-200" <<'EOF'
#!/usr/bin/env bash
printf '200'
EOF
chmod +x "$STUB_BIN/curl-200"

# `telepty listen` stand-in: the three bus lines (verbatim shapes from daemon.js
# buildSessionEvent — `extra` is spread at the TOP level, not nested) plus the
# CLI's own non-JSON banner, once, then hold the connection open like the real one.
cat > "$STUB_BIN/telepty-listen" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "listen" ] && [ ! -f "$STUB_LISTEN_ONCE" ]; then
  : > "$STUB_LISTEN_ONCE"
  printf '%s\n' '👂 Listening to the telepty event bus...'
  printf '%s\n' '{"host":"127.0.0.1","type":"session_activity_observation","event_type":"session_activity_observation","sender":"daemon","session_id":"sid-noise","timestamp":"2026-08-15T10:00:00.000Z","transport":{"health_status":"CONNECTED"},"semantic":null}'
  printf '%s\n' '{"host":"127.0.0.1","type":"surface_orphaned","event_type":"surface_orphaned","sender":"daemon","session_id":"sid-ghost","timestamp":"2026-08-15T10:00:01.000Z","transport":{"health_status":"CONNECTED"},"semantic":null,"sid":"sid-ghost","backend":"cmux","cmuxWorkspaceId":"WS-GHOST","surfaceGoneSeconds":420,"livenessVerdict":"gone","ownerSocketOpen":true,"reclaimed":false}'
  printf '%s\n' '{"host":"127.0.0.1","type":"surface_mismatched","event_type":"surface_mismatched","sender":"daemon","session_id":"sid-stray","timestamp":"2026-08-15T10:00:02.000Z","transport":{},"semantic":null,"sid":"sid-stray","backend":"cmux","cmuxWorkspaceId":"WS-STRAY","expectedPtyPid":4242,"observedSurface":"ttys009","mismatchSeconds":90}'
fi
sleep 120
EOF
chmod +x "$STUB_BIN/telepty-listen"
export STUB_LISTEN_ONCE="$T_TMP/listen-emitted"

run_bridge_env() {
  TELEPTY="$STUB_BIN/telepty-listen" \
  CURL="$STUB_BIN/curl-200" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
  BUS_BRIDGE_READ_TIMEOUT=1 \
    "$BRIDGE" "$@"
}

run_bridge_env --ensure || fail "--ensure exited non-zero"
wait_for 15 test -s "$ORPHANED" \
  || fail "no surface_orphaned line reached $ORPHANED; health=$(cat "$DISPATCH_STATE_DIR/bus-bridge-health.json" 2>/dev/null), err=$(cat "$DISPATCH_STATE_DIR/bus-bridge.err" 2>/dev/null)"
wait_for 15 test -s "$MISMATCHED" \
  || fail "no surface_mismatched line reached $MISMATCHED"
BRIDGE_PIDS="$(cat "$DISPATCH_STATE_DIR/bus-bridge.pid" 2>/dev/null || true)"

[ "$(wc -l < "$ORPHANED" | tr -d ' ')" = "1" ] \
  || fail "expected exactly 1 orphaned line, got $(wc -l < "$ORPHANED"):
$(cat "$ORPHANED")"
t_assert_contains "$ORPHANED" '"sid":"sid-ghost"'
t_assert_contains "$ORPHANED" '"livenessVerdict":"gone"'
t_assert_contains "$ORPHANED" '"surfaceGoneSeconds":420'
t_assert_contains "$MISMATCHED" '"sid":"sid-stray"'
t_assert_contains "$MISMATCHED" '"expectedPtyPid":4242'

# The bus event's transport/semantic blocks and every other event kind are NOT
# mirrored — this is the "filter at the bridge" constraint, asserted.
grep -q 'sid-noise\|session_activity_observation\|health_status' "$ORPHANED" "$MISMATCHED" \
  && fail "the bridge mirrored bus payload it must filter out:
$(cat "$ORPHANED" "$MISMATCHED")"

# ===========================================================================
# B) singleton
# ===========================================================================
SECOND_LOG="$T_TMP/second.log"
run_bridge_env --run > "$SECOND_LOG" 2>&1 || fail "a losing second instance must exit 0, not fail"
grep -q "already running" "$SECOND_LOG" \
  || fail "second instance did not name the first; log:
$(cat "$SECOND_LOG")"
[ "$(cat "$DISPATCH_STATE_DIR/bus-bridge.pid")" = "$BRIDGE_PIDS" ] \
  || fail "second instance overwrote the pidfile (duplicate-writer regression, #539/#618)"

# ===========================================================================
# C) the drain handoff — the consumers' decision logic is untouched; the drain
#    REMOVES the file so the bridge's next rename-install has a free path.
# ===========================================================================
SCHED_STUB="$STUB_BIN/sched-noop.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$SCHED_STUB"; chmod +x "$SCHED_STUB"
CLEANUP_STUB="$STUB_BIN/cleanup-noop.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$CLEANUP_STUB"; chmod +x "$CLEANUP_STUB"
printf '%s' '[]' > "$STUB_LIST_FILE"     # no sessions -> the sweep has nothing to do

run_reconciler() {
  RUN_LOG="$T_TMP/recon.log"
  AIGENTRY_BUS_BRIDGE=0 \
  RECONCILER_NOW="2026-08-15T12:00:00Z" \
  TELEPTY="$STUB_BIN/telepty" \
  SCHEDULER_SH="$SCHED_STUB" \
  CLEANUP_SH="$CLEANUP_STUB" \
  AIGENTRY_ROLE_SANDBOX_DIR="$T_TMP/no-such-sandbox" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
    bash "$RECONCILER" "$@" > "$RUN_LOG" 2>&1 \
      || fail "reconciler exited non-zero ($*):
$(cat "$RUN_LOG")"
}

run_reconciler
grep -q "surface_orphaned consumed=1" "$RUN_LOG" \
  || fail "the consumer did not consume the bridged surface_orphaned event; log:
$(cat "$RUN_LOG")"
grep -q "surface_mismatched consumed=1" "$RUN_LOG" \
  || fail "the consumer did not consume the bridged surface_mismatched event; log:
$(cat "$RUN_LOG")"
[ -e "$ORPHANED" ] \
  && fail "drain left $ORPHANED in place — the bridge installs by rename onto an ABSENT path, so a truncate-drain wedges every later batch in the spool"
[ -e "$MISMATCHED" ] \
  && fail "drain left $MISMATCHED in place (same rename-install contract)"

# ===========================================================================
# D) a gated-out event actuates nothing and is STILL drained
# ===========================================================================
printf '%s\n' '{"sid":"sid-indeterminate","backend":"cmux","cmuxWorkspaceId":"WS-X","surfaceGoneSeconds":900,"livenessVerdict":"unknown","timestamp":"2026-08-15T11:00:00Z"}' > "$ORPHANED"
run_reconciler
grep -q "surface_orphaned consumed" "$RUN_LOG" \
  && fail "an INV-17-gated event (livenessVerdict=unknown) was counted as consumed — it must actuate nothing"
grep -q "SURFACE_ORPHANED closed" "$RUN_LOG" \
  && fail "a close fired on livenessVerdict=unknown (INV-17 regression)"
[ -e "$ORPHANED" ] \
  && fail "a rejected event was retained — it is rejected forever, and keeping it grows the file without bound once a bridge feeds it"

# --dry-run must still change nothing.
printf '%s\n' '{"sid":"sid-ghost","backend":"cmux","cmuxWorkspaceId":"WS-GHOST","surfaceGoneSeconds":420,"livenessVerdict":"gone","timestamp":"2026-08-15T11:00:00Z"}' > "$ORPHANED"
run_reconciler --dry-run
[ -e "$ORPHANED" ] || fail "--dry-run drained the source (it must be report-only)"
grep -q "SURFACE_ORPHANED would-close sid=sid-ghost" "$RUN_LOG" \
  || fail "--dry-run did not report the would-close; log:
$(cat "$RUN_LOG")"
rm -f "$ORPHANED"

# stop the part-A bridge before part E starts one of its own
for p in $BRIDGE_PIDS; do kill "$p" 2>/dev/null || true; done
BRIDGE_PIDS=""

# ===========================================================================
# E) live subscribe against a real daemon we own
# ===========================================================================
if [ -z "$REAL_TELEPTY" ]; then
  echo "T95: SKIP part E — no telepty CLI on PATH (transport untested here)" >&2
else
  D_HOME="$T_TMP/dhome"
  mkdir -p "$D_HOME/.telepty"
  printf '%s' '{"authToken":"tok-T95-livesmoke"}' > "$D_HOME/.telepty/config.json"
  chmod 600 "$D_HOME/.telepty/config.json"
  # An ephemeral port we picked, never :3848, and TELEPTY_BIND pins it to loopback
  # so this daemon is not reachable off the box for the seconds it lives.
  D_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  [ "$D_PORT" != "3848" ] || fail "refusing to run the live smoke on the production port"
  HOME="$D_HOME" PORT="$D_PORT" TELEPTY_BIND=127.0.0.1 \
    "$REAL_TELEPTY" daemon > "$T_TMP/daemon.log" 2>&1 &
  DAEMON_PID=$!

  daemon_up() {
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
        -H "x-telepty-token: tok-T95-livesmoke" \
        "http://127.0.0.1:$D_PORT/api/sessions" 2>/dev/null || true)" = "200" ]
  }
  wait_for 30 daemon_up \
    || fail "test daemon never answered on 127.0.0.1:$D_PORT; log:
$(cat "$T_TMP/daemon.log")"

  LIVE_STATE="$T_TMP/live-state"
  mkdir -p "$LIVE_STATE"
  HOME="$D_HOME" TELEPTY_PORT="$D_PORT" TELEPTY="$REAL_TELEPTY" \
  DISPATCH_STATE_DIR="$LIVE_STATE" BUS_BRIDGE_READ_TIMEOUT=1 \
    "$BRIDGE" --ensure || fail "--ensure exited non-zero against the live daemon"

  live_connected() {
    grep -q '"state": "connected"' "$LIVE_STATE/bus-bridge-health.json" 2>/dev/null
  }
  wait_for 25 live_connected \
    || fail "the bridge never reached the live bus on 127.0.0.1:$D_PORT; health=$(cat "$LIVE_STATE/bus-bridge-health.json" 2>/dev/null), err=$(cat "$LIVE_STATE/bus-bridge.err" 2>/dev/null)"
  BRIDGE_PIDS="$(cat "$LIVE_STATE/bus-bridge.pid" 2>/dev/null || true)"
  # It subscribed without starting anything: the daemon we started is still the
  # only one, and it is the one on OUR port.
  grep -q "\"listen_pid\"" "$LIVE_STATE/bus-bridge-health.json" \
    || fail "no listener recorded for the live subscription"
  kill -0 "$DAEMON_PID" 2>/dev/null || fail "the test daemon died during the smoke"
fi

echo "T95 PASS"
