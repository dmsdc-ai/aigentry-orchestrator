#!/usr/bin/env bash
# T130 (#899 tranche 5) — bin/orchestrator-report-target.sh must work from an
# init-materialized workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup), T111 (reconciler),
# T114 (hitl), T117 (open-session), T121 (cleanup-scheduler), T123 (comms-auditor),
# T125 (inject-handler) and T128 (bridge-auditor), for the eleventh shim.
# bin/orchestrator-report-target.sh is an exec shim onto
# dist/src/report-target/cli.js now. In the repo and in the installed npm package
# dist/ sits next to bin/, so "$SCRIPT_DIR/../dist" resolves. In a control workspace
# it does NOT: `init` copies bin/ out of the package via bin/init/manifest.mjs (which
# lists this script at :44 and ships no dist entries at all), so dist/ stays behind in
# the package root.
#
# WHY THIS ONE IS DIFFERENT FROM ITS SIBLINGS, and why it is still worth a guard.
# This shim resolves NO bin/ helpers and NO state root — it reads env, runs curl and
# the interface listers, and prints one line. So there is no cross-checkout state
# mutation to catch here, which is what T125's blocks B and C exist for. What there
# IS instead is a caller that reads the answer and cannot tell a bad one from a good
# one: src/dispatch/cli.ts:595-597 substitutes this stdout into every worker's
# dispatch ref. Two distinct failures matter in a workspace, and they are opposites:
#
#   * a shim that cannot resolve its implementation must fail LOUDLY (non-zero, empty
#     stdout), because dispatch.sh's #690 fail-closed arm keys on exactly that — an
#     unresolvable target must block the dispatch, never be substituted as the empty
#     string and reported as success (T67 case 5 is the assertion for the caller's
#     half; block C here is the assertion for this half);
#   * a shim that DOES resolve must produce the REAL answer, not merely exit 0. A
#     stub-shaped success that printed nothing would pass a naive rc check and then
#     hand dispatch an empty target.
#
# ⚠️ THE MODE BIT IS LOAD-BEARING (block D). src/dispatch/cli.ts:595 gates the whole
# resolve on `isExecutable(REPORT_TARGET_SH)`, so a workspace copy that lost +x does
# not degrade the answer — it silently skips the resolver and fails every dispatch
# that carries {{ORCHESTRATOR_REPORT_TARGET}}. `init` copying bin/ is exactly the
# moment a mode bit gets lost.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build), reachable only as the `aigentry-orchestrator`
#                  bin on PATH, exactly as npm installs it
#
# Hermetic: curl and the interface scan are both seams, so no network and no daemon in
# any layout.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T130]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/report-target/cli.js" ] \
  || fail "dist/src/report-target/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

TAILNET_IP="100.72.155.21"

# ── seams: an answering probe and an interface that carries a CGNAT address ──
CURL_STUB="$T_TMP/curl-stub"
printf '%s\n' '#!/usr/bin/env bash' 'echo "${STUB_HTTP:-200}"' > "$CURL_STUB"
IFACE="$T_TMP/iface"
printf '%s\n' '#!/usr/bin/env bash' "printf '\tinet $TAILNET_IP --> $TAILNET_IP netmask 0xffffffff\n'" > "$IFACE"
chmod +x "$CURL_STUB" "$IFACE"

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

RESOLVER="$WS/bin/orchestrator-report-target.sh"

# ── (D) the workspace copy is still executable ─────────────────────────────
# Asserted FIRST, because every block below would report a confusing failure if it
# were not, and because this is the one property whose loss is silent in production.
[ -x "$RESOLVER" ] \
  || fail "D: the workspace copy is not executable — src/dispatch/cli.ts:595 gates the resolve on isExecutable(), so every dispatch carrying the placeholder would fail closed with no diagnostic naming this file"

# ── (A) a workspace-layout resolve reaches the REAL implementation ─────────
OUT="$T_TMP/out.txt"; ERR="$T_TMP/err.txt"
set +e
env PATH="$PKGBIN:$PATH" CURL="$CURL_STUB" REPORT_TARGET_IFACE_CMD="$IFACE" \
  AIGENTRY_ORCHESTRATOR_SID=ws-orch bash "$RESOLVER" > "$OUT" 2> "$ERR"
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- stderr ---" >&2; cat "$ERR" >&2
  fail "A: a workspace-layout resolve exited $rc — the shim did not resolve the package's dist/"
}
# …and it produced the REAL answer, not merely a zero exit. An empty or malformed
# stdout here is what dispatch.sh would substitute into every worker's ref.
[ "$(cat "$OUT")" = "ws-orch@$TAILNET_IP" ] \
  || { echo "--- stdout ---" >&2; cat "$OUT" >&2
       fail "A: the workspace resolve exited 0 but did not produce the resolved target — dispatch.sh reads stdout only, so this is what every worker would be told to report to"; }
[ "$(grep -c . "$OUT")" = "1" ] || fail "A: stdout is not a single line: [$(cat "$OUT")]"

# ── (B) the fallback arm works there too, and the note still goes to stderr ─
# The silent-probe path is the one that changes the ANSWER, so it must be exercised in
# the workspace layout as well: a shim that resolved a stale dist/ could answer block A
# correctly and still take the wrong branch here.
set +e
env PATH="$PKGBIN:$PATH" CURL="$CURL_STUB" STUB_HTTP=000 REPORT_TARGET_IFACE_CMD="$IFACE" \
  AIGENTRY_ORCHESTRATOR_SID=ws-orch bash "$RESOLVER" > "$OUT" 2> "$ERR"
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "B: a workspace-layout silent probe exited $rc, which blocks every dispatch"
[ "$(cat "$OUT")" = "ws-orch" ] \
  || fail "B: a silent tailnet address was still handed out as the report target from a workspace; got '$(cat "$OUT")'"
grep -q "does not answer" "$ERR" || fail "B: the workspace fallback was silent: $(cat "$ERR")"
grep -q "orchestrator-report-target:" "$OUT" \
  && fail "B: a stderr note leaked onto stdout, which dispatch.sh substitutes verbatim"

# ── (C) no package on PATH → LOUD failure, never a silent empty answer ─────
# This is the arm dispatch.sh's #690 fail-closed logic depends on. An unresolvable
# implementation must be non-zero AND print nothing on stdout; a shim that exited 0
# with empty stdout would be substituted as the empty string.
set +e
env -u PATH PATH="/usr/bin:/bin" CURL="$CURL_STUB" REPORT_TARGET_IFACE_CMD="$IFACE" \
  bash "$RESOLVER" > "$OUT" 2> "$ERR"
rc=$?
set -e
[ "$rc" -ne 0 ] \
  || fail "C: an unresolvable implementation exited 0 — dispatch.sh would substitute '$(cat "$OUT")' into every worker's ref instead of refusing (#690 reborn)"
[ ! -s "$OUT" ] \
  || fail "C: an unresolvable implementation still wrote to stdout: [$(cat "$OUT")]"
grep -q "compiled implementation not found" "$ERR" \
  || { cat "$ERR" >&2; fail "C: the failure did not carry bin/lib/node-shim.sh's diagnostic, so an operator has nothing to act on"; }

# ── (E) neither layout is a fluke: the REPO tree (sibling dist/) still works ─
set +e
env CURL="$CURL_STUB" REPORT_TARGET_IFACE_CMD="$IFACE" AIGENTRY_ORCHESTRATOR_SID=repo-orch \
  bash "$REPO_ROOT/bin/orchestrator-report-target.sh" > "$OUT" 2> "$ERR"
rc=$?
set -e
[ "$rc" -eq 0 ] || { cat "$ERR" >&2; fail "E: the repo-tree layout (sibling dist/) stopped working"; }
[ "$(cat "$OUT")" = "repo-orch@$TAILNET_IP" ] \
  || fail "E: the repo-tree layout resolved '$(cat "$OUT")'"

echo "T130 PASS layouts=workspace+repo arms=resolved/fallback/unresolvable"
