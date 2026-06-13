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

platform::kill_pid()          { _PLATFORM_WINDOWS_NOT_YET "kill_pid"; }
platform::is_alive()          { _PLATFORM_WINDOWS_NOT_YET "is_alive"; }
platform::pid_exists()        { _PLATFORM_WINDOWS_NOT_YET "pid_exists"; }
platform::file_lock()         { _PLATFORM_WINDOWS_NOT_YET "file_lock"; }
platform::file_unlock()       { _PLATFORM_WINDOWS_NOT_YET "file_unlock"; }
platform::event_wait()        { _PLATFORM_WINDOWS_NOT_YET "event_wait"; }
platform::spawn_tmux_window() { _PLATFORM_WINDOWS_NOT_YET "spawn_tmux_window"; }
platform::spawn_iterm_tab()   { _PLATFORM_WINDOWS_NOT_YET "spawn_iterm_tab"; }
platform::has_tmux_session()  { _PLATFORM_WINDOWS_NOT_YET "has_tmux_session"; }
