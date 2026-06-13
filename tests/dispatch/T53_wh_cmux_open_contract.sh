#!/usr/bin/env bash
# T53 — per-adapter contract test for cmux `wh_open` (#608 Phase 1, ADR §5 + §12 BC3).
#
# Proves the spawn contract that `_wh_cmux_open` (moved byte-for-byte from
# open-session.sh's cmux branch) must satisfy as the 9th Workspace Host verb:
#   A) handle emitted ⇒ pane ready: wh_open BLOCKS through the ready-gate and prints
#      the ref ONLY after the 3-part proof passes (never a pre-ready handle).
#   B) ready-gate timeout: non-zero exit, NO handle on stdout, the half-spawned
#      workspace is CLOSED (no orphaned surface left), actionable stderr.
#   C) spawn failure (no ref from new-workspace): return 2, no handle.
#   D) handle round-trips: the emitted ref == wh_lookup(sid) (cmuxWorkspaceId).
#   E) BC2 — `ready_attestation: surface` is declared for cmux.
#   F) BC2 — the public contract is EXACTLY the 9 verbs + 1 composite (no 10th verb;
#      readiness is an internal obligation of wh_open, not `wh_probe_ready`).
#
# Hermetic — a fake cmux stub injected via the CMUX env seam (NO live cmux daemon
# 3848, NO real `new-workspace`), driven by a poll-counter exactly as T39 does for
# the legacy inline path. T53 is the byte-equivalent twin of T39 at the adapter
# layer: the SAME ready-gate semantics must hold whether driven inline or via wh_open.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T53]: $*" >&2; exit 1; }

REF="workspace:777"
SID="t53-open"
STUB="$T_TMP/cmux-stub"
# Fake cmux. Poll counter increments on each list-workspaces (once-per-poll probe).
# The *_READY_AFTER vars decide when each ready signal flips on. Mirrors T39's stub
# so the two tests exercise an identical ready-gate against an identical surface.
cat > "$STUB" <<'EOF'
#!/usr/bin/env bash
ref="${CMUX_STUB_REF:-workspace:777}"
cnt="${CMUX_STUB_CNT:?}"; log="${CMUX_STUB_LOG:?}"
la="${STUB_LIST_READY_AFTER:-0}"; sa="${STUB_SURF_READY_AFTER:-0}"; ra="${STUB_READ_READY_AFTER:-0}"
case "$1" in
  new-workspace)
    echo "new-workspace $*" >> "$log"
    [ "${CMUX_STUB_NO_REF:-0}" = "1" ] && { echo "Error: spawn refused"; exit 0; }
    echo "OK $ref" ;;
  rename-workspace) echo "rename-workspace $*" >> "$log" ;;
  list-workspaces)
    n=$(( $(cat "$cnt" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$cnt"
    echo "* workspace:1  orchestrator  [selected]"
    [ "$n" -gt "$la" ] && echo "  $ref  faketitle"
    ;;
  surface-health)
    n=$(cat "$cnt" 2>/dev/null || echo 0)
    if [ "$n" -gt "$sa" ]; then echo "surface:9  type=terminal in_window=false"
    else echo "Error: not ready"; fi
    ;;
  read-screen)
    n=$(cat "$cnt" 2>/dev/null || echo 0)
    [ "$n" -gt "$ra" ] && echo "  claude prompt rendered" || true
    ;;
  close-workspace)  echo "close-workspace $*" >> "$log" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$STUB"

# run_open <list_after> <surf_after> <read_after> <timeout_ms> [no_ref]
#   → sets OUT RC ERRTXT CNT (calls wh_open via the forced cmux adapter).
run_open() {
  local la="$1" sa="$2" ra="$3" tmo="$4" noref="${5:-0}"
  : > "$T_TMP/stub.log"; : > "$T_TMP/poll.cnt"
  local errf="$T_TMP/err.txt"
  set +e
  OUT=$(
    AIGENTRY_WORKSPACE_HOST=cmux \
    CMUX="$STUB" \
    CMUX_STUB_REF="$REF" CMUX_STUB_CNT="$T_TMP/poll.cnt" CMUX_STUB_LOG="$T_TMP/stub.log" \
    CMUX_STUB_NO_REF="$noref" \
    STUB_LIST_READY_AFTER="$la" STUB_SURF_READY_AFTER="$sa" STUB_READ_READY_AFTER="$ra" \
    CMUX_READY_TIMEOUT_MS="$tmo" CMUX_READY_INTERVAL_MS=10 \
    "$BASH_BIN" -c '. "'"$LIB"'"; wh_open "'"$SID"'" "'"$T_TMP/cwd"'" "claude --x"' 2>"$errf"
  )
  RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
  CNT=$(cat "$T_TMP/poll.cnt" 2>/dev/null || echo 0)
}

# --- A: not-ready 3 polls then ready → blocks, emits ref, exit 0 -------------
run_open 3 0 0 2000
[ "$RC" -eq 0 ]                          || fail "A: rc=$RC want 0 (err: $ERRTXT)"
printf '%s\n' "$OUT" | grep -qx "$REF"   || fail "A: stdout='$OUT' want exactly '$REF'"
[ "$CNT" -ge 4 ]                         || fail "A: polled $CNT, expected >=4 (handle emitted before ready-gate passed)"

# --- B: never ready → exit!=0, NO handle, ws CLOSED (no half-spawned surface) -
run_open 99999 0 0 100
[ "$RC" -ne 0 ]                          || fail "B: rc=0 but should fail loud on timeout"
printf '%s\n' "$OUT" | grep -q 'workspace:' && fail "B: emitted a handle for a dead ws: '$OUT'"
printf '%s\n' "$ERRTXT" | grep -q 'not ready' || fail "B: stderr missing actionable msg: '$ERRTXT'"
grep -q "close-workspace --workspace $REF" "$T_TMP/stub.log" \
  || fail "B: half-spawned ws not closed. log:
$(cat "$T_TMP/stub.log")"

# --- C: new-workspace yields no ref → return 2, no handle --------------------
run_open 0 0 0 2000 1
[ "$RC" -eq 2 ]                          || fail "C: rc=$RC want 2 (spawn-failure contract)"
printf '%s\n' "$OUT" | grep -q 'workspace:' && fail "C: emitted a handle despite spawn failure: '$OUT'"

# --- D: handle round-trips through wh_lookup --------------------------------
# telepty list maps sid → cmuxWorkspaceId == the emitted ref (the cmux lookup key).
printf '%s' "[{\"id\":\"$SID\",\"cmuxWorkspaceId\":\"$REF\"}]" > "$STUB_LIST_FILE"
run_open 0 0 0 2000
[ "$RC" -eq 0 ]                          || fail "D: spawn rc=$RC want 0"
lk=$(AIGENTRY_WORKSPACE_HOST=cmux CMUX="$STUB" "$BASH_BIN" -c '. "'"$LIB"'"; wh_lookup "'"$SID"'"' 2>/dev/null)
[ "$lk" = "$REF" ]                       || fail "D: wh_lookup='$lk' != emitted ref '$REF' (no round-trip)"

# --- E: BC2 — cmux ready_attestation is surface-attested --------------------
att=$(AIGENTRY_WORKSPACE_HOST=cmux "$BASH_BIN" -c '. "'"$LIB"'"; _wh_cmux_ready_attestation')
[ "$att" = "surface" ]                   || fail "E: cmux ready_attestation='$att' want 'surface' (BC2)"

# --- F: BC2 — exactly the 9 verbs + 1 composite (no 10th public verb) -------
verbs=$("$BASH_BIN" -c '. "'"$LIB"'"; declare -F | sed -n "s/^declare -f //p" | grep "^wh_" | sort | tr "\n" " "')
want="wh_alive wh_clear_status wh_close wh_close_for_sid wh_focus wh_list_ids wh_lookup wh_open wh_prune_orphans wh_set_status "
[ "$verbs" = "$want" ] || fail "F: public verb set drift (BC2 9-verb boundary).
  got:  $verbs
  want: $want"

echo "T53 PASS"
