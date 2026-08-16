#!/usr/bin/env bash
# T4 — dispatch.sh is_ready accepts post-welcome `❯ Try "..."` placeholder.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/postwelcome.txt" "$STUB_SCREEN_FILE"
if "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A claude; then echo "T4 PASS"; else echo "FAIL: is_ready=0 on postwelcome" >&2; exit 1; fi
