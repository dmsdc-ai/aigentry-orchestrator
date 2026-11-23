#!/usr/bin/env bash
# T25 — warp adapter: §17 graceful degrade, no-blind-close, INV-17 alive guard,
#       _wh_adapter selection (warp force-only / never auto-detected), wh_focus.
# Verdict 2026-05-30 surface-ownership. Tests source the lib + stub
# osascript/pgrep/uname/cmux/tmux on PATH or via a curated PATH. NO production edits.
# task 1304: warp alive/close are answered by tmux (ADR D3), so 1)-3) stub tmux.
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

# tmux stub (task 1304 D3: warp alive/close are tmux has-session / kill-session).
# Sessions are files under TMUX_STATE; TMUX_ANSWER overrides every reply (rc 1) to model
# a tmux that cannot answer. Records argv so the guard can see what was asked.
TMUX_STATE="$T_TMP/tmux-state"; mkdir -p "$TMUX_STATE"
TMUX_LOG="$T_TMP/tmux-calls.log"; : > "$TMUX_LOG"
make_tmux() {
  cat > "$STUB_BIN/tmux" <<EOF
#!/usr/bin/env bash
printf '%s\n' "tmux \$*" >> "$TMUX_LOG"
[ -n "\${TMUX_ANSWER:-}" ] && { echo "\$TMUX_ANSWER" >&2; exit 1; }
t=""; prev=""; for a in "\$@"; do [ "\$prev" = -t ] && t="\$a"; prev="\$a"; done
t="\${t#=}"; t="\${t%:}"
case "\$1" in
  has-session)  [ -e "$TMUX_STATE/\$t" ] && exit 0; echo "can't find session: \$t" >&2; exit 1 ;;
  kill-session) [ -e "$TMUX_STATE/\$t" ] && { rm -f "$TMUX_STATE/\$t"; exit 0; }; echo "can't find session: \$t" >&2; exit 1 ;;
esac
exit 0
EOF
  chmod +x "$STUB_BIN/tmux"
}
make_tmux

# ===========================================================================
# 1) §17 graceful degrade — NO osascript + non-macOS uname:
#    _wh_warp_close / _wh_warp_focus return 0 (no-op + log), never throw.
#    task 1304: close needs no UI-scripting at all any more (tmux kill-session);
#    a session tmux says does not exist is "already gone" → 0.
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
# 2) _wh_warp_alive INV-17 mass-vanish guard (task 1304: answered by tmux).
#    (a) tmux cannot answer (permission denied) -> INDETERMINATE -> alive (return 0)
#    (b) tmux ABSENT (unprobeable)              -> INDETERMINATE -> alive (return 0)
#    (c) session present                        -> alive (return 0)
#    (d) tmux: "can't find session"             -> gone  (return 1)
#    (e) tmux: "no server running"              -> gone  (return 1; the sessions die
#                                                  with their server)
# Never returns "gone" on the unprobeable paths (the #486 guard).
# ===========================================================================
make_uname "Darwin"
SID_ALIVE="sid-warp-alive"; MARK_ALIVE="telepty::$SID_ALIVE"
: > "$TMUX_STATE/aigentry-warp-$SID_ALIVE"
# (a) tmux answers with something that is not "no such session"
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" TMUX_ANSWER="error connecting to /tmp/tmux-0/default (Permission denied)" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_ALIVE"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "alive(tmux-unanswerable) returned '$rc', expected 0 (INV-17 INDETERMINATE->alive)"

# (b) tmux absent — unprobeable -> alive. Curated PATH WITHOUT tmux (no /usr/bin).
rm_stub tmux
rc=$(PATH="$STUB_BIN" "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_ALIVE"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "alive(no-tmux) returned '$rc', expected 0 (unprobeable->alive)"
make_tmux

# (c) session present -> alive
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_ALIVE"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "alive(session present) returned '$rc', expected 0 (alive)"
grep -qF "has-session -t =aigentry-warp-$SID_ALIVE" "$TMUX_LOG" || fail "alive did not ask tmux for the exact session; log:
$(cat "$TMUX_LOG")"

# (d) tmux answers no such session -> gone (return 1).
SID_GONE="sid-warp-gone"; MARK_GONE="telepty::$SID_GONE"
rm -f "$TMUX_STATE/aigentry-warp-$SID_GONE"
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_GONE"'"; echo $?' 2>/dev/null)
[ "$rc" = "1" ] || fail "alive(no such session) returned '$rc', expected 1 (gone)"

# (e) no tmux server on this socket -> gone (return 1).
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" TMUX_ANSWER="no server running on /tmp/tmux-0/default" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_alive "'"$MARK_ALIVE"'"; echo $?' 2>/dev/null)
[ "$rc" = "1" ] || fail "alive(no tmux server) returned '$rc', expected 1 (gone)"

# ===========================================================================
# 3) No blind destructive op: _wh_warp_close never sends a key or touches a window.
#    It kills exactly the worker's tmux session and removes what open wrote (tab
#    config, pre-1304 sentinel). Accessibility is left to focus, which matches the
#    window title EXACTLY (`telepty::w-1` must never raise `telepty::w-10`).
# ===========================================================================
make_uname "Darwin"
cat > "$STUB_BIN/osascript" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OSA_LOG"
cat >> "$OSA_LOG.script" 2>/dev/null || true   # keep the AppleScript text
exit 1
EOF
chmod +x "$STUB_BIN/osascript"
: > "$OSA_LOG"; : > "$OSA_LOG.script"; : > "$TMUX_LOG"
SID_ORPH="sid-warp-orphan"; MARK_ORPH="telepty::$SID_ORPH"
touch "$AIGENTRY_WARP_SURFACE_DIR/$SID_ORPH.live"
: > "$TMUX_STATE/aigentry-warp-$SID_ORPH"
rc=$(PATH="$STUB_BIN:/bin:/usr/bin" AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
  "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_close "'"$MARK_ORPH"'"; echo $?' 2>/dev/null)
[ "$rc" = "0" ] || fail "warp close returned '$rc', expected 0 (session released)"
grep -qF "kill-session -t =aigentry-warp-$SID_ORPH" "$TMUX_LOG" || fail "close did not kill the worker's tmux session; log:
$(cat "$TMUX_LOG")"
[ -e "$TMUX_STATE/aigentry-warp-$SID_ORPH" ] && fail "close left the worker's tmux session alive"
[ -s "$OSA_LOG" ] && fail "BLIND DESTRUCTIVE OP: close reached osascript (it must not send keys or raise windows):
$(cat "$OSA_LOG")"
[ -f "$AIGENTRY_WARP_SURFACE_DIR/$SID_ORPH.live" ] && fail "close did not remove the sentinel file"
# focus: one osascript call with the marker as argv, and an EXACT title comparison.
"$BASH_BIN" -c 'PATH="'"$STUB_BIN"':/bin:/usr/bin"; . "'"$LIB"'"; _wh_warp_focus "'"$MARK_ORPH"'"' >/dev/null 2>&1 \
  || fail "warp focus (window not found) did not degrade to 0"
grep -qF -- "- $MARK_ORPH" "$OSA_LOG" || fail "focus did not pass the marker as argv; log:
$(cat "$OSA_LOG")"
grep -qF '(name of w as string) is marker' "$OSA_LOG.script" || fail "focus does not match the window title EXACTLY; script:
$(cat "$OSA_LOG.script")"
grep -qF 'contains marker' "$OSA_LOG.script" && fail "focus still matches the title by substring; script:
$(cat "$OSA_LOG.script")"

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
