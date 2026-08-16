#!/usr/bin/env bash
# T14 — Trust-folder modal with `Press Enter to continue` in last3 = not-ready
# (hard-negative guard prevents the new positive-override from accepting the prompt symbol).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/trust_folder_modal.txt" "$STUB_SCREEN_FILE"
if "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A claude; then echo "FAIL: trust-folder modal returned ready" >&2; exit 1; else echo "T14 PASS"; fi
