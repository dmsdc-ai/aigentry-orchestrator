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

# ---------------------------------------------------------------------------
# Host power: sleep prevention while a worker is live (#909)
# ---------------------------------------------------------------------------

# platform::session_pid <sid> [timeout_ms] — print the pid of the `telepty allow
# --id <sid>` process fronting a session, or "" when it is not running. A spawn
# returns its ref before that process is necessarily up, so timeout_ms > 0 polls
# at 250ms; the default 0 is a single shot. The single-shot body is verbatim the
# one session-reconciler.sh:parent_pid_for_sid used to carry inline — it calls
# this now rather than the two scripts keeping divergent copies of one ps/awk.
platform::session_pid() {
  local sid="${1:-}" timeout_ms="${2:-0}" waited=0 pid
  [[ -z "$sid" ]] && return 0
  while :; do
    pid=$(ps -eo pid,command 2>/dev/null \
      | awk -v s="$sid" '$0 ~ ("telepty allow --id " s " ") {print $1; exit}' || true)
    [[ -n "$pid" ]] && { printf '%s\n' "$pid"; return 0; }
    [[ "$waited" -ge "$timeout_ms" ]] && return 0
    sleep 0.25
    waited=$((waited + 250))
  done
}

# platform::hold_awake <pid> <why> — hold a sleep assertion for exactly as long as
# <pid> lives, and no longer. Per-worker on purpose: a global or indefinite
# assertion is how a laptop stays awake for a week after one crashed spawner, so
# there is deliberately no code path here that outlives the process it was taken
# for — the OS releases it when that pid exits, including on a kill or a crash.
#
# macOS `caffeinate -i -w <pid>`: -i asserts against IDLE sleep only. It does NOT
# override a CLOSED LID — clamshell sleep is an SMC path no userspace assertion
# beats without an external display attached. That case is covered by the
# reconciler's LID_CLOSED alert (#909 item d), never by this function.
# Linux: systemd-inhibit --what=idle --mode=block, held by a waiter that exits with
# the worker. No systemd-inhibit ⇒ ANNOUNCED no-op (Rule 26): nothing is held and
# the line says so, rather than leaving a silent false guarantee behind.
#
# Seams so no test ever caffeinates the real host: AIGENTRY_CAFFEINATE,
# AIGENTRY_SYSTEMD_INHIBIT. Always returns 0 — a missing assertion must never gate
# a spawn.
platform::hold_awake() {
  local pid="${1:-}" why="${2:-aigentry-worker}" bin
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    echo "hold_awake: no live pid for '$why' — NO sleep assertion held" >&2
    return 0
  fi
  case "$(platform::os_type)" in
    macos)
      bin="${AIGENTRY_CAFFEINATE:-caffeinate}"
      if ! command -v "$bin" >/dev/null 2>&1; then
        echo "hold_awake: '$bin' not found — NO sleep assertion held for '$why'" >&2
        return 0
      fi
      nohup "$bin" -i -w "$pid" >/dev/null 2>&1 &
      echo "hold_awake: caffeinate -i -w $pid held for '$why' — releases when that pid exits; a CLOSED LID still sleeps this host" >&2
      ;;
    linux)
      bin="${AIGENTRY_SYSTEMD_INHIBIT:-systemd-inhibit}"
      if ! command -v "$bin" >/dev/null 2>&1; then
        echo "hold_awake: systemd-inhibit not found — NO sleep assertion held for '$why' (announced no-op)" >&2
        return 0
      fi
      # ponytail: 5s poll waiter, because systemd-inhibit follows a command rather
      # than a pid. Swap in a pidfd waiter if 5s of slack past worker-exit matters.
      nohup "$bin" --what=idle --who=aigentry --why="$why" --mode=block \
        sh -c "while kill -0 $pid 2>/dev/null; do sleep 5; done" >/dev/null 2>&1 &
      echo "hold_awake: systemd-inhibit idle-block held for '$why' (pid $pid) — releases when that pid exits" >&2
      ;;
    *)
      echo "hold_awake: no sleep-assertion primitive for this OS — NO assertion held for '$why'" >&2
      ;;
  esac
  return 0
}

# platform::host_power_state — print `awake`, `asleep` or `unknown`.
#
# "asleep" includes DarkWake, and that is the whole point: a DarkWake window is
# precisely when this host runs a cron tick, notices an idle worker, and pages the
# orchestrator about a session nobody is watching. Measured 2026-08-16 — ~70
# orchestrator turns burned across a 7.5h sleep, every one of them in one of these
# windows.
#
# macOS: the last power event in `pmset -g log`. The event name is the column
# between the timestamp and the TAB, which is why this parses on the tab rather
# than on whitespace — "Wake Requests" and "WakeDetails" are different events that
# both begin with the word Wake, and a whitespace split cannot tell them from a
# real "Wake". Costs ~1.2s (measured; pmset emits the whole log), so callers
# resolve it ONCE per tick and pass it down via AIGENTRY_HOST_POWER_STATE.
# Linux: no cheap equivalent — `unknown`, which every consumer treats as awake.
# UNKNOWN IS ALWAYS FAIL-OPEN: nothing may be suppressed on a state we do not know.
platform::host_power_state() {
  if [[ -n "${AIGENTRY_HOST_POWER_STATE:-}" ]]; then
    printf '%s\n' "$AIGENTRY_HOST_POWER_STATE"
    return 0
  fi
  local bin last
  case "$(platform::os_type)" in
    macos)
      bin="${AIGENTRY_PMSET:-pmset}"
      command -v "$bin" >/dev/null 2>&1 || { printf 'unknown\n'; return 0; }
      last=$("$bin" -g log 2>/dev/null | awk -F'\t' '
        $1 ~ /^[0-9][0-9][0-9][0-9]-/ {
          n = $1
          sub(/^[^ ]+ [^ ]+ [^ ]+ +/, "", n)
          gsub(/[ \t]+$/, "", n)
          if (n == "Sleep" || n == "DarkWake" || n == "Wake") last = n
        }
        END { print last }')
      case "$last" in
        Sleep|DarkWake) printf 'asleep\n' ;;
        Wake)           printf 'awake\n' ;;
        *)              printf 'unknown\n' ;;
      esac
      ;;
    *)
      printf 'unknown\n'
      ;;
  esac
}

# platform::lid_closed — 0 closed, 1 open, 2 unknown.
#
# A closed lid is the one sleep cause NO userspace assertion overrides: without an
# external display attached, clamshell sleep is an SMC path `caffeinate -i` loses to.
# So this is not an actuator, it is a page — the operator is the only fix.
#
# macOS: ioreg AppleClamshellState (~14ms measured, cheap enough per tick).
# Linux: /proc/acpi/button/lid/*/state where the kernel exposes it, else unknown.
# NOT MEASURED on Linux — no Linux host was available for #909; the path is the
# documented one and degrades to `unknown` (which never pages) when absent.
platform::lid_closed() {
  local bin state
  case "$(platform::os_type)" in
    macos)
      bin="${AIGENTRY_IOREG:-ioreg}"
      command -v "$bin" >/dev/null 2>&1 || return 2
      state=$("$bin" -r -k AppleClamshellState -d 4 2>/dev/null \
        | awk -F'= *' '/"AppleClamshellState"/ {print $2; exit}' | tr -d ' "')
      case "$state" in
        Yes) return 0 ;;
        No)  return 1 ;;
        *)   return 2 ;;
      esac
      ;;
    linux)
      state=$(cat /proc/acpi/button/lid/*/state 2>/dev/null | head -1)
      case "$state" in
        *closed) return 0 ;;
        *open)   return 1 ;;
        *)       return 2 ;;
      esac
      ;;
    *)
      return 2
      ;;
  esac
}
