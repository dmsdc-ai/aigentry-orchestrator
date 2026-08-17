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

# ── the workspace: bin/ without dist/ ──
WS="$T_TMP/workspace"
mkdir -p "$WS/state/dispatch"
cp -R "$REPO_ROOT/bin" "$WS/bin"
[ ! -e "$WS/dist" ] || fail "fixture is wrong: the workspace must not have a dist/"

# ── the installed package, reachable only via its bin on PATH ──
PKG="$T_TMP/pkg"
mkdir -p "$PKG/bin/init"
cp -R "$REPO_ROOT/bin/lib" "$PKG/bin/lib"
printf '%s\n' '#!/usr/bin/env node' > "$PKG/bin/init/cli.mjs"
chmod +x "$PKG/bin/init/cli.mjs"
ln -s "$REPO_ROOT/dist" "$PKG/dist"
PKGBIN="$T_TMP/pkgbin"
mkdir -p "$PKGBIN"
ln -s "$PKG/bin/init/cli.mjs" "$PKGBIN/aigentry-orchestrator"

BOOT="$WS/bin/orchestrator-boot.sh"
[ -x "$BOOT" ] || fail "the workspace copy is not executable — an operator following bin/init/cli.mjs:458 runs it directly"

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
grep -qw 50349 "$KILL_LOG" \
  || fail "A: the singleton guard did not run in the workspace layout; kills: $(cat "$KILL_LOG")"
grep -q -- "allow --id $SID --auto-restart claude --dangerously-skip-permissions --continue" "$EXEC_LOG" \
  || fail "A: the workspace boot did not exec the bridge argv: $(cat "$EXEC_LOG")"
[ -s "$T_TMP/a.out" ] \
  && fail "A: the workspace boot wrote to stdout — the argv channel leaked past the shim: $(cat "$T_TMP/a.out")"

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
PATH="$EXEC_DIR:$PKGBIN:$PATH" bash "$BOOT" >/dev/null 2>"$T_TMP/b.err" \
  || fail "B: the workspace boot exited non-zero: $(cat "$T_TMP/b.err")"
grep -qF 'tok-FROM-WORKSPACE' "$CURL_LOG" \
  || fail "B: the DELETE did not carry the WORKSPACE's credential — AIGENTRY_SHIM_SCRIPT_DIR was not honoured, so bin/lib/telepty-auth.sh was resolved against the compiled module's location instead. calls: $(cat "$CURL_LOG")"
grep -qF 'tok-FROM-PACKAGE' "$CURL_LOG" \
  && fail "B: the PACKAGE's credential resolver was sourced from a workspace boot: $(cat "$CURL_LOG")"
# Invariant 4: the token never appears in the log stream either way.
grep -q 'tok-FROM-' "$T_TMP/b.err" \
  && fail "B: the credential leaked into the log output: $(cat "$T_TMP/b.err")"
# Restore the real resolver for the blocks below.
cp "$REPO_ROOT/bin/lib/telepty-auth.sh" "$WS/bin/lib/telepty-auth.sh"
cp "$REPO_ROOT/bin/lib/telepty-auth.sh" "$PKG/bin/lib/telepty-auth.sh"

# ===========================================================================
# C) `__probe` resolves in the workspace layout too — it is the seam T40 drives, and
#    it must never reach the exec.
# ===========================================================================
: > "$EXEC_LOG"; : > "$KILL_LOG"
PATH="$EXEC_DIR:$PKGBIN:$PATH" bash "$BOOT" __probe singleton-guard >/dev/null 2>"$T_TMP/c.err" \
  || fail "C: __probe singleton-guard failed in the workspace layout: $(cat "$T_TMP/c.err")"
grep -qw 50349 "$KILL_LOG" || fail "C: the workspace probe ran no guard; kills: $(cat "$KILL_LOG")"
[ -s "$EXEC_LOG" ] && fail "C: __probe booted the orchestrator from the workspace layout: $(cat "$EXEC_LOG")"

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
# E) neither layout is a fluke: the REPO tree (sibling dist/) still works.
# ===========================================================================
: > "$EXEC_LOG"; : > "$KILL_LOG"; : > "$CURL_LOG"
PATH="$EXEC_DIR:$PATH" bash "$REPO_ROOT/bin/orchestrator-boot.sh" >/dev/null 2>"$T_TMP/e.err" \
  || fail "the repo-tree layout (sibling dist/) stopped working: $(cat "$T_TMP/e.err")"
grep -qw 50349 "$KILL_LOG" || fail "the repo-tree boot ran no guard; kills: $(cat "$KILL_LOG")"
grep -q -- "allow --id $SID" "$EXEC_LOG" || fail "the repo-tree boot did not exec: $(cat "$EXEC_LOG")"

echo "T132 PASS layouts=workspace+repo+unresolvable resolver=workspace-lib"
