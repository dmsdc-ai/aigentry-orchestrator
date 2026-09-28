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
#   * the self/ancestor belt starting at the boot's default self pid, through a
#     synthetic ancestry table — the #539 invariant (block N).
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
# are the recorder's parent and the private runner pid used in block N's synthetic
# ancestry table; no host process table is read and all signals go to recorders.
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
# the port replaced. `guard` and `reconcile` below use normal compiled boot for
# actuation (probes are read-only now) and dispatch on
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
#
# ── #1181 v2: THE OLD ORACLE IS MIGRATED, DELIBERATELY, AND NOT WEAKENED ────────────
#
# WHAT CHANGED IN THE PRODUCT. Until this revision a bare, TERMINAL-LESS invocation with
# `ORCHESTRATOR_CLI=claude` booted `claude --dangerously-skip-permissions --continue`, and
# with `ORCHESTRATOR_CLI=codex` it booted
# `codex resume --last --dangerously-bypass-approvals-and-sandbox`. A variable that names
# neither a permission mode nor a history mode selected BOTH, on the process that becomes
# the control tower. That door is gone. There are now exactly two ways to boot:
#
#   empty argv + a terminal on fd 0 AND fd 2      the wizard; a typed YES or nothing
#   empty argv, no terminal                        AIGENTRY_BOOT_PLAN=1 + a COMPLETE,
#                                                  VALIDATED plan, or exit 2
#
# WHAT THAT MEANS FOR THIS GUARD. Every block below whose SUBJECT is the guard, the
# reconcile, the exec or the argv channel used a bare non-TTY boot as its VEHICLE. That
# vehicle now refuses. The blocks are NOT relaxed and NOT skipped: each is given a
# COMPLETE, BENIGN, EXPLICIT PLAN through `plan_env` below — claude, approval=manual (the
# most restrictive value claude 2.1.283's help prints), history=new, no elevated value and
# therefore no acknowledgement — and then makes EXACTLY THE SAME SECURITY ASSERTION it
# always made. The pids killed, the pids refused, the DELETE arms, the ordering, the child
# argv and the SIGKILL-only rule are all unchanged. Only the provider tail of the exec argv
# differs, because the risky tail is no longer producible at all.
#
#   old vehicle:  ORCHESTRATOR_CLI=claude, bare, no terminal
#   new vehicle:  AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=claude ORCHESTRATOR_SID=<sid>
#                 AIGENTRY_BOOT_PERMISSION=approval=manual AIGENTRY_BOOT_HISTORY=new
#   old tail:     claude --dangerously-skip-permissions --continue
#   new tail:     claude --permission-mode manual
#
# A BENIGN PLAN IS THE POINT. Using an elevated plan here would have kept the old argv and
# made the migration invisible; it would also mean this guard's own fixture authorised a
# permission bypass, which is the exact thing #1181 removed. `approval=manual` is chosen
# because it needs NO `AIGENTRY_BOOT_RISK_ACK`, so nothing in this file ever types an
# acknowledgement for a bypass.
#
# BLOCK AA IS NEW AND IS THE OTHER HALF. Migrating an oracle that pinned a risky default
# is only honest if something then pins that the default is GONE. AA drives the old door
# from both sides — `ORCHESTRATOR_CLI` alone, for all four providers, and the two literal
# tails — and asserts a refusal with an EMPTY stdout and zero effects.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BOOT_SOURCE="${ORCH_BOOT_UNDER_TEST:-$REPO_ROOT/bin/orchestrator-boot.sh}"
ORIGINAL="${ORCH_BOOT_PARITY_ORIGINAL:-0}"
# Execute a private copy of the unchanged shim and compiled boot, with a synthetic
# auth resolver. No normal boot invocation can enter the repository's live layout.
BOOT_FIXTURE="$T_TMP/boot-fixture"
mkdir -p "$BOOT_FIXTURE/bin/lib" "$BOOT_FIXTURE/dist/src/orchestrator-boot" "$BOOT_FIXTURE/home"
cp "$BOOT_SOURCE" "$BOOT_FIXTURE/bin/orchestrator-boot.sh"
cp "$REPO_ROOT/bin/lib/node-shim.sh" "$BOOT_FIXTURE/bin/lib/node-shim.sh"
# H1 — THE FIXTURE MUST CARRY THE WHOLE MODULE. This copied `cli.js` + `usage.js` only.
# Since #1181 the compiled cli.js imports ./plan.js and ./wizard.js, and plan.js imports
# ./provider-capabilities.js, so a two-file fixture dies at import time with
# ERR_MODULE_NOT_FOUND before a single assertion runs — a guard that cannot fail for the
# right reason. The staged set is now the whole compiled module, and the loop below FAILS
# LOUDLY on a missing file rather than letting `cp` half-populate the fixture.
BOOT_MODULE_FILES="cli.js usage.js plan.js wizard.js provider-capabilities.js"
for _f in $BOOT_MODULE_FILES; do
  [ -f "$REPO_ROOT/dist/src/orchestrator-boot/$_f" ] \
    || { echo "FAIL[T131]: the compiled module is incomplete — $_f is missing from $REPO_ROOT/dist/src/orchestrator-boot (run tsc -p .)" >&2; exit 1; }
  cp "$REPO_ROOT/dist/src/orchestrator-boot/$_f" "$BOOT_FIXTURE/dist/src/orchestrator-boot/"
done
# #1162: cli.js imports ./boot-record.js, which imports two boot-adapter modules. Same loud rule.
for _f in orchestrator-boot/boot-record.js session/boot-adapter/launch-config.js session/boot-adapter/types.js; do
  [ -f "$REPO_ROOT/dist/src/$_f" ] \
    || { echo "FAIL[T131]: the compiled module is incomplete — $_f is missing from $REPO_ROOT/dist/src (run tsc -p .)" >&2; exit 1; }
  mkdir -p "$BOOT_FIXTURE/dist/src/$(dirname "$_f")"
  cp "$REPO_ROOT/dist/src/$_f" "$BOOT_FIXTURE/dist/src/$_f"
done
printf '{"type":"module"}\n' > "$BOOT_FIXTURE/package.json"
AUTH_LOG="$T_TMP/auth.log"
printf 'telepty_auth_token() { printf "auth\\n" >> "%s"; printf "fixture-token-T131"; }\n' "$AUTH_LOG" \
  > "$BOOT_FIXTURE/bin/lib/telepty-auth.sh"
BOOT="$BOOT_FIXTURE/bin/orchestrator-boot.sh"
BOOT_CLI="$BOOT_FIXTURE/dist/src/orchestrator-boot/cli.js"
chmod +x "$BOOT"
export AIGENTRY_SHIM_SCRIPT_DIR="$BOOT_FIXTURE/bin" AIGENTRY_HOME="$BOOT_FIXTURE/home"
export ORCHESTRATOR_CLI=claude SINGLETON_SELF_PID=9999 TELEPTY_PORT=3848
unset _NODE_SHIM_SH_SOURCED
cd "$BOOT_FIXTURE"

fail() { echo "FAIL[T131]: $*" >&2; exit 1; }

SID="orchestrator"

# ── the complete, benign, explicit plan every non-TTY block below boots with ─────────
# See the #1181 note in the header. This is the MINIMUM complete plan for claude: the
# provider, the sid, the one axis claude 2.1.283 has at its most restrictive printed
# value, and an explicit `new` conversation. It selects nothing elevated, so
# AIGENTRY_BOOT_RISK_ACK is deliberately NOT set anywhere in this file — if the product
# ever started accepting this plan as elevated, or started requiring an ack for it, these
# blocks would fail rather than quietly acquire one.
#
# The ORIGINAL bash knows none of these variables and ignores them, so exporting them
# leaves the ORCH_BOOT_PARITY_ORIGINAL=1 side byte-identical to what it was.
export AIGENTRY_BOOT_PLAN=1
export AIGENTRY_BOOT_PERMISSION='approval=manual'
export AIGENTRY_BOOT_HISTORY=new
# The provider tail the plan above produces, as the argv elements it is. Every block that
# used to spell `claude --dangerously-skip-permissions --continue` spells this instead.
PLAN_TAIL_ARGV=(claude --permission-mode manual)
PLAN_TAIL="claude --permission-mode manual"

# ── the two entry points, one per implementation ────────────────────────────
# The original is SOURCEABLE and reads every seam from the environment at source
# time; the port's normal zero-argv CLI actuates and prints argv without exec. Callers
# export the seams and then call these.
guard() {
  if [ "$ORIGINAL" = "1" ]; then
    bash -c 'set -uo pipefail; . "$1"; orchestrator_singleton_guard' _ "$BOOT"
  else
    node "$BOOT_CLI"
  fi
}
reconcile() {
  if [ "$ORIGINAL" = "1" ]; then
    bash -c 'set -uo pipefail; . "$1"; orchestrator_registry_reconcile' _ "$BOOT"
  else
    node "$BOOT_CLI"
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

# The ps-table row that represents a LIVE bridge. Its tail is the plan tail now, for the
# same reason the expectations moved: this is what a bridge booted by this product looks
# like. The singleton guard matches on `[node] telepty allow … --id <sid>` and never on
# the tail, so the change cannot affect a single kill decision — asserted by U and V,
# which still kill exactly what they always killed.
BRIDGE="node /Users/x/.nvm/versions/node/v20.20.0/bin/telepty allow --id $SID --auto-restart $PLAN_TAIL"

reset() { : > "$KILL_LOG"; : > "$CURL_LOG"; : > "$ORDER_LOG"; : > "$PS_ARGV"; : > "$TELEPTY_ARGV"; }
# `grep -c .` prints the count and exits 1 when the count is zero, so the status is
# swallowed rather than answered with a second line.
kills() { grep -c . "$KILL_LOG" 2>/dev/null || true; }

# ===========================================================================
# N) THE #539 INVARIANT FROM THE DEFAULT SELF PID — never kill self or any ancestor.
#
# T40 proves the ppid walk on a fixture. This proves the walk covers whatever process
# is running the boot: the ps recorder uses its parent (Node on the port) and the
# private runner pid as the start of a synthetic chain ending at bridge 1111.
# No host ps is called. One synthetic non-ancestor bridge (424242) may be killed.
#
# The full BOOT path is used, not the probe, so the exec is part of the measurement:
# the wrapper records the pid of the shell that runs the script, that shell execs the
# boot, and the boot must both REFUSE to kill it (by name, in the exact refusal line)
# and end by exec'ing `telepty`.
# ===========================================================================
PS_ANCESTRY_STUB="$STUB_BIN/ps-ancestry.sh"
cat > "$PS_ANCESTRY_STUB" <<EOF
#!/usr/bin/env bash
# PPID is supplied by this private child shell; no process lister is invoked.
runner="\$(cat "$T_TMP/runner-pid.txt")"
if [ "\$PPID" != "\$runner" ]; then
  printf '%s %s node boot-fixture\n' "\$PPID" "\$runner"
fi
printf '%s 1111 node /usr/local/bin/telepty allow --id %s --auto-restart claude\n' "\$runner" "$SID"
printf '1111 1 node /usr/local/bin/telepty allow --id %s --auto-restart claude\n' "$SID"
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
(unset SINGLETON_SELF_PID; SINGLETON_PS_CMD="$PS_ANCESTRY_STUB" PATH="$EXEC_DIR:$PATH" boot_with_exec) 2>"$N_ERR" >/dev/null \
  || fail "N: the boot exited non-zero: $(cat "$N_ERR")"

runner="$(cat "$RUNNER_PID")"
grep -q "skip self/ancestor bridge pid=$runner ($SID)" "$N_ERR" \
  || fail "N: the process running the boot ($runner) was NOT refused by name — the #539 ancestry belt does not cover it. stderr: $(cat "$N_ERR")"
grep -qw 424242 "$KILL_LOG" \
  || fail "N: the non-ancestor stale bridge 424242 was not killed; kills: $(cat "$KILL_LOG")"
[ "$(kills)" = "1" ] || fail "N: expected exactly 1 kill (424242); kills: $(cat "$KILL_LOG")"
grep -qw "$runner" "$KILL_LOG" \
  && fail "N: THE PROCESS RUNNING THE BOOT WAS KILLED — #539. kills: $(cat "$KILL_LOG")"
grep -q 'skip self/ancestor bridge pid=1111' "$N_ERR" || fail "N: synthetic ancestor was not skipped"
[ -s "$EXEC_LOG" ] || fail "N: the boot never reached the exec"
# #1162: exactly one fixed-vocabulary boot-record line. The fixture ROOT has no sessions/,
# so the display-only writer must skip without creating anything.
if [ "$ORIGINAL" != "1" ]; then
  [ "$(grep -c '^\[orchestrator-boot\] boot record: ' "$N_ERR")" = "1" ] \
    || fail "N: expected exactly one boot-record line; stderr: $(cat "$N_ERR")"
  grep -qx '\[orchestrator-boot\] boot record: skipped:unsafe-path relation=none' "$N_ERR" \
    || fail "N: boot-record line is not the fixed skipped:unsafe-path record; stderr: $(cat "$N_ERR")"
  [ ! -e "$BOOT_FIXTURE/home/sessions" ] || fail "N: the boot record created sessions/ under the fixture ROOT"
fi

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
grep -q -- "--id $SID --auto-restart $PLAN_TAIL" "$EXEC_LOG" \
  || fail "Q: the exec'd argv is not the contract argv: $(cat "$EXEC_LOG")"
# The FIXED HEAD is still fixed data, whatever the plan chose. This is the half of the
# argv the singleton guard's match token and telepty's own lifecycle depend on, and #1181
# moved only the tail.
grep -q -- "^allow --id $SID --auto-restart " "$EXEC_LOG" \
  || fail "Q: the exec'd argv head is no longer the fixed 'allow --id <sid> --auto-restart': $(cat "$EXEC_LOG")"
# …and it is still the BENIGN tail. A regression that reintroduced the removed default
# would exec here and this guard would otherwise have called it a pass.
grep -q -- '--dangerously-skip-permissions\|--dangerously-bypass-approvals-and-sandbox' "$EXEC_LOG" \
  && fail "Q: a bypass flag reached the exec from a plan that never named one: $(cat "$EXEC_LOG")"
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
  SINGLETON_SELF_PID=9999 node "$BOOT_CLI" >"$R_OUT" 2>/dev/null
  want="$(printf '%s\n' telepty allow --id "$SID" --auto-restart "${PLAN_TAIL_ARGV[@]}")"
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
    for _element in telepty allow --id "$SID" --auto-restart "${PLAN_TAIL_ARGV[@]}"; do
      [ "$line" = "$_element" ] \
        && fail "R: --dry-run put the bare exec-argv element '$line' alone on a stdout line — indistinguishable from the boot path's contract channel"
    done
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
  PATH="$NOJQ" node "$BOOT_CLI" 2>"$T_ERR" >/dev/null
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
grep -q 'x-telepty-token: fixture-token-T131' "$CURL_LOG" || fail "W: synthetic token did not reach curl"
grep -q 'fixture-token-T131' "$W_ERR" && fail "W: token value appears in log output"
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

# Z) Probes inspect actionable fixtures without DELETE, signal, auth or exec.
if [ "$ORIGINAL" != "1" ]; then
  for probe in singleton-guard registry-reconcile exec-argv; do
    reset; : > "$EXEC_LOG"; : > "$AUTH_LOG"
    SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" "$BOOT" __probe "$probe" \
      >"$T_TMP/probe.out" 2>"$T_TMP/probe.err"
    [ ! -s "$KILL_LOG" ] && [ ! -s "$CURL_LOG" ] && [ ! -s "$AUTH_LOG" ] && [ ! -s "$EXEC_LOG" ] \
      || fail "Z/$probe: probe acted, resolved auth or exec'd"
    case "$probe" in
      singleton-guard) grep -q 'would SIGKILL.*pid=7777' "$T_TMP/probe.err" || fail "Z: missing kill verdict" ;;
      registry-reconcile) grep -q 'would DELETE' "$T_TMP/probe.err" || fail "Z: missing DELETE verdict" ;;
      exec-argv) cmp "$R_OUT" "$T_TMP/probe.out" || fail "Z: probe argv differs from boot stdout" ;;
    esac
  done
fi

# ===========================================================================
# AA) #1181 v2 — THE OLD BYPASS DOOR IS CLOSED, AND STAYS CLOSED.
#
#     This block is the other half of the oracle migration above. Every block before it
#     now boots through a complete explicit plan; that is only honest if something pins
#     that the thing the plan REPLACED can no longer happen. Before this revision:
#
#       ORCHESTRATOR_CLI=claude  (no terminal, no plan)
#         -> telepty allow --id <sid> --auto-restart claude --dangerously-skip-permissions --continue
#       ORCHESTRATOR_CLI=codex   (no terminal, no plan)
#         -> telepty allow --id <sid> --auto-restart codex resume --last --dangerously-bypass-approvals-and-sandbox
#
#     A variable naming an EXECUTABLE selected a permission BYPASS and a session RESUME.
#     Both are refusals now. This is a RED-first block: run it against the pre-#1181
#     compiled cli.js and every row fails, because every row booted.
#
#     Nothing here is skipped under ORCH_BOOT_PARITY_ORIGINAL=1 in the sense of pretending
#     to pass — the ORIGINAL genuinely had the door, so the original's expectation is the
#     opposite one, and it is asserted rather than waved through.
# ===========================================================================
AA_BAD_TAILS='--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|resume --last|--continue'

# AA.1 — ORCHESTRATOR_CLI ALONE IS NOT AUTHORITY, for any registered provider. The plan
# variables are unset for this block only; everything else stays as it is.
for aa_cli in claude codex gemini grok; do
  reset; : > "$EXEC_LOG"
  : > "$PS_TABLE"; no_orch_listing
  AA_OUT="$T_TMP/aa.out"; AA_ERR="$T_TMP/aa.err"
  set +e
  (unset AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY
   ORCHESTRATOR_CLI="$aa_cli" SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" \
     bash "$BOOT" >"$AA_OUT" 2>"$AA_ERR") </dev/null
  aa_rc=$?
  set -e
  if [ "$ORIGINAL" = "1" ]; then
    [ "$aa_rc" = "0" ] \
      || fail "AA.1/$aa_cli: the original refused a bare ORCHESTRATOR_CLI boot (rc $aa_rc) — it never did"
    continue
  fi
  [ "$aa_rc" = "2" ] \
    || fail "AA.1/$aa_cli: ORCHESTRATOR_CLI alone, with no terminal and no plan, must exit 2; got $aa_rc. stdout: $(cat "$AA_OUT") stderr: $(cat "$AA_ERR")"
  # THE ARGV CHANNEL MUST BE EMPTY. The shim reads fd 1 through a command substitution;
  # a refusal that printed one token would be a refusal the shell exec'd.
  [ ! -s "$AA_OUT" ] \
    || fail "AA.1/$aa_cli: a refusal wrote to the exec-argv channel: $(cat "$AA_OUT")"
  [ ! -s "$EXEC_LOG" ] \
    || fail "AA.1/$aa_cli: ORCHESTRATOR_CLI alone BOOTED — the removed bypass door is open again: $(cat "$EXEC_LOG")"
  # ZERO EFFECTS, and specifically zero effects BEFORE the refusal: the refusal is
  # documented as landing before the capture validation, the registry read and the
  # process scan, so an incomplete plan cannot cost a DELETE or a SIGKILL.
  [ ! -s "$KILL_LOG" ] || fail "AA.1/$aa_cli: the refusal SIGKILLed something: $(cat "$KILL_LOG")"
  [ ! -s "$CURL_LOG" ] || fail "AA.1/$aa_cli: the refusal issued a registry request: $(cat "$CURL_LOG")"
  [ ! -s "$AUTH_LOG" ] || fail "AA.1/$aa_cli: the refusal resolved a credential"
  [ ! -s "$PS_ARGV" ] || fail "AA.1/$aa_cli: the refusal scanned the process table: $(cat "$PS_ARGV")"
  [ ! -s "$TELEPTY_ARGV" ] || fail "AA.1/$aa_cli: the refusal read the registry: $(cat "$TELEPTY_ARGV")"
  # It must say WHY, naming the opt-in, so an operator is not left guessing.
  grep -qF 'AIGENTRY_BOOT_PLAN' "$AA_ERR" \
    || fail "AA.1/$aa_cli: the refusal never names the opt-in that would make a plan valid: $(cat "$AA_ERR")"
  # And it must not have printed the thing it refused to do.
  grep -qE -- "$AA_BAD_TAILS" "$AA_OUT" \
    && fail "AA.1/$aa_cli: the refusal echoed a removed bypass argv on stdout: $(cat "$AA_OUT")"
done

if [ "$ORIGINAL" != "1" ]; then
  # AA.2 — A PARTIAL PLAN IS A REFUSAL, NOT A COMPLETION. Each row drops exactly ONE
  # required field from the complete plan the blocks above use. Absence must never be
  # filled with a permissive value; the field must be NAMED.
  aa_partial() { # aa_partial <label> <field-that-must-be-named> <env assignments...>
    local label="$1" want="$2"; shift 2
    reset; : > "$EXEC_LOG"
    : > "$PS_TABLE"; no_orch_listing
    local out="$T_TMP/aa2.out" err="$T_TMP/aa2.err" rc=0
    set +e
    # ORCHESTRATOR_CLI is exported at the top of this file, so it is cleared here too and
    # each row states it explicitly. Otherwise the `no-provider` row could not exist.
    (unset AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY ORCHESTRATOR_CLI
     env "$@" SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" bash "$BOOT" >"$out" 2>"$err") </dev/null
    rc=$?
    set -e
    [ "$rc" = "2" ] || fail "AA.2/$label: an incomplete plan must exit 2, got $rc; stderr: $(cat "$err")"
    [ ! -s "$out" ] || fail "AA.2/$label: an incomplete plan wrote to the exec-argv channel: $(cat "$out")"
    [ ! -s "$EXEC_LOG" ] || fail "AA.2/$label: an incomplete plan BOOTED: $(cat "$EXEC_LOG")"
    [ ! -s "$KILL_LOG" ] || fail "AA.2/$label: an incomplete plan SIGKILLed something"
    [ ! -s "$CURL_LOG" ] || fail "AA.2/$label: an incomplete plan issued a registry request"
    grep -qF -- "$want" "$err" \
      || fail "AA.2/$label: the refusal does not name the missing field '$want': $(cat "$err")"
  }
  aa_partial no-permission AIGENTRY_BOOT_PERMISSION \
    AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_HISTORY=new
  aa_partial no-history AIGENTRY_BOOT_HISTORY \
    AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=manual'
  aa_partial no-provider ORCHESTRATOR_CLI \
    AIGENTRY_BOOT_PLAN=1 AIGENTRY_BOOT_PERMISSION='approval=manual' AIGENTRY_BOOT_HISTORY=new
  # codex has TWO axes. Naming one and omitting the other is the exact shape of "absent
  # is permissive", and it must be refused with the omitted axis named.
  aa_partial codex-missing-sandbox-axis sandbox \
    AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=codex AIGENTRY_BOOT_PERMISSION='approval=on-request' \
    AIGENTRY_BOOT_HISTORY=new

  # AA.3 — THE OPT-IN IS NOT OPTIONAL AND NOT FUZZY. A plan field set without
  # AIGENTRY_BOOT_PLAN=1 must be REFUSED rather than ignored: silently dropping a
  # permission axis a caller took the trouble to set is the worst outcome available.
  reset; : > "$EXEC_LOG"; : > "$PS_TABLE"; no_orch_listing
  set +e
  (unset AIGENTRY_BOOT_PLAN
   ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=bypassPermissions' \
     AIGENTRY_BOOT_HISTORY=last SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" \
     bash "$BOOT" >"$T_TMP/aa3.out" 2>"$T_TMP/aa3.err") </dev/null
  aa3_rc=$?
  set -e
  [ "$aa3_rc" = "2" ] || fail "AA.3: plan fields without the opt-in must exit 2, got $aa3_rc"
  [ ! -s "$T_TMP/aa3.out" ] || fail "AA.3: it wrote to the exec-argv channel"
  [ ! -s "$EXEC_LOG" ] || fail "AA.3: plan fields without the opt-in BOOTED"
  grep -qF 'AIGENTRY_BOOT_PERMISSION' "$T_TMP/aa3.err" \
    || fail "AA.3: the refusal does not name the field that was about to be ignored: $(cat "$T_TMP/aa3.err")"

  # 'true', 'yes', '0' — anything but the literal '1' — must be told, not guessed at.
  for aa_flag in true yes 0 1x; do
    reset; : > "$EXEC_LOG"; : > "$PS_TABLE"; no_orch_listing
    set +e
    (AIGENTRY_BOOT_PLAN="$aa_flag" ORCHESTRATOR_CLI=claude SINGLETON_SELF_PID=9999 \
       PATH="$EXEC_DIR:$PATH" bash "$BOOT" >"$T_TMP/aa4.out" 2>"$T_TMP/aa4.err") </dev/null
    aa4_rc=$?
    set -e
    [ "$aa4_rc" = "2" ] || fail "AA.3/$aa_flag: AIGENTRY_BOOT_PLAN='$aa_flag' must exit 2, got $aa4_rc"
    [ ! -s "$EXEC_LOG" ] || fail "AA.3/$aa_flag: a non-'1' opt-in value BOOTED"
    [ ! -s "$T_TMP/aa4.out" ] || fail "AA.3/$aa_flag: it wrote to the exec-argv channel"
  done

  # AA.4 — AN ELEVATED PLAN STILL NEEDS THE TYPED ACKNOWLEDGEMENT, and the phrase is
  # derived from the SELECTION. This is the door an operator who genuinely needs the old
  # behaviour walks through, and it must not be walkable by accident.
  reset; : > "$EXEC_LOG"; : > "$PS_TABLE"; no_orch_listing
  set +e
  (AIGENTRY_BOOT_PERMISSION='approval=dangerously-skip-permissions' AIGENTRY_BOOT_HISTORY=last \
     ORCHESTRATOR_CLI=claude SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" \
     bash "$BOOT" >"$T_TMP/aa5.out" 2>"$T_TMP/aa5.err") </dev/null
  aa5_rc=$?
  set -e
  [ "$aa5_rc" = "2" ] \
    || fail "AA.4: the old bypass argv was produced WITHOUT an acknowledgement (rc $aa5_rc): $(cat "$T_TMP/aa5.out")"
  [ ! -s "$EXEC_LOG" ] || fail "AA.4: an unacknowledged bypass plan BOOTED: $(cat "$EXEC_LOG")"
  [ ! -s "$T_TMP/aa5.out" ] || fail "AA.4: an unacknowledged bypass plan wrote to the exec-argv channel"
  grep -qF 'AIGENTRY_BOOT_RISK_ACK' "$T_TMP/aa5.err" \
    || fail "AA.4: the refusal does not name the acknowledgement field: $(cat "$T_TMP/aa5.err")"
  # A STALE acknowledgement for a DIFFERENT selection must not authorise this one.
  reset; : > "$EXEC_LOG"; : > "$PS_TABLE"; no_orch_listing
  set +e
  (AIGENTRY_BOOT_PERMISSION='approval=dangerously-skip-permissions' AIGENTRY_BOOT_HISTORY=last \
     AIGENTRY_BOOT_RISK_ACK='I ACCEPT ELEVATED claude approval=auto' \
     ORCHESTRATOR_CLI=claude SINGLETON_SELF_PID=9999 PATH="$EXEC_DIR:$PATH" \
     bash "$BOOT" >"$T_TMP/aa6.out" 2>"$T_TMP/aa6.err") </dev/null
  aa6_rc=$?
  set -e
  [ "$aa6_rc" = "2" ] \
    || fail "AA.4: an acknowledgement naming a DIFFERENT elevated value authorised this one (rc $aa6_rc)"
  [ ! -s "$EXEC_LOG" ] || fail "AA.4: a stale acknowledgement BOOTED a bypass"

  # AA.5 — THE STATIC HALF. The two removed literals must not be reachable as DATA from
  # the boot path's own modules. They survive in exactly one legitimate place: named
  # values of the chosen provider's approval axis, each marked risk "bypass", which is
  # the acknowledged door AA.4 just proved is shut by default.
  #
  # Comment lines are stripped before the scan because both files explain the removal in
  # prose, and a guard that cannot tell an explanation from an argv would either fail on
  # the documentation or have to stop looking.
  for aa_mod in cli.js plan.js wizard.js; do
    aa_src="$BOOT_FIXTURE/dist/src/orchestrator-boot/$aa_mod"
    sed -e 's|^[[:space:]]*//.*$||' -e 's|^[[:space:]]*\*.*$||' "$aa_src" > "$T_TMP/aa-nocomment.js"
    grep -nE -- '--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox' \
      "$T_TMP/aa-nocomment.js" \
      && fail "AA.5: $aa_mod carries a removed bypass literal outside a comment — the hardcoded tail is reachable again"
  done
  aa_caps="$BOOT_FIXTURE/dist/src/orchestrator-boot/provider-capabilities.js"
  grep -n -- 'value: "dangerously-skip-permissions"' "$aa_caps" | grep -q 'risk: "bypass"' \
    || fail "AA.5: claude's dangerously-skip-permissions value is no longer marked risk 'bypass' — it would stop requiring the acknowledgement"
  grep -n -- 'value: "dangerously-bypass-approvals-and-sandbox"' "$aa_caps" | grep -q 'risk: "bypass"' \
    || fail "AA.5: codex's combined bypass value is no longer marked risk 'bypass'"
  # And no axis's RESTRICTIVE default may be one of them — the wizard pre-selects
  # restrictive values and Enter must never reach a bypass.
  grep -nE -- '"(dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|danger-full-access|yolo)".*risk: "restrictive"' "$aa_caps" \
    && fail "AA.5: a bypass-class value is registered as 'restrictive' — Enter would pre-select it in the wizard"

  # AA.6 — NO IMPLICIT RESUME. `--continue` / `resume --last` are history choices now, and
  # the benign plan this file boots with chose `new`. Nothing on the boot path may add one.
  reset; : > "$EXEC_LOG"
  : > "$PS_TABLE"; no_orch_listing
  SINGLETON_SELF_PID=9999 node "$BOOT_CLI" >"$T_TMP/aa7.out" 2>/dev/null
  grep -qx -- '--continue' "$T_TMP/aa7.out" \
    && fail "AA.6: a plan that chose history=new emitted --continue — an implicit resume: $(cat "$T_TMP/aa7.out")"
  grep -qx -- 'resume' "$T_TMP/aa7.out" \
    && fail "AA.6: a plan that chose history=new emitted a 'resume' subcommand: $(cat "$T_TMP/aa7.out")"
  echo "T131 AA PASS (the ORCHESTRATOR_CLI-alone bypass door is closed on all four providers)"
fi

echo "T131 PASS"
