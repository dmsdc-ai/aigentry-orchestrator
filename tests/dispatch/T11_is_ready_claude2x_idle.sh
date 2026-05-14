#!/usr/bin/env bash
# T11 — Claude 2.x welcome banner + idle `❯ Try "..."` placeholder = ready (telepty#22 fallback).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/claude2x_welcome_idle.txt" "$STUB_SCREEN_FILE"
export DISPATCH_SH_NO_MAIN=1
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
if is_ready sid-A claude; then echo "T11 PASS"; else echo "FAIL: Claude 2.x welcome+idle prompt blocks is_ready" >&2; exit 1; fi
