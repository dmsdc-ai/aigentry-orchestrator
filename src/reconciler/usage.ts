// Generated from bin/session-reconciler.sh lines 2-32 by the #899 tranche-2c port.
//
// The shell `usage()` was `sed -n '2,32p' "$0"` — it printed the script's own
// comment header and stopped mid-sentence at line 32 (the `--loop` bullet's second
// line), which is what a hard-coded line range does when the header grows under it.
// bin/session-reconciler.sh is now an exec shim with no header to print, so the
// text lives here VERBATIM instead — same move as src/dispatch/usage.ts (tranche 1),
// src/tracker/usage.ts (1b) and src/cleanup/usage.ts (2a), including the mid-sentence
// stop: `--help` output is a contract, and "fixing" it here would be an undeclared
// change to what an operator reads.
//
// The Article-17 line still says "shell + python3 stdlib + jq + telepty". Kept as
// measured rather than edited: the Rule 38 record of what this port changed about
// the runtime belongs in bin/session-reconciler.sh's header, not in a silent
// rewrite of the operator-facing text. Same call tranche 2a made.
export const USAGE = `# session-reconciler.sh — 60s level-triggered safety net (ADR 2026-05-20 Layer R).
#
# Single cron-style tick. Two responsibilities, executed in order:
#
#   1) Layer D fire-due — invoke dispatch-cleanup-scheduler.sh tick. Any sid
#      whose scheduled_cleanup_time has passed gets session-cleanup.sh.
#
#   2) Orphan sweep — compute GC root from the dispatch registry
#      (sessions with an in-flight dispatch) ∪ {orchestrator} (PROTECTED).
#      For every telepty session NOT in the root and not in PROTECTED:
#        - age_since_spawn > 5min (anti-spawn-race floor)
#        - keep_alive flag on the dispatch record: skipped (preserves long-lived workers)
#        - PID_dead OR
#          (telepty.healthStatus == DISCONNECTED AND disconnect_age > 4min) OR
#          workspace_host_orphan (wh_lookup empty AND telepty stale)
#      Matches are cleaned via bin/session-cleanup.sh.
#
# Idempotent: session-cleanup.sh's DELETE→404 is the "already gone" signal.
# Exponential backoff: per-sid retry counter at state/dispatch/reconciler-backoff.json.
# Initial 5s, max 1000s (controller-runtime defaults).
#
# Article 17 (무의존): shell + python3 stdlib + jq + telepty. No npm runtime deps.
# Cross-platform: POSIX bash; works on macOS (launchd-driven) + Linux (systemd-driven).
#
# Usage:
#   session-reconciler.sh           # one tick
#   session-reconciler.sh --dry-run # report what would happen, don't act
#   session-reconciler.sh --shadow  # observe+decide only; append shadow JSONL
#   session-reconciler.sh --once    # alias for default
#   session-reconciler.sh --loop    # long-lived daemon: re-exec \`--once\` every
#                                    #   RECONCILER_LOOP_INTERVAL (default 60s).`;
