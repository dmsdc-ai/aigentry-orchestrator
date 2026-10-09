#!/usr/bin/env bash
# T134 (#934) — LOOKING AT THE CONTROL TOWER MUST NOT BOOT IT.
#
# THE INCIDENT, 2026-08-18, right after PR #23 merged. The orchestrator ran
#
#     bin/orchestrator-boot.sh --help | head -2
#
# as a smoke check. There is no `--help` and there never was: argv is not read on the
# boot path at all (src/orchestrator-boot/cli.ts dispatches on `__probe` and everything
# else falls into main()), so the "smoke check" ran the REAL boot — the #905 registry
# reconcile, the #539 singleton SIGKILL guard, and then the exec, which died on SIGPIPE
# from `head`. Nothing was harmed that day (the record was CONNECTED so the reconcile
# left it alone, the live bridge pid 6965 was correctly skipped as an ancestor, and a
# post-check found a single bridge with `orchestrator` CONNECTED clients=1) and the
# original bash behaved identically, so the port was faithful. THE FOOTGUN IS THE
# DESIGN, NOT THE PORT: a script that SIGKILLs processes and DELETEs a registry record
# had no way to be inspected without acting.
#
# Measured on this branch's parent (1088ad7) before the fix, with ps/kill/telepty/curl
# recorder stubs: `--help`, `-h`, `--dry-run` and `--bogus-flag` ALL produced the same
# four stderr lines, ONE SIGKILL of the fixture bridge, and the exec — rc 0 for every
# one of them.
#
# THIS GUARD IS THE RED. What it pins:
#
#   A  `--help` / `-h`: usage on stdout, exit 0, and ZERO of everything — no `ps`, no
#      `kill`, no `telepty list`, no `curl`, no exec.
#   B  the usage text is COMPLETE: every flag and every env seam the implementation
#      actually reads is named, and one line says a bare invocation boots and execs.
#      A usage that omits a seam is how the bridge-auditor's --help came to advertise
#      SINGLETON_PS_CMD and hide TELEPTY for a year (src/bridge-auditor/usage.ts:18-21).
#   C  `--dry-run`: ZERO kills, ZERO DELETEs, NO exec — but the reads DID happen (`ps`
#      and `telepty list --json` were called), because a dry run that reads nothing
#      cannot report a verdict.
#   D  `--dry-run` NAMES THE SAME WOULD-KILL SET a real run kills on the SAME ps
#      fixture. Driven through T131 block V's fixture — a real stale bridge, an
#      ancestor bridge, and an operator's own `pgrep -fl telepty` that merely MENTIONS
#      the marker — so the dry run inherits D4's fix and #539's belt instead of
#      re-deriving them. The dry run must PROVE the guard by SHOWING the skip, not by
#      bypassing it.
#   E  an unknown flag: one stderr line naming it, usage, non-zero, and still no boot.
#   F  EARLY-CLOSED STDOUT IS NOT A BOOT. `--help | head -2` and `--dry-run | head -2`
#      are the exact shape of the incident. The pipe closes under the writer; nothing
#      may be exec'd and no kill may be issued.
#   G  the reconcile's DELETE arm is REPORTED but NOT SENT: a STALE record with 0
#      clients — the one listing shape that authorises a DELETE — leaves the curl
#      recorder empty under `--dry-run`.
#
# NOTHING HERE TOUCHES A REAL PROCESS OR A REAL DAEMON. `ps`, `kill`, `telepty` and
# `curl` are recorder stubs throughout and every pid is synthetic; the exec target is a
# recorder on a private PATH that must never fire. No `telepty allow` is ever run.
#
# T131 owns the argv surface and keeps it: block Q gains "the exec recorder stays empty
# for every no-exec mode" and block R gains "no stdout line in a no-exec mode is a bare
# exec-argv element". This file owns everything else.
#
# ── #1181 v2: MIGRATED ORACLE, AND A BIGGER H ──────────────────────────────────────
#
# `--dry-run` and `__probe` resolve a plan the same non-prompting way a non-TTY boot does,
# so every block here that ran a dry run now needs a COMPLETE EXPLICIT PLAN or it gets a
# refusal instead of a report. The plan used is the benign one T131 uses — claude,
# approval=manual, history=new, no elevated value and therefore NO acknowledgement.
# Blocks C, D and G keep their assertions verbatim; only the reported provider tail moves
# from `claude --dangerously-skip-permissions --continue` to `claude --permission-mode
# manual`, because the former is no longer producible.
#
# BLOCK H IS REWRITTEN RATHER THAN PATCHED, and it is the one place this file GROWS.
# It used to assert #1131's selector: `ORCHESTRATOR_CLI` unset/claude/codex, each mapping
# to a hardcoded tail. Two of those three rows asserted a bypass default that has been
# deliberately removed, and the third (unset) asserted that a MISSING provider still
# booted — the exact behaviour #1181 exists to end. The replacement pins what the product
# claims instead: FOUR PROVIDERS, each with its OWN measured flag spelling, and the unset
# row becomes a refusal. It also pins the negative that makes the registry's whole reason
# for existing testable — that one provider's token is NOT accepted on another's axis.
#
# BLOCK J IS NEW: --help and -h must stay readable and inert under a HOSTILE environment
# (a malformed opt-in, a control-character sid, junk in every plan field). Help is what an
# operator runs when already confused; refusing it over an unrelated variable, or acting
# while printing it, are the two failures this ticket is about.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BOOT_SOURCE="${ORCH_BOOT_UNDER_TEST:-$REPO_ROOT/bin/orchestrator-boot.sh}"
# Keep shim behavior under test, but execute only private unchanged copies with a
# synthetic auth resolver. The actuation control invokes the compiled CLI directly.
BOOT_FIXTURE="$T_TMP/boot-fixture"
mkdir -p "$BOOT_FIXTURE/bin/lib" "$BOOT_FIXTURE/dist/src/orchestrator-boot" "$BOOT_FIXTURE/home"
cp "$BOOT_SOURCE" "$BOOT_FIXTURE/bin/orchestrator-boot.sh"
cp "$REPO_ROOT/bin/lib/node-shim.sh" "$BOOT_FIXTURE/bin/lib/node-shim.sh"
# H1 — the fixture must carry the WHOLE compiled module, not cli.js + usage.js. Since
# #1181 cli.js imports ./plan.js and ./wizard.js, and plan.js imports
# ./provider-capabilities.js; a two-file fixture dies at import with ERR_MODULE_NOT_FOUND
# before any assertion runs. Missing files fail loudly instead of half-populating.
BOOT_MODULE_FILES="cli.js usage.js plan.js wizard.js provider-capabilities.js"
for _f in $BOOT_MODULE_FILES; do
  [ -f "$REPO_ROOT/dist/src/orchestrator-boot/$_f" ] \
    || { echo "FAIL[T134]: the compiled module is incomplete — $_f is missing from $REPO_ROOT/dist/src/orchestrator-boot (run tsc -p .)" >&2; exit 1; }
  cp "$REPO_ROOT/dist/src/orchestrator-boot/$_f" "$BOOT_FIXTURE/dist/src/orchestrator-boot/"
done
# #1162: cli.js imports ./boot-record.js, which imports two boot-adapter modules. Same loud rule.
for _f in orchestrator-boot/boot-record.js session/boot-adapter/launch-config.js session/boot-adapter/types.js; do
  [ -f "$REPO_ROOT/dist/src/$_f" ] \
    || { echo "FAIL[T134]: the compiled module is incomplete — $_f is missing from $REPO_ROOT/dist/src (run tsc -p .)" >&2; exit 1; }
  mkdir -p "$BOOT_FIXTURE/dist/src/$(dirname "$_f")"
  cp "$REPO_ROOT/dist/src/$_f" "$BOOT_FIXTURE/dist/src/$_f"
done
# #1201: cli.js also imports the context-handoff engine, whose own imports are its business.
# Stage the whole compiled tree so the fixture cannot die at import on a list kept here.
cp -R "$REPO_ROOT/dist/src/." "$BOOT_FIXTURE/dist/src/"
printf '{"type":"module"}\n' > "$BOOT_FIXTURE/package.json"
AUTH_LOG="$T_TMP/auth.log"
printf 'telepty_auth_token() { printf "auth\\n" >> "%s"; printf "fixture-token-T134"; }\n' "$AUTH_LOG" \
  > "$BOOT_FIXTURE/bin/lib/telepty-auth.sh"
BOOT="$BOOT_FIXTURE/bin/orchestrator-boot.sh"
BOOT_CLI="$BOOT_FIXTURE/dist/src/orchestrator-boot/cli.js"
chmod +x "$BOOT"
export AIGENTRY_SHIM_SCRIPT_DIR="$BOOT_FIXTURE/bin" AIGENTRY_HOME="$BOOT_FIXTURE/home"
export ORCHESTRATOR_CLI=claude SINGLETON_SELF_PID=9999 TELEPTY_PORT=3848
# #1201: this file pins argv. The handoff step is T135's subject: it is switched off here, and
# HOME is a scratch dir with every store override unset, so the operator's real transcript
# stores (~/.claude, ~/.codex, ~/.gemini, ~/.grok) are never scanned whatever the switch does.
export AIGENTRY_HANDOFF=off HOME="$T_TMP/scratch-home"
mkdir -p "$HOME"
unset CLAUDE_CONFIG_DIR CODEX_HOME GEMINI_CLI_HOME CLAUDE_CODE_SESSION_ID
unset _NODE_SHIM_SH_SOURCED
cd "$BOOT_FIXTURE"

fail() { echo "FAIL[T134]: $*" >&2; exit 1; }

SID="orchestrator"

# ── the complete, benign, explicit plan the no-exec modes are driven with ───────────
# See the #1181 note in the header. Identical to T131's, for the same reason: it is the
# minimum COMPLETE plan for claude, it selects nothing elevated, and so nothing in this
# file ever sets AIGENTRY_BOOT_RISK_ACK. Blocks that must be driven WITHOUT a plan (A, E,
# J and H's refusal rows) clear these explicitly in a subshell.
export AIGENTRY_BOOT_PLAN=1
export AIGENTRY_BOOT_PERMISSION='approval=manual'
export AIGENTRY_BOOT_HISTORY=new
PLAN_TAIL_ARGV=(claude --permission-mode manual)
PLAN_TAIL="claude --permission-mode manual"

# ── recorders: the same four seams T131 uses, same shapes ───────────────────
PS_TABLE="$T_TMP/ps-table.txt"
PS_ARGV="$T_TMP/ps-argv.log"
PS_STUB="$STUB_BIN/ps-recorder134.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PS_ARGV"
cat "$PS_TABLE"
EOF

KILL_LOG="$T_TMP/kill-calls.log"
KILL_STUB="$STUB_BIN/kill-recorder134.sh"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF

LIST_JSON="$T_TMP/list.json"
TELEPTY_ARGV="$T_TMP/telepty-argv.log"
TELEPTY_STUB="$STUB_BIN/telepty-recorder134.sh"
cat > "$TELEPTY_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TELEPTY_ARGV"
cat "$LIST_JSON" 2>/dev/null || true
exit 0
EOF

CURL_LOG="$T_TMP/curl-calls.log"
CURL_STUB="$STUB_BIN/curl-recorder134.sh"
cat > "$CURL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
printf '200'
exit 0
EOF

chmod +x "$PS_STUB" "$KILL_STUB" "$TELEPTY_STUB" "$CURL_STUB"

# The exec target. Resolved from PATH exactly as the shim resolves it, so if any mode
# ever reaches the exec this file records it. It must stay EMPTY in every block here.
EXEC_DIR="$T_TMP/exec-path"
mkdir -p "$EXEC_DIR"
EXEC_LOG="$T_TMP/exec.log"
cat > "$EXEC_DIR/telepty" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$EXEC_LOG"
exit 0
EOF
chmod +x "$EXEC_DIR/telepty"

export SINGLETON_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB"
export TELEPTY="$TELEPTY_STUB" CURL="$CURL_STUB"
export ORCHESTRATOR_SID="$SID"

# The ps row that stands for a LIVE bridge. Its tail is the plan tail now — that is what
# a bridge this product boots looks like. The guard matches `[node] telepty allow … --id
# <sid>` and never the tail, so no kill decision below changes.
BRIDGE="node /Users/x/.nvm/versions/node/v20.20.0/bin/telepty allow --id $SID --auto-restart $PLAN_TAIL"

reset() { : > "$KILL_LOG"; : > "$CURL_LOG"; : > "$PS_ARGV"; : > "$TELEPTY_ARGV"; : > "$EXEC_LOG"; : > "$AUTH_LOG"; }
# `grep -c .` prints the count and exits 1 on zero, so the status is swallowed rather
# than answered with a second line (T131's idiom).
lines() { grep -c . "$1" 2>/dev/null || true; }

# The listing that authorises a DELETE. Used deliberately: a dry run must reach the one
# arm that acts and STILL not act.
stale_listing() {
  printf '[{"id":"%s","healthStatus":"STALE","active_clients":0}]' "$SID" > "$LIST_JSON"
}

# A ps table with a real stale bridge on it, so "no kill" is a measurement and not an
# empty fixture answering for itself.
loaded_ps_table() {
  cat > "$PS_TABLE" <<EOF
7777 1 $BRIDGE
EOF
}

# Every no-exec assertion in one place: whatever ran, it must not have acted.
assert_no_side_effects() { # assert_no_side_effects <label>
  [ "$(lines "$KILL_LOG")" = "0" ] \
    || fail "$1: a kill was issued by a mode that must not kill; kills: $(cat "$KILL_LOG")"
  [ "$(lines "$CURL_LOG")" = "0" ] \
    || fail "$1: a registry request was issued by a mode that must not DELETE; calls: $(cat "$CURL_LOG")"
  [ "$(lines "$EXEC_LOG")" = "0" ] \
    || fail "$1: THE MODE BOOTED THE ORCHESTRATOR — the exec recorder fired: $(cat "$EXEC_LOG")"
  [ "$(lines "$AUTH_LOG")" = "0" ] || fail "$1: inspection resolved auth"
}

# ===========================================================================
# A) --help / -h — usage on stdout, exit 0, and NOTHING read, killed or exec'd.
#    Both spellings, because the incident's command used the long one and an
#    operator's fingers use the short one.
# ===========================================================================
for flag in --help -h; do
  reset; loaded_ps_table; stale_listing
  A_OUT="$T_TMP/a.out"; A_ERR="$T_TMP/a.err"
  set +e
  PATH="$EXEC_DIR:$PATH" bash "$BOOT" "$flag" >"$A_OUT" 2>"$A_ERR"
  a_rc=$?
  set -e
  [ "$a_rc" = "0" ] || fail "A: '$flag' must exit 0, got $a_rc; stderr: $(cat "$A_ERR")"
  [ -s "$A_OUT" ] || fail "A: '$flag' printed no usage on STDOUT (stderr was: $(cat "$A_ERR"))"
  assert_no_side_effects "A/$flag"
  # A --help that scans the process table is still doing the dangerous half of the
  # work; the incident's whole lesson is that inspection must be inert.
  [ "$(lines "$PS_ARGV")" = "0" ] \
    || fail "A: '$flag' ran the process lister; ps argv: $(cat "$PS_ARGV")"
  [ "$(lines "$TELEPTY_ARGV")" = "0" ] \
    || fail "A: '$flag' queried the daemon; telepty argv: $(cat "$TELEPTY_ARGV")"
done

# A control-character ORCHESTRATOR_SID (D1) must NOT swallow --help. --help is what an
# operator runs when already confused; refusing it over an unrelated env var is the
# same family of footgun this ticket closes. T131 block S keeps D1 on the boot path.
reset; loaded_ps_table; stale_listing
A2_OUT="$T_TMP/a2.out"
set +e
ORCHESTRATOR_SID="$(printf 'orch\nboot')" PATH="$EXEC_DIR:$PATH" bash "$BOOT" --help >"$A2_OUT" 2>/dev/null
a2_rc=$?
set -e
[ "$a2_rc" = "0" ] \
  || fail "A: --help was refused (rc $a2_rc) because of an unrelated ORCHESTRATOR_SID — help must always be readable"
[ -s "$A2_OUT" ] || fail "A: --help printed nothing under a control-character sid"
assert_no_side_effects "A/ctrl-sid"

# ===========================================================================
# B) THE USAGE IS COMPLETE. Every flag and every env seam the implementation reads is
#    named, plus one line stating that a bare invocation boots and execs — which is
#    the sentence whose absence caused the incident.
#
#    The seam list is not hardcoded prose: it is read back out of the compiled
#    implementation, so a seam added later without a usage line fails here.
# ===========================================================================
USAGE_TXT="$T_TMP/usage.txt"
PATH="$EXEC_DIR:$PATH" bash "$BOOT" --help >"$USAGE_TXT" 2>/dev/null

for flag in --help -h --dry-run; do
  grep -qF -- "$flag" "$USAGE_TXT" || fail "B: usage does not name the flag '$flag': $(cat "$USAGE_TXT")"
done

IMPL="$REPO_ROOT/dist/src/orchestrator-boot/cli.js"
[ -f "$IMPL" ] || fail "B: the compiled implementation is missing at $IMPL (run npx tsc -p .)"
# The seams as the implementation reads them: `env.NAME` / `env["NAME"]`. AIGENTRY_ is
# included — the shim exports AIGENTRY_SHIM_SCRIPT_DIR and an operator debugging a
# symlinked entrypoint needs to know it exists.
SEAMS="$T_TMP/seams.txt"
sed -n 's/.*env\.\([A-Z][A-Z0-9_]*\).*/\1/p' "$IMPL" | sort -u > "$SEAMS"
[ -s "$SEAMS" ] || fail "B: no env seam could be read out of $IMPL — the extraction broke, not the usage"
while read -r seam; do
  grep -qF -- "$seam" "$USAGE_TXT" \
    || fail "B: the implementation reads \$$seam but usage never names it. usage: $(cat "$USAGE_TXT")"
done < "$SEAMS"

# The one line that would have stopped the incident: a bare invocation ACTS.
grep -qiE 'bare invocation|with no (flag|argument)' "$USAGE_TXT" \
  || fail "B: usage never states that a bare invocation boots and execs: $(cat "$USAGE_TXT")"
grep -qiE 'exec' "$USAGE_TXT" || fail "B: usage never mentions the exec: $(cat "$USAGE_TXT")"

# ===========================================================================
# C) --dry-run READS BUT DOES NOT ACT. The reads must happen — a dry run that never
#    lists the processes or the registry cannot report a verdict, and "it did nothing"
#    would then be indistinguishable from "it worked".
# ===========================================================================
reset; loaded_ps_table; stale_listing
C_OUT="$T_TMP/c.out"; C_ERR="$T_TMP/c.err"
set +e
PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run >"$C_OUT" 2>"$C_ERR"
c_rc=$?
set -e
[ "$c_rc" = "0" ] || fail "C: --dry-run must exit 0, got $c_rc; stderr: $(cat "$C_ERR")"
assert_no_side_effects "C"
grep -qx -- '-eo pid,ppid,command' "$PS_ARGV" \
  || fail "C: --dry-run did not run the process scan, so its verdict is not measured: $(cat "$PS_ARGV")"
grep -qx -- 'list --json' "$TELEPTY_ARGV" \
  || fail "C: --dry-run did not read the registry, so its reconcile verdict is not measured: $(cat "$TELEPTY_ARGV")"

# The exec argv is reported, one element per line, PREFIXED so nothing can confuse it
# with the contract channel the shim reads on the boot path.
for a in telepty allow --id "$SID" --auto-restart "${PLAN_TAIL_ARGV[@]}"; do
  grep -qxF -- "[would-exec] $a" "$C_OUT" \
    || fail "C: --dry-run did not report '[would-exec] $a' as its own line: $(cat "$C_OUT")"
done
# A dry run must describe THE PLAN IT WAS GIVEN, not a default it invented. These two
# lines are what makes the report reviewable rather than decorative.
grep -qE 'plan +provider +claude' "$C_OUT" \
  || fail "C: --dry-run did not report the provider its plan named: $(cat "$C_OUT")"
grep -qE 'plan +history +new' "$C_OUT" \
  || fail "C: --dry-run did not report the history mode its plan named: $(cat "$C_OUT")"
grep -qE -- '--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox' "$C_OUT" \
  && fail "C: --dry-run reported a bypass flag for a plan that named none: $(cat "$C_OUT")"

# ===========================================================================
# D) THE DRY RUN AND THE REAL RUN AGREE. Same ps fixture as T131 block V — the
#    operator's own diagnosis session: (i) a real stale bridge, (ii) a `zsh -c pgrep`
#    that merely MENTIONS the marker (D4), (iii) an ancestor bridge (#539). The real
#    run kills exactly 7777; the dry run must NAME exactly 7777 and must SHOW the
#    ancestor skip rather than bypass the guard that produces it.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
3333 2222 bash $BOOT
2222 1111 node claude
1111 1 $BRIDGE
7777 1 $BRIDGE
8888 1 /bin/zsh -c pgrep -fl telepty allow --id $SID --auto-restart claude
EOF

# Actuate through zero-argv compiled boot: same implementation, prints argv without
# exec. Every effect reaches a recorder, including the synthetic auth door.
reset; stale_listing
SINGLETON_SELF_PID=3333 node "$BOOT_CLI" >"$T_TMP/normal.out" 2>"$T_TMP/normal.err"
grep -q -- '-X DELETE' "$CURL_LOG" || fail "D: normal boot did not DELETE the stale fixture"
grep -q 'x-telepty-token: fixture-token-T134' "$CURL_LOG" || fail "D: synthetic auth missing"
grep -q 'fixture-token-T134' "$T_TMP/normal.out" "$T_TMP/normal.err" && fail "D: token leaked"
[ ! -s "$EXEC_LOG" ] || fail "D: compiled CLI exec'd a bridge"
printf '%s\n' telepty allow --id "$SID" --auto-restart "${PLAN_TAIL_ARGV[@]}" \
  > "$T_TMP/normal.expected"
cmp "$T_TMP/normal.expected" "$T_TMP/normal.out" || fail "D: normal boot stdout is not exact argv"
# #1162: exactly one fixed-vocabulary boot-record line on the normal boot (fixture ROOT has no sessions/).
[ "$(grep -c '^\[orchestrator-boot\] boot record: ' "$T_TMP/normal.err")" = "1" ] \
  || fail "D: expected exactly one boot-record line; stderr: $(cat "$T_TMP/normal.err")"
grep -qx '\[orchestrator-boot\] boot record: skipped:unsafe-path relation=none' "$T_TMP/normal.err" \
  || fail "D: boot-record line is not the fixed skipped:unsafe-path record; stderr: $(cat "$T_TMP/normal.err")"
[ ! -e "$BOOT_FIXTURE/home/sessions" ] || fail "D: the boot record created sessions/ under the fixture ROOT"
REAL_KILLS="$T_TMP/real-kills.txt"
sed 's/^-9 //' "$KILL_LOG" | sort -u > "$REAL_KILLS"
[ "$(cat "$REAL_KILLS")" = "7777" ] \
  || fail "D: the real run's kill set is not exactly 7777 (the fixture changed under this guard): $(cat "$REAL_KILLS")"

# Probe inspection uses the identical actionable fixtures, separately from control.
for probe in singleton-guard registry-reconcile exec-argv; do
  reset
  SINGLETON_SELF_PID=3333 PATH="$EXEC_DIR:$PATH" bash "$BOOT" __probe "$probe" \
    >"$T_TMP/probe.out" 2>"$T_TMP/probe.err"
  assert_no_side_effects "D/probe/$probe"
  case "$probe" in
    singleton-guard) grep -q 'would SIGKILL.*pid=7777' "$T_TMP/probe.err" || fail "D: missing probe kill verdict" ;;
    registry-reconcile) grep -q 'would DELETE' "$T_TMP/probe.err" || fail "D: missing probe DELETE verdict" ;;
    exec-argv) cmp "$T_TMP/normal.expected" "$T_TMP/probe.out" || fail "D: probe argv changed" ;;
  esac
done

# The dry run's would-kill set, from its own report.
reset; stale_listing
D_OUT="$T_TMP/d.out"
SINGLETON_SELF_PID=3333 PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run >"$D_OUT" 2>/dev/null
assert_no_side_effects "D"
DRY_KILLS="$T_TMP/dry-kills.txt"
sed -n 's/.*would SIGKILL[^=]*pid=\([0-9][0-9]*\).*/\1/p' "$D_OUT" | sort -u > "$DRY_KILLS"
[ -s "$DRY_KILLS" ] || fail "D: --dry-run named no would-kill pid at all: $(cat "$D_OUT")"
diff -u "$REAL_KILLS" "$DRY_KILLS" \
  || fail "D: the dry run's would-kill set differs from what a real run kills on the SAME fixture. real: $(tr '\n' ' ' < "$REAL_KILLS") dry: $(tr '\n' ' ' < "$DRY_KILLS")"

# The guard is PROVEN, not bypassed: the ancestor is named as a skip, and the operator's
# `pgrep` is named as a non-bridge. Both are the reasons a human runs --dry-run for.
grep -q "skip self/ancestor bridge pid=1111" "$D_OUT" \
  || fail "D: --dry-run did not SHOW the #539 ancestor skip for 1111 — it must prove the guard, not bypass it: $(cat "$D_OUT")"
grep -q "8888" "$D_OUT" \
  || fail "D: --dry-run never mentions 8888, the operator's own pgrep — the D4 near miss is exactly what a dry run is read for: $(cat "$D_OUT")"
grep -qE 'would SIGKILL[^=]*pid=(1111|8888)' "$D_OUT" \
  && fail "D: --dry-run announced it would kill an ancestor or a mere mention of the marker: $(cat "$D_OUT")"

# ===========================================================================
# E) AN UNKNOWN FLAG IS A REFUSAL, NOT A BOOT. This is the arm that did not exist:
#    before this ticket `--bogus-flag` ran the full boot and exited 0.
# ===========================================================================
loaded_ps_table
reset; stale_listing
E_OUT="$T_TMP/e.out"; E_ERR="$T_TMP/e.err"
set +e
PATH="$EXEC_DIR:$PATH" bash "$BOOT" --bogus-flag >"$E_OUT" 2>"$E_ERR"
e_rc=$?
set -e
[ "$e_rc" != "0" ] || fail "E: an unknown flag exited 0 — it must refuse; stdout: $(cat "$E_OUT")"
assert_no_side_effects "E"
grep -qF -- '--bogus-flag' "$E_ERR" \
  || fail "E: the refusal does not name the offending flag on stderr: $(cat "$E_ERR")"
grep -qF -- '--dry-run' "$E_ERR" \
  || fail "E: the refusal did not print usage on stderr: $(cat "$E_ERR")"

# A second token is unknown too, so no mode can be smuggled in behind another.
reset; stale_listing
set +e
PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run --bogus >/dev/null 2>/dev/null
e2_rc=$?
set -e
[ "$e2_rc" != "0" ] || fail "E: '--dry-run --bogus' exited 0 — an unknown token must refuse"
assert_no_side_effects "E/two-tokens"

# ===========================================================================
# F) EARLY-CLOSED STDOUT IS NOT A BOOT. `bin/orchestrator-boot.sh --help | head -2` is
#    the incident's literal command line. The pipe closes under the writer; the only
#    acceptable outcome is that nothing was killed and nothing was exec'd.
# ===========================================================================
for flag in --help --dry-run; do
  reset; loaded_ps_table; stale_listing
  F_OUT="$T_TMP/f.out"
  set +e
  PATH="$EXEC_DIR:$PATH" bash "$BOOT" "$flag" 2>/dev/null | head -2 > "$F_OUT"
  set -e
  assert_no_side_effects "F/$flag"
  [ -s "$F_OUT" ] || fail "F: '$flag | head -2' produced nothing at all"
done

# ===========================================================================
# G) THE ONE LISTING SHAPE THAT AUTHORISES A DELETE, DRY. A STALE record with 0
#    clients is the only arm that acts (#905). --dry-run must reach that verdict,
#    report it, and still send nothing.
# ===========================================================================
reset; loaded_ps_table; stale_listing
G_OUT="$T_TMP/g.out"
PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run >"$G_OUT" 2>/dev/null
[ "$(lines "$CURL_LOG")" = "0" ] \
  || fail "G: --dry-run issued the DELETE it was only supposed to report; calls: $(cat "$CURL_LOG")"
grep -qiE 'would DELETE' "$G_OUT" \
  || fail "G: --dry-run reached the STALE/0-clients arm but never reported the DELETE it would send: $(cat "$G_OUT")"
grep -qF -- "/api/sessions/$SID" "$G_OUT" \
  || fail "G: the reported DELETE does not name the endpoint it would hit: $(cat "$G_OUT")"
# Invariant 4 travels with it: the credential is never printed, dry or not.
grep -q 'x-telepty-token' "$G_OUT" \
  && fail "G: --dry-run printed the credential header: $(cat "$G_OUT")"

# ===========================================================================
# H) THE FOUR PROVIDER FLAG MAPPINGS, each in its OWN spelling. (#1131 -> #1181 v2)
#
#    WHAT THIS BLOCK USED TO BE, and why it could not stay. It drove three rows —
#    ORCHESTRATOR_CLI unset, claude, codex — and asserted:
#
#      unset / claude -> claude --dangerously-skip-permissions --continue
#      codex          -> codex resume --last --dangerously-bypass-approvals-and-sandbox
#
#    All three pin product behaviour that #1181 v2 deliberately removed, and the `unset`
#    row pinned the worst of it: a MISSING provider still booting, into a bypass. Keeping
#    them would be asserting the defect. Deleting them and asserting nothing would be
#    losing the coverage. So the row set is replaced with a stronger one.
#
#    WHAT IT IS NOW. A complete explicit plan per provider, each naming EVERY axis that
#    provider has, at a value chosen from that provider's OWN measured list. The expected
#    argv is written out here literally rather than derived from the implementation, so
#    this block is an independent statement of the mapping and not a restatement of the
#    code:
#
#      claude  ONE axis (--permission-mode). claude 2.1.283's help prints NO --sandbox.
#      codex   TWO axes, different flags entirely (--ask-for-approval, --sandbox).
#      gemini  TWO axes; --approval-mode, and a BOOLEAN sandbox whose 'on' contributes a
#              bare `--sandbox` with no value.
#      grok    TWO axes; --permission-mode spelled IDENTICALLY to claude's, with values
#              that are grok's own, plus --sandbox <PROFILE>.
#
#    The `unset` row survives as a REFUSAL row, which is the behaviour that replaced it.
#    Dry-run stays inert throughout — that is still this file's subject.
# ===========================================================================
h_dry() { # h_dry <label> <expected-tail...> ; reads H_PLAN_ENV[] for the plan
  local label="$1"; shift
  reset; loaded_ps_table; stale_listing
  local out="$T_TMP/h.out"
  (unset AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY ORCHESTRATOR_CLI
   env "${H_PLAN_ENV[@]}" PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run) >"$out" 2>"$T_TMP/h.err" \
    || fail "H/$label: --dry-run exited non-zero for a COMPLETE plan; stderr: $(cat "$T_TMP/h.err")"
  local expected="$T_TMP/h.expected"
  printf '[would-exec] %s\n' telepty allow --id "$SID" --auto-restart >"$expected"
  printf '[would-exec] %s\n' "$@" >>"$expected"
  grep '^\[would-exec\]' "$out" >"$T_TMP/h.actual"
  diff -u "$expected" "$T_TMP/h.actual" || fail "H/$label: argv mismatch"
  assert_no_side_effects "H/$label"
  echo "T134 H/$label PASS"
}

# claude — one axis. A plan may not name a `sandbox` axis it does not have (H.5 below).
H_PLAN_ENV=(AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=manual'
            AIGENTRY_BOOT_HISTORY=new)
h_dry claude claude --permission-mode manual

# codex — two axes, two different flags, and a positional-subcommand history mode.
H_PLAN_ENV=(AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=codex
            AIGENTRY_BOOT_PERMISSION='approval=on-request;sandbox=read-only'
            AIGENTRY_BOOT_HISTORY=new)
h_dry codex codex --ask-for-approval on-request --sandbox read-only

# gemini — the boolean sandbox: `on` contributes a bare `--sandbox`, no value token.
H_PLAN_ENV=(AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=gemini
            AIGENTRY_BOOT_PERMISSION='approval=default;sandbox=on'
            AIGENTRY_BOOT_HISTORY=new)
h_dry gemini gemini --approval-mode default --sandbox

# grok — --permission-mode spelled exactly like claude's, with grok's own value, plus a
# sandbox PROFILE. If these two ever collapsed into one shared enum this row and the
# claude row would stop being distinguishable.
H_PLAN_ENV=(AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=grok
            AIGENTRY_BOOT_PERMISSION='approval=default;sandbox=strict'
            AIGENTRY_BOOT_HISTORY=new)
h_dry grok grok --permission-mode default --sandbox strict

# H.5 — SIMILAR NAMES ARE NOT SHARED POLICY. Each row takes a token that IS valid on some
# other provider's axis and offers it here. Every one must be refused, with the offending
# value named, and nothing may be read or acted on.
h_refuse() { # h_refuse <label> <must-appear-in-stderr> <env assignments...>
  local label="$1" want="$2"; shift 2
  reset; loaded_ps_table; stale_listing
  local rc=0
  (unset AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY ORCHESTRATOR_CLI
   env "$@" PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run) >"$T_TMP/h5.out" 2>"$T_TMP/h5.err" || rc=$?
  [ "$rc" = "2" ] || fail "H.5/$label: must exit 2, got $rc; stderr: $(cat "$T_TMP/h5.err")"
  [ ! -s "$T_TMP/h5.out" ] || fail "H.5/$label: a refusal wrote to stdout: $(cat "$T_TMP/h5.out")"
  grep -qF -- "$want" "$T_TMP/h5.err" \
    || fail "H.5/$label: the refusal never names '$want': $(cat "$T_TMP/h5.err")"
  [ "$(lines "$PS_ARGV")" = "0" ] || fail "H.5/$label: the refusal scanned the process table"
  [ "$(lines "$TELEPTY_ARGV")" = "0" ] || fail "H.5/$label: the refusal read the registry"
  assert_no_side_effects "H.5/$label"
}
# codex's sandbox policy offered to gemini, whose sandbox is a boolean.
h_refuse gemini-takes-codex-sandbox 'workspace-write' \
  AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=gemini \
  AIGENTRY_BOOT_PERMISSION='approval=default;sandbox=workspace-write' AIGENTRY_BOOT_HISTORY=new
# gemini's approval token offered to codex.
h_refuse codex-takes-gemini-approval 'yolo' \
  AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=codex \
  AIGENTRY_BOOT_PERMISSION='approval=yolo;sandbox=read-only' AIGENTRY_BOOT_HISTORY=new
# grok's sandbox profile offered to codex.
h_refuse codex-takes-grok-profile 'devbox' \
  AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=codex \
  AIGENTRY_BOOT_PERMISSION='approval=on-request;sandbox=devbox' AIGENTRY_BOOT_HISTORY=new
# An axis claude does not have. Inventing one for it is how a provider ends up described
# by another's capabilities.
h_refuse claude-has-no-sandbox-axis 'sandbox' \
  AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=claude \
  AIGENTRY_BOOT_PERMISSION='approval=manual;sandbox=read-only' AIGENTRY_BOOT_HISTORY=new
# Effort: claude's measured enum is not evidence for codex, whose effort is a RECORDED
# GAP. Setting it must be refused and the gap NAMED, not silently dropped.
h_refuse codex-effort-is-a-gap 'AIGENTRY_BOOT_EFFORT' \
  AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=codex AIGENTRY_BOOT_EFFORT=high \
  AIGENTRY_BOOT_PERMISSION='approval=on-request;sandbox=read-only' AIGENTRY_BOOT_HISTORY=new
# gemini has no effort flag at all — measured absent, refused for a different reason.
h_refuse gemini-effort-unsupported 'AIGENTRY_BOOT_EFFORT' \
  AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=gemini AIGENTRY_BOOT_EFFORT=high \
  AIGENTRY_BOOT_PERMISSION='approval=default;sandbox=on' AIGENTRY_BOOT_HISTORY=new

# H.6 — THE ROW THAT REPLACED THE OLD `default` ROW. An unset ORCHESTRATOR_CLI used to
# boot claude with a bypass. It must now refuse and say what it would accept.
reset; loaded_ps_table; stale_listing
h6_rc=0
(unset AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY ORCHESTRATOR_CLI
 PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run) >"$T_TMP/h6.out" 2>"$T_TMP/h6.err" || h6_rc=$?
[ "$h6_rc" = "2" ] \
  || fail "H.6: an unset ORCHESTRATOR_CLI must refuse (it used to boot a bypass), got $h6_rc"
[ ! -s "$T_TMP/h6.out" ] || fail "H.6: the refusal wrote to stdout: $(cat "$T_TMP/h6.out")"
grep -qF 'ORCHESTRATOR_CLI' "$T_TMP/h6.err" || fail "H.6: the refusal does not name the field"
for h6_p in claude codex gemini grok; do
  grep -qF "$h6_p" "$T_TMP/h6.err" \
    || fail "H.6: the refusal does not list '$h6_p' among the registered providers: $(cat "$T_TMP/h6.err")"
done
assert_no_side_effects "H.6"
echo "T134 H PASS (four provider mappings, six cross-provider refusals, unset = refusal)"

# I) Invalid selectors refuse before even reading the daemon/process table.
for cli in unknown "$(printf 'codex\nextra')"; do
  reset; loaded_ps_table; stale_listing
  i_rc=0
  ORCHESTRATOR_CLI="$cli" PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run >"$T_TMP/i.out" 2>"$T_TMP/i.err" || i_rc=$?
  [ "$i_rc" = 2 ] || fail "I: invalid CLI must exit 2, got $i_rc"
  [ ! -s "$T_TMP/i.out" ] || fail "I: refusal emitted stdout"
  grep -qF 'ORCHESTRATOR_CLI' "$T_TMP/i.err" || fail "I: missing selector diagnostic"
  grep -qF 'Usage:' "$T_TMP/i.err" || fail "I: missing usage"
  [ "$(lines "$PS_ARGV")" = 0 ] || fail "I: refusal read processes"
  [ "$(lines "$TELEPTY_ARGV")" = 0 ] || fail "I: refusal read registry"
  assert_no_side_effects "I"
done
ORCHESTRATOR_CLI=codex bash "$BOOT" --help >"$T_TMP/cli-help"
grep -qF 'ORCHESTRATOR_CLI' "$T_TMP/cli-help" || fail "I: help omits CLI selector"
grep -qF 'inherits cwd' "$T_TMP/cli-help" || fail "I: help omits cwd contract"
echo "T134 I PASS"

# ===========================================================================
# J) HELP IS READABLE AND INERT UNDER A HOSTILE ENVIRONMENT. (#1181 v2, NEW)
#
#    Block A already proves --help survives a control-character ORCHESTRATOR_SID. #1181
#    added SIX more variables that every other path validates and refuses on, and the
#    documented exemption is "--help is exempt from every env refusal and acts on
#    nothing". That is two claims — READABLE and INERT — and each row below breaks the
#    environment in a different way and asserts both.
#
#    Why this matters more than it looks: --help is what an operator runs AFTER the boot
#    refused them. If the refusal's own advice is unreadable because of the variable that
#    caused the refusal, the advice is unreachable exactly when it is needed.
# ===========================================================================
j_help() { # j_help <label> <env assignments...>
  local label="$1"; shift
  for j_flag in --help -h; do
    reset; loaded_ps_table; stale_listing
    local out="$T_TMP/j.out" err="$T_TMP/j.err" rc=0
    (unset AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY ORCHESTRATOR_CLI
     env "$@" PATH="$EXEC_DIR:$PATH" bash "$BOOT" "$j_flag") >"$out" 2>"$err" || rc=$?
    [ "$rc" = "0" ] \
      || fail "J/$label/$j_flag: help must exit 0 whatever the environment says, got $rc; stderr: $(cat "$err")"
    [ -s "$out" ] || fail "J/$label/$j_flag: help printed nothing on stdout"
    grep -qF 'Usage:' "$out" || fail "J/$label/$j_flag: what was printed is not the usage: $(cat "$out")"
    assert_no_side_effects "J/$label/$j_flag"
    [ "$(lines "$PS_ARGV")" = "0" ] || fail "J/$label/$j_flag: help scanned the process table"
    [ "$(lines "$TELEPTY_ARGV")" = "0" ] || fail "J/$label/$j_flag: help read the registry"
  done
}
# The opt-in itself malformed — the one refusal that fires earliest on every other path.
j_help bad-opt-in AIGENTRY_BOOT_PLAN=true ORCHESTRATOR_CLI=claude
# Plan fields set with NO opt-in: a refusal everywhere else.
j_help fields-without-opt-in AIGENTRY_BOOT_PERMISSION='approval=bypassPermissions' \
  AIGENTRY_BOOT_HISTORY=last ORCHESTRATOR_CLI=claude
# Every plan field junk at once, including an unregistered provider.
j_help all-junk AIGENTRY_BOOT_PLAN=1 ORCHESTRATOR_CLI=not-a-provider \
  AIGENTRY_BOOT_MODEL='--sandbox' AIGENTRY_BOOT_EFFORT='!!' \
  AIGENTRY_BOOT_PERMISSION='approval=nope;;=' AIGENTRY_BOOT_HISTORY='selected=../../etc/passwd' \
  AIGENTRY_BOOT_RISK_ACK='I ACCEPT EVERYTHING'
# A control character in the sid AND a malformed opt-in together: block A covers the sid
# alone, and the two refusals are checked at different points in the file.
j_help ctrl-sid-and-bad-opt-in AIGENTRY_BOOT_PLAN=nope \
  ORCHESTRATOR_SID="$(printf 'orch\tboot')" ORCHESTRATOR_CLI=claude
# The usage help prints must actually document the new schema, or the exemption is
# preserving a text that no longer helps. Every #1181 field, by name.
reset
J_TXT="$T_TMP/j-usage.txt"
PATH="$EXEC_DIR:$PATH" bash "$BOOT" --help >"$J_TXT" 2>/dev/null
for j_field in AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_MODEL AIGENTRY_BOOT_EFFORT \
               AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY AIGENTRY_BOOT_RISK_ACK \
               --wizard-plan; do
  grep -qF -- "$j_field" "$J_TXT" \
    || fail "J: usage never names '$j_field', which every non-TTY caller now has to set"
done
for j_p in claude codex gemini grok; do
  grep -qF "$j_p" "$J_TXT" || fail "J: usage does not name the registered provider '$j_p'"
done
echo "T134 J PASS (help readable and inert under a hostile environment)"

echo "T134 PASS blocks=A-J inspection=read-only normal-control=recorded-kill-and-DELETE execs=0"
