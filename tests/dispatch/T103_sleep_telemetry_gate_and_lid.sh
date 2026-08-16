#!/usr/bin/env bash
# T103 — sleep-aware telemetry gate + closed-lid page (#909 item d).
#
# Measured 2026-08-16: ~70 orchestrator turns during one 7.5h host sleep. Each was
# an idle-worker note delivered inside a DarkWake maintenance window, and each woke
# a session that could do nothing about it — the workers were stalled by the same
# sleep that was waking the orchestrator.
#
# Measured path, re-measured for this guard rather than taken on report: the ONLY
# orchestrator-side forwarder of that telemetry is bin/dispatch-tracker.sh, at two
# sites — `HOLD sid=… no completion fact observed` (_poll_observations_and_hold) and
# `WORKTREE_ACTIVITY sid=…` (_git_check_and_observe). The daemon-side
# TASK_COMPLETION_UNKNOWN emission that feeds them is telepty's and out of scope.
#
# The gate must never LOSE a note: the tracker's seen-ledger marks a note raised
# before it is sent, so a withheld note is never re-raised and the digest is its
# only route to a human. Several assertions below are about that, not about silence.
#
# Hermetic: pmset/ioreg are seams (AIGENTRY_HOST_POWER_STATE / AIGENTRY_IOREG), stub
# telepty, tmp state dir, frozen clock. The real host's power state is never read.
#
# Asserts:
#   A) asleep ⇒ the note is QUEUED, not injected.
#   B) awake ⇒ injected, nothing queued.
#   C) unknown ⇒ injected. Fail-open: nothing is withheld on an unmeasured state.
#   D) first tick after wake ⇒ ONE digest inject carrying the count and the notes,
#      queue drained.
#   E) still asleep ⇒ no digest, queue intact.
#   F) a failed digest delivery does NOT drain the queue, and pages.
#   G) lid closed + live workers ⇒ LID_CLOSED once per episode, naming the remedy;
#      re-armed by the lid opening.
#   H) lid closed + no live workers ⇒ silent. Lid unknown ⇒ silent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T103]: $*" >&2; exit 1; }

RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"
NOW="2026-08-16T12:00:00Z"
QUEUE="$DISPATCH_STATE_DIR/sleep-telemetry-queue.log"
ALERTS="$DISPATCH_STATE_DIR/alerts.log"
LID_LATCH="$DISPATCH_STATE_DIR/lid-closed.latch"

# ── the tracker half: one note, three power states ───────────────────────────────────
# A 404 observation endpoint is the shortest route to a real HOLD forward (T36's path).
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
cat /dev/null
printf '\n404'
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl"

tracker_note() {   # <power-state> — fresh state each time; prints nothing
  rm -f "$QUEUE" "$DISPATCH_STATE_DIR/observations.seen"
  : > "$STUB_DISPATCH_LOG"
  t_init_v2
  t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-111 \
    expected_report_by="2026-05-12T11:30:00Z"
  AIGENTRY_HOST_POWER_STATE="$1" t_run_tracker check >/dev/null
}
injected() { grep -c 'HOLD sid=sid-A' "$STUB_DISPATCH_LOG" 2>/dev/null || true; }
queued()   { if [ -f "$QUEUE" ]; then grep -c 'HOLD sid=sid-A' "$QUEUE" || true; else echo 0; fi; }

# --- A) asleep ⇒ queued, not injected ------------------------------------------------
tracker_note asleep
[ "$(injected)" = "0" ] \
  || fail "A: telemetry was injected to the orchestrator while the host was asleep — that is the ~70-turn defect:
$(cat "$STUB_DISPATCH_LOG")"
[ "$(queued)" = "1" ] \
  || fail "A: the withheld note was DROPPED, not queued. The tracker already marked it raised, so it can never be re-raised."
grep -q "$NOW\|20" "$QUEUE" || fail "A: the queued note carries no timestamp: $(cat "$QUEUE")"

# --- B) awake ⇒ injected, nothing queued ---------------------------------------------
tracker_note awake
[ "$(injected)" = "1" ] || fail "B: an awake host did not forward telemetry: $(cat "$STUB_DISPATCH_LOG")"
[ "$(queued)" = "0" ] || fail "B: an awake host queued instead of forwarding: $(cat "$QUEUE")"

# --- C) unknown ⇒ injected (fail-open) -----------------------------------------------
tracker_note unknown
[ "$(injected)" = "1" ] \
  || fail "C: telemetry was withheld on an UNMEASURED power state. Unknown must never suppress — a Linux host reports unknown for every tick."

# ── the reconciler half: digest + lid ────────────────────────────────────────────────
noop() { printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$1"; chmod +x "$1"; }
noop "$STUB_BIN/sched-noop.sh"; noop "$STUB_BIN/cleanup-noop.sh"
noop "$STUB_BIN/tracker-noop.sh"; noop "$STUB_BIN/comms-noop.sh"; noop "$STUB_BIN/bridge-noop.sh"
noop "$STUB_BIN/hitl-noop.sh"
cat > "$STUB_BIN/curl-200" <<'EOF'
#!/usr/bin/env bash
printf '200'
EOF
chmod +x "$STUB_BIN/curl-200"

# ioreg seam: AppleClamshellState is whatever $T_TMP/lid holds.
cat > "$STUB_BIN/ioreg-stub" <<EOF
#!/usr/bin/env bash
state=\$(cat "$T_TMP/lid" 2>/dev/null || echo No)
[ "\$state" = "absent" ] && exit 0
printf '  |   "AppleClamshellState" = %s\n' "\$state"
EOF
chmod +x "$STUB_BIN/ioreg-stub"
lid() { printf '%s' "$1" > "$T_TMP/lid"; }
lid No

run_tick() {   # <power-state> [extra env…]
  local power="$1"; shift
  RUN_LOG="$T_TMP/recon.log"
  AIGENTRY_BUS_BRIDGE=0 \
  RECONCILER_NOW="$NOW" \
  AIGENTRY_HOST_POWER_STATE="$power" \
  AIGENTRY_IOREG="$STUB_BIN/ioreg-stub" \
  CURL="$STUB_BIN/curl-200" \
  TELEPTY="${TICK_TELEPTY:-$STUB_BIN/telepty}" \
  SCHEDULER_SH="$STUB_BIN/sched-noop.sh" \
  CLEANUP_SH="$STUB_BIN/cleanup-noop.sh" \
  TRACKER_SH="$STUB_BIN/tracker-noop.sh" \
  COMMS_AUDITOR_SH="$STUB_BIN/comms-noop.sh" \
  BRIDGE_AUDITOR_SH="$STUB_BIN/bridge-noop.sh" \
  HITL_SH="$STUB_BIN/hitl-noop.sh" \
  AIGENTRY_ROLE_SANDBOX_DIR="$T_TMP/no-such-sandbox" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
    env "$@" bash "$RECONCILER" > "$RUN_LOG" 2>&1 \
      || fail "reconciler tick exited non-zero:
$(cat "$RUN_LOG")"
}

seed_queue() {
  printf '2026-08-16T03:10:00Z\tHOLD sid=w-1 reason=observation_endpoint_absent\n' > "$QUEUE"
  printf '2026-08-16T04:40:00Z\tHOLD sid=w-2 reason=no_transport_inject_id\n' >> "$QUEUE"
}
digests() { grep -c 'SLEEP_DIGEST:' "$STUB_DISPATCH_LOG" 2>/dev/null || true; }

# A live session so the tick has something to hold open (also feeds G).
t_init_v2
t_seed_dispatch w-1 lifecycle.state=in_flight expected_report_by=2027-01-01T00:00:00Z
printf '[{"id":"w-1","command":"claude","healthStatus":"CONNECTED","startedAt":"2026-08-16T11:00:00Z"}]' \
  > "$STUB_LIST_FILE"
printf '● working\n❯ Try "x"\n' > "$STUB_SCREEN_FILE"

# --- E) still asleep ⇒ no digest, queue intact ---------------------------------------
seed_queue; : > "$STUB_DISPATCH_LOG"; : > "$ALERTS"
run_tick asleep
[ "$(digests)" = "0" ] || fail "E: delivered a digest while the host was still asleep"
[ -s "$QUEUE" ] || fail "E: drained the queue while asleep — the notes are gone and cannot be re-raised"

# --- D) first tick after wake ⇒ exactly one digest, queue drained --------------------
: > "$STUB_DISPATCH_LOG"
run_tick awake
[ "$(digests)" = "1" ] || fail "D: expected exactly 1 digest inject, got $(digests):
$(cat "$STUB_DISPATCH_LOG")
--- tick ---
$(cat "$RUN_LOG")"
t_assert_contains "$STUB_DISPATCH_LOG" '2 idle-worker telemetry note(s)'
t_assert_contains "$STUB_DISPATCH_LOG" 'sid=w-1'
t_assert_contains "$STUB_DISPATCH_LOG" 'sid=w-2'
[ -f "$QUEUE" ] && fail "D: the queue survived a delivered digest — the next wake would re-send it"
: > "$STUB_DISPATCH_LOG"
run_tick awake
[ "$(digests)" = "0" ] || fail "D: a second digest went out with an empty queue"

# --- F) a failed delivery keeps the queue and pages ---------------------------------
cat > "$STUB_BIN/telepty-failing" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inject) exit 1;;
  read-screen) cat "\${STUB_SCREEN_FILE:-/dev/null}";;
  session) shift; [ "\${1:-}" = "info" ] && cat "\${STUB_INFO_FILE:-/dev/null}";;
  list) shift; [ "\${1:-}" = "--json" ] && cat "\${STUB_LIST_FILE:-/dev/null}";;
  *) exit 0;;
esac
EOF
chmod +x "$STUB_BIN/telepty-failing"
seed_queue; : > "$ALERTS"
TICK_TELEPTY="$STUB_BIN/telepty-failing" run_tick awake
[ -s "$QUEUE" ] \
  || fail "F: an UNDELIVERED digest drained the queue — those notes are the tracker's only record and it will not re-raise them"
grep -q 'SLEEP_DIGEST_UNDELIVERED' "$ALERTS" || fail "F: a failed digest was silent: $(cat "$ALERTS")"
rm -f "$QUEUE"

# --- G) closed lid with live workers ⇒ one page per episode --------------------------
lid Yes
rm -f "$LID_LATCH"; : > "$ALERTS"
run_tick awake
grep -q 'LID_CLOSED' "$ALERTS" || fail "G: lid shut with a live worker raised nothing:
$(cat "$ALERTS")
--- tick ---
$(cat "$RUN_LOG")"
grep -q 'caffeinate' "$ALERTS" \
  || fail "G: the page does not say WHY the sleep assertion will not save this (clamshell beats caffeinate -i): $(cat "$ALERTS")"
grep -q 'external display' "$ALERTS" || fail "G: the page names no remedy: $(cat "$ALERTS")"
: > "$ALERTS"
run_tick awake
grep -q 'LID_CLOSED' "$ALERTS" \
  && fail "G: paged again on the next 60s tick — one page per episode, not one per minute"
# Opening the lid re-arms it.
lid No; : > "$ALERTS"
run_tick awake
[ -f "$LID_LATCH" ] && fail "G: the latch survived the lid opening — the next episode would be silent"
lid Yes; : > "$ALERTS"
run_tick awake
grep -q 'LID_CLOSED' "$ALERTS" || fail "G: a NEW closed-lid episode was swallowed by a stale latch"

# --- H) no live workers ⇒ silent; unknown lid ⇒ silent -------------------------------
t_init_v2   # no dispatches at all
rm -f "$LID_LATCH"; lid Yes; : > "$ALERTS"
run_tick awake
grep -q 'LID_CLOSED' "$ALERTS" \
  && fail "H: paged about a closed lid with no workers to stall — that is a laptop being shut for the night"
t_seed_dispatch w-1 lifecycle.state=in_flight expected_report_by=2027-01-01T00:00:00Z
rm -f "$LID_LATCH"; lid absent; : > "$ALERTS"
run_tick awake
grep -q 'LID_CLOSED' "$ALERTS" \
  && fail "H: paged on an UNKNOWN clamshell state (a desktop, or an ioreg that answered nothing)"

echo "T103 PASS gate=asleep-queues digest=once-on-wake lid=once-per-episode"
