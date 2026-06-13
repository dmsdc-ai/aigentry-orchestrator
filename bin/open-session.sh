#!/usr/bin/env bash
# open-session.sh — Open an aigentry session in the user's current terminal environment
#
# Cross-terminal universality (헌법 Rule 2 크로스 + Rule 14 범용 블로킹 금지 + Rule 17 무의존):
#   Detects host terminal (cmux / aterm / tmux / wezterm / iTerm / ghostty / generic)
#   and spawns a visible UI container that wraps the CLI in `telepty allow --id <sid>`.
#   This guarantees BOTH:
#     1. Backend: telepty daemon registers the session (`telepty list`, inject targets work)
#     2. Frontend: user sees the session in their actual terminal
#
# Two-layer flag design (Rule 14 generic/multi-cross):
#   Layer 1 (generic): --cwd always works. No project-name assumptions.
#   Layer 2 (optional): --role looks up ~/.aigentry/config.json for user-specific shortcut
#
# Session id (SID) convention: {track}-{name}  (e.g. "B-architect-264")
#
# Usage:
#   open-session.sh --track B --name architect-264 --cwd ~/repos/my-design --cli claude
#   open-session.sh --track A --name bench-250 --cwd /tmp/bench-orch
#
#   # With ~/.aigentry/config.json configured:
#   open-session.sh --track B --role architect --task 264
#
# Default per-CLI flags (applied only when --extra-flags + config cli_flags both empty):
#   claude default flags: --permission-mode bypassPermissions
#   codex default flags: -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox
#   gemini default flags: -m ${AIGENTRY_GEMINI_MODEL:-gemini-2.5-flash} --approval-mode yolo
#
# Output: session ref on stdout (cmux: "workspace:N", others: SID)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Resolve symlinks to find the real script directory (POSIX-portable).
# Required because ~/projects/aigentry-orchestrator/bin/open-session.sh is a symlink
# pointing at this script, and `cd + pwd` alone does not follow symlinks — which
# breaks `source $SCRIPT_DIR/lib/platform.sh`.
_resolve_src() {
  local src="$1"
  while [ -L "$src" ]; do
    local target
    target="$(readlink "$src")"
    case "$target" in
      /*) src="$target" ;;
      *)  src="$(cd "$(dirname "$src")" && pwd -P)/$target" ;;
    esac
  done
  printf '%s\n' "$src"
}
SCRIPT_DIR="$(cd "$(dirname "$(_resolve_src "${BASH_SOURCE[0]}")")" && pwd -P)"
# shellcheck source=./lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"
# Workspace Host adapter seam (#608 step2): wh_open is the cmux spawn path. Local
# relative source — this script is now an orchestrator real file (not the legacy
# devkit symlink), so SCRIPT_DIR reaches orchestrator/bin/lib/workspace-host.sh.
# shellcheck source=./lib/workspace-host.sh
source "$SCRIPT_DIR/lib/workspace-host.sh"

CONFIG_FILE="${AIGENTRY_CONFIG:-$HOME/.aigentry/config.json}"

track=""
name=""
role=""
task=""
cli="claude"
cwd_override=""
extra_flags=""
sid=""
auto_cleanup=0

while [ $# -gt 0 ]; do
  case "$1" in
    --track) track="$2"; shift 2;;
    --name) name="$2"; shift 2;;
    --role) role="$2"; shift 2;;
    --task) task="$2"; shift 2;;
    --cli) cli="$2"; shift 2;;
    --cwd) cwd_override="$2"; shift 2;;
    --extra-flags) extra_flags="$2"; shift 2;;
    --auto-cleanup-on-exit) auto_cleanup=1; shift;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0;;
    *) echo "ERR unknown arg: $1" >&2; exit 1;;
  esac
done

[ -z "$track" ] && { echo "ERR --track required" >&2; exit 1; }

# Resolve name: explicit --name wins, else {role}-{task}, else error
if [ -z "$name" ]; then
  if [ -n "$role" ] && [ -n "$task" ]; then
    name="${role}-${task}"
  else
    echo "ERR need either --name or (--role + --task)" >&2; exit 1
  fi
fi

# Resolve cwd: explicit --cwd wins, else lookup ~/.aigentry/config.json by --role
cwd=""
cli_flags_from_config=""
if [ -n "$cwd_override" ]; then
  cwd="$cwd_override"
elif [ -n "$role" ] && [ -f "$CONFIG_FILE" ]; then
  cwd=$(jq -r --arg r "$role" '.roles[$r].path // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
  cli_flags_from_config=$(jq -r --arg r "$role" '.roles[$r].cli_flags // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
  cli_from_config=$(jq -r --arg r "$role" '.roles[$r].cli // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
  [ -n "$cli_from_config" ] && cli="$cli_from_config"
fi

if [ -z "$cwd" ]; then
  echo "ERR cwd unresolved. Options:" >&2
  echo "  1. Pass --cwd PATH explicitly" >&2
  echo "  2. Configure role in $CONFIG_FILE (see $HOME/projects/aigentry-devkit/docs/session-conventions.md)" >&2
  exit 1
fi

# Homedir shortcut expansion
eval cwd="$cwd"
[ -d "$cwd" ] || mkdir -p "$cwd"

# Trust check warning (claude only)
trust_status=$(jq -r --arg p "$cwd" '.projects[$p].hasTrustDialogAccepted // false' "$HOME/.claude.json" 2>/dev/null || echo "false")
if [ "$trust_status" != "true" ] && [ "$cli" = "claude" ]; then
  echo "WARN: $cwd not in ~/.claude.json trust list — claude will show trust prompt" >&2
  echo "      run: aigentry-devkit/bin/trust-path.sh $cwd" >&2
fi

title="${track}-${name}"
sid="$title"  # SID convention = title (track-name)

# CLI flags: --extra-flags arg > config > defaults
if [ -z "$extra_flags" ] && [ -n "$cli_flags_from_config" ]; then
  extra_flags="$cli_flags_from_config"
fi
case "$cli" in
  claude) [ -z "$extra_flags" ] && extra_flags="--permission-mode bypassPermissions";;
  codex)  [ -z "$extra_flags" ] && extra_flags="-c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox";;
  gemini) [ -z "$extra_flags" ] && extra_flags="-m ${AIGENTRY_GEMINI_MODEL:-gemini-2.5-flash} --approval-mode yolo";;
esac

# Detect host terminal environment
detect_terminal() {
  [ -n "${CMUX_WORKSPACE_ID:-}" ] && { echo cmux; return; }
  [ -n "${ATERM_IPC_SOCKET:-}" ] && { echo aterm; return; }
  [ -n "${TMUX:-}" ] && { echo tmux; return; }
  case "${TERM_PROGRAM:-}" in
    WezTerm)   echo wezterm ;;
    iTerm.app) echo iterm ;;
    ghostty)   echo ghostty ;;
    *)         echo generic ;;
  esac
}

# Fallback chain when a preferred terminal CLI is unavailable.
# Goes through the platform abstraction (Rule 26) so a future Windows backend
# can satisfy the tmux branch natively (WSL tmux / wt.exe etc.).
fallback_spawn() {
  local _sid="$1" _cwd="$2" _cli_cmd="$3"
  if command -v tmux >/dev/null 2>&1 && platform::has_tmux_session; then
    platform::spawn_tmux_window "$_sid" "$_cwd" "telepty allow --id '$_sid' --auto-restart $_cli_cmd"
    echo "$_sid"
  else
    telepty spawn --id "$_sid" -- bash -c "cd '$_cwd' && exec $_cli_cmd" >/dev/null
    echo "⚠️  Session spawned as daemon (no visible terminal). Attach: telepty attach $_sid" >&2
    echo "$_sid"
  fi
}

# _cmux_wait_ready <workspace-ref> [cmux-bin] — readiness barrier for a freshly created
# cmux workspace (BUG-A: close the daemon submit-race at the source, Rule 27).
#
# `cmux new-workspace` returns `workspace:N` on a string-parse, but the pane's surface PTY
# + `telepty allow` foreground proc come up async AFTER that. Returning the ref before the
# surface can accept `send-key` lets the daemon submit fire into a not-yet-live socket
# ("Failed to write to socket") → the worker's Enter is lost → it never starts. This gate
# makes the returned ref mean "the pane is ready to receive keys".
#
# Proof is 3-part, re-checked each poll. cmux's EXIT STATUS IS UNRELIABLE (it prints
# "Error:" lines with rc=0) and a BOGUS REF SILENTLY FALLS BACK to the caller's own surface
# — so every check inspects OUTPUT TEXT, and existence is anchored on list-workspaces (which
# never lists a bogus ref):
#   (a) list-workspaces contains the exact ref → workspace registered (fallback-immune)
#   (b) surface-health shows a `type=terminal` line and no `Error:` → pane surface exists
#   (c) read-screen returns non-empty content and no `Error:`      → surface renders/responds
# Checks short-circuit existence-first, so the fallback-prone probes are never consulted for
# an unregistered ref. The cmux branch is macOS-only, so the loop uses only portable
# primitives (awk/sleep/grep) — no OS abstraction needed (Rule 26).
_cmux_wait_ready() {
  local ref="$1" cmux_bin="${2:-cmux}"
  local timeout_ms="${CMUX_READY_TIMEOUT_MS:-10000}"
  local interval_ms="${CMUX_READY_INTERVAL_MS:-200}"
  local interval_s; interval_s=$(awk -v ms="$interval_ms" 'BEGIN{printf "%.3f", ms/1000}')
  local max_iters=$(( timeout_ms / interval_ms )); [ "$max_iters" -lt 1 ] && max_iters=1
  local i=0 lw sh rs
  while [ "$i" -lt "$max_iters" ]; do
    lw=$("$cmux_bin" list-workspaces 2>/dev/null || true)
    if printf '%s\n' "$lw" | grep -qE "(^|[[:space:]])${ref}([[:space:]]|$)"; then
      sh=$("$cmux_bin" surface-health --workspace "$ref" 2>&1 || true)
      if printf '%s\n' "$sh" | grep -q 'type=terminal' \
         && ! printf '%s\n' "$sh" | grep -q '^Error:'; then
        rs=$("$cmux_bin" read-screen --workspace "$ref" --lines 1 2>&1 || true)
        if [ -n "$(printf '%s' "$rs" | tr -d '[:space:]')" ] \
           && ! printf '%s\n' "$rs" | grep -q '^Error:'; then
          return 0
        fi
      fi
    fi
    i=$((i+1))
    sleep "$interval_s"
  done
  return 1
}

# Open session in detected terminal. Always wraps in `telepty allow --id <sid>`
# so the daemon registers it (visible to `telepty list` + inject targets).
open_in_terminal() {
  local term cli_cmd ref out
  term=$(detect_terminal)
  cli_cmd="$cli $extra_flags"

  case "$term" in
    cmux)
      # cmux --command sends text+Enter; telepty allow runs as the workspace's foreground process.
      # bash -c 'cd ... && exec ...' wrapper: cmux --cwd only affects workspace shell, not the
      # telepty-allow-wrapped CLI. Explicit cd inside wrapper guarantees claude inherits cwd (#311).
      if [ "${AIGENTRY_WH_LEGACY_SPAWN:-}" = "1" ]; then
        # BC4-a rollback switch: force the legacy inline cmux path (devkit original,
        # byte-for-byte) instead of wh_open. Immediate revert if the seam regresses.
        # CMUX seam: injectable cmux binary so the readiness gate is hermetically testable
        # (BUG-A); defaults to the real `cmux` in production.
        local CMUX_BIN="${CMUX:-cmux}"
        out=$("$CMUX_BIN" new-workspace --cwd "$cwd" --command "bash -c 'cd $cwd && exec telepty allow --id $sid --auto-restart $cli_cmd'" 2>&1)
        ref=$(echo "$out" | grep -oE 'workspace:[0-9]+' | head -1)
        [ -z "$ref" ] && { echo "ERR cmux new-workspace failed: $out" >&2; exit 2; }
        "$CMUX_BIN" rename-workspace --workspace "$ref" "$title" >/dev/null 2>&1 || true
        # Readiness barrier (BUG-A, Rule 27): return the ref ONLY once the pane surface can
        # accept `send-key`, so the daemon submit never races a not-yet-live socket.
        if ! _cmux_wait_ready "$ref" "$CMUX_BIN"; then
          echo "ERR cmux workspace $ref pane not ready after ${CMUX_READY_TIMEOUT_MS:-10000}ms — surface cannot accept send-key (daemon submit would race 'Failed to write to socket'). Not returning a ref for a dead workspace." >&2
          "$CMUX_BIN" close-workspace --workspace "$ref" >/dev/null 2>&1 || true
          exit 3
        fi
        echo "$ref"
      else
        # #608 step2: wh_open is the byte-equivalent cmux spawn. _wh_cmux_open does
        # new-workspace + rename + the 3-part ready-gate internally, returning the ref
        # ONLY once the pane can accept send-key. Its exit codes match the legacy inline
        # contract above (2 = spawn failure, 3 = ready-timeout with the ws closed), so
        # propagate them verbatim — same observable behavior, single SSOT spawn path.
        ref=$(wh_open "$sid" "$cwd" "$cli_cmd") || exit $?
        echo "$ref"
      fi
      ;;
    aterm)
      # bash -c wrapper for cwd propagation into claude (#311).
      if command -v aterm >/dev/null 2>&1 \
        && aterm new-session --cwd "$cwd" --cmd "bash -c 'cd $cwd && exec telepty allow --id $sid --auto-restart $cli_cmd'" 2>/dev/null; then
        echo "$sid"
      else
        fallback_spawn "$sid" "$cwd" "$cli_cmd"
      fi
      ;;
    tmux)
      # tmux new-window -c propagates cwd correctly via platform::spawn_tmux_window.
      platform::spawn_tmux_window "$title" "$cwd" "telepty allow --id '$sid' --auto-restart $cli_cmd"
      echo "$sid"
      ;;
    wezterm)
      if command -v wezterm >/dev/null 2>&1; then
        # Explicit cd inside bash -c guarantees cwd propagation into claude (#311).
        wezterm cli spawn --cwd "$cwd" -- bash -c "cd '$cwd' && exec telepty allow --id $sid --auto-restart $cli_cmd" >/dev/null
        echo "$sid"
      else
        fallback_spawn "$sid" "$cwd" "$cli_cmd"
      fi
      ;;
    iterm)
      platform::spawn_iterm_tab "$cwd" "telepty allow --id $sid --auto-restart $cli_cmd" \
        || { echo "ERR iTerm spawn failed" >&2; exit 2; }
      echo "$sid"
      ;;
    ghostty|generic|*)
      # No clean spawn-tab CLI — fall back to daemon PTY with attach instructions.
      telepty spawn --id "$sid" -- bash -c "cd '$cwd' && exec $cli_cmd" >/dev/null
      echo "⚠️  Session spawned as daemon ($term has no spawn-tab CLI)." >&2
      echo "    Attach via: telepty attach $sid" >&2
      echo "$sid"
      ;;
  esac
}

# EXIT trap — best-effort session-lifecycle hook (Plan A Task 8 integration).
# Calls ctx-router on-session-end so journal/handoff state is flushed if this script
# itself terminates abnormally before the spawn completes.
cleanup_on_exit() {
  local ec=$?
  local ctx_router="${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}"
  if [ -x "$ctx_router" ] && [ -n "${sid:-}" ]; then
    "$ctx_router" on-session-end "$sid" >/dev/null 2>&1 || true
  fi
  # Extended (#304): if --auto-cleanup-on-exit, also run session-cleanup.sh
  # so PTY + cmux workspace + orchestrator pid mutex all get torn down.
  if [ "${auto_cleanup:-0}" -eq 1 ] && [ -n "${sid:-}" ]; then
    local sc
    sc="$(dirname "${BASH_SOURCE[0]}")/session-cleanup.sh"
    [ -x "$sc" ] && "$sc" "$sid" >/dev/null 2>&1 || true
  fi
  exit $ec
}
trap cleanup_on_exit EXIT

# Spawn the session (output the ref/sid on stdout)
ref=$(open_in_terminal)

# Log
log_file="$HOME/.aigentry/open-session.log"
mkdir -p "$(dirname "$log_file")"
echo "$(date -u +%FT%TZ) term=$(detect_terminal) ref=$ref sid=$sid title=$title cwd=$cwd cli=$cli flags=$extra_flags" >> "$log_file"

echo "$ref"
