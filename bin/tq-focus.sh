#!/usr/bin/env bash
# Task Queue v2 — switch active focus or show current focus with next actions
# Usage:
#   tq-focus.sh                     # show current focus
#   tq-focus.sh <track-id>          # switch focus to track
set -euo pipefail
TQ="${TQ:-$HOME/projects/aigentry-orchestrator/state/task-queue.json}"
[ -f "$TQ" ] || { echo "ERR task queue not found: $TQ" >&2; exit 1; }

new_focus="${1:-}"

if [ -n "$new_focus" ]; then
  # Validate track exists
  valid=$(jq -r --arg t "$new_focus" '.tracks[$t] // empty' "$TQ")
  [ -z "$valid" ] && { echo "ERR unknown track: $new_focus"; exit 1; }

  # Swap focus
  tmp=$(mktemp)
  jq --arg t "$new_focus" '.active_focus = $t' "$TQ" > "$tmp"
  mv "$tmp" "$TQ"
  echo "Focus switched to: $new_focus"
  echo ""
fi

# Show current focus detail
jq -r '
  .active_focus as $f |
  if $f == null or $f == "" then "No active focus set. Use: tq-focus.sh <track-id>" else
    .tracks[$f] as $meta |
    "=== Active Focus: [\($f)] \($meta.name) ===",
    "  Status: \($meta.status) | Priority: \($meta.priority)",
    (if $meta.resume_ref then "  Resume ref: \($meta.resume_ref)" else empty end),
    "",
    "=== Next Actionable (not completed, not blocked) ===",
    (
      [.tasks[] | select(.track == $f and .status == "pending")] |
      sort_by(.priority, .id) |
      .[0:5] |
      if length == 0 then "  (none)" else
        map("  #\(.id) [\(.priority)] \(.desc | .[0:100])") | join("\n")
      end
    )
  end
' "$TQ"
