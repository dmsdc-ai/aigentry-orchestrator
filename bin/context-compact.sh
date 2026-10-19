#!/usr/bin/env bash
# context-compact.sh — snapshot-then-compact for the orchestrator session, in one step, on any CLI.
#
# The orchestrator writes .context-snapshot.md itself (the model knows the plan; no script can).
# This helper enforces the order the Safe Compact Protocol requires and then asks the session to
# compact: it refuses when the snapshot is missing or stale, and otherwise injects the session's
# compaction command into the orchestrator's own telepty session, which the CLI executes as the
# next input. The command comes from the session's CLI — AIGENTRY_ORCH_CLI, else the `command` of
# the sid's record on the telepty daemon (AIGENTRY_TELEPTY_API, default
# http://127.0.0.1:${TELEPTY_PORT:-3848}): claude/codex/grok → /compact, gemini/agy → /compress.
# AIGENTRY_COMPACT_COMMAND, when set, always wins.
#
# Restore after the compaction: claude prints the snapshot back through its SessionStart/compact
# hook (installed by the devkit). codex, gemini, agy and grok have no hook that can (grok 1.0.25's
# PostCompact hook is passive — its stdout never reaches the model), so this helper starts a detached
# waiter (`--wait-and-restore <sid> <snapshot>`, internal) that polls the session record every
# AIGENTRY_COMPACT_POLL_MS (default 2000), waits until it has seen the session busy and then idle
# for ≥ 5 s (or 180 s pass), and injects the same restore line the Claude hook prints. Log:
# state/logs/context-compact-<sid>.log. Native Windows has no setsid, so no waiter is started there;
# the instruction backstop in tooling/instructions/common.md applies instead.
# Exit: 0 injected, 3 snapshot missing/stale, 4 inject failed, 5 CLI unknown (no command for it).
set -euo pipefail
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
snap="$root/.context-snapshot.md"
max_age="${AIGENTRY_SNAPSHOT_MAX_AGE_SECONDS:-900}"
sid="${AIGENTRY_ORCH_SID:-orchestrator}"
api="${AIGENTRY_TELEPTY_API:-http://127.0.0.1:${TELEPTY_PORT:-3848}}"
poll_ms="${AIGENTRY_COMPACT_POLL_MS:-2000}"
case "$poll_ms" in ''|*[!0-9]*|0) poll_ms=2000 ;; esac   # digits only: it reaches $(( ))
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
# The one daemon-credential resolver (tests/dispatch/T87); this file never reads the config itself.
# shellcheck source=lib/telepty-auth.sh
. "$(dirname "$self")/lib/telepty-auth.sh"
telepty="${AIGENTRY_TELEPTY:-$(command -v telepty || true)}"

# session_probe <sid> — the sid's daemon record as "command␟ready␟idleSeconds␟lastActivityAt",
# or nothing when the daemon does not answer or holds no such session.
session_probe() {
  telepty_curl -sf "$api/api/sessions" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);
const a=Array.isArray(d)?d:(d&&d.sessions)||[];const r=a.find(x=>x&&x.id===process.argv[1]);
if(r)process.stdout.write([r.command,r.ready,r.idleSeconds,r.lastActivityAt]
.map(v=>v==null?"":String(v).replace(/[\x1f\n]/g," ")).join("\x1f"))}catch{}})' "$1" 2>/dev/null || true
}

restore_line() {
  printf 'CONTEXT SNAPSHOT restored after compact — %s (written %s). Read it, then continue the work it describes.' \
    "$1" "$(date -r "$1" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || echo unknown)"
}

# wait_and_restore <sid> <snapshot> — the detached waiter. Busy = `ready` false, `lastActivityAt`
# moved or `idleSeconds` went down; idle = `idleSeconds` ≥ 5 (own clock when the field is absent).
wait_and_restore() {
  local w_sid="$1" w_snap="$2" deadline busy=0 outcome=timeout rec ready idle last
  local prev_idle="" prev_last="" changed_at idle_for nap
  deadline=$(( $(date +%s) + 180 )); changed_at=$(date +%s)
  nap=$(printf '%d.%03d' $(( poll_ms / 1000 )) $(( poll_ms % 1000 )))
  echo "$(date '+%F %T') waiter pid=$$ sid=$w_sid snapshot=$w_snap poll=${poll_ms}ms"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    rec=$(session_probe "$w_sid")
    if [ -n "$rec" ]; then
      IFS=$'\x1f' read -r _ ready idle last <<<"$rec" || true
      idle="${idle%%.*}"
      if [ "$ready" = "false" ] || { [ -n "$prev_last" ] && [ "$last" != "$prev_last" ]; } \
        || { [ -n "$prev_idle" ] && [ -n "$idle" ] && [ "$idle" -lt "$prev_idle" ]; }; then
        [ "$busy" = 1 ] || echo "$(date '+%F %T') busy observed (ready=$ready idleSeconds=$idle)"
        busy=1; changed_at=$(date +%s)
      fi
      prev_last="$last"; prev_idle="$idle"
      if [ -n "$idle" ]; then idle_for="$idle"; else idle_for=$(( $(date +%s) - changed_at )); fi
      if [ "$busy" = 1 ] && [ "$idle_for" -ge 5 ]; then outcome=idle; break; fi
    fi
    sleep "$nap"
  done
  echo "$(date '+%F %T') $outcome — injecting the restore line"
  if "$telepty" inject --submit --from "$w_sid" "$w_sid" "$(restore_line "$w_snap")" >/dev/null 2>&1; then
    echo "$(date '+%F %T') restore injected"
  else
    echo "$(date '+%F %T') restore inject failed"; return 4
  fi
}

if [ "${1:-}" = "--wait-and-restore" ]; then wait_and_restore "$2" "$3"; exit $?; fi

if [ ! -f "$snap" ]; then echo "context-compact: no snapshot at $snap — write it first" >&2; exit 3; fi
# GNU form first: GNU `stat -f` is --file-system and prints a "File: ..." report into $(( )) (#1204);
# BSD stat refuses -c with nothing on stdout.
age=$(( $(date +%s) - $(stat -c %Y "$snap" 2>/dev/null || stat -f %m "$snap") ))
if [ "$age" -gt "$max_age" ]; then
  echo "context-compact: snapshot is ${age}s old (limit ${max_age}s) — refresh it before compacting" >&2; exit 3
fi
cli="${AIGENTRY_ORCH_CLI:-}"
[ -n "$cli" ] || { rec=$(session_probe "$sid"); cli="${rec%%$'\x1f'*}"; }
cli="${cli##*/}"; cli="${cli##*\\}"
case "$cli" in *.exe|*.EXE|*.cmd|*.CMD) cli="${cli%.*}" ;; esac
case "$cli" in
  claude|codex|grok) cli_cmd=/compact ;;
  gemini|agy)        cli_cmd=/compress ;;
  *)                 cli_cmd= ;;
esac
cmd="${AIGENTRY_COMPACT_COMMAND:-$cli_cmd}"
if [ -z "$cmd" ]; then
  echo "context-compact: no compaction command known for CLI '${cli:-<unresolved>}' of session $sid — set AIGENTRY_COMPACT_COMMAND to the command that CLI uses" >&2; exit 5
fi
[ -n "$telepty" ] || { echo "context-compact: telepty not found" >&2; exit 4; }
if ! "$telepty" inject --submit --from "$sid" "$sid" "$cmd" >/dev/null 2>&1; then
  echo "context-compact: inject into $sid failed" >&2; exit 4
fi
case "$cli" in
  claude)
    echo "context-compact: snapshot is ${age}s old; '$cmd' injected into $sid — the session compacts when this turn ends, then the $cli hook restores the snapshot" ;;
  codex|gemini|agy|grok)
    case "$(uname -s 2>/dev/null || echo unknown)" in
      MINGW*|MSYS*|CYGWIN*)
        echo "context-compact: snapshot is ${age}s old; '$cmd' injected into $sid — no restore waiter on native Windows (no setsid); the instruction backstop applies: read $snap after the compaction"
        exit 0 ;;
    esac
    log="$root/state/logs/context-compact-${sid//[^A-Za-z0-9._-]/_}.log"
    mkdir -p "$(dirname "$log")"
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid bash "$self" --wait-and-restore "$sid" "$snap" >>"$log" 2>&1 </dev/null &
    else
      # macOS ships no setsid(1); node's detached spawn calls setsid(2) for the child.
      nohup node -e 'require("child_process").spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:"inherit"}).unref()' \
        bash "$self" --wait-and-restore "$sid" "$snap" >>"$log" 2>&1 </dev/null &
    fi
    echo "context-compact: snapshot is ${age}s old; '$cmd' injected into $sid — the session compacts when this turn ends, then a detached waiter injects the snapshot restore (log: $log)" ;;
  *)
    echo "context-compact: snapshot is ${age}s old; '$cmd' injected into $sid (AIGENTRY_COMPACT_COMMAND) — CLI '${cli:-<unresolved>}' has no known restore path; the instruction backstop applies: read $snap after the compaction" ;;
esac
