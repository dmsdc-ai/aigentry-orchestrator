#!/usr/bin/env bash
# context-compact.sh — snapshot-then-compact for the orchestrator session, in one step.
#
# The orchestrator writes .context-snapshot.md itself (the model knows the plan; no script can).
# This helper enforces the order the Safe Compact Protocol requires and then asks the session to
# compact: it refuses when the snapshot is missing or stale, and otherwise injects "/compact" into
# the orchestrator's own telepty session, which Claude Code executes as the next input. After the
# compaction the SessionStart/compact hook (.claude/hooks/session-start-compact.sh) prints the
# snapshot back into the new context. Exit: 0 injected, 3 snapshot missing/stale, 4 inject failed.
set -euo pipefail
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
snap="$root/.context-snapshot.md"
max_age="${AIGENTRY_SNAPSHOT_MAX_AGE_SECONDS:-900}"
sid="${AIGENTRY_ORCH_SID:-orchestrator}"
cmd="${AIGENTRY_COMPACT_COMMAND:-/compact}"
if [ ! -f "$snap" ]; then echo "context-compact: no snapshot at $snap — write it first" >&2; exit 3; fi
age=$(( $(date +%s) - $(stat -f %m "$snap" 2>/dev/null || stat -c %Y "$snap") ))
if [ "$age" -gt "$max_age" ]; then
  echo "context-compact: snapshot is ${age}s old (limit ${max_age}s) — refresh it before compacting" >&2; exit 3
fi
telepty="${AIGENTRY_TELEPTY:-$(command -v telepty || true)}"
[ -n "$telepty" ] || { echo "context-compact: telepty not found" >&2; exit 4; }
if "$telepty" inject --submit --from "$sid" "$sid" "$cmd" >/dev/null 2>&1; then
  echo "context-compact: snapshot is ${age}s old; '$cmd' injected into $sid — the session compacts when this turn ends, then the SessionStart hook restores the snapshot"
else
  echo "context-compact: inject into $sid failed" >&2; exit 4
fi
