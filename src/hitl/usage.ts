// Generated from bin/hitl.sh lines 2-23 by the #899 tranche-2d port.
//
// The shell `usage()` was `sed -n '2,23p' "$0"` — it printed hitl.sh's own comment
// header, 22 lines, to STDOUT (exit 0 for --help/-h/help/no-args, exit 1 after the
// "unknown command" line on stderr). bin/hitl.sh is now an exec shim with no header
// to print, so the text lives here VERBATIM instead — same move as
// src/dispatch/usage.ts (tranche 1), src/tracker/usage.ts (1b),
// src/cleanup/usage.ts (2a) and src/reconciler/usage.ts (2c).
//
// VERBATIM INCLUDES THE LAST LINE. "Article 17: shell + Python stdlib only" now
// describes the pre-port implementation, and it is kept anyway: the operator-facing
// help text is part of the CLI contract this port may not move, and T113 pins all 22
// lines byte-for-byte against the original bash. The same precedent is already in the
// tree — src/reconciler/usage.ts keeps "Article 17 (무의존): shell + python3 stdlib +
// jq + telepty", pinned by T110. The CURRENT, honest Article 17 statement for this
// component is in the shim header (bin/hitl.sh), which is the file whose language the
// line was ever describing, and in the ADR amendment it cites.
export const USAGE = `# hitl.sh — HITL Gate CLI (ADR 2026-07-26-hitl-gate-primitive).
#
# One human-in-the-loop primitive shared by the reconciler loop and worker loops.
# A gate is a file: state/hitl/pending/<id>.json, moved to state/hitl/decided/
# on decision. The directory IS the index — \`ls pending/\` answers "is anything
# pending?" and the loop's pause predicate is a grep over it. Level-triggered:
# no daemon, no lock, no in-memory state to recover after a restart.
#
# Commands:
#   hitl.sh open --source S --kind K --question Q [--subject-sid SID]
#                [--resume R] [--options "a=…,b=…"] [--context-ref PATH]
#   hitl.sh list [--kind K] [--json]     — pending gates, oldest first
#   hitl.sh show <id>                    — full record (pending or decided)
#   hitl.sh approve <id> [--note TEXT]   — decide + run resume hook
#   hitl.sh reject  <id> [--note TEXT]
#   hitl.sh remind                       — internal: retry failed notifies, re-notify ≥24h
#   hitl.sh --help
#
#   kind   ∈ destructive | decision | info   (global pause | per-item | none)
#   resume ∈ reinject | registry-clear-redispatch | none   (what approve DOES)
#
# Article 17: shell + Python stdlib only. macOS + Linux.`;
