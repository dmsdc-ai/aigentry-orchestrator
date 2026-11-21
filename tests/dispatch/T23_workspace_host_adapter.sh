#!/usr/bin/env bash
# T23 — Workspace Host adapter seam: 4 functions, cmux adapter via stub binary.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

# Stub cmux on PATH that records calls + answers list/sidebar-state/close, modelling
# the cmux CLI contract verified live in SPEC 2026-06-06-cmux-adaptor-prune-status:
#   F2 — the global `--json` flag PRECEDES the command (`cmux --json list-workspaces`).
#   F3 — the listing shape is `{"workspaces":[{ref,...}]}` (no top-level array / `id`).
#   F7/F9 — per-handle liveness is `sidebar-state`. Per #1162(c) the ONLY "gone"
#           answer is a FAILED probe (rc!=0) whose whole reply is exactly
#           `Error: ERROR: Tab not found`, emitted on STDERR by cmux 0.64.20.
#           A zero-exit reply carrying that text is NOT an answer (a state dump
#           may contain it, and a refused daemon socket wears the same shape),
#           so the stub must fail the probe to model a genuinely absent handle.
CMUX_CALLS="$T_TMP/cmux-calls.log"
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
echo "cmux \$*" >> "$CMUX_CALLS"
if [ "\$1" = "--json" ] && [ "\$2" = "list-workspaces" ]; then
  cat "$T_TMP/cmux-workspaces.json"; exit 0
fi
case "\$1" in
  sidebar-state)
    # \$2=--workspace \$3=<id>; known handles are alive (state on stdout, rc=0),
    # unknown => cmux 0.64.20's missing-handle answer: the exact line on stderr
    # AND a non-zero exit (F7, #1162c).
    case "\${3:-}" in
      ws-alive|ws-other) echo "tab=\${3} status_count=0"; exit 0;;
      *) echo "Error: ERROR: Tab not found" >&2; exit 1;;
    esac
    ;;
  close-workspace)
    # \$2=--workspace \$3=<id> — succeed for "ws-alive", fail for "ws-bad"
    if [ "\${3:-}" = "ws-bad" ]; then exit 1; fi
    exit 0
    ;;
  *) exit 0;;
esac
EOF
chmod +x "$STUB_BIN/cmux"
printf '{"workspaces":[{"ref":"ws-alive"},{"ref":"ws-other"}]}' > "$T_TMP/cmux-workspaces.json"

# telepty list with cmuxWorkspaceId mapping.
cat > "$STUB_LIST_FILE" <<EOF
[{"id":"sid-A","healthStatus":"CONNECTED","cmuxWorkspaceId":"ws-alive"}]
EOF

# Source the seam in a subshell so we can call its functions.
out=$(AIGENTRY_WORKSPACE_HOST=cmux bash -c "
  set -e
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  echo \"lookup=\$(wh_lookup sid-A)\"
  echo \"alive=\$(wh_alive ws-alive; echo \$?)\"
  echo \"gone=\$(wh_alive ws-missing; echo \$?)\"
  echo \"list_ids=\$(wh_list_ids | tr '\n' ',')\"
  wh_close ws-alive && echo close-alive=ok || echo close-alive=fail
")

echo "$out" | grep -q "lookup=ws-alive"     || { echo "FAIL: lookup"; echo "$out"; exit 1; }
echo "$out" | grep -q "alive=0"             || { echo "FAIL: alive"; echo "$out"; exit 1; }
echo "$out" | grep -q "gone=1"              || { echo "FAIL: alive-gone"; echo "$out"; exit 1; }
echo "$out" | grep -q "list_ids=ws-alive,ws-other," || { echo "FAIL: list_ids"; echo "$out"; exit 1; }
echo "$out" | grep -q "close-alive=ok"      || { echo "FAIL: close"; echo "$out"; exit 1; }

# Headless adapter — all no-ops, alive=1.
out2=$(AIGENTRY_WORKSPACE_HOST=headless bash -c "
  set -e
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  echo \"lookup=\$(wh_lookup sid-A)\"
  wh_alive any && echo alive-ok || echo alive-gone
  wh_close any && echo close-ok || echo close-fail
")
echo "$out2" | grep -q "lookup=$"     || { echo "FAIL: headless lookup not empty"; echo "$out2"; exit 1; }
echo "$out2" | grep -q "alive-gone"   || { echo "FAIL: headless alive (should be gone)"; echo "$out2"; exit 1; }
echo "$out2" | grep -q "close-ok"     || { echo "FAIL: headless close"; echo "$out2"; exit 1; }

# --- #835: only a real answer may say "gone" -------------------------------
# wh_alive's "gone" verdict is a CORROBORATING signal for a teardown
# (session-reconciler.sh INV-17), so a probe that learned nothing must not supply
# it. cmux answering `Error:` is an answer (covered above: gone=1). cmux saying
# nothing, or not being reachable at all, is not — and used to read as "gone",
# which is how a crashed or missing cmux manufactured half the evidence for
# closing a live worker's surface. The warp adapter already maps "cannot probe"
# to INDETERMINATE→alive (_wh_warp_alive, INV-17 #486); cmux must match.
BASH_BIN="$(command -v bash)"
SILENT_DIR="$T_TMP/silent-bin"; mkdir -p "$SILENT_DIR"
cat > "$SILENT_DIR/cmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  sidebar-state) exit 1;;   # crashed / hung / wrong version: nothing on stdout
  *) exit 0;;
esac
EOF
chmod +x "$SILENT_DIR/cmux"

out3=$(AIGENTRY_WORKSPACE_HOST=cmux "$BASH_BIN" -c "
  export PATH='$SILENT_DIR:/usr/bin:/bin'
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  wh_alive ws-alive && echo silent=present || echo silent=gone
" 2>/dev/null)
echo "$out3" | grep -q "silent=present" \
  || { echo "FAIL: a silent cmux probe reported the surface GONE — an unanswered probe is not evidence, and this verdict corroborates a teardown"; echo "$out3"; exit 1; }

# cmux not on PATH at all — same reasoning, stronger case. Probed at the adapter
# function directly (as T25 does for _wh_warp_alive) because with cmux absent the
# public wh_alive resolves to the headless adapter, whose documented "gone" is a
# separate contract asserted above and is unreachable from the sweep (headless
# wh_lookup returns no host_id, so the reconciler never probes).
EMPTY_DIR="$T_TMP/empty-bin"; mkdir -p "$EMPTY_DIR"
out4=$("$BASH_BIN" -c "
  export PATH='$EMPTY_DIR:/usr/bin:/bin'
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  _wh_cmux_alive ws-alive && echo nocmux=present || echo nocmux=gone
" 2>/dev/null)
echo "$out4" | grep -q "nocmux=present" \
  || { echo "FAIL: an unreachable cmux reported the surface GONE — 'I cannot probe' is not 'it is not there'"; echo "$out4"; exit 1; }

# ── background creation: the cmux argv, and the refusal on a cmux without --focus ──
# A recording stub stands in for cmux: it logs the FULL argv of every call, so the
# assertions below are about the argument vector the adapter really builds, not about a
# window. Nothing opens a terminal, and no real cmux is contacted.
FOCUS_LOG="$T_TMP/focus-cmux-argv.log"
cat > "$STUB_BIN/cmux-focus" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$T_TMP/focus-cmux-argv.log"
case "$1" in
  --help)
    [ "${T23_CMUX_NO_FOCUS:-0}" = 1 ] && exit 0   # an older cmux: no --focus advertised
    echo '  new-workspace [--focus <true|false>] [--cwd <dir>] [--command <cmd>]';;
  new-workspace) echo 'OK workspace:56';;
  list-workspaces) echo 'workspace:56 fixture';;
  surface-health) echo 'type=terminal';;
  read-screen) echo 'fixture prompt';;
  *) :;;
esac
EOF
chmod +x "$STUB_BIN/cmux-focus"
open_focus_fixture() (
  export CMUX="$STUB_BIN/cmux-focus" CMUX_READY_TIMEOUT_MS=1 CMUX_READY_INTERVAL_MS=1
  . "$REPO_ROOT/bin/lib/workspace-host.sh"
  _wh_cmux_open 'fixture-t23-focus' "$T_TMP/focus-cwd" 'fixture-cli --fixture-only'
)
mkdir -p "$T_TMP/focus-cwd"

# A: the spawn passes --focus false, and asks cmux whether it supports it first.
: > "$FOCUS_LOG"; unset T23_CMUX_NO_FOCUS
[ "$(open_focus_fixture)" = workspace:56 ] || { echo 'FAIL: focus-aware open did not emit its ref'; exit 1; }
grep -q -- '^--help$' "$FOCUS_LOG" \
  || { echo 'FAIL: the adapter did not probe cmux --help for --focus support'; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '^new-workspace --focus false --cwd ' "$FOCUS_LOG" \
  || { echo 'FAIL: new-workspace did not receive --focus false as its first argument pair'; cat "$FOCUS_LOG"; exit 1; }
# The support probe must come BEFORE the spawn, or the refusal would arrive too late.
[ "$(grep -n -- '^--help$' "$FOCUS_LOG" | head -1 | cut -d: -f1)" -lt \
  "$(grep -n -- '^new-workspace ' "$FOCUS_LOG" | head -1 | cut -d: -f1)" ] \
  || { echo 'FAIL: the --focus support probe ran after the spawn'; cat "$FOCUS_LOG"; exit 1; }
# Focus is never ACTUATED on spawn: no select/focus verb is issued at all (cf. T56 part C).
grep -qE 'select-workspace|^focus' "$FOCUS_LOG" \
  && { echo 'FAIL: FOCUS THEFT — the adapter actuated focus while creating a worker workspace'; cat "$FOCUS_LOG"; exit 1; }

# B: a cmux whose --help does not advertise --focus is refused, cleanly and before spawn.
: > "$FOCUS_LOG"; export T23_CMUX_NO_FOCUS=1
rc=0; out5=$(open_focus_fixture 2> "$T_TMP/focus.err") || rc=$?
[ "$rc" = 2 ] || { echo "FAIL: an older cmux must be refused with exit 2, got $rc"; cat "$T_TMP/focus.err"; exit 1; }
[ -z "$out5" ] || { echo "FAIL: a refused spawn must emit no ref, got '$out5'"; exit 1; }
grep -q CMUX_NO_FOCUS_UNSUPPORTED "$T_TMP/focus.err" \
  || { echo 'FAIL: the refusal did not name CMUX_NO_FOCUS_UNSUPPORTED'; cat "$T_TMP/focus.err"; exit 1; }
grep -q -- '^new-workspace' "$FOCUS_LOG" \
  && { echo 'FAIL: a workspace was spawned despite the refusal — there must be no fallback'; cat "$FOCUS_LOG"; exit 1; }
unset T23_CMUX_NO_FOCUS

echo "T23 PASS"
