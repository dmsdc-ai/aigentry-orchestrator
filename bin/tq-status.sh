#!/usr/bin/env bash
# Task Queue v2 — global status overview
set -euo pipefail
TQ="${TQ:-$HOME/projects/aigentry-orchestrator/state/task-queue.json}"
[ -f "$TQ" ] || { echo "ERR task queue not found: $TQ" >&2; exit 1; }

jq -r '
  "=== Active Focus ===",
  "  \(.active_focus // "none")",
  "",
  "=== Tracks ===",
  (
    .tracks // {} | to_entries[] |
    "  [\(.key)] \(.value.name)",
    "      status=\(.value.status) priority=\(.value.priority)",
    (if .value.blocked_by and (.value.blocked_by | length > 0) then "      blocked_by=\(.value.blocked_by | join(","))" else empty end),
    ""
  ),
  "=== Task Status (all) ===",
  (
    [.tasks[] | .status] | group_by(.) |
    map("  \(.[0]): \(length)") | join("\n")
  ),
  "",
  "=== Pending by Track ===",
  (
    [.tasks[] | select(.status == "pending" or .status == "in_progress" or .status == "blocked")] |
    group_by(.track // "legacy") |
    map("  \(.[0].track // "legacy"): \(length)") |
    join("\n")
  ),
  "",
  "=== Top 5 Recent Activity (by id desc) ===",
  (
    [.tasks[] | select((.updated_at // "") != "" or .id >= 240)] |
    sort_by(-.id)[0:5] |
    map("  #\(.id) [\(.track // "legacy")] \(.status) — \(.desc | .[0:80])") |
    join("\n")
  )
' "$TQ"
