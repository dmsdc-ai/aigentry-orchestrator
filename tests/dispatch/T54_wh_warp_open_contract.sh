#!/usr/bin/env bash
# T54 — per-adapter contract test for warp `wh_open` (#608 Phase 2, ADR §5 D5 + §12
# BC1/BC2/BC3). warp is a **Tier 2** adapter (fire-and-forget spawn: no CLI to drive
# the surface — deeplink handoff + an in-surface sentinel). This proves the warp
# spawn contract closes G5 (deeplink call site) + G6 (sentinel writer):
#   A) handle ⇒ sentinel + tab_config: with AX, wh_open BLOCKS through the V2
#      ready-gate (surface-attested AX read-screen) and prints exactly the marker
#      "telepty::<sid>" only after Warp-alive + sentinel + AX content; the deeplink
#      `warp://tab_config/telepty-<sid>` was issued and the TOML titles the marker.
#   B) ready-gate timeout: surface never comes up (no sentinel) → return 3, NO
#      handle, tab_config + sentinel GC'd (no half-spawned surface).
#   C) spawn failure: deeplink `open` fails → return 2, NO handle, GC'd.
#   D) handle round-trips: emitted marker == wh_lookup(sid).
#   E) BC1 — DEGRADED path: AX/osascript ABSENT → still spawns (process-attested),
#      emits the marker + a LOUD "DEGRADED" stderr line (never a silent no-op).
#   F) BC2 — ready_attestation declared: `surface` with AX, `process` without.
#   G) BC1 — no V1 code path: the wrapper carries NO `telepty allow --on-ready` hook.
#   H) BC2 — the public contract is EXACTLY the 9 verbs + 1 composite (no 10th verb).
#
# Hermetic — osascript / pgrep / uname / open are stubbed on a curated PATH (NO real
# Warp app, NO live cmux daemon 3848). The `open` stub models Warp consuming the
# deeplink: it touches the sentinel exactly as the in-surface wrapper's `touch` would.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T54]: $*" >&2; exit 1; }

SID="t54-warp"
MARK="telepty::$SID"
# Isolate ALL warp state under tmp — never touch the real ~/.aigentry or ~/.warp.
export AIGENTRY_WARP_SURFACE_DIR="$T_TMP/warp-surfaces"
export AIGENTRY_WARP_TAB_CONFIG_DIR="$T_TMP/tab_configs"
mkdir -p "$AIGENTRY_WARP_SURFACE_DIR" "$AIGENTRY_WARP_TAB_CONFIG_DIR"
SENTINEL="$AIGENTRY_WARP_SURFACE_DIR/$SID.live"
TOML="$AIGENTRY_WARP_TAB_CONFIG_DIR/telepty-$SID.toml"

OPEN_LOG="$T_TMP/open-calls.log"; : > "$OPEN_LOG"
OSA_LOG="$T_TMP/osa-calls.log";   : > "$OSA_LOG"

# uname → FAKE_UNAME (default Darwin). Linux exercises the no-AX-capability degrade.
cat > "$STUB_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_UNAME:-Darwin}"
EOF

# pgrep → Warp "running" when WARP_UP=1 (the ready-gate's app-alive guard).
cat > "$STUB_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
if [ "${WARP_UP:-1}" = "1" ]; then
  case "$*" in *Warp.app*|*warp-terminal*) echo 99999; exit 0;; esac
fi
exit 1
EOF

# osascript → AX read-screen. Prints AX_CONTENT (surface text) when AX_OK=1; else
# fails (window not found / AX denied). Drains the heredoc stdin.
cat > "$STUB_BIN/osascript" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OSA_LOG"
cat >/dev/null 2>&1 || true
[ "\${AX_OK:-1}" = "1" ] || exit 1
printf '%s\n' "\${AX_CONTENT:-$MARK}"
exit 0
EOF

# open / xdg-open → model Warp consuming the deeplink (macOS / Linux opener).
# OPEN_FAIL=1 → spawn cannot be issued. Otherwise (OPEN_SPAWN=1) it touches the
# sentinel exactly as the in-surface wrapper's `touch <sentinel>` would once Warp
# launches the tab. Both openers share one body so either OS path is covered.
for opener in open xdg-open; do
  cat > "$STUB_BIN/$opener" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OPEN_LOG"
[ "\${OPEN_FAIL:-0}" = "1" ] && exit 1
[ "\${OPEN_SPAWN:-1}" = "1" ] && touch "$SENTINEL"
exit 0
EOF
  chmod +x "$STUB_BIN/$opener"
done
chmod +x "$STUB_BIN/uname" "$STUB_BIN/pgrep" "$STUB_BIN/osascript"

PATH_W="$STUB_BIN:/bin:/usr/bin"

# run_warp_open <extra-env...> → sets OUT RC ERRTXT (forced warp adapter, fast gate).
run_warp_open() {
  : > "$OPEN_LOG"; : > "$OSA_LOG"; rm -f "$SENTINEL" "$TOML"
  local errf="$T_TMP/err.txt"
  set +e
  OUT=$(
    env "$@" \
      PATH="$PATH_W" \
      AIGENTRY_WORKSPACE_HOST=warp \
      AIGENTRY_WARP_SURFACE_DIR="$AIGENTRY_WARP_SURFACE_DIR" \
      AIGENTRY_WARP_TAB_CONFIG_DIR="$AIGENTRY_WARP_TAB_CONFIG_DIR" \
      WARP_READY_TIMEOUT_MS=300 WARP_READY_INTERVAL_MS=10 \
      "$BASH_BIN" -c '. "'"$LIB"'"; wh_open "'"$SID"'" "'"$T_TMP/cwd"'" "claude --x"' 2>"$errf"
  )
  RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
}

# --- A: AX present → surface-attested ready-gate, emits marker, rc 0 ----------
run_warp_open WARP_UP=1 AX_OK=1 OPEN_SPAWN=1 AX_CONTENT="$MARK claude ready"
[ "$RC" -eq 0 ]                          || fail "A: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$MARK"  || fail "A: stdout='$OUT' want exactly '$MARK'"
[ -f "$SENTINEL" ]                       || fail "A: handle emitted but sentinel missing (G6)"
[ -f "$TOML" ]                           || fail "A: tab_config TOML not written"
grep -qF "warp://tab_config/telepty-$SID" "$OPEN_LOG" \
  || fail "A: deeplink not issued (G5). open log:
$(cat "$OPEN_LOG")"
grep -qF "title = '$MARK'" "$TOML"       || fail "A: TOML window title != marker. TOML:
$(cat "$TOML")"
# surface attestation actually consulted the AX read-screen.
grep -qF "$MARK" "$OSA_LOG"              || fail "A: AX read-screen not consulted (BC1 V2). osa log:
$(cat "$OSA_LOG")"

# --- B: surface never ready (no sentinel) → rc 3, NO handle, GC'd -------------
run_warp_open WARP_UP=1 AX_OK=1 OPEN_SPAWN=0 AX_CONTENT="$MARK"
[ "$RC" -eq 3 ]                          || fail "B: rc=$RC want 3 (ready-timeout, err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -q 'telepty::' && fail "B: emitted a handle for a dead surface: '$OUT'"
printf '%s\n' "$ERRTXT" | grep -q 'ready-gate timed out' || fail "B: stderr missing actionable msg: '$ERRTXT'"
[ -f "$SENTINEL" ] && fail "B: sentinel not GC'd on timeout"
[ -f "$TOML" ]     && fail "B: tab_config not GC'd on timeout (half-spawned surface left)"

# --- C: deeplink open fails → rc 2, NO handle, GC'd --------------------------
run_warp_open WARP_UP=1 AX_OK=1 OPEN_FAIL=1
[ "$RC" -eq 2 ]                          || fail "C: rc=$RC want 2 (spawn-failure, err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -q 'telepty::' && fail "C: emitted a handle despite spawn failure: '$OUT'"
[ -f "$TOML" ] && fail "C: tab_config not GC'd on spawn failure"

# --- D: handle round-trips through wh_lookup ---------------------------------
# Post-spawn, `telepty allow` has registered the sid → telepty list shows it; the
# warp marker is synthesized as the spawn-time contract "telepty::<sid>".
printf '%s' "[{\"id\":\"$SID\",\"command\":\"claude\"}]" > "$STUB_LIST_FILE"
run_warp_open WARP_UP=1 AX_OK=1 OPEN_SPAWN=1 AX_CONTENT="$MARK"
[ "$RC" -eq 0 ]                          || fail "D: spawn rc=$RC want 0"
lk=$(PATH="$PATH_W" AIGENTRY_WORKSPACE_HOST=warp \
  "$BASH_BIN" -c '. "'"$LIB"'"; wh_lookup "'"$SID"'"' 2>/dev/null)
[ "$lk" = "$MARK" ]                      || fail "D: wh_lookup='$lk' != emitted marker '$MARK' (no round-trip)"

# --- E1: BC1/BC6 DEGRADED via AX-DENIED — osascript present but read-screen FAILS.
# The surface spawns (sentinel lands), AX never attests → DEGRADE to process-attested
# (rc 0, marker emitted, LOUD line), never a hard timeout. AX_OK=0 → osascript exits 1.
run_warp_open WARP_UP=1 AX_OK=0 OPEN_SPAWN=1
[ "$RC" -eq 0 ]                          || fail "E1: AX-denied degraded rc=$RC want 0 (BC6 spawn worked; err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$MARK"  || fail "E1: degraded stdout='$OUT' want '$MARK'"
printf '%s\n' "$ERRTXT" | grep -q 'DEGRADED' || fail "E1: no LOUD degraded declaration (BC1/BC6/§13): '$ERRTXT'"

# --- E2: BC1 DEGRADED via NO AX CAPABILITY — non-macOS uname (no AX at all).
# Linux opener path (xdg-open). Process-attested floor → rc 0 + marker + LOUD line.
run_warp_open FAKE_UNAME=Linux WARP_UP=1 OPEN_SPAWN=1
[ "$RC" -eq 0 ]                          || fail "E2: no-AX degraded rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$MARK"  || fail "E2: degraded stdout='$OUT' want '$MARK'"
printf '%s\n' "$ERRTXT" | grep -q 'DEGRADED' || fail "E2: no LOUD degraded declaration (BC1/BC6/§13): '$ERRTXT'"

# --- F: BC2 ready_attestation declared per AX capability ---------------------
att=$(PATH="$PATH_W" "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_ready_attestation')
[ "$att" = "surface" ]                   || fail "F: warp ready_attestation(AX)='$att' want 'surface' (BC2 V2)"
att2=$(PATH="$PATH_W" FAKE_UNAME=Linux "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_ready_attestation')
[ "$att2" = "process" ]                  || fail "F: warp ready_attestation(no-AX)='$att2' want 'process' (BC2 degraded)"

# --- G: BC1 — no V1 code path: the spawned wrapper has NO --on-ready hook -----
grep -qF -- '--on-ready' "$TOML" && fail "G: V1 leaked — wrapper carries a telepty --on-ready hook (BC1 rejects V1). TOML:
$(cat "$TOML")"
grep -qF "touch $SENTINEL" "$TOML"       || fail "G: wrapper does not write the sentinel (G6 fix missing). TOML:
$(cat "$TOML")"

# --- H: BC2 — exactly the 9 verbs + 1 composite (no 10th public verb) --------
verbs=$("$BASH_BIN" -c '. "'"$LIB"'"; declare -F | sed -n "s/^declare -f //p" | grep "^wh_" | sort | tr "\n" " "')
want="wh_alive wh_clear_status wh_close wh_close_for_sid wh_focus wh_list_ids wh_lookup wh_open wh_prune_orphans wh_set_status "
[ "$verbs" = "$want" ] || fail "H: public verb set drift (BC2 9-verb boundary).
  got:  $verbs
  want: $want"

echo "T54 PASS"
