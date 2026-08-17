#!/usr/bin/env bash
# T125 (#899 tranche 5) — bin/inject-handler.sh must work from an init-materialized
# workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler),
# T114 (hitl), T117 (open-session), T121 (cleanup-scheduler) and T123 (comms-auditor),
# for the ninth shim. bin/inject-handler.sh is an exec shim onto
# dist/src/inject-handler/cli.js now. In the repo and in the installed npm package
# dist/ sits next to bin/, so "$SCRIPT_DIR/../dist" resolves. In a control workspace it
# does NOT: `init` copies bin/ out of the package via bin/init/manifest.mjs (which
# lists this script at :31 and ships no dist entries at all), so dist/ stays behind in
# the package root.
#
# WHY THIS ONE MATTERS TWICE. First, the arms: a workspace operator piping a worker's
# CLEANUP_REQUEST or TEST_REPORT into a shim that could not resolve its implementation
# would get exit 2 and no Layer-D arming — recoverable, because it is loud. Second, and
# the reason both live verbs are driven here rather than only `--help`: this shim
# resolves TWO of its own bin/ helpers at runtime (dispatch-cleanup-scheduler.sh,
# dispatch-registry.py) and one state root (state/dispatch, state/test-reports) from
# the shim's own directory. A port that resolved those relative to dist/ would answer
# `--help` perfectly and then, from inside a workspace, arm cleanups on the REPO's
# queue and write test reports into the REPO's tree — the workspace's own sessions
# never scheduled, another checkout's state mutated, and nothing anywhere saying so.
# Both helpers are replaced with recorders in the workspace copy, so "it reached the
# workspace's own bin/" is measured rather than assumed.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build), reachable only as the `aigentry-orchestrator`
#                  bin on PATH, exactly as npm installs it
#
# Hermetic: the temp state dir from lib.sh, recorders for both children, a throwaway
# sid only. This script contacts no daemon in any layout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T125]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/inject-handler/cli.js" ] \
  || fail "dist/src/inject-handler/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

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

HANDLER="$WS/bin/inject-handler.sh"
[ -x "$HANDLER" ] || fail "the workspace copy is not executable — every caller execs it directly"

# ── (A) --help resolves the package's dist/ and reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$HANDLER" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout inject-handler.sh --help exited $rc — the shim did not resolve the package's dist/"
}
# …and it reached the REAL implementation, not merely something that exits 0.
t_assert_contains "$OUT" "# inject-handler.sh — Orchestrator-side dispatcher for incoming inject envelopes."
t_assert_contains "$OUT" "#   inject-handler.sh < body.txt"

# ── (B) a real cleanup-request reaches the WORKSPACE's own bin/ scheduler ──
# If the scheduler were resolved relative to dist/ (i.e. the repo's bin/), this log
# would stay empty while the run still exited 0 — a workspace whose Layer D silently
# arms on another checkout's queue.
SCHED_LOG="$T_TMP/scheduler.log"
cat > "$WS/bin/dispatch-cleanup-scheduler.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SCHED_LOG"
exit 0
EOF
REG_LOG="$T_TMP/registry.log"
cat > "$WS/bin/dispatch-registry.py" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REG_LOG"
exit 0
EOF
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$WS/bin/emit-telemetry.mjs"
chmod +x "$WS/bin/dispatch-cleanup-scheduler.sh" "$WS/bin/dispatch-registry.py" "$WS/bin/emit-telemetry.mjs"
: > "$SCHED_LOG"; : > "$REG_LOG"

SID="sid-T125"
printf 'CLEANUP_REQUEST: %s | reason: workspace layout\n' "$SID" \
  | PATH="$PKGBIN:$PATH" bash "$HANDLER" >/dev/null \
  || fail "a workspace-layout cleanup-request exited non-zero"
grep -qxF "schedule $SID --source explicit-request --reason workspace layout" "$SCHED_LOG" \
  || { echo "--- scheduler calls ---" >&2; cat "$SCHED_LOG" >&2
       fail "the Layer-D arm did not reach the WORKSPACE's own bin/dispatch-cleanup-scheduler.sh — AIGENTRY_SHIM_SCRIPT_DIR was not honoured"; }

# The report arm reaches the workspace's own registry too — that is the other helper
# whose mis-resolution would write observations into a different checkout's active.json.
printf 'REPORT: %s-DONE | files=x | build=green\n' "$SID" \
  | PATH="$PKGBIN:$PATH" bash "$HANDLER" --sid "$SID" >/dev/null \
  || fail "a workspace-layout report exited non-zero"
grep -q "^observe --sid $SID --kind legacy_report_envelope_observed" "$REG_LOG" \
  || { echo "--- registry calls ---" >&2; cat "$REG_LOG" >&2
       fail "the report arm's observation did not reach the WORKSPACE's own bin/dispatch-registry.py"; }

# ── (C) the state roots follow the shim, not dist/ ──
# TEST_REPORTS_DIR is unset here on purpose: its default is "$REPO_DIR/state/test-reports",
# and REPO_DIR is the shim's own parent. A port that defaulted it from dist/ would write
# the workspace's tester handoffs into the repo's tree.
env -u TEST_REPORTS_DIR -u DISPATCH_STATE_DIR PATH="$PKGBIN:$PATH" bash "$HANDLER" <<EOF >/dev/null
TEST_REPORT: $SID | suite=ws | total=1 | passed=1 | failed=0 | skipped=0 | duration_ms=1
EOF
DATE_DIR=$(date -u +%Y-%m-%d)
[ -f "$WS/state/test-reports/$DATE_DIR/$SID.json" ] \
  || { find "$WS/state" "$REPO_ROOT/state/test-reports/$DATE_DIR" -name "$SID.json" 2>/dev/null >&2
       fail "the test-report landed outside the WORKSPACE — the default state root was resolved from dist/, not from the shim"; }
[ ! -f "$REPO_ROOT/state/test-reports/$DATE_DIR/$SID.json" ] \
  || fail "a workspace run wrote into the REPO's state/test-reports — cross-checkout state mutation"

# ── (D) neither layout is a fluke: the REPO tree (sibling dist/) still works ──
: > "$SCHED_LOG"
printf 'CLEANUP_REQUEST: %s-repo | reason: repo layout\n' "$SID" \
  | SCHEDULER_SH="$WS/bin/dispatch-cleanup-scheduler.sh" EMIT_TELEMETRY_MJS="$WS/bin/emit-telemetry.mjs" \
    bash "$REPO_ROOT/bin/inject-handler.sh" >/dev/null \
  || fail "the repo-tree layout (sibling dist/) stopped working"
grep -qxF "schedule $SID-repo --source explicit-request --reason repo layout" "$SCHED_LOG" \
  || fail "the repo-tree layout did not reach the scheduler"

echo "T125 PASS layouts=workspace+repo children=dispatch-cleanup-scheduler.sh/dispatch-registry.py"
