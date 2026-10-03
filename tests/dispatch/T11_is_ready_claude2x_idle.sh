#!/usr/bin/env bash
# T11 — Claude 2.x welcome banner + idle `❯ Try "..."` placeholder = ready (telepty#22 fallback).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/claude2x_welcome_idle.txt" "$STUB_SCREEN_FILE"
# #751: `__probe is-ready` reads the CURRENT viewport, never the legacy read-screen ring.
# Bind one — fixture sid, fake uuids, owned stubs — and serve THIS fixture through it.
# The assertion below is unchanged; only the transport carrying the screen is.
t_current_view sid-A claude
rc=0; "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A claude || rc=$?
t_assert_current_view_read T11
if [ "$rc" -eq 0 ]; then echo "T11 PASS"; else echo "FAIL: Claude 2.x welcome+idle prompt blocks is_ready" >&2; exit 1; fi
