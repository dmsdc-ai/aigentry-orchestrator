#!/usr/bin/env bash
# T40 — bin/orchestrator-boot.sh singleton guard (#539).
# HERMETIC: the guard is driven through `__probe` (main is NEVER reached, so nothing
# is ever exec'd) with a STUBBED process lister (SINGLETON_PS_CMD → fixture table), a
# STUBBED killer (KILL_CMD → call recorder) and an overridable SINGLETON_SELF_PID.
# NO real process is ever listed or killed. Asserts:
#   A) two bridges (one self-ancestor + one stale) → ONLY the non-self one is
#      kill -9'd; ancestor bridge (grandparent) survives (kill-self belt).
#   B) zero bridges → no-op.
#   C) one bridge == self → no-op.
#   D) ORCH_SID configurable (ORCHESTRATOR_SID) → only the matching sid killed.
#   E) signal is ALWAYS -9, NEVER -TERM/-15.
#
# #899 tranche 5 — this file used to `source` bin/orchestrator-boot.sh and call
# orchestrator_singleton_guard / orchestrator_registry_reconcile as bash functions and
# read ORCH_EXEC_ARGV as a bash array. That script is a shim onto
# src/orchestrator-boot/cli.ts now and an exec shim exports no shell functions, so the
# same behaviours are reached through the `__probe` subcommands built for exactly this
# (`singleton-guard`, `registry-reconcile`, `exec-argv` — the T52 shape from tranche
# 2a). Same seams, same fixtures, same assertions, now measuring the code production
# actually runs. The shim routes `__probe` straight to node, so no probe can reach the
# exec.
#
# #905 — the guard above kills PROCESSES; it never reconciled the daemon's REGISTRY
# record, and on 2026-08-16 that made an orchestrator restart structurally impossible:
# the record survived its dead bridge holding that bridge's owner token (telepty #815),
# so every `telepty allow --id orchestrator` was refused the owner claim. F–K cover the
# pre-exec reconcile, and L the exec argv. Every registry interaction goes through a
# recorder seam — NO real DELETE is ever issued, against :3848 or anything else:
#   F) STALE + 0 clients          → DELETE issued for the right sid, with a credential.
#   G) CONNECTED                  → no DELETE (that is a live orchestrator).
#   H) DISCONNECTED (not STALE)   → no DELETE (may be mid-reconnect), announced.
#   I) no record                  → no DELETE, nothing to reconcile.
#   J) daemon unreachable         → announced, no DELETE, boot still proceeds.
#   K) STALE but clients > 0      → no DELETE (someone is attached).
#   L) exec argv carries --auto-restart, before the command word.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BOOT="$REPO_ROOT/bin/orchestrator-boot.sh"

fail() { echo "FAIL[T40]: $*" >&2; exit 1; }

# --- stub: process lister. Ignores args, prints the fixture table file. --------
PS_TABLE="$T_TMP/ps-table.txt"
PS_STUB="$STUB_BIN/ps-stub.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
cat "$PS_TABLE"
EOF
chmod +x "$PS_STUB"

# --- stub: kill recorder. Appends args, exits 0 (simulates successful kill). ---
KILL_LOG="$T_TMP/kill-calls.log"
KILL_STUB="$STUB_BIN/kill-stub.sh"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$KILL_STUB"

# ORCH_SID / SINGLETON_SELF_PID are set by each block below and read from the env by
# the probe, where the sourced script used to read them from this shell.
ORCH_SID="orchestrator"
SINGLETON_SELF_PID="9999"
run_guard() {
  : > "$KILL_LOG"
  ORCHESTRATOR_SID="$ORCH_SID" SINGLETON_SELF_PID="$SINGLETON_SELF_PID" \
    SINGLETON_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB" \
    "$BOOT" __probe singleton-guard >/dev/null 2>&1
}

B="node telepty allow --id orchestrator claude --dangerously-skip-permissions --continue"

# ===========================================================================
# A) two bridges: 1111 is a SELF ANCESTOR (grandparent), 4444 is STALE.
#    ancestry(3333) = 3333→2222→1111. Only 4444 must be SIGKILLed.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
3333 2222 bash $BOOT
2222 1111 node claude
1111 1 $B
4444 1 $B
5555 1 node some-unrelated-daemon
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="3333"
run_guard
grep -qw 4444 "$KILL_LOG" || fail "A: stale bridge 4444 not killed; log: $(cat "$KILL_LOG")"
grep -qw 1111 "$KILL_LOG" && fail "A: self-ANCESTOR bridge 1111 was killed (kill-self belt broken!)"
grep -qw 5555 "$KILL_LOG" && fail "A: unrelated process 5555 killed (over-match)"
grep -q -- '-9' "$KILL_LOG" || fail "A: signal not -9; log: $(cat "$KILL_LOG")"
[ "$(grep -c . "$KILL_LOG")" = "1" ] || fail "A: expected exactly 1 kill; log: $(cat "$KILL_LOG")"

# ===========================================================================
# B) zero bridges → no kill.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
9999 1 bash
8888 1 node unrelated
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="9999"
run_guard
[ -s "$KILL_LOG" ] && fail "B: kill invoked with zero bridges; log: $(cat "$KILL_LOG")"

# ===========================================================================
# C) one bridge == self → no kill.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
1111 1 $B
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="1111"
run_guard
[ -s "$KILL_LOG" ] && fail "C: self bridge killed (must no-op); log: $(cat "$KILL_LOG")"

# ===========================================================================
# D) configurable sid: ORCH_SID=custom-orch → kill ONLY the custom-orch bridge,
#    leave the default 'orchestrator' bridge untouched (Rule 16).
# ===========================================================================
cat > "$PS_TABLE" <<EOF
4444 1 node telepty allow --id custom-orch claude --continue
5555 1 node telepty allow --id orchestrator claude --continue
EOF
ORCH_SID="custom-orch"; SINGLETON_SELF_PID="9999"
run_guard
grep -qw 4444 "$KILL_LOG" || fail "D: custom-orch bridge 4444 not killed; log: $(cat "$KILL_LOG")"
grep -qw 5555 "$KILL_LOG" && fail "D: non-matching sid bridge 5555 killed (sid match too loose)"

# ===========================================================================
# E) signal is ALWAYS -9, NEVER -TERM/-15 (re-run A and inspect every call).
# ===========================================================================
cat > "$PS_TABLE" <<EOF
4444 1 $B
EOF
ORCH_SID="orchestrator"; SINGLETON_SELF_PID="9999"
run_guard
grep -qE -- '-TERM|-15|-SIGTERM' "$KILL_LOG" && fail "E: SIGTERM used (cascades DELETE!); log: $(cat "$KILL_LOG")"
grep -q -- '-9' "$KILL_LOG" || fail "E: SIGKILL (-9) not used; log: $(cat "$KILL_LOG")"

# ===========================================================================
# #905 — pre-exec registry reconcile. Seams: TELEPTY (the listing query) and
# CURL (the DELETE). Both are recorders; nothing real is contacted.
# ===========================================================================
LIST_JSON="$T_TMP/list.json"
LIST_MODE="$T_TMP/list-mode.txt"       # ok | fail | garbage
CURL_LOG="$T_TMP/curl-calls.log"
CURL_CODE="$T_TMP/curl-code.txt"

TELEPTY_STUB="$STUB_BIN/telepty-list-stub.sh"
cat > "$TELEPTY_STUB" <<EOF
#!/usr/bin/env bash
mode="\$(cat "$LIST_MODE" 2>/dev/null || echo ok)"
case "\$mode" in
  fail)    exit 7 ;;                       # daemon unreachable / CLI error
  garbage) printf 'not json at all' ;;     # version mismatch shape
  *)       cat "$LIST_JSON" ;;
esac
exit 0
EOF
chmod +x "$TELEPTY_STUB"

# Records the full argv, prints the http code the case under test wants. Mirrors
# `curl -s -o /dev/null -w '%{http_code}'`, which prints ONLY the code on stdout.
CURL_STUB="$STUB_BIN/curl-recorder.sh"
cat > "$CURL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
printf '%s' "\$(cat "$CURL_CODE" 2>/dev/null || echo 200)"
exit 0
EOF
chmod +x "$CURL_STUB"

# rec <health> <clients> — one orchestrator record with the daemon's real field
# names (daemon.js:2205-2214 — healthStatus + active_clients; cli.js:1334 prints
# exactly this pair as "<STATUS> ... - Clients: <n>").
rec() { printf '[{"id":"orchestrator","command":"claude","healthStatus":"%s","active_clients":%s}]' "$1" "$2"; }

reconcile() {
  ORCHESTRATOR_SID="orchestrator" TELEPTY="$TELEPTY_STUB" CURL="$CURL_STUB" \
    "$BOOT" __probe registry-reconcile >/dev/null 2>&1
}

run_reconcile() {
  : > "$CURL_LOG"
  printf 'ok'  > "$LIST_MODE"
  printf '200' > "$CURL_CODE"
  reconcile
}

# --- F) STALE + 0 clients → DELETE ----------------------------------------------
rec STALE 0 > "$LIST_JSON"
run_reconcile
grep -q -- '-X DELETE' "$CURL_LOG" \
  || fail "F: no DELETE issued for a STALE 0-client record; calls: $(cat "$CURL_LOG")"
grep -q '/api/sessions/orchestrator' "$CURL_LOG" \
  || fail "F: DELETE did not target /api/sessions/orchestrator; calls: $(cat "$CURL_LOG")"
grep -q 'x-telepty-token:' "$CURL_LOG" \
  || fail "F: DELETE carried no credential header (the daemon would 401 and the record would STAY); calls: $(cat "$CURL_LOG")"
grep -q '127.0.0.1' "$CURL_LOG" \
  || fail "F: DELETE was not addressed to loopback; calls: $(cat "$CURL_LOG")"

# --- G) CONNECTED → no DELETE ---------------------------------------------------
rec CONNECTED 1 > "$LIST_JSON"
run_reconcile
[ -s "$CURL_LOG" ] && fail "G: DELETE issued against a LIVE orchestrator; calls: $(cat "$CURL_LOG")"

# --- H) DISCONNECTED but not yet STALE → no DELETE ------------------------------
# A bridge that dropped seconds ago may be mid-reconnect (cli.js scheduleReconnect);
# deleting it would race a session that is about to come back.
rec DISCONNECTED 0 > "$LIST_JSON"
run_reconcile
[ -s "$CURL_LOG" ] && fail "H: DELETE issued for DISCONNECTED (not STALE) — races a reconnecting bridge; calls: $(cat "$CURL_LOG")"

# --- I) no record for this sid → nothing to reconcile ---------------------------
printf '[{"id":"some-worker","command":"claude","healthStatus":"CONNECTED","active_clients":1}]' > "$LIST_JSON"
run_reconcile
[ -s "$CURL_LOG" ] && fail "I: DELETE issued with no orchestrator record present; calls: $(cat "$CURL_LOG")"

# --- J) daemon unreachable → announced, no DELETE, boot proceeds ----------------
: > "$CURL_LOG"; printf 'fail' > "$LIST_MODE"
reconcile \
  || fail "J: reconcile returned non-zero when the daemon was unreachable — that would block the boot it exists to enable"
[ -s "$CURL_LOG" ] && fail "J: DELETE issued despite no answer from the daemon; calls: $(cat "$CURL_LOG")"

# A non-JSON answer is the same class of unknown and must not authorise a delete.
: > "$CURL_LOG"; printf 'garbage' > "$LIST_MODE"
reconcile || fail "J: reconcile returned non-zero on a non-JSON listing"
[ -s "$CURL_LOG" ] && fail "J: DELETE issued on an unparseable listing; calls: $(cat "$CURL_LOG")"

# --- K) STALE but someone is attached → no DELETE -------------------------------
rec STALE 2 > "$LIST_JSON"
run_reconcile
[ -s "$CURL_LOG" ] && fail "K: DELETE issued while clients were attached; calls: $(cat "$CURL_LOG")"

# An absent client count is an UNKNOWN, and unknown must never authorise a delete.
printf '[{"id":"orchestrator","command":"claude","healthStatus":"STALE"}]' > "$LIST_JSON"
run_reconcile
[ -s "$CURL_LOG" ] && fail "K: DELETE issued when the client count was absent (unknown ≠ zero); calls: $(cat "$CURL_LOG")"

# --- L) the exec argv carries --auto-restart, before the command word -----------
# Measured in cli.js: --auto-restart is extracted by indexOf over the args AFTER
# `allow`, then spliced out before `command = allowArgs[0]` (cli.js:1837-1846) — so
# it has to sit ahead of the command, exactly where the workers carry it. The array
# `__probe exec-argv` prints one element per line is the SAME array the shim execs.
ARGV_OUT="$T_TMP/exec-argv.txt"
"$BOOT" __probe exec-argv > "$ARGV_OUT" 2>/dev/null \
  || fail "L: __probe exec-argv exited non-zero"
ORCH_EXEC_ARGV=()
while IFS= read -r a; do ORCH_EXEC_ARGV+=("$a"); done < "$ARGV_OUT"
argv="${ORCH_EXEC_ARGV[*]}"
case "$argv" in
  *--auto-restart*) ;;
  *) fail "L: exec argv has no --auto-restart: $argv" ;;
esac
flag_pos=-1; cmd_pos=-1; i=0
for a in "${ORCH_EXEC_ARGV[@]}"; do
  [ "$a" = "--auto-restart" ] && flag_pos=$i
  [ "$a" = "claude" ] && [ "$cmd_pos" -lt 0 ] && cmd_pos=$i
  i=$((i + 1))
done
[ "$flag_pos" -ge 0 ] && [ "$cmd_pos" -gt "$flag_pos" ] \
  || fail "L: --auto-restart must precede the command word; argv: $argv"

echo "T40 PASS"
