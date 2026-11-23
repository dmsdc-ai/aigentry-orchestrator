#!/usr/bin/env bash
# T1304S — task 1304 round 3: a worker cleanup must never close the CONTROLLER's surface.
#
# THE INCIDENT (2026-11-23, Mac): a worker opened with the warp adapter ran in a tmux
# session whose SERVER had been started from the cmux controller's shell, so the worker
# inherited CMUX_WORKSPACE_ID/CMUX_SURFACE_ID/TELEPTY_SESSION_ID. telepty stored
# backend=cmux, terminal=tmux and the controller's cmuxWorkspaceId for it. After
# `wh-cli.sh close-for-sid` had removed the adapter record, `session-cleanup.sh <sid>`
# fell back to "cmux if installed", the cmux lookup returned the controller's workspace
# id, and cmux closed the controller. Three independent protections, one part each:
#
#   (1) P1 scrub — the warp pane command and the tmux window command start the worker
#       through `env -u …`; a worker started with CMUX_*/TELEPTY_SESSION_ID/
#       ATERM_IPC_SOCKET in its ambient environment (the stale tmux server's) does not
#       see them; a tmux-hosted worker keeps TMUX; a headless worker loses TMUX and
#       TERM_PROGRAM too.
#   (2) P2 own surface — closing a handle equal to the caller's CMUX_WORKSPACE_ID is
#       refused (exit 4, one labelled line) through `close`, `close-for-sid` and the real
#       session-cleanup.sh, and the cmux recorder records no close-workspace.
#   (3) P3 the exact incident sequence — open as warp, close-for-sid with no override,
#       then session-cleanup for the same sid with telepty reporting backend=cmux,
#       terminal=tmux and the controller's workspace id, with NO adapter override and NO
#       CMUX_WORKSPACE_ID (so (2) cannot be what saves it): no cmux close. Also with the
#       record AND its tombstone gone: the cmux lookup refuses an id the session's own
#       evidence (terminal=tmux) says is not its workspace.
#
# Hermetic: cleanup-close-lib.sh's seams (recording cmux, telepty stub, curl, ps and
# kill fakes; the kill TRIPWIRE stays armed), plus a stub tmux, a stub Warp opener and a
# probe that records the worker's environment. Fixture sids and fixture UUIDs only.
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/cleanup-close-lib.sh"

cc_setup T1304S
trap cc_teardown EXIT
cc_selfcheck

CTRL="E6BB270F-0000-4000-8000-00000000C0DE"          # the controller's workspace (fixture)
CTRL_LC=$(printf '%s' "$CTRL" | tr '[:upper:]' '[:lower:]')
export AIGENTRY_WARP_TAB_CONFIG_DIR="$T_TMP/tab_configs"
export AIGENTRY_WARP_SURFACE_DIR="$T_TMP/warp-surfaces"
export WARP_READY_TIMEOUT_MS=3000 WARP_READY_INTERVAL_MS=20
export TMUX_STUB_STATE="$T_TMP/tmux"; mkdir -p "$TMUX_STUB_STATE/s" "$TMUX_STUB_STATE/w"
PROBE_DIR="$T_TMP/probe"; mkdir -p "$PROBE_DIR"
export TMUX_STUB_PROBE="$PROBE_DIR" PROBE_LOG="$T_TMP/probe.log"
STATE="$AIGENTRY_WH_STATE_DIR"

# ── the worker's view of its environment: telepty (allow wrapper) and claude (daemon) ─
for p in telepty claude; do
  cat > "$PROBE_DIR/$p" <<'EOF'
#!/usr/bin/env bash
{ echo "RUN $(basename "$0") $*"
  env | grep -E '^(CMUX_[A-Za-z0-9_]*|TELEPTY_SESSION_ID|ATERM_IPC_SOCKET|TMUX|TMUX_PANE|TERM_PROGRAM|TERM_PROGRAM_VERSION)=' | sed 's/=.*//; s/^/ENV /'
} >> "${PROBE_LOG:?}"
EOF
  chmod +x "$PROBE_DIR/$p"
done

# ── stub tmux: sessions/windows are files; new-session/new-window RUN their command ──
cat > "$STUB_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
st="${TMUX_STUB_STATE:?}"
printf '%s\n' "tmux $*" >> "$st/log"
verb="${1:-}"; [ $# -gt 0 ] && shift
t=""; prev=""; for a in "$@"; do [ "$prev" = -t ] && t="$a"; prev="$a"; done
n="${t#=}"; n="${n%:}"
case "$verb" in
  new-session)
    name=""; dir=""; cmd=""
    while [ $# -gt 0 ]; do case "$1" in -A) shift;; -s) name="$2"; shift 2;; -c) dir="$2"; shift 2;; *) cmd="$1"; shift;; esac; done
    : > "$st/s/$name"
    ( cd "$dir" && PATH="$TMUX_STUB_PROBE:$PATH" bash -c "$cmd" ) >> "$st/run.log" 2>&1 || true ;;
  new-window)
    cmd=""; for a in "$@"; do cmd="$a"; done
    i=$(( $(cat "$st/wn" 2>/dev/null || echo 70) + 1 )); echo "$i" > "$st/wn"; : > "$st/w/@$i"
    ( PATH="$TMUX_STUB_PROBE:$PATH" bash -c "$cmd" ) >> "$st/run.log" 2>&1 || true
    echo "@$i" ;;
  has-session)  [ -e "$st/s/$n" ] && exit 0; echo "can't find session: $n" >&2; exit 1 ;;
  kill-session) [ -e "$st/s/$n" ] && { rm -f "$st/s/$n"; exit 0; }; echo "can't find session: $n" >&2; exit 1 ;;
  list-sessions) out=$(ls "$st/s"); [ -n "$out" ] || { echo "no server running on /tmp/tmux-stub/default" >&2; exit 1; }; printf '%s\n' "$out" ;;
  list-windows) ls "$st/w" ;;
  kill-window) [ -e "$st/w/$n" ] && { rm -f "$st/w/$n"; exit 0; }; echo "can't find window: $n" >&2; exit 1 ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/tmux"

# ── the Warp deeplink handoff: run commands[0] of the tab config, as Warp's shell does ─
TAB_PY="$T_TMP/tab-command.py"
cat > "$TAB_PY" <<'EOF'
import json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
try:
    import tomllib
    print(tomllib.loads(text)["panes"][0]["commands"][0], end="")
except ModuleNotFoundError:
    m = re.search(r'^commands = \[(".*")\]$', text, re.M)
    print(json.loads(m.group(1)) if m else "", end="")
EOF
for opener in open xdg-open; do
  cat > "$STUB_BIN/$opener" <<EOF
#!/usr/bin/env bash
toml="\$AIGENTRY_WARP_TAB_CONFIG_DIR/\${1##*/}.toml"
[ -f "\$toml" ] || exit 1
cp "\$toml" "$T_TMP/kept.toml"
bash -c "\$(python3 "$TAB_PY" "\$toml")" >> "$T_TMP/opener.log" 2>&1 || true
exit 0
EOF
  chmod +x "$STUB_BIN/$opener"
done

# an executing telepty for the daemon arm only: `spawn … -- argv` runs argv, rest → stub
EXEC_DIR="$T_TMP/execbin"; mkdir -p "$EXEC_DIR"
cat > "$EXEC_DIR/telepty" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = spawn ]; then
  while [ \$# -gt 0 ]; do [ "\$1" = "--" ] && { shift; break; }; shift; done
  ( PATH="$PROBE_DIR:\$PATH"; "\$@" ) >> "$T_TMP/daemon-run.log" 2>&1 || true
  exit 0
fi
exec "$STUB_BIN/telepty" "\$@"
EOF
chmod +x "$EXEC_DIR/telepty"

wh() { "$CC_BASH_BIN" "$CC_WH_CLI" "$@"; }
# the controller's ambient terminal identity, as a stale tmux server would hand it on
AMBIENT=(CMUX_WORKSPACE_ID="$CTRL" CMUX_SURFACE_ID="7879253D-0000-4000-8000-00000000C0DE"
         CMUX_TERMINAL_LIFECYCLE_ID="11111111-0000-4000-8000-00000000C0DE"
         TELEPTY_SESSION_ID=orchestrator ATERM_IPC_SOCKET=/tmp/t1304-fake-aterm
         TERM_PROGRAM=ghostty TERM_PROGRAM_VERSION=0.0-fixture
         CMUX_PANEL_ID=fixture-panel CMUX_TAB_ID=fixture-tab CMUX_SOCKET=/tmp/t1304-fake-cmux.sock
         CMUX_SOCKET_PATH=/tmp/t1304-fake-cmux.sock CMUX_CLAUDE_PID=1
         CMUX_AGENT_LAUNCH_KIND=fixture CMUX_CLAUDE_WRAPPER_SHIM=/tmp/t1304-fake-shim
         CMUX_CUA_AUTH_TOKEN_FILE=/tmp/t1304-fake-token CMUX_FUTURE_UNNAMED_FIXTURE=1)
probe_has() { grep -qE "^ENV ($1)\$" "$PROBE_LOG"; }
# r4: EVERY CMUX_* name counts as a leak, not just the identity ids (measured after r3:
# 39 others reached the worker — panel/tab ids, sockets, wrapper shims, a token file).
LEAK='CMUX_[A-Za-z0-9_]*|TELEPTY_SESSION_ID|ATERM_IPC_SOCKET'

# ════ (1) P1 — the scrub ════════════════════════════════════════════════════════════
: > "$PROBE_LOG"; cc_reset_logs P1-warp
env "${AMBIENT[@]}" AIGENTRY_WORKSPACE_HOST=warp "$CC_BASH_BIN" "$CC_WH_CLI" open t1304-s1 "$T_TMP" "claude --x" \
  > "$CC_EVID/p1-warp.out" 2> "$CC_EVID/p1-warp.err"
cc_expect_exit "$?" 0 "P1 warp open with the controller's markers in the environment"
cc_has "RUN telepty allow --id t1304-s1" "P1 warp: the worker command really ran inside the pane" "$PROBE_LOG"
if probe_has "$LEAK"; then cc_not_ok "P1 warp: the worker does not see CMUX_*/TELEPTY_SESSION_ID/ATERM_IPC_SOCKET" "$(cat "$PROBE_LOG")"
else cc_ok "P1 warp: the worker does not see CMUX_*/TELEPTY_SESSION_ID/ATERM_IPC_SOCKET"; fi
cc_has 'sed -n \"s/^\\(CMUX_[A-Za-z0-9_]*\\)=' \
  "P1 warp: the scrub is IN the tab config's pane command (beats a stale tmux server env)" "$T_TMP/kept.toml"
# r4: the controller's TERM_PROGRAM (ghostty) is not tmux's own value, so it is removed
if probe_has 'TERM_PROGRAM|TERM_PROGRAM_VERSION'; then cc_not_ok "R4-1 warp: a TERM_PROGRAM that is not tmux's own does not reach the worker" "$(cat "$PROBE_LOG")"
else cc_ok "R4-1 warp: a TERM_PROGRAM that is not tmux's own does not reach the worker"; fi

: > "$PROBE_LOG"
env "${AMBIENT[@]}" TMUX=/tmp/t1304-fake-tmux,1,0 AIGENTRY_WORKSPACE_HOST=tmux "$CC_BASH_BIN" "$CC_WH_CLI" open t1304-s2 "$T_TMP" "claude --x" \
  > "$CC_EVID/p1-tmux.out" 2> "$CC_EVID/p1-tmux.err"
cc_expect_exit "$?" 0 "P1 tmux open with the controller's markers in the environment"
cc_has "RUN telepty allow --id t1304-s2" "P1 tmux: the window command really ran" "$PROBE_LOG"
if probe_has "$LEAK"; then cc_not_ok "P1 tmux: the worker does not see the controller's markers" "$(cat "$PROBE_LOG")"
else cc_ok "P1 tmux: the worker does not see the controller's markers"; fi
if probe_has 'TMUX'; then cc_ok "P1 tmux: a tmux-hosted worker KEEPS TMUX (its own pane's)"
else cc_not_ok "P1 tmux: a tmux-hosted worker KEEPS TMUX (its own pane's)" "$(cat "$PROBE_LOG")"; fi
if probe_has 'TERM_PROGRAM'; then cc_not_ok "R4-1 tmux: the controller's TERM_PROGRAM (ghostty) is removed" "$(cat "$PROBE_LOG")"
else cc_ok "R4-1 tmux: the controller's TERM_PROGRAM (ghostty) is removed"; fi
# …and tmux's own value (what a real tmux pane carries) is kept
: > "$PROBE_LOG"
env "${AMBIENT[@]}" TERM_PROGRAM=tmux TERM_PROGRAM_VERSION=3.5 TMUX=/tmp/t1304-fake-tmux,1,0 AIGENTRY_WORKSPACE_HOST=tmux \
  "$CC_BASH_BIN" "$CC_WH_CLI" open t1304-s2b "$T_TMP" "claude --x" > /dev/null 2> "$CC_EVID/p1-tmux-own.err"
cc_has "RUN telepty allow --id t1304-s2b" "R4-1 tmux (own TERM_PROGRAM): the window command ran" "$PROBE_LOG"
if probe_has 'TERM_PROGRAM' && probe_has 'TERM_PROGRAM_VERSION'; then cc_ok "R4-1 tmux: tmux's own TERM_PROGRAM/_VERSION are kept"
else cc_not_ok "R4-1 tmux: tmux's own TERM_PROGRAM/_VERSION are kept" "$(cat "$PROBE_LOG")"; fi
if probe_has "$LEAK"; then cc_not_ok "R4-1 tmux (own TERM_PROGRAM): still no CMUX_* at all" "$(cat "$PROBE_LOG")"
else cc_ok "R4-1 tmux (own TERM_PROGRAM): still no CMUX_* at all"; fi

: > "$PROBE_LOG"
env "${AMBIENT[@]}" TMUX=/tmp/t1304-ctrl-tmux,1,0 TMUX_PANE=%9 AIGENTRY_WORKSPACE_HOST=headless \
  PATH="$EXEC_DIR:$PATH" "$CC_BASH_BIN" "$CC_WH_CLI" open t1304-s3 "$T_TMP" "claude --x" \
  > "$CC_EVID/p1-headless.out" 2> "$CC_EVID/p1-headless.err"
cc_expect_exit "$?" 0 "P1 headless open with the controller's markers (and TMUX) in the environment"
cc_has "RUN claude --x" "P1 headless: the daemon arm really ran the worker" "$PROBE_LOG"
if probe_has "$LEAK|TMUX|TMUX_PANE|TERM_PROGRAM|TERM_PROGRAM_VERSION"; then
  cc_not_ok "P1 headless: no controller marker, TMUX or TERM_PROGRAM reaches a daemon worker" "$(cat "$PROBE_LOG")"
else cc_ok "P1 headless: no controller marker, TMUX or TERM_PROGRAM reaches a daemon worker"; fi
cc_assert_cmux_count "close-workspace" 0 "P1: no cmux close anywhere in the spawn leg"

# ════ (2) P2 — the caller's own surface is never closed ═════════════════════════════
cc_reset_logs P2-close
env CMUX_WORKSPACE_ID="$CTRL" AIGENTRY_WORKSPACE_HOST=cmux "$CC_BASH_BIN" "$CC_WH_CLI" close "$CTRL_LC" \
  > "$CC_EVID/p2-close.out" 2> "$CC_EVID/p2-close.err"
cc_expect_exit "$?" 4 "P2 close of the caller's own workspace (case differs) is refused"
cc_assert_cmux_count "close-workspace" 0 "P2 close: the cmux recorder saw no close-workspace"
n=$(grep -c 'wh_close_refused=own-surface' "$CC_EVID/p2-close.err" | tr -d ' ')
[ "$n" = 1 ] && cc_ok "P2 close: exactly one labelled refusal line" \
  || cc_not_ok "P2 close: exactly one labelled refusal line" "$(cat "$CC_EVID/p2-close.err")"
cc_reset_logs P2-control
env CMUX_WORKSPACE_ID="$CTRL" AIGENTRY_WORKSPACE_HOST=cmux "$CC_BASH_BIN" "$CC_WH_CLI" close "workspace:42" \
  > /dev/null 2> "$CC_EVID/p2-control.err"
cc_expect_exit "$?" 0 "P2 control: another workspace still closes"
cc_assert_cmux_count "close-workspace --workspace workspace:42" 1 "P2 control: that close reached cmux"

cc_reset_logs P2-cfs
printf '[{"id":"t1304-own","command":"claude","healthStatus":"CONNECTED","cmuxWorkspaceId":"%s"}]' "$CTRL" > "$FAKE_LIST_FILE"
env CMUX_WORKSPACE_ID="$CTRL" AIGENTRY_WORKSPACE_HOST=cmux "$CC_BASH_BIN" "$CC_WH_CLI" close-for-sid t1304-own \
  > /dev/null 2> "$CC_EVID/p2-cfs.err"
cc_expect_exit "$?" 4 "P2 close-for-sid that maps to the caller's own workspace is refused, not 0"
cc_assert_cmux_count "close-workspace" 0 "P2 close-for-sid: no close-workspace"

cc_reset_logs P2-cleanup
rc=$(CMUX_WORKSPACE_ID="$CTRL" cc_run_cleanup P2-cleanup t1304-own)
cc_expect_exit "$rc" 1 "P2 session-cleanup reports the refusal as a failure (never a success)"
cc_assert_cmux_count "close-workspace" 0 "P2 session-cleanup: no close-workspace"
cc_has "close REFUSED for t1304-own" "P2 session-cleanup names the refusal" "$CC_EVID/P2-cleanup.out" "$CC_EVID/P2-cleanup.err"
cc_none "workspace host closed: t1304-own" "P2 session-cleanup does not claim a close" "$CC_EVID/P2-cleanup.out" "$CC_EVID/P2-cleanup.err"
cc_assert_no_kills "P2: kill tripwire stayed empty"

# ════ (3) P3 — the exact incident sequence ══════════════════════════════════════════
# session-cleanup with NO adapter override and NO CMUX_WORKSPACE_ID: protection (2) is
# out of play, so only the tombstone / the lookup evidence can stop the cmux close.
r3_run_cleanup() {
  local name="$1"; shift
  env -u AIGENTRY_WORKER_SESSION -u AIGENTRY_WORKSPACE_HOST -u CMUX_WORKSPACE_ID \
      PATH="$PATH" HOME="$HOME" TELEPTY="$TELEPTY" CURL="$CURL" \
      CLEANUP_PS_CMD="$CLEANUP_PS_CMD" KILL_CMD="$KILL_CMD" \
      DISPATCH_REGISTRY_PY="$DISPATCH_REGISTRY_PY" ORCHESTRATOR_SID="sid-repro-protected-fixture" \
      "$CC_BASH_BIN" "$CC_CLEANUP_SH" "$@" >"$CC_EVID/$name.out" 2>"$CC_EVID/$name.err" &
  cc_wait_child "$!" "$name"
}
SID=t1304-incident
cc_reset_logs P3-open
env "${AMBIENT[@]}" AIGENTRY_WORKSPACE_HOST=warp "$CC_BASH_BIN" "$CC_WH_CLI" open "$SID" "$T_TMP" "bash" \
  > /dev/null 2> "$CC_EVID/p3-open.err"
cc_expect_exit "$?" 0 "P3 open as warp"
env -u AIGENTRY_WORKSPACE_HOST -u CMUX_WORKSPACE_ID "$CC_BASH_BIN" "$CC_WH_CLI" close-for-sid "$SID" \
  > /dev/null 2> "$CC_EVID/p3-cfs.err"
cc_expect_exit "$?" 0 "P3 close-for-sid with no override"
[ -e "$STATE/$SID.rec" ] && cc_not_ok "P3: the live record is gone after close" || cc_ok "P3: the live record is gone after close"
[ -e "$STATE/$SID.closed" ] && cc_ok "P3: close left a tombstone naming the adapter" \
  || cc_not_ok "P3: close left a tombstone naming the adapter" "$(ls -A "$STATE" 2>&1)"
# telepty's row for the worker, exactly as measured after the incident
printf '[{"id":"%s","command":"bash","healthStatus":"CONNECTED","backend":"cmux","terminal":"tmux","termProgram":"tmux","cmuxWorkspaceId":"%s","cmuxSurfaceId":"7879253D-0000-4000-8000-00000000C0DE"}]' \
  "$SID" "$CTRL" > "$FAKE_LIST_FILE"
cc_reset_logs P3-cleanup
rc=$(r3_run_cleanup P3-cleanup "$SID")
cc_assert_cmux_count "close-workspace" 0 "P3 the incident sequence: session-cleanup performs NO cmux close"
cc_none "$CTRL" "P3: the controller's workspace id is never named as a host closed" "$CC_EVID/P3-cleanup.out" "$CC_EVID/P3-cleanup.err"
cc_assert_no_kills "P3: kill tripwire stayed empty"

# ── R4-2: the tombstone's END. It survives every prune tick while telepty still lists the
# sid (between close and the end of cleanup the adapter is never unknown), and goes on the
# SECOND consecutive tick on which the sid is absent from the live set (seen-twice).
[ -e "$STATE/$SID.closed" ] && cc_ok "R4-2: the tombstone is still there after session-cleanup's surface close" \
  || cc_not_ok "R4-2: the tombstone is still there after session-cleanup's surface close" "$(ls -A "$STATE" 2>&1)"
for tick in 1 2 3; do
  env -u AIGENTRY_WORKSPACE_HOST AIGENTRY_CMUX_ORPHAN_LEDGER="$T_TMP/cmux-ledger.json" "$CC_BASH_BIN" "$CC_WH_CLI" prune-orphans "$SID,sid-A" "" > "$CC_EVID/r42-live-$tick.out" 2>/dev/null
done
[ -e "$STATE/$SID.closed" ] && cc_ok "R4-2: three ticks with the sid LIVE keep the tombstone" \
  || cc_not_ok "R4-2: three ticks with the sid LIVE keep the tombstone" "$(ls -A "$STATE" 2>&1)"
env -u AIGENTRY_WORKSPACE_HOST AIGENTRY_CMUX_ORPHAN_LEDGER="$T_TMP/cmux-ledger.json" "$CC_BASH_BIN" "$CC_WH_CLI" prune-orphans "sid-A" "" > "$CC_EVID/r42-gone-1.out" 2>/dev/null
[ -e "$STATE/$SID.closed" ] && cc_ok "R4-2: the first tick with the sid gone keeps it (debounce floor)" \
  || cc_not_ok "R4-2: the first tick with the sid gone keeps it (debounce floor)"
env -u AIGENTRY_WORKSPACE_HOST AIGENTRY_CMUX_ORPHAN_LEDGER="$T_TMP/cmux-ledger.json" "$CC_BASH_BIN" "$CC_WH_CLI" prune-orphans "sid-A" "" > "$CC_EVID/r42-gone-2.out" 2> "$CC_EVID/r42-gone-2.err"
[ -e "$STATE/$SID.closed" ] && cc_not_ok "R4-2: the second tick with the sid gone removes the tombstone" "$(ls -A "$STATE" 2>&1)" \
  || cc_ok "R4-2: the second tick with the sid gone removes the tombstone"
[ "$(cat "$CC_EVID/r42-gone-2.out")" = "0" ] && cc_ok "R4-2: prune's stdout is still only the host prune's count" \
  || cc_not_ok "R4-2: prune's stdout is still only the host prune's count" "$(cat "$CC_EVID/r42-gone-2.out")"
cc_assert_cmux_count "close-workspace" 0 "R4-2: tombstone removal closed nothing"

# the record AND its tombstone lost: the cmux lookup itself must refuse the id
rm -f "$STATE/$SID.rec" "$STATE/$SID.closed"
cc_reset_logs P3-norecord
rc=$(r3_run_cleanup P3-norecord "$SID")
cc_assert_cmux_count "close-workspace" 0 "P3 no record at all, telepty says terminal=tmux: no cmux close"
cc_assert_no_kills "P3 no record: kill tripwire stayed empty"
# the same lookup through the door (cleanup discards its stderr): no id, and the reason
lk=$(env -u AIGENTRY_WORKSPACE_HOST -u CMUX_WORKSPACE_ID "$CC_BASH_BIN" "$CC_WH_CLI" lookup "$SID" "$(sed 's/^\[//; s/\]$//' "$FAKE_LIST_FILE")" 2> "$CC_EVID/p3-lookup.err")
[ -z "$lk" ] && cc_ok "P3: the cmux lookup returns no workspace for a tmux-hosted session" \
  || cc_not_ok "P3: the cmux lookup returns no workspace for a tmux-hosted session" "got: $lk"
cc_has "hosted outside cmux (telepty terminal=tmux)" "P3: the cmux lookup says why it ignored telepty's workspace id" "$CC_EVID/p3-lookup.err"

cc_summary T1304S
cc_exit T1304S
