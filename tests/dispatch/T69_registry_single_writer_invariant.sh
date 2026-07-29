#!/usr/bin/env bash
# T69 — telepty#60 Stage A, design §"writer inventory and structural enforcement"
# (2)(3)(4) + §8.5.10. Source invariant: the registry component is the ONLY thing
# that may touch the dispatch registry file, nothing outside it may name the
# outcome fields, and the terminal vocabulary 0.8.0 removes may not come back.
# This is a static scan — it needs no state.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

BIN="$REPO_ROOT/bin"
REGISTRY="$BIN/dispatch-registry.py"
[ -f "$REGISTRY" ] || { echo "FAIL: registry component missing at $REGISTRY" >&2; exit 1; }

fail=0
note() { echo "FAIL: $1" >&2; fail=1; }

# (1) single writer: no production file except the component may even NAME the
#     registry file. Every read and write routes through its typed operations, so
#     a path/handle anywhere else is a second entrance by construction.
while IFS= read -r hit; do
  note "registry file named outside the component: $hit"
done < <(grep -rn "active\.json\|ACTIVE_JSON" "$BIN" 2>/dev/null | grep -v "^$REGISTRY:")

# (2) outcome fields are writable only inside the component.
while IFS= read -r hit; do
  note "outcome field named outside the component: $hit"
done < <(grep -rn "reported_value" "$BIN" 2>/dev/null | grep -v "^$REGISTRY:")

# (3) the terminal vocabulary 0.8.0 removes stays removed.
for token in 'AUTO_REPORT' 'auto_reported' 'mark-reported' 'pendingReports'; do
  while IFS= read -r hit; do
    note "removed terminal vocabulary '$token': $hit"
  done < <(grep -rn -- "$token" "$BIN" 2>/dev/null)
done

# tracker_class must no longer be able to say "done".
if grep -rn 'return "done"' "$BIN/session-probe.py" >/dev/null 2>&1; then
  note "session-probe.py still classifies a prompt as \"done\""
fi

# (4) the retired dedup sidecar has no reader/writer outside the cutover archival op.
while IFS= read -r hit; do
  case "$hit" in
    "$REGISTRY":*) ;;
    *) note "retired dedup sidecar accessed outside archive-sidecars: $hit";;
  esac
done < <(grep -rn "dispatch-helper" "$BIN" 2>/dev/null)

# (5) fixture invariant (§8.7): no test may seed the legacy root array or assert a
#     terminal status. One named legacy-migration input fixture is exempt.
LEGACY_FIXTURE="fixtures/legacy-active-v1.json"
while IFS= read -r hit; do
  case "$hit" in
    *"$LEGACY_FIXTURE"*|*T69_registry_single_writer_invariant.sh:*) ;;
    *) note "legacy registry shape in the test subtree: $hit";;
  esac
done < <(grep -rnE "t_assert_status|t_seed_entry|printf '\[\]'|[^a-zA-Z]e\[\"status\"\]" "$HERE" 2>/dev/null)

[ "$fail" -eq 0 ] || exit 1
echo "T69 PASS"
