#!/usr/bin/env bash
# T27 — sole surface-close + idempotency (verdict 2026-05-30 §4/§6):
#   * session-cleanup.sh routes surface-close through wh_close EXACTLY ONCE
#     (the SOLE orchestrator close path — no second/direct cmux close-workspace).
#   * a transient DOUBLE wh_close (telepty-rollout window) is an idempotent
#     no-op: an already-gone host returns 0, never a hard failure.
# Stubs telepty/cmux/curl on PATH (session-cleanup.sh does NOT override PATH).
# NO production edits.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T27]: $*" >&2; exit 1; }

# curl stub: DELETE registry → 404 (already gone). Fast + offline.
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo 404
EOF
chmod +x "$STUB_BIN/curl"

# ===========================================================================
# 1) SOLE close: session-cleanup.sh sid-x → wh_close → exactly ONE
#    `cmux close-workspace --workspace ws-x`. No duplicate/direct close.
# ===========================================================================
CMUX_CALLS="$T_TMP/cmux-calls.log"; : > "$CMUX_CALLS"
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CMUX_CALLS"
case "\$1" in
  list-workspaces) [ "\${2:-}" = "--json" ] && echo '[{"id":"ws-x"}]';;
  close-workspace) exit 0;;   # close succeeds
  *) exit 0;;
esac
EOF
chmod +x "$STUB_BIN/cmux"

# telepty list maps sid-x → cmuxWorkspaceId ws-x
printf '%s' '[{"id":"sid-x","healthStatus":"CONNECTED","cmuxWorkspaceId":"ws-x"}]' > "$STUB_LIST_FILE"

AIGENTRY_WORKSPACE_HOST=cmux bash "$CLEANUP" sid-x >/dev/null 2>&1 \
  || fail "session-cleanup.sh sid-x exited non-zero on a healthy close"

n=$(grep -c "close-workspace --workspace ws-x" "$CMUX_CALLS" || true)
[ "$n" = "1" ] \
  || fail "expected EXACTLY ONE surface close-workspace call (sole-close), got $n; calls:
$(cat "$CMUX_CALLS")"

# ===========================================================================
# 2) Idempotent double wh_close: an already-gone host returns 0 BOTH times.
#    cmux stub: close-workspace FAILS (already gone) + list shows it absent →
#    _wh_cmux_close re-probes alive → gone → returns 0.
# ===========================================================================
cat > "$STUB_BIN/cmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  list-workspaces) [ "${2:-}" = "--json" ] && echo '[]';;  # ws-gone absent
  close-workspace) exit 1;;                                  # "fails" = already gone
  *) exit 0;;
esac
EOF
chmod +x "$STUB_BIN/cmux"

out=$(AIGENTRY_WORKSPACE_HOST=cmux "$BASH_BIN" -c '
  . "'"$LIB"'"
  wh_close ws-gone; echo "first=$?"
  wh_close ws-gone; echo "second=$?"
' 2>/dev/null)
echo "$out" | grep -q '^first=0$'  || fail "first wh_close(already-gone) not 0: $out"
echo "$out" | grep -q '^second=0$' || fail "second wh_close(already-gone) not 0 (not idempotent): $out"

# ===========================================================================
# 3) Idempotency across the other adapters (double-close = 0,0).
#    headless: pure no-op. warp: degrade no-op (non-macOS uname → no UI-script).
# ===========================================================================
out=$(AIGENTRY_WORKSPACE_HOST=headless "$BASH_BIN" -c '
  . "'"$LIB"'"
  wh_close any; echo "first=$?"
  wh_close any; echo "second=$?"
' 2>/dev/null)
echo "$out" | grep -q '^first=0$'  || fail "headless first wh_close not 0: $out"
echo "$out" | grep -q '^second=0$' || fail "headless second wh_close not 0: $out"

# warp degrade: force non-macOS via uname stub so close is a logged no-op → 0,0.
cat > "$STUB_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf 'Linux\n'
EOF
chmod +x "$STUB_BIN/uname"
export AIGENTRY_WARP_SURFACE_DIR="$T_TMP/warp-surfaces"; mkdir -p "$AIGENTRY_WARP_SURFACE_DIR"
out=$(PATH="$STUB_BIN:/bin:/usr/bin" AIGENTRY_WORKSPACE_HOST=warp \
  AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" "$BASH_BIN" -c '
  . "'"$LIB"'"
  wh_close "telepty::sid-w"; echo "first=$?"
  wh_close "telepty::sid-w"; echo "second=$?"
' 2>/dev/null)
echo "$out" | grep -q '^first=0$'  || fail "warp first wh_close (degrade) not 0: $out"
echo "$out" | grep -q '^second=0$' || fail "warp second wh_close (degrade) not 0: $out"

echo "T27 PASS"
