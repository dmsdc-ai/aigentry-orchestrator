#!/usr/bin/env bash
# T124 (#899 tranche 5) — the inject-handler CLI contract, and the three declared
# deviations of the port.
#
# Four guards drive bin/inject-handler.sh today and between them they measure the
# happy path of three of its five arms: T24 the test-report write (fenced + markdown +
# one malformed refusal), T18 the same arm through a tester handoff, T17 the 3-layer
# lifecycle end to end, T83 the report arm's refusal to claim outcome authority. All
# four are worth keeping as they are. What none of them touches is the whole argv
# surface (`--help`, `-h`, an unknown flag, the stdin form), the `--sid required`
# refusal, the parse-failure line, the hold arm's audit record, the exact
# dispatch-cleanup-scheduler.sh argv the cleanup-request and extend-lifetime arms
# build, and every one of the five telemetry emissions.
#
# Each of those is a line a port can drop silently. The scheduler still schedules, the
# test-report still lands, and the only visible change is an operator's typo answered
# by a different exit code, an audit line holds.log readers no longer recognise, or a
# `--reason`/`--grace-seconds` flag quietly missing from a Layer-D call. So this guard
# is the characterization test that makes the port's parity measurable rather than
# reviewed.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $INJECT_HANDLER_UNDER_TEST, defaulting to bin/inject-handler.sh. Blocks A-I passed
# against the ORIGINAL bash (the merge-base of this port's branch, copied into bin/ so
# its SCRIPT_DIR and REPO_DIR resolve dist/ and the bin/ helpers the same way) before
# the port landed:
#
#   git show <base>:bin/inject-handler.sh > bin/.inject-handler-original.sh
#   chmod +x bin/.inject-handler-original.sh
#   INJECT_HANDLER_UNDER_TEST="$PWD/bin/.inject-handler-original.sh" \
#     INJECT_PARITY_ORIGINAL=1 bash tests/dispatch/T124_inject_handler_parity.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with the inject path. (T120 set this precedent.)
#
# BLOCKS J, K, L AND M ARE THE DECLARED DEVIATIONS, so they are the blocks that CANNOT
# pass against both implementations. INJECT_PARITY_ORIGINAL=1 makes them assert the
# ORIGINAL's behaviour instead of the port's — nothing is skipped in either direction,
# which is what keeps "the bash did X, the port does Y" a measurement rather than a
# claim:
#
#   J  D1 type — `payload.grace_seconds` reached `--grace-seconds` unvalidated. The
#      parser type-checks the field not at all (validateCleanupRequest,
#      src/session/inject-parser.ts), so `"grace_seconds": "soon"` from an
#      unauthenticated inject reached the scheduler, which used to truncate the whole
#      fleet's cleanup-pending.json to zero bytes and now (tranche 4 D1) refuses with
#      rc 1 — which `>/dev/null 2>&1 || true` ate. The envelope's cleanup was never
#      scheduled, the handler printed its ordinary success line and exited 0, and
#      NOTHING anywhere said so. Task #928.
#   K  D1 bounds — the scheduler validates integer-ness and no range, so a negative
#      grace_seconds wrote a scheduled_cleanup_time in the PAST: an unauthenticated
#      inject could make the next Layer-D tick retire a live session immediately, and
#      a negative defer_minutes pulled a pending cleanup earlier instead of later.
#      Bounds belong at the trust boundary, which is here.
#   L  D1 scheduler rc — a well-formed envelope whose scheduler call fails for any
#      other reason was equally silent. It stays exit 0 (the envelope WAS recognized,
#      which is the contract `--help` prints), but it stops being silent.
#   M  D2 — `payload.session_id` was pasted into the test-report filename after a
#      `typeof === "string"` check and nothing else, so `"../../../pwned"` wrote a
#      `.json` file of attacker-chosen content ANYWHERE the orchestrator user can
#      write, `mv` overwriting whatever was there — state/dispatch/active.json,
#      cleanup-pending.json, ~/.telepty/config.json. Same shape as the comms-auditor
#      D1 thread_id traversal (tranche 4). The port refuses a session_id that is not a
#      single safe path segment.
#
# Hermetic: the temp state dir from lib.sh, recorder stubs for all three children
# (scheduler, registry, telemetry), and a canary tree outside TEST_REPORTS_DIR that
# block M proves stayed untouched. This script contacts no daemon at all — no telepty,
# no curl — so there is nothing here that could reach :3848.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

HANDLER="${INJECT_HANDLER_UNDER_TEST:-$REPO_ROOT/bin/inject-handler.sh}"
ORIGINAL="${INJECT_PARITY_ORIGINAL:-0}"

fail() { echo "FAIL[T124]: $*" >&2; exit 1; }
[ -x "$HANDLER" ] || fail "$HANDLER is not executable — every caller execs it directly"

export TEST_REPORTS_DIR="$T_TMP/test-reports"
ALERTS="$DISPATCH_STATE_DIR/alerts.log"
HOLDS="$DISPATCH_STATE_DIR/holds.log"

# ── recorders for the three children ──
SCHED_LOG="$T_TMP/scheduler.log"; SCHED_STUB="$T_TMP/scheduler-stub.sh"
cat > "$SCHED_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SCHED_LOG"
exit \${SCHED_RC:-0}
EOF
REG_LOG="$T_TMP/registry.log"; REG_STUB="$T_TMP/registry-stub.sh"
cat > "$REG_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REG_LOG"
exit 0
EOF
EMIT_LOG="$T_TMP/telemetry.log"; EMIT_STUB="$T_TMP/emit-stub.sh"
cat > "$EMIT_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$EMIT_LOG"
exit 0
EOF
chmod +x "$SCHED_STUB" "$REG_STUB" "$EMIT_STUB"
export SCHEDULER_SH="$SCHED_STUB" DISPATCH_REGISTRY_PY="$REG_STUB" EMIT_TELEMETRY_MJS="$EMIT_STUB"

# run [--stdin <body>] <args...> — drive the handler. Sets: OUT RC ERRTXT.
# Every child log and the alerts log are truncated first, so each block reads only
# what its own invocation produced.
OUT=""; RC=0; ERRTXT=""
run() {
  : > "$SCHED_LOG"; : > "$REG_LOG"; : > "$EMIT_LOG"; : > "$ALERTS"
  local stdin_body=""
  if [ "${1:-}" = "--stdin" ]; then stdin_body="$2"; shift 2; fi
  local errf="$T_TMP/stderr.txt"
  set +e
  if [ -n "$stdin_body" ]; then
    OUT=$(printf '%s' "$stdin_body" | "$HANDLER" "$@" 2>"$errf")
  else
    OUT=$("$HANDLER" "$@" 2>"$errf" </dev/null)
  fi
  RC=$?
  set -e
  ERRTXT=$(cat "$errf")
}

body() { local f="$T_TMP/body-$1.txt"; shift; printf '%s\n' "$@" > "$f"; printf '%s' "$f"; }

# fenced <name> <payload-json-line> — a body carrying an envelope-in-PTY fence; echoes
# the path.
#
# KEEP THE `$( … )` CALL SITES BORING — this is a runner constraint, not style. CI's
# macOS job runs bash 3.2, and the first cut built each fenced body inline:
#   run --body-file "$(body "seg-$i" '```…' "{\"session_id\":\"$bad\",…}" '```')"
# Under bash 3.2 that call reached `run` as TWELVE positional parameters (the same path
# repeated eleven times, measured); under bash 5 it was the two it reads as. So the
# guard passed locally and failed on the runner for a reason with nothing to do with
# the inject path. Neither the backticks nor the `\"` escapes reproduce it alone in a
# minimal case — the exact 3.2 parse was not isolated — so the fix is structural rather
# than a workaround for a named bug: the fence lives in this function, and any payload
# needing interpolation is assembled into a variable BEFORE the substitution (see the
# M-block loop). Nothing inside a `$( … )` here is more than a bare word or "$var".
fenced() {
  local f="$T_TMP/body-$1.txt"
  { printf '%s\n' '```json aigentry-envelope/v1'; printf '%s\n' "$2"; printf '%s\n' '```'; } > "$f"
  printf '%s' "$f"
}

want_rc()   { [ "$RC" = "$1" ] || fail "$2: rc=$RC (want $1) out=<$OUT> err=<$ERRTXT>"; }
want_out()  { [ "$OUT" = "$1" ] || fail "$2: stdout=<$OUT> want=<$1>"; }
want_err()  { case "$ERRTXT" in *"$1"*) ;; *) fail "$2: stderr=<$ERRTXT> want substring <$1>";; esac; }
want_sched(){ grep -qxF "$1" "$SCHED_LOG" || { echo "--- scheduler calls ---" >&2; cat "$SCHED_LOG" >&2; fail "$2"; }; }
no_sched()  { [ ! -s "$SCHED_LOG" ] || { echo "--- scheduler calls ---" >&2; cat "$SCHED_LOG" >&2; fail "$1"; }; }
want_alert(){ grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z $1" "$ALERTS" \
                || { echo "--- alerts ---" >&2; cat "$ALERTS" 2>/dev/null >&2; fail "$2"; }; }
no_alert()  { [ ! -s "$ALERTS" ] || { echo "--- alerts ---" >&2; cat "$ALERTS" >&2; fail "$1"; }; }

# ── A. --help is 19 lines of the original header, truncated mid-Usage ──
run --help
want_rc 0 "A --help"
[ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" = 19 ] \
  || fail "A: --help printed $(printf '%s\n' "$OUT" | wc -l | tr -d ' ') lines, want 19 (sed -n '2,20p')"
case "$OUT" in
  "# inject-handler.sh — Orchestrator-side dispatcher for incoming inject envelopes."*) ;;
  *) fail "A: --help does not start with the header's first line: <${OUT%%$'\n'*}>";;
esac
[ "${OUT##*$'\n'}" = "#   inject-handler.sh < body.txt" ] \
  || fail "A: --help does not end at the sed range's last line: <${OUT##*$'\n'}>"
case "$OUT" in *"#   inject-handler.sh --body-file body.txt"*)
  fail "A: --help gained the --body-file usage line — sed -n '2,20p' stopped before it";; esac
t_assert_contains <(printf '%s' "$OUT") "#   test-report     → write state/test-reports/<YYYY-MM-DD>/<session_id>.json (R5a)"
run -h
want_rc 0 "A -h"
[ -n "$OUT" ] || fail "A: -h printed nothing"

# ── B. an unknown flag is a usage error, not a parse error ──
run --bogus
want_rc 4 "B unknown flag"
want_err "inject-handler: unknown --bogus" "B"
[ -z "$OUT" ] || fail "B: unknown flag wrote to stdout: <$OUT>"

# ── C. an unparseable body is the parser's error on stderr, exit 1 ──
run --stdin "this is not an envelope at all"
want_rc 1 "C parse failure"
want_err "inject-handler: parse failed: " "C"
no_sched "C: an unparseable body reached the scheduler"

# ── D. a REPORT envelope carries no sid, so --sid is required ──
run --body-file "$(body report 'REPORT: sid-A-DONE | files=bin/x.sh | build=green')"
want_rc 1 "D report without --sid"
want_err "inject-handler: --sid required for REPORT envelopes" "D"
no_sched "D: a sid-less report armed Layer D anyway"

# ── E. the report arm: two observations, an armed cleanup, one telemetry emission ──
run --sid sid-A --body-file "$(body report 'REPORT: sid-A-DONE | files=bin/x.sh | build=green')"
want_rc 0 "E report"
want_out "[inject-handler] report kind=report sid=sid-A transport=markdown-fallback — recorded as an observation; outcome_protocol_unavailable (0.8.0 has no terminal outcome); scheduler armed" "E"
grep -qxF "observe --sid sid-A --kind legacy_report_envelope_observed --field transport=markdown-fallback --field outcome_protocol=unavailable --field reason=stage_b_deferred_to_0.9.0" "$REG_LOG" \
  || { cat "$REG_LOG" >&2; fail "E: the nonterminal observation argv changed"; }
grep -qxF "observe --sid sid-A --kind cleanup_scheduled_from_legacy_report_envelope --field basis=legacy_report_envelope" "$REG_LOG" \
  || { cat "$REG_LOG" >&2; fail "E: the D1-condition basis observation argv changed"; }
want_sched "schedule sid-A --grace-seconds 60 --source legacy-report-envelope" "E: the Layer-D arm's argv changed"
grep -qxF -e '--helper report --subtype report --payload-json {"target_sid":"sid-A","transport":"markdown-fallback"} --correlation-id sid-A' "$EMIT_LOG" \
  || { cat "$EMIT_LOG" >&2; fail "E: the report telemetry argv changed"; }

# ── F. cleanup-request, read from STDIN (the form no guard covered) ──
run --stdin 'CLEANUP_REQUEST: worker-3 | reason: phase done | grace_seconds: 120'
want_rc 0 "F cleanup-request"
want_out "[inject-handler] cleanup-request target=worker-3 transport=markdown-fallback" "F"
want_sched "schedule worker-3 --source explicit-request --reason phase done --grace-seconds 120" "F: the cleanup argv changed (order/flags are the scheduler's contract)"
grep -qxF -e '--helper lifecycle --subtype cleanup --payload-json {"target":"worker-3","reason":"phase done","grace_seconds":"120","transport":"markdown-fallback"} --correlation-id worker-3' "$EMIT_LOG" \
  || { cat "$EMIT_LOG" >&2; fail "F: the cleanup telemetry argv changed"; }
# …and the optional flags stay optional: no reason, no grace.
run --stdin 'CLEANUP_REQUEST: worker-4'
want_rc 0 "F bare cleanup-request"
want_sched "schedule worker-4 --source explicit-request" "F: a bare cleanup-request grew flags it never had"

# ── G. extend-lifetime: defer when minutes are given, cancel when they are not ──
run --stdin 'EXTEND_LIFETIME: worker-5 | defer_minutes: 30 | reason: still building'
want_rc 0 "G defer"
want_out "[inject-handler] extend-lifetime target=worker-5 defer=30m transport=markdown-fallback" "G"
want_sched "defer worker-5 --minutes 30 --reason still building" "G: the defer argv changed"
run --stdin 'EXTEND_LIFETIME: worker-6'
want_rc 0 "G cancel"
want_out "[inject-handler] extend-lifetime target=worker-6 cancel-pending transport=markdown-fallback" "G"
want_sched "cancel worker-6" "G: the cancel argv changed"
grep -qxF -e '--helper lifecycle --subtype extend --payload-json {"target":"worker-6","cancel":true,"transport":"markdown-fallback"} --correlation-id worker-6' "$EMIT_LOG" \
  || { cat "$EMIT_LOG" >&2; fail "G: the cancel telemetry argv changed"; }

# ── H. hold is audit-only: one tab-delimited holds.log line, no scheduler ──
: > "$HOLDS"
run --stdin 'HOLD: sid-B | phase: 2 | reason: spec gap | needs: a decision'
want_rc 0 "H hold"
want_out "[inject-handler] hold logged transport=markdown-fallback" "H"
no_sched "H: the hold arm reached Layer D"
grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"$'\t'"\{" "$HOLDS" \
  || { cat "$HOLDS" >&2; fail "H: holds.log is not <utc-iso>TAB<json> — orchestrator sessions read this"; }
python3 - "$HOLDS" <<'PY'
import json, sys
line = open(sys.argv[1], encoding="utf-8").read().rstrip("\n")
stamp, _, blob = line.partition("\t")
rec = json.loads(blob)
assert rec["ok"] is True, rec
assert rec["kind"] == "hold", rec
assert rec["payload"]["reason"] == "spec gap", rec
assert rec["transport"] == "markdown-fallback", rec
PY
[ "$(wc -l < "$HOLDS" | tr -d ' ')" = 1 ] || fail "H: holds.log is not append-one-line-per-hold"

# ── I. test-report: path, bytes, and the --sid override ──
FENCED=$(fenced treport \
  '{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"tester-9","suite":"vitest/계약","totals":{"total":3,"passed":3,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":7}}')
run --body-file "$FENCED"
want_rc 0 "I test-report"
DATE_DIR=$(date -u +%Y-%m-%d)
REPORT_FILE="$TEST_REPORTS_DIR/$DATE_DIR/tester-9.json"
want_out "[inject-handler] test-report written sid=tester-9 path=$REPORT_FILE transport=json-fenced" "I"
[ -f "$REPORT_FILE" ] || fail "I: $REPORT_FILE not written"
python3 - "$REPORT_FILE" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
assert raw.endswith("\n"), "trailing newline dropped (python print added one)"
assert '\n  "suite"' in raw, f"not 2-space indented:\n{raw}"
assert "계약" in raw, "non-ASCII was escaped (python used ensure_ascii=False)"
doc = json.loads(raw)
assert list(doc)[-1] == "_transport", f"_transport is not appended last: {list(doc)}"
assert doc["_transport"] == "json-fenced", doc
assert doc["totals"]["total"] == 3, doc
assert "kind" not in doc, "the whole parse result was written, not just the payload"
PY
# --sid overrides the payload's session_id for the FILENAME.
run --sid override-9 --body-file "$FENCED"
want_rc 0 "I --sid override"
[ -f "$TEST_REPORTS_DIR/$DATE_DIR/override-9.json" ] \
  || fail "I: --sid did not override the payload session_id for the filename"

# ── J. DEVIATION D1 (type) — a non-integer grace_seconds ──
BAD_TYPE=$(fenced badtype \
  '{"schema_version":"1","kind":"cleanup-request","payload":{"target":"victim-1","tier":"immediate","reason":"done","grace_seconds":"soon"}}')
run --body-file "$BAD_TYPE"
if [ "$ORIGINAL" = "1" ]; then
  want_rc 0 "J original"
  want_out "[inject-handler] cleanup-request target=victim-1 transport=json-fenced" "J original"
  want_sched "schedule victim-1 --source explicit-request --reason done --grace-seconds soon" \
    "J original: the bash was supposed to pass the garbage straight through"
  [ -z "$ERRTXT" ] || fail "J original: the bash was supposed to be silent, stderr=<$ERRTXT>"
  no_alert "J original: the bash was supposed to write no alert"
else
  want_rc 1 "J port"
  want_err "grace_seconds" "J port: the stderr line must NAME the rejected field"
  no_sched "J port: a rejected payload still reached Layer D"
  want_alert "INJECT_PAYLOAD_REJECTED field=grace_seconds kind=cleanup-request target=victim-1" "J port"
  [ -z "$OUT" ] || fail "J port: a rejected payload still printed the success line: <$OUT>"
fi

# ── K. DEVIATION D1 (bounds) — in-range integers only ──
bounds_case() { # <label> <fenced-json> <field> <kind> <target> <sched-substring>
  local label="$1" json="$2" field="$3" kind="$4" target="$5" sched="$6"
  run --body-file "$(fenced "bounds-$label" "$json")"
  if [ "$ORIGINAL" = "1" ]; then
    want_rc 0 "K/$label original"
    want_sched "$sched" "K/$label original: the bash passed the out-of-range value through"
  else
    want_rc 1 "K/$label port"
    want_err "$field" "K/$label port: the stderr line must name the field"
    no_sched "K/$label port: an out-of-range value reached Layer D"
    want_alert "INJECT_PAYLOAD_REJECTED field=$field kind=$kind target=$target" "K/$label port"
  fi
}
bounds_case grace-negative \
  '{"schema_version":"1","kind":"cleanup-request","payload":{"target":"victim-2","tier":"immediate","grace_seconds":-100000}}' \
  grace_seconds cleanup-request victim-2 "schedule victim-2 --source explicit-request --grace-seconds -100000"
bounds_case grace-huge \
  '{"schema_version":"1","kind":"cleanup-request","payload":{"target":"victim-3","tier":"immediate","grace_seconds":86401}}' \
  grace_seconds cleanup-request victim-3 "schedule victim-3 --source explicit-request --grace-seconds 86401"
bounds_case defer-negative \
  '{"schema_version":"1","kind":"extend-lifetime","payload":{"target":"victim-4","defer_minutes":-100000}}' \
  defer_minutes extend-lifetime victim-4 "defer victim-4 --minutes -100000"
bounds_case defer-huge \
  '{"schema_version":"1","kind":"extend-lifetime","payload":{"target":"victim-5","defer_minutes":1441}}' \
  defer_minutes extend-lifetime victim-5 "defer victim-5 --minutes 1441"
# …and the edges of the accepted range still go through, in both implementations.
run --body-file "$(fenced bounds-edge \
  '{"schema_version":"1","kind":"cleanup-request","payload":{"target":"ok-1","tier":"immediate","grace_seconds":86400}}')"
want_rc 0 "K edge 86400"
want_sched "schedule ok-1 --source explicit-request --grace-seconds 86400" "K: the upper edge must stay accepted"
run --body-file "$(fenced bounds-zero \
  '{"schema_version":"1","kind":"extend-lifetime","payload":{"target":"ok-2","defer_minutes":0}}')"
want_rc 0 "K edge 0"
# defer_minutes 0 is falsy in bash's `[ -n "$defer" ]` sense only if it were empty; "0" is not.
want_sched "defer ok-2 --minutes 0" "K: defer_minutes 0 must stay a defer, not a cancel"

# ── L. DEVIATION D1 (scheduler rc) — a valid envelope whose scheduler call fails ──
# SCHED_RC reaches the stub through the handler's environment, which is the point:
# the child's non-zero exit is what `>/dev/null 2>&1 || true` used to erase.
run_sched_fail() {
  : > "$SCHED_LOG"; : > "$EMIT_LOG"; : > "$ALERTS"
  local errf="$T_TMP/stderr.txt"
  set +e
  OUT=$(SCHED_RC=1 "$HANDLER" --body-file "$(body schedfail 'CLEANUP_REQUEST: worker-7 | reason: x')" 2>"$errf" </dev/null)
  RC=$?
  set -e
  ERRTXT=$(cat "$errf")
}
run_sched_fail
want_rc 0 "L: a recognized envelope stays exit 0 in BOTH implementations (the --help contract)"
want_sched "schedule worker-7 --source explicit-request --reason x" "L: the scheduler was not called at all"
if [ "$ORIGINAL" = "1" ]; then
  [ -z "$ERRTXT" ] || fail "L original: the bash swallowed the failure, stderr=<$ERRTXT>"
  no_alert "L original: the bash wrote no alert"
else
  want_err "rc=1" "L port: the stderr line must carry the scheduler's exit code"
  want_alert "CLEANUP_SCHEDULE_FAILED verb=schedule target=worker-7 rc=1" "L port"
  want_out "[inject-handler] cleanup-request target=worker-7 transport=markdown-fallback" \
    "L port: the ordinary stdout line is unchanged — the alert is the added signal, not a replacement"
fi

# ── M. DEVIATION D2 — session_id is a path segment, not a path ──
# The canary tree sits OUTSIDE TEST_REPORTS_DIR, one level up, which is exactly where
# `../../../pwned` lands from `$TEST_REPORTS_DIR/<date>/`.
CANARY_DIR="$T_TMP/canary"; mkdir -p "$CANARY_DIR"
printf 'do-not-touch\n' > "$CANARY_DIR/precious.json"
TRAVERSAL=$(fenced traversal \
  '{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"../../canary/precious","suite":"s","totals":{"total":1,"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}')
run --body-file "$TRAVERSAL"
if [ "$ORIGINAL" = "1" ]; then
  want_rc 0 "M original"
  [ "$(cat "$CANARY_DIR/precious.json")" != "do-not-touch" ] \
    || fail "M original: the traversal was supposed to REACH the canary — the reproduction is wrong, not the bash"
else
  want_rc 1 "M port"
  want_err "session_id" "M port: the stderr line must name the rejected field"
  want_alert "INJECT_PAYLOAD_REJECTED field=session_id kind=test-report" "M port"
  [ "$(cat "$CANARY_DIR/precious.json")" = "do-not-touch" ] \
    || fail "M port: an unauthenticated inject overwrote a file outside TEST_REPORTS_DIR"
  [ -z "$OUT" ] || fail "M port: the refusal still printed the success line: <$OUT>"
  # nothing was written anywhere under the reports root either
  [ ! -e "$TEST_REPORTS_DIR/$DATE_DIR/../../canary/precious.json.tmp" ] || fail "M port: a tmpfile leaked"
fi
# The other segment shapes the port must refuse (and the bash never checked). The last
# one is 300 chars: a segment longer than any filesystem's NAME_MAX made `mktemp` fail
# and took the whole handler down with it under `set -e`.
seg_i=0
if [ "$ORIGINAL" != "1" ]; then
  LONG_SID=$(python3 -c 'print("a"*300)')
  for bad in ".." "." "a/b" "" 'a\\b' "$LONG_SID"; do
    seg_i=$((seg_i + 1))
    # Assembled into a variable FIRST, by single-quote concatenation rather than `\"`
    # escapes, so the `$( … )` below contains nothing but "$var". See fenced()'s header
    # for the bash 3.2 failure this shape avoids.
    seg_json='{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"'"$bad"'","suite":"s","totals":{"total":1,"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}'
    seg_body=$(fenced "seg-$seg_i" "$seg_json")
    run --body-file "$seg_body"
    want_rc 1 "M port: session_id <$bad> was accepted as a path segment"
  done
  # …while an ordinary sid still writes, so the refusal is narrow.
  run --body-file "$(fenced seg-ok \
    '{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"ih899-coder.v2","suite":"s","totals":{"total":1,"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}')"
  want_rc 0 "M port: a normal session_id must still write"
  [ -f "$TEST_REPORTS_DIR/$DATE_DIR/ih899-coder.v2.json" ] || fail "M port: the narrow refusal blocked a legitimate sid"
fi

echo "T124 PASS original=$ORIGINAL blocks=A-M handler=$(basename "$HANDLER")"
