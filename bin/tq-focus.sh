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
  # closes the old check-then-write TOCTOU. The `jq` READER below is untouched.
  #
  # R11 (review qr1172bct) — what is preserved and what intentionally changed. The earlier
  # claim that "observable behaviour is unchanged" was too strong:
  #   PRESERVED: an unknown track still prints `ERR unknown track: <t>` on stdout and
  #              exits 1; a successful switch still prints `Focus switched to: <t>`;
  #              a same-value switch still reports success (the helper no-ops).
  #   NEW, intentionally: the locked path ADDS refusals that did not exist before —
  #              expect_focus_mismatch, queue_corrupt, queue_unavailable, lock_not_regular,
  #              transform_timeout/_signalled/_unrecognized and the --node/capability
  #              refusals. Each surfaces as `ERR focus switch refused (rc N)` on stderr and
  #              exits with the helper's own code (3 state, 4 usage, 6 capability, 9 corrupt).
  #
  # R9: this script invokes `node`, so it REQUIRES node on PATH — that is a real new
  # requirement of the write path and is why the script itself passes no `--node`.
  # `bin/tq-note.mjs` supplies the broker's required explicit `--node process.execPath`.
  # The removed AIGENTRY_TQ_NODE / PATH fallback inside the broker is NOT restored.
  command -v node >/dev/null 2>&1 || {
    echo "ERR node is required to switch focus (bin/tq-note.mjs performs the locked write): not on PATH" >&2
    exit 3
  }
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
  # R1: rc 0 alone is NOT proof of a write. The entry-guard defect made tq-note.mjs exit 0
  # having written nothing, and this script printed success anyway (measured). A successful
  # `--json` run always emits a response document, so its absence is a failure.
  case "$out" in
    *'"applied"'*) : ;;
    *) echo "ERR focus switch produced no response document (rc $rc): ${out:-(empty)}" >&2; exit 3 ;;
  esac
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
