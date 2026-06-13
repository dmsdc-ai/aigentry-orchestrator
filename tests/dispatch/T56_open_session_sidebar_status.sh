#!/usr/bin/env bash
# T56 — #616 spawn-time cmux sidebar visibility (사용자확정 옵션2 = 사이드바). After
# open-session.sh spawns a worker via the cmux wh_open seam, it must push a ⚡working
# pill to the cmux sidebar so the new worker is immediately visible — WITHOUT stealing
# focus from the orchestrator (옵션2 = sidebar pill only, NO select-workspace).
#
# Asserts (end-to-end through open-session.sh, hermetic via the CMUX seam — NO live
# cmux daemon 3848):
#   A) successful spawn returns the ref (rc 0, ref on stdout — pill wiring never gates
#      the spawn nor pollutes stdout).
#   B) `set-status aigentry working --workspace <ref>` was issued (the #616 pill, under
#      the DISTINCT `aigentry` key, never clobbering claude_code's pill).
#   C) NO `select-workspace` was issued — the orchestrator keeps focus (no focus theft).
#
# The set_status path escapes the PATH-based stub (open-session prepends the real cmux),
# so this also regression-locks the CMUX seam on _wh_cmux_set_status: the pill MUST hit
# the injected stub, never the live daemon.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

OPEN_SESSION="$REPO_ROOT/bin/open-session.sh"
[ -x "$OPEN_SESSION" ] || { echo "T56 SKIP — bin/open-session.sh missing"; exit 0; }

fail() { echo "FAIL[T56]: $*" >&2; exit 1; }

REF="workspace:616"
STUB="$T_TMP/cmux-stub"
STUBLOG="$T_TMP/stub.log"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
ref="${CMUX_STUB_REF:-workspace:616}"
cnt="${CMUX_STUB_CNT:?}"; log="${CMUX_STUB_LOG:?}"
echo "$*" >> "$log"
case "$1" in
  new-workspace)    echo "OK $ref" ;;
  list-workspaces)
    n=$(( $(cat "$cnt" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$cnt"
    echo "* workspace:1  orchestrator  [selected]"
    echo "  $ref  faketitle"
    ;;
  surface-health)   echo "surface:9  type=terminal in_window=false" ;;
  read-screen)      echo "  claude prompt rendered" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$STUB"

errf="$T_TMP/err.txt"; : > "$STUBLOG"; : > "$T_TMP/poll.cnt"
set +e
OUT=$(
  HOME="$T_TMP" \
  CTX_ROUTER_PATH=/nonexistent \
  CMUX_WORKSPACE_ID=test-t56 \
  CMUX="$STUB" \
  CMUX_STUB_REF="$REF" CMUX_STUB_CNT="$T_TMP/poll.cnt" CMUX_STUB_LOG="$STUBLOG" \
  CMUX_READY_TIMEOUT_MS=2000 CMUX_READY_INTERVAL_MS=10 \
  "$OPEN_SESSION" --track t56 --name pill --cwd "$T_TMP/cwd" --cli claude 2>"$errf"
)
RC=$?
set -e
ERRTXT=$(cat "$errf" 2>/dev/null || true)

# A) spawn succeeded, ref on stdout (pill wiring is best-effort — never gates/pollutes).
[ "$RC" -eq 0 ]                        || fail "A: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$REF" || fail "A: stdout='$OUT' want exactly '$REF'"

# B) the #616 ⚡working pill was pushed under the `aigentry` key for the new ref.
grep -qF "set-status aigentry working" "$STUBLOG" \
  || fail "B: #616 working pill not pushed. stub log:
$(cat "$STUBLOG")"
grep -qF -- "--workspace $REF" "$STUBLOG" \
  || fail "B: set-status not targeted at the spawned ref '$REF'. stub log:
$(cat "$STUBLOG")"

# C) NO focus theft — the orchestrator keeps its surface (옵션2 = sidebar pill only).
if grep -q 'select-workspace' "$STUBLOG"; then
  fail "C: FOCUS THEFT — select-workspace issued on spawn (옵션2 forbids it). stub log:
$(cat "$STUBLOG")"
fi

echo "T56 PASS"
