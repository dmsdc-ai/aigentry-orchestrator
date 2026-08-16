// Generated from bin/session-cleanup.sh lines 2-20 by the #899 tranche-2a port.
//
// The shell `usage()` was `sed -n '2,20p' "$0"` — it printed session-cleanup.sh's
// own comment header, and deliberately stopped BEFORE the `Usage:` block at line 21
// (the range is 2-20, not 2-26). bin/session-cleanup.sh is now an exec shim with no
// header to print, so the text lives here verbatim instead — same move as
// src/dispatch/usage.ts (tranche 1) and src/tracker/usage.ts (tranche 1b).
export const USAGE = `# session-cleanup.sh — Actually remove orchestrator-spawned sessions.
#
# Three-step removal per session:
#   1. Kill the parent \`telepty allow --id <sid> ...\` process via SIGTERM
#      (process tree dies → wrapped CLI dies, telepty auto-deregisters most cases).
#   2. cmux close-workspace (best-effort, harmless if cmux unavailable).
#   3. DELETE /api/sessions/<sid> on local daemon (force-remove from registry —
#      handles the edge case where parent kill alone did not propagate).
#
# Discovered 2026-05-17: prior version of this script only attempted cmux close +
# advisory "telepty#17 pending" emit, which left 21 wrapped sessions accumulated
# for days. The DELETE API existed in daemon.js:2367 but was unused by this helper.
# parent-PID SIGTERM is the load-bearing step (auto-deregisters in ~404 of cases);
# DELETE is the backup that handles residual entries.
#
# Enforces AGENTS.md Rule 28 by refusing to clean the protected \`orchestrator\`
# session unless --force is passed. The active-builder session(s) currently working
# may be additionally protected via --keep <sid>.
#`;
