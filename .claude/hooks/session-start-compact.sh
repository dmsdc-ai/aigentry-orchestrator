#!/usr/bin/env bash
# SessionStart/compact hook — after a compaction, hand the orchestrator its own snapshot back.
#
# Claude Code runs this when the session resumes after /compact (matcher "compact"). Whatever
# this prints becomes context for the first turn after the compaction, so the model never
# continues "without knowing what it was doing" (CLAUDE.md Safe Compact Protocol, step 2).
# Bounded: at most 400 lines / 32 KiB. Silent when there is no snapshot.
snap="${CLAUDE_PROJECT_DIR:-$PWD}/.context-snapshot.md"
[ -f "$snap" ] || exit 0
printf 'CONTEXT SNAPSHOT restored after compact — %s (written %s). Read it, then continue the work it describes.\n\n' \
  "$snap" "$(date -r "$snap" '+%Y-%m-%d %H:%M %Z' 2>/dev/null || echo unknown)"
head -c 32768 "$snap" | head -n 400
