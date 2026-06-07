#!/usr/bin/env bash
# T50 (#557) — codex's interactive `›` REPL during MCP-server boot = ready.
# The "Starting MCP servers (n/6) … (esc to interrupt)" status line trips HARD_NEG
# via "esc to interrupt", but the prompt accepts input, so dispatch must NOT wait
# out the full (>30s) 6-server boot. The early init banner (no prompt) stays
# not-ready — see T12.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/codex_mcp_boot.txt" "$STUB_SCREEN_FILE"
export DISPATCH_SH_NO_MAIN=1
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
if is_ready sid-A codex; then echo "T50 PASS"; else echo 'FAIL: codex prompt during MCP boot blocked is_ready' >&2; exit 1; fi
