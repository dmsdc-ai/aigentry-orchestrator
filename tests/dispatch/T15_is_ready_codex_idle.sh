#!/usr/bin/env bash
# T15 — codex welcome banner + idle `›` placeholder = ready (positive override applies cross-CLI).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/codex_welcome_idle.txt" "$STUB_SCREEN_FILE"
export DISPATCH_SH_NO_MAIN=1
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
if is_ready sid-A codex; then echo "T15 PASS"; else echo "FAIL: codex welcome+idle prompt blocks is_ready" >&2; exit 1; fi
