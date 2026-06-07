#!/usr/bin/env bash
# T39 — open-session.sh cmux workspace readiness barrier (BUG-A: close the submit-race).
#
# open-session.sh returned the workspace ref OPTIMISTICALLY on a string-parse of
# `workspace:N`, before the pane surface could accept `cmux send-key` → the daemon submit
# raced a not-yet-live socket ("Failed to write to socket") → the worker's Enter was lost.
# The fix gates the ref behind _cmux_wait_ready, a 3-part output-text proof per poll:
#   (a) list-workspaces contains the exact ref (fallback-immune existence anchor)
#   (b) surface-health shows `type=terminal` and no `Error:`  (pane surface exists)
#   (c) read-screen returns non-empty content and no `Error:` (surface renders/responds)
#
# Hermetic — a fake cmux stub (injected via the CMUX env seam, NO live spawn) is driven by
# a poll-counter to simulate not-ready→ready transitions. Cases:
#   A) not-ready 3x then ready  → open-session waits, then prints the ref, exit 0
#   B) never ready (timeout)    → exit != 0, NO ref on stdout, actionable stderr, ws closed
#   C) fallback-immunity        → list omits ref but surface/read "pass" → gate must NOT
#                                 pass, and the fallback-prone surface-health is never
#                                 consulted (existence short-circuits first)
#   D) read-screen confirm gate → list+surface ready but read-screen empty 3x then renders
#                                 → gate waits on (c) past (a)+(b), then exit 0
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

OPEN_SESSION="$REPO_ROOT/bin/open-session.sh"
[ -x "$OPEN_SESSION" ] || { echo "T39 SKIP — bin/open-session.sh missing"; exit 0; }

fail() { echo "FAIL[T39]: $*" >&2; exit 1; }

REF="workspace:777"
STUB="$T_TMP/cmux-stub"
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
# Fake cmux. Poll counter increments on each list-workspaces (the outermost, once-per-poll
# probe). The *_READY_AFTER vars decide when each signal flips to ready.
ref="${CMUX_STUB_REF:-workspace:777}"
cnt="${CMUX_STUB_CNT:?}"; log="${CMUX_STUB_LOG:?}"
la="${STUB_LIST_READY_AFTER:-0}"; sa="${STUB_SURF_READY_AFTER:-0}"; ra="${STUB_READ_READY_AFTER:-0}"
case "$1" in
  new-workspace)    echo "OK $ref" ;;
  rename-workspace) : ;;
  list-workspaces)
    n=$(( $(cat "$cnt" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$cnt"
    echo "* workspace:1  orchestrator  [selected]"
    [ "$n" -gt "$la" ] && echo "  $ref  faketitle"
    ;;
  surface-health)
    echo "surface-health $*" >> "$log"
    n=$(cat "$cnt" 2>/dev/null || echo 0)
    if [ "$n" -gt "$sa" ]; then echo "surface:9  type=terminal in_window=false"
    else echo "Error: not ready"; fi
    ;;
  read-screen)
    echo "read-screen $*" >> "$log"
    n=$(cat "$cnt" 2>/dev/null || echo 0)
    [ "$n" -gt "$ra" ] && echo "  claude prompt rendered" || true
    ;;
  close-workspace)  echo "close $*" >> "$log" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$STUB"

# run_open <list_after> <surf_after> <read_after> <timeout_ms>  → sets: OUT RC ERRTXT CNT
run_open() {
  local la="$1" sa="$2" ra="$3" tmo="$4"
  : > "$T_TMP/stub.log"; : > "$T_TMP/poll.cnt"
  local errf="$T_TMP/err.txt"
  set +e
  OUT=$(
    HOME="$T_TMP" \
    CTX_ROUTER_PATH=/nonexistent \
    CMUX_WORKSPACE_ID=test-t39 \
    CMUX="$STUB" \
    CMUX_STUB_REF="$REF" CMUX_STUB_CNT="$T_TMP/poll.cnt" CMUX_STUB_LOG="$T_TMP/stub.log" \
    STUB_LIST_READY_AFTER="$la" STUB_SURF_READY_AFTER="$sa" STUB_READ_READY_AFTER="$ra" \
    CMUX_READY_TIMEOUT_MS="$tmo" CMUX_READY_INTERVAL_MS=10 \
    "$OPEN_SESSION" --track t39 --name ready --cwd "$T_TMP/cwd" --cli claude 2>"$errf"
  )
  RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
  CNT=$(cat "$T_TMP/poll.cnt" 2>/dev/null || echo 0)
}

# --- A: not-ready 3 polls then ready → waits, returns ref, exit 0 ------------
run_open 3 0 0 2000
[ "$RC" -eq 0 ]                          || fail "A: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$REF"   || fail "A: stdout='$OUT' want exactly '$REF'"
[ "$CNT" -ge 4 ]                         || fail "A: polled $CNT times, expected >=4 (must wait)"

# --- B: never ready → exit!=0, NO ref on stdout, actionable stderr, ws closed -
run_open 99999 0 0 100
[ "$RC" -ne 0 ]                          || fail "B: rc=0 but should fail loud on timeout"
printf '%s\n' "$OUT" | grep -q 'workspace:' && fail "B: emitted a ref for a dead ws: '$OUT'"
printf '%s\n' "$ERRTXT" | grep -q 'not ready' || fail "B: stderr missing actionable msg: '$ERRTXT'"
grep -q "close-workspace --workspace $REF" "$T_TMP/stub.log" || fail "B: dead ws not closed. log:
$(cat "$T_TMP/stub.log")"

# --- C: fallback-immunity → existence fails, surface/read 'pass' → gate blocks,
#        and surface-health is NEVER consulted (existence short-circuits first) --
run_open 99999 0 0 100
[ "$RC" -ne 0 ]                          || fail "C: gate passed on surface-health despite missing existence anchor"
printf '%s\n' "$OUT" | grep -q 'workspace:' && fail "C: emitted a ref via fallback false-positive: '$OUT'"
grep -q 'surface-health' "$T_TMP/stub.log" && fail "C: surface-health consulted for an unregistered ref (fallback-prone probe not gated by existence)"

# --- D: read-screen confirm gate → list+surface ready, read empty 3x then renders -
run_open 0 0 3 2000
[ "$RC" -eq 0 ]                          || fail "D: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$REF"   || fail "D: stdout='$OUT' want exactly '$REF'"
[ "$CNT" -ge 4 ]                         || fail "D: polled $CNT times; read-screen gate did not hold past surface-health"
grep -q 'read-screen' "$T_TMP/stub.log"  || fail "D: read-screen 3rd-confirm was never exercised"

echo "T39 PASS"
