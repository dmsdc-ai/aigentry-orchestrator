#!/usr/bin/env bash
# T105 (#899 tranche 2a) — bin/session-cleanup.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch) and T100 (tracker), for the third shim.
# session-cleanup.sh is an exec shim onto dist/src/cleanup/cli.js now. In the repo
# and in the installed npm package dist/ sits next to bin/, so "$SCRIPT_DIR/../dist"
# resolves. In a control workspace it does NOT: `init` copies bin/ out of the
# package via bin/init/manifest.mjs, which ships no dist entries at all, so dist/
# stays behind in the package root. A workspace's reconciler calls this script on
# every scheduled cleanup and `--auto-cleanup-on-exit` calls it on every session
# teardown, so a shim that only tried the sibling path would leave a workspace
# unable to remove any session at all — and silently, because the reconciler
# swallows a non-zero cleanup.
#
# Beyond T99's --help: a workspace TEARDOWN is asserted too, because --help is
# answered by the compiled module alone while a real cleanup also has to reach the
# workspace's OWN bin/wh-cli.sh (the surface-close door) and bin/dispatch-registry.py
# through AIGENTRY_SHIM_SCRIPT_DIR. Those two are the reason this shim exports it:
# a port that resolved them relative to dist/ instead would pass --help and destroy
# nothing in a workspace. Both are replaced with RECORDERS inside the workspace
# copy, so "it reached the workspace's own bin/" is measured rather than assumed.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to
#                  the repo's real build), reachable only as the
#                  `aigentry-orchestrator` bin on PATH, exactly as npm installs it
#
# Throwaway sid only; telepty/curl are stubbed and the surface close is a recorder,
# so no daemon is contacted and no real session or workspace is touched.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T105]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/cleanup/cli.js" ] \
  || fail "dist/src/cleanup/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

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

CLEANUP="$WS/bin/session-cleanup.sh"

# ── (A) --help resolves the package's dist/ and reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$CLEANUP" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout session-cleanup.sh --help exited $rc — the shim did not resolve the package's dist/"
}
# …and it reached the REAL implementation, not merely something that exits 0.
t_assert_contains "$OUT" "Actually remove orchestrator-spawned sessions"
t_assert_contains "$OUT" "DELETE /api/sessions/<sid> on local daemon"

# ── (B) a real teardown reaches the WORKSPACE's own bin/ helpers ──
# Recorders in place of the two helpers the shim must resolve through
# AIGENTRY_SHIM_SCRIPT_DIR. If either were resolved relative to dist/ (i.e. the
# repo's bin/), its log would stay empty here while the run still exited 0.
WH_LOG="$T_TMP/wh.log"
cat > "$WS/bin/wh-cli.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WH_LOG"
exit 0
EOF
REG_LOG="$T_TMP/registry.log"
cat > "$WS/bin/dispatch-registry.py" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REG_LOG"
exit 0
EOF
chmod +x "$WS/bin/wh-cli.sh" "$WS/bin/dispatch-registry.py"

CURL_LOG="$T_TMP/curl.log"; export CURL_LOG
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf 'ARGV %s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *DELETE*) echo 404;;   # already gone
  *)        echo 200;;   # the #835 corroboration probe: a genuinely empty daemon
esac
EOF
chmod +x "$STUB_BIN/curl"

# A genuinely empty daemon → the telepty-orphan teardown path (#323/#340).
SID="orphan-sid-T105"
printf '%s' '[]' > "$STUB_LIST_FILE"
: > "$WH_LOG"; : > "$REG_LOG"; : > "$CURL_LOG"

PATH="$PKGBIN:$PATH" HOME="$T_TMP/home" bash "$CLEANUP" "$SID" >/dev/null 2>&1 \
  || fail "a workspace-layout cleanup of a telepty-orphan exited non-zero"

grep -qx "close-for-sid $SID" "$WH_LOG" \
  || { echo "--- wh-cli calls ---" >&2; cat "$WH_LOG" >&2
       fail "the surface close did not reach the WORKSPACE's own bin/wh-cli.sh — AIGENTRY_SHIM_SCRIPT_DIR was not honoured"; }
grep -q -- "--kind session_absent_observed --all" "$REG_LOG" \
  || { echo "--- registry calls ---" >&2; cat "$REG_LOG" >&2
       fail "the registry retire did not reach the WORKSPACE's own bin/dispatch-registry.py"; }
grep -q "ARGV .*-X DELETE .*/api/sessions/$SID" "$CURL_LOG" \
  || { echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
       fail "the registry DELETE was lost in the workspace layout"; }

# ── (C) neither layout is a fluke: the same run from the REPO tree still works ──
# (the sibling-dist arm of bin/lib/node-shim.sh, which A and B never exercise).
# This one runs the REAL bin/wh-cli.sh, so the adapter is forced to `headless` —
# a pure no-op — and the registry stays the recorder: no live surface is probed.
: > "$CURL_LOG"
HOME="$T_TMP/home" AIGENTRY_WORKSPACE_HOST=headless \
  DISPATCH_REGISTRY_PY="$WS/bin/dispatch-registry.py" \
  bash "$REPO_ROOT/bin/session-cleanup.sh" "$SID" >/dev/null 2>&1 \
  || fail "the repo-tree layout (sibling dist/) stopped working"
grep -q "ARGV .*-X DELETE .*/api/sessions/$SID" "$CURL_LOG" \
  || fail "the repo-tree run did not reach the registry DELETE"

echo "T105 PASS"
