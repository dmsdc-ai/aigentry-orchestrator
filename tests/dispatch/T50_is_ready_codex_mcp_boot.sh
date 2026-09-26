#!/usr/bin/env bash
# T50 (#557) — codex's interactive `›` REPL during MCP-server boot = ready.
# The "Starting MCP servers (n/6) … (esc to interrupt)" status line trips HARD_NEG
# via "esc to interrupt", but the prompt accepts input, so dispatch must NOT wait
# out the full (>30s) 6-server boot. The early init banner (no prompt) stays
# not-ready — see T12.
#
# #1136, CURRENT-viewport half. The recorded fixture's prompt row is
# ` › Use /skills to list available skills` — codex's OWN empty-composer placeholder, the
# same category as claude's `Try "…"` and codex's `Ask Codex to do anything`. It is
# admitted as ONE anchored literal for the codex kind only
# (session-probe.py CODEX_EMPTY_COMPOSER_HINT), and that arm says nothing beyond "the
# composer is empty". Blocks B–H below are the negatives that pin the boundary, each with
# the stub tripwires that prove WHERE the verdict came from: no generic `Use …` sentence,
# no typed command, no text trailing the literal, no active work, no approval or trust
# modal, no promptless startup, and not the claude kind. Block I is the fail-closed case:
# an uncertain binding must never reach a viewport at all. No blanket legacy busy bypass
# is ported and the boot status row is still not, by itself, work.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

# The legacy `telepty read-screen` ring keeps the recorded fixture, as it always did. The
# live path must not consult it — asserted per block, not assumed.
cp "$HERE/fixtures/codex_mcp_boot.txt" "$STUB_SCREEN_FILE"
t_current_view sid-A codex
t_history_read_tripwire

VIEW="$T_TMP/current-view.txt"

# probe <cli> — one is-ready measurement against the currently bound viewport. Resets the
# stub invocation records first so each block's controls measure THAT probe alone.
probe() {
  t_current_view_reset_log
  rc=0
  "$REPO_ROOT/bin/dispatch.sh" __probe is-ready sid-A "$1" || rc=$?
}

expect_ready() {
  t_assert_current_view_read "$1"
  t_assert_no_history_screen_read "$1"
  [ "$rc" -eq 0 ] || { echo "FAIL[$1]: $2" >&2; exit 1; }
}

expect_not_ready() {
  t_assert_current_view_read "$1"
  t_assert_no_history_screen_read "$1"
  [ "$rc" -ne 0 ] || { echo "FAIL[$1]: $2" >&2; exit 1; }
}

# ── A — the recorded fixture, served through the BOUND current viewport ──────────
# The fixture file itself is read verbatim; nothing is copied through or rewritten.
t_current_screen_file "$HERE/fixtures/codex_mcp_boot.txt"
probe codex
expect_ready "T50/A" "codex prompt during MCP boot blocked is_ready"

t_current_screen_file "$VIEW"

# ── B — a GENERIC `Use …` sentence on the prompt row is a populated composer ─────
cat > "$VIEW" <<'EOF'
• Starting MCP servers (1/6): aigentry-brain, codex_apps, computer-use, … (0s • esc to interrupt)
 › Use the migration plan in docs/plan.md
EOF
probe codex
expect_not_ready "T50/B" "generic 'Use …' text on the prompt row was accepted as an empty composer"

# ── C — a typed command is a populated composer ──────────────────────────────────
cat > "$VIEW" <<'EOF'
• Starting MCP servers (1/6): aigentry-brain, codex_apps, computer-use, … (0s • esc to interrupt)
 › /skills
EOF
probe codex
expect_not_ready "T50/C" "a non-empty command on the prompt row was accepted as an empty composer"

# ── D — the literal is anchored: nothing may trail it ────────────────────────────
cat > "$VIEW" <<'EOF'
• Starting MCP servers (1/6): aigentry-brain, codex_apps, computer-use, … (0s • esc to interrupt)
 › Use /skills to list available skills and then fix the build
EOF
probe codex
expect_not_ready "T50/D" "text trailing the placeholder literal was accepted as an empty composer"

# ── E — ACTIVE WORK still blocks, placeholder or not ─────────────────────────────
# The boot status row alone is not work (block A). A real working row is.
cat > "$VIEW" <<'EOF'
• Starting MCP servers (1/6): aigentry-brain, codex_apps, computer-use, … (0s • esc to interrupt)
• Working (5s · esc to interrupt)
 › Use /skills to list available skills
EOF
probe codex
expect_not_ready "T50/E" "active work alongside the placeholder was treated as ready"

# ── F — a codex approval modal blocks, placeholder or not ────────────────────────
cat > "$VIEW" <<'EOF'
• Starting MCP servers (1/6): aigentry-brain, codex_apps, computer-use, … (0s • esc to interrupt)
Would you like to run the following command?
  1. Yes
  2. No
 › Use /skills to list available skills
EOF
probe codex
expect_not_ready "T50/F" "a pending command-approval modal was treated as ready"

# ── G — a folder-trust modal blocks, placeholder or not ──────────────────────────
cat > "$VIEW" <<'EOF'
• Starting MCP servers (1/6): aigentry-brain, codex_apps, computer-use, … (0s • esc to interrupt)
Do you trust the contents of this project?
 › Use /skills to list available skills
EOF
probe codex
expect_not_ready "T50/G" "a pending folder-trust modal was treated as ready"

# ── H — PROMPTLESS MCP startup stays not-ready (the T12 boundary) ────────────────
cat > "$VIEW" <<'EOF'
╭───────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.133.0)                            │
╰───────────────────────────────────────────────────────╯

• Starting MCP servers (1/6): aigentry-brain, codex_apps, computer-use, … (0s • esc to interrupt)
EOF
probe codex
expect_not_ready "T50/H" "MCP startup with no usable prompt row was treated as ready"

# ── I — the arm is CODEX-ONLY: the same literal under claude is not a placeholder ─
# Rebinding resets STUB_CMUX_SCREEN_FILE, so point it at $VIEW again afterwards.
cat > "$VIEW" <<'EOF'
 ❯ Use /skills to list available skills
EOF
t_current_view sid-A claude
t_current_screen_file "$VIEW"
probe claude
expect_not_ready "T50/I" "codex's placeholder literal was accepted for the claude kind"

# ── J — an UNCERTAIN binding never reaches a viewport at all ─────────────────────
# Same ready-looking fixture, but the bound surface is no longer a terminal. The adapter
# must fail closed BEFORE read-screen: the tripwire asserts the tree lookup happened and
# the screen read did not, so "not ready" here is the binding refusing, not a classifier.
t_current_view sid-A codex
t_current_screen_file "$HERE/fixtures/codex_mcp_boot.txt"
export STUB_CMUX_SURFACE_TYPE=pane
probe codex
if ! grep -qF -- ' tree --workspace ' "$STUB_CMUX_LOG"; then
  echo "FAIL[T50/J]: the bound cmux tree lookup was never attempted" >&2
  cat "$STUB_CMUX_LOG" >&2 || true
  exit 1
fi
if grep -q 'read-screen' "$STUB_CMUX_LOG"; then
  echo "FAIL[T50/J]: a non-terminal surface was still read; the binding did not fail closed" >&2
  cat "$STUB_CMUX_LOG" >&2 || true
  exit 1
fi
t_assert_no_history_screen_read "T50/J"
[ "$rc" -ne 0 ] || { echo "FAIL[T50/J]: an uncertain binding was treated as ready" >&2; exit 1; }

echo "T50 PASS"
