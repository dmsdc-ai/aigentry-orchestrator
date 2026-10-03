#!/usr/bin/env bash
# T5 — Old welcome banner in scrollback is ignored; tail prompt = ready.
#
# THE REQUIREMENT IS UNCHANGED, the transport under it is not. #751 moved live readiness
# onto a BOUND CURRENT viewport (bin/current_screen.py) and removed the historical
# `telepty read-screen` ring from that path entirely — a stale ring reading as live
# evidence was the bug. T5's property is exactly the one that move is supposed to
# guarantee, so it is measured the way it is actually meant:
#
#   Block A — the historical ring still serves the ORIGINAL scrollback fixture, byte for
#     byte, trust line and "Press Enter to continue" included. An INDEPENDENT bound cmux
#     viewport shows a settled, empty composer. Readiness must follow the LIVE viewport,
#     and the historical ring must never be read on this path at all.
#   Block B — the paired negative that keeps block A honest. The SAME trust/modal text,
#     moved INTO the current viewport and dressed with an idle-looking Claude footer, must
#     BLOCK readiness. A live modal is a live modal regardless of the chrome around it.
#
# So neither escape hatch is available: deleting the trust text from the fixture, or
# narrowing the current modal detector, makes block A pass and block B fail. Nothing here
# re-enables the history fallback, and the two viewports are guard-local files under
# $T_TMP — no fixtures/ file is added or edited.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

# The historical ring: the original fixture, unmodified.
cp "$HERE/fixtures/scrollback_welcome.txt" "$STUB_SCREEN_FILE"
t_current_view sid-A claude
t_history_read_tripwire
t_current_screen_file "$T_TMP/current-view.txt"

# ── Block A — genuinely idle CURRENT viewport, stale banner only in history ──────
cat > "$T_TMP/current-view.txt" <<'EOF'
ran a quick build
build succeeded
all green

 ❯ Try "what should I work on next?"
EOF
t_current_view_reset_log
rc=0; "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A claude || rc=$?
t_assert_current_view_read "T5/A"
t_assert_no_history_screen_read "T5/A"
if [ "$rc" -ne 0 ]; then
  echo "FAIL: stale scrollback welcome still blocks is_ready" >&2
  exit 1
fi

# ── Block B — the SAME trust/modal text, now live in the CURRENT viewport ────────
# An idle-looking footer does not make an unanswered modal idle.
cat > "$T_TMP/current-view.txt" <<'EOF'
Welcome back to Claude
Tips for getting started in this project
Trust this folder to enable tools
Press Enter to continue and dismiss this banner

 ❯ Try "what should I work on next?"
  ? for shortcuts · shift+tab to cycle
EOF
t_current_view_reset_log
rc=0; "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A claude || rc=$?
t_assert_current_view_read "T5/B"
t_assert_no_history_screen_read "T5/B"
if [ "$rc" -eq 0 ]; then
  echo "FAIL: trust/continue modal IN the current viewport was treated as ready" >&2
  exit 1
fi

echo "T5 PASS"
