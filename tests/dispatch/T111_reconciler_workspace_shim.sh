#!/usr/bin/env bash
# T111 (#899 tranche 2c) — bin/session-reconciler.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker) and T105 (cleanup), for the fourth
# shim. The reconciler is an exec shim onto dist/src/reconciler/cli.js now. In the
# repo and in the installed npm package dist/ sits next to bin/, so
# "$SCRIPT_DIR/../dist" resolves. In a control workspace it does NOT: `init` copies
# bin/ out of the package via bin/init/manifest.mjs, which ships no dist entries at
# all, so dist/ stays behind in the package root. A workspace's reconciler is the
# launchd tick — it runs every 60 seconds and it is the only thing that sweeps
# orphans, fires scheduled cleanups and pages about a stale orchestrator — so a shim
# that only tried the sibling path would silently leave a workspace with no safety
# net at all, and launchd would just restart the failure.
#
# Beyond T99's --help: a real TICK is asserted too, because --help is answered by
# the compiled module alone while a tick also has to reach the workspace's OWN
# bin/wh-cli.sh (the surface door), bin/dispatch-registry.py (the GC root) and
# bin/lib/platform.sh (the host-power / lid / session-pid door) through
# AIGENTRY_SHIM_SCRIPT_DIR. Those three are the reason this shim exports it: a port
# that resolved them relative to dist/ instead would pass --help and then run the
# repo's copies from inside a workspace. All three are replaced with RECORDERS in
# the workspace copy, so "it reached the workspace's own bin/" is measured rather
# than assumed.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build), reachable only as the `aigentry-orchestrator`
#                  bin on PATH, exactly as npm installs it
#
# Throwaway sids only; telepty is stubbed, every actuator is a no-op and the
# workspace-host door is a recorder, so no daemon is contacted and no real session
# or workspace is touched.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T111]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/reconciler/cli.js" ] \
  || fail "dist/src/reconciler/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

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

RECON="$WS/bin/session-reconciler.sh"

# ── (A) --help resolves the package's dist/ and reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$RECON" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout session-reconciler.sh --help exited $rc — the shim did not resolve the package's dist/"
}
# …and it reached the REAL implementation, not merely something that exits 0.
t_assert_contains "$OUT" "60s level-triggered safety net"
t_assert_contains "$OUT" "Exponential backoff: per-sid retry counter"

# ── (B) a real tick reaches the WORKSPACE's own bin/ helpers ──
# Recorders in place of the three helpers the shim must resolve through
# AIGENTRY_SHIM_SCRIPT_DIR. If any were resolved relative to dist/ (i.e. the repo's
# bin/), its log would stay empty here while the tick still exited 0.
WH_LOG="$T_TMP/wh.log"; : > "$WH_LOG"
cat > "$WS/bin/wh-cli.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WH_LOG"
exit 0
EOF
REG_LOG="$T_TMP/registry.log"; : > "$REG_LOG"
cat > "$WS/bin/dispatch-registry.py" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REG_LOG"
exit 0
EOF
PLAT_LOG="$T_TMP/platform.log"; : > "$PLAT_LOG"
# The platform door is SOURCED by the caller (bash -c '. lib; fn'), so the recorder
# is a lib that defines the three functions this tick uses, not an executable.
cat > "$WS/bin/lib/platform.sh" <<EOF
#!/usr/bin/env bash
platform::host_power_state() { printf '%s\n' "\$*" >> "$PLAT_LOG"; printf 'awake\n'; }
platform::lid_closed()       { printf 'lid\n'   >> "$PLAT_LOG"; return 2; }
platform::session_pid()      { printf 'pid %s\n' "\${1:-}" >> "$PLAT_LOG"; printf ''; }
EOF
chmod +x "$WS/bin/wh-cli.sh" "$WS/bin/dispatch-registry.py"

NOOP="$T_TMP/noop.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$NOOP"
chmod +x "$NOOP"

# One session that is NOT in the (recorder-emptied) registry and is old enough to be
# examined, so the sweep actually reaches wh_lookup / platform::session_pid.
cat > "$STUB_LIST_FILE" <<'EOF'
[{"id":"sid-T111","healthStatus":"DISCONNECTED","startedAt":"2026-08-16T11:00:00Z","lastSeenAt":"2026-08-16T11:50:00Z","cmuxWorkspaceId":"WS-T111"}]
EOF

RUN_LOG="$T_TMP/tick.log"
set +e
PATH="$PKGBIN:$PATH" \
RECONCILER_NOW="2026-08-16T12:00:00Z" \
TELEPTY="$STUB_BIN/telepty" \
CLEANUP_SH="$NOOP" SCHEDULER_SH="$NOOP" TRACKER_SH="$NOOP" \
COMMS_AUDITOR_SH="$NOOP" BRIDGE_AUDITOR_SH="$NOOP" BUS_BRIDGE_SH="$NOOP" HITL_SH="$NOOP" \
  bash "$RECON" > "$RUN_LOG" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "--- tick ---" >&2; cat "$RUN_LOG" >&2
  fail "a workspace-layout tick exited $rc"; }

grep -q "^lookup sid-T111" "$WH_LOG" \
  || { echo "--- wh-cli calls ---" >&2; cat "$WH_LOG" >&2
       fail "the surface lookup did not reach the WORKSPACE's own bin/wh-cli.sh — AIGENTRY_SHIM_SCRIPT_DIR was not honoured"; }
grep -q "^prune-orphans " "$WH_LOG" \
  || { echo "--- wh-cli calls ---" >&2; cat "$WH_LOG" >&2
       fail "step 2b's prune did not reach the workspace's own bin/wh-cli.sh"; }
grep -q -- "list --not-retired --fields assigned.sid" "$REG_LOG" \
  || { echo "--- registry calls ---" >&2; cat "$REG_LOG" >&2
       fail "the GC root did not reach the WORKSPACE's own bin/dispatch-registry.py"; }
grep -q "^pid sid-T111" "$PLAT_LOG" \
  || { echo "--- platform calls ---" >&2; cat "$PLAT_LOG" >&2
       fail "platform::session_pid did not reach the WORKSPACE's own bin/lib/platform.sh"; }
grep -q "^lid" "$PLAT_LOG" \
  || { echo "--- platform calls ---" >&2; cat "$PLAT_LOG" >&2
       fail "platform::lid_closed did not reach the workspace's own bin/lib/platform.sh"; }

# ── (C) neither layout is a fluke: the same tick from the REPO tree still works ──
# (the sibling-dist arm of bin/lib/node-shim.sh, which A and B never exercise).
# The workspace host is forced to `headless` here — a pure no-op adapter — so the
# real bin/wh-cli.sh contacts nothing.
RUN2="$T_TMP/tick-repo.log"
set +e
RECONCILER_NOW="2026-08-16T12:00:00Z" \
AIGENTRY_WORKSPACE_HOST=headless \
TELEPTY="$STUB_BIN/telepty" \
DISPATCH_REGISTRY_PY="$WS/bin/dispatch-registry.py" \
CLEANUP_SH="$NOOP" SCHEDULER_SH="$NOOP" TRACKER_SH="$NOOP" \
COMMS_AUDITOR_SH="$NOOP" BRIDGE_AUDITOR_SH="$NOOP" BUS_BRIDGE_SH="$NOOP" HITL_SH="$NOOP" \
  bash "$REPO_ROOT/bin/session-reconciler.sh" > "$RUN2" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "--- tick ---" >&2; cat "$RUN2" >&2
  fail "the repo-tree layout (sibling dist/) stopped working"; }
grep -q "tick: gc_root=" "$RUN2" \
  || { echo "--- tick ---" >&2; cat "$RUN2" >&2; fail "the repo-tree tick did not complete"; }

echo "T111 PASS"
