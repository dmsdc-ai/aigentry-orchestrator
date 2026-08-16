#!/usr/bin/env bash
# T104 (#899 pre-tranche-2) — bin/wh-cli.sh is the SAME thing as sourcing
# bin/lib/workspace-host.sh and calling the function.
#
# Tranche 2 ports session-cleanup.sh / session-reconciler.sh / open-session.sh to
# TypeScript. Those three do not invoke the workspace host, they `source` it and call
# its bash functions in-process, and a TS port cannot source bash. wh-cli.sh is the
# subprocess door that makes the port possible — so the ONLY thing that makes the port
# safe is a measurement that the door and the function agree. That is this guard:
#
#   A) equivalence, cmux adapter — every verb, CLI exit code + stdout == the sourced
#      function's exit code + stdout, run back-to-back against one stub cmux.
#   B) equivalence, headless adapter — same 11 verbs down the no-op arm, because a
#      forwarding bug that only shows up when the adapter does nothing is still a bug
#      in the door (CI and docker run headless).
#   C) the exit-code contract table for `open` reproduced THROUGH the CLI: 0 with a
#      ref, 2 on spawn failure, 3 on ready-gate timeout with no ref emitted.
#   D) argv hygiene — unknown/absent verb is 64 with usage on stderr, and no verb
#      reaches a computed function name.
#   E) the init-workspace layout (bin/ copied, no repo, no dist/, cwd elsewhere) —
#      the T99/T100 catch, checked here rather than in a fourth shim guard.
#   F) coverage — the CLI's declared verb set == every public wh_* function the lib
#      defines, plus detect_terminal. A 12th verb appearing in the lib without a door
#      fails HERE rather than in tranche 2.
#
# Why detect_terminal is in the set: open-session.sh:201 and :272 call it and
# open-session.sh is a tranche-2 target, so it is public in practice whatever the
# prose says. It was found by grepping all 69 lib functions against all three
# consumers; that sweep also found _wh_adapter and _wh_fallback_spawn appear in
# open-session.sh's COMMENTS only, which is why they are not doors. Part F is that
# sweep frozen into an assertion.
#
# Hermetic — a stub cmux on PATH and on the CMUX seam. NO live cmux daemon 3848, no
# real new-workspace/close-workspace, exactly as T23/T39/T53 do it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
CLI="$REPO_ROOT/bin/wh-cli.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T104]: $*" >&2; exit 1; }

[ -f "$CLI" ] || fail "bin/wh-cli.sh does not exist — tranche 2 has no subprocess door onto the workspace host"
[ -x "$CLI" ] || fail "bin/wh-cli.sh is not executable"

REF="workspace:777"
SID="t104-sid"
STUB_LOG="$T_TMP/cmux.log"
LEDGER="$T_TMP/orphan-ledger.json"
export AIGENTRY_CMUX_ORPHAN_LEDGER="$LEDGER"

# ── stub cmux ────────────────────────────────────────────────────────────────────
# Deliberately PURE (no poll counters, ready on the first probe): part A runs each
# verb twice and compares, so any hidden per-invocation state would show up as a
# false drift. T53 owns the counter-driven ready-gate timing; this guard owns the
# CLI-vs-function equality.
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
echo "cmux \$*" >> "$STUB_LOG"
if [ "\$1" = "--json" ] && [ "\$2" = "list-workspaces" ]; then
  cat "$T_TMP/workspaces.json"; exit 0
fi
case "\$1" in
  new-workspace)
    [ "\${CMUX_STUB_NO_REF:-0}" = "1" ] && { echo "Error: spawn refused"; exit 0; }
    echo "OK $REF" ;;
  rename-workspace|set-status|clear-status|select-workspace|close-workspace) : ;;
  list-workspaces) echo "* workspace:1  orchestrator"; echo "  $REF  faketitle" ;;
  surface-health)
    if [ "\${CMUX_STUB_NEVER_READY:-0}" = "1" ]; then echo "Error: not ready"
    else echo "surface:9  type=terminal in_window=false"; fi ;;
  read-screen)     echo "  claude prompt rendered" ;;
  sidebar-state)
    case "\${3:-}" in
      $REF|ws-alive) echo "tab=\${3} status_count=0" ;;
      *) echo "Error: ERROR: Tab not found" ;;
    esac ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/cmux"
export CMUX="$STUB_BIN/cmux"

# Two workspaces: one live (title == SID) and one orphan whose cwd is under the
# harness sandbox, so prune-orphans has a real candidate to reason about.
ORPHAN_CWD="$AIGENTRY_ROLE_SANDBOX_DIR/gone-worker"
printf '%s' "{\"workspaces\":[
  {\"ref\":\"$REF\",\"title\":\"$SID\",\"current_directory\":\"/elsewhere\"},
  {\"ref\":\"workspace:9\",\"title\":\"gone-worker\",\"current_directory\":\"$ORPHAN_CWD\"}
]}" > "$T_TMP/workspaces.json"
printf '%s' "[{\"id\":\"$SID\",\"healthStatus\":\"CONNECTED\",\"cmuxWorkspaceId\":\"$REF\"}]" \
  > "$STUB_LIST_FILE"

# reset_state — everything a verb may have mutated, back to the pre-run value, so the
# sourced run and the CLI run start from byte-identical state. The ledger is seeded
# WITH the orphan so prune-orphans takes its close path (seen-twice debounce already
# satisfied) instead of only recording a first sighting.
reset_state() {
  : > "$STUB_LOG"
  printf '%s' '{"workspace:9":"2026-08-16T00:00:00Z"}' > "$LEDGER"
}

# run_sourced <fn> [args…] / run_cli <verb> [args…] — the two halves under test.
run_sourced() {
  local fn="$1"; shift
  "$BASH_BIN" -c '. "$1"; f="$2"; shift 2; "$f" "$@"' wh-src "$LIB" "$fn" "$@"
}
run_cli() { "$BASH_BIN" "$CLI" "$@"; }

# eq <verb> [args…] — the assertion this whole guard exists for.
eq() {
  local verb="$1"; shift
  local fn="wh_${verb//-/_}"
  [ "$verb" = "detect-terminal" ] && fn="detect_terminal"
  local s_out c_out s_rc c_rc
  set +e
  reset_state; s_out=$(run_sourced "$fn" "$@" 2>/dev/null); s_rc=$?
  reset_state; c_out=$(run_cli    "$verb" "$@" 2>/dev/null); c_rc=$?
  set -e
  [ "$s_rc" = "$c_rc" ] || fail "$ADAPTER/$verb: exit drift — sourced=$s_rc cli=$c_rc"
  [ "$s_out" = "$c_out" ] || fail "$ADAPTER/$verb: stdout drift
  sourced: '$s_out'
  cli:     '$c_out'"
  echo "  ok $ADAPTER/$verb rc=$s_rc out='$s_out'"
}

# all_verbs — one call per verb with arguments that reach real behaviour, not a
# no-arg smoke test. Runs identically under every adapter.
all_verbs() {
  eq open "$SID" "$T_TMP/cwd" "claude --x"
  eq lookup "$SID"
  eq lookup "$SID" "{\"id\":\"$SID\",\"cmuxWorkspaceId\":\"$REF\"}"
  eq lookup "no-such-sid"
  eq close "$REF"
  eq alive "$REF"
  eq alive "workspace:404"
  eq list-ids
  eq focus "$REF"
  eq prune-orphans "$SID" "workspace:1"
  eq set-status "$REF" working
  eq set-status "$REF" bogus-state
  eq clear-status "$REF"
  eq close-for-sid "$SID"
  eq close-for-sid "no-such-sid"
  eq detect-terminal
}

# --- A: cmux adapter — every verb agrees ----------------------------------------
ADAPTER=cmux
export AIGENTRY_WORKSPACE_HOST=cmux
all_verbs

# --- B: headless adapter — every verb agrees down the no-op arm -----------------
# `open` excluded from the sweep here and asserted separately: the headless open
# spawns through telepty (the stub) and prints attach instructions, so it is the one
# verb whose two runs are compared with the spawn recorded rather than suppressed.
ADAPTER=headless
export AIGENTRY_WORKSPACE_HOST=headless
eq lookup "$SID"
eq close "$REF"
eq alive "$REF"
eq list-ids
eq focus "$REF"
eq prune-orphans "$SID" "workspace:1"
eq set-status "$REF" working
eq clear-status "$REF"
eq close-for-sid "$SID"
eq detect-terminal
eq open "$SID" "$T_TMP/cwd" "claude --x"

# --- C: the `open` exit-code table, through the CLI -----------------------------
export AIGENTRY_WORKSPACE_HOST=cmux
open_cli() {
  set +e
  OUT=$(CMUX_READY_TIMEOUT_MS=100 CMUX_READY_INTERVAL_MS=10 \
        "$BASH_BIN" "$CLI" open "$SID" "$T_TMP/cwd" "claude --x" 2>"$T_TMP/open.err")
  RC=$?
  set -e
}
reset_state; open_cli
[ "$RC" -eq 0 ] || fail "C: ready spawn rc=$RC want 0 (stderr: $(cat "$T_TMP/open.err"))"
[ "$OUT" = "$REF" ] || fail "C: ready spawn stdout='$OUT' want '$REF'"

reset_state; CMUX_STUB_NO_REF=1 open_cli
[ "$RC" -eq 2 ] || fail "C: spawn-failure rc=$RC want 2"
printf '%s' "$OUT" | grep -q 'workspace:' && fail "C: emitted a handle despite spawn failure: '$OUT'"

reset_state; CMUX_STUB_NEVER_READY=1 open_cli
[ "$RC" -eq 3 ] || fail "C: ready-gate-timeout rc=$RC want 3"
printf '%s' "$OUT" | grep -q 'workspace:' && fail "C: emitted a handle for a never-ready ws: '$OUT'"
grep -q "close-workspace --workspace $REF" "$STUB_LOG" \
  || fail "C: half-spawned ws not closed through the CLI. log:
$(cat "$STUB_LOG")"

# --- D: argv hygiene ------------------------------------------------------------
set +e
"$BASH_BIN" "$CLI" no-such-verb >/dev/null 2>"$T_TMP/d.err"; d_rc=$?
"$BASH_BIN" "$CLI"              >/dev/null 2>"$T_TMP/d2.err"; d2_rc=$?
"$BASH_BIN" "$CLI" --help       >"$T_TMP/help.txt" 2>&1;      d3_rc=$?
set -e
[ "$d_rc" -eq 64 ]  || fail "D: unknown verb rc=$d_rc want 64"
grep -q "unknown verb" "$T_TMP/d.err" || fail "D: unknown verb has no actionable stderr"
[ "$d2_rc" -eq 64 ] || fail "D: no verb rc=$d2_rc want 64"
[ "$d3_rc" -eq 0 ]  || fail "D: --help rc=$d3_rc want 0"
# A verb must never be a computed function name: an internal is not reachable as one.
set +e
"$BASH_BIN" "$CLI" _wh_cmux_close "$REF" >/dev/null 2>&1; d4_rc=$?
set -e
[ "$d4_rc" -eq 64 ] || fail "D: an internal lib function was reachable as a verb (rc=$d4_rc)"

# --- E: init-workspace layout (bin/ copied, no repo, no dist/, cwd elsewhere) ----
WS="$T_TMP/workspace"
mkdir -p "$WS/bin/lib"
cp "$CLI" "$WS/bin/wh-cli.sh"
cp "$LIB" "$WS/bin/lib/workspace-host.sh"
chmod +x "$WS/bin/wh-cli.sh"
set +e
e_out=$(cd / && AIGENTRY_WORKSPACE_HOST=headless "$BASH_BIN" "$WS/bin/wh-cli.sh" detect-terminal 2>"$T_TMP/e.err")
e_rc=$?
set -e
[ "$e_rc" -eq 0 ] || fail "E: workspace copy failed (rc=$e_rc) — the lib is resolved relative to cwd, not to the script.
$(cat "$T_TMP/e.err")"
[ -n "$e_out" ] || fail "E: workspace copy printed nothing for detect-terminal"
set +e
(cd / && AIGENTRY_WORKSPACE_HOST=headless "$BASH_BIN" "$WS/bin/wh-cli.sh" alive x >/dev/null 2>&1); e2_rc=$?
set -e
[ "$e2_rc" -eq 1 ] || fail "E: workspace copy alive rc=$e2_rc want 1 (headless gone)"

# --- F: coverage — declared verbs == public lib surface -------------------------
declared=$(sed -n 's/^  \([a-z][a-z-]*\) .*/\1/p' "$T_TMP/help.txt" | sort -u | tr '\n' ' ')
libverbs=$("$BASH_BIN" -c '. "'"$LIB"'"; declare -F | sed -n "s/^declare -f //p" | grep "^wh_"' \
  | sed 's/^wh_//; s/_/-/g' | sort -u)
want=$(printf '%s\ndetect-terminal\n' "$libverbs" | sort -u | tr '\n' ' ')
[ "$declared" = "$want" ] || fail "F: verb-set drift between wh-cli.sh and workspace-host.sh.
  declared by --help: $declared
  public lib surface: $want
  A lib verb with no CLI door is a verb tranche 2 cannot reach; a CLI verb with no lib
  function is a door onto nothing. Add the case arm (and an eq line above) or explain
  the exclusion here."

echo "T104 PASS"
