#!/usr/bin/env bash
# T7 — --verify-delivered returns failure when placeholder stays.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/postinject_fail.txt" "$STUB_SCREEN_FILE"
ref="$T_TMP/ref.md"
printf 'a unique-line that will NOT appear on screen\n' > "$ref"
export AIGENTRY_DISPATCH_VERIFY_SLEEP_MS=0
if "$REPO_ROOT/bin/dispatch.sh" __probe verify-delivered --ref "$ref" sid-A; then
  echo "FAIL: should NOT have detected delivered" >&2; exit 1
fi
echo "T7 PASS"
