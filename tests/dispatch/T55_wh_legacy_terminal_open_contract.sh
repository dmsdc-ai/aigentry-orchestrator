#!/usr/bin/env bash
# T55 — per-adapter BC3 Tier conformance for the 5 terminal spawn adapters folded
# into the Workspace Host seam in #608 Phase 3 (ADR §7 P3 + §D2 + §12 BC3): aterm,
# tmux, wezterm, iterm, headless (the ghostty/generic daemon fold). Each _wh_<term>_open
# is the inline open-session.sh:open_in_terminal() branch moved 1:1 (byte-equivalent),
# so this proves the SPAWN contract each must satisfy as a Workspace Host `open`:
#
# A) fire-and-forget spawn: wh_open routes via AIGENTRY_WORKSPACE_HOST=<term> to
#    _wh_<term>_open, issues the host spawn command wrapping `telepty allow --id <sid>`
#    (or `telepty spawn` for headless), and emits exactly <sid> on stdout, rc 0.
# B) aterm/wezterm CLI absent → _wh_fallback_spawn (daemon PTY), still emits <sid>.
# C) iterm spawn failure (osascript fails) → return 2, NO handle (legacy `exit 2`).
# D) BC2 ready_attestation declared per adapter (= `none`: the byte-equivalent move
#    added no ready-gate; the Tier-1 label is a capability ceiling, not a claim).
# E) D2 registry/detect unification (G4 resolved): detect_terminal returns the right
#    adapter per env (ghostty/generic → headless); _wh_adapter LIFECYCLE auto-detect
#    stays cmux-or-headless even with TMUX/TERM_PROGRAM set (terminal routing comes
#    from detect_terminal→env-force, never from auto-detect).
# F) BC3 Tier classification table is declared in _wh_registry.
# G) BC2 — exactly the 9 verbs + 1 composite (no 10th public verb).
#
# Hermetic — terminal CLIs (aterm/wezterm/tmux/osascript) + telepty are stubbed on a
# curated PATH; NO live cmux daemon 3848, NO real terminal. platform.sh is sourced
# (the platform:: spawn primitives the tmux/iterm adapters consume) with
# PLATFORM_OVERRIDE=macos so the iTerm macOS gate is deterministic.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
PLATFORM="$REPO_ROOT/bin/lib/platform.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T55]: $*" >&2; exit 1; }

SID="t55-open"
CWD="$T_TMP/cwd"; mkdir -p "$CWD"
ATERM_LOG="$T_TMP/aterm.log"
WEZ_LOG="$T_TMP/wezterm.log"
TMUX_LOG="$T_TMP/tmux.log"
OSA_LOG="$T_TMP/osa.log"

mk_stub() { # <name> <log-or-empty>  → records argv (and stdin if log set), exit $RC.
  local name="$1" log="${2:-}"
  cat > "$STUB_BIN/$name" <<EOF
#!/usr/bin/env bash
printf '%s\n' "$name \$*" >> "${log:-/dev/null}"
cat >> "${log:-/dev/null}" 2>/dev/null || true
exit \${STUB_RC:-0}
EOF
  chmod +x "$STUB_BIN/$name"
}

CURATED="$STUB_BIN:/bin:/usr/bin"

# run_open <term> [extra-env...]  → OUT RC ERRTXT (forced <term> adapter).
run_open() {
  local term="$1"; shift
  : > "$ATERM_LOG"; : > "$WEZ_LOG"; : > "$TMUX_LOG"; : > "$OSA_LOG"
  local errf="$T_TMP/err.txt"
  set +e
  OUT=$(
    env "$@" \
      PATH="$CURATED" \
      PLATFORM_OVERRIDE=macos \
      AIGENTRY_WORKSPACE_HOST="$term" \
      "$BASH_BIN" -c '. "'"$PLATFORM"'"; . "'"$LIB"'"; wh_open "'"$SID"'" "'"$CWD"'" "claude --x"' 2>"$errf"
  )
  RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
}

# === A/B/C: per-adapter spawn contracts ===================================== #

# A-aterm: aterm CLI present → new-session issued wrapping telepty allow, emits sid.
mk_stub aterm "$ATERM_LOG"
run_open aterm
[ "$RC" -eq 0 ]                        || fail "aterm: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$SID" || fail "aterm: stdout='$OUT' want '$SID'"
grep -q 'new-session' "$ATERM_LOG"     || fail "aterm: new-session not issued. log:
$(cat "$ATERM_LOG")"
grep -qF "telepty allow --id $SID" "$ATERM_LOG" || fail "aterm: spawn did not wrap telepty allow"
rm -f "$STUB_BIN/aterm"

# B-aterm: aterm CLI ABSENT → fallback daemon (telepty spawn), still emits sid.
run_open aterm
[ "$RC" -eq 0 ]                        || fail "aterm-fallback: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$SID" || fail "aterm-fallback: stdout='$OUT' want '$SID'"

# A-tmux: tmux new-window issued via platform::, wrapping telepty allow, emits sid.
mk_stub tmux "$TMUX_LOG"
run_open tmux
[ "$RC" -eq 0 ]                        || fail "tmux: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$SID" || fail "tmux: stdout='$OUT' want '$SID'"
grep -q 'new-window' "$TMUX_LOG"       || fail "tmux: new-window not issued. log:
$(cat "$TMUX_LOG")"
grep -qF "telepty allow --id '$SID'" "$TMUX_LOG" || fail "tmux: spawn did not wrap telepty allow. log:
$(cat "$TMUX_LOG")"
rm -f "$STUB_BIN/tmux"

# A-wezterm: wezterm cli spawn issued wrapping telepty allow, emits sid.
mk_stub wezterm "$WEZ_LOG"
run_open wezterm
[ "$RC" -eq 0 ]                        || fail "wezterm: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$SID" || fail "wezterm: stdout='$OUT' want '$SID'"
grep -q 'cli spawn' "$WEZ_LOG"         || fail "wezterm: 'cli spawn' not issued. log:
$(cat "$WEZ_LOG")"
grep -qF "telepty allow --id $SID" "$WEZ_LOG" || fail "wezterm: spawn did not wrap telepty allow"
rm -f "$STUB_BIN/wezterm"

# B-wezterm: wezterm absent → fallback, still emits sid.
run_open wezterm
[ "$RC" -eq 0 ]                        || fail "wezterm-fallback: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$SID" || fail "wezterm-fallback: stdout='$OUT' want '$SID'"

# A-iterm: osascript (iTerm AppleScript) issued wrapping telepty allow, emits sid.
mk_stub osascript "$OSA_LOG"
run_open iterm STUB_RC=0
[ "$RC" -eq 0 ]                        || fail "iterm: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$SID" || fail "iterm: stdout='$OUT' want '$SID'"
grep -qF "telepty allow --id $SID" "$OSA_LOG" || fail "iterm: AppleScript did not wrap telepty allow. log:
$(cat "$OSA_LOG")"

# C-iterm: osascript FAILS → return 2, NO handle (legacy `exit 2` contract).
run_open iterm STUB_RC=1
[ "$RC" -eq 2 ]                        || fail "iterm-fail: rc=$RC want 2 (spawn-failure contract; err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -q "$SID" && fail "iterm-fail: emitted a handle despite spawn failure: '$OUT'"
printf '%s\n' "$ERRTXT" | grep -q 'iTerm spawn failed' || fail "iterm-fail: missing actionable stderr: '$ERRTXT'"
rm -f "$STUB_BIN/osascript"

# A-headless: daemon-PTY spawn (telepty spawn), emits sid + attach hint on stderr.
run_open headless
[ "$RC" -eq 0 ]                        || fail "headless: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$SID" || fail "headless: stdout='$OUT' want '$SID'"
printf '%s\n' "$ERRTXT" | grep -q 'telepty attach' || fail "headless: missing attach instructions: '$ERRTXT'"

# === D: BC2 ready_attestation declared per adapter ========================== #
for pair in aterm:none tmux:none wezterm:none iterm:none headless:none cmux:surface; do
  term="${pair%%:*}"; want="${pair##*:}"
  att=$(PATH="$CURATED" "$BASH_BIN" -c '. "'"$LIB"'"; _wh_'"$term"'_ready_attestation')
  [ "$att" = "$want" ] || fail "D: $term ready_attestation='$att' want '$want' (BC2)"
done

# === E: D2 registry / detect unification (G4) =============================== #
# Drive detect_terminal purely by env (clean env -i); detect's cmux predicate is
# CMUX_WORKSPACE_ID, never a PATH probe, so the lifecycle-only cmux PATH check can
# never interfere with "which terminal am I in".
d() { env -i PATH="/bin:/usr/bin" "$@" "$BASH_BIN" -c '. "'"$LIB"'"; detect_terminal' 2>/dev/null; }
[ "$(d CMUX_WORKSPACE_ID=ws-1)" = "cmux" ]      || fail "E: detect cmux (CMUX_WORKSPACE_ID)"
[ "$(d ATERM_IPC_SOCKET=/s)" = "aterm" ]        || fail "E: detect aterm (ATERM_IPC_SOCKET)"
[ "$(d TMUX=/tmp/tmux-1)" = "tmux" ]            || fail "E: detect tmux (TMUX)"
[ "$(d TERM_PROGRAM=WezTerm)" = "wezterm" ]     || fail "E: detect wezterm (TERM_PROGRAM)"
[ "$(d TERM_PROGRAM=iTerm.app)" = "iterm" ]     || fail "E: detect iterm (TERM_PROGRAM)"
[ "$(d TERM_PROGRAM=ghostty)" = "headless" ]    || fail "E: detect ghostty → headless (fold)"
[ "$(d)" = "headless" ]                         || fail "E: detect generic → headless (catch-all)"

# _wh_adapter LIFECYCLE auto-detect invariant: TMUX/TERM_PROGRAM set must NOT change
# the lifecycle adapter (no cmux on PATH → headless, NOT tmux/iterm).
a() { env -i PATH="$1" "$BASH_BIN" -c 'unset AIGENTRY_WORKSPACE_HOST
       TMUX=/tmp/t TERM_PROGRAM=iTerm.app; . "'"$LIB"'"; _wh_adapter' 2>/dev/null; }
[ "$(a /bin:/usr/bin)" = "headless" ] || fail "E: _wh_adapter auto-detect must stay headless (no cmux on PATH), not follow TMUX/TERM_PROGRAM"
# cmux on PATH → cmux (the live orchestrator's lifecycle host).
cat > "$STUB_BIN/cmux" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$STUB_BIN/cmux"
[ "$(a "$STUB_BIN:/bin:/usr/bin")" = "cmux" ] || fail "E: _wh_adapter auto-detect must select cmux when on PATH"
rm -f "$STUB_BIN/cmux"

# === F: BC3 Tier classification table declared in the registry ============== #
reg=$("$BASH_BIN" -c '. "'"$LIB"'"; _wh_registry')
for row in "cmux	yes	1" "aterm	no	2" "tmux	no	1" "wezterm	no	1" "iterm	no	1" "warp	no	2" "headless	yes	2"; do
  printf '%s\n' "$reg" | grep -qF "$row" || fail "F: registry row missing/wrong (BC3 tier): '$row'
got:
$reg"
done

# === G: BC2 — exactly the 9 verbs + 1 composite (no 10th public verb) ======= #
verbs=$("$BASH_BIN" -c '. "'"$LIB"'"; declare -F | sed -n "s/^declare -f //p" | grep "^wh_" | sort | tr "\n" " "')
want="wh_alive wh_clear_status wh_close wh_close_for_sid wh_focus wh_list_ids wh_lookup wh_open wh_prune_orphans wh_set_status "
[ "$verbs" = "$want" ] || fail "G: public verb set drift (BC2 9-verb boundary).
  got:  $verbs
  want: $want"

echo "T55 PASS"
