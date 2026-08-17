#!/usr/bin/env bash
# T123 (#899 tranche 4) — bin/session-comms-auditor.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler),
# T114 (hitl), T117 (open-session) and T121 (scheduler), for the eighth shim.
# bin/session-comms-auditor.sh is an exec shim onto dist/src/comms-auditor/cli.js now.
# In the repo and in the installed npm package dist/ sits next to bin/, so
# "$SCRIPT_DIR/../dist" resolves. In a control workspace it does NOT: `init` copies
# bin/ out of the package via bin/init/manifest.mjs (which lists this script at :47
# and ships no dist entries at all), so dist/ stays behind in the package root.
#
# WHY THIS ONE MATTERS TWICE OVER. This shim has no `--help`, so unlike its seven
# siblings there is no cheap way to ask "did you resolve?" — the only proof is a real
# audit pass. And it carries a second, sharper failure mode the others do not:
# SESSION_COMMS_DIR and AIGENTRY_PEER_INJECT_LOG both DEFAULT to `$SCRIPT_DIR/..`,
# and a reconciler tick passes neither (src/reconciler/cli.ts:1292-1293 calls it with
# no argv and only TELEPTY added to the env). So a port that derived its root from
# the compiled module's own location instead of AIGENTRY_SHIM_SCRIPT_DIR would
# resolve `dist/src/comms-auditor/../../..` — the installed PACKAGE — and every
# workspace would tail the package's peer-inject log, write the package's round
# counters, and report a clean pass while its own peer lane went completely
# unaudited. Nothing in any log would say so: the tick folds a non-zero into one
# line and there would be no non-zero to fold. Blocks A and B measure exactly that,
# from both directions.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $WS/state/   — the workspace's OWN state, which is what must be audited
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build) + a state/ tree that must stay untouched,
#                  reachable only as the `aigentry-orchestrator` bin on PATH, exactly
#                  as npm installs it
#
# Hermetic: everything under $T_TMP, lib.sh's recording telepty stub reached through
# an ABSOLUTE $TELEPTY (lib.sh:45 — which is also what keeps the shim's hardened
# /opt/homebrew/bin prefix off the real telepty), AUDITOR_NOW for the clock. The repo
# tree's own state/ is never written in any arm. No session is contacted.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T123]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/comms-auditor/cli.js" ] \
  || fail "dist/src/comms-auditor/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

export AUDITOR_NOW="2026-08-17T12:00:00Z"
VIOLATION='{"ts":"2026-08-17T11:59:00Z","from":"peer-A","to":"peer-B","body":"go implement X and push"}'

# ── the workspace: bin/ without dist/, plus its own state/ ──
WS="$T_TMP/workspace"
mkdir -p "$WS/state/dispatch"
cp -R "$REPO_ROOT/bin" "$WS/bin"
[ ! -e "$WS/dist" ] || fail "fixture is wrong: the workspace must not have a dist/"
printf '%s\n' "$VIOLATION" > "$WS/state/dispatch/peer-injects.jsonl"

# ── the installed package, reachable only via its bin on PATH ──
PKG="$T_TMP/pkg"
mkdir -p "$PKG/bin/init" "$PKG/state/dispatch"
printf '%s\n' '#!/usr/bin/env node' > "$PKG/bin/init/cli.mjs"
chmod +x "$PKG/bin/init/cli.mjs"
ln -s "$REPO_ROOT/dist" "$PKG/dist"
# A DIFFERENT violation in the package's own log. If the shim resolves its root from
# dist/ instead of from bin/, this is the line it will audit — and block B will see it.
printf '%s\n' '{"ts":"t","from":"pkg-A","to":"pkg-B","body":"the PACKAGE log, which a workspace must never tail"}' \
  > "$PKG/state/dispatch/peer-injects.jsonl"
PKGBIN="$T_TMP/pkgbin"
mkdir -p "$PKGBIN"
ln -s "$PKG/bin/init/cli.mjs" "$PKGBIN/aigentry-orchestrator"

AUD="$WS/bin/session-comms-auditor.sh"
[ -x "$AUD" ] || fail "the workspace copy is not executable — the reconciler gates on [ -x ] and would silently skip the peer lane"

# ── (A) a real audit pass resolves the package's dist/ AND the workspace's state ──
# No SESSION_COMMS_DIR and no AIGENTRY_PEER_INJECT_LOG, exactly as the reconciler
# calls it — so both defaults are under test, not just the dist resolution.
set +e
ERRF="$T_TMP/a.err"
PATH="$PKGBIN:$PATH" bash "$AUD" >"$T_TMP/a.out" 2>"$ERRF"
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- stderr ---" >&2; cat "$ERRF" >&2
  fail "a workspace-layout audit pass exited $rc — the shim did not resolve the package's dist/"
}
WS_TELE="$WS/state/session-comms/telemetry.jsonl"
[ -f "$WS_TELE" ] || fail "the pass wrote no telemetry under the WORKSPACE's state/ — AIGENTRY_SHIM_SCRIPT_DIR was not honoured, so the default SESSION_COMMS_DIR pointed somewhere else"
grep -q 'peer_inject_out_of_policy' "$WS_TELE" \
  || fail "the workspace's own peer-inject log was not classified: $(cat "$WS_TELE")"
grep -q 'peer-A' "$WS_TELE" || fail "the pass classified something other than the workspace's violation: $(cat "$WS_TELE")"
grep -q 'HOLD' "$STUB_DISPATCH_LOG" || fail "the workspace-layout violation was not escalated: $(cat "$STUB_DISPATCH_LOG")"
[ -f "$WS/state/session-comms/.audit-cursor" ] || fail "the byte cursor was not written under the workspace's state/"

# ── (B) the package's own state was NOT touched ──────────────────────────────
# The failure this rules out is the quiet one: a workspace that audits the package's
# log looks identical from the outside — exit 0, a HOLD sent, telemetry written —
# while its own peer lane is never read.
[ ! -e "$PKG/state/session-comms" ] \
  || fail "the workspace pass wrote into the PACKAGE's state/: $(ls -A "$PKG/state/session-comms")"
grep -q 'pkg-A' "$WS_TELE" && fail "the workspace tailed the PACKAGE's peer-inject log instead of its own"

# ── (C) the workspace layout still reports an undelivered HOLD as rc 5 ───────
# rc 5 is the ONLY channel that survives the reconciler's stdio-ignored call, so it
# has to survive the layout too — a shim that resolved but swallowed the code would
# make #835 silent again in every workspace.
cat > "$STUB_BIN/telepty" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  inject) exit 1;;
  *)      exit 0;;
esac
EOF
chmod +x "$STUB_BIN/telepty"
printf '%s\n' '{"ts":"t","from":"peer-C","to":"peer-D","body":"a second violation, refused transport"}' \
  >> "$WS/state/dispatch/peer-injects.jsonl"
set +e
PATH="$PKGBIN:$PATH" bash "$AUD" >/dev/null 2>"$T_TMP/c.err"
rc=$?
set -e
[ "$rc" -eq 5 ] || fail "a workspace-layout undelivered HOLD exited $rc, not 5: $(cat "$T_TMP/c.err")"
grep -q UNDELIVERED "$T_TMP/c.err" || fail "the workspace layout did not name the undelivered escalation: $(cat "$T_TMP/c.err")"
cp "$HERE/stubs/telepty" "$STUB_BIN/telepty"; chmod +x "$STUB_BIN/telepty"

# ── (D) neither layout is a fluke: the REPO tree (sibling dist/) still works ──
# Exercises bin/lib/node-shim.sh's sibling-dist path, which A-C never reach. Both
# env seams are set here so the repo's own state/ is never written.
: > "$STUB_DISPATCH_LOG"
REPO_TELE="$T_TMP/repo-run/session-comms/telemetry.jsonl"
mkdir -p "$T_TMP/repo-run"
printf '%s\n' "$VIOLATION" > "$T_TMP/repo-run/peer-injects.jsonl"
SESSION_COMMS_DIR="$T_TMP/repo-run/session-comms" \
  AIGENTRY_PEER_INJECT_LOG="$T_TMP/repo-run/peer-injects.jsonl" \
  bash "$REPO_ROOT/bin/session-comms-auditor.sh" >/dev/null 2>&1 \
  || fail "the repo-tree layout (sibling dist/) stopped working"
grep -q 'peer_inject_out_of_policy' "$REPO_TELE" \
  || fail "the repo-tree pass classified nothing: $(cat "$REPO_TELE" 2>/dev/null)"
[ ! -e "$REPO_ROOT/state/session-comms" ] \
  || fail "a test wrote into the repo's own state/session-comms — this suite must never touch it"

echo "T123 PASS layouts=workspace+repo defaults=SESSION_COMMS_DIR/AIGENTRY_PEER_INJECT_LOG"
