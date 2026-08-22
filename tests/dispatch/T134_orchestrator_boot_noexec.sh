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
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BOOT="${ORCH_BOOT_UNDER_TEST:-$REPO_ROOT/bin/orchestrator-boot.sh}"

fail() { echo "FAIL[T134]: $*" >&2; exit 1; }

SID="orchestrator"

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

BRIDGE="node /Users/x/.nvm/versions/node/v20.20.0/bin/telepty allow --id $SID --auto-restart claude --dangerously-skip-permissions --continue"

reset() { : > "$KILL_LOG"; : > "$CURL_LOG"; : > "$PS_ARGV"; : > "$TELEPTY_ARGV"; : > "$EXEC_LOG"; }
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
for a in telepty allow --id "$SID" --auto-restart claude --dangerously-skip-permissions --continue; do
  grep -qxF -- "[would-exec] $a" "$C_OUT" \
    || fail "C: --dry-run did not report '[would-exec] $a' as its own line: $(cat "$C_OUT")"
done

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

# The real kill set, through the probe (which is the code the boot path runs).
reset
SINGLETON_SELF_PID=3333 "$BOOT" __probe singleton-guard >/dev/null 2>&1
REAL_KILLS="$T_TMP/real-kills.txt"
sed 's/^-9 //' "$KILL_LOG" | sort -u > "$REAL_KILLS"
[ "$(cat "$REAL_KILLS")" = "7777" ] \
  || fail "D: the real run's kill set is not exactly 7777 (the fixture changed under this guard): $(cat "$REAL_KILLS")"

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

echo "T134 PASS blocks=A-G modes=--help/-h/--dry-run/unknown kills=0 deletes=0 execs=0"
