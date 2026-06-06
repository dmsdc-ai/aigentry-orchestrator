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
#   F7/F9 — per-handle liveness is `sidebar-state`, judged by STDOUT: alive iff
#           non-empty AND not an `Error:` line (a missing tab prints `Error:`).
CMUX_CALLS="$T_TMP/cmux-calls.log"
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
echo "cmux \$*" >> "$CMUX_CALLS"
if [ "\$1" = "--json" ] && [ "\$2" = "list-workspaces" ]; then
  cat "$T_TMP/cmux-workspaces.json"; exit 0
fi
case "\$1" in
  sidebar-state)
    # \$2=--workspace \$3=<id>; known handles are alive, unknown => Error: (F7).
    case "\${3:-}" in
      ws-alive|ws-other) echo "tab=\${3} status_count=0";;
      *) echo "Error: ERROR: Tab not found";;
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

echo "T23 PASS"
