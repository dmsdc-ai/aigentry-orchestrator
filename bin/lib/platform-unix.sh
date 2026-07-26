#!/usr/bin/env bash
# platform-unix.sh — macOS + Linux backend for platform.sh.
# Sourced by platform.sh when os_type ∈ {macos, linux}.

# ---------------------------------------------------------------------------
# Terminal spawn (Rule 26 migration of open-session.sh branches)
# ---------------------------------------------------------------------------

# platform::has_tmux_session — 0 if called from inside a tmux session (TMUX set).
platform::has_tmux_session() {
  [[ -n "${TMUX:-}" ]]
}

# platform::spawn_tmux_window <name> <cwd> <cmd>
# Wraps `tmux new-window`. Name becomes the window label, cwd the starting dir.
platform::spawn_tmux_window() {
  local name="${1:-}" cwd="${2:-}" cmd="${3:-}"
  [[ -z "$name" || -z "$cwd" || -z "$cmd" ]] && { echo "spawn_tmux_window: 3 args" >&2; return 2; }
  command -v tmux >/dev/null 2>&1 || { echo "tmux not installed" >&2; return 4; }
  tmux new-window -c "$cwd" -n "$name" "$cmd"
}

# platform::spawn_iterm_tab <cwd> <cmd>  (macOS-only, via AppleScript)
platform::spawn_iterm_tab() {
  local cwd="${1:-}" cmd="${2:-}"
  [[ -z "$cwd" || -z "$cmd" ]] && { echo "spawn_iterm_tab: 2 args" >&2; return 2; }
  [[ "$(platform::os_type)" == "macos" ]] || { echo "iTerm requires macOS" >&2; return 4; }
  osascript >/dev/null 2>&1 <<APPLESCRIPT
tell application "iTerm"
  tell current window
    create tab with default profile
    tell current session
      write text "cd ${cwd} && ${cmd}"
    end tell
  end tell
end tell
APPLESCRIPT
}
