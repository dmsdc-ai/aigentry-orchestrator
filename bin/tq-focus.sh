#!/usr/bin/env bash
# Task Queue v2 — switch active focus or show current focus with next actions
# Usage:
#   tq-focus.sh                     # show current focus
#   tq-focus.sh <track-id>          # switch focus to track
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TQ="${TQ:-$(cd "$(dirname "$0")/.." && pwd)/state/task-queue.json}"
[ -f "$TQ" ] || { echo "ERR task queue not found: $TQ" >&2; exit 1; }

new_focus="${1:-}"

if [ -n "$new_focus" ]; then
  # #1172 U3 — the focus WRITE goes through the one locked transaction path
  # (bin/tq-note.mjs -> bin/lib/task-queue-lock.py), so it can no longer lose a
  # concurrent dispatch-ledger write. Measured before the change: holding this script
  # between its `jq > $tmp` and its `mv` let a committed taskLedgerUpdate write
  # (status + dispatch stamp) be silently overwritten, reproduced 3/3.
  #
  # Three defects go with the `mv`: a `mktemp` in the default TMPDIR made it a
  # cross-device COPY (truncation-capable, not a rename), there was no fsync, and `jq`'s
  # number/format normalisation could shift bytes outside the key it set.
  #
  # `--expect-focus` is the revision guard: the value just read here, refused by name if
  # the focus moved underneath. Track validation now happens INSIDE the lock, which
  # closes the old check-then-write TOCTOU; the `ERR unknown track` contract below is
  # reproduced from that named refusal, so this script's observable behaviour is
  # unchanged. The `jq` READER below is untouched.
  prev="$(jq -r '.active_focus // "null"' "$TQ")"
  rc=0
  out="$(node "$SCRIPT_DIR/tq-note.mjs" set-focus --track "$new_focus" --queue "$TQ" \
    --expect-focus "$prev" --json 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$out" in
      *unknown_track*) echo "ERR unknown track: $new_focus"; exit 1 ;;
      *) echo "ERR focus switch refused (rc $rc): $out" >&2; exit "$rc" ;;
    esac
  fi
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
