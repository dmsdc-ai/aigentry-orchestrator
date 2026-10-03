#!/usr/bin/env bash
# T15 — codex welcome banner + idle `›` placeholder = ready (positive override applies cross-CLI).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/codex_welcome_idle.txt" "$STUB_SCREEN_FILE"
# #751: `__probe is-ready` reads the CURRENT viewport, never the legacy read-screen ring.
# Bind one — fixture sid, fake uuids, owned stubs — and serve THIS fixture through it.
# The assertion below is unchanged; only the transport carrying the screen is.
t_current_view sid-A codex
rc=0; "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A codex || rc=$?
t_assert_current_view_read T15
if [ "$rc" -eq 0 ]; then echo "T15 PASS"; else echo "FAIL: codex welcome+idle prompt blocks is_ready" >&2; exit 1; fi
