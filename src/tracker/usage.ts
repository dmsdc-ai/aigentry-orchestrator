// Generated from bin/dispatch-tracker.sh lines 2-22 by the #899 tranche-1b port.
//
// The shell `usage()` was `sed -n '2,22p' "$0"` — it printed dispatch-tracker.sh's
// own comment header. bin/dispatch-tracker.sh is now an exec shim with no header
// to print, so the text lives here verbatim instead (same move as
// src/dispatch/usage.ts in tranche 1).
export const USAGE = `# dispatch-tracker.sh — Orchestrator-side dispatch health-check + auto re-dispatch.
#
# Polls every dispatch the registry is still holding open and records what it
# measured. telepty#60 Stage A: it can no longer settle anything. Screen state,
# git commits, disconnects, errors and cleanups became observations; the outcome
# axis is created "unknown" by the registry and has no writer at all in 0.8.0.
# The honest answer for most dispatches is "no completion fact observed", and a
# repeating HOLD is what surfaces that to a human.
#
# See docs/specs/2026-05-12-dispatch-healthcheck.md (Rule 32 영구 fix for #113).
#
# Commands:
#   dispatch-tracker.sh check                    — one-shot scan; alerts to stdout + log
#   dispatch-tracker.sh status [<sid>]
#   dispatch-tracker.sh prune
#   dispatch-tracker.sh --help
#
# Records are created by bin/dispatch.sh's begin-delivery transaction BEFORE the
# bytes are handed over, so there is no append/register hook here — a second
# record-creation entrance is exactly what the single-writer proof would have to
# keep excluding forever.`;
