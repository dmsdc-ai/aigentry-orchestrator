#!/usr/bin/env bash
# T132 (#899 tranche 5) — bin/orchestrator-boot.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler),
# T114 (hitl), T117 (open-session), T121 (scheduler), T123 (comms-auditor), T128
# (bridge-auditor) and T125 (inject-handler), for the eleventh shim.
# bin/orchestrator-boot.sh is a shim onto dist/src/orchestrator-boot/cli.js now. In the
# repo and in the installed npm package dist/ sits next to bin/, so
# "$SCRIPT_DIR/../dist/…" resolves. In a control workspace it does NOT: `init` copies
# bin/ out of the package via bin/init/manifest.mjs (which lists this script at :42 and
# ships no dist entries at all), so dist/ stays behind in the package root.
#
# WHY THIS ONE MATTERS BEYOND "IT STARTS". This is the script an operator runs BY HAND
# when the control tower is already wedged, and bin/init/cli.mjs:458 tells them to run
# it from their workspace — so the workspace layout is not an edge case here, it is the
# documented one. Two things have to resolve, not one:
#
#   * the compiled implementation, from the PACKAGE's dist/ (block A);
#   * bin/lib/telepty-auth.sh — the ONE sanctioned credential resolver (#824) — from
#     the WORKSPACE's own bin/, because AIGENTRY_SHIM_SCRIPT_DIR is what the port
#     resolves it against. A port that derived it from the compiled module's location
#     would read the PACKAGE's copy instead. Both copies normally agree, which is
#     exactly why the mistake would go unnoticed until the day they do not — the
#     symptom being a 401 on the #905 DELETE and a boot that cannot claim its own id.
#     Block B makes the two copies differ on purpose and asserts which one was used.
#
# HERMETIC: `ps`, `kill`, `telepty` (both the listing and the exec'd bridge) and `curl`
# are recorder stubs. NO real process is ever listed or signalled, NO real DELETE is
# ever issued, and the `telepty allow` at the end of every boot is a stub on PATH that
# records its argv and exits. Everything is under $T_TMP; the repo tree's own state/ is
# never written.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

fail() { echo "FAIL[T132]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/orchestrator-boot/cli.js" ] \
  || fail "dist/src/orchestrator-boot/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

SID="orchestrator"

# --- recorders shared by every block -------------------------------------------
PS_TABLE="$T_TMP/ps-table.txt"
PS_STUB="$STUB_BIN/ps-stub132.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
cat "$PS_TABLE"
EOF
KILL_LOG="$T_TMP/kill-calls.log"
KILL_STUB="$STUB_BIN/kill-stub132.sh"
cat > "$KILL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
LIST_JSON="$T_TMP/list.json"
LIST_STUB="$STUB_BIN/telepty-list132.sh"
cat > "$LIST_STUB" <<EOF
#!/usr/bin/env bash
cat "$LIST_JSON"
exit 0
EOF
CURL_LOG="$T_TMP/curl-calls.log"
CURL_STUB="$STUB_BIN/curl132.sh"
cat > "$CURL_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
printf '200'
exit 0
EOF
chmod +x "$PS_STUB" "$KILL_STUB" "$LIST_STUB" "$CURL_STUB"
: > "$KILL_LOG"; : > "$CURL_LOG"

BRIDGE="node /usr/local/bin/telepty allow --id $SID --auto-restart claude --dangerously-skip-permissions --continue"
cat > "$PS_TABLE" <<EOF
50349 1 $BRIDGE
EOF
printf '[{"id":"%s","healthStatus":"STALE","active_clients":0}]' "$SID" > "$LIST_JSON"

# The `telepty` the boot EXECs at the end. Resolved from PATH exactly as the real one
# is, so nothing real is ever started.
EXEC_DIR="$T_TMP/exec-path"
mkdir -p "$EXEC_DIR"
EXEC_LOG="$T_TMP/exec.log"
cat > "$EXEC_DIR/telepty" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$EXEC_LOG"
exit 0
EOF
chmod +x "$EXEC_DIR/telepty"
: > "$EXEC_LOG"

export SINGLETON_PS_CMD="$PS_STUB" KILL_CMD="$KILL_STUB"
export TELEPTY="$LIST_STUB" CURL="$CURL_STUB"
export ORCHESTRATOR_SID="$SID" SINGLETON_SELF_PID=9999
export ORCHESTRATOR_CLI=claude TELEPTY_PORT=3848
export AIGENTRY_HOME="$T_TMP/home"
mkdir -p "$AIGENTRY_HOME"

# Every auth door is private; only B deliberately gives the two copies different tokens.
export AUTH_LOG="$T_TMP/auth.log"
: > "$AUTH_LOG"
PRIVATE_AUTH="$T_TMP/telepty-auth.sh"
cat > "$PRIVATE_AUTH" <<'EOF'
#!/usr/bin/env bash
telepty_auth_token() {
  printf 'auth\n' >> "$AUTH_LOG"
  printf 'tok-FIXTURE-T132'
}
EOF

# ── the workspace: bin/ without dist/ ──
WS="$T_TMP/workspace"
mkdir -p "$WS/state/dispatch"
cp -R "$REPO_ROOT/bin" "$WS/bin"
cp "$PRIVATE_AUTH" "$WS/bin/lib/telepty-auth.sh"
[ ! -e "$WS/dist" ] || fail "fixture is wrong: the workspace must not have a dist/"

# ── the installed package: PATH fallback for the workspace, sibling dist/ for E ──
PKG="$T_TMP/pkg"
mkdir -p "$PKG/bin/init"
cp -R "$REPO_ROOT/bin/lib" "$PKG/bin/lib"
cp "$PRIVATE_AUTH" "$PKG/bin/lib/telepty-auth.sh"
cp "$REPO_ROOT/bin/orchestrator-boot.sh" "$PKG/bin/orchestrator-boot.sh"
printf '%s\n' '#!/usr/bin/env node' > "$PKG/bin/init/cli.mjs"
chmod +x "$PKG/bin/init/cli.mjs"
ln -s "$REPO_ROOT/dist" "$PKG/dist"
PKGBIN="$T_TMP/pkgbin"
mkdir -p "$PKGBIN"
ln -s "$PKG/bin/init/cli.mjs" "$PKGBIN/aigentry-orchestrator"

BOOT="$WS/bin/orchestrator-boot.sh"
[ -x "$BOOT" ] || fail "the workspace copy is not executable — an operator following bin/init/cli.mjs:458 runs it directly"
cd "$WS"

# ===========================================================================
# A) a real boot from the workspace layout: the package's dist/ resolves, the
#    reconcile and the guard both run, and the boot ends in the exec.
# ===========================================================================
set +e
PATH="$EXEC_DIR:$PKGBIN:$PATH" bash "$BOOT" >"$T_TMP/a.out" 2>"$T_TMP/a.err"
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- stderr ---" >&2; cat "$T_TMP/a.err" >&2
  fail "a workspace-layout boot exited $rc — the shim did not resolve the package's dist/"
}
grep -q -- '-X DELETE' "$CURL_LOG" \
  || fail "A: the #905 reconcile did not run in the workspace layout; calls: $(cat "$CURL_LOG")"
grep -qxF -- '-9 50349' "$KILL_LOG" \
  || fail "A: the singleton guard did not run in the workspace layout; kills: $(cat "$KILL_LOG")"
grep -q -- "allow --id $SID --auto-restart claude --dangerously-skip-permissions --continue" "$EXEC_LOG" \
  || fail "A: the workspace boot did not exec the bridge argv: $(cat "$EXEC_LOG")"
[ -s "$T_TMP/a.out" ] \
  && fail "A: the workspace boot wrote to stdout — the argv channel leaked past the shim: $(cat "$T_TMP/a.out")"
grep -qF 'tok-FIXTURE-T132' "$T_TMP/a.err" \
  && fail "A: the fixture credential leaked into the log output"

# ===========================================================================
# B) the credential resolver comes from the WORKSPACE's bin/lib, not the package's.
#    The two copies are made to differ so the answer is measurable: whichever token
#    reaches the curl header names the copy that was sourced.
# ===========================================================================
cat > "$WS/bin/lib/telepty-auth.sh" <<'EOF'
#!/usr/bin/env bash
telepty_auth_token() { printf 'tok-FROM-WORKSPACE'; }
EOF
cat > "$PKG/bin/lib/telepty-auth.sh" <<'EOF'
#!/usr/bin/env bash
telepty_auth_token() { printf 'tok-FROM-PACKAGE'; }
EOF
: > "$CURL_LOG"; : > "$KILL_LOG"; : > "$EXEC_LOG"
PATH="$EXEC_DIR:$PKGBIN:$PATH" bash "$BOOT" >"$T_TMP/b.out" 2>"$T_TMP/b.err" \
  || fail "B: the workspace boot exited non-zero: $(cat "$T_TMP/b.err")"
grep -q -- '-X DELETE' "$CURL_LOG" || fail "B: the workspace boot ran no reconcile"
grep -qxF -- '-9 50349' "$KILL_LOG" || fail "B: the workspace boot ran no SIGKILL guard"
grep -q -- "allow --id $SID --auto-restart claude --dangerously-skip-permissions --continue" "$EXEC_LOG" \
  || fail "B: the workspace boot did not exec the bridge argv"
[ ! -s "$T_TMP/b.out" ] || fail "B: the workspace boot wrote to stdout"
grep -qF 'tok-FROM-WORKSPACE' "$CURL_LOG" \
  || fail "B: the DELETE did not carry the WORKSPACE's credential — AIGENTRY_SHIM_SCRIPT_DIR was not honoured, so bin/lib/telepty-auth.sh was resolved against the compiled module's location instead. calls: $(cat "$CURL_LOG")"
grep -qF 'tok-FROM-PACKAGE' "$CURL_LOG" \
  && fail "B: the PACKAGE's credential resolver was sourced from a workspace boot: $(cat "$CURL_LOG")"
# Invariant 4: the token never appears in the log stream either way.
grep -q 'tok-FROM-' "$T_TMP/b.err" \
  && fail "B: the credential leaked into the log output: $(cat "$T_TMP/b.err")"
# Restore the private resolver for the blocks below; never read host credentials.
cp "$PRIVATE_AUTH" "$WS/bin/lib/telepty-auth.sh"
cp "$PRIVATE_AUTH" "$PKG/bin/lib/telepty-auth.sh"

# ===========================================================================
# C) `__probe` resolves and evaluates the stale bridge through the real guard,
#    but reports a dry-run verdict without effects or persistence changes.
# ===========================================================================
mkdir -p "$T_TMP/c-before"
cp -R "$WS" "$T_TMP/c-before/workspace"
cp -R "$DISPATCH_STATE_DIR" "$T_TMP/c-before/dispatch-state"
cp -R "$AIGENTRY_HOME" "$T_TMP/c-before/home"
: > "$EXEC_LOG"; : > "$KILL_LOG"; : > "$CURL_LOG"; : > "$AUTH_LOG"
PATH="$EXEC_DIR:$PKGBIN:$PATH" bash "$BOOT" __probe singleton-guard >"$T_TMP/c.out" 2>"$T_TMP/c.err" \
  || fail "C: __probe singleton-guard failed in the workspace layout: $(cat "$T_TMP/c.err")"
grep -qF "[dry-run] would SIGKILL stale orchestrator bridge pid=50349 ($SID)" "$T_TMP/c.err" \
  || fail "C: the workspace probe did not evaluate the stale bridge fixture"
grep -qF "[dry-run] singleton guard done: would_kill=1 stale bridge(s) for $SID" "$T_TMP/c.err" \
  || fail "C: the workspace probe did not report its dry-run guard summary"
[ ! -s "$KILL_LOG" ] || fail "C: the workspace probe signalled a process"
[ ! -s "$CURL_LOG" ] || fail "C: the workspace probe called curl"
[ ! -s "$AUTH_LOG" ] || fail "C: the workspace probe resolved credentials"
[ -s "$EXEC_LOG" ] && fail "C: __probe booted the orchestrator from the workspace layout: $(cat "$EXEC_LOG")"
[ ! -s "$T_TMP/c.out" ] || fail "C: the singleton probe wrote to stdout"
diff -r "$T_TMP/c-before/workspace" "$WS" \
  || fail "C: the workspace probe changed workspace persistence"
diff -r "$T_TMP/c-before/dispatch-state" "$DISPATCH_STATE_DIR" \
  || fail "C: the workspace probe changed dispatch state"
diff -r "$T_TMP/c-before/home" "$AIGENTRY_HOME" \
  || fail "C: the workspace probe changed private home persistence"

# ===========================================================================
# D) the shim FAILS LOUD when neither layout resolves, and it fails BEFORE the exec.
#    A shim that fell through to a bare `telepty allow` on an unbuilt tree would
#    silently skip both the #905 reconcile and the #539 guard — the two things this
#    wrapper exists to do — while looking like a normal boot.
# ===========================================================================
BARE="$T_TMP/bare"
mkdir -p "$BARE"
cp -R "$REPO_ROOT/bin" "$BARE/bin"
# PRECONDITION, and it cannot be forced from out here: on a host that has
# @dmsdc-ai/aigentry-orchestrator globally installed on the PATH used below,
# node-shim.sh's package arm resolves and the "neither layout" state is
# unconstructible. Reported rather than skipped — the word SKIP is not used because
# run-all.sh enforces an exact skip SET and this guard is not in it.
if PATH="/usr/bin:/bin" command -v aigentry-orchestrator >/dev/null 2>&1; then
  echo "T132 note: block D (fail-loud) not exercised — aigentry-orchestrator is installed on this host's minimal PATH, so an unresolvable layout cannot be built. Blocks A/B/C/E ran." >&2
else
  : > "$EXEC_LOG"
  set +e
  PATH="$EXEC_DIR:/usr/bin:/bin" bash "$BARE/bin/orchestrator-boot.sh" \
    >"$T_TMP/d.out" 2>"$T_TMP/d.err"
  rc=$?
  set -e
  [ "$rc" -eq 2 ] \
    || fail "an unresolvable layout exited $rc, not 2 — bin/lib/node-shim.sh must fail loud: $(cat "$T_TMP/d.err")"
  grep -qF 'compiled implementation not found' "$T_TMP/d.err" \
    || fail "the unresolvable layout gave no diagnostic: $(cat "$T_TMP/d.err")"
  [ ! -s "$EXEC_LOG" ] \
    || fail "an unresolvable layout still exec'd a bridge — an unguarded boot is worse than no boot: $(cat "$EXEC_LOG")"
  [ ! -s "$T_TMP/d.out" ] || fail "the unresolvable layout wrote to stdout: $(cat "$T_TMP/d.out")"
fi

# ===========================================================================
# E) neither layout is a fluke: the repo/package layout (sibling dist/) still works,
#    through the copied shim and private resolver in the package fixture.
# ===========================================================================
: > "$EXEC_LOG"; : > "$KILL_LOG"; : > "$CURL_LOG"
PATH="$EXEC_DIR:$PATH" bash "$PKG/bin/orchestrator-boot.sh" >"$T_TMP/e.out" 2>"$T_TMP/e.err" \
  || fail "the repo-tree layout (sibling dist/) stopped working: $(cat "$T_TMP/e.err")"
grep -qxF -- '-9 50349' "$KILL_LOG" || fail "the repo-tree boot ran no guard; kills: $(cat "$KILL_LOG")"
grep -q -- '-X DELETE' "$CURL_LOG" || fail "E: the sibling-dist boot ran no reconcile"
grep -q -- "allow --id $SID --auto-restart claude --dangerously-skip-permissions --continue" "$EXEC_LOG" \
  || fail "E: the sibling-dist boot did not exec the bridge argv"
[ ! -s "$T_TMP/e.out" ] || fail "E: the sibling-dist boot wrote to stdout"
grep -qF 'tok-FIXTURE-T132' "$T_TMP/e.err" \
  && fail "E: the fixture credential leaked into the log output"

echo "T132 PASS layouts=workspace+repo+unresolvable resolver=workspace-lib"
