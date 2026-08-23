#!/usr/bin/env bash
# T136 — #932: a refused session_id must stay VISIBLE, not merely refused.
#
# #932 moved the single-safe-path-segment rule up into src/session/inject-parser.ts so
# every consumer inherits it. That move has a failure mode of its own, and it is the
# reason this guard exists: the parser runs BEFORE inject-handler's per-kind arms, so
# a traversal is now rejected before armTestReport's own requireSafeSegment ever sees
# it. Done naively, the refusal survives and its OBSERVABILITY does not — the operator
# gets `parse failed: unknown envelope kind` and alerts.log gets nothing at all.
# Measured, before the fix that this guard now pins:
#   FAIL[T124]: M port: the stderr line must name the rejected field:
#   stderr=<inject-handler: parse failed: unknown envelope kind> want substring <session_id>
#
# T124 block M already measures the refusal end to end (canary file, exit code, stderr).
# This guard measures the AUDIT TRAIL specifically, because that is the half that can
# be removed without any test going red once block M's other assertions are satisfied:
# an attack that is blocked but not logged is an attack nobody knows happened. It is a
# separate file rather than another block in T124 so that the property is named by the
# guard's own filename — a reviewer deleting the routing in cli.ts has to walk past it.
#
# Both transports are asserted. The markdown path BUILDS a TestReport directly and
# never went through validateTestReport, so it is a second door to the same filename.
#
# Hermetic: the three children (scheduler, registry, telemetry) are recorder stubs and
# the state dir is under $T_TMP. No daemon is contacted — :3848 is never dialled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

HANDLER="${INJECT_HANDLER_UNDER_TEST:-$REPO_ROOT/bin/inject-handler.sh}"
fail() { echo "FAIL[T136]: $*" >&2; exit 1; }
[ -x "$HANDLER" ] || fail "$HANDLER is not executable — every caller execs it directly"

export TEST_REPORTS_DIR="$T_TMP/test-reports"
ALERTS="$DISPATCH_STATE_DIR/alerts.log"

# Recorders: a refusal must call NONE of them, which is the other half of "no side
# effect escaped before the boundary said no".
SCHED_LOG="$T_TMP/scheduler.log"; SCHED_STUB="$T_TMP/scheduler-stub.sh"
REG_LOG="$T_TMP/registry.log";    REG_STUB="$T_TMP/registry-stub.sh"
EMIT_LOG="$T_TMP/telemetry.log";  EMIT_STUB="$T_TMP/emit-stub.sh"
for pair in "$SCHED_STUB:$SCHED_LOG" "$REG_STUB:$REG_LOG" "$EMIT_STUB:$EMIT_LOG"; do
  stub=${pair%%:*}; log=${pair##*:}
  cat > "$stub" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$log"
exit 0
EOF
  chmod +x "$stub"
done
export SCHEDULER_SH="$SCHED_STUB" DISPATCH_REGISTRY_PY="$REG_STUB" EMIT_TELEMETRY_MJS="$EMIT_STUB"

OUT=""; RC=0; ERRTXT=""
run_body() {
  : > "$SCHED_LOG"; : > "$REG_LOG"; : > "$EMIT_LOG"; : > "$ALERTS"
  local errf="$T_TMP/stderr.txt"
  set +e
  OUT=$("$HANDLER" --body-file "$1" 2>"$errf" </dev/null)
  RC=$?
  set -e
  ERRTXT=$(cat "$errf")
}

# The alerts convention is `<utc-iso> <line>`; the timestamp anchor is what stops a
# stray substring elsewhere in the file from satisfying this.
want_alert() {
  grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z $1" "$ALERTS" \
    || { echo "--- alerts.log was ---" >&2; cat "$ALERTS" 2>/dev/null >&2; fail "$2"; }
}

# Assembled into a variable first, then referenced as a bare "$var" inside `$( … )`.
# T124's fenced() header records the bash 3.2 parse that makes this a runner
# constraint rather than a style preference.
fenced() {
  local f="$T_TMP/body-$1.txt"
  { printf '%s\n' '```json aigentry-envelope/v1'; printf '%s\n' "$2"; printf '%s\n' '```'; } > "$f"
  printf '%s' "$f"
}
plain() { local f="$T_TMP/body-$1.txt"; printf '%s\n' "$2" > "$f"; printf '%s' "$f"; }

assert_refusal_is_logged() {
  local label="$1" bodyfile="$2" bad="$3"
  run_body "$bodyfile"
  [ "$RC" = "1" ] || fail "$label: rc=$RC (want 1) out=<$OUT> err=<$ERRTXT>"
  # THE POINT OF THIS GUARD: the greppable audit line, with the field NAMED.
  want_alert "INJECT_PAYLOAD_REJECTED field=session_id kind=test-report" \
    "$label: the refusal left no INJECT_PAYLOAD_REJECTED line naming session_id. The rejection still happened, so nothing else goes red — but an attack that is blocked and not logged is one nobody can see. The parser rejects before inject-handler's per-kind arms now (#932), so a field-shaped rejection must be routed back into rejectField()"
  # …and the line must carry WHAT was attempted, JSON-quoted so an embedded newline
  # cannot forge a second alerts.log entry.
  grep -qF "$(printf '%s' "$bad" | sed 's/"/\\"/g')" "$ALERTS" \
    || { cat "$ALERTS" >&2; fail "$label: the alert does not record the offending value, so the log says an attack happened but not what it tried"; }
  # The operator-facing half, which T124 block M also holds.
  case "$ERRTXT" in *session_id*) ;; *) fail "$label: stderr does not name the field: <$ERRTXT>";; esac
  # A boundary refusal happens BEFORE any child runs.
  [ ! -s "$SCHED_LOG" ] || { cat "$SCHED_LOG" >&2; fail "$label: the scheduler was called on a refused envelope"; }
  [ ! -s "$EMIT_LOG" ]  || { cat "$EMIT_LOG"  >&2; fail "$label: telemetry was emitted for a refused envelope"; }
  [ -z "$OUT" ] || fail "$label: the refusal still printed a success line: <$OUT>"
}

# ── (A) the fenced transport ──
BAD='../../canary/precious'
A_JSON='{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"'"$BAD"'","suite":"s","totals":{"total":1,"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}'
assert_refusal_is_logged "A fenced" "$(fenced trav "$A_JSON")" "$BAD"

# ── (B) the markdown transport — the second door to the same filename ──
B_LINE="TEST_REPORT: $BAD | suite=s | total=1 | passed=1 | failed=0 | skipped=0 | duration_ms=1"
assert_refusal_is_logged "B markdown" "$(plain travmd "$B_LINE")" "$BAD"

# ── (C) `.` and `..` are rejected BY NAME, and logged the same way ──
# They are built only from characters the segment class allows, so a filter that is a
# character class alone passes them through intact and never reaches this log line.
for bad in "." ".."; do
  C_JSON='{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"'"$bad"'","suite":"s","totals":{"total":1,"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}'
  run_body "$(fenced "dot-${#bad}" "$C_JSON")"
  [ "$RC" = "1" ] || fail "C: session_id <$bad> was accepted (rc=$RC)"
  want_alert "INJECT_PAYLOAD_REJECTED field=session_id kind=test-report" \
    "C: <$bad> was refused without an audit line — it passes a character-class filter intact, so it is exactly the form a weakened rule would let through silently"
done

# ── (D) the refusal stays NARROW: a legitimate sid still writes, and logs no alert ──
D_JSON='{"schema_version":"1","kind":"test-report","payload":{"schema_version":"1","session_id":"ih899-coder.v2","suite":"s","totals":{"total":1,"passed":1,"failed":0,"skipped":0},"finished_at":"2026-05-23T13:50:00Z","duration_ms":1}}'
run_body "$(fenced ok "$D_JSON")"
[ "$RC" = "0" ] || fail "D: a normal session_id was refused (rc=$RC) err=<$ERRTXT>"
grep -q "INJECT_PAYLOAD_REJECTED" "$ALERTS" 2>/dev/null \
  && { cat "$ALERTS" >&2; fail "D: a legitimate sid produced a rejection alert — the rule is over-broad and the log is now crying wolf"; }
[ -f "$TEST_REPORTS_DIR/$(date -u +%Y-%m-%d)/ih899-coder.v2.json" ] \
  || fail "D: the narrow refusal blocked a legitimate sid from being written"

echo "T136 PASS"
