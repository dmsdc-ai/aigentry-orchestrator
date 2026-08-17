#!/usr/bin/env bash
# T118 (#899 tranche 4) — the telepty-bus-bridge.sh CLI contract lines NO guard pinned.
#
# T95 drives this bridge well where it matters most: the filter and the routing, the
# singleton, the drain handoff with the reconciler, and the gated-event case. What it
# does NOT measure is the CLI itself and the byte shapes underneath it — the usage
# text, the argument matrix and its exit codes, the health file's serialization, the
# projection's answer for a field the event does not carry, the spool cap and its
# drop accounting, and — the one that would be silently catastrophic — whether
# `--ensure` is still IDEMPOTENT once the bridge no longer runs as bash.
#
# WHY THE --ensure BLOCK EXISTS (part B), written RED-first before the port was
# fixed. bridge_pid() corroborates the pidfile against `ps -p <pid> -o command=`,
# because a recycled pid is how a stale pidfile convinces every future instance that
# a bridge it cannot see is running. The shell matched the literal
# `telepty-bus-bridge` — its own argv. A ported bridge runs as
# `node …/dist/src/bus-bridge/cli.js --run`, which carries no such literal, so the
# faithful port ANSWERED "no bridge running" FOR A BRIDGE THAT WAS ALIVE. Measured
# against the first cut of src/bus-bridge/cli.ts, this block reported:
#
#   FAIL[T118]: B: --ensure started a SECOND bridge (pid 41234 -> 41251) — the pidfile
#   corroboration no longer recognises the running bridge, so every reconciler tick
#   doubles the writers (#539/#618)
#
# In production src/reconciler/cli.ts:1309 runs `--ensure` on EVERY tick, so that is
# one new bus subscriber and one new spool writer every 60 seconds, forever. The fix
# is two accepted literals, `telepty-bus-bridge` and `bus-bridge/cli.js` — and only
# those two, because a bare `bus-bridge` would corroborate any recycled pid that
# merely carried those characters in its cwd or arguments, which is the exact failure
# the ps cross-check is there to refuse. Part B also pins that narrowness.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $BUS_BRIDGE_SH_UNDER_TEST, defaulting to bin/telepty-bus-bridge.sh. Every block
# below passed against the ORIGINAL bash implementation
# (`git show e2c3a36:bin/telepty-bus-bridge.sh`, copied into bin/ so its SCRIPT_DIR
# resolves lib/telepty-listing.sh the same) before the port landed:
#
#   git show e2c3a36:bin/telepty-bus-bridge.sh > bin/.telepty-bus-bridge-original.sh
#   chmod +x bin/.telepty-bus-bridge-original.sh
#   BUS_BRIDGE_SH_UNDER_TEST="$PWD/bin/.telepty-bus-bridge-original.sh" \
#     bash tests/dispatch/T118_bus_bridge_cli_contract.sh
#
# THE COPY'S FILENAME MUST KEEP THE `telepty-bus-bridge` SUBSTRING, and that is not
# fussiness — it is part B's subject. The original corroborates its pidfile against
# its OWN argv, so a copy named bin/.bus-bridge-original.sh fails part B for the
# rename rather than for anything about the bridge (measured: it does, with exactly
# the message quoted above). Rename it and you are testing the harness.
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with the bridge.
#
# The ONE deliberate deviation, and why it is not asserted here: `$STATE_DIR/
# bus-bridge.fifo` is no longer created (child_process.spawn supplies natively what
# the FIFO gave bash — a pid to end, no orphaned pipeline member, a non-blocking
# open). Nothing outside the script ever referenced that path, so there is no
# contract line to pin; the shim header records the removal.
#
# Hermetic throughout: a temp state dir, a temp HOME so no token resolver reaches the
# real ~/.telepty/config.json, `telepty listen` is an emitter stub, CURL is a
# 200-printing stub for the reachability probe, and no daemon is started — the live
# transport stays T95 part E's job, behind AIGENTRY_RUN_LIVE_TESTS. Nothing here
# touches :3848 or production state.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"

t_setup
BRIDGE_PIDS=""
cleanup() {
  local p
  for p in $BRIDGE_PIDS; do kill "$p" 2>/dev/null || true; done
  t_teardown
}
trap cleanup EXIT

BRIDGE="${BUS_BRIDGE_SH_UNDER_TEST:-$REPO_ROOT/bin/telepty-bus-bridge.sh}"
ORPHANED="$DISPATCH_STATE_DIR/surface-orphaned.jsonl"
MISMATCHED="$DISPATCH_STATE_DIR/surface-mismatched.jsonl"
PIDFILE="$DISPATCH_STATE_DIR/bus-bridge.pid"
HEALTH="$DISPATCH_STATE_DIR/bus-bridge-health.json"

fail() { echo "FAIL[T118]: $*" >&2; exit 1; }

# A temp HOME: lib/telepty-auth.sh builds the token path from $HOME, and a guard may
# not read an operator's real credential file even to ignore the result.
export HOME="$T_TMP/home"
mkdir -p "$HOME"

# wait_for <seconds> <cmd…> — poll at 0.2s until the command succeeds.
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

[ -x "$BRIDGE" ] || fail "no bridge at $BRIDGE"

# The reachability seam: lib/telepty-listing.sh calls "${CURL:-curl}" with
# -w '%{http_code}', so a stub that prints 200 is a reachable daemon. It is an env
# seam, not a PATH one, because the bridge hardens PATH and a PATH stub would be
# shadowed by the real binary.
cat > "$STUB_BIN/curl-200" <<'EOF'
#!/usr/bin/env bash
printf '200'
EOF
chmod +x "$STUB_BIN/curl-200"

# `telepty listen` stand-in. Emits whatever lines are in $STUB_LISTEN_LINES once,
# then holds the connection open like the real one.
cat > "$STUB_BIN/telepty-listen" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "listen" ] && [ ! -f "$STUB_LISTEN_ONCE" ]; then
  : > "$STUB_LISTEN_ONCE"
  [ -f "$STUB_LISTEN_LINES" ] && cat "$STUB_LISTEN_LINES"
fi
sleep 120
EOF
chmod +x "$STUB_BIN/telepty-listen"
export STUB_LISTEN_ONCE="$T_TMP/listen-emitted"
export STUB_LISTEN_LINES="$T_TMP/listen-lines"
: > "$STUB_LISTEN_LINES"

# bridge <args…> — the script under test with every seam pointed at the sandbox.
OUT="$T_TMP/out"; ERR="$T_TMP/err"; RC=0
bridge() {
  set +e
  env TELEPTY="$STUB_BIN/telepty-listen" \
      CURL="$STUB_BIN/curl-200" \
      DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
      BUS_BRIDGE_READ_TIMEOUT=1 \
      "${EXTRA_ENV[@]}" \
      "$BRIDGE" "$@" > "$OUT" 2> "$ERR"
  RC=$?
  set -e
}
EXTRA_ENV=()

# ===========================================================================
# A) the argument matrix — usage text, exit codes, which stream each lands on
# ===========================================================================
USAGE_LINES=(
'#'
'# Usage:'
'#   telepty-bus-bridge.sh --ensure  # start it if it is not running (reconciler tick)'
'#   telepty-bus-bridge.sh --run     # the bridge itself; foreground, long-lived'
'#   telepty-bus-bridge.sh --help'
)

want_usage() {  # want_usage <label>
  local want line
  want=$(printf '%s\n' "${USAGE_LINES[@]}")
  [ "$(cat "$OUT")" = "$want" ] \
    || fail "$1: --help text drifted.
want:
$want
got:
$(cat "$OUT")"
  # every line is a comment line: the shell printed its own header and the port
  # must not have prettified it into prose.
  while IFS= read -r line; do
    case "$line" in '#'*) ;; *) fail "$1: usage line is not the shell's header text: $line";; esac
  done < "$OUT"
}

bridge --help
[ "$RC" = 0 ] || fail "A: --help rc=$RC, want 0 (err=$(cat "$ERR"))"
want_usage "A --help"
[ ! -s "$ERR" ] || fail "A: --help wrote stderr: $(cat "$ERR")"

bridge -h
[ "$RC" = 0 ] || fail "A: -h rc=$RC, want 0"
want_usage "A -h"

# No argument at all is `${1:---help}` — help, exit 0, and NOT the unknown-argument
# arm. A port that read argv[2] as "" instead of defaulting would exit 2 here.
bridge
[ "$RC" = 0 ] || fail "A: no-args rc=$RC, want 0 (err=$(cat "$ERR"))"
want_usage "A no-args"
[ ! -s "$ERR" ] || fail "A: no-args wrote stderr: $(cat "$ERR")"

# Unknown argument: the diagnostic on STDERR, the usage on STDOUT, exit 2.
bridge --bogus
[ "$RC" = 2 ] || fail "A: --bogus rc=$RC, want 2"
grep -qxF -- 'unknown argument: --bogus' "$ERR" \
  || fail "A: --bogus stderr drifted: $(cat "$ERR")"
want_usage "A --bogus"

# Neither help arm may create state — a `--help` that mkdir'd the state dir would
# make every operator's typo a side effect.
[ -e "$PIDFILE" ] && fail "A: an argument-only invocation created $PIDFILE"
[ -e "$HEALTH" ] && fail "A: an argument-only invocation created $HEALTH"

# ===========================================================================
# B) --ensure IS IDEMPOTENT — pinned against the TS argv (see the header)
# ===========================================================================
printf '%s\n' \
  '{"type":"surface_orphaned","sid":"sid-b","backend":"cmux","cmuxWorkspaceId":"WS-B","surfaceGoneSeconds":1,"livenessVerdict":"gone","timestamp":"2026-08-17T00:00:00.000Z"}' \
  > "$STUB_LISTEN_LINES"

bridge --ensure
[ "$RC" = 0 ] || fail "B: --ensure rc=$RC, want 0 (err=$(cat "$ERR"))"
wait_for 15 test -s "$PIDFILE" || fail "B: --ensure never wrote a pidfile"
FIRST_PID="$(cat "$PIDFILE")"
BRIDGE_PIDS="$FIRST_PID"
wait_for 15 test -s "$ORPHANED" \
  || fail "B: the started bridge never wrote an event; health=$(cat "$HEALTH" 2>/dev/null), err=$(cat "$DISPATCH_STATE_DIR/bus-bridge.err" 2>/dev/null)"

# The corroboration must recognise the RUNNING bridge, whatever its argv is now.
ps -p "$FIRST_PID" -o command= > "$T_TMP/argv" 2>/dev/null \
  || fail "B: the bridge pid $FIRST_PID is not alive"

# THE ASSERTION. A second --ensure must find the first and start nothing.
bridge --ensure
[ "$RC" = 0 ] || fail "B: the second --ensure rc=$RC, want 0"
SECOND_PID="$(cat "$PIDFILE")"
[ "$SECOND_PID" = "$FIRST_PID" ] \
  || fail "B: --ensure started a SECOND bridge (pid $FIRST_PID -> $SECOND_PID) — the pidfile corroboration no longer recognises the running bridge, so every reconciler tick doubles the writers (#539/#618).
argv of the first: $(cat "$T_TMP/argv")"
grep -q 'not running — started' "$ERR" \
  && fail "B: the second --ensure announced a start; it must be silent when the bridge is up. stderr:
$(cat "$ERR")"
# Silent means silent: nothing appended to the operator's log either.
[ "$(grep -c 'BUS_BRIDGE not running' "$DISPATCH_STATE_DIR/reconciler.log")" = "1" ] \
  || fail "B: reconciler.log records more than one bridge start:
$(grep 'BUS_BRIDGE' "$DISPATCH_STATE_DIR/reconciler.log")"

# ...and the corroboration is still NARROW. A pid that is alive but is not a bridge
# must not corroborate, or a recycled pid resurrects a dead bridge's pidfile forever.
sleep 60 &
IMPOSTOR=$!
BRIDGE_PIDS="$BRIDGE_PIDS $IMPOSTOR"
SAVED_PID="$FIRST_PID"
kill "$FIRST_PID" 2>/dev/null || true
wait_for 10 bash -c '! kill -0 '"$FIRST_PID"' 2>/dev/null' || fail "B: could not stop the first bridge"
printf '%s\n' "$IMPOSTOR" > "$PIDFILE"
bridge --ensure
[ "$RC" = 0 ] || fail "B: --ensure over an impostor pid rc=$RC, want 0"
# --ensure returns as soon as the detached child is spawned; the child writes the
# pidfile a moment later, so the read has to wait for it rather than race it.
wait_for 15 bash -c '[ "$(cat "'"$PIDFILE"'" 2>/dev/null)" != "'"$IMPOSTOR"'" ]' || true
NEW_PID="$(cat "$PIDFILE")"
[ "$NEW_PID" != "$IMPOSTOR" ] \
  || fail "B: a live NON-bridge pid ($IMPOSTOR, a plain sleep) corroborated the pidfile — the ps cross-check has been widened past what it can distinguish, and a recycled pid now keeps a dead bridge's pidfile alive forever"
BRIDGE_PIDS="$BRIDGE_PIDS $NEW_PID"
[ "$NEW_PID" != "$SAVED_PID" ] || fail "B: --ensure re-used the dead bridge's pid"

# ===========================================================================
# C) the losing --run exits 0 and does not take the pidfile
# ===========================================================================
bridge --run
[ "$RC" = 0 ] || fail "C: a losing second instance must exit 0, not $RC"
grep -q 'already running' "$ERR" \
  || fail "C: the loser did not name the winner; stderr:
$(cat "$ERR")"
[ "$(cat "$PIDFILE")" = "$NEW_PID" ] \
  || fail "C: the loser overwrote the pidfile (duplicate-writer regression, #539/#618)"

# ===========================================================================
# D) bus-bridge-health.json's SERIALIZATION, not just its contents
# ===========================================================================
# python's json.dump(sort_keys=True) defaults: ", " and ": " WITH the space, keys
# sorted, one trailing newline. T95:253 greps `'"state": "connected"'` with that
# space, and any reader of this file that was written against the shell's bytes is
# entitled to the same shape.
wait_for 15 grep -q '"state": "connected"' "$HEALTH" \
  || fail "D: no python-shaped \"state\": \"connected\" in the health file:
$(cat "$HEALTH" 2>/dev/null)"
grep -q '"state":"connected"' "$HEALTH" \
  && fail "D: the health file was re-serialized compact — the separator lost its space, which is a silent break for every grep written against the shell's output:
$(cat "$HEALTH")"
[ "$(tail -c 1 "$HEALTH" | od -An -c | tr -d ' ')" = '\n' ] \
  || fail "D: the health file does not end in exactly one newline"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$HEALTH" \
  || fail "D: the health file is not valid JSON: $(cat "$HEALTH")"
python3 - "$HEALTH" <<'PY' || fail "D: health keys are not sorted (json.dump used sort_keys=True)"
import json, re, sys
raw = open(sys.argv[1], encoding="utf-8").read()
keys = re.findall(r'"([^"]+)": ', raw)
sys.exit(0 if keys == sorted(keys) else 1)
PY
# The counter merge: events_bridged is an increment, not an overwrite.
python3 - "$HEALTH" <<'PY' || fail "D: events_bridged is not a counted integer >= 1"
import json, sys
v = json.load(open(sys.argv[1], encoding="utf-8")).get("events_bridged")
sys.exit(0 if isinstance(v, int) and v >= 1 else 1)
PY

# ===========================================================================
# E) the projection: field ORDER, compaction, and null for an absent key
# ===========================================================================
# jq's `{sid, backend, …}` yields null for a key the event does not carry, and
# `tostring` emits it compact in the order the filter names. A consumer parses this
# line; a port that dropped the absent keys instead would change its key set.
for p in $BRIDGE_PIDS; do kill "$p" 2>/dev/null || true; done
BRIDGE_PIDS=""
rm -f "$PIDFILE" "$ORPHANED" "$MISMATCHED" "$ORPHANED.spool" "$MISMATCHED.spool" "$STUB_LISTEN_ONCE"
printf '%s\n' \
  '👂 Listening to the telepty event bus...' \
  '{"type":"session_activity_observation","sid":"sid-noise","timestamp":"2026-08-17T00:00:00.000Z"}' \
  'not json at all' \
  '{"type":"surface_orphaned","sid":"sid-e","cmuxWorkspaceId":"WS-E","surfaceGoneSeconds":7,"timestamp":"2026-08-17T00:00:00.000Z","extraNoise":"drop-me"}' \
  '{"type":"surface_mismatched","sid":"sid-f","backend":"cmux","cmuxWorkspaceId":"WS-F","expectedPtyPid":11,"observedSurface":"ttys001","mismatchSeconds":9,"timestamp":"2026-08-17T00:00:01.000Z"}' \
  > "$STUB_LISTEN_LINES"

bridge --ensure
[ "$RC" = 0 ] || fail "E: --ensure rc=$RC"
wait_for 15 test -s "$PIDFILE" || fail "E: no pidfile"
BRIDGE_PIDS="$(cat "$PIDFILE")"
wait_for 15 test -s "$ORPHANED" || fail "E: nothing reached $ORPHANED"
wait_for 15 test -s "$MISMATCHED" || fail "E: nothing reached $MISMATCHED"

grep -qxF -- '{"sid":"sid-e","backend":null,"cmuxWorkspaceId":"WS-E","surfaceGoneSeconds":7,"livenessVerdict":null,"timestamp":"2026-08-17T00:00:00.000Z"}' "$ORPHANED" \
  || fail "E: the surface_orphaned projection drifted (order, compaction, or the null for an absent key):
$(cat "$ORPHANED")"
grep -qxF -- '{"sid":"sid-f","backend":"cmux","cmuxWorkspaceId":"WS-F","expectedPtyPid":11,"observedSurface":"ttys001","mismatchSeconds":9,"timestamp":"2026-08-17T00:00:01.000Z"}' "$MISMATCHED" \
  || fail "E: the surface_mismatched projection drifted:
$(cat "$MISMATCHED")"
grep -q 'extraNoise\|sid-noise\|not json at all' "$ORPHANED" "$MISMATCHED" \
  && fail "E: the bridge mirrored input it must filter or project away:
$(cat "$ORPHANED" "$MISMATCHED")"
[ "$(wc -l < "$ORPHANED" | tr -d ' ')" = "1" ] || fail "E: expected exactly 1 orphaned line, got $(cat "$ORPHANED")"

# ===========================================================================
# F) the spool cap counts its drops instead of absorbing them
# ===========================================================================
# With <src> present the rename-install can never fire, so the spool is the only
# place events go — which is precisely the "nothing is draining" state the cap
# exists for. Five events against a cap of two must drop three, count them in
# events_dropped, and say so in the operator's log.
for p in $BRIDGE_PIDS; do kill "$p" 2>/dev/null || true; done
BRIDGE_PIDS=""
rm -f "$PIDFILE" "$HEALTH" "$ORPHANED.spool" "$STUB_LISTEN_ONCE"
: > "$DISPATCH_STATE_DIR/reconciler.log"
printf '%s\n' '{"held":"by the consumer"}' > "$ORPHANED"     # undrained: install_spool must not fire
: > "$STUB_LISTEN_LINES"
for i in 1 2 3 4 5; do
  printf '{"type":"surface_orphaned","sid":"sid-cap-%s","backend":"cmux","cmuxWorkspaceId":"WS-CAP","surfaceGoneSeconds":%s,"livenessVerdict":"gone","timestamp":"2026-08-17T00:00:0%s.000Z"}\n' \
    "$i" "$i" "$i" >> "$STUB_LISTEN_LINES"
done

EXTRA_ENV=(BUS_BRIDGE_SPOOL_MAX=2)
bridge --ensure
EXTRA_ENV=()
[ "$RC" = 0 ] || fail "F: --ensure rc=$RC"
wait_for 15 test -s "$PIDFILE" || fail "F: no pidfile"
BRIDGE_PIDS="$(cat "$PIDFILE")"
wait_for 20 grep -q 'spool cap' "$DISPATCH_STATE_DIR/reconciler.log" \
  || fail "F: the cap never fired; log=$(cat "$DISPATCH_STATE_DIR/reconciler.log"), spool=$(cat "$ORPHANED.spool" 2>/dev/null)"
grep -q 'BUS_BRIDGE spool cap (2) hit for surface-orphaned.jsonl — dropped .* oldest event(s); nothing is draining surface-orphaned.jsonl' \
  "$DISPATCH_STATE_DIR/reconciler.log" \
  || fail "F: the cap line drifted:
$(grep 'spool cap' "$DISPATCH_STATE_DIR/reconciler.log")"
[ "$(wc -l < "$ORPHANED.spool" | tr -d ' ')" = "2" ] \
  || fail "F: the spool was not trimmed to the cap; it has $(wc -l < "$ORPHANED.spool") line(s):
$(cat "$ORPHANED.spool")"
grep -q 'sid-cap-5' "$ORPHANED.spool" \
  || fail "F: the trim kept the wrong end — tail -n keeps the NEWEST events:
$(cat "$ORPHANED.spool")"
grep -q 'sid-cap-1' "$ORPHANED.spool" \
  && fail "F: the oldest event survived a cap trim:
$(cat "$ORPHANED.spool")"
wait_for 10 python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("events_dropped",0)>=3 else 1)' "$HEALTH" \
  || fail "F: events_dropped was not counted (>=3 expected): $(cat "$HEALTH")"
# The undrained file was never touched — the rename-install's absent-path rule holds.
[ "$(cat "$ORPHANED")" = '{"held":"by the consumer"}' ] \
  || fail "F: the bridge wrote over an undrained <src>; the rename-install must only land on an ABSENT path:
$(cat "$ORPHANED")"

echo "T118 PASS"
