#!/usr/bin/env bash
# T117 (#899 tranche 3a) — bin/open-session.sh must work from an init-materialized
# workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler)
# and T114 (hitl), for the sixth shim. bin/open-session.sh is an exec shim onto
# dist/src/session/open-session/cli.js now. In the repo and in the installed npm
# package dist/ sits next to bin/, so "$SCRIPT_DIR/../dist" resolves. In a control
# workspace it does NOT: `init` copies bin/ out of the package via
# bin/init/manifest.mjs, which ships no dist entries at all, so dist/ stays behind
# in the package root.
#
# WHY THIS ONE MATTERS. open-session is the LIVE SPAWN PATH: `bin/dispatch.sh
# --spawn-and-dispatch` → boot-prepare → here, and it is 100 % of delegation. A
# shim that resolved only the sibling path would leave every control workspace able
# to dispatch and unable to spawn — the orchestrator's turn would see a non-zero
# exit from a script that used to be pure bash and had no build step at all. That
# failure is loud, which is the good news; it is also total, which is why it gets
# its own guard rather than an assumption.
#
# Beyond --help: a real spawn is asserted too, because --help is answered by the
# compiled module alone while a spawn also has to reach the workspace's OWN
# bin/wh-cli.sh — the door onto bin/lib/workspace-host.sh, which stays bash (T3b
# declined) and which is the one bin/ helper this script resolves through
# AIGENTRY_SHIM_SCRIPT_DIR. A port that resolved it relative to dist/ instead would
# pass --help and then drive the REPO's adapter from inside a workspace. It is
# replaced with a recorder in the workspace copy, so "it reached the workspace's own
# bin/" is measured rather than assumed.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build), reachable only as the `aigentry-orchestrator`
#                  bin on PATH, exactly as npm installs it
#
# Hermetic: temp HOME (so the real ~/.aigentry/open-session.log is never touched),
# a recorder in place of wh-cli.sh, CTX_ROUTER_PATH pointed at nothing,
# AIGENTRY_SLEEP_GUARD=0 from lib.sh, and a throwaway track/name only. No cmux, no
# telepty daemon, no live surface.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T117]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/session/open-session/cli.js" ] \
  || fail "dist/src/session/open-session/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

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

OPEN="$WS/bin/open-session.sh"
[ -x "$OPEN" ] || fail "the workspace copy of bin/open-session.sh is not executable — dispatch execs it directly"

# ── (A) --help resolves the package's dist/ and reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$OPEN" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout open-session.sh --help exited $rc — the shim did not resolve the package's dist/"
}
# …and it reached the REAL implementation, not merely something that exits 0.
t_assert_contains "$OUT" "# open-session.sh — Open an aigentry session in the user's current terminal environment"
t_assert_contains "$OUT" '# Session id (SID) convention: {track}-{name}  (e.g. "B-architect-264")'

# ── (B) a real spawn reaches the WORKSPACE's own bin/wh-cli.sh ──
# The recorder answers the three verbs open-session reaches — and only those three.
# An unknown verb is a hard failure here rather than a shrug, because a port that
# grew a fourth door would otherwise be invisible until it hit production.
WH_LOG="$T_TMP/wh.log"; : > "$WH_LOG"
cat > "$WS/bin/wh-cli.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WH_LOG"
case "\${1:-}" in
  detect-terminal) echo cmux ;;
  open)            echo workspace:117 ;;
  set-status)      : ;;
  *) echo "recorder: unexpected verb '\${1:-}'" >&2; exit 70 ;;
esac
exit 0
EOF
chmod +x "$WS/bin/wh-cli.sh"

HOME_WS="$T_TMP/home-ws"; mkdir -p "$HOME_WS"
set +e
ref=$(PATH="$PKGBIN:$PATH" HOME="$HOME_WS" CTX_ROUTER_PATH=/nonexistent \
  AIGENTRY_CONFIG="$T_TMP/no-such-config.json" \
  bash "$OPEN" --track t117 --name ws --cwd "$T_TMP/cwd-ws" --cli claude 2> "$T_TMP/ws.err")
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "--- stderr ---" >&2; cat "$T_TMP/ws.err" >&2
  fail "a workspace-layout spawn exited $rc"; }
[ "$ref" = "workspace:117" ] || fail "workspace spawn printed '$ref', want 'workspace:117'"
grep -qxF "detect-terminal" "$WH_LOG" \
  || { echo "--- wh-cli calls ---" >&2; cat "$WH_LOG" >&2
       fail "detect-terminal did not reach the WORKSPACE's own bin/wh-cli.sh — AIGENTRY_SHIM_SCRIPT_DIR was not honoured"; }
grep -qxF "open t117-ws $T_TMP/cwd-ws claude --model claude-opus-4-8 --effort xhigh --permission-mode bypassPermissions" "$WH_LOG" \
  || { echo "--- wh-cli calls ---" >&2; cat "$WH_LOG" >&2
       fail "the spawn's open argv changed, or did not reach the workspace's own wh-cli.sh"; }
grep -qxF "set-status workspace:117 working" "$WH_LOG" \
  || { echo "--- wh-cli calls ---" >&2; cat "$WH_LOG" >&2
       fail "the #616 pill did not reach the workspace's own wh-cli.sh"; }
# The log line landed under the workspace-run's HOME, not the operator's.
[ -f "$HOME_WS/.aigentry/open-session.log" ] \
  || fail "a workspace-layout spawn wrote no ~/.aigentry/open-session.log line"
grep -qF "ref=workspace:117 sid=t117-ws" "$HOME_WS/.aigentry/open-session.log" \
  || fail "the workspace log line is malformed: $(cat "$HOME_WS/.aigentry/open-session.log")"

# ── (C) neither layout is a fluke: the REPO tree (sibling dist/) still works ──
# Same recorder idiom, pointed at the repo's own shim, which finds dist/ as a
# sibling. AIGENTRY_SHIM_SCRIPT_DIR is what the repo shim exports for itself, so
# this arm drives the REAL bin/wh-cli.sh against a fake cmux instead.
STUB="$T_TMP/cmux-stub"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  new-workspace)    echo "OK workspace:118" ;;
  list-workspaces)  echo "  workspace:118  faketitle" ;;
  surface-health)   echo "surface:9  type=terminal in_window=false" ;;
  read-screen)      echo "  claude prompt rendered" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$STUB"
HOME_REPO="$T_TMP/home-repo"; mkdir -p "$HOME_REPO"
set +e
rref=$(HOME="$HOME_REPO" CTX_ROUTER_PATH=/nonexistent \
  AIGENTRY_CONFIG="$T_TMP/no-such-config.json" \
  CMUX_WORKSPACE_ID=t117 CMUX="$STUB" AIGENTRY_WORKSPACE_HOST=cmux \
  CMUX_READY_TIMEOUT_MS=2000 CMUX_READY_INTERVAL_MS=10 \
  bash "$REPO_ROOT/bin/open-session.sh" --track t117 --name repo --cwd "$T_TMP/cwd-repo" --cli claude \
  2> "$T_TMP/repo.err")
rc=$?
set -e
[ "$rc" -eq 0 ] || { cat "$T_TMP/repo.err" >&2; fail "the repo-tree layout (sibling dist/) stopped working"; }
[ "$rref" = "workspace:118" ] || fail "the repo-tree spawn printed '$rref', want 'workspace:118'"

echo "T117 PASS layouts=workspace+repo doors=detect-terminal/open/set-status"
