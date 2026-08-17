#!/usr/bin/env bash
# T119 (#899 tranche 4) — bin/telepty-bus-bridge.sh must work from an init-materialized
# workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler),
# T114 (hitl) and T117 (open-session), for the seventh shim. In the repo and in the
# installed npm package dist/ sits next to bin/, so "$SCRIPT_DIR/../dist" resolves.
# In a control workspace it does NOT: `init` copies bin/ out of the package via
# bin/init/manifest.mjs — which lists bin/telepty-bus-bridge.sh (line 54) and ships
# no dist entries at all — so dist/ stays behind in the package root.
#
# WHY THIS ONE MATTERS, and why the failure would be QUIET. Every other shim in this
# family is driven by a human or by a command whose exit code someone reads. This one
# is supervised: src/reconciler/cli.ts:1309 calls `--ensure` on every tick and does
# nothing with a non-zero result but log one line ("ERR bus-bridge ensure non-zero
# (continuing)") before carrying on with the rest of the tick. A shim that resolved
# only the sibling path would therefore leave a control workspace ticking healthily
# forever with NO bridge — and the visible symptom is not an error, it is
# consume_surface_orphaned / consume_surface_mismatched going dormant again, which is
# the exact dormancy #847 existed to end. Loud enough to catch here, silent enough in
# production to deserve a guard rather than an assumption.
#
# Beyond --help: --ensure actually starts a bridge from the workspace copy and that
# bridge SUBSCRIBES, because --help is answered by the compiled module alone while a
# subscription also has to reach the workspace's OWN bin/lib/telepty-listing.sh — the
# `bash -c '. lib; telepty_listing_verdict'` door onto the one lib this script did
# not stop sourcing, resolved through AIGENTRY_SHIM_SCRIPT_DIR. A port that resolved
# it relative to dist/ instead would answer --help and then run the REPO's
# reachability probe from inside a workspace. It is replaced with a recorder in the
# workspace copy, so "it reached the workspace's own bin/lib/" is measured rather
# than assumed.
#
# Hermetic: temp state, temp HOME, a recorder in place of the listing lib, an emitter
# stub for `telepty listen`, and the bridge is killed in the trap. No daemon is
# started, nothing touches :3848, and the live transport stays T95 part E's job.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"

t_setup
BRIDGE_PIDS=""
cleanup() {
  local p
  for p in $BRIDGE_PIDS; do kill "$p" 2>/dev/null || true; done
  t_teardown
}
trap cleanup EXIT

fail() { echo "FAIL[T119]: $*" >&2; exit 1; }

wait_for() {
  local limit="$1"; shift
  local tries=$(( limit * 5 ))
  while [ "$tries" -gt 0 ]; do
    if "$@"; then return 0; fi
    sleep 0.2
    tries=$(( tries - 1 ))
  done
  return 1
}

[ -f "$REPO_ROOT/dist/src/bus-bridge/cli.js" ] \
  || fail "dist/src/bus-bridge/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

export HOME="$T_TMP/home"
mkdir -p "$HOME"

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

BRIDGE="$WS/bin/telepty-bus-bridge.sh"
[ -x "$BRIDGE" ] \
  || fail "the workspace copy of bin/telepty-bus-bridge.sh is not executable — src/reconciler/cli.ts:1309 gates on executable() and would skip the bridge silently"

# ── (A) --help resolves the package's dist/ and reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$BRIDGE" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout telepty-bus-bridge.sh --help exited $rc — the shim did not resolve the package's dist/"
}
t_assert_contains "$OUT" "telepty-bus-bridge.sh --ensure  # start it if it is not running (reconciler tick)"
t_assert_contains "$OUT" "telepty-bus-bridge.sh --run     # the bridge itself; foreground, long-lived"

# ── (B) --ensure starts a bridge that reaches the WORKSPACE's own bin/lib/ ──
# The recorder stands in for bin/lib/telepty-listing.sh. It records that it was
# sourced from the workspace copy and returns the reachable verdict, so the bridge
# proceeds to subscribe without any daemon existing.
PROBE_LOG="$T_TMP/listing-probe.log"; : > "$PROBE_LOG"
cat > "$WS/bin/lib/telepty-listing.sh" <<EOF
#!/usr/bin/env bash
telepty_listing_verdict() {
  printf '%s\n' "verdict-called-from-workspace" >> "$PROBE_LOG"
  printf 'ok'
}
EOF

cat > "$STUB_BIN/telepty-listen" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "listen" ] && [ ! -f "$STUB_LISTEN_ONCE" ]; then
  : > "$STUB_LISTEN_ONCE"
  printf '%s\n' '{"type":"surface_orphaned","sid":"sid-T119","backend":"cmux","cmuxWorkspaceId":"WS-T119","surfaceGoneSeconds":5,"livenessVerdict":"gone","timestamp":"2026-08-17T00:00:00.000Z"}'
fi
sleep 120
EOF
chmod +x "$STUB_BIN/telepty-listen"
export STUB_LISTEN_ONCE="$T_TMP/listen-emitted"

WS_STATE="$T_TMP/ws-state"
mkdir -p "$WS_STATE"
set +e
PATH="$PKGBIN:$PATH" TELEPTY="$STUB_BIN/telepty-listen" \
  DISPATCH_STATE_DIR="$WS_STATE" BUS_BRIDGE_READ_TIMEOUT=1 \
  bash "$BRIDGE" --ensure > "$T_TMP/ensure.out" 2> "$T_TMP/ensure.err"
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "--- stderr ---" >&2; cat "$T_TMP/ensure.err" >&2
  fail "a workspace-layout --ensure exited $rc"; }

wait_for 20 test -s "$WS_STATE/bus-bridge.pid" \
  || fail "the workspace --ensure never started a bridge; err=$(cat "$WS_STATE/bus-bridge.err" 2>/dev/null)"
BRIDGE_PIDS="$(cat "$WS_STATE/bus-bridge.pid")"

wait_for 20 test -s "$PROBE_LOG" \
  || fail "the reachability probe did not reach the WORKSPACE's own bin/lib/telepty-listing.sh — AIGENTRY_SHIM_SCRIPT_DIR was not honoured, so a workspace bridge would run the REPO's lib"

wait_for 20 test -s "$WS_STATE/surface-orphaned.jsonl" \
  || fail "the workspace bridge never bridged an event; health=$(cat "$WS_STATE/bus-bridge-health.json" 2>/dev/null), err=$(cat "$WS_STATE/bus-bridge.err" 2>/dev/null)"
t_assert_contains "$WS_STATE/surface-orphaned.jsonl" '"sid":"sid-T119"'

# The self-respawn resolved the compiled module, not a path relative to the
# workspace: a bridge that could not re-exec itself would be a one-shot.
wait_for 20 grep -q '"state": "connected"' "$WS_STATE/bus-bridge-health.json" \
  || fail "the workspace bridge never reached state=connected: $(cat "$WS_STATE/bus-bridge-health.json" 2>/dev/null)"

# ── (C) neither layout is a fluke: the REPO tree (sibling dist/) still works ──
set +e
bash "$REPO_ROOT/bin/telepty-bus-bridge.sh" --help > "$T_TMP/repo-help.txt" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || { cat "$T_TMP/repo-help.txt" >&2; fail "the REPO-layout --help exited $rc"; }
t_assert_contains "$T_TMP/repo-help.txt" "telepty-bus-bridge.sh --ensure  # start it if it is not running (reconciler tick)"

echo "T119 PASS"
