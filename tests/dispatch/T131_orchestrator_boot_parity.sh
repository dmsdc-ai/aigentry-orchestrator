#!/usr/bin/env bash
# T131 (#899 tranche 5) — the control-tower boot contract lines no guard pinned.
#
# ONE guard named bin/orchestrator-boot.sh before this one: T40, and it is worth
# keeping exactly as it is. T40 asserts the self/ancestor belt on a fixture, the
# SIGKILL-not-SIGTERM signal, sid configurability, the six reconcile verdicts and that
# --auto-restart precedes the command word.
#
# What T40 does NOT pin, and a port could therefore drop in silence:
#   * THE EXEC ITSELF. T40 never runs it — it reads the argv array and stops. Nothing
#     asserted that the boot ends in a PROCESS REPLACEMENT, which is the whole reason
#     this script exists as a wrapper: the shell the user's terminal launched has to
#     BECOME the bridge (block Q).
#   * the self/ancestor belt against REAL pids. T40's ancestry is a fixture table, so
#     it proves the walk, not that the walk covers whatever process is actually
#     running the boot — the #539 invariant (block N).
#   * every `[orchestrator-boot] …` line's BYTES, and that they all go to stderr
#     (blocks R, W, X).
#   * that the reconcile runs BEFORE the process guard (block O).
#   * the `ps`, `telepty list` and `curl` argv as ARGV (block Y).
#   * that a sid is matched LITERALLY rather than as a regex (block U) and that a
#     MENTION of the marker is not a bridge (block V) — the two SIGKILL defects.
#   * that `jq` is not a precondition for the #905 remediation (block T).
#   * that a sid which cannot survive the shim round trip is refused (block S).
#
# THIS IS THE USER-RUN CONTROL TOWER. It SIGKILLs processes and DELETEs a registry
# record, and the operator runs it by hand at the worst possible moment — when the
# orchestrator is already wedged. A dropped contract line here is not a silent
# regression in a background tick; it is a wrong `kill -9` in front of a human.
#
# NOTHING IN THIS FILE TOUCHES A REAL PROCESS OR A REAL DAEMON. `ps`, `kill`,
# `telepty` and `curl` are recorder stubs throughout; the only real pids that appear
# are READ from `ps -o ppid=` to build block N's ancestry fixture, and the guard's
# verdict on them is asserted to be "skip".
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $ORCH_BOOT_UNDER_TEST, defaulting to bin/orchestrator-boot.sh. Every block below
# passed against the ORIGINAL bash before the port landed:
#
#   git show b300875:bin/orchestrator-boot.sh > bin/.orchestrator-boot-original.sh
#   chmod +x bin/.orchestrator-boot-original.sh
#   ORCH_BOOT_UNDER_TEST="$PWD/bin/.orchestrator-boot-original.sh" \
#     ORCH_BOOT_PARITY_ORIGINAL=1 bash tests/dispatch/T131_orchestrator_boot_parity.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with orchestrator bridges.
#
# The original has no `__probe` — it was SOURCEABLE, which is what T40 used and what
# the port replaced. `guard` and `reconcile` below dispatch on
# ORCH_BOOT_PARITY_ORIGINAL so both implementations are driven through the same seams
# (all of which the original reads from the environment at source time).
#
# FIVE BLOCKS CANNOT PASS AGAINST BOTH IMPLEMENTATIONS, so ORCH_BOOT_PARITY_ORIGINAL=1
# makes each assert the ORIGINAL's behaviour instead of the port's. Nothing is skipped
# in either direction — that is what keeps "the bash did X, the port does Y" a
# measurement rather than a claim:
#
#   S  D1, A NEW REFUSAL. An ORCHESTRATOR_SID containing a control character. The port
#      hands its exec argv back to the shim as newline-delimited text, so a newline in
#      the sid would split one argv element into two and the shell would exec a
#      corrupted command line. ORIGINAL: boots, the sid reaching `telepty allow --id`
#      with its newline intact. PORT: rc 2, one stderr line naming the field, NO exec.
#   T  D2, A NAMED DEVIATION. `jq` is gone. ORIGINAL, with no `jq` on PATH and a
#      listing that is STALE with 0 clients: "registry reconcile SKIPPED — the listing
#      was not JSON (daemon/CLI version mismatch?)" and NO DELETE, so the #905
#      remediation was unavailable on that host and the message blamed the daemon.
#      PORT: the DELETE is issued.
#   U  D3, A FIX. `awk -v s="$ORCH_SID"` + `$0 ~ ("telepty allow --id " s " ")` made
#      the sid a DYNAMIC REGEX. ORIGINAL: `orch.tor` SIGKILLs `orchXtor` and
#      `orch1tor` as well (3 kills), and `orch[` dies with `awk: nonterminated
#      character class` and then reports `killed=0` — a disarmed singleton guard
#      announced as a success. PORT: literal token comparison, 1 kill and 1 kill.
#   V  D4, A FIX (the orchestrator's override). The marker was a SUBSTRING TEST over
#      the whole `pid ppid command` row, so a process that merely MENTIONED
#      `telepty allow --id <sid> ` was SIGKILLed — an operator's own `pgrep -fl
#      telepty` or `grep` while diagnosing a stuck orchestrator is exactly that.
#      ORIGINAL: 2 kills (the real bridge AND the zsh that mentions it). PORT: 1.
#      SCOPE IS THIS KILL PATH: the detect-only sites that share the marker
#      (bin/session-reconciler.sh:415, src/bridge-auditor/cli.ts — T127 block H pins
#      the false positive there) are unchanged and belong to #931.
#   R  the argv channel. The port prints its exec argv on stdout for the shim to exec;
#      the original wrote nothing to stdout at all. Asserted on whichever is running.
#
# Blocks N, O, P, Q, W, X, Y pass against BOTH.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BOOT="${ORCH_BOOT_UNDER_TEST:-$REPO_ROOT/bin/orchestrator-boot.sh}"
ORIGINAL="${ORCH_BOOT_PARITY_ORIGINAL:-0}"

fail() { echo "FAIL[T131]: $*" >&2; exit 1; }

SID="orchestrator"

# ── the two entry points, one per implementation ────────────────────────────
# The original is SOURCEABLE and reads every seam from the environment at source
# time; the port exposes the same two behaviours as `__probe` subcommands. Callers
# export the seams and then call these.
guard() {
  if [ "$ORIGINAL" = "1" ]; then
    bash -c 'set -uo pipefail; . "$1"; orchestrator_singleton_guard' _ "$BOOT"
  else
    "$BOOT" __probe singleton-guard
  fi
}
reconcile() {
  if [ "$ORIGINAL" = "1" ]; then
    bash -c 'set -uo pipefail; . "$1"; orchestrator_registry_reconcile' _ "$BOOT"
  else
    "$BOOT" __probe registry-reconcile
  fi
}

# ── recorders ───────────────────────────────────────────────────────────────
PS_TABLE="$T_TMP/ps-table.txt"
PS_STUB="$STUB_BIN/ps-recorder.sh"
PS_ARGV="$T_TMP/ps-argv.log"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PS_ARGV"
cat "$PS_TABLE"
EOF
chmod +x "$PS_STUB"

KILL_LOG="$T_TMP/kill-calls.log"
KILL_STUB="$STUB_BIN/kill-recorder.sh"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$KILL_STUB"

LIST_JSON="$T_TMP/list.json"
ORDER_LOG="$T_TMP/order.log"
TELEPTY_ARGV="$T_TMP/telepty-argv.log"
TELEPTY_STUB="$STUB_BIN/telepty-recorder.sh"
cat > "$TELEPTY_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TELEPTY_ARGV"
printf 'telepty %s\n' "\$1" >> "$ORDER_LOG"
cat "$LIST_JSON" 2>/dev/null || true
exit 0
EOF
chmod +x "$TELEPTY_STUB"

CURL_LOG="$T_TMP/curl-calls.log"
CURL_CODE="$T_TMP/curl-code.txt"
CURL_STUB="$STUB_BIN/curl-recorder2.sh"
cat > "$CURL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
printf '%s' "\$(cat "$CURL_CODE" 2>/dev/null || echo 200)"
exit 0
EOF
chmod +x "$CURL_STUB"

printf '200' > "$CURL_CODE"

# A daemon listing that holds no record for OUR sid, for the blocks whose subject is the
# guard or the exec rather than the reconcile: the pre-flight then takes its "nothing to
# reconcile" arm and issues no DELETE. A record for an unrelated worker rather than an
# empty array, both because it is the more realistic shape and because tests/dispatch/T69
# §8.7 forbids seeding a bare root array anywhere in this subtree.
no_orch_listing() {
  printf '[{"id":"some-worker","command":"claude","healthStatus":"CONNECTED","active_clients":1}]' \
    > "$LIST_JSON"
}

export SINGLETON_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB"
export TELEPTY="$TELEPTY_STUB" CURL="$CURL_STUB"
export ORCHESTRATOR_SID="$SID"

BRIDGE="node /Users/x/.nvm/versions/node/v20.20.0/bin/telepty allow --id $SID --auto-restart claude --dangerously-skip-permissions --continue"

reset() { : > "$KILL_LOG"; : > "$CURL_LOG"; : > "$ORDER_LOG"; : > "$PS_ARGV"; : > "$TELEPTY_ARGV"; }
# `grep -c .` prints the count and exits 1 when the count is zero, so the status is
# swallowed rather than answered with a second line.
kills() { grep -c . "$KILL_LOG" 2>/dev/null || true; }

# ===========================================================================
# N) THE #539 INVARIANT AGAINST REAL PIDS — never kill self or any ancestor.
#
# T40 proves the ppid walk on a fixture. This proves the walk covers whatever process
# is ACTUALLY running the boot, which is the property #539 is about: the `ps` stub
# below builds its rows from its OWN real ancestry and dresses every pid from its
# GRANDPARENT up as an orchestrator bridge. Whichever implementation is under test,
# the process running it is on that chain. One synthetic non-ancestor bridge (424242)
# is the only pid that may be killed.
#
# The full BOOT path is used, not the probe, so the exec is part of the measurement:
# the wrapper records the pid of the shell that runs the script, that shell execs the
# boot, and the boot must both REFUSE to kill it (by name, in the exact refusal line)
# and end by exec'ing `telepty`.
# ===========================================================================
PS_ANCESTRY_STUB="$STUB_BIN/ps-ancestry.sh"
cat > "$PS_ANCESTRY_STUB" <<EOF
#!/usr/bin/env bash
# Rows for this stub's own real ancestry. hop 0 is the stub, hop 1 its parent; from
# hop 2 up every pid is dressed as an orchestrator bridge and every one of them is a
# genuine ancestor of whatever is running the guard.
pid=\$\$
hop=0
while [ -n "\$pid" ] && [ "\$pid" -gt 1 ] 2>/dev/null; do
  ppid="\$(/bin/ps -o ppid= -p "\$pid" 2>/dev/null | tr -d ' ')"
  [ -z "\$ppid" ] && break
  if [ "\$hop" -ge 2 ]; then
    printf '%s %s node /usr/local/bin/telepty allow --id %s --auto-restart claude\n' "\$pid" "\$ppid" "$SID"
  else
    printf '%s %s bash t131-harness-hop-%s\n' "\$pid" "\$ppid" "\$hop"
  fi
  pid="\$ppid"
  hop=\$((hop + 1))
done
printf '424242 1 node /usr/local/bin/telepty allow --id %s --auto-restart claude\n' "$SID"
EOF
chmod +x "$PS_ANCESTRY_STUB"

# The `telepty` the boot execs: resolved from PATH, exactly as both implementations
# resolve it. It records the argv it was exec'd with AND its own pid, which is how the
# process replacement is measured in block Q.
EXEC_DIR="$T_TMP/exec-path"
mkdir -p "$EXEC_DIR"
EXEC_LOG="$T_TMP/exec.log"
EXEC_PID="$T_TMP/exec-pid.txt"
cat > "$EXEC_DIR/telepty" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$EXEC_LOG"
printf '%s' "\$\$" > "$EXEC_PID"
exit 0
EOF
chmod +x "$EXEC_DIR/telepty"

RUNNER_PID="$T_TMP/runner-pid.txt"
# Record the pid of the shell that runs the boot script, then REPLACE it with the
# script. Both implementations must end up exec'ing telepty in that very pid.
boot_with_exec() {
  bash -c 'printf "%s" "$$" > "$1"; exec bash "$2"' _ "$RUNNER_PID" "$BOOT"
}

reset; : > "$EXEC_LOG"; : > "$EXEC_PID"
no_orch_listing
N_ERR="$T_TMP/n.err"
SINGLETON_PS_CMD="$PS_ANCESTRY_STUB" PATH="$EXEC_DIR:$PATH" boot_with_exec 2>"$N_ERR" >/dev/null \
  || fail "N: the boot exited non-zero: $(cat "$N_ERR")"

runner="$(cat "$RUNNER_PID")"
grep -q "skip self/ancestor bridge pid=$runner ($SID)" "$N_ERR" \
  || fail "N: the process running the boot ($runner) was NOT refused by name — the #539 ancestry belt does not cover it. stderr: $(cat "$N_ERR")"
grep -qw 424242 "$KILL_LOG" \
  || fail "N: the non-ancestor stale bridge 424242 was not killed; kills: $(cat "$KILL_LOG")"
[ "$(kills)" = "1" ] || fail "N: expected exactly 1 kill (424242); kills: $(cat "$KILL_LOG")"
grep -qw "$runner" "$KILL_LOG" \
  && fail "N: THE PROCESS RUNNING THE BOOT WAS KILLED — #539. kills: $(cat "$KILL_LOG")"
[ -s "$EXEC_LOG" ] || fail "N: the boot never reached the exec"

# ===========================================================================
# O) the reconcile runs BEFORE the process guard. #905's fix is a pre-flight: a
#    DELETE issued after the kills would race the bridge this boot is about to
#    become. Both children write to one ordered log.
# ===========================================================================
KILL_ORDER_STUB="$STUB_BIN/kill-order.sh"
cat > "$KILL_ORDER_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
printf 'kill\n' >> "$ORDER_LOG"
exit 0
EOF
chmod +x "$KILL_ORDER_STUB"

reset; : > "$EXEC_LOG"
printf '[{"id":"%s","healthStatus":"CONNECTED","active_clients":1}]' "$SID" > "$LIST_JSON"
cat > "$PS_TABLE" <<EOF
7777 1 $BRIDGE
EOF
KILL_CMD="$KILL_ORDER_STUB" SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" \
  bash "$BOOT" >/dev/null 2>&1
[ "$(head -1 "$ORDER_LOG")" = "telepty list" ] \
  || fail "O: the registry reconcile did not run first; order: $(tr '\n' ' ' < "$ORDER_LOG")"
grep -q '^kill$' "$ORDER_LOG" || fail "O: the singleton guard never ran; order: $(tr '\n' ' ' < "$ORDER_LOG")"

# ===========================================================================
# P) SIGKILL, NEVER SIGTERM — invariant 2. T40 block E inspects the recorder; this
#    inspects the IMPLEMENTATION, so a SIGTERM path cannot be added on a code path
#    no fixture happens to reach. telepty's closeAllowSession runs on the SIGTERM
#    handler and DELETE-cascades a close to every co-bound client, which is how the
#    LIVE orchestrator self-exited on 2026-06-07.
# ===========================================================================
if [ "$ORIGINAL" = "1" ]; then
  P_SRC="$BOOT"
else
  P_SRC="$REPO_ROOT/dist/src/orchestrator-boot/cli.js"
  [ -f "$P_SRC" ] || fail "P: the compiled implementation is missing at $P_SRC (run tsc -p .)"
fi
# Signal LITERALS and node's own signal primitive, not the word in prose — both files
# name SIGTERM in their headers, explaining why it must never be sent.
grep -nE -- '["'"'"']-(TERM|15)["'"'"']|["'"'"']SIGTERM["'"'"']|process\.kill' "$P_SRC" \
  && fail "P: a SIGTERM/-15 signal primitive appears in $P_SRC — the DELETE cascade is exactly what #539 exists to avoid"
grep -qE -- '["'"'"']-9["'"'"']|kill.*-9|-9 ' "$P_SRC" || fail "P: no SIGKILL (-9) found in $P_SRC"

# ===========================================================================
# Q) THE BOOT ENDS IN A REAL PROCESS REPLACEMENT — invariant 3, and the reason this
#    port could not be a plain `exec node …` shim. Node has no execve, so a
#    `telepty allow` started from TypeScript would be a CHILD and the user's terminal
#    would keep a node generation forever. The wrapper records its own pid, execs the
#    boot, and the telepty stub records the pid it ends up running as: they must be
#    the SAME process.
# ===========================================================================
reset; : > "$EXEC_LOG"; : > "$EXEC_PID"
no_orch_listing
: > "$PS_TABLE"
SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" boot_with_exec >/dev/null 2>&1
runner="$(cat "$RUNNER_PID")"
[ -s "$EXEC_PID" ] || fail "Q: telepty was never exec'd"
[ "$(cat "$EXEC_PID")" = "$runner" ] \
  || fail "Q: the boot did NOT replace its own process — the shell that ran it was pid $runner but telepty runs as $(cat "$EXEC_PID"). The user's terminal must BECOME the bridge."
grep -q -- "--id $SID --auto-restart claude --dangerously-skip-permissions --continue" "$EXEC_LOG" \
  || fail "Q: the exec'd argv is not the contract argv: $(cat "$EXEC_LOG")"
grep -q '^allow ' "$EXEC_LOG" || fail "Q: the exec'd subcommand is not 'allow': $(cat "$EXEC_LOG")"

# A `__probe` must never reach the exec (it is a test seam, not a boot).
if [ "$ORIGINAL" != "1" ]; then
  : > "$EXEC_LOG"
  PATH="$EXEC_DIR:$PATH" "$BOOT" __probe exec-argv >/dev/null 2>&1 \
    || fail "Q: __probe exec-argv exited non-zero"
  [ -s "$EXEC_LOG" ] && fail "Q: __probe reached the exec — a test seam booted the orchestrator"

  # #934: BOOTING REQUIRES AN EMPTY ARGV. `__probe` was the only argv that could not
  # reach the exec; now NO argv can. The shim execs node for any non-empty argv, so
  # the command substitution and the `exec` below it are never reached — which is what
  # makes a mode added later unable to regress into a boot. Before #934 every row here
  # ran the full boot and exited 0 (measured on 1088ad7).
  #
  # T134 owns what each mode DOES; this block owns the one property that belongs to
  # the exec: it does not happen.
  : > "$PS_TABLE"; no_orch_listing
  for argv in --help -h --dry-run --bogus-flag "--dry-run --help" anything; do
    : > "$EXEC_LOG"
    set +e
    # Unquoted on purpose: the two-token row must arrive as two arguments.
    # shellcheck disable=SC2086
    SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" bash "$BOOT" $argv >/dev/null 2>&1
    q_rc=$?
    set -e
    [ -s "$EXEC_LOG" ] \
      && fail "Q: 'orchestrator-boot.sh $argv' REACHED THE EXEC — looking at the control tower booted it (#934): $(cat "$EXEC_LOG")"
    # The recorder above only fires when the accidental exec happens to target
    # `telepty`. MEASURED with the gate reverted to its pre-#934 `__probe`-only form:
    # the shim captured the usage text through its command substitution, split it into
    # an array and exec'd its FIRST WORD, exiting 127 — an exec of the wrong thing,
    # invisible to the recorder. 126/127 are the shell's two "tried to exec something
    # unrunnable" codes and neither is a code any mode here may legitimately return.
    case "$q_rc" in
      126 | 127)
        fail "Q: 'orchestrator-boot.sh $argv' exited $q_rc — the shim exec'd something. A no-exec mode's output reached the exec argv channel (#934)."
        ;;
    esac
  done

  # One EMPTY argument is still a non-empty argv, and it is the shape a caller with an
  # unset variable produces (`bin/orchestrator-boot.sh "$FLAG"`). It must refuse, not
  # boot — quoted separately because the loop above word-splits deliberately.
  : > "$EXEC_LOG"
  SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" bash "$BOOT" "" >/dev/null 2>&1 || true
  [ -s "$EXEC_LOG" ] \
    && fail "Q: one empty argument reached the exec — the gate is counting tokens it can see, not argv: $(cat "$EXEC_LOG")"

  # And the other direction, so the gate cannot be satisfied by refusing everything:
  # an EMPTY argv still boots. Block N and the top of this block already exec, but
  # they do it through boot_with_exec; this pins the plain form the operator types.
  : > "$EXEC_LOG"
  SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" bash "$BOOT" >/dev/null 2>&1 || true
  [ -s "$EXEC_LOG" ] \
    || fail "Q: a BARE invocation no longer execs — #934 only adds non-booting modes, it does not change the boot"
fi

# ===========================================================================
# R) THE ARGV CHANNEL. The port prints its exec argv on stdout, one element per line,
#    for the shim to exec — so stdout is a contract channel and a stray byte on it
#    would be exec'd. The original wrote NOTHING to stdout: every line went through
#    log() to stderr.
# ===========================================================================
if [ "$ORIGINAL" = "1" ]; then
  reset; : > "$EXEC_LOG"
  : > "$PS_TABLE"; no_orch_listing
  R_OUT="$T_TMP/r.out"
  SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" bash "$BOOT" >"$R_OUT" 2>/dev/null
  [ -s "$R_OUT" ] && fail "R: the original wrote to stdout: $(cat "$R_OUT")"
else
  reset
  : > "$PS_TABLE"; no_orch_listing
  R_OUT="$T_TMP/r.out"
  SINGLETON_SELF_PID=9999 node "$REPO_ROOT/dist/src/orchestrator-boot/cli.js" >"$R_OUT" 2>/dev/null
  want="$(printf 'telepty\nallow\n--id\n%s\n--auto-restart\nclaude\n--dangerously-skip-permissions\n--continue\n' "$SID")"
  [ "$(cat "$R_OUT")" = "$want" ] \
    || fail "R: stdout is not EXACTLY the exec argv, one element per line. got: $(cat "$R_OUT")"

  # #934: THE CHANNEL STAYS UNAMBIGUOUS IN THE OTHER MODES. `--dry-run` also reports
  # an exec argv, and it also writes to stdout — but every element is PREFIXED, so no
  # line it produces is a bare argv element. If the shim's `$(...)` reader ever saw
  # this output it could not mistake one line of it for the contract channel.
  reset
  : > "$PS_TABLE"; no_orch_listing
  R2_OUT="$T_TMP/r2.out"
  SINGLETON_SELF_PID=9999 "$BOOT" --dry-run >"$R2_OUT" 2>/dev/null
  while IFS= read -r line; do
    case "$line" in
      telepty|allow|--id|"$SID"|--auto-restart|claude|--dangerously-skip-permissions|--continue)
        fail "R: --dry-run put the bare exec-argv element '$line' alone on a stdout line — indistinguishable from the boot path's contract channel"
        ;;
    esac
  done < "$R2_OUT"
  grep -q '^\[would-exec\] telepty$' "$R2_OUT" \
    || fail "R: --dry-run did not report its exec argv prefixed, one element per line: $(cat "$R2_OUT")"

  # --help is not an argv channel at all: nothing it prints may be a bare element.
  R3_OUT="$T_TMP/r3.out"
  "$BOOT" --help >"$R3_OUT" 2>/dev/null
  grep -qx -- 'telepty' "$R3_OUT" \
    && fail "R: --help put a bare 'telepty' alone on a stdout line: $(cat "$R3_OUT")"
fi

# ===========================================================================
# S) D1 — a sid that cannot survive the shim round trip.
# ===========================================================================
CTRL_SID="$(printf 'orch\nboot')"
reset; : > "$EXEC_LOG"
: > "$PS_TABLE"; no_orch_listing
S_ERR="$T_TMP/s.err"
set +e
ORCHESTRATOR_SID="$CTRL_SID" SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" \
  bash "$BOOT" >/dev/null 2>"$S_ERR"
s_rc=$?
set -e
if [ "$ORIGINAL" = "1" ]; then
  [ "$s_rc" = "0" ] \
    || fail "S: the original refused a control-character sid (rc $s_rc) — it never did; stderr: $(cat "$S_ERR")"
  [ -s "$EXEC_LOG" ] \
    || fail "S: the original did not boot with a control-character sid"
else
  [ "$s_rc" = "2" ] \
    || fail "S: a control-character sid must exit 2, got $s_rc; stderr: $(cat "$S_ERR")"
  grep -q 'ORCHESTRATOR_SID contains a control character' "$S_ERR" \
    || fail "S: the refusal does not name the field: $(cat "$S_ERR")"
  [ -s "$EXEC_LOG" ] \
    && fail "S: a control-character sid still reached the exec — the argv round trip is corruptible"
fi

# ===========================================================================
# T) D2 — `jq` is no longer a precondition for the #905 remediation. A PATH built
#    from symlinks to exactly what both implementations need, with `jq` deliberately
#    absent.
# ===========================================================================
NOJQ="$T_TMP/nojq-bin"
mkdir -p "$NOJQ"
for b in bash sh env cat printf sed grep awk head tr dirname pwd node python3 rm mkdir chmod ls; do
  p="$(command -v "$b" 2>/dev/null || true)"
  [ -n "$p" ] && ln -sf "$p" "$NOJQ/$b"
done
command -v jq >/dev/null 2>&1 || fail "T: jq is not installed on this host, so 'jq absent' cannot be measured against 'jq present'"
[ -e "$NOJQ/jq" ] && fail "T: jq leaked into the jq-less PATH"

reset
printf '[{"id":"%s","healthStatus":"STALE","active_clients":0}]' "$SID" > "$LIST_JSON"
T_ERR="$T_TMP/t.err"
if [ "$ORIGINAL" = "1" ]; then
  PATH="$NOJQ" bash -c 'set -uo pipefail; . "$1"; orchestrator_registry_reconcile' _ "$BOOT" 2>"$T_ERR" >/dev/null
  [ -s "$CURL_LOG" ] \
    && fail "T: the original issued a DELETE with no jq on PATH; calls: $(cat "$CURL_LOG")"
  grep -q 'the listing was not JSON' "$T_ERR" \
    || fail "T: the original's jq-less arm changed; stderr: $(cat "$T_ERR")"
else
  PATH="$NOJQ" "$BOOT" __probe registry-reconcile 2>"$T_ERR" >/dev/null
  grep -q -- '-X DELETE' "$CURL_LOG" \
    || fail "T: the port did NOT reconcile without jq — #905 stays unfixable on a jq-less host. stderr: $(cat "$T_ERR")"
fi

# ===========================================================================
# U) D3 — the sid was a DYNAMIC REGEX, and this is a KILL path.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
1111 1 node /usr/local/bin/telepty allow --id orchXtor --auto-restart claude
2222 1 node /usr/local/bin/telepty allow --id orch1tor --auto-restart claude
3333 1 node /usr/local/bin/telepty allow --id orch.tor --auto-restart claude
EOF
reset
ORCHESTRATOR_SID='orch.tor' SINGLETON_SELF_PID=9999 guard >/dev/null 2>&1
if [ "$ORIGINAL" = "1" ]; then
  [ "$(kills)" = "3" ] \
    || fail "U: the original's 'orch.tor' over-match changed (want 3 kills); kills: $(cat "$KILL_LOG")"
else
  [ "$(kills)" = "1" ] \
    || fail "U: a sid metacharacter still over-matches — 'orch.tor' must kill ONLY orch.tor; kills: $(cat "$KILL_LOG")"
  grep -qw 3333 "$KILL_LOG" || fail "U: the real orch.tor bridge (3333) was not killed"
fi

cat > "$PS_TABLE" <<EOF
4444 1 node /usr/local/bin/telepty allow --id orch[ --auto-restart claude
EOF
reset
U2_ERR="$T_TMP/u2.err"
ORCHESTRATOR_SID='orch[' SINGLETON_SELF_PID=9999 guard >/dev/null 2>"$U2_ERR"
if [ "$ORIGINAL" = "1" ]; then
  [ "$(kills)" = "0" ] \
    || fail "U: the original's 'orch[' crash arm changed (want 0 kills); kills: $(cat "$KILL_LOG")"
  grep -q 'killed=0' "$U2_ERR" \
    || fail "U: the original did not report killed=0 for a broken-regex sid; stderr: $(cat "$U2_ERR")"
else
  [ "$(kills)" = "1" ] \
    || fail "U: a sid with a regex metacharacter still disarms the guard — 'orch[' must kill its own stale bridge; kills: $(cat "$KILL_LOG"); stderr: $(cat "$U2_ERR")"
fi

# ===========================================================================
# V) D4 — MENTION IS NOT A BRIDGE. This is the operator's own diagnosis session:
#    (i) a real bridge, (ii) a `zsh -c grep` for the marker, (iii) an ancestor.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
3333 2222 bash $BOOT
2222 1111 node claude
1111 1 $BRIDGE
7777 1 $BRIDGE
8888 1 /bin/zsh -c pgrep -fl telepty allow --id $SID --auto-restart claude
EOF
reset
V_ERR="$T_TMP/v.err"
SINGLETON_SELF_PID=3333 guard >/dev/null 2>"$V_ERR"
grep -qw 1111 "$KILL_LOG" && fail "V: the ancestor bridge 1111 was killed (#539); kills: $(cat "$KILL_LOG")"
grep -qw 7777 "$KILL_LOG" || fail "V: the real stale bridge 7777 was not killed; kills: $(cat "$KILL_LOG")"
if [ "$ORIGINAL" = "1" ]; then
  grep -qw 8888 "$KILL_LOG" \
    || fail "V: the original's mention-is-a-bridge behaviour changed (8888 should have been killed); kills: $(cat "$KILL_LOG")"
  [ "$(kills)" = "2" ] || fail "V: the original should kill exactly 2; kills: $(cat "$KILL_LOG")"
else
  grep -qw 8888 "$KILL_LOG" \
    && fail "V: an operator's own 'pgrep -fl telepty' was SIGKILLed — a MENTION of the marker is not a bridge. kills: $(cat "$KILL_LOG")"
  [ "$(kills)" = "1" ] || fail "V: expected exactly 1 kill (7777); kills: $(cat "$KILL_LOG")"
fi

# ===========================================================================
# W) the five DELETE arms, by their bytes. T40 asserts only that a DELETE happened.
# ===========================================================================
w_arm() { # w_arm <http-code> <expected substring>
  reset
  printf '%s' "$1" > "$CURL_CODE"
  printf '[{"id":"%s","healthStatus":"STALE","active_clients":0}]' "$SID" > "$LIST_JSON"
  local err="$T_TMP/w.err"
  reconcile >/dev/null 2>"$err"
  grep -qF "$2" "$err" \
    || fail "W: http $1 did not produce '$2'; stderr: $(cat "$err")"
}
w_arm 200 "→ 200 (stale record removed; the id is claimable)"
w_arm 404 "→ 404 (already gone — someone or something beat us to it)"
w_arm 401 "→ 401 (daemon refused the credential"
w_arm 403 "→ 403 (daemon refused the credential"
w_arm 000 "→ no answer from the daemon (the STALE record STAYS; nothing was removed)"
w_arm 500 "→ 500 (unexpected; the record may still be there)"
printf '200' > "$CURL_CODE"

# The token is NEVER logged — invariant 4. It reaches the curl header argument and
# nowhere else.
reset
printf '[{"id":"%s","healthStatus":"STALE","active_clients":0}]' "$SID" > "$LIST_JSON"
W_ERR="$T_TMP/w2.err"
reconcile >/dev/null 2>"$W_ERR"
grep -q 'x-telepty-token' "$W_ERR" \
  && fail "W: the credential header appears in the log output: $(cat "$W_ERR")"

# ===========================================================================
# X) the reconcile's non-deleting verdicts, by their bytes. Every UNKNOWN must resolve
#    to "do not delete" (#835) and say why.
# ===========================================================================
x_case() { # x_case <listing json> <expected substring>
  reset
  printf '%s' "$1" > "$LIST_JSON"
  local err="$T_TMP/x.err"
  reconcile >/dev/null 2>"$err" || fail "X: the reconcile returned non-zero for $1 — it must never block the boot"
  grep -qF "$2" "$err" || fail "X: $1 did not produce '$2'; stderr: $(cat "$err")"
  [ -s "$CURL_LOG" ] && fail "X: $1 issued a DELETE; calls: $(cat "$CURL_LOG")"
  return 0
}
x_case '[]' "no record for '$SID' — nothing to reconcile"
x_case '[{"id":"'"$SID"'","healthStatus":"DISCONNECTED","active_clients":0}]' \
  "is DISCONNECTED (clients=0) — left alone; only a STALE record with 0 clients is reconciled"
x_case '[{"id":"'"$SID"'","healthStatus":"STALE"}]' \
  "is STALE but the listing reports no client count — unknown is not zero, leaving it alone"
x_case '[{"id":"'"$SID"'","healthStatus":"STALE","active_clients":2}]' \
  "is STALE but 2 client(s) are attached — leaving it alone"
x_case 'null' "the listing was not JSON (daemon/CLI version mismatch?); continuing to exec"
x_case 'not json at all' "the listing was not JSON (daemon/CLI version mismatch?); continuing to exec"
# jq's `//` falls through on null as well as on absent, and `tostring` renders a null
# count as the STRING "null" — which is an attached-client verdict, not an absent one.
x_case '[{"id":"'"$SID"'","healthStatus":null,"status":"DISCONNECTED","active_clients":0}]' \
  "is DISCONNECTED (clients=0) — left alone"
x_case '[{"id":"'"$SID"'","healthStatus":"STALE","active_clients":null}]' \
  "is STALE but null client(s) are attached — leaving it alone"
# activeClients is the camelCase spelling the listing may use instead.
x_case '[{"id":"'"$SID"'","healthStatus":"STALE","activeClients":5}]' \
  "is STALE but 5 client(s) are attached — leaving it alone"

# A `telepty list --json` that does not answer is announced and the boot proceeds.
reset
FAIL_TELEPTY="$STUB_BIN/telepty-fail.sh"
printf '#!/usr/bin/env bash\nexit 7\n' > "$FAIL_TELEPTY"
chmod +x "$FAIL_TELEPTY"
X_ERR="$T_TMP/x2.err"
TELEPTY="$FAIL_TELEPTY" reconcile >/dev/null 2>"$X_ERR" \
  || fail "X: an unreachable daemon made the reconcile non-zero — that would block the boot it exists to enable"
grep -q "did not answer; continuing to exec (allow will report its own error)" "$X_ERR" \
  || fail "X: the unreachable-daemon line changed: $(cat "$X_ERR")"
[ -s "$CURL_LOG" ] && fail "X: a DELETE was issued despite no answer from the daemon"

# ===========================================================================
# Y) the three children's ARGV, as argv.
# ===========================================================================
reset
cat > "$PS_TABLE" <<EOF
7777 1 $BRIDGE
EOF
SINGLETON_SELF_PID=9999 guard >/dev/null 2>&1
grep -qx -- '-eo pid,ppid,command' "$PS_ARGV" \
  || fail "Y: the ps argv is not '-eo pid,ppid,command' (portable across BSD/macOS and GNU/Linux): $(cat "$PS_ARGV")"
grep -qx -- '-9 7777' "$KILL_LOG" \
  || fail "Y: the kill argv is not '-9 <pid>': $(cat "$KILL_LOG")"

reset
printf '[{"id":"%s","healthStatus":"STALE","active_clients":0}]' "$SID" > "$LIST_JSON"
reconcile >/dev/null 2>&1
grep -qx -- 'list --json' "$TELEPTY_ARGV" \
  || fail "Y: the listing argv is not 'list --json': $(cat "$TELEPTY_ARGV")"
grep -qF -- "-s -o /dev/null -w %{http_code} -H x-telepty-token: " "$CURL_LOG" \
  || fail "Y: the curl argv shape changed: $(cat "$CURL_LOG")"
grep -qF -- "-X DELETE http://127.0.0.1:3848/api/sessions/$SID" "$CURL_LOG" \
  || fail "Y: the DELETE url changed: $(cat "$CURL_LOG")"

# TELEPTY_PORT is a seam (Rule 16, no hardcode).
reset
printf '[{"id":"%s","healthStatus":"STALE","active_clients":0}]' "$SID" > "$LIST_JSON"
TELEPTY_PORT=4999 reconcile >/dev/null 2>&1
grep -qF -- "http://127.0.0.1:4999/api/sessions/$SID" "$CURL_LOG" \
  || fail "Y: TELEPTY_PORT is not honoured: $(cat "$CURL_LOG")"

echo "T131 PASS"
