#!/usr/bin/env bash
# T116 (#899 tranche 3a) — the open-session CLI contract lines NO guard pinned.
#
# Twelve guards name bin/open-session.sh and only two drive it: T39 pins the cmux
# readiness barrier's four cases, T56 pins the #616 sidebar pill and the absence of
# focus theft. Both are worth keeping exactly as they are, and both leave the CLI
# ITSELF unmeasured: the --help text, the argument validation matrix, the exact
# stderr wording, the ~/.aigentry/open-session.log line, which exit codes the
# adapter's failures arrive as, and — the one that matters most on this path —
# whether AIGENTRY_WH_LEGACY_SPAWN=1 still reaches the inline arm rather than
# quietly falling through to the wh_open seam it exists to bypass.
#
# Each of those is a line a port can drop silently. The spawn still works, the ref
# still comes back, and the only visible change is an operator's typo answered by a
# different message, a log line whose fields moved, a spawn failure arriving as 1
# instead of 2 (which is what a caller reads to tell "no surface" from "surface but
# not ready"), or a rollback lever that no longer levers anything. THIS IS THE LIVE
# SPAWN PATH — `bin/dispatch.sh --spawn-and-dispatch` → boot-prepare → here — so
# this guard is the characterization test that makes the port's parity measurable
# rather than reviewed.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $OPEN_SESSION_UNDER_TEST, defaulting to bin/open-session.sh. Every block below
# passed against the ORIGINAL bash implementation (`git show
# 736707a:bin/open-session.sh`, copied into bin/ so its SCRIPT_DIR resolves
# lib/workspace-host.sh and lib/platform.sh the same way) before the port landed:
#
#   git show 736707a:bin/open-session.sh > bin/.open-session-original.sh
#   chmod +x bin/.open-session-original.sh
#   OPEN_SESSION_UNDER_TEST="$PWD/bin/.open-session-original.sh" \
#     bash tests/dispatch/T116_open_session_parity.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with the spawn path.
#
# THE ONE DELIBERATE DEVIATION, and why the message is not asserted: a flag with no
# value (`--track` last on argv) was `"$2"` under `set -u`. bash printed a
# LOCALE-DEPENDENT diagnostic ("$2: unbound variable", and on this host "$2: 바인딩
# 해제한 변수") and exited 1. Block B pins the exit code and that SOMETHING was said
# on stderr; pinning a localized shell string would make the guard fail on a runner
# whose LANG differs, which measures the locale and not the CLI.
#
# EXIT 64 IS NOT EXERCISED, AND THAT IS A MEASUREMENT, NOT AN OMISSION. wh_open
# answers 64 when the selected adapter has no `_wh_<adapter>_open`
# (bin/lib/workspace-host.sh:940). open-session forces the adapter to
# detect_terminal's own answer, which is always one of the seven registry rows, and
# all seven have an _open arm — so 64 is unreachable from this script by
# construction. Block E pins the construction instead: a hostile
# AIGENTRY_WORKSPACE_HOST in the ENVIRONMENT does not survive the env-force, so it
# cannot steer the spawn onto an adapter that has no spawn.
#
# Hermetic throughout: a fake cmux driven through the CMUX seam (T39/T56's idiom, NO
# live daemon 3848), a temp HOME so the real ~/.aigentry/open-session.log is never
# appended to, CTX_ROUTER_PATH pointed at nothing, AIGENTRY_SLEEP_GUARD=0 from
# lib.sh so no test touches the host's power state, and a throwaway track/name only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

OPEN="${OPEN_SESSION_UNDER_TEST:-$REPO_ROOT/bin/open-session.sh}"
[ -x "$OPEN" ] || { echo "T116 SKIP — $OPEN missing"; exit 0; }

fail() { echo "FAIL[T116]: $*" >&2; exit 1; }

REF="workspace:116"
STUB="$T_TMP/cmux-stub"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
# Fake cmux. STUB_NO_REF makes new-workspace produce no `workspace:N` (spawn
# failure); STUB_NEVER_READY makes list-workspaces omit the ref forever (ready-gate
# timeout). Both mirror what the real binary does on those two failures, including
# printing `Error:` with exit 0 — cmux's exit status is unreliable and every arm of
# the readiness gate inspects OUTPUT TEXT for that reason.
ref="${CMUX_STUB_REF:-workspace:116}"
log="${CMUX_STUB_LOG:?}"
printf '%s\n' "$*" >> "$log"
case "$1" in
  new-workspace)
    [ "${STUB_NO_REF:-0}" = 1 ] && { echo "Error: could not create"; exit 0; }
    echo "OK $ref" ;;
  list-workspaces)
    echo "* workspace:1  orchestrator  [selected]"
    [ "${STUB_NEVER_READY:-0}" = 1 ] || echo "  $ref  faketitle" ;;
  surface-health)   echo "surface:9  type=terminal in_window=false" ;;
  read-screen)      echo "  claude prompt rendered" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$STUB"

# run_open <label> [VAR=VAL ...] — drive the script under test with the fake cmux and
# a per-arm temp HOME. Sets: OUT RC ERRTXT STUBLOG OSLOG.
run_open() {
  local label="$1"; shift
  STUBLOG="$T_TMP/$label.stub.log"; : > "$STUBLOG"
  local home="$T_TMP/home-$label"; mkdir -p "$home"
  OSLOG="$home/.aigentry/open-session.log"
  local errf="$T_TMP/$label.err"
  set +e
  OUT=$(env "$@" \
    HOME="$home" \
    CTX_ROUTER_PATH=/nonexistent \
    CMUX_WORKSPACE_ID=t116 \
    CMUX="$STUB" \
    CMUX_STUB_REF="$REF" CMUX_STUB_LOG="$STUBLOG" \
    CMUX_READY_TIMEOUT_MS=120 CMUX_READY_INTERVAL_MS=10 \
    AIGENTRY_CONFIG="$T_TMP/no-such-config.json" \
    "$OPEN" --track t116 --name "$label" --cwd "$T_TMP/cwd-$label" --cli claude 2>"$errf")
  RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
}

# --- A) --help is the old header, all 29 lines of it -------------------------------
# The shell answered --help with `sed -n '2,30p' "$0"`. Line 30 is the script's own
# `set -euo pipefail` — nobody chose to document it, sed included it, and it is
# therefore part of the output every operator who ran --help has seen. A port that
# tidied it away would be changing the contract while calling it a cleanup.
set +e
HELP=$("$OPEN" --help 2>"$T_TMP/help.err"); rc=$?
set -e
[ "$rc" -eq 0 ] || fail "A: --help exited $rc, want 0"
n=$(printf '%s\n' "$HELP" | wc -l | tr -d ' ')
[ "$n" -eq 29 ] || fail "A: --help printed $n lines, want 29 (sed -n '2,30p')"
printf '%s\n' "$HELP" | head -1 \
  | grep -qxF "# open-session.sh — Open an aigentry session in the user's current terminal environment" \
  || fail "A: --help first line changed: '$(printf '%s\n' "$HELP" | head -1)'"
printf '%s\n' "$HELP" | tail -1 | grep -qxF 'set -euo pipefail' \
  || fail "A: --help last line changed: '$(printf '%s\n' "$HELP" | tail -1)'"
# Three contract lines from the middle — the SID convention and the per-CLI defaults
# are the part operators actually read.
for want in \
  '# Session id (SID) convention: {track}-{name}  (e.g. "B-architect-264")' \
  '#   claude default flags: --permission-mode bypassPermissions' \
  '# Output: session ref on stdout (cmux: "workspace:N", others: SID)'
do
  printf '%s\n' "$HELP" | grep -qxF "$want" || fail "A: --help lost the line: $want"
done
[ -z "$(cat "$T_TMP/help.err")" ] || fail "A: --help wrote to stderr: $(cat "$T_TMP/help.err")"

# --- B) the argument validation matrix, message for message ------------------------
# arg_case <label> <expected-rc> <expected-stderr-first-line> [args...]
arg_case() {
  local label="$1" want_rc="$2" want_err="$3"; shift 3
  local errf="$T_TMP/arg-$label.err"
  set +e
  local out; out=$(HOME="$T_TMP/home-arg" AIGENTRY_CONFIG="$T_TMP/no-such-config.json" \
    "$OPEN" "$@" 2>"$errf"); local rc=$?
  set -e
  [ "$rc" -eq "$want_rc" ] || fail "B/$label: rc=$rc want $want_rc (err: $(cat "$errf"))"
  [ -z "$out" ] || fail "B/$label: wrote '$out' to stdout — a refusal must emit no ref"
  head -1 "$errf" | grep -qxF "$want_err" \
    || fail "B/$label: stderr first line '$(head -1 "$errf")' want '$want_err'"
}
arg_case no-args    1 'ERR --track required'
arg_case no-name    1 'ERR need either --name or (--role + --task)'         --track x
arg_case no-cwd     1 'ERR cwd unresolved. Options:'                        --track x --name y
arg_case unknown    1 'ERR unknown arg: --bogus'                            --bogus
# The `--cwd unresolved` refusal is three lines and the last one names the config
# file it wants edited; an operator who only gets line 1 has nothing to act on.
set +e
HOME="$T_TMP/home-arg" AIGENTRY_CONFIG="$T_TMP/cfg.json" "$OPEN" --track x --name y \
  2>"$T_TMP/nocwd.err" >/dev/null
set -e
grep -qxF '  1. Pass --cwd PATH explicitly' "$T_TMP/nocwd.err" \
  || fail "B: the cwd refusal lost its first option line"
grep -qF "  2. Configure role in $T_TMP/cfg.json" "$T_TMP/nocwd.err" \
  || fail "B: the cwd refusal does not name AIGENTRY_CONFIG's file"
# A flag with no value: exit 1 and a diagnostic. The wording is the implementation's
# (see this file's header) — only the code and the fact of a message are contract.
set +e
HOME="$T_TMP/home-arg" "$OPEN" --track 2>"$T_TMP/unbound.err" >/dev/null; rc=$?
set -e
[ "$rc" -eq 1 ] || fail "B: a valueless --track exited $rc, want 1"
[ -s "$T_TMP/unbound.err" ] || fail "B: a valueless --track said nothing on stderr"

# --- C) the happy path: one ref on stdout, one log line, the #616 pill -------------
run_open ok AIGENTRY_WORKSPACE_HOST=cmux
[ "$RC" -eq 0 ] || fail "C: rc=$RC want 0 (err: $ERRTXT)"
[ "$OUT" = "$REF" ] || fail "C: stdout='$OUT' want exactly '$REF' (the ref must be the SOLE stdout line)"
# The log line, field by field. Its shape is what `~/.aigentry/open-session.log`'s
# 753 recorded spawns are parseable as; a reordered or renamed field breaks every
# reader of that file, and nothing else in the repo would notice.
[ -f "$OSLOG" ] || fail "C: no ~/.aigentry/open-session.log line was appended"
[ "$(wc -l < "$OSLOG" | tr -d ' ')" -eq 1 ] || fail "C: expected exactly one log line, got $(wc -l < "$OSLOG")"
LOGLINE=$(cat "$OSLOG")
grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ' <<<"$LOGLINE" \
  || fail "C: log line does not start with a \`date -u +%FT%TZ\` stamp: $LOGLINE"
for want in \
  "term=cmux" "ref=$REF" "sid=t116-ok" "title=t116-ok" "cwd=$T_TMP/cwd-ok" "cli=claude" \
  "flags=--model "
do
  grep -qF -- "$want" <<<"$LOGLINE" || fail "C: log line lost '$want': $LOGLINE"
done
grep -qE "term=cmux ref=$REF sid=t116-ok title=t116-ok cwd=[^ ]+ cli=claude flags=" <<<"$LOGLINE" \
  || fail "C: log line field ORDER changed: $LOGLINE"
# The #616 pill went out and no focus was stolen (T56 owns this end-to-end; repeated
# here because block E tells the two spawn paths apart by its presence).
grep -qF "set-status aigentry working" "$STUBLOG" || fail "C: the #616 working pill was not pushed"
grep -q 'select-workspace' "$STUBLOG" && fail "C: FOCUS THEFT — select-workspace issued on spawn"
# The default claude flags reached cmux verbatim: the wrapped command is what the
# worker actually starts as, and #909's sleep assertion finds the pid by matching it.
#
# #926 MOVED THE cwd AND THE sid OFF THE COMMAND STRING AND ONTO ARGV, so this block
# and block E's twin were re-pinned to the new shape. Nothing else in T116 changed:
# the eval this guard was believed to pin was never exercised here (no block ever
# passed a cwd holding a metacharacter), so the port's `eval cwd="$cwd"` could be
# deleted without touching a line. Only the sid's `--id "$2"` moved bytes. What the
# assertion still measures is unchanged — the wrapper is `telepty allow` with the
# default claude flags verbatim — plus, now, that the sid arrives as DATA on argv.
grep -qF -- "exec telepty allow --id \"\$2\" --auto-restart claude --model " "$STUBLOG" \
  || fail "C: the telepty-allow wrapper argv changed. stub log:
$(cat "$STUBLOG")"
grep -qE -- "' _ .* t116-ok\$" "$STUBLOG" \
  || fail "C: the sid is no longer the last argv element handed to the wrapper. stub log:
$(cat "$STUBLOG")"

# --- D) the adapter's failure codes arrive verbatim, on BOTH spawn paths -----------
# 2 = new-workspace produced no ref (nothing spawned); 3 = the ready gate timed out
# and the workspace was closed. A caller that cannot tell those apart cannot tell
# "no surface" from "a surface that was torn down", and neither must ever be
# smoothed to 1 — a generic failure — by the port.
#
# `AIGENTRY_WH_LEGACY_SPAWN=` (empty) is the wh arm rather than an empty array
# expansion: `"${arr[@]}"` on an empty array is an unbound-variable fatal under
# `set -u` in the bash 3.2 that ships as /bin/bash on the macos-latest runner, and
# the value is only ever compared against the literal "1".
for arm in wh legacy; do
  legacy_env="AIGENTRY_WH_LEGACY_SPAWN="
  [ "$arm" = legacy ] && legacy_env="AIGENTRY_WH_LEGACY_SPAWN=1"
  run_open "noref-$arm" AIGENTRY_WORKSPACE_HOST=cmux STUB_NO_REF=1 "$legacy_env"
  [ "$RC" -eq 2 ] || fail "D/$arm: a spawn that produced no ref exited $RC, want 2 (err: $ERRTXT)"
  [ -z "$OUT" ] || fail "D/$arm: emitted '$OUT' for a workspace that was never created"
  grep -qF 'ERR cmux new-workspace failed:' <<<"$ERRTXT" \
    || fail "D/$arm: the spawn failure was not announced. stderr:
$ERRTXT"
  [ ! -f "$OSLOG" ] || fail "D/$arm: logged a spawn that failed: $(cat "$OSLOG")"

  run_open "timeout-$arm" AIGENTRY_WORKSPACE_HOST=cmux STUB_NEVER_READY=1 "$legacy_env"
  [ "$RC" -eq 3 ] || fail "D/$arm: a ready-gate timeout exited $RC, want 3 (err: $ERRTXT)"
  [ -z "$OUT" ] || fail "D/$arm: emitted '$OUT' for a pane that never came up"
  grep -qF 'pane not ready after 120ms' <<<"$ERRTXT" \
    || fail "D/$arm: the timeout was not announced actionably. stderr:
$ERRTXT"
  grep -qF "close-workspace --workspace $REF" "$STUBLOG" \
    || fail "D/$arm: the dead workspace was not closed. stub log:
$(cat "$STUBLOG")"
  [ ! -f "$OSLOG" ] || fail "D/$arm: logged a spawn that timed out: $(cat "$OSLOG")"
done

# --- E) AIGENTRY_WH_LEGACY_SPAWN=1 still takes the INLINE arm ---------------------
# The only rollback lever on this path that needs no rebuild. Two observables tell
# the inline arm from the wh_open seam, and neither is a proxy for the other:
#   * the seam logs `[workspace-host] open: adapter=cmux` from wh_open itself;
#   * the seam's caller then pushes the #616 pill, which the inline arm returns
#     before ever reaching.
# The inline arm must show NEITHER and still hand back the same ref: a lever that
# silently fell through to the thing it exists to bypass is worse than no lever,
# because the operator believes they have reverted.
run_open legacy AIGENTRY_WORKSPACE_HOST=cmux AIGENTRY_WH_LEGACY_SPAWN=1
[ "$RC" -eq 0 ] || fail "E: the legacy arm exited $RC, want 0 (err: $ERRTXT)"
[ "$OUT" = "$REF" ] || fail "E: legacy stdout='$OUT' want '$REF'"
grep -qF '[workspace-host] open:' <<<"$ERRTXT" \
  && fail "E: AIGENTRY_WH_LEGACY_SPAWN=1 reached wh_open — the rollback lever does not bypass the seam"
grep -qF 'set-status aigentry working' "$STUBLOG" \
  && fail "E: AIGENTRY_WH_LEGACY_SPAWN=1 pushed the #616 pill — that is the wh_open path, not the inline arm"
# …and the inline arm is still the devkit original: same new-workspace argv, same
# rename, same three-part readiness gate against the same cmux binary.
for want in "new-workspace --cwd" "rename-workspace --workspace $REF t116-legacy" \
            "list-workspaces" "surface-health --workspace $REF" "read-screen --workspace $REF --lines 1"
do
  grep -qF -- "$want" "$STUBLOG" || fail "E: the inline arm no longer issues '$want'. stub log:
$(cat "$STUBLOG")"
done
# Re-pinned by #926 alongside block C — the inline arm carries its OWN copy of the
# wrapper (legacy-spawn.ts), so it got the same cwd+sid-onto-argv fix and the same
# re-pin. A lever that still shipped the injectable wrapper would not be a rollback.
grep -qF -- "exec telepty allow --id \"\$2\" --auto-restart claude " "$STUBLOG" \
  || fail "E: the inline arm's telepty-allow wrapper changed. stub log:
$(cat "$STUBLOG")"
grep -qE -- "' _ .* t116-legacy\$" "$STUBLOG" \
  || fail "E: the inline arm no longer hands the sid on argv. stub log:
$(cat "$STUBLOG")"
# The control: the SAME invocation without the lever DOES take the seam. Without
# this line block E would pass just as happily against an implementation that never
# reaches wh_open at all.
run_open control AIGENTRY_WORKSPACE_HOST=cmux
grep -qF '[workspace-host] open:' <<<"$ERRTXT" \
  || fail "E: the default path did NOT reach wh_open — the seam is gone, not bypassed. stderr:
$ERRTXT"

# --- F) the env-force is what makes exit 64 unreachable ---------------------------
# wh_open answers 64 for an adapter with no `_wh_<adapter>_open`. This script forces
# AIGENTRY_WORKSPACE_HOST to detect_terminal's own answer for the spawn call, so an
# inherited value — including a garbage one — cannot steer it onto an adapter that
# has no spawn. Pinning the construction is honest; manufacturing a 64 it cannot
# produce would not be.
run_open forced AIGENTRY_WORKSPACE_HOST=not-a-real-adapter
[ "$RC" -eq 0 ] || fail "F: a hostile AIGENTRY_WORKSPACE_HOST changed the spawn's outcome (rc=$RC): $ERRTXT"
[ "$OUT" = "$REF" ] || fail "F: with a hostile AIGENTRY_WORKSPACE_HOST stdout='$OUT' want '$REF'"
grep -qF '[workspace-host] open: adapter=cmux' <<<"$ERRTXT" \
  || fail "F: the spawn did not force the DETECTED adapter — exit 64 stops being unreachable. stderr:
$ERRTXT"

echo "T116 PASS help=29-lines args=5 codes=2/3-both-paths legacy=inline"
