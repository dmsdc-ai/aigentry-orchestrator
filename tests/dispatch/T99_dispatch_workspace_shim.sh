#!/usr/bin/env bash
# T99 (#899 tranche 1) — bin/dispatch.sh must work from an init-materialized
# workspace, where there is no sibling dist/.
#
# dispatch.sh is an exec shim onto dist/src/dispatch/cli.js now. In the repo and
# in the installed npm package, dist/ sits next to bin/, so `$SCRIPT_DIR/../dist`
# resolves. In a control workspace it does NOT: `init` copies bin/ (and the
# doctrine) out of the package via bin/init/manifest.mjs, which ships no dist
# entries at all — dist/ stays behind in the package root. The first cut of the
# shim only tried the sibling path and every workspace dispatch would have died
# on a missing file; tests/packaging/smoke-init.sh (h) caught it on CI, and this
# guard is the cheap always-run version of that catch, so the workspace layout
# cannot regress silently between full packaging runs.
#
# Layout materialized here (the two directories the shim must bridge):
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to
#                  the repo's real build), reachable only as the
#                  `aigentry-orchestrator` bin on PATH, exactly as npm installs it
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T99]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/dispatch/cli.js" ] \
  || fail "dist/src/dispatch/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

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

OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$WS/bin/dispatch.sh" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout dispatch.sh --help exited $rc — the shim did not resolve the package's dist/"
}

# …and it reached the REAL implementation, not merely something that exits 0.
# The knob line is the same one T60 pins in --help, so a shim that silently
# printed nothing would not pass here either.
t_assert_contains "$OUT" "AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS"
t_assert_contains "$OUT" "180000"

echo "T99 PASS"
