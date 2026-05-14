#!/usr/bin/env bash
# T12 — real boot (banner only, no prompt in last3) = not-ready.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/boot_no_prompt.txt" "$STUB_SCREEN_FILE"
export DISPATCH_SH_NO_MAIN=1
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
if is_ready sid-A claude; then echo "FAIL: boot-only banner returned ready" >&2; exit 1; else echo "T12 PASS"; fi
