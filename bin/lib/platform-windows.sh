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
