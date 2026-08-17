// Generated from bin/dispatch-cleanup-scheduler.sh lines 2-38 by the #899 tranche-4 port.
//
// The shell `usage()` was `sed -n '2,38p' "$0"` — it printed the script's own comment
// header AND, because the range outran the header by two lines, the `set -euo pipefail`
// and `export PATH=...` lines that follow it. Nobody chose to document those; sed
// included them, so they are part of what every operator who ran `--help` has seen.
// They are kept VERBATIM here for the same reason src/reconciler/usage.ts keeps its
// mid-sentence stop: `--help` output is a contract, and tidying it would be an
// undeclared change to what an operator reads. tests/dispatch/T120 block A pins all
// 37 lines, the first and the last by exact text.
//
// bin/dispatch-cleanup-scheduler.sh is now an exec shim with no header of its own to
// print — same move as src/dispatch/usage.ts (tranche 1), src/tracker/usage.ts (1b),
// src/cleanup/usage.ts (2a), src/reconciler/usage.ts (2c) and src/hitl/usage.ts (2d).
export const USAGE = `# dispatch-cleanup-scheduler.sh — Layer D timeout fallback (ADR 2026-05-20).
#
# Maintains state/dispatch/cleanup-pending.json — an array of records:
#
#   {
#     "sid": "<session-id>",
#     "report_time": "<iso8601>",
#     "scheduled_cleanup_time": "<iso8601>",
#     "source": "layer-d-timeout" | "reconciler" | "explicit-request",
#     "preempt_reason": "<optional, set when EXTEND_LIFETIME deferred>"
#   }
#
# Atomic writes via tmpfile+mv (avoids partial state on crash — pattern #114).
#
# Commands:
#   dispatch-cleanup-scheduler.sh schedule <sid> [--grace-seconds N] [--source S] [--reason TEXT]
#       Append a pending record. Default grace 60s. Default source layer-d-timeout.
#       Idempotent on sid: replaces existing pending record for the same sid.
#       Skips if the dispatch record has keep_alive=true.
#
#   dispatch-cleanup-scheduler.sh cancel <sid>
#       Remove any pending record for sid. Used when EXTEND_LIFETIME arrives.
#
#   dispatch-cleanup-scheduler.sh defer <sid> --minutes N [--reason TEXT]
#       Push scheduled_cleanup_time by N minutes. Creates record if absent.
#
#   dispatch-cleanup-scheduler.sh tick
#       For each pending record past scheduled_cleanup_time, invoke
#       bin/session-cleanup.sh <sid> and drop the record.
#
#   dispatch-cleanup-scheduler.sh list
#       Pretty-print current pending records.
#
# Exit codes: 0 OK, 4 usage.

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`;
