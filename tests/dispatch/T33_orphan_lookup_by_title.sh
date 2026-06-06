#!/usr/bin/env bash
# T33 — _wh_cmux_lookup MUST fall back to cmux-title match for a telepty-orphan
# (#523). Motivating incident: T32 stubbed wh_close_for_sid and so MASKED the
# fact that the REAL lookup returns empty for an orphan (telepty has no record),
# leaving wh_close_for_sid with an empty host_id → silent return 0, no close.
#
# Setup (REAL lookup, NOTHING stubbed on the resolve path):
#   - `telepty list --json` returns [] → no telepty record for the sid (orphan).
#   - cmux `--json list-workspaces` reports a workspace whose TITLE == the sid.
# Assert:
#   1. `_wh_cmux_lookup <sid> ""` resolves the cmux ref via the title fallback.
#   2. `wh_close_for_sid <sid>` actually invokes `cmux close-workspace` on that ref.
# TDD: RED before the fallback exists (lookup returns empty), GREEN after.
# Throwaway sid/title only — the stub cmux records calls, never touches a live ws.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

fail() { echo "FAIL[T33]: $*" >&2; exit 1; }

ORPHAN="orphan-sid-T33"
REF="workspace:7"
CLOSE_CALLS="$T_TMP/cmux-close.log"; : > "$CLOSE_CALLS"
WS_JSON="$T_TMP/cmux-workspaces.json"
export CLOSE_CALLS

# telepty has NO record of the orphan → list --json returns [].
printf '%s' '[]' > "$STUB_LIST_FILE"

# cmux reports exactly one workspace whose title == the orphan sid (the orphan
# title == sid invariant verified live by the orchestrator).
printf '%s' "{\"workspaces\":[{\"ref\":\"$REF\",\"title\":\"$ORPHAN\",\"current_directory\":\"$HOME/.aigentry/role-sandbox/$ORPHAN\"}]}" > "$WS_JSON"

# Stub cmux on PATH. Real call shapes: `cmux --json list-workspaces` and
# `cmux close-workspace --workspace <ref>` / `cmux sidebar-state --workspace <ref>`.
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--json" ] && [ "\$2" = "list-workspaces" ]; then
  cat "$WS_JSON"
  exit 0
fi
case "\$1" in
  close-workspace) echo "\$3" >> "$CLOSE_CALLS"; exit 0;;
  sidebar-state)   echo "alive"; exit 0;;
  *) exit 0;;
esac
EOF
chmod +x "$STUB_BIN/cmux"

# 1. REAL lookup resolves the ref via the title fallback.
out=$(AIGENTRY_WORKSPACE_HOST=cmux bash -c "
  set -e
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  echo \"lookup=\$(_wh_cmux_lookup '$ORPHAN' '')\"
")
echo "$out" | grep -qx "lookup=$REF" \
  || fail "_wh_cmux_lookup did NOT resolve orphan by title==sid. got: $out"

# 2. wh_close_for_sid drives a real close on the resolved ref.
AIGENTRY_WORKSPACE_HOST=cmux bash -c "
  set -e
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  wh_close_for_sid '$ORPHAN'
"
grep -qx "$REF" "$CLOSE_CALLS" \
  || fail "wh_close_for_sid did NOT close the orphan ref ($REF). close log:
$(cat "$CLOSE_CALLS")"

echo "T33 PASS"
