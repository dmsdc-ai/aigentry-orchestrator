#!/usr/bin/env bash
# T100 (#899 tranche 1b) — bin/dispatch-tracker.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99, for the second shim. dispatch-tracker.sh is an exec shim onto
# dist/src/tracker/cli.js now. In the repo and in the installed npm package dist/
# sits next to bin/, so "$SCRIPT_DIR/../dist" resolves. In a control workspace it
# does NOT: `init` copies bin/ out of the package via bin/init/manifest.mjs, which
# ships no dist entries at all, so dist/ stays behind in the package root. The
# reconciler tick in a workspace calls this script every 60 seconds, so a shim that
# only tried the sibling path would take the whole health-check offline there —
# silently, because the tick swallows a non-zero tracker (session-reconciler.sh:700).
#
# Both shims share ONE resolver (bin/lib/node-shim.sh), and this guard exists so
# the tracker's use of it is measured rather than assumed: a lib is only shared if
# both call sites are pinned.
#
# Beyond T99's --help: a workspace `status` run is asserted too, because --help is
# answered by the compiled module alone while `status` also has to reach the
# workspace's OWN bin/dispatch-registry.py through AIGENTRY_SHIM_SCRIPT_DIR. That
# is the second half of the layout the shim has to bridge.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to
#                  the repo's real build), reachable only as the
#                  `aigentry-orchestrator` bin on PATH, exactly as npm installs it
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T100]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/tracker/cli.js" ] \
  || fail "dist/src/tracker/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

# ── the workspace: bin/ without dist/ ──
WS="$T_TMP/workspace"
mkdir -p "$WS"
cp -R "$REPO_ROOT/bin" "$WS/bin"
[ ! -e "$WS/dist" ] || fail "fixture is wrong: the workspace must not have a dist/"

# ── the installed package, reachable only via its bin on PATH ──
PKG="$T_TMP/pkg"
mkdir -p "$PKG/bin/init"
printf '%s\n' '#!/usr/bin/env node' > "$PKG/bin/init/cli.mjs"
chmod +x "$PKG/bin/init/cli.mjs"
ln -s "$REPO_ROOT/dist" "$PKG/dist"
PKGBIN="$T_TMP/pkgbin"
mkdir -p "$PKGBIN"
ln -s "$PKG/bin/init/cli.mjs" "$PKGBIN/aigentry-orchestrator"

# ── (1) --help reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$WS/bin/dispatch-tracker.sh" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout dispatch-tracker.sh --help exited $rc — the shim did not resolve the package's dist/"
}
# …and it printed the header the retired `sed -n '2,22p' "$0"` printed, so a shim
# that silently emitted nothing would not pass here either.
t_assert_contains "$OUT" "dispatch-tracker.sh check"
t_assert_contains "$OUT" "one-shot scan; alerts to stdout + log"

# ── (2) a real subcommand resolves the workspace's own bin/ helpers ──
t_seed_dispatch sid-A expected_report_by="2026-05-12T11:30:00Z"
OUT2="$T_TMP/status.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$WS/bin/dispatch-tracker.sh" status > "$OUT2" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT2" >&2
  fail "a workspace-layout dispatch-tracker.sh status exited $rc"
}
t_assert_contains "$OUT2" "sid-A"
t_assert_contains "$OUT2" "delivery_attempt_started"

echo "T100 PASS"
