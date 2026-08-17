#!/usr/bin/env bash
# T127 (#899 tranche 5) — the duplicate-bridge auditor contract lines no guard pinned.
#
# ONE guard names bin/orchestrator-bridge-auditor.sh today: T57, and it is worth
# keeping exactly as it is. T57 asserts that two bridges produce exactly one HOLD
# inject to the orchestrator mentioning both pids and `kill -9`, that the oldest pid
# is flagged, that one and zero bridges are silent, that `orchestrator-2 ` is not
# `orchestrator`, that ORCHESTRATOR_SID is honoured, that --dry-run sends nothing,
# and — block E, the #606 invariant — that a `kill` recorder stub stays empty.
#
# What T57 does NOT pin, and a port can therefore drop in silence:
#   * the alert line's own bytes (T57 greps for pids and "HOLD", never the line);
#   * the `telepty inject` argv as ARGV — that the HOLD text is ONE element, so a
#     pid list can never become a flag or a word split;
#   * --help AT ALL. It was `sed -n '30,40p' "$0"` — a slice of the script's own
#     comment header — so after the port there is no source to slice and --help
#     would silently print nothing (D2);
#   * every argv error arm: rc 4, the `unknown: <arg>` text, and the fact that argv
#     is consumed to completion BEFORE `ps` runs, so `--dry-run bogus` alerts nothing;
#   * that DRY_RUN IS ARGV-ONLY and an env DRY_RUN=1 is IGNORED (block G — this one
#     is a live hazard, see below);
#   * the `ps` argv itself, and that a lister which fails or is missing is a silent
#     exit 0 rather than an error;
#   * the `etime` parser's arms: the day part, bare seconds, and the tie rule;
#   * the `<defunct>` skip and the `PID ELAPSED COMMAND` header drop;
#   * that a missing/refusing `telepty` still exits 0 after a detected duplicate.
#
# THIS IS A LIVE PATH. src/reconciler/cli.ts:1300-1301 runs it from launchd every 60s
# with no argv and only TELEPTY added to the env, and folds ANY non-zero into one
# `ERR bridge-auditor non-zero (continuing)` line. So a dropped contract line here is
# invisible by construction: the belt for #618 stops working and the tick still logs
# a clean pass. This guard is the characterization test that makes the port's parity
# measurable rather than reviewed.
#
# BLOCK G IS THE HAZARD THE PORT COULD HAVE INTRODUCED, and it is worth naming
# because nothing about it is obvious. bash :54 is a plain `DRY_RUN=0` assignment —
# never an env read — and src/reconciler/cli.ts:45 relies on exactly that ("nothing
# else under bin/ reads DRY_RUN from the environment — bin/orchestrator-bridge-
# auditor.sh:54 sets its own"). The reconciler takes its own DRY_RUN from argv ALONE
# (cli.ts:1154,1166), so `DRY_RUN=1 bin/session-reconciler.sh` with no `--dry-run`
# leaves the reconciler ACTING and puts DRY_RUN=1 into the `{ ...env, TELEPTY }` it
# hands step 0d. A port that read env.DRY_RUN would downgrade every #618 HOLD on that
# host to a log line, forever, and nothing would say so.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $BRIDGE_AUDITOR_UNDER_TEST, defaulting to bin/orchestrator-bridge-auditor.sh. Every
# block below passed against the ORIGINAL bash before the port landed:
#
#   git show c95fb34:bin/orchestrator-bridge-auditor.sh > bin/.bridge-auditor-original.sh
#   chmod +x bin/.bridge-auditor-original.sh
#   BRIDGE_AUDITOR_UNDER_TEST="$PWD/bin/.bridge-auditor-original.sh" \
#     BRIDGE_PARITY_ORIGINAL=1 bash tests/dispatch/T127_bridge_auditor_parity.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with duplicate bridges.
#
# THREE BLOCKS CANNOT PASS AGAINST BOTH IMPLEMENTATIONS, so BRIDGE_PARITY_ORIGINAL=1
# makes each assert the ORIGINAL's behaviour instead of the port's. Nothing is
# skipped in either direction — that is what keeps "the bash did X, the port does Y"
# a measurement rather than a claim:
#
#   J  D1, THE ONE DECLARED FIX. An unwritable $DISPATCH_STATE_DIR used to SUPPRESS
#      the duplicate-bridge HOLD. `emit_alert` was `printf … | tee -a "$ALERTS_LOG"
#      >&2`; its `mkdir -p` was best-effort but the `tee` was not, so under
#      `set -euo pipefail` a tee that cannot open alerts.log failed the pipeline and
#      killed the script at bash :119 — five lines before the inject at :124. The
#      detector had already succeeded; only the alarm was lost, and `runQuiet`
#      discards the stderr that would have explained it. ORIGINAL: rc 1, no inject.
#      PORT: rc 0, the alert on stderr, THE HOLD DELIVERED.
#   I  D4, a NAMED DEVIATION. `awk -v s="$ORCH_SID"` + `$0 ~ ("telepty allow --id "
#      s " ")` made the sid a DYNAMIC REGEX. ORIGINAL: `orch.tor` matches
#      `orchXtor`/`orchYtor` too (count=3, a spurious HOLD naming all three), and
#      `orch[` kills the pass with `awk: nonterminated character class` at rc 2.
#      PORT: literal `includes()`, so `orch.tor` matches only `orch.tor` and `orch[`
#      is just a sid. The deviation only ever matches NARROWER — a real bridge's
#      command line contains its sid literally — so no duplicate can be missed.
#   K2 the static half of the no-kill assertion reads the COMPILED port, so it has
#      nothing to read when the original bash is under test.
#
# BLOCK H IS A REPRODUCED DEFECT (D3), so it is green against both: the marker is
# tested against the whole `command` column, so a process that merely MENTIONS
# `telepty allow --id <sid> ` is counted as a bridge and can be named
# `likely-stale=oldest=` in a HOLD that tells the operator to `kill -9` it. Pinned so
# the port cannot quietly change what counts as a bridge, and so the defect cannot be
# lost before the ticket that decides it. Measured in the wild, not only here: on the
# port host a grep for the marker returned 3 hits where a clean snapshot returned 1,
# the extras being the measuring shell's own argv.
#
# Deliberately NOT pinned: the BYTES of the D1 stderr line in block J's original arm.
# bash printed `tee`'s own `Not a directory`, which is locale-dependent; the exit code
# and the fact of a stderr line are the contract. T122 block J, T116 block B and T120
# set that precedent.
#
# HERMETIC: process lister STUBBED (SINGLETON_PS_CMD → a fixture table); telepty
# STUBBED through an ABSOLUTE $TELEPTY (lib.sh:45 — which is also what keeps the
# shim's hardened /opt/homebrew/bin prefix off the real telepty this host has);
# `kill` recorder on PATH; state under $T_TMP. NO real process is listed for effect
# and NONE is ever signalled. The real daemon is never contacted.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
AUDITOR="${BRIDGE_AUDITOR_UNDER_TEST:-$REPO_ROOT/bin/orchestrator-bridge-auditor.sh}"
ORIGINAL="${BRIDGE_PARITY_ORIGINAL:-0}"

fail() { echo "FAIL[T127]: $*" >&2; exit 1; }

export AUDITOR_NOW="2026-08-18T00:00:00Z"

# --- stub: process lister. Ignores args, records its argv, prints the fixture. ----
PS_TABLE="$T_TMP/ps-table.txt"
PS_ARGV="$T_TMP/ps-argv.txt"
PS_STUB="$STUB_BIN/ps-stub.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$PS_ARGV"
cat "$PS_TABLE"
EOF
# a lister that FAILS, loudly, on stderr
cat > "$STUB_BIN/ps-fail.sh" <<'EOF'
#!/usr/bin/env bash
echo "ps: boom" >&2
exit 3
EOF
# --- stub: kill recorder. Must stay EMPTY (#606) — same shape as T57 block E. -----
KILL_LOG="$T_TMP/kill-calls.log"
cat > "$STUB_BIN/kill" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
# --- stub: telepty that records each argv element on its OWN line, so "one text
# --- argument" is measurable as argv rather than as a substring of a log line.
INJ_ARGV="$T_TMP/inject-argv.txt"
cat > "$STUB_BIN/telepty-argv" <<EOF
#!/usr/bin/env bash
: > "$INJ_ARGV"
for a in "\$@"; do printf '%s\n' "\$a" >> "$INJ_ARGV"; done
echo "stub inject OK"
EOF
chmod +x "$STUB_BIN"/ps-stub.sh "$STUB_BIN"/ps-fail.sh "$STUB_BIN"/kill "$STUB_BIN"/telepty-argv
: > "$KILL_LOG"

export SINGLETON_PS_CMD="$PS_STUB"

B="node telepty allow --id orchestrator claude --dangerously-skip-permissions --continue"

# run <state-subdir> [env=v ...] -- [argv ...] → rc in $RC, stdout/stderr in files
RC=0
run() {
  local sd="$T_TMP/$1"; shift
  local -a envs=() args=()
  while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; args=("$@"); break; fi
    envs+=("$1"); shift
  done
  OUT="$T_TMP/out.txt"; ERR="$T_TMP/err.txt"
  ALERTS="$sd/alerts.log"
  : > "$INJ_ARGV"; : > "$KILL_LOG"
  set +e
  # `${a[@]+"${a[@]}"}` and not `"${a[@]-}"`: on bash 3.2 (macOS CI's /bin/bash) the
  # latter expands an EMPTY array to one empty argument, which `env` then reads as a
  # command name. T118 landed the same fix.
  env DISPATCH_STATE_DIR="$sd" TELEPTY="$STUB_BIN/telepty-argv" \
    ${envs[@]+"${envs[@]}"} "$AUDITOR" ${args[@]+"${args[@]}"} >"$OUT" 2>"$ERR"
  RC=$?
  set -e
}
no_inject() { [ ! -s "$INJ_ARGV" ] || fail "$1 — an inject was sent: $(cat "$INJ_ARGV")"; }
no_kill()   { [ ! -s "$KILL_LOG" ] || fail "$1 — kill was invoked (bridge cleanup is USER-ONLY, #606): $(cat "$KILL_LOG")"; }

# ===========================================================================
# A) two bridges → the alert line and the inject ARGV, byte for byte.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
99999 01:02:03 node some-unrelated-daemon
EOF
run A --
[ "$RC" -eq 0 ] || fail "A: rc=$RC, expected 0: $(cat "$ERR")"
[ ! -s "$OUT" ] || fail "A: wrote to stdout (the alert belongs on stderr): $(cat "$OUT")"
EXPECT_ALERT='2026-08-18T00:00:00Z ORCH_BRIDGE_DUPLICATE count=2 pids=[50349(2-08:11:00), 74838(00:05:23)] likely_stale=50349 dry_run=0'
[ "$(cat "$ERR")" = "$EXPECT_ALERT" ] \
  || fail "A: stderr alert line changed.
  want: $EXPECT_ALERT
  got : $(cat "$ERR")"
[ "$(cat "$ALERTS")" = "$EXPECT_ALERT" ] \
  || fail "A: alerts.log line changed.
  want: $EXPECT_ALERT
  got : $(cat "$ALERTS")"
# the inject as ARGV: exactly 4 elements, the HOLD text being ONE of them
EXPECT_HOLD='HOLD: orchestrator-bridge DUPLICATE | N=2 bridges (expected 1) | pids: 50349(2-08:11:00), 74838(00:05:23) | likely-stale=oldest=50349 | remedy: confirm the live-TUI pid, then `kill -9 <stale-pid>` — USER-ONLY (automation must NOT kill). ref #618'
n_argv=$(wc -l < "$INJ_ARGV" | tr -d ' ')
[ "$n_argv" -eq 4 ] || fail "A: inject argv has $n_argv elements, expected 4 (a split HOLD text lets a pid list become a flag): $(cat "$INJ_ARGV")"
[ "$(sed -n '1p' "$INJ_ARGV")" = "inject" ]       || fail "A: argv[0] != inject: $(sed -n '1p' "$INJ_ARGV")"
[ "$(sed -n '2p' "$INJ_ARGV")" = "--submit" ]     || fail "A: argv[1] != --submit: $(sed -n '2p' "$INJ_ARGV")"
[ "$(sed -n '3p' "$INJ_ARGV")" = "orchestrator" ] || fail "A: argv[2] != orchestrator: $(sed -n '3p' "$INJ_ARGV")"
[ "$(sed -n '4p' "$INJ_ARGV")" = "$EXPECT_HOLD" ] \
  || fail "A: the HOLD wire text changed.
  want: $EXPECT_HOLD
  got : $(sed -n '4p' "$INJ_ARGV")"
no_kill "A"
# the ps argv is the cross-OS column set, unchanged (bash :79)
[ "$(cat "$PS_ARGV")" = "-eo pid,etime,command" ] \
  || fail "A: ps argv changed to '$(cat "$PS_ARGV")' — the BSD/GNU-portable column set is the contract"

# ===========================================================================
# B) --dry-run → BOTH alert lines, no inject. Act-only.
# ===========================================================================
run B -- --dry-run
[ "$RC" -eq 0 ] || fail "B: rc=$RC: $(cat "$ERR")"
EXPECT_DRY_1='2026-08-18T00:00:00Z ORCH_BRIDGE_DUPLICATE count=2 pids=[50349(2-08:11:00), 74838(00:05:23)] likely_stale=50349 dry_run=1'
EXPECT_DRY_2='2026-08-18T00:00:00Z ORCH_BRIDGE_DUPLICATE would-HOLD (dry-run) → orchestrator'
printf '%s\n%s\n' "$EXPECT_DRY_1" "$EXPECT_DRY_2" > "$T_TMP/want-dry.txt"
diff -u "$T_TMP/want-dry.txt" "$ERR" >/dev/null \
  || fail "B: the --dry-run stderr pair changed:
$(diff -u "$T_TMP/want-dry.txt" "$ERR" || true)"
diff -u "$T_TMP/want-dry.txt" "$ALERTS" >/dev/null \
  || fail "B: the --dry-run alerts.log pair changed:
$(diff -u "$T_TMP/want-dry.txt" "$ALERTS" || true)"
no_inject "B"
no_kill "B"
# and a LONE bridge under --dry-run is still completely silent
cat > "$T_TMP/one.txt" <<EOF
50349 00:05:23 $B
99999 01:02:03 node unrelated
EOF
cp "$T_TMP/one.txt" "$PS_TABLE"
run B2 -- --dry-run
[ "$RC" -eq 0 ] || fail "B2: rc=$RC"
[ ! -s "$ERR" ] || fail "B2: a lone bridge under --dry-run wrote to stderr: $(cat "$ERR")"
[ ! -e "$ALERTS" ] || fail "B2: a lone bridge created alerts.log: $(cat "$ALERTS")"

# ===========================================================================
# C) --help — all 498 bytes, in all four positions. Unpinned before this guard,
#    and the ONE contract line that could not survive the port mechanically.
# ===========================================================================
cat > "$T_TMP/want-help.txt" <<'HELPEOF'
# set of bin/orchestrator-boot.sh:48).
#
# Usage:
#   orchestrator-bridge-auditor.sh            # one audit pass (act: HOLD on duplicate)
#   orchestrator-bridge-auditor.sh --dry-run  # detect + log only, never inject
#
# Env:
#   ORCHESTRATOR_SID  orchestrator sid (default: orchestrator) — same source as
#                     bin/orchestrator-boot.sh:36 (Rule 16, no hardcode).
# Test seams (hermetic T57, mirror orchestrator-boot.sh:40-42):
#   SINGLETON_PS_CMD  process lister (default: ps)
HELPEOF
want_bytes=$(wc -c < "$T_TMP/want-help.txt" | tr -d ' ')
[ "$want_bytes" -eq 498 ] || fail "C: the fixture itself is $want_bytes bytes, not 498 — this file was edited"
cp "$PS_TABLE" "$T_TMP/keep.txt"
for helpargs in "-h" "--help" "-h --dry-run" "--dry-run -h"; do
  # shellcheck disable=SC2086
  run "C-$(echo "$helpargs" | tr ' -' '__')" -- $helpargs
  [ "$RC" -eq 0 ] || fail "C: '$helpargs' rc=$RC, expected 0: $(cat "$ERR")"
  diff -u "$T_TMP/want-help.txt" "$OUT" >/dev/null \
    || fail "C: '$helpargs' help text changed:
$(diff -u "$T_TMP/want-help.txt" "$OUT" || true)"
  [ ! -s "$ERR" ] || fail "C: '$helpargs' wrote to stderr: $(cat "$ERR")"
  no_inject "C ($helpargs)"
done

# ===========================================================================
# D) argv error arms: rc 4, the text, and the fact that argv is consumed BEFORE ps.
# ===========================================================================
run D1 -- --bogus
[ "$RC" -eq 4 ] || fail "D1: rc=$RC, expected 4"
[ "$(cat "$ERR")" = "unknown: --bogus" ] || fail "D1: stderr='$(cat "$ERR")', expected 'unknown: --bogus'"
[ ! -s "$OUT" ] || fail "D1: wrote to stdout: $(cat "$OUT")"
[ ! -e "$T_TMP/D1/alerts.log" ] || fail "D1: an argv error wrote alerts.log"
no_inject "D1"
# `--dry-run bogus`: the flag is accepted, THEN the bad arg exits 4 — with TWO
# bridges present and NO alert, because the loop runs to completion before ps.
run D2 -- --dry-run bogus
[ "$RC" -eq 4 ] || fail "D2: rc=$RC, expected 4"
[ "$(cat "$ERR")" = "unknown: bogus" ] || fail "D2: stderr='$(cat "$ERR")'"
[ ! -e "$T_TMP/D2/alerts.log" ] \
  || fail "D2: argv is no longer parsed to completion before detection — an alert was emitted: $(cat "$T_TMP/D2/alerts.log")"
# an EMPTY argv element is 'unknown: ' — with the trailing space
run D3 -- ""
[ "$RC" -eq 4 ] || fail "D3: rc=$RC, expected 4"
[ "$(cat "$ERR" | od -An -c | tr -s ' ')" = "$(printf 'unknown: \n' | od -An -c | tr -s ' ')" ] \
  || fail "D3: stderr bytes changed for an empty argv element: $(od -c < "$ERR")"

# ===========================================================================
# E) count arms: 3 bridges, the <defunct> skip, the ps header drop.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
111 3-00:00:00 $B
222 00:00:10 $B
333 10:00 $B
EOF
run E1 --
[ "$RC" -eq 0 ] || fail "E1: rc=$RC"
[ "$(cat "$ERR")" = '2026-08-18T00:00:00Z ORCH_BRIDGE_DUPLICATE count=3 pids=[111(3-00:00:00), 222(00:00:10), 333(10:00)] likely_stale=111 dry_run=0' ] \
  || fail "E1: three-bridge alert changed: $(cat "$ERR")"
grep -qF 'N=3 bridges (expected 1)' "$INJ_ARGV" || fail "E1: the HOLD does not say N=3: $(cat "$INJ_ARGV")"
# a zombie is not a bridge: 2 lines match, one is <defunct>, so count=1 → silence
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B <defunct>
EOF
run E2 --
[ "$RC" -eq 0 ] || fail "E2: rc=$RC"
[ ! -s "$ERR" ] || fail "E2: a <defunct> line was counted as a live bridge: $(cat "$ERR")"
no_inject "E2"
# the `PID ELAPSED COMMAND` header must not become a bridge
cat > "$PS_TABLE" <<EOF
  PID     ELAPSED COMMAND
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF
run E3 --
[ "$(cat "$ERR")" = "$EXPECT_ALERT" ] || fail "E3: the ps header row changed the count: $(cat "$ERR")"

# ===========================================================================
# F) the etime parser: ties resolve to the FIRST, bare seconds parse, days win.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
111 00:05:00 $B
222 00:05:00 $B
EOF
run F1 --
grep -qF 'likely_stale=111' "$T_TMP/err.txt" || fail "F1: an etime tie no longer flags the FIRST pid: $(cat "$ERR")"
cat > "$PS_TABLE" <<EOF
111 42 $B
222 00:00:01 $B
EOF
run F2 --
grep -qF 'likely_stale=111' "$T_TMP/err.txt" \
  || fail "F2: a bare-seconds etime (42) no longer parses as 42s: $(cat "$ERR")"
cat > "$PS_TABLE" <<EOF
111 00:05:23 $B
222 1-00:00:01 $B
EOF
run F3 --
grep -qF 'likely_stale=222' "$T_TMP/err.txt" \
  || fail "F3: the [DD-] day part is no longer parsed, so the oldest bridge is wrong: $(cat "$ERR")"

# ===========================================================================
# G) DRY_RUN IS ARGV-ONLY. An env DRY_RUN=1 must be IGNORED — see the header.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF
run G DRY_RUN=1 --
[ "$RC" -eq 0 ] || fail "G: rc=$RC"
grep -qF 'dry_run=0' "$T_TMP/err.txt" \
  || fail "G: an env DRY_RUN=1 changed the alert's dry_run field — DRY_RUN became an env seam: $(cat "$ERR")"
[ -s "$INJ_ARGV" ] \
  || fail "G: an env DRY_RUN=1 SUPPRESSED the #618 HOLD. The reconciler passes its whole env to step 0d and takes its own DRY_RUN from argv alone (src/reconciler/cli.ts:1154,1166), so this would silently disable the belt on any host with DRY_RUN exported."

# ===========================================================================
# H) D3 REPRODUCED — a process that merely MENTIONS the marker is a bridge.
#    Green against both implementations, on purpose. See the header.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 00:05:23 $B
77777 00:01:00 grep -n telepty allow --id orchestrator  bin/foo.sh
EOF
run H --
[ "$RC" -eq 0 ] || fail "H: rc=$RC"
grep -qF 'count=2' "$T_TMP/err.txt" \
  || fail "H: the mention-is-a-bridge behaviour changed. That may be an IMPROVEMENT, but it is a detection-policy change across the three sites that share this marker (bin/orchestrator-boot.sh:88, bin/session-reconciler.sh:415, here) — it needs its own ticket, not a port. Alert: $(cat "$ERR")"
grep -qF '77777' "$T_TMP/err.txt" || fail "H: the non-bridge pid is no longer named: $(cat "$ERR")"

# ===========================================================================
# I) D4 — ORCHESTRATOR_SID: a DYNAMIC REGEX in bash, a LITERAL in the port.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
111 00:01:00 node telepty allow --id orchXtor claude
222 00:02:00 node telepty allow --id orchYtor claude
333 00:03:00 node telepty allow --id orch.tor claude
EOF
run I1 ORCHESTRATOR_SID=orch.tor --
if [ "$ORIGINAL" = "1" ]; then
  [ "$RC" -eq 0 ] || fail "I1[original]: rc=$RC"
  grep -qF 'count=3' "$T_TMP/err.txt" \
    || fail "I1[original]: the bash matched the sid as a regex, so 'orch.tor' must count all THREE: $(cat "$ERR")"
else
  [ "$RC" -eq 0 ] || fail "I1[port]: rc=$RC: $(cat "$ERR")"
  [ ! -s "$ERR" ] \
    || fail "I1[port]: 'orch.tor' must match ONLY the literal sid — one bridge, silence. The regex semantics came back: $(cat "$ERR")"
  no_inject "I1[port]"
fi
run I2 ORCHESTRATOR_SID='orch[' --
if [ "$ORIGINAL" = "1" ]; then
  [ "$RC" -eq 2 ] || fail "I2[original]: rc=$RC, expected 2 — an invalid-regex sid killed the awk pass"
  grep -qi 'character class' "$ERR" || fail "I2[original]: expected awk's regex error: $(cat "$ERR")"
else
  [ "$RC" -eq 0 ] \
    || fail "I2[port]: rc=$RC — a sid containing a regex metacharacter must be just a sid, not a crash (and rc 2 now means 'dist not found'): $(cat "$ERR")"
  [ ! -s "$ERR" ] || fail "I2[port]: 'orch[' matched something: $(cat "$ERR")"
fi

# ===========================================================================
# J) D1 — THE DECLARED FIX. An unwritable state dir must not suppress the HOLD.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF
# A regular FILE where the state dir must go, so both the mkdir and the alerts.log
# open fail with ENOTDIR. `run` is bypassed here: it points DISPATCH_STATE_DIR at a
# directory it creates, which is the one thing this block must not have.
BLOCKER="$T_TMP/blocker-file"; : > "$BLOCKER"
: > "$INJ_ARGV"; : > "$KILL_LOG"
set +e
env DISPATCH_STATE_DIR="$BLOCKER/state" TELEPTY="$STUB_BIN/telepty-argv" \
  "$AUDITOR" >"$T_TMP/j.out" 2>"$T_TMP/j.err"
RC=$?
set -e
no_kill "J"
if [ "$ORIGINAL" = "1" ]; then
  [ "$RC" -eq 1 ] \
    || fail "J[original]: rc=$RC, expected 1 — the bash's un-guarded \`tee\` failed the pipeline under pipefail"
  [ -s "$T_TMP/j.err" ] \
    || fail "J[original]: expected a stderr line (tee's own message; its BYTES are locale-dependent and deliberately not pinned)"
  [ ! -s "$INJ_ARGV" ] \
    || fail "J[original]: the bash DID send the HOLD — then D1 was never real: $(cat "$INJ_ARGV")"
else
  [ "$RC" -eq 0 ] \
    || fail "J[port]: rc=$RC, expected 0 — an unwritable state dir must not fail the pass (D1): $(cat "$T_TMP/j.err")"
  [ -s "$INJ_ARGV" ] \
    || fail "J[port]: THE DUPLICATE-BRIDGE HOLD WAS SUPPRESSED by an unwritable state dir. This is D1: the detector succeeded and the alarm was lost, and src/reconciler/cli.ts:1301 discards the stderr that would have said so."
  [ "$(sed -n '4p' "$INJ_ARGV")" = "$EXPECT_HOLD" ] \
    || fail "J[port]: the HOLD text degraded when the log was unwritable: $(sed -n '4p' "$INJ_ARGV")"
  grep -qF 'ORCH_BRIDGE_DUPLICATE count=2' "$T_TMP/j.err" \
    || fail "J[port]: the alert did not reach stderr when alerts.log was unwritable — the operator's only remaining copy: $(cat "$T_TMP/j.err")"
fi

# ===========================================================================
# K) WARN, NEVER KILL (#606) — twice: the recorder, and the compiled artifact.
# ===========================================================================
# K1: every duplicate-detecting arm above ran with a `kill` recorder on PATH and
# no_kill asserted after each. One explicit end-to-end pass for the record:
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF
: > "$KILL_LOG"
run K1 --
[ "$RC" -eq 0 ] || fail "K1: rc=$RC"
[ -s "$INJ_ARGV" ] || fail "K1: no HOLD sent, so the no-kill assertion would be vacuous"
no_kill "K1"
run K1b -- --dry-run
no_kill "K1b (--dry-run)"
# K2: the static half. A recorder only catches a `kill` that RUNS; this catches a
# kill path that exists at all — including one on a branch no fixture reaches.
if [ "$ORIGINAL" != "1" ]; then
  CLI_JS="$REPO_ROOT/dist/src/bridge-auditor/cli.js"
  [ -f "$CLI_JS" ] || fail "K2: $CLI_JS missing — run 'tsc -p .' before this suite (see run-all.sh header)"
  # Scan CODE only. Comment-only lines are dropped first — the file's own header
  # spells out the invariant in prose ("no process.kill, no SIGTERM/SIGKILL"), and a
  # kill primitive cannot hide on a line that starts with `//`. Then the `kill -9`
  # inside the HOLD string a human reads is stripped, and nothing kill-shaped may
  # remain anywhere.
  if grep -vE '^[[:space:]]*(//|/\*|\*)' "$CLI_JS" \
     | sed 's/`kill -9 <stale-pid>`//g; s/must NOT kill//g' \
     | grep -nE 'process\.kill|\.kill\(|SIGKILL|SIGTERM|SIGHUP|"kill"|'"'"'kill'"'"'' ; then
    fail "K2: the compiled auditor contains a kill/signal primitive. Orchestrator bridge cleanup is USER-ONLY (#606): this process is neither the user nor an ancestor of either bridge, so it cannot apply boot.sh's self/ancestor protection and could kill the LIVE bridge."
  fi
fi

# ===========================================================================
# L) child failures are swallowed to exit 0 — the lister and the transport.
# ===========================================================================
# a lister that exits 3 with stderr output: silent exit 0, and ps's stderr is NOT
# forwarded (the tick would fold it into a meaningless ERR line otherwise)
set +e
env DISPATCH_STATE_DIR="$T_TMP/L1" SINGLETON_PS_CMD="$STUB_BIN/ps-fail.sh" \
  TELEPTY="$STUB_BIN/telepty-argv" "$AUDITOR" >"$T_TMP/l1.out" 2>"$T_TMP/l1.err"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "L1: a failing process lister must be a silent no-op, got rc=$RC: $(cat "$T_TMP/l1.err")"
[ ! -s "$T_TMP/l1.err" ] || fail "L1: the lister's stderr leaked through: $(cat "$T_TMP/l1.err")"
[ ! -e "$T_TMP/L1/alerts.log" ] || fail "L1: a failing lister produced an alert"
# a missing lister binary: same
set +e
env DISPATCH_STATE_DIR="$T_TMP/L2" SINGLETON_PS_CMD="$T_TMP/no-such-ps" \
  TELEPTY="$STUB_BIN/telepty-argv" "$AUDITOR" >/dev/null 2>"$T_TMP/l2.err"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "L2: a MISSING process lister must be a silent no-op, got rc=$RC: $(cat "$T_TMP/l2.err")"
# a missing telepty after a REAL duplicate: the alert is written, rc stays 0
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF
set +e
env DISPATCH_STATE_DIR="$T_TMP/L3" SINGLETON_PS_CMD="$PS_STUB" \
  TELEPTY="$T_TMP/no-such-telepty" "$AUDITOR" >/dev/null 2>"$T_TMP/l3.err"
RC=$?
set -e
[ "$RC" -eq 0 ] \
  || fail "L3: a missing telepty must not turn a detected duplicate into a non-zero exit (the tick folds those into one line), got rc=$RC"
grep -qF 'ORCH_BRIDGE_DUPLICATE count=2' "$T_TMP/L3/alerts.log" \
  || fail "L3: the alert was not recorded when the transport was missing: $(cat "$T_TMP/L3/alerts.log" 2>/dev/null)"
no_kill "L3"

echo "T127 PASS blocks=A-L original=$ORIGINAL help_bytes=498 children=ps+telepty kill_paths=0"
