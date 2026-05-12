#!/usr/bin/env bash
# T6 — --verify-delivered exits 0 when placeholder is gone after inject.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/postinject_ok.txt" "$STUB_SCREEN_FILE"
ref="$T_TMP/ref.md"
printf 'REPORT: DISPATCH_HC_IMPL_DONE incoming — wait\npayload body\n' > "$ref"
export DISPATCH_SH_NO_MAIN=1
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
ref_file="$ref"
# Skip 5s sleep
sleep() { :; }
export -f sleep
if verify_delivered sid-A; then echo "T6 PASS"; else echo "FAIL: should have detected delivered" >&2; exit 1; fi
