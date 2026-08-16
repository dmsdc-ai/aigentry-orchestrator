#!/usr/bin/env bash
# platform-windows.sh — Stub backend for Windows native (PowerShell / cmd).
# Every API returns exit 3 with a tracking message.
# Real implementation tracked at #305. Workaround: WSL.

_PLATFORM_WINDOWS_NOT_YET() {
  echo "platform-windows: '$1' not yet implemented." >&2
  echo "                  Windows native support tracked at #305." >&2
  echo "                  Workaround: use WSL (Windows Subsystem for Linux)." >&2
  return 3
}

platform::spawn_tmux_window() { _PLATFORM_WINDOWS_NOT_YET "spawn_tmux_window"; }
platform::spawn_iterm_tab()   { _PLATFORM_WINDOWS_NOT_YET "spawn_iterm_tab"; }
platform::has_tmux_session()  { _PLATFORM_WINDOWS_NOT_YET "has_tmux_session"; }

# Host power (#909). These two are QUERIES a caller uses to decide whether to act,
# not spawns — returning 3 would make every caller branch on an error code for the
# answer "I do not know". They answer honestly instead: no pid, no assertion, and a
# line saying so. `platform::host_power_state` prints `unknown`, which every #909
# consumer already treats as "do not gate on this".
platform::session_pid()      { return 0; }
platform::hold_awake()       { echo "hold_awake: Windows native has no sleep-assertion primitive yet (#305) — NO assertion held for '${2:-aigentry-worker}'" >&2; return 0; }
platform::host_power_state() { printf 'unknown\n'; }
platform::lid_closed()       { return 2; }
