#!/usr/bin/env bash
# T54 — per-adapter contract test for warp `wh_open` (#608 Phase 2, ADR §5 D5 + §12
# BC1/BC2/BC3; re-pinned by task 1304 ADR D3 "Warp shows, tmux controls"). warp is a
# **Tier 2** adapter (no CLI to drive the surface — deeplink handoff only), so the worker
# runs in its own tmux session that the Warp tab attaches to, and the ready-gate waits
# for THAT session. This proves the warp spawn contract:
#   A) handle ⇒ tmux session + tab_config: wh_open BLOCKS until the worker's tmux session
#      exists and prints exactly the marker "telepty::<sid>"; the deeplink
#      `warp://tab_config/telepty-<sid>` was issued and the TOML titles the marker
#      (documented schema: top-level name/title, one [[panes]] — no [[tabs]]).
#   B) ready-gate timeout: the session never appears → return 3, NO handle, tab_config
#      GC'd (no half-spawned surface).
#   C) spawn failure: deeplink `open` fails → return 2, NO handle, GC'd.
#   D) handle round-trips: emitted marker == wh_lookup(sid).
#   E) no Accessibility in the spawn path: on Linux (xdg-open, no AX at all) the same
#      open succeeds the same way, and osascript is never called by an open.
#   F) BC2 — ready_attestation declared: `process` (the gate proves a session exists;
#      the screen is read by dispatch readiness through wh_read_screen).
#   G) BC1 — no V1 code path: the pane command carries NO `telepty allow --on-ready`
#      hook; it is the one `tmux new-session -A -s <name>` line.
#   H) BC2 — the public contract: the 9 verbs + 1 composite + 3 #1162 agent-meta verbs
#      + task 1304's wh_read_screen.
#
# Hermetic — osascript / uname / open / xdg-open / tmux are stubbed on a curated PATH (NO
# real Warp app, NO tmux server, NO live cmux daemon 3848). The `open` stub models Warp
# consuming the deeplink: it brings the worker's tmux session into existence in the tmux
# stub, exactly as the tab's `tmux new-session` would.
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
TMUX_NAME="aigentry-warp-$SID"
# Isolate ALL warp state under tmp — never touch the real ~/.aigentry or ~/.warp.
export AIGENTRY_WARP_SURFACE_DIR="$T_TMP/warp-surfaces"
export AIGENTRY_WARP_TAB_CONFIG_DIR="$T_TMP/tab_configs"
mkdir -p "$AIGENTRY_WARP_TAB_CONFIG_DIR"
TOML="$AIGENTRY_WARP_TAB_CONFIG_DIR/telepty-$SID.toml"
TMUX_STATE="$T_TMP/tmux-state"; mkdir -p "$TMUX_STATE"

OPEN_LOG="$T_TMP/open-calls.log"; : > "$OPEN_LOG"
OSA_LOG="$T_TMP/osa-calls.log";   : > "$OSA_LOG"
TMUX_LOG="$T_TMP/tmux-calls.log"; : > "$TMUX_LOG"

# uname → FAKE_UNAME (default Darwin). Linux exercises the xdg-open / no-AX path.
cat > "$STUB_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_UNAME:-Darwin}"
EOF

# osascript → only a recorder: the spawn path must never need it.
cat > "$STUB_BIN/osascript" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OSA_LOG"
cat >/dev/null 2>&1 || true
exit 0
EOF

# tmux → sessions are files under TMUX_STATE; has-session answers like tmux does.
cat > "$STUB_BIN/tmux" <<EOF
#!/usr/bin/env bash
printf '%s\n' "tmux \$*" >> "$TMUX_LOG"
t=""; a=("\$@"); for ((i=0; i<\${#a[@]}; i++)); do [ "\${a[i]}" = -t ] && t="\${a[i+1]:-}"; done
t="\${t#=}"; t="\${t%:}"
case "\$1" in
  has-session)  [ -e "$TMUX_STATE/\$t" ] && exit 0; echo "can't find session: \$t" >&2; exit 1 ;;
  kill-session) [ -e "$TMUX_STATE/\$t" ] && { rm -f "$TMUX_STATE/\$t"; exit 0; }; echo "can't find session: \$t" >&2; exit 1 ;;
esac
exit 0
EOF

# open / xdg-open → model Warp consuming the deeplink (macOS / Linux opener).
# OPEN_FAIL=1 → spawn cannot be issued. Otherwise (OPEN_SPAWN=1) the tab's
# `tmux new-session` runs, i.e. the worker's session appears in the tmux stub.
for opener in open xdg-open; do
  cat > "$STUB_BIN/$opener" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OPEN_LOG"
[ "\${OPEN_FAIL:-0}" = "1" ] && exit 1
[ "\${OPEN_SPAWN:-1}" = "1" ] && : > "$TMUX_STATE/$TMUX_NAME"
exit 0
EOF
  chmod +x "$STUB_BIN/$opener"
done
chmod +x "$STUB_BIN/uname" "$STUB_BIN/osascript" "$STUB_BIN/tmux"

PATH_W="$STUB_BIN:/bin:/usr/bin"

# run_warp_open <extra-env...> → sets OUT RC ERRTXT (forced warp adapter, fast gate).
run_warp_open() {
  : > "$OPEN_LOG"; : > "$OSA_LOG"; rm -f "$TOML" "$TMUX_STATE/$TMUX_NAME"
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

# --- A: the worker's tmux session appears → emits marker, rc 0 ---------------
run_warp_open OPEN_SPAWN=1
[ "$RC" -eq 0 ]                          || fail "A: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$MARK"  || fail "A: stdout='$OUT' want exactly '$MARK'"
[ -e "$TMUX_STATE/$TMUX_NAME" ]          || fail "A: handle emitted but the worker's tmux session does not exist"
[ -f "$TOML" ]                           || fail "A: tab_config TOML not written"
grep -qF "warp://tab_config/telepty-$SID" "$OPEN_LOG" \
  || fail "A: deeplink not issued (G5). open log:
$(cat "$OPEN_LOG")"
grep -qxF "title = \"$MARK\"" "$TOML"    || fail "A: TOML title != marker. TOML:
$(cat "$TOML")"
grep -qxF "name = \"$MARK\"" "$TOML"     || fail "A: TOML has no top-level name. TOML:
$(cat "$TOML")"
grep -qxF '[[panes]]' "$TOML"            || fail "A: TOML has no [[panes]] table (documented schema). TOML:
$(cat "$TOML")"
grep -qxF 'type = "terminal"' "$TOML"    || fail "A: pane type is not terminal. TOML:
$(cat "$TOML")"
grep -qF '[[tabs]]' "$TOML"              && fail "A: TOML still carries the [[tabs]] schema Warp does not execute. TOML:
$(cat "$TOML")"
# the gate actually asked tmux for the exact session.
grep -qF "has-session -t =$TMUX_NAME" "$TMUX_LOG" || fail "A: the ready-gate never probed the worker's tmux session. tmux log:
$(cat "$TMUX_LOG")"

# --- B: session never appears → rc 3, NO handle, GC'd ------------------------
run_warp_open OPEN_SPAWN=0
[ "$RC" -eq 3 ]                          || fail "B: rc=$RC want 3 (ready-timeout, err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -q 'telepty::' && fail "B: emitted a handle for a dead surface: '$OUT'"
printf '%s\n' "$ERRTXT" | grep -q 'ready-gate timed out' || fail "B: stderr missing actionable msg: '$ERRTXT'"
[ -f "$TOML" ]     && fail "B: tab_config not GC'd on timeout (half-spawned surface left)"

# --- C: deeplink open fails → rc 2, NO handle, GC'd --------------------------
run_warp_open OPEN_FAIL=1
[ "$RC" -eq 2 ]                          || fail "C: rc=$RC want 2 (spawn-failure, err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -q 'telepty::' && fail "C: emitted a handle despite spawn failure: '$OUT'"
[ -f "$TOML" ] && fail "C: tab_config not GC'd on spawn failure"

# --- D: handle round-trips through wh_lookup ---------------------------------
# Post-spawn, `telepty allow` has registered the sid → telepty list shows it; the
# warp marker is synthesized as the spawn-time contract "telepty::<sid>".
printf '%s' "[{\"id\":\"$SID\",\"command\":\"claude\"}]" > "$STUB_LIST_FILE"
run_warp_open OPEN_SPAWN=1
[ "$RC" -eq 0 ]                          || fail "D: spawn rc=$RC want 0"
lk=$(PATH="$PATH_W" AIGENTRY_WORKSPACE_HOST=warp \
  "$BASH_BIN" -c '. "'"$LIB"'"; wh_lookup "'"$SID"'"' 2>/dev/null)
[ "$lk" = "$MARK" ]                      || fail "D: wh_lookup='$lk' != emitted marker '$MARK' (no round-trip)"

# --- E: no AX in the spawn path — Linux (xdg-open, no AX) opens the same way ------
run_warp_open FAKE_UNAME=Linux OPEN_SPAWN=1
[ "$RC" -eq 0 ]                          || fail "E: Linux open rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$MARK"  || fail "E: Linux stdout='$OUT' want '$MARK'"
printf '%s\n' "$ERRTXT" | grep -q 'DEGRADED' && fail "E: the tmux-backed open still declares a DEGRADED AX gate: '$ERRTXT'"
[ -s "$OSA_LOG" ] && fail "E: an open called osascript (Accessibility is for focus only). osa log:
$(cat "$OSA_LOG")"

# --- F: BC2 ready_attestation declared --------------------------------------
att=$(PATH="$PATH_W" "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_ready_attestation')
[ "$att" = "process" ]                   || fail "F: warp ready_attestation='$att' want 'process' (gate = tmux session exists)"
att2=$(PATH="$PATH_W" FAKE_UNAME=Linux "$BASH_BIN" -c '. "'"$LIB"'"; _wh_warp_ready_attestation')
[ "$att2" = "process" ]                  || fail "F: warp ready_attestation(Linux)='$att2' want 'process'"

# --- G: BC1 — no V1 code path; the pane command is the tmux attach line -------
grep -qF -- '--on-ready' "$TOML" && fail "G: V1 leaked — the pane command carries a telepty --on-ready hook (BC1 rejects V1). TOML:
$(cat "$TOML")"
grep -qF "new-session -A -s '$TMUX_NAME' -c " "$TOML" || fail "G: the pane command is not the worker's tmux new-session line. TOML:
$(cat "$TOML")"

# --- H: BC2 — the 9 verbs + 1 composite + 3 #1162 agent-meta verbs + read_screen -
verbs=$("$BASH_BIN" -c '. "'"$LIB"'"; declare -F | sed -n "s/^declare -f //p" | grep "^wh_" | sort | tr "\n" " "')
# #1162 G2c: the three reviewed per-surface metadata verbs, listed literally (never
# derived from workspace-host.sh) so an added or dropped wh_ export still fails here.
# task 1304 ADR D4: wh_read_screen reopens the boundary on purpose (readiness reads it).
want="wh_agent_meta_caps wh_agent_meta_clear wh_agent_meta_set wh_alive wh_clear_status wh_close wh_close_for_sid wh_focus wh_list_ids wh_lookup wh_open wh_prune_orphans wh_read_screen wh_set_status "
[ "$verbs" = "$want" ] || fail "H: public verb set drift (BC2 verb boundary).
  got:  $verbs
  want: $want"

echo "T54 PASS"
