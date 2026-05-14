#!/usr/bin/env bash
# T13 — `Working... esc to interrupt` in last3 = not-ready (hard-negative guard).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/working_active.txt" "$STUB_SCREEN_FILE"
export DISPATCH_SH_NO_MAIN=1
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
if is_ready sid-A claude; then echo "FAIL: working-active returned ready" >&2; exit 1; else echo "T13 PASS"; fi
