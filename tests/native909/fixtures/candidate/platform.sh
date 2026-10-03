#!/usr/bin/env bash
# platform.sh — Cross-OS abstraction dispatcher.
# Source this file from any script needing OS-specific primitives.
# After source, platform::* functions are available.
#
# Spec: docs/superpowers/specs/2026-04-19-session-cleanup-and-platform-abstraction-design.md

# Guard against double-source
[[ "${_PLATFORM_SH_SOURCED:-}" == "1" ]] && return 0
_PLATFORM_SH_SOURCED=1

PLATFORM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# platform::os_type() → macos|linux|windows|unknown
# Honors $PLATFORM_OVERRIDE for test injection.
platform::os_type() {
  if [[ -n "${PLATFORM_OVERRIDE:-}" ]]; then
    echo "$PLATFORM_OVERRIDE"
    return 0
  fi
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)               echo macos ;;
    Linux)                echo linux ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *)                    echo unknown ;;
  esac
}

# Source backend based on detected OS.
_load_backend() {
  local os
  os=$(platform::os_type)
  case "$os" in
    macos|linux)
      # shellcheck source=./platform-unix.sh
      source "$PLATFORM_LIB_DIR/platform-unix.sh"
      ;;
    windows)
      # shellcheck source=./platform-windows.sh
      source "$PLATFORM_LIB_DIR/platform-windows.sh"
      ;;
    *)
      echo "platform.sh: unknown OS '$os' — abort" >&2
      return 4
      ;;
  esac
}

_load_backend
