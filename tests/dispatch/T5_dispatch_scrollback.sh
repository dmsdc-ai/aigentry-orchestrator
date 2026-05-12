#!/usr/bin/env bash
# T5 — Old welcome banner in scrollback is ignored; tail prompt = ready.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/scrollback_welcome.txt" "$STUB_SCREEN_FILE"
export DISPATCH_SH_NO_MAIN=1
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
if is_ready sid-A claude; then echo "T5 PASS"; else echo "FAIL: stale scrollback welcome still blocks is_ready" >&2; exit 1; fi
