#!/usr/bin/env bash
# T102 — a turn cut by host sleep is RESUMED once, autonomously (#909 item c).
#
# Measured 2026-08-16: three worker turns showed, verbatim,
#   "API Error: Your computer went to sleep mid-response. The response above may be
#    incomplete."
# session-probe.py folded that into the generic `error` surface, whose policy is
# AWAIT_USER — an operator gate. But there is nothing here for an operator to
# classify: the host slept, the turn is resumable, and each recovery cost a human
# noticing telemetry silence and injecting RESUME by hand (33m, 1h7m and 31m of work
# stalled behind that notice).
#
# The danger of automating it is a loop, so the assertions are mostly about the
# BOUNDS (Rule 30): one per occurrence, a rolling per-hour cap, and a latch that only
# a changed surface can clear.
#
# Hermetic: stub telepty (screen + inject recorder), stub tracker/scheduler/auditors,
# stub hitl, tmp state dir, frozen clock. No real sid, no real daemon.
#
# Asserts:
#   A) probe: the measured string ⇒ surface=sleep_cut, and it beats the generic
#      API-error classification (which would send it to a gate).
#   B) policy: sleep_cut ⇒ RESUME; a generic API error still ⇒ AWAIT_USER; the
#      lifecycle status is NOT rewritten (that would drop the record out of --live).
#   C) one tick on a cut screen ⇒ exactly ONE RESUME inject, from the orchestrator
#      lane (a reconciler-named peer inject is what the comms auditor HOLDs on).
#   D) a second tick on the same occurrence ⇒ NO second RESUME.
#   E) the surface changing clears the latch; a LATER cut is a NEW occurrence.
#   F) the per-hour cap holds even across distinct occurrences, and says so.
#   G) no HITL gate is opened for a sleep cut (that is the path being replaced).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T102]: $*" >&2; exit 1; }

RECONCILER="$REPO_ROOT/bin/session-reconciler.sh"
PROBE="$REPO_ROOT/bin/session-probe.py"
POLICY="$REPO_ROOT/bin/policy.py"
NOW="2026-08-16T12:00:00Z"
SID="sid-A"

# The measured banner, verbatim.
CUT_LINE='API Error: Your computer went to sleep mid-response. The response above may be incomplete.'

write_screen() { printf '%s\n' "$@" > "$STUB_SCREEN_FILE"; }
cut_screen()   { write_screen '● Edited bin/thing.sh' '' "$CUT_LINE" '' '❯'; }
idle_screen()  { write_screen '● Edited bin/thing.sh' '' '❯ Try "fix the failing test"'; }

# --- A) the probe classifies it apart from the generic error surface -----------------
cut_screen
state=$("$PROBE" --sid "$SID" --screen-file "$STUB_SCREEN_FILE" --info-file "$STUB_INFO_FILE")
surface=$(printf '%s' "$state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["surface"])')
[ "$surface" = "sleep_cut" ] || fail "A: surface=$surface, want sleep_cut for: $CUT_LINE"
write_screen '● Edited bin/thing.sh' '' 'API Error: 529 overloaded_error' '' '❯'
surface=$("$PROBE" --sid "$SID" --screen-file "$STUB_SCREEN_FILE" --info-file "$STUB_INFO_FILE" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["surface"])')
[ "$surface" = "error" ] || fail "A: a generic API error became surface=$surface — the sleep-cut arm widened past its measurement"

# --- B) policy: RESUME, and the status is left alone ---------------------------------
decide() {
  printf '%s' "$2" | "$POLICY" --status "$1" --state - \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["action"], d["status"])'
}
st_cut='{"alive":true,"ready":false,"surface":"sleep_cut","activity":"static","cli":"claude","detail":{}}'
st_err='{"alive":true,"ready":false,"surface":"error","activity":"static","cli":"claude","detail":{}}'
got=$(decide in_flight "$st_cut")
[ "$got" = "RESUME in_flight" ] \
  || fail "B: sleep_cut ⇒ '$got', want 'RESUME in_flight' (a rewritten status drops the record out of --live)"
got=$(decide in_flight "$st_err")
[ "$got" = "AWAIT_USER stuck_error" ] \
  || fail "B: the generic error row moved to '$got' — operator classification must be unchanged"

# --- stubs for the tick --------------------------------------------------------------
noop() { printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$1"; chmod +x "$1"; }
noop "$STUB_BIN/sched-noop.sh"; noop "$STUB_BIN/cleanup-noop.sh"
noop "$STUB_BIN/tracker-noop.sh"; noop "$STUB_BIN/comms-noop.sh"; noop "$STUB_BIN/bridge-noop.sh"

HITL_LOG="$T_TMP/hitl-calls.log"; : > "$HITL_LOG"
cat > "$STUB_BIN/hitl-recorder" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$HITL_LOG"
exit 0
EOF
chmod +x "$STUB_BIN/hitl-recorder"

cat > "$STUB_BIN/curl-recorder" <<'EOF'
#!/usr/bin/env bash
printf '200'
exit 0
EOF
chmod +x "$STUB_BIN/curl-recorder"

t_seed_dispatch "$SID" lifecycle.state=in_flight expected_report_by=2027-01-01T00:00:00Z
printf '[{"id":"%s","command":"claude","healthStatus":"CONNECTED","startedAt":"2026-08-16T11:00:00Z"}]' \
  "$SID" > "$STUB_LIST_FILE"

ALERTS="$DISPATCH_STATE_DIR/alerts.log"

run_tick() {
  RUN_LOG="$T_TMP/recon.log"
  AIGENTRY_BUS_BRIDGE=0 \
  RECONCILER_NOW="${TICK_NOW:-$NOW}" \
  CURL="$STUB_BIN/curl-recorder" \
  TELEPTY="$STUB_BIN/telepty" \
  SCHEDULER_SH="$STUB_BIN/sched-noop.sh" \
  CLEANUP_SH="$STUB_BIN/cleanup-noop.sh" \
  TRACKER_SH="$STUB_BIN/tracker-noop.sh" \
  COMMS_AUDITOR_SH="$STUB_BIN/comms-noop.sh" \
  BRIDGE_AUDITOR_SH="$STUB_BIN/bridge-noop.sh" \
  HITL_SH="$STUB_BIN/hitl-recorder" \
  AIGENTRY_ROLE_SANDBOX_DIR="$T_TMP/no-such-sandbox" \
  DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
    env "$@" bash "$RECONCILER" > "$RUN_LOG" 2>&1 \
      || fail "reconciler tick exited non-zero:
$(cat "$RUN_LOG")"
}

resumes() { grep -cF -- "RESUME: your last turn was cut" "$STUB_DISPATCH_LOG" 2>/dev/null || true; }

# --- C) one cut ⇒ exactly one RESUME, in the orchestrator lane -----------------------
cut_screen
: > "$STUB_DISPATCH_LOG"; : > "$ALERTS"
run_tick
[ "$(resumes)" = "1" ] || fail "C: expected exactly 1 RESUME inject, got $(resumes). injects:
$(cat "$STUB_DISPATCH_LOG")
--- tick ---
$(cat "$RUN_LOG")"
t_assert_contains "$STUB_DISPATCH_LOG" "--from orchestrator"
t_assert_contains "$STUB_DISPATCH_LOG" "--submit-force"
grep -qF -- "--from session-reconciler" "$STUB_DISPATCH_LOG" \
  && fail "C: the RESUME was sent on the peer lane — session-comms-auditor.sh HOLDs on those, one operator page per recovery"
grep -q 'SLEEP_RESUME ' "$ALERTS" || fail "C: the RESUME was not recorded in alerts.log: $(cat "$ALERTS")"

# --- G) and no operator gate was opened ---------------------------------------------
grep -q 'open' "$HITL_LOG" 2>/dev/null \
  && fail "G: a HITL gate was opened for a sleep cut — that is the manual path being replaced: $(cat "$HITL_LOG")"

# --- D) same occurrence on the next tick ⇒ silence -----------------------------------
: > "$STUB_DISPATCH_LOG"
run_tick
[ "$(resumes)" = "0" ] || fail "D: a second RESUME went out for the same occurrence — that is the 60s loop this must not become:
$(cat "$STUB_DISPATCH_LOG")"
grep -q 'SLEEP_RESUME skip' "$T_TMP/recon.log" \
  || fail "D: the suppressed repeat was not logged (a silent skip is indistinguishable from a broken detector)"

# --- E) surface changes ⇒ latch clears ⇒ a later cut is a NEW occurrence -------------
idle_screen
: > "$STUB_DISPATCH_LOG"
run_tick
[ "$(resumes)" = "0" ] || fail "E: RESUMED an idle session"
cut_screen
: > "$STUB_DISPATCH_LOG"
run_tick
[ "$(resumes)" = "1" ] || fail "E: a NEW sleep cut after a recovered turn was swallowed by the latch — got $(resumes) RESUME(s):
$(cat "$RUN_LOG")"

# --- F) the rolling per-hour cap holds across occurrences ----------------------------
# Two sends already happened this hour. Cap at 2 ⇒ the next occurrence is refused.
idle_screen; run_tick          # clear the latch
cut_screen
: > "$STUB_DISPATCH_LOG"; : > "$ALERTS"
run_tick RECONCILER_RESUME_MAX_PER_HOUR=2
[ "$(resumes)" = "0" ] || fail "F: the per-hour cap did not hold — a session that never comes back would be RESUMED forever"
grep -q 'SLEEP_RESUME_CAPPED' "$ALERTS" \
  || fail "F: the cap fired silently; a capped session needs a human and must page for one: $(cat "$ALERTS")"
grep -q 'needs a human' "$ALERTS" || fail "F: the cap alert does not say what happens next: $(cat "$ALERTS")"

# ...and an hour later the same cut is allowed again (rolling, not permanent).
idle_screen; TICK_NOW="2026-08-16T13:30:00Z" run_tick
cut_screen
: > "$STUB_DISPATCH_LOG"
TICK_NOW="2026-08-16T13:30:00Z" run_tick RECONCILER_RESUME_MAX_PER_HOUR=2
[ "$(resumes)" = "1" ] \
  || fail "F: the cap never expires — it is supposed to be a rolling hour, not a permanent ban:
$(cat "$RUN_LOG")"

echo "T102 PASS resume=1-per-occurrence cap=rolling-hour gate=not-opened"
