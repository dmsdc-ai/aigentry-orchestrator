#!/usr/bin/env bash
# T91 — an escalation, and a delivery verification, may only claim what they
# measured (#835/#836).
#
# Three claims that were being made without evidence:
#
#   ask.sh          escalates a peer dispute to the orchestrator without checking
#                   that the named parties exist. Two such escalations fired this
#                   month — one naming a copy-pasted placeholder, one a session
#                   already cleaned up and merged — and each cost an operator a
#                   verification round to dismiss. A dispute between parties that
#                   do not exist is a claim beyond the measurement. (#836)
#
#   ask.sh          then sent that escalation with a trailing `|| true`, so an
#                   escalation the transport rejected was reported as sent. §6 of
#                   the guardrail spec says the channel never silently drops, and
#                   a swallowed non-zero is exactly a silent drop. (#835)
#
#   dispatch.sh     --verify-delivered read the session's screen back to confirm
#                   the inject landed, and folded a FAILED read into an empty
#                   screen. An empty screen matches no placeholder, so the check
#                   passed and the dispatch reported `verified: true` on the
#                   strength of having read nothing. (#835)
#
#   comms-auditor   routed each policy violation upward as a HOLD, `|| true`, and
#                   exited 0 — after its byte cursor had already advanced past the
#                   line. An undelivered HOLD therefore vanished for good. (#835)
#
# The rule in all four: absence of evidence is not evidence. "I could not tell"
# must stay distinguishable from "I checked and it is fine".
#
# Hermetic: stub telepty, temp state, fixture logs. No session is contacted.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
ASK="$REPO_ROOT/bin/ask.sh"
AUDITOR="$REPO_ROOT/bin/session-comms-auditor.sh"

fail() { echo "FAIL[T91]: $*" >&2; exit 1; }

export SESSION_COMMS_DIR="$T_TMP/session-comms"
export ASK_NOW="2026-08-01T12:00:00Z"
TELE="$SESSION_COMMS_DIR/telemetry.jsonl"
BOTH_LIVE='[{"id":"peer-A","healthStatus":"CONNECTED"},{"id":"peer-B","healthStatus":"CONNECTED"}]'

# ask_conflict <thread> → "<rc>\n<stderr>"; the --conflict fast-path always
# refuses the inject and escalates, so it is the shortest route to the escalator.
ask_conflict() {
  local thread="$1" out rc=0
  set +e
  out=$("$ASK" --from peer-A --to peer-B --thread "$thread" --conflict reply "we disagree" 2>&1 >/dev/null)
  rc=$?
  set -e
  printf '%s\n%s' "$rc" "$out"
}
rc_of()  { printf '%s' "$1" | head -1; }
out_of() { printf '%s' "$1" | tail -n +2; }

# ── (1) a party that does not exist ⇒ recorded stale, NOT escalated ─────────
printf '%s' '[{"id":"peer-A","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
: > "$STUB_DISPATCH_LOG"
res=$(ask_conflict t91-stale)
[ "$(rc_of "$res")" != "0" ] || fail "the --conflict path must still refuse the inject"
grep -q 'peer_escalation_stale' "$TELE" 2>/dev/null \
  || fail "an escalation naming a party that does not exist was not recorded stale; telemetry:
$(cat "$TELE" 2>/dev/null)"
if grep -q 'HOLD' "$STUB_DISPATCH_LOG" 2>/dev/null; then
  echo "--- injects ---" >&2; cat "$STUB_DISPATCH_LOG" >&2
  fail "the escalation was sent anyway — an operator would spend a verification round only to find one party does not exist"
fi
case "$(out_of "$res")" in
  *"not a live session"*) ;;
  *) fail "the caller was not told why nothing was escalated: $(out_of "$res")";;
esac

# ── (2) both parties live ⇒ the escalation goes (a filter, not an off switch) ─
printf '%s' "$BOTH_LIVE" > "$STUB_LIST_FILE"
: > "$STUB_DISPATCH_LOG"
res=$(ask_conflict t91-live)
[ "$(rc_of "$res")" != "0" ] || fail "the --conflict path must still refuse the inject"
grep -q 'HOLD' "$STUB_DISPATCH_LOG" \
  || fail "a real dispute between two live parties was not escalated; injects:
$(cat "$STUB_DISPATCH_LOG")"

# ── (3) liveness UNKNOWN ⇒ escalate anyway ──────────────────────────────────
# When the session list itself is unusable, "not in the list" is not evidence of
# absence. Suppressing on that would drop real escalations, and unlike a teardown
# a spurious HOLD destroys nothing.
printf '%s' 'not a listing at all' > "$STUB_LIST_FILE"
: > "$STUB_DISPATCH_LOG"; : > "$TELE"
res=$(ask_conflict t91-unknown)
grep -q 'HOLD' "$STUB_DISPATCH_LOG" \
  || fail "the escalation was dropped on an UNKNOWN liveness answer; injects:
$(cat "$STUB_DISPATCH_LOG")"
grep -q 'peer_escalation_stale' "$TELE" 2>/dev/null \
  && fail "an unusable session list was treated as proof the parties are gone"

# ── (4) an escalation the transport rejected is not an escalation ───────────
printf '%s' "$BOTH_LIVE" > "$STUB_LIST_FILE"
cat > "$STUB_BIN/telepty" <<EOF
#!/usr/bin/env bash
case "\$1" in
  list)   shift; [ "\${1:-}" = "--json" ] && cat "$STUB_LIST_FILE"; exit 0;;
  inject) printf '%s ' "telepty inject" "\$@" >> "$STUB_DISPATCH_LOG"; printf '\n' >> "$STUB_DISPATCH_LOG"
          case "\$*" in *orchestrator*) exit 1;; esac
          exit 0;;
  *)      exit 0;;
esac
EOF
chmod +x "$STUB_BIN/telepty"
: > "$STUB_DISPATCH_LOG"; : > "$TELE"
res=$(ask_conflict t91-undelivered)
case "$(out_of "$res")" in
  *"UNDELIVERED"*) ;;
  *) fail "a rejected escalation was reported as sent — the channel silently dropped it: $(out_of "$res")";;
esac
grep -q 'peer_escalation_undelivered' "$TELE" 2>/dev/null \
  || fail "the undelivered escalation left no record; telemetry:
$(cat "$TELE" 2>/dev/null)"
cp "$HERE/stubs/telepty" "$STUB_BIN/telepty"; chmod +x "$STUB_BIN/telepty"

# ── (5) a screen that could not be read is not a verified delivery ──────────
ref="$T_TMP/ref.md"
printf 'a line that will not appear on any screen\n' > "$ref"
: > "$STUB_SCREEN_FILE"                       # read-screen answers with nothing
(
  set -euo pipefail
  export DISPATCH_SH_NO_MAIN=1
  # shellcheck source=/dev/null
  source "$REPO_ROOT/bin/dispatch.sh"
  ref_file="$ref"
  sleep() { :; }
  rc=0
  verify_delivered sid-A >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] || { echo "FAIL[T91]: an unreadable screen was reported as a verified delivery" >&2; exit 1; }
  [ "$rc" -eq 2 ] || { echo "FAIL[T91]: an unreadable screen returned $rc — it must be distinguishable from a screen that was read and showed the inject did not land" >&2; exit 1; }
) || exit 1

# ── (6) an undelivered violation HOLD is not a clean audit pass ─────────────
export AIGENTRY_PEER_INJECT_LOG="$T_TMP/peer-injects.jsonl"
export AUDITOR_NOW="2026-08-01T12:00:00Z"
printf '%s\n' '{"ts":"2026-08-01T11:59:00Z","from":"peer-A","to":"peer-B","body":"go implement X and push"}' \
  > "$AIGENTRY_PEER_INJECT_LOG"
cat > "$STUB_BIN/telepty" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  inject) exit 1;;
  *)      exit 0;;
esac
EOF
chmod +x "$STUB_BIN/telepty"
set +e
aud_err=$(TELEPTY="$STUB_BIN/telepty" "$AUDITOR" 2>&1 >/dev/null)
aud_rc=$?
set -e
[ "$aud_rc" -ne 0 ] \
  || fail "the auditor reported a clean pass while its escalation never landed — and its cursor has already moved past the violation, so nothing will raise it again"
case "$aud_err" in
  *UNDELIVERED*) ;;
  *) fail "the auditor did not name the undelivered escalation: $aud_err";;
esac

echo "T91 PASS"
