#!/usr/bin/env bash
# T121 (#899 tranche 4) — bin/dispatch-cleanup-scheduler.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler),
# T114 (hitl) and T117 (open-session), for the seventh shim.
# bin/dispatch-cleanup-scheduler.sh is an exec shim onto
# dist/src/cleanup-scheduler/cli.js now. In the repo and in the installed npm package
# dist/ sits next to bin/, so "$SCRIPT_DIR/../dist" resolves. In a control workspace it
# does NOT: `init` copies bin/ out of the package via bin/init/manifest.mjs (which
# lists this script at :22 and ships no dist entries at all), so dist/ stays behind in
# the package root.
#
# WHY THIS ONE MATTERS. It is Layer D — the timeout fallback that retires workers
# nobody reported for. A workspace reconciler ticks it every 60s
# (src/reconciler/cli.ts:1318) and swallows the result (`if … !== 0) log(…)`), and
# bin/inject-handler.sh reaches schedule/defer/cancel with `>/dev/null 2>&1 || true`
# on the dispatch path. So a shim that resolved only the sibling path would leave a
# workspace's sessions accumulating forever with NOTHING in any log to say why — the
# exact 21-stuck-sessions failure that made bin/session-cleanup.sh load-bearing in the
# first place. Every caller has decided in advance to ignore this script's exit code,
# which is why the resolution gets a guard rather than an assumption.
#
# Beyond --help: a real schedule + tick is asserted too, because --help is answered by
# the compiled module alone, while the two live verbs also have to reach the
# workspace's OWN bin/dispatch-registry.py (the keep_alive read, whose failure arm
# decides whether cleanup is even permitted) and bin/session-cleanup.sh (the child
# that does the removing). Those two are the reason this shim exports
# AIGENTRY_SHIM_SCRIPT_DIR: a port that resolved them relative to dist/ would answer
# --help fine and then drive the REPO's helpers from inside a workspace. Both are
# replaced with recorders in the workspace copy, so "it reached the workspace's own
# bin/" is measured rather than assumed.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build), reachable only as the `aigentry-orchestrator`
#                  bin on PATH, exactly as npm installs it
#
# Hermetic: the temp state dir from lib.sh, recorders for both children, SCHEDULER_NOW
# for the clock, a throwaway sid only. This script contacts no daemon in any layout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T121]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/cleanup-scheduler/cli.js" ] \
  || fail "dist/src/cleanup-scheduler/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

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

SCHED="$WS/bin/dispatch-cleanup-scheduler.sh"
[ -x "$SCHED" ] || fail "the workspace copy is not executable — the reconciler gates on [ -x ] and would silently skip Layer D"
PENDING="$DISPATCH_STATE_DIR/cleanup-pending.json"

# ── (A) --help resolves the package's dist/ and reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$SCHED" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout dispatch-cleanup-scheduler.sh --help exited $rc — the shim did not resolve the package's dist/"
}
# …and it reached the REAL implementation, not merely something that exits 0.
t_assert_contains "$OUT" "# dispatch-cleanup-scheduler.sh — Layer D timeout fallback (ADR 2026-05-20)."
t_assert_contains "$OUT" "# Atomic writes via tmpfile+mv (avoids partial state on crash — pattern #114)."

# ── (B) a real schedule + tick reaches the WORKSPACE's own bin/ helpers ──
# Recorders in place of the two children the shim must resolve through
# AIGENTRY_SHIM_SCRIPT_DIR. If either were resolved relative to dist/ (i.e. the repo's
# bin/), its log would stay empty here while the run still exited 0 — and for the
# registry that failure is worse than silent, because an unreachable registry reads as
# keep_alive and Layer D stops scheduling anything at all.
REG_LOG="$T_TMP/registry.log"
cat > "$WS/bin/dispatch-registry.py" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REG_LOG"
exit 0
EOF
CLEANUP_LOG="$T_TMP/cleanup.log"
cat > "$WS/bin/session-cleanup.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CLEANUP_LOG"
exit 0
EOF
chmod +x "$WS/bin/dispatch-registry.py" "$WS/bin/session-cleanup.sh"
: > "$REG_LOG"; : > "$CLEANUP_LOG"

SID="sid-T121"
export SCHEDULER_NOW="2026-05-23T12:00:00Z"
PATH="$PKGBIN:$PATH" bash "$SCHED" schedule "$SID" --grace-seconds 60 >/dev/null \
  || fail "a workspace-layout schedule exited non-zero"
grep -qxF "get --sid $SID --pointer keep_alive" "$REG_LOG" \
  || { echo "--- registry calls ---" >&2; cat "$REG_LOG" >&2
       fail "the keep_alive read did not reach the WORKSPACE's own bin/dispatch-registry.py — AIGENTRY_SHIM_SCRIPT_DIR was not honoured"; }
python3 -c "import json,sys;p=json.load(open('$PENDING'));sys.exit(0 if [r['sid'] for r in p]==['$SID'] else 1)" \
  || fail "the workspace-layout schedule wrote no record: $(cat "$PENDING")"

export SCHEDULER_NOW="2026-05-23T12:01:00Z"
PATH="$PKGBIN:$PATH" bash "$SCHED" tick >/dev/null \
  || fail "a workspace-layout tick exited non-zero"
grep -qxF "$SID" "$CLEANUP_LOG" \
  || { echo "--- cleanup calls ---" >&2; cat "$CLEANUP_LOG" >&2
       fail "the tick's cleanup child did not reach the WORKSPACE's own bin/session-cleanup.sh"; }
[ "$(python3 -c "import json;print(len(json.load(open('$PENDING'))))")" = 0 ] \
  || fail "the workspace-layout tick did not drain the record it fired: $(cat "$PENDING")"

# ── (C) neither layout is a fluke: the REPO tree (sibling dist/) still works ──
# Same recorders, pointed at the repo's own shim through the two env seams, so this arm
# exercises bin/lib/node-shim.sh's sibling-dist path — which A and B never reach.
: > "$REG_LOG"; : > "$CLEANUP_LOG"
export SCHEDULER_NOW="2026-05-23T13:00:00Z"
DISPATCH_REGISTRY_PY="$WS/bin/dispatch-registry.py" SESSION_CLEANUP_SH="$WS/bin/session-cleanup.sh" \
  bash "$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh" schedule "$SID-repo" --grace-seconds 0 >/dev/null \
  || fail "the repo-tree layout (sibling dist/) stopped working"
export SCHEDULER_NOW="2026-05-23T13:00:01Z"
DISPATCH_REGISTRY_PY="$WS/bin/dispatch-registry.py" SESSION_CLEANUP_SH="$WS/bin/session-cleanup.sh" \
  bash "$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh" tick >/dev/null \
  || fail "the repo-tree tick stopped working"
grep -qxF "$SID-repo" "$CLEANUP_LOG" || fail "the repo-tree tick did not reach the cleanup child"

echo "T121 PASS layouts=workspace+repo children=dispatch-registry.py/session-cleanup.sh"
