#!/usr/bin/env bash
# T120 (#899 tranche 4) — the Layer-D scheduler CLI contract lines NO guard pinned.
#
# Six guards name bin/dispatch-cleanup-scheduler.sh and four drive it: T19 pins the
# grace arithmetic and one fire, T20 cancel/defer, T21 the keep_alive skip, T17 the
# 3-layer sequence end to end (T22 reaches it through the reconciler, T76 only asserts
# that a tick rewrites no byte of a corrupt active.json). All six are worth keeping as
# they are, and all six together leave 17 of the 21 measured entrypoint behaviours
# unmeasured: the --help text, the whole refusal matrix, every one of the six
# `[scheduler] …` log lines, the tick arms where the cleanup child fails or is missing,
# the JSON bytes the queue file is written as, and both fail-CLOSED arms of the
# keep_alive read — the ones that decide whether an unreadable registry is treated as
# permission to retire a session.
#
# Each of those is a line a port can drop silently. Cleanup still fires, the queue
# still drains, and the only visible change is an operator's typo answered by a
# different exit code, a log line that a human or a grep no longer recognises, a
# registry outage that starts reading as consent, or a queue file whose bytes no longer
# match what bin/inject-handler.sh's siblings expect to parse. THIS IS A LIVE PATH —
# src/reconciler/cli.ts:1318 runs `tick` every 60s from launchd, and
# bin/inject-handler.sh:119,134,147,153 reach schedule/defer/cancel on the dispatch
# path — so this guard is the characterization test that makes the port's parity
# measurable rather than reviewed.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $SCHEDULER_UNDER_TEST, defaulting to bin/dispatch-cleanup-scheduler.sh. Blocks A-H
# passed against the ORIGINAL bash (`git show e2c3a36:bin/dispatch-cleanup-scheduler.sh`,
# copied into bin/ so its SCRIPT_DIR resolves dispatch-registry.py the same way) before
# the port landed:
#
#   git show e2c3a36:bin/dispatch-cleanup-scheduler.sh > bin/.scheduler-original.sh
#   chmod +x bin/.scheduler-original.sh
#   SCHEDULER_UNDER_TEST="$PWD/bin/.scheduler-original.sh" SCHEDULER_PARITY_ORIGINAL=1 \
#     bash tests/dispatch/T120_scheduler_parity.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with Layer D.
#
# BLOCKS I AND J ARE THE TWO DECLARED DEVIATIONS, so they are the two blocks that
# CANNOT pass against both implementations. SCHEDULER_PARITY_ORIGINAL=1 makes them
# assert the ORIGINAL's behaviour instead of the port's — nothing is skipped in either
# direction, which is what keeps "the bash did X, the port does Y" a measurement rather
# than a claim:
#   I  D1 — a non-numeric `--grace-seconds`/`--minutes` used to TRUNCATE the queue file
#      to zero bytes (`python3 - <<PY | atomic_write_json`: the writer half commits an
#      empty tmpfile when the producer dies, and `pipefail` reports it after the `mv`).
#      That is every pending Layer-D cleanup in the fleet, lost silently, reachable
#      from an unauthenticated inject payload (bin/inject-handler.sh:130-134 passes
#      `payload.grace_seconds` through with `>/dev/null 2>&1 || true`). The port
#      validates the integer BEFORE touching the file: same exit 1, same empty stdout,
#      one stderr line naming the flag, queue byte-identical.
#   J  D2 — `list` had never run on any CPython: a backslash inside an f-string
#      expression in `python3 -c '…'` is a compile-time SyntaxError, so the verb failed
#      even on an empty queue, from b7829ec onward, with zero callers. The port prints
#      the format the code intended. This block exists so it cannot rot back.
#
# The two flag-with-no-value arms (`--grace-seconds` last on argv) are pinned by exit
# code and by the FACT of a stderr line, not by its text: bash printed a
# LOCALE-DEPENDENT `$2: unbound variable` (on this host "$2: 바인딩 해제한 변수"), and
# pinning a localized shell string would fail on a runner whose LANG differs, which
# measures the locale and not the CLI. T116 block B set that precedent.
#
# Hermetic throughout: the temp state dir from lib.sh, a fake session-cleanup recorder
# (T19's idiom), a fake registry for the fail-closed arms, and SCHEDULER_NOW for every
# clock. This script contacts no daemon at all — no telepty, no curl, no jq — so there
# is nothing here that could reach :3848.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

SCHED="${SCHEDULER_UNDER_TEST:-$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh}"
ORIGINAL="${SCHEDULER_PARITY_ORIGINAL:-0}"
PENDING="$DISPATCH_STATE_DIR/cleanup-pending.json"

fail() { echo "FAIL[T120]: $*" >&2; exit 1; }
[ -x "$SCHED" ] || fail "$SCHED is not executable — every caller execs it directly"

# run <args...> — drive the script under test. Sets: OUT RC ERRTXT.
run() {
  local errf="$T_TMP/run.err"
  set +e
  OUT=$("$SCHED" "$@" 2>"$errf"); RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
}
sha() { python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

# The cleanup recorder: one line per invocation, exit code controlled by FAKE_RC.
CLEANUP_LOG="$T_TMP/cleanup-calls.log"
FAKE_CLEANUP="$T_TMP/fake-cleanup.sh"
cat > "$FAKE_CLEANUP" <<EOF
#!/usr/bin/env bash
echo "cleanup \$*" >> "$CLEANUP_LOG"
exit \${FAKE_RC:-0}
EOF
chmod +x "$FAKE_CLEANUP"
export SESSION_CLEANUP_SH="$FAKE_CLEANUP"
: > "$CLEANUP_LOG"

# --- A) --help is the old header, all 37 lines of it -------------------------------
# The shell answered --help with `sed -n '2,38p' "$0"`. The header ends at line 35, so
# lines 37-38 — `set -euo pipefail` and the PATH export — came along. Nobody chose to
# document them; sed included them, so they are part of the output every operator who
# ran --help has seen, and a port that tidied them away would be changing the contract
# while calling it a cleanup.
for flag in --help -h; do
  run "$flag"
  [ "$RC" -eq 0 ] || fail "A: $flag exited $RC, want 0"
  n=$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')
  [ "$n" -eq 37 ] || fail "A: $flag printed $n lines, want 37 (sed -n '2,38p')"
  [ -z "$ERRTXT" ] || fail "A: $flag wrote to stderr: $ERRTXT"
done
printf '%s\n' "$OUT" | head -1 \
  | grep -qxF '# dispatch-cleanup-scheduler.sh — Layer D timeout fallback (ADR 2026-05-20).' \
  || fail "A: --help first line changed: '$(printf '%s\n' "$OUT" | head -1)'"
printf '%s\n' "$OUT" | tail -1 \
  | grep -qxF 'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"' \
  || fail "A: --help last line changed: '$(printf '%s\n' "$OUT" | tail -1)'"
# Five contract lines from the middle: the record schema an operator reads, the two
# defaults nothing else states, the atomicity claim, and the exit-code line.
for want in \
  '#     "source": "layer-d-timeout" | "reconciler" | "explicit-request",' \
  '#       Append a pending record. Default grace 60s. Default source layer-d-timeout.' \
  '#       Idempotent on sid: replaces existing pending record for the same sid.' \
  '# Atomic writes via tmpfile+mv (avoids partial state on crash — pattern #114).' \
  '# Exit codes: 0 OK, 4 usage.'
do
  printf '%s\n' "$OUT" | grep -qxF "$want" || fail "A: --help lost the line: $want"
done

# --- B) the refusal matrix, message for message ------------------------------------
# refuse <label> <rc> <stderr-first-line> [args…] — a refusal must emit no ref and no
# record; `-` for the stderr line means "something was said, wording not pinned".
refuse() {
  local label="$1" want_rc="$2" want_err="$3"; shift 3
  run "$@"
  [ "$RC" -eq "$want_rc" ] || fail "B/$label: rc=$RC want $want_rc (err: $ERRTXT)"
  if [ "$want_err" = "-" ]; then
    [ -n "$ERRTXT" ] || fail "B/$label: said nothing on stderr"
  else
    printf '%s\n' "$ERRTXT" | head -1 | grep -qxF "$want_err" \
      || fail "B/$label: stderr first line '$(printf '%s\n' "$ERRTXT" | head -1)' want '$want_err'"
  fi
}
refuse no-sid-schedule   4 'schedule: <sid> required'   schedule
refuse empty-sid         4 'schedule: <sid> required'   schedule ''
refuse unknown-flag      4 'schedule: unknown --bogus'  schedule sid-X --bogus v
refuse no-sid-cancel     4 'cancel: <sid> required'     cancel
refuse no-sid-defer      4 'defer: <sid> required'      defer
refuse no-minutes        4 'defer: --minutes required'  defer sid-X
refuse empty-minutes     4 'defer: --minutes required'  defer sid-X --minutes ''
refuse unknown-defer     4 'defer: unknown --bogus'     defer sid-X --bogus v
# A flag with no value: exit 1 (NOT 4) and a diagnostic. See this file's header.
refuse grace-no-value    1 '-'  schedule sid-X --grace-seconds
refuse minutes-no-value  1 '-'  defer sid-X --minutes
# No args and an unknown verb both print the 37-line usage to STDOUT and exit 4 — the
# `unknown:` line is the only thing on stderr.
run
[ "$RC" -eq 4 ] || fail "B: no args exited $RC, want 4"
[ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" -eq 37 ] || fail "B: no args did not print the 37-line usage"
run bogus-verb
[ "$RC" -eq 4 ] || fail "B: an unknown verb exited $RC, want 4"
printf '%s\n' "$ERRTXT" | grep -qxF 'unknown: bogus-verb' || fail "B: unknown verb stderr: '$ERRTXT'"
[ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" -eq 37 ] || fail "B: an unknown verb did not print the usage"
# Every refusal above must have left the queue empty.
[ "$(python3 -c "import json;print(len(json.load(open('$PENDING'))))")" = 0 ] \
  || fail "B: a refusal wrote a record: $(cat "$PENDING")"

# --- C) both fail-CLOSED arms of the keep_alive read ------------------------------
# telepty#60 Stage A (docs/designs/2026-07-30-…:274): a registry this script cannot
# read must be treated as keep_alive, i.e. as "do NOT schedule cleanup". T21 pins the
# keep_alive=true answer; these are the two failure arms, and they are the ones that
# decide whether a registry outage reads as permission to retire a session.
export SCHEDULER_NOW="2026-05-23T12:00:00Z"
REG_STUB="$T_TMP/registry-stub.py"
cat > "$REG_STUB" <<'EOF'
#!/usr/bin/env bash
exit ${REG_RC:-0}
EOF
chmod +x "$REG_STUB"
KA_LINE='— skipping Layer D schedule'
# c1) not executable at all
run_ka() {
  local label="$1"; shift
  run schedule "$1" --grace-seconds 60
  [ "$RC" -eq 0 ] || fail "C/$label: rc=$RC want 0 (err: $ERRTXT)"
  printf '%s\n' "$OUT" | grep -qF "[scheduler] keep_alive=true for $1 $KA_LINE" \
    || fail "C/$label: expected the keep_alive skip log, got: $OUT"
  python3 -c "import json,sys;p=json.load(open('$PENDING'));sys.exit(0 if not any(r.get('sid')=='$1' for r in p) else 1)" \
    || fail "C/$label: a record was written for a session that must not be cleaned up"
}
DISPATCH_REGISTRY_PY=/nonexistent/dispatch-registry.py run_ka not-executable sid-NX
DISPATCH_REGISTRY_PY="$REG_STUB" REG_RC=3 run_ka registry-nonzero sid-RC3
# c3) the control: a registry that answers successfully and NOT "true" lets it land.
DISPATCH_REGISTRY_PY="$REG_STUB" REG_RC=0 run schedule sid-OK --grace-seconds 60
[ "$RC" -eq 0 ] || fail "C: the control schedule exited $RC (err: $ERRTXT)"
python3 -c "import json,sys;p=json.load(open('$PENDING'));sys.exit(0 if any(r.get('sid')=='sid-OK' for r in p) else 1)" \
  || fail "C: a readable registry answering not-true did NOT let the schedule land — the gate is stuck closed"
run cancel sid-OK

# --- D) the six log lines, and the queue BYTES ------------------------------------
# The log lines are what an operator greps and what ~/.aigentry logs are parseable as;
# the bytes are what every other reader of cleanup-pending.json parses. Both are
# contract, and nothing else in the repo would notice either changing.
: > "$PENDING"   # an unreadable queue reads as empty, as all five heredocs did
run schedule sid-1 --grace-seconds 60 --source layer-d-timeout --reason test-report
[ "$RC" -eq 0 ] || fail "D: schedule exited $RC (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qxF '[scheduler] scheduled cleanup sid=sid-1 in 60s (source=layer-d-timeout)' \
  || fail "D: the schedule log line changed: '$OUT'"
run schedule sid-2 --grace-seconds 30
run defer sid-2 --minutes 5 --reason more-work
printf '%s\n' "$OUT" | grep -qxF '[scheduler] deferred cleanup for sid-2 by 5m' \
  || fail "D: the defer log line changed: '$OUT'"
run cancel sid-absent
printf '%s\n' "$OUT" | grep -qxF '[scheduler] cancelled pending cleanup for sid-absent' \
  || fail "D: cancelling an absent sid must still log (and exit 0): rc=$RC out='$OUT'"
[ "$RC" -eq 0 ] || fail "D: cancelling an absent sid exited $RC, want 0"
run defer sid-3 --minutes 7
printf '%s\n' "$OUT" | grep -qxF '[scheduler] deferred cleanup for sid-3 by 7m' || fail "D: defer-creates log changed"
# `--grace-seconds 060` logs 060s: the log carries the RAW argument, python did the int.
run schedule sid-4 --grace-seconds 060
printf '%s\n' "$OUT" | grep -qxF '[scheduler] scheduled cleanup sid=sid-4 in 060s (source=layer-d-timeout)' \
  || fail "D: the log line reformatted the raw --grace-seconds value: '$OUT'"
# Now the bytes, in full: 2-space indent, insertion order, key order per record,
# preempt_reason present only when a reason was given, one trailing newline.
WANT_BYTES="$T_TMP/want-pending.json"
cat > "$WANT_BYTES" <<'EOF'
[
  {
    "sid": "sid-1",
    "report_time": "2026-05-23T12:00:00Z",
    "scheduled_cleanup_time": "2026-05-23T12:01:00Z",
    "source": "layer-d-timeout",
    "preempt_reason": "test-report"
  },
  {
    "sid": "sid-2",
    "report_time": "2026-05-23T12:00:00Z",
    "scheduled_cleanup_time": "2026-05-23T12:05:00Z",
    "source": "explicit-request",
    "preempt_reason": "more-work"
  },
  {
    "sid": "sid-3",
    "report_time": "2026-05-23T12:00:00Z",
    "scheduled_cleanup_time": "2026-05-23T12:07:00Z",
    "source": "explicit-request"
  },
  {
    "sid": "sid-4",
    "report_time": "2026-05-23T12:00:00Z",
    "scheduled_cleanup_time": "2026-05-23T12:01:00Z",
    "source": "layer-d-timeout"
  }
]
EOF
diff -u "$WANT_BYTES" "$PENDING" \
  || fail "D: the queue file's BYTES changed (left = the shell's json.dumps(indent=2) output)"
# defer on an EXISTING record mutates it in place: `report_time` and any field the
# record already carried survive, and the sid keeps its position in the array.
python3 - "$PENDING" <<'PY' || exit 1
import json, sys
p = json.load(open(sys.argv[1]))
r = next(x for x in p if x["sid"] == "sid-2")
assert [x["sid"] for x in p] == ["sid-1", "sid-2", "sid-3", "sid-4"], p
assert r["report_time"] == "2026-05-23T12:00:00Z", r     # NOT rewritten to defer's now
assert r["source"] == "explicit-request", r
PY

# --- E) tick: the four arms, and what happens to the record in each ----------------
# The record is dropped when the cleanup child FAILS as well as when it succeeds — the
# scheduler is a fallback, and a retry loop here would be a second policy engine.
: > "$CLEANUP_LOG"
export SCHEDULER_NOW="2026-05-23T12:00:30Z"
run tick
printf '%s\n' "$OUT" | grep -qxF '[scheduler] tick fired=0' || fail "E: pre-deadline tick line: '$OUT'"
[ ! -s "$CLEANUP_LOG" ] || fail "E: tick fired before any deadline: $(cat "$CLEANUP_LOG")"
export SCHEDULER_NOW="2026-05-23T12:07:00Z"
FAKE_RC=0 run tick
[ "$RC" -eq 0 ] || fail "E: tick exited $RC (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qxF '[scheduler] tick fired=4' || fail "E: tick line: '$OUT'"
# Fired in the queue's array order, one argv each, and the queue is drained.
[ "$(cat "$CLEANUP_LOG")" = "cleanup sid-1
cleanup sid-2
cleanup sid-3
cleanup sid-4" ] || fail "E: cleanup child argv/order changed:
$(cat "$CLEANUP_LOG")"
[ "$(python3 -c "import json;print(len(json.load(open('$PENDING'))))")" = 0 ] \
  || fail "E: the queue was not drained: $(cat "$PENDING")"
# A cleanup that exits non-zero: announced on STDOUT, counted as fired, record gone.
: > "$CLEANUP_LOG"
export SCHEDULER_NOW="2026-05-23T13:00:00Z"
run schedule sid-F1 --grace-seconds 0
FAKE_RC=9 run tick
[ "$RC" -eq 0 ] || fail "E: a failing cleanup made the tick itself exit $RC, want 0"
printf '%s\n' "$OUT" | grep -qxF '[scheduler] cleanup non-zero for sid-F1' \
  || fail "E: a failing cleanup was not announced: '$OUT'"
printf '%s\n' "$OUT" | grep -qxF '[scheduler] tick fired=1' || fail "E: a failing cleanup was not counted"
[ "$(python3 -c "import json;print(len(json.load(open('$PENDING'))))")" = 0 ] \
  || fail "E: a failing cleanup left the record pending — the fallback would retry forever"
# The child missing entirely: STDERR, still counted, record still dropped.
run schedule sid-F2 --grace-seconds 0
SESSION_CLEANUP_SH="$T_TMP/does-not-exist" run tick
[ "$RC" -eq 0 ] || fail "E: a missing cleanup child made the tick exit $RC, want 0"
printf '%s\n' "$ERRTXT" | grep -qF "[scheduler] session-cleanup.sh not executable at $T_TMP/does-not-exist" \
  || fail "E: the missing-child diagnostic changed (and it must be on stderr): '$ERRTXT'"
printf '%s\n' "$OUT" | grep -qxF '[scheduler] tick fired=1' || fail "E: a missing child was not counted as fired"
# An unparseable scheduled_cleanup_time is SKIPPED and the record KEPT (python's
# `except Exception: continue`) — a record that cannot be judged is never fired.
printf '%s\n' '[{"sid":"sid-BAD","report_time":"x","scheduled_cleanup_time":"not-a-time","source":"s"}]' > "$PENDING"
: > "$CLEANUP_LOG"
run tick
[ "$RC" -eq 0 ] || fail "E: an unparseable stamp made the tick exit $RC, want 0"
printf '%s\n' "$OUT" | grep -qxF '[scheduler] tick fired=0' || fail "E: an unparseable stamp fired: '$OUT'"
[ ! -s "$CLEANUP_LOG" ] || fail "E: cleanup ran for a record whose deadline could not be read"
python3 -c "import json,sys;p=json.load(open('$PENDING'));sys.exit(0 if [r['sid'] for r in p]==['sid-BAD'] else 1)" \
  || fail "E: the unjudgeable record was dropped instead of kept: $(cat "$PENDING")"

# --- F) idempotence on sid, and the load-time side effects -------------------------
export SCHEDULER_NOW="2026-05-23T14:00:00Z"
printf '[]\n' > "$PENDING"
run schedule sid-I --grace-seconds 60
run schedule sid-I --grace-seconds 90 --source reconciler
python3 - "$PENDING" <<'PY' || fail "F: schedule is not idempotent on sid"
import json, sys
p = json.load(open(sys.argv[1]))
assert [r["sid"] for r in p] == ["sid-I"], p
assert p[0]["scheduled_cleanup_time"] == "2026-05-23T14:01:30Z", p
assert p[0]["source"] == "reconciler", p
PY
# `mkdir -p "$STATE_DIR"` and the `[]` seed run BEFORE argv is looked at, so --help and
# a refusal both materialize them. Anything that reads the queue file's existence as
# "Layer D has been used" depends on this.
FRESH="$T_TMP/fresh-state"
DISPATCH_STATE_DIR="$FRESH" run --help
[ -f "$FRESH/cleanup-pending.json" ] || fail "F: --help no longer creates the state dir and the empty queue"
[ "$(cat "$FRESH/cleanup-pending.json")" = "[]" ] || fail "F: the seeded queue is not '[]' + newline: $(cat "$FRESH/cleanup-pending.json")"

# --- G) an unreadable queue reads as EMPTY, and is replaced -----------------------
# All five heredocs were `try: json.load(...) / except Exception: pending = []`. That is
# fail-OPEN for this file (unlike active.json, where T76 forbids it) and it is
# deliberate: the queue is a fallback timer, not a ledger. Pinned so the port's read
# path is measured rather than assumed.
printf '%s' '{"not":"an array"' > "$PENDING"
export SCHEDULER_NOW="2026-05-23T15:00:00Z"
run schedule sid-R --grace-seconds 60
[ "$RC" -eq 0 ] || fail "G: a malformed queue made schedule exit $RC, want 0 (err: $ERRTXT)"
python3 -c "import json,sys;p=json.load(open('$PENDING'));sys.exit(0 if [r['sid'] for r in p]==['sid-R'] else 1)" \
  || fail "G: a malformed queue was not replaced by the one new record: $(cat "$PENDING")"

# --- H) SCHEDULER_NOW is used VERBATIM -------------------------------------------
# `now_iso()` returns the override with no parse-and-reformat, so `report_time` is the
# operator's exact bytes. T19/T20 assert arithmetic derived from it; nothing asserted
# the verbatim part, and a port that normalised it would silently change every
# `report_time` in the file.
printf '[]\n' > "$PENDING"
SCHEDULER_NOW="2026-05-23T16:00:00Z" run schedule sid-V --grace-seconds 1
python3 -c "import json,sys;p=json.load(open('$PENDING'));sys.exit(0 if p[0]['report_time']=='2026-05-23T16:00:00Z' and p[0]['scheduled_cleanup_time']=='2026-05-23T16:00:01Z' else 1)" \
  || fail "H: SCHEDULER_NOW was not used verbatim: $(cat "$PENDING")"

# --- I) D1 — a non-numeric grace/minutes must not cost the queue ------------------
# RED-first: this block fails against the pre-port bash by design (see the header).
SEED='[
  {
    "sid": "keep-me",
    "report_time": "2026-05-23T12:00:00Z",
    "scheduled_cleanup_time": "2026-05-23T23:00:00Z",
    "source": "layer-d-timeout"
  }
]'
d1_case() {
  local label="$1" flag="$2"; shift 2
  printf '%s\n' "$SEED" > "$PENDING"
  local before; before=$(sha "$PENDING")
  run "$@"
  [ "$RC" -eq 1 ] || fail "I/$label: rc=$RC want 1"
  [ -z "$OUT" ] || fail "I/$label: wrote '$OUT' to stdout — a refusal must say nothing there"
  [ -n "$ERRTXT" ] || fail "I/$label: said nothing on stderr"
  local after; after=$(sha "$PENDING")
  if [ "$ORIGINAL" = "1" ]; then
    # The defect, measured: the queue is truncated to zero bytes.
    [ "$before" != "$after" ] || fail "I/$label: SCHEDULER_PARITY_ORIGINAL=1 but the queue survived — this is not the pre-port bash"
    [ ! -s "$PENDING" ] || fail "I/$label: the original wiped the file to 0 bytes; got $(wc -c < "$PENDING") bytes"
  else
    [ "$before" = "$after" ] \
      || fail "I/$label: the queue file changed (sha $before → $after). A bad '$flag' must never cost the fleet its pending cleanups.
--- file now ---
$(cat "$PENDING")"
    printf '%s\n' "$ERRTXT" | grep -qF -- "$flag" \
      || fail "I/$label: the stderr line does not name $flag, so an operator cannot act on it: '$ERRTXT'"
  fi
}
d1_case grace   --grace-seconds  schedule sid-D1 --grace-seconds soon
d1_case minutes --minutes        defer keep-me --minutes abc
# Valid JSON that is not an array was NOT inside that `try` — it raised an
# AttributeError in the comprehension and took the file with it. Same invariant.
printf '%s\n' '{"sid":"x"}' > "$PENDING"
before=$(sha "$PENDING")
run schedule sid-D1b --grace-seconds 5
[ "$RC" -eq 1 ] || fail "I: a non-array queue exited $RC, want 1"
if [ "$ORIGINAL" = "1" ]; then
  [ ! -s "$PENDING" ] || fail "I: the original wiped a non-array queue; got $(wc -c < "$PENDING") bytes"
else
  [ "$before" = "$(sha "$PENDING")" ] || fail "I: a non-array queue was overwritten instead of refused: $(cat "$PENDING")"
fi

# --- J) D2 — `list` prints, in the format its f-string was written to produce -----
# RED-first: against the pre-port bash this verb is a compile-time SyntaxError.
printf '%s\n' "$SEED" > "$PENDING"
export SCHEDULER_NOW="2026-05-23T12:00:00Z"
run defer keep-me --minutes 1 --reason more-work
run schedule sid-L2 --grace-seconds 60
run list
if [ "$ORIGINAL" = "1" ]; then
  [ "$RC" -eq 1 ] || fail "J: SCHEDULER_PARITY_ORIGINAL=1 but list exited $RC — this is not the pre-port bash"
  printf '%s\n' "$ERRTXT" | grep -qF 'SyntaxError' \
    || fail "J: the original's list failed for a different reason than the f-string SyntaxError: '$ERRTXT'"
else
  [ "$RC" -eq 0 ] || fail "J: list exited $RC, want 0 (err: $ERRTXT)"
  [ -z "$ERRTXT" ] || fail "J: list wrote to stderr: $ERRTXT"
  [ "$(printf '%s\n' "$OUT" | wc -l | tr -d ' ')" -eq 2 ] || fail "J: list printed $(printf '%s\n' "$OUT" | wc -l) lines, want one per record:
$OUT"
  # `{sid:40s}` is a left-justified pad to 40 columns, no truncation; `reason=` is
  # appended only for a record that carries preempt_reason.
  printf '%s\n' "$OUT" | grep -qxF 'keep-me                                  scheduled=2026-05-23T12:01:00Z src=explicit-request reason=more-work' \
    || fail "J: the list line for a record WITH a reason changed:
$OUT"
  printf '%s\n' "$OUT" | grep -qxF 'sid-L2                                   scheduled=2026-05-23T12:01:00Z src=layer-d-timeout' \
    || fail "J: the list line for a record without a reason changed:
$OUT"
  # A record missing the optional keys prints `?` for each, and an over-long sid is
  # padded by nothing rather than cut.
  LONG='sid-that-is-considerably-longer-than-forty-columns'
  printf '%s\n' "[{\"sid\":\"$LONG\"}]" > "$PENDING"
  run list
  [ "$RC" -eq 0 ] || fail "J: list exited $RC on a sparse record"
  printf '%s\n' "$OUT" | grep -qxF "$LONG scheduled=? src=?" \
    || fail "J: a sparse/over-long record is not rendered as the f-string would: '$OUT'"
fi

echo "T120 PASS help=37-lines refusals=12 fail-closed=2 bytes=pinned tick=4-arms d1=queue-survives d2=list-works"
