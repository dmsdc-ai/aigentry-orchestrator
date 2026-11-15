#!/usr/bin/env bash
# T40 — bin/orchestrator-boot.sh: the former singleton guard (#539) and registry reconcile (#905),
# migrated to the task-1270 create-only boot.
#
# HISTORY. Until task 1270 this file asserted a SIGKILL guard (kill every stale `telepty allow --id
# <sid>` except self and ancestors, -9 never -15) and a pre-exec DELETE of a STALE/0-client registry
# record. Task 1270 REMOVED both: the boot no longer lists processes or sessions, signals anything or
# deletes anything. It asks a bounded, exact-local PREFLIGHT instead —
#   `telepty boot-capabilities` (exact sealed JSON) → curl GET /api/meta (wrapped-sessions +
#   register-create-only) → curl GET /api/sessions/<sid>
# — and only a 404 (FRESH) emits `telepty allow-create-v1 --id <sid> --auto-restart <tail>`. Every
# other verdict exits 3 with an EMPTY stdout and acts on nothing.
#
# WHAT IS KEPT. Every adversarial input the old blocks used — the ancestor bridge, the stale bridge, an
# unrelated process, the self bridge, a second sid, every registry health shape, an unreachable or
# garbage daemon — is still fed to the REAL compiled boot through the SAME recorder seams, and the
# assertion is now the opposite one: ZERO ps, ZERO kill, ZERO `telepty list`, ZERO DELETE. The old
# positive expectations (kill 4444, DELETE the STALE record) are the removed behaviour; each block
# states its new causal expectation next to the old one.
#
# HERMETIC: actuation is the unchanged compiled CLI with zero argv (prints argv, never execs a bridge).
# ps/kill/`telepty list`/curl are recorders; `telepty boot-capabilities` is answered by a private stub
# prepended to PATH (the lib.sh `stubs/telepty` is not relied on); the auth door is synthetic. No real
# process is listed or signalled and no real daemon is contacted.
#
# #1181 — the boot needs a complete explicit plan (claude, approval=manual, history=new); N0 pins the
# refusal without one. The `ps` rows still spell old bypass argv on purpose: they describe bridges an
# earlier boot left running.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
BOOT_CLI="$REPO_ROOT/dist/src/orchestrator-boot/cli.js"
# Only the compiled CLI is invoked; its auth door and workspace are synthetic.
BOOT_FIXTURE="$T_TMP/boot-fixture"
mkdir -p "$BOOT_FIXTURE/bin/lib" "$BOOT_FIXTURE/home"
AUTH_LOG="$T_TMP/auth.log"
printf 'telepty_auth_token() { printf "auth\\n" >> "%s"; printf "fixture-token-T40"; }\n' "$AUTH_LOG" \
  > "$BOOT_FIXTURE/bin/lib/telepty-auth.sh"
export AIGENTRY_SHIM_SCRIPT_DIR="$BOOT_FIXTURE/bin" AIGENTRY_HOME="$BOOT_FIXTURE/home"
export ORCHESTRATOR_CLI=claude ORCHESTRATOR_SID=orchestrator TELEPTY_PORT=3848
unset TELEPTY_HOST
# The complete, benign, explicit plan (#1181; see header). ORCHESTRATOR_SID is set per call.
export AIGENTRY_BOOT_PLAN=1 AIGENTRY_BOOT_PERMISSION='approval=manual' AIGENTRY_BOOT_HISTORY=new
# #1201: this file pins argv. The handoff step is T135's subject: it is switched off here, and
# HOME is a scratch dir with every store override unset, so the operator's real transcript
# stores (~/.claude, ~/.codex, ~/.gemini, ~/.grok) are never scanned whatever the switch does.
export AIGENTRY_HANDOFF=off HOME="$T_TMP/scratch-home"
mkdir -p "$HOME"
unset CLAUDE_CONFIG_DIR CODEX_HOME GEMINI_CLI_HOME CLAUDE_CODE_SESSION_ID
# plan_argv <sid> — the exact exec argv a FRESH boot of that plan produces, one element per line.
plan_argv() { printf '%s\n' telepty allow-create-v1 --id "$1" --auto-restart claude --permission-mode manual; }
cd "$BOOT_FIXTURE"

fail() { echo "FAIL[T40]: $*" >&2; exit 1; }

# --- tripwires: the removed guard's and reconcile's seams. All must stay EMPTY. ---------------
PS_TABLE="$T_TMP/ps-table.txt"
PS_LOG="$T_TMP/ps-calls.log"
PS_STUB="$STUB_BIN/ps-stub.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PS_LOG"
cat "$PS_TABLE"
EOF
chmod +x "$PS_STUB"

KILL_LOG="$T_TMP/kill-calls.log"
KILL_STUB="$STUB_BIN/kill-stub.sh"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$KILL_STUB"

LIST_JSON="$T_TMP/list.json"
LIST_MODE="$T_TMP/list-mode.txt"       # ok | fail | garbage
LIST_LOG="$T_TMP/list-calls.log"
TELEPTY_STUB="$STUB_BIN/telepty-list-stub.sh"
cat > "$TELEPTY_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LIST_LOG"
mode="\$(cat "$LIST_MODE" 2>/dev/null || echo ok)"
case "\$mode" in
  fail)    exit 7 ;;
  garbage) printf 'not json at all' ;;
  *)       cat "$LIST_JSON" ;;
esac
exit 0
EOF
chmod +x "$TELEPTY_STUB"
export SINGLETON_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB" TELEPTY="$TELEPTY_STUB"

# --- the preflight's two seams --------------------------------------------------------------
# (1) `telepty boot-capabilities`, resolved by bash from PATH: a private stub prepended to PATH answers
#     EXACTLY that argv (sealed line, or CAPS_TEXT); any other argv is a tripwire.
CAPS_DIR="$T_TMP/caps-path"; mkdir -p "$CAPS_DIR"
CAPS_LOG="$T_TMP/caps-calls.log"; CAPS_TRIP="$T_TMP/caps-tripwire.log"; CAPS_TEXT="$T_TMP/caps.txt"
SEALED_CAPS='{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"],"viewer_detach":"nondeleting-v1"}'
cat > "$CAPS_DIR/telepty" <<EOF
#!/usr/bin/env bash
if [ "\$#" = 1 ] && [ "\$1" = boot-capabilities ]; then
  printf 'boot-capabilities\n' >> "$CAPS_LOG"
  cat "$CAPS_TEXT"
  exit 0
fi
printf '%s\n' "\$*" >> "$CAPS_TRIP"
exit 97
EOF
chmod +x "$CAPS_DIR/telepty"
export PATH="$CAPS_DIR:$PATH"
# (2) the CURL seam: records the full argv (the existing practice: the only token in it is the synthetic
#     fixture token), and answers the preflight's GETs by route as `<body>\n<code>` (curl -w '\n%{http_code}').
CURL_LOG="$T_TMP/curl-calls.log"
META_CODE="$T_TMP/meta-code"; META_BODY="$T_TMP/meta-body"
SESSION_CODE="$T_TMP/session-code"; SESSION_BODY="$T_TMP/session-body"; CURL_EXIT="$T_TMP/curl-exit"
CURL_STUB="$STUB_BIN/curl-recorder.sh"
cat > "$CURL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
rc="\$(cat "$CURL_EXIT" 2>/dev/null || echo 0)"
if [ "\$rc" != 0 ]; then printf '\n000'; exit "\$rc"; fi
for a in "\$@"; do u="\$a"; done
case "\$u" in
  */api/meta)       cat "$META_BODY"; printf '\n%s' "\$(cat "$META_CODE")" ;;
  */api/sessions/*) cat "$SESSION_BODY"; printf '\n%s' "\$(cat "$SESSION_CODE")" ;;
  *)                printf '\n000'; exit 7 ;;
esac
exit 0
EOF
chmod +x "$CURL_STUB"
export CURL="$CURL_STUB"

# daemon_fresh — a current daemon (both capabilities) holding NO session with the sid: the FRESH answer.
daemon_fresh() {
  printf '%s\n' "$SEALED_CAPS" > "$CAPS_TEXT"
  printf '200' > "$META_CODE"
  printf '{"capabilities":["sessions","wrapped-sessions","register-create-only"]}' > "$META_BODY"
  printf '404' > "$SESSION_CODE"
  printf '{"error":"Session not found"}' > "$SESSION_BODY"
  printf '0' > "$CURL_EXIT"
}
# session_answer <code> <body> — the exact-sid lookup's answer.
session_answer() { printf '%s' "$1" > "$SESSION_CODE"; printf '%s' "$2" > "$SESSION_BODY"; }
reset() { : > "$PS_LOG"; : > "$KILL_LOG"; : > "$LIST_LOG"; : > "$CURL_LOG"; : > "$AUTH_LOG"; : > "$CAPS_LOG"; : > "$CAPS_TRIP"; daemon_fresh; printf 'ok' > "$LIST_MODE"; }

# boot <sid> — one real compiled boot; sets BOOT_RC. Output in $T_TMP/boot.out / boot.err.
boot() {
  set +e
  ORCHESTRATOR_SID="$1" SINGLETON_SELF_PID="${SELF_PID:-9999}" node "$BOOT_CLI" >"$T_TMP/boot.out" 2>"$T_TMP/boot.err"
  BOOT_RC=$?
  set -e
}
# no_destructive_effect <label> — the removed guard and reconcile never ran, whatever the fixture.
no_destructive_effect() {
  [ ! -s "$PS_LOG" ] || fail "$1: the process table was listed (the removed guard ran): $(cat "$PS_LOG")"
  [ ! -s "$KILL_LOG" ] || fail "$1: a kill was issued: $(cat "$KILL_LOG")"
  [ ! -s "$LIST_LOG" ] || fail "$1: the registry was listed (the removed reconcile ran): $(cat "$LIST_LOG")"
  grep -q -- '-X DELETE' "$CURL_LOG" && fail "$1: a DELETE was issued: $(cat "$CURL_LOG")"
  [ ! -s "$CAPS_TRIP" ] || fail "$1: telepty was run with an argv other than boot-capabilities: $(cat "$CAPS_TRIP")"
  grep -q 'fixture-token-T40' "$T_TMP/boot.out" "$T_TMP/boot.err" && fail "$1: the token leaked into output"
  return 0
}
# fresh_boot <label> <sid> — FRESH: exit 0, stdout exactly the create-only argv, exactly the preflight.
fresh_boot() {
  [ "$BOOT_RC" = "0" ] || fail "$1: a FRESH boot exited $BOOT_RC: $(cat "$T_TMP/boot.err")"
  plan_argv "$2" | cmp - "$T_TMP/boot.out" || fail "$1: stdout is not the exact create-only argv: $(cat "$T_TMP/boot.out")"
  [ "$(grep -c . "$CAPS_LOG")" = "1" ] || fail "$1: expected exactly one boot-capabilities probe: $(cat "$CAPS_LOG")"
  [ "$(grep -c '/api/meta' "$CURL_LOG")" = "1" ] || fail "$1: expected exactly one GET /api/meta: $(cat "$CURL_LOG")"
  [ "$(grep -c "/api/sessions/$2\$" "$CURL_LOG")" = "1" ] || fail "$1: expected exactly one GET /api/sessions/$2: $(cat "$CURL_LOG")"
  grep -q "boot preflight FRESH — no session '$2'" "$T_TMP/boot.err" || fail "$1: no FRESH verdict line: $(cat "$T_TMP/boot.err")"
  no_destructive_effect "$1"
}
# refused_boot <label> <verdict> — every non-FRESH verdict: exit 3, EMPTY stdout, verdict named, no effect.
refused_boot() {
  [ "$BOOT_RC" = "3" ] || fail "$1: expected exit 3 ($2), got $BOOT_RC: $(cat "$T_TMP/boot.err")"
  [ ! -s "$T_TMP/boot.out" ] || fail "$1: a refused preflight wrote to the exec-argv channel: $(cat "$T_TMP/boot.out")"
  grep -q "boot preflight $2 for " "$T_TMP/boot.err" || fail "$1: the verdict $2 is not named: $(cat "$T_TMP/boot.err")"
  grep -q "Nothing was created, attached, signalled, deleted or exec'd." "$T_TMP/boot.err" || fail "$1: no zero-effect statement"
  no_destructive_effect "$1"
}

B="node telepty allow --id orchestrator claude --dangerously-skip-permissions --continue"

# ===========================================================================
# N0) no plan → refused BEFORE any effect (#1181). The fixture is actionable (a stale
#     bridge row) and every seam is one recorder, so a refusal that leaked past the gate
#     would show up as a list, ps, kill, DELETE, credential read or capability probe.
# ===========================================================================
NP_LOG="$T_TMP/no-plan-effects.log"
NP_REC="$STUB_BIN/no-plan-recorder.sh"
cat > "$NP_REC" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$NP_LOG"
exit 97
EOF
chmod +x "$NP_REC"
printf '4444 1 %s\n' "$B" > "$PS_TABLE"
reset; : > "$NP_LOG"
set +e
(unset AIGENTRY_BOOT_PLAN AIGENTRY_BOOT_PERMISSION AIGENTRY_BOOT_HISTORY
 SINGLETON_SELF_PID=9999 SINGLETON_PS_CMD="$NP_REC" KILL_CMD="$NP_REC" TELEPTY="$NP_REC" \
   CURL="$NP_REC" node "$BOOT_CLI" >"$T_TMP/np.out" 2>"$T_TMP/np.err") </dev/null
np_rc=$?
set -e
[ "$np_rc" = "2" ] || fail "N0: a no-plan boot must exit 2, got $np_rc: $(cat "$T_TMP/np.err")"
[ ! -s "$T_TMP/np.out" ] || fail "N0: the refusal wrote to the exec-argv channel: $(cat "$T_TMP/np.out")"
[ ! -s "$NP_LOG" ] || fail "N0: the refusal listed, scanned, signalled, DELETEd or probed: $(cat "$NP_LOG")"
[ ! -s "$KILL_LOG" ] || fail "N0: the refusal reached the kill recorder: $(cat "$KILL_LOG")"
[ ! -s "$AUTH_LOG" ] || fail "N0: the refusal resolved a credential"
[ ! -s "$CAPS_LOG" ] || fail "N0: the refusal ran the capability probe"
grep -qF 'AIGENTRY_BOOT_PLAN' "$T_TMP/np.err" || fail "N0: the refusal does not name the opt-in"

# ===========================================================================
# A) WAS: two bridges (1111 a self ANCESTOR, 4444 stale) → only 4444 SIGKILLed.
#    NOW: the same table, armed — the boot never reads it, kills nothing, and boots FRESH.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
3333 2222 node $BOOT_CLI
2222 1111 node claude
1111 1 $B
4444 1 $B
5555 1 node some-unrelated-daemon
EOF
reset; SELF_PID=3333 boot orchestrator
fresh_boot A orchestrator

# ===========================================================================
# B) WAS: zero bridges → no kill.  C) WAS: one bridge == self → no kill.  NOW: the same, and FRESH.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
9999 1 bash
8888 1 node unrelated
EOF
reset; SELF_PID=9999 boot orchestrator
fresh_boot B orchestrator

cat > "$PS_TABLE" <<EOF
1111 1 $B
EOF
reset; SELF_PID=1111 boot orchestrator
fresh_boot C orchestrator

# ===========================================================================
# D) WAS: ORCHESTRATOR_SID=custom-orch → kill ONLY the custom-orch bridge (Rule 16).
#    NOW: the selected sid is the ONE that is looked up and booted; nothing is killed for either.
# ===========================================================================
cat > "$PS_TABLE" <<EOF
4444 1 node telepty allow --id custom-orch claude --continue
5555 1 node telepty allow --id orchestrator claude --continue
EOF
reset; boot custom-orch
fresh_boot D custom-orch
grep -q '/api/sessions/orchestrator$' "$CURL_LOG" && fail "D: the default sid was looked up instead of the selected one: $(cat "$CURL_LOG")"

# ===========================================================================
# E) WAS: the signal is ALWAYS -9, NEVER -TERM/-15. NOW: no signal of any kind is sent (stronger).
# ===========================================================================
cat > "$PS_TABLE" <<EOF
4444 1 $B
EOF
reset; boot orchestrator
fresh_boot E orchestrator
[ ! -s "$KILL_LOG" ] || fail "E: a signal was sent: $(cat "$KILL_LOG")"

# ===========================================================================
# #905 cases, migrated. WAS: the STALE/0-client record was DELETEd before the exec. NOW: the registry
# listing is never read; the EXACT session lookup decides. A session that exists — whatever its health
# or client count — is EXISTS_IDENTITY_UNPROVEN: exit 3, empty stdout, NOT deleted, attached or replaced.
# ===========================================================================
rec() { printf '[{"id":"orchestrator","command":"claude","healthStatus":"%s","active_clients":%s}]' "$1" "$2"; }
EXISTING='{"id":"orchestrator","type":"wrapped","alias":null,"active_clients":0}'
: > "$PS_TABLE"

# --- F) WAS: STALE + 0 clients → DELETE with a credential. NOW: exists → refused, no DELETE. ---
rec STALE 0 > "$LIST_JSON"
reset; session_answer 200 "$EXISTING"; boot orchestrator
refused_boot F EXISTS_IDENTITY_UNPROVEN
# The credential still travels — on the two GETs, as the curl header argument — and is never printed.
[ "$(grep -c 'x-telepty-token: fixture-token-T40' "$CURL_LOG")" = "2" ] \
  || fail "F: the preflight GETs did not both carry the synthetic credential header: $(cat "$CURL_LOG")"
grep -q '127.0.0.1:3848' "$CURL_LOG" || fail "F: the preflight was not addressed to loopback: $(cat "$CURL_LOG")"

# --- G) CONNECTED / H) DISCONNECTED / K) STALE + clients, and an absent count: all → exists → refused. ---
for shape in "CONNECTED 1" "DISCONNECTED 0" "STALE 2"; do
  # shellcheck disable=SC2086
  rec $shape > "$LIST_JSON"
  reset; session_answer 200 "$EXISTING"; boot orchestrator
  refused_boot "G/H/K($shape)" EXISTS_IDENTITY_UNPROVEN
done
printf '[{"id":"orchestrator","command":"claude","healthStatus":"STALE"}]' > "$LIST_JSON"
reset; session_answer 200 "$EXISTING"; boot orchestrator
refused_boot "K(no count)" EXISTS_IDENTITY_UNPROVEN

# --- I) WAS: no record → nothing to reconcile. NOW: 404 → FRESH: the only answer that boots. ---
printf '[{"id":"some-worker","command":"claude","healthStatus":"CONNECTED","active_clients":1}]' > "$LIST_JSON"
reset; boot orchestrator
fresh_boot I orchestrator
cp "$T_TMP/boot.out" "$T_TMP/fresh-boot.out"

# --- J) WAS: daemon unreachable / non-JSON → announced, no DELETE, boot PROCEEDS.
#        NOW (changed on purpose): an unknown never boots — UNKNOWN, exit 3, no exec, no DELETE. ---
reset; printf 'fail' > "$LIST_MODE"; printf '7' > "$CURL_EXIT"; boot orchestrator
refused_boot "J(unreachable)" UNKNOWN
reset; printf 'garbage' > "$LIST_MODE"; printf 'not json at all' > "$META_BODY"; boot orchestrator
refused_boot "J(meta not JSON)" UNKNOWN
grep -q '/api/sessions/' "$CURL_LOG" && fail "J: the session was looked up after an unusable meta answer"

# ===========================================================================
# NEW) unsupported CLI or daemon → UNSUPPORTED before any further request.
# ===========================================================================
reset; printf 'Usage: telepty <command>\n' > "$CAPS_TEXT"; boot orchestrator
refused_boot "old telepty (help + exit 0)" UNSUPPORTED
[ ! -s "$CURL_LOG" ] || fail "an unsupported telepty was followed by a daemon request: $(cat "$CURL_LOG")"
[ ! -s "$AUTH_LOG" ] || fail "an unsupported telepty was followed by a credential read"
reset; printf '{"capabilities":["sessions","wrapped-sessions"]}' > "$META_BODY"; boot orchestrator
refused_boot "meta without register-create-only" UNSUPPORTED

# ===========================================================================
# L) the exec argv carries --auto-restart, before the command word (unchanged property).
# ===========================================================================
ARGV_OUT="$T_TMP/exec-argv.txt"
reset
node "$BOOT_CLI" __probe exec-argv > "$ARGV_OUT" 2>/dev/null \
  || fail "L: __probe exec-argv exited non-zero"
plan_argv orchestrator > "$T_TMP/expected-argv.txt"
cmp "$T_TMP/expected-argv.txt" "$ARGV_OUT" || fail "L: probe stdout is not exact argv"
cmp "$T_TMP/expected-argv.txt" "$T_TMP/fresh-boot.out" || fail "L: normal FRESH boot stdout is not exact argv"
[ ! -s "$CAPS_LOG" ] && [ ! -s "$CURL_LOG" ] && [ ! -s "$AUTH_LOG" ] || fail "L: __probe exec-argv ran the preflight"
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
[ "${ORCH_EXEC_ARGV[1]}" = "allow-create-v1" ] || fail "L: the verb is not allow-create-v1: $argv"

# ===========================================================================
# M) WAS: the probes reported would-SIGKILL / would-DELETE on actionable fixtures, acting on nothing.
#    NOW: singleton-guard and registry-reconcile are REMOVED (exit 4, unknown subcommand), still inert;
#    exec-argv is unchanged. The same actionable fixtures stay armed.
# ===========================================================================
printf '7777 1 %s\n' "$B" > "$PS_TABLE"
rec STALE 0 > "$LIST_JSON"
for probe in singleton-guard registry-reconcile exec-argv; do
  reset
  set +e
  SINGLETON_SELF_PID=9999 node "$BOOT_CLI" __probe "$probe" >"$T_TMP/probe.out" 2>"$T_TMP/probe.err"
  probe_rc=$?
  set -e
  [ ! -s "$CURL_LOG" ] && [ ! -s "$AUTH_LOG" ] && [ ! -s "$CAPS_LOG" ] || fail "M/$probe: probe ran the preflight or resolved auth"
  no_destructive_effect "M/$probe"
  case "$probe" in
    singleton-guard|registry-reconcile)
      [ "$probe_rc" = "4" ] || fail "M/$probe: a removed probe must exit 4, got $probe_rc"
      [ ! -s "$T_TMP/probe.out" ] || fail "M/$probe: a removed probe wrote stdout"
      grep -qx "orchestrator-boot.sh: unknown __probe subcommand: $probe" "$T_TMP/probe.err" \
        || fail "M/$probe: not the unknown-subcommand refusal: $(cat "$T_TMP/probe.err")"
      grep -qE 'would (SIGKILL|DELETE)' "$T_TMP/probe.err" && fail "M/$probe: a removed effect was still described" ;;
    exec-argv)
      [ "$probe_rc" = "0" ] || fail "M/exec-argv exited $probe_rc"
      cmp "$ARGV_OUT" "$T_TMP/probe.out" || fail "M: probe argv changed" ;;
  esac
done

# ===========================================================================
# NEW) --dry-run probes nothing and claims no verdict, with every fixture armed.
# ===========================================================================
reset
SINGLETON_SELF_PID=9999 node "$BOOT_CLI" --dry-run >"$T_TMP/dry.out" 2>"$T_TMP/dry.err" \
  || fail "dry-run exited non-zero: $(cat "$T_TMP/dry.err")"
[ ! -s "$CAPS_LOG" ] && [ ! -s "$CURL_LOG" ] && [ ! -s "$AUTH_LOG" ] || fail "dry-run probed (caps/curl/auth)"
cp /dev/null "$T_TMP/boot.out"; cp /dev/null "$T_TMP/boot.err"
no_destructive_effect "dry-run"
grep -q 'only on a FRESH verdict' "$T_TMP/dry.out" || fail "dry-run does not say the exec needs a FRESH verdict"
grep -qE 'boot preflight (FRESH|EXISTS)' "$T_TMP/dry.out" "$T_TMP/dry.err" && fail "dry-run reported an unprobed verdict"
grep -qx '\[would-exec\] allow-create-v1' "$T_TMP/dry.out" || fail "dry-run [would-exec] verb is not allow-create-v1"

echo "T40 PASS"
