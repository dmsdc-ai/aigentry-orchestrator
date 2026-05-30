#!/usr/bin/env bash
# T25 — warp adapter: §17 graceful degrade, no-blind-close, INV-17 alive guard,
#       _wh_adapter selection (warp force-only / never auto-detected), wh_focus.
# Verdict 2026-05-30 surface-ownership. Tests source the lib + stub
# osascript/pgrep/uname/cmux on PATH or via a curated PATH. NO production edits.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
# Absolute bash so curated PATHs (used to hide pgrep/osascript) never lose the
# interpreter itself — `PATH=x bash -c` would otherwise search x for `bash`.
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T25]: $*" >&2; exit 1; }

# Isolate all warp surface state under the tmp dir.
export AIGENTRY_WARP_SURFACE_DIR="$T_TMP/warp-surfaces"
mkdir -p "$AIGENTRY_WARP_SURFACE_DIR"

# ---------------------------------------------------------------------------
# Stub builders. Each records invocations so we can assert *no* destructive op.
# ---------------------------------------------------------------------------
OSA_LOG="$T_TMP/osascript-calls.log"; : > "$OSA_LOG"
PGREP_LOG="$T_TMP/pgrep-calls.log";   : > "$PGREP_LOG"

# osascript stub: logs argv, drains stdin (the heredoc), exit code from $1.
make_osascript() { # $1 = exit code to return
  cat > "$STUB_BIN/osascript" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OSA_LOG"
cat >/dev/null 2>&1 || true   # drain the AppleScript heredoc
exit ${1}
EOF
  chmod +x "$STUB_BIN/osascript"
}

# uname stub: forces the reported OS (to exercise the non-macOS degrade path).
make_uname() { # $1 = string to print
  cat > "$STUB_BIN/uname" <<EOF
#!/usr/bin/env bash
printf '%s\n' "${1}"
EOF
  chmod +x "$STUB_BIN/uname"
}

# pgrep stub: exit 0 (Warp "running") only when WARP_UP=1 and pattern matches.
make_pgrep() {
  cat > "$STUB_BIN/pgrep" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PGREP_LOG"
if [ "\${WARP_UP:-0}" = "1" ]; then
  case "\$*" in *Warp.app*|*warp-terminal*) echo 99999; exit 0;; esac
fi
exit 1
EOF
  chmod +x "$STUB_BIN/pgrep"
}

rm_stub() { rm -f "$STUB_BIN/$1"; }

# ===========================================================================
# 1) §17 graceful degrade — NO osascript + non-macOS uname:
#    _wh_warp_close / _wh_warp_focus return 0 (no-op + log), never throw.
# ===========================================================================
make_uname "Linux"            # non-macOS
rm_stub osascript             # ensure NO osascript on the curated PATH
make_pgrep
DEGRADE_PATH="$STUB_BIN:/bin:/usr/bin"
out=$(PATH="$DEGRADE_PATH" AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
  "$BASH_BIN" -c '
    set -e
    . "'"$LIB"'"
    _wh_warp_close "telepty::sid-deg"; echo "close=$?"
    _wh_warp_focus "telepty::sid-deg"; echo "focus=$?"
  ' 2>/dev/null)
echo "$out" | grep -q '^close=0$' || fail "warp close did not degrade to 0 (non-macOS/no-osascript): $out"
echo "$out" | grep -q '^focus=0$' || fail "warp focus did not degrade to 0 (non-macOS/no-osascript): $out"

# ===========================================================================
# 2) _wh_warp_alive INV-17 mass-vanish guard.
#    (a) Warp DOWN (sentinel present)  -> INDETERMINATE -> alive (return 0)
#    (b) pgrep ABSENT (unprobeable)    -> INDETERMINATE -> alive (return 0)
#    (c) Warp UP + sentinel present    -> alive (return 0)
#    (d) Warp UP + sentinel absent     -> gone  (return 1)
# Never returns "gone" on the unprobeable / Warp-down paths (the #486 guard).
# ===========================================================================
make_uname "Darwin"
make_pgrep
SID_ALIVE="sid-warp-alive"; MARK_ALIVE="telepty::$SID_ALIVE"
touch "$AIGENTRY_WARP_SURFACE_DIR/$SID_ALIVE.live"
# (a) Warp down, sentinel present — must STILL be alive (never single-signal gone)
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" WARP_UP=0 AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_ALIVE"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "alive(Warp-down) returned '$rc', expected 0 (INV-17 INDETERMINATE->alive)"

# (b) pgrep absent — unprobeable -> alive. Curated PATH WITHOUT pgrep (no /usr/bin).
rc=$(PATH="$STUB_BIN" AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_ALIVE"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "alive(no-pgrep) returned '$rc', expected 0 (unprobeable->alive)"

# (c) Warp up + sentinel present -> alive
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" WARP_UP=1 AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_ALIVE"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "alive(Warp-up+sentinel) returned '$rc', expected 0 (alive)"

# (d) Warp up + sentinel absent -> gone (return 1). This is the ONLY 'gone' path.
SID_GONE="sid-warp-gone"; MARK_GONE="telepty::$SID_GONE"
rm -f "$AIGENTRY_WARP_SURFACE_DIR/$SID_GONE.live"
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" WARP_UP=1 AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_GONE"'"; echo $?' 2>/dev/null)
[ "$rc" = "1" ] || fail "alive(Warp-up+no-sentinel) returned '$rc', expected 1 (gone)"

# ===========================================================================
# 3) No blind destructive op: _wh_warp_close when the window CANNOT be
#    confirmed (raise fails) -> leaves orphan tab (return 0), NEVER issues a
#    blind Cmd+W (key code 13).
# ===========================================================================
make_uname "Darwin"
make_osascript 1          # every osascript invocation FAILS (window not found / AX denied)
: > "$OSA_LOG"
SID_ORPH="sid-warp-orphan"; MARK_ORPH="telepty::$SID_ORPH"
touch "$AIGENTRY_WARP_SURFACE_DIR/$SID_ORPH.live"
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" WARP_UP=1 AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_close "'"$MARK_ORPH"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "warp close (unconfirmable window) returned '$rc', expected 0 (orphan-left)"
grep -q "$MARK_ORPH" "$OSA_LOG" || fail "expected a raise-window osascript attempt; log:
$(cat "$OSA_LOG")"
# NEVER for a Cmd+W key-code send. The send passes the keycode (13) as argv.
if grep -Eq '(^| )13( |$)' "$OSA_LOG"; then
  fail "BLIND DESTRUCTIVE OP: a Cmd+W (key code 13) was sent on the unconfirmable path:
$(cat "$OSA_LOG")"
fi
[ -f "$AIGENTRY_WARP_SURFACE_DIR/$SID_ORPH.live" ] && fail "close did not remove the sentinel file"

# ===========================================================================
# 4) _wh_adapter selection.
# ===========================================================================
cat > "$STUB_BIN/warp" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$STUB_BIN/warp"
rm_stub cmux

a=$(PATH="$STUB_BIN:/bin:/usr/bin" AIGENTRY_WORKSPACE_HOST=warp \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_adapter' 2>/dev/null)
[ "$a" = "warp" ] || fail "_wh_adapter force-warp returned '$a', expected 'warp'"

# unset env, warp present, cmux ABSENT -> headless (warp NEVER auto-detected).
a=$(PATH="$STUB_BIN:/bin:/usr/bin" "$BASH_BIN" -c 'unset AIGENTRY_WORKSPACE_HOST; . "'"$LIB"'"; _wh_adapter' 2>/dev/null)
[ "$a" = "headless" ] || fail "_wh_adapter auto-detect (warp-on-PATH, no cmux) returned '$a', expected 'headless' (warp never auto-detected)"

# cmux present -> cmux
cat > "$STUB_BIN/cmux" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$STUB_BIN/cmux"
a=$(PATH="$STUB_BIN:/bin:/usr/bin" "$BASH_BIN" -c 'unset AIGENTRY_WORKSPACE_HOST; . "'"$LIB"'"; _wh_adapter' 2>/dev/null)
[ "$a" = "cmux" ] || fail "_wh_adapter auto-detect (cmux present) returned '$a', expected 'cmux'"

# ===========================================================================
# 5) wh_focus dispatch.
#    - cmux -> `cmux select-workspace --workspace <id>` (assert args via stub).
#    - headless -> no-op, return 0.
# ===========================================================================
CMUX_CALLS="$T_TMP/cmux-focus-calls.log"; : > "$CMUX_CALLS"
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
printf 'cmux %s\n' "\$*" >> "$CMUX_CALLS"
exit 0
EOF
chmod +x "$STUB_BIN/cmux"
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" AIGENTRY_WORKSPACE_HOST=cmux \
  "$BASH_BIN" -c '. "'"$LIB"'"; wh_focus ws-focus-x; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "wh_focus(cmux) returned '$rc', expected 0"
grep -qF "cmux select-workspace --workspace ws-focus-x" "$CMUX_CALLS" \
  || fail "wh_focus(cmux) did not call 'select-workspace --workspace ws-focus-x'; log:
$(cat "$CMUX_CALLS")"

rc=$(PATH="$STUB_BIN:/bin:/usr/bin" AIGENTRY_WORKSPACE_HOST=headless \
  "$BASH_BIN" -c '. "'"$LIB"'"; wh_focus anything; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "wh_focus(headless) returned '$rc', expected 0 (no-op)"

echo "T25 PASS"
