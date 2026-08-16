#!/usr/bin/env bash
# T6 — --verify-delivered exits 0 when placeholder is gone after inject.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/postinject_ok.txt" "$STUB_SCREEN_FILE"
ref="$T_TMP/ref.md"
printf 'REPORT: DISPATCH_HC_IMPL_DONE incoming — wait\npayload body\n' > "$ref"
# Skip the 5s settle wait (#899: an env seam now, not a `sleep` builtin override).
export AIGENTRY_DISPATCH_VERIFY_SLEEP_MS=0
if "$REPO_ROOT/bin/dispatch.sh" __probe verify-delivered --ref "$ref" sid-A; then echo "T6 PASS"; else echo "FAIL: should have detected delivered" >&2; exit 1; fi
