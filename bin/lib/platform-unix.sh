#!/usr/bin/env bash
# platform-unix.sh — macOS + Linux backend for platform.sh.
# Sourced by platform.sh when os_type ∈ {macos, linux}.

# platform::is_alive <pid> → 0 if alive, non-zero otherwise.
platform::is_alive() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && return 1
  kill -0 "$pid" 2>/dev/null
}

# platform::kill_pid <pid>
# Graceful: SIGTERM + 5s grace + SIGKILL fallback. Idempotent (missing pid ok).
platform::kill_pid() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && { echo "kill_pid: pid required" >&2; return 2; }
  platform::is_alive "$pid" || return 0

  kill -TERM "$pid" 2>/dev/null || return 0
  local i=0
  while [[ $i -lt 10 ]]; do  # 10 * 0.5s = 5s grace
    platform::is_alive "$pid" || return 0
    sleep 0.5
    i=$((i+1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  return 0
}

# platform::pid_exists <pidfile> → 0 if file has a live pid, non-zero otherwise.
platform::pid_exists() {
  local file="${1:-}"
  [[ -f "$file" ]] || return 1
  local pid
  pid=$(cat "$file" 2>/dev/null)
  platform::is_alive "$pid"
}

# platform::file_lock <path> <fn> [args...]
# Acquire lock on <path>, run <fn> with <args>, release. flock preferred;
# mkdir + PID-liveness fallback when flock absent.
platform::file_lock() {
  local path="$1"; shift
  local fn="$1"; shift
  if command -v flock >/dev/null 2>&1; then
    (
      exec 200>"$path" || exit 1
      flock -n 200 || { echo "lock held: $path" >&2; exit 1; }
      "$fn" "$@"
    )
    return $?
  fi
  local lockdir="${path}.d"
  local tries=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    local holder
    holder=$(cat "$lockdir/pid" 2>/dev/null || echo 0)
    if [[ "$holder" != "0" ]] && ! platform::is_alive "$holder"; then
      rm -rf "$lockdir"
      continue
    fi
    tries=$((tries+1))
    [[ $tries -gt 3 ]] && { echo "lock held by pid $holder: $path" >&2; return 1; }
    sleep 0.3
  done
  echo $$ > "$lockdir/pid"
  local rc=0
  "$fn" "$@" || rc=$?
  rm -rf "$lockdir"
  return $rc
}

# platform::file_unlock <path>  (best-effort for script-wide locks).
platform::file_unlock() {
  local path="${1:-}"
  [[ -z "$path" ]] && return 0
  rm -rf "${path}.d" 2>/dev/null || true
}

# platform::event_wait <dir> <timeout_sec>
# Block until <dir> gains a new entry, or timeout elapses.
# Preference order (autodetect at call-time):
#   1. `timeout` / `gtimeout` + fswatch -1   (GNU coreutils if present)
#   2. background fswatch -1 + watchdog kill (works with older fswatch that
#      lacks --timeout, e.g. 1.18.x on macOS)
#   3. pure sleep-poll fallback              (no fswatch on host)
platform::event_wait() {
  local dir="${1:-}" timeout="${2:-30}"
  [[ -d "$dir" ]] || { echo "event_wait: dir required" >&2; return 2; }

  if command -v fswatch >/dev/null 2>&1; then
    local tcmd=""
    if command -v gtimeout >/dev/null 2>&1; then tcmd=gtimeout
    elif command -v timeout >/dev/null 2>&1; then tcmd=timeout
    fi
    if [[ -n "$tcmd" ]]; then
      "$tcmd" "$timeout" fswatch -1 --event Created --event Updated --latency 0.5 "$dir" >/dev/null 2>&1
      local rc=$?
      # coreutils `timeout` returns 124 on timeout — map to 1, pass 0 through.
      [[ $rc -eq 0 ]] && return 0
      return 1
    fi
    # Background fswatch + watchdog kill.
    fswatch -1 --event Created --event Updated --latency 0.5 "$dir" >/dev/null 2>&1 &
    local fs_pid=$!
    local i=0
    while [[ $i -lt $timeout ]] && kill -0 "$fs_pid" 2>/dev/null; do
      sleep 1
      i=$((i+1))
    done
    if kill -0 "$fs_pid" 2>/dev/null; then
      kill "$fs_pid" 2>/dev/null
      wait "$fs_pid" 2>/dev/null
      return 1
    fi
    wait "$fs_pid" 2>/dev/null
    return 0
  fi

  local deadline=$(( $(date +%s) + timeout ))
  local seen
  seen=$(find "$dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 2
    local now
    now=$(find "$dir" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
    [[ "$now" != "$seen" ]] && return 0
  done
  return 1
}

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
