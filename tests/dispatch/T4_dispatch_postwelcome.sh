#!/usr/bin/env bash
# T4 — dispatch.sh is_ready accepts post-welcome `❯ Try "..."` placeholder.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/postwelcome.txt" "$STUB_SCREEN_FILE"
# #751: `__probe is-ready` reads the CURRENT viewport, never the legacy read-screen ring.
# Bind one — fixture sid, fake uuids, owned stubs — and serve THIS fixture through it.
# The assertion below is unchanged; only the transport carrying the screen is.
t_current_view sid-A claude
rc=0; "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A claude || rc=$?
t_assert_current_view_read T4
if [ "$rc" -eq 0 ]; then echo "T4 PASS"; else echo "FAIL: is_ready=0 on postwelcome" >&2; exit 1; fi
