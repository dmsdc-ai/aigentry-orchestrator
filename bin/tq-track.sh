#!/usr/bin/env bash
# Task Queue v2 — drill into a specific track
# Usage: tq-track.sh <track-id> [--all]
set -euo pipefail
TQ="${TQ:-$HOME/projects/aigentry-orchestrator/state/task-queue.json}"
[ -f "$TQ" ] || { echo "ERR task queue not found: $TQ" >&2; exit 1; }

track="${1:-}"
show_completed=0
[ "${2:-}" = "--all" ] && show_completed=1
[ -z "$track" ] && {
  echo "Usage: tq-track.sh <track-id> [--all]"
  echo "Available tracks:"
  jq -r '.tracks // {} | keys[]' "$TQ" | sed 's/^/  /'
  exit 1
}

jq -r --arg t "$track" --argjson show_completed "$show_completed" '
  .tracks[$t] as $meta |
  if $meta == null then "ERR unknown track: \($t)" else
    "=== Track [\($t)] ===",
    "  Name: \($meta.name)",
    "  Desc: \($meta.desc)",
    "  Status: \($meta.status) | Priority: \($meta.priority)",
    (if $meta.resume_ref then "  Resume ref: \($meta.resume_ref)" else empty end),
    (if ($meta.blocks // []) | length > 0 then "  Blocks: \($meta.blocks | join(","))" else empty end),
    (if ($meta.blocked_by // []) | length > 0 then "  Blocked by: \($meta.blocked_by | join(","))" else empty end),
    "",
    "=== Tasks ===",
    (
      [.tasks[] | select(.track == $t)] as $ts |
      if $show_completed == 1 then $ts else [$ts[] | select(.status != "completed")] end |
      sort_by(.id) |
      map(
        "  #\(.id) \(.status) [\(.priority)] \(.desc | .[0:100])",
        (if .resume_context then "      ↳ resume: \(.resume_context | .[0:120])" else empty end),
        (if .blocked_by and (.blocked_by | length > 0) then "      ↳ blocked_by: \(.blocked_by | tostring)" else empty end)
      ) | flatten | join("\n")
    )
  end
' "$TQ"
