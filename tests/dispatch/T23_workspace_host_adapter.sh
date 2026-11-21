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

# ── AIGENTRY_WORKER_AUTO_RESTART: the per-launch retry budget of the cmux adapter ──
# Executes the GENERATED child command against an argv-only telepty stub: nothing starts a
# real CLI, a daemon or a bridge. The stub records the argv `telepty allow` was handed and
# the cwd it ran in, which is the whole contract under test — the flag is present by
# default, absent at 0, and an unreadable value refuses before cmux is called at all.
cat > "$STUB_BIN/telepty" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$T_TMP/allow-argv"
printf '%s\n' "$PWD" > "$T_TMP/allow-cwd"
EOF
cat > "$STUB_BIN/cmux-open" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$T_TMP/open-calls"
case "$1" in
  new-workspace)
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --command ]; then bash -c "$2" || exit; break; fi
      shift
    done
    echo 'OK workspace:23';;
  list-workspaces) echo 'workspace:23 fixture';;
  surface-health) echo 'type=terminal';;
  read-screen) [ "${T23_NOT_READY:-0}" = 1 ] || echo 'fixture prompt';;
  *) :;;
esac
EOF
chmod +x "$STUB_BIN/telepty" "$STUB_BIN/cmux-open"
# A cwd containing a space: the %q quoting of --command must survive being typed in.
mkdir -p "$T_TMP/cwd with space"
open_fixture() (
  export CMUX="$STUB_BIN/cmux-open" CMUX_READY_TIMEOUT_MS=1 CMUX_READY_INTERVAL_MS=1
  . "$REPO_ROOT/bin/lib/workspace-host.sh"
  _wh_cmux_open 'fixture-t23' "$T_TMP/cwd with space" 'fixture-cli --fixture-only'
)
for setting in unset 1 0; do
  if [ "$setting" = unset ]; then unset AIGENTRY_WORKER_AUTO_RESTART;
  else export AIGENTRY_WORKER_AUTO_RESTART="$setting"; fi
  [ "$(open_fixture)" = workspace:23 ] \
    || { echo "FAIL: open result for AIGENTRY_WORKER_AUTO_RESTART=$setting"; exit 1; }
  printf '%s\n' allow --id fixture-t23 > "$T_TMP/expected-argv"
  [ "$setting" = 0 ] || printf '%s\n' --auto-restart >> "$T_TMP/expected-argv"
  printf '%s\n' fixture-cli --fixture-only >> "$T_TMP/expected-argv"
  cmp "$T_TMP/expected-argv" "$T_TMP/allow-argv" \
    || { echo "FAIL: restart argv for setting=$setting"; exit 1; }
  [ "$(cat "$T_TMP/allow-cwd")" = "$T_TMP/cwd with space" ] \
    || { echo "FAIL: the child did not inherit the quoted cwd (setting=$setting)"; exit 1; }
done
# An empty or unrecognized value is refused, and refused BEFORE cmux is invoked.
for setting in '' invalid 2 true; do
  : > "$T_TMP/open-calls"
  export AIGENTRY_WORKER_AUTO_RESTART="$setting"
  rc=0; open_fixture > "$T_TMP/invalid.out" 2> "$T_TMP/invalid.err" || rc=$?
  [ "$rc" = 2 ] || { echo "FAIL: value '$setting' did not refuse with exit 2 (rc=$rc)"; exit 1; }
  [ ! -s "$T_TMP/open-calls" ] || { echo "FAIL: value '$setting' reached cmux before refusing"; exit 1; }
  [ ! -s "$T_TMP/invalid.out" ] || { echo "FAIL: value '$setting' emitted a ref"; exit 1; }
  grep -q AIGENTRY_WORKER_AUTO_RESTART "$T_TMP/invalid.err" \
    || { echo "FAIL: value '$setting' did not name the setting on stderr"; exit 1; }
done
# The readiness barrier is unchanged by the new setting: still exit 3, still no ref, still
# a closed workspace.
export AIGENTRY_WORKER_AUTO_RESTART=0 T23_NOT_READY=1
: > "$T_TMP/open-calls"
rc=0; open_fixture > "$T_TMP/not-ready.out" 2> "$T_TMP/not-ready.err" || rc=$?
[ "$rc" = 3 ] && [ ! -s "$T_TMP/not-ready.out" ] && grep -qx close-workspace "$T_TMP/open-calls" \
  || { echo 'FAIL: readiness refusal changed'; exit 1; }
unset AIGENTRY_WORKER_AUTO_RESTART T23_NOT_READY

echo "T23 PASS"
