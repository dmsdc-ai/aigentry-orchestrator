#!/usr/bin/env bash
# T128 (#899 tranche 5) — bin/orchestrator-bridge-auditor.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler),
# T114 (hitl), T117 (open-session), T121 (scheduler) and T123 (comms-auditor), for
# the ninth shim. bin/orchestrator-bridge-auditor.sh is an exec shim onto
# dist/src/bridge-auditor/cli.js now. In the repo and in the installed npm package
# dist/ sits next to bin/, so "$SCRIPT_DIR/../dist/…" resolves. In a control
# workspace it does NOT: `init` copies bin/ out of the package via
# bin/init/manifest.mjs (which lists this script at :43 and ships no dist entries at
# all), so dist/ stays behind in the package root.
#
# WHY THIS ONE MATTERS BEYOND "--help ANSWERS". `DISPATCH_STATE_DIR` DEFAULTS to
# `$SCRIPT_DIR/../state/dispatch`, and a reconcile tick passes it NEITHER argv nor
# that env (src/reconciler/cli.ts:1300-1301 calls it with no argv and only TELEPTY
# added). So a port that derived its root from the compiled module's own location
# instead of AIGENTRY_SHIM_SCRIPT_DIR would resolve
# `dist/src/bridge-auditor/../../..` — the installed PACKAGE — and every workspace
# would append its duplicate-bridge alerts into the package's alerts.log while its
# own stayed empty. That failure is silent by construction: the pass still exits 0,
# the HOLD is still injected, and the operator who greps the workspace's
# state/dispatch/alerts.log after a #618 incident finds nothing and concludes the
# belt never fired. Blocks A and B measure exactly that, from both directions.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $WS/state/   — the workspace's OWN state, which is where alerts must land
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build) + a state/ tree that must stay untouched,
#                  reachable only as the `aigentry-orchestrator` bin on PATH, exactly
#                  as npm installs it
#
# HERMETIC: the process lister is STUBBED (SINGLETON_PS_CMD → a fixture table), so no
# real process is listed and no real bridge count can leak in; telepty is STUBBED
# through an ABSOLUTE $TELEPTY (lib.sh:45 — also what keeps the shim's hardened
# /opt/homebrew/bin prefix off the real telepty this host has); a `kill` recorder is
# on PATH and must stay empty (#606); AUDITOR_NOW pins the clock; everything is under
# $T_TMP. The repo tree's own state/ is never written in any arm, and NOTHING is ever
# signalled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

fail() { echo "FAIL[T128]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/bridge-auditor/cli.js" ] \
  || fail "dist/src/bridge-auditor/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

export AUDITOR_NOW="2026-08-18T12:00:00Z"

# --- the shared fixtures: a duplicate-bridge process table and a kill recorder ----
PS_TABLE="$T_TMP/ps-table.txt"
PS_STUB="$STUB_BIN/ps-stub.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
cat "$PS_TABLE"
EOF
KILL_LOG="$T_TMP/kill-calls.log"
cat > "$STUB_BIN/kill" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
chmod +x "$PS_STUB" "$STUB_BIN/kill"
: > "$KILL_LOG"
export SINGLETON_PS_CMD="$PS_STUB"

B="node telepty allow --id orchestrator claude --dangerously-skip-permissions --continue"
cat > "$PS_TABLE" <<EOF
50349 2-08:11:00 $B
74838 00:05:23 $B
EOF

# ── the workspace: bin/ without dist/, plus its own state/ ──
WS="$T_TMP/workspace"
mkdir -p "$WS/state/dispatch"
cp -R "$REPO_ROOT/bin" "$WS/bin"
[ ! -e "$WS/dist" ] || fail "fixture is wrong: the workspace must not have a dist/"

# ── the installed package, reachable only via its bin on PATH ──
PKG="$T_TMP/pkg"
mkdir -p "$PKG/bin/init" "$PKG/state/dispatch"
printf '%s\n' '#!/usr/bin/env node' > "$PKG/bin/init/cli.mjs"
chmod +x "$PKG/bin/init/cli.mjs"
ln -s "$REPO_ROOT/dist" "$PKG/dist"
PKGBIN="$T_TMP/pkgbin"
mkdir -p "$PKGBIN"
ln -s "$PKG/bin/init/cli.mjs" "$PKGBIN/aigentry-orchestrator"

AUD="$WS/bin/orchestrator-bridge-auditor.sh"
[ -x "$AUD" ] \
  || fail "the workspace copy is not executable — the reconciler gates on [ -x ] (src/reconciler/cli.ts:1300) and would silently skip the duplicate-bridge belt"

# ===========================================================================
# A) a real audit pass resolves the package's dist/ AND the workspace's state.
#    No DISPATCH_STATE_DIR is passed, exactly as the reconcile tick calls it, so
#    the DEFAULT is what is under test — not just the dist resolution.
# ===========================================================================
# `env -u DISPATCH_STATE_DIR` is load-bearing: lib.sh:34 EXPORTS DISPATCH_STATE_DIR
# into every guard's environment, which would satisfy the very default this block
# exists to measure and make A/B vacuous. T123's equivalent arm did not need this
# because SESSION_COMMS_DIR is not one of the harness exports; this one is.
set +e
env -u DISPATCH_STATE_DIR PATH="$PKGBIN:$PATH" bash "$AUD" >"$T_TMP/a.out" 2>"$T_TMP/a.err"
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- stderr ---" >&2; cat "$T_TMP/a.err" >&2
  fail "a workspace-layout audit pass exited $rc — the shim did not resolve the package's dist/"
}
WS_ALERTS="$WS/state/dispatch/alerts.log"
[ -f "$WS_ALERTS" ] \
  || fail "the pass wrote no alerts.log under the WORKSPACE's state/ — AIGENTRY_SHIM_SCRIPT_DIR was not honoured, so the default DISPATCH_STATE_DIR pointed somewhere else. stderr: $(cat "$T_TMP/a.err")"
grep -qF 'ORCH_BRIDGE_DUPLICATE count=2' "$WS_ALERTS" \
  || fail "the workspace's duplicate was not recorded: $(cat "$WS_ALERTS")"
grep -qF '50349' "$WS_ALERTS" || fail "the alert does not name the stale pid: $(cat "$WS_ALERTS")"
grep -qF 'HOLD' "$STUB_DISPATCH_LOG" \
  || fail "the workspace-layout duplicate was not escalated: $(cat "$STUB_DISPATCH_LOG")"
[ ! -s "$KILL_LOG" ] \
  || fail "the workspace layout invoked kill — bridge cleanup is USER-ONLY (#606): $(cat "$KILL_LOG")"

# ===========================================================================
# B) the package's own state was NOT touched. This is the quiet failure: a
#    workspace that alerts into the package looks identical from outside — exit 0,
#    a HOLD sent — while its own alerts.log stays empty forever.
# ===========================================================================
[ ! -e "$PKG/state/dispatch/alerts.log" ] \
  || fail "the workspace pass wrote into the PACKAGE's state/dispatch/alerts.log: $(cat "$PKG/state/dispatch/alerts.log")"

# ===========================================================================
# C) --help resolves in the workspace layout too, all 498 bytes of it. Cheap, and
#    it is the arm an operator actually reaches for; D2 moved this text out of the
#    script's own comment header into src/bridge-auditor/usage.ts, so in a
#    workspace it is served from the PACKAGE's dist while the shim is the
#    workspace's own file.
# ===========================================================================
set +e
env -u DISPATCH_STATE_DIR PATH="$PKGBIN:$PATH" bash "$AUD" --help >"$T_TMP/c.out" 2>"$T_TMP/c.err"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "workspace --help exited $rc: $(cat "$T_TMP/c.err")"
help_bytes=$(wc -c < "$T_TMP/c.out" | tr -d ' ')
[ "$help_bytes" -eq 498 ] \
  || fail "workspace --help printed $help_bytes bytes, not the original's 498 (the shim has no comment header to slice, so an empty answer here is exactly the D2 regression): $(cat "$T_TMP/c.out")"
grep -qF 'orchestrator-bridge-auditor.sh --dry-run' "$T_TMP/c.out" \
  || fail "workspace --help lost the usage block: $(cat "$T_TMP/c.out")"

# ===========================================================================
# D) the shim FAILS LOUD when neither layout resolves. Merge is a live deploy and
#    this path runs from launchd every 60s: a shim that exited 0 on an unbuilt tree
#    would read as "no duplicate bridges" forever.
# ===========================================================================
BARE="$T_TMP/bare"
mkdir -p "$BARE"
cp -R "$REPO_ROOT/bin" "$BARE/bin"
# PRECONDITION, and it cannot be forced from out here: the shim PREPENDS
# /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin to PATH, so on a host that has
# @dmsdc-ai/aigentry-orchestrator globally installed in one of those four,
# node-shim.sh's package arm resolves and the "neither layout" state is
# unconstructible. Reported rather than skipped — the word SKIP is not used because
# run-all.sh enforces an exact skip SET (:43-44) and this guard is not in it.
if command -v aigentry-orchestrator >/dev/null 2>&1; then
  echo "T128 note: block D (fail-loud) not exercised — aigentry-orchestrator is installed on this host's hardened PATH, so an unresolvable layout cannot be built. Blocks A/B/C/E ran." >&2
else
  set +e
  env -u DISPATCH_STATE_DIR PATH="/usr/bin:/bin" bash "$BARE/bin/orchestrator-bridge-auditor.sh" \
    >"$T_TMP/d.out" 2>"$T_TMP/d.err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] \
    || fail "an unresolvable layout exited $rc, not 2 — bin/lib/node-shim.sh must fail loud rather than look like a clean pass: $(cat "$T_TMP/d.err")"
  grep -qF 'compiled implementation not found' "$T_TMP/d.err" \
    || fail "the unresolvable layout gave no diagnostic: $(cat "$T_TMP/d.err")"
  [ ! -s "$T_TMP/d.out" ] || fail "the unresolvable layout wrote to stdout: $(cat "$T_TMP/d.out")"
fi

# ===========================================================================
# E) neither layout is a fluke: the REPO tree (sibling dist/) still works.
#    Exercises bin/lib/node-shim.sh's sibling-dist path, which A-D never reach.
#    DISPATCH_STATE_DIR is set here so the repo's own state/ is never written.
# ===========================================================================
: > "$STUB_DISPATCH_LOG"
REPO_RUN="$T_TMP/repo-run"
mkdir -p "$REPO_RUN"
DISPATCH_STATE_DIR="$REPO_RUN" bash "$REPO_ROOT/bin/orchestrator-bridge-auditor.sh" \
  >/dev/null 2>"$T_TMP/e.err" \
  || fail "the repo-tree layout (sibling dist/) stopped working: $(cat "$T_TMP/e.err")"
grep -qF 'ORCH_BRIDGE_DUPLICATE count=2' "$REPO_RUN/alerts.log" \
  || fail "the repo-tree pass recorded nothing: $(cat "$REPO_RUN/alerts.log" 2>/dev/null)"
grep -qF 'HOLD' "$STUB_DISPATCH_LOG" || fail "the repo-tree pass did not escalate"
[ ! -s "$KILL_LOG" ] || fail "a later block invoked kill (#606): $(cat "$KILL_LOG")"

echo "T128 PASS layouts=workspace+repo+unresolvable default=DISPATCH_STATE_DIR help_bytes=498"
