#!/usr/bin/env bash
# context-handoff.sh — POSIX exec shim onto bin/context-handoff.mjs (#1201, SPEC §3.1, §8).
#
# Prints the previous orchestrator session's context, derived read-only from the native
# transcripts of claude/codex/gemini/grok (newest last activity for this workspace), redacted
# and bounded. Flags: [--workspace <abs>] [--before <ISO>] [--json] [--write|--dry-run].
# Exit 0 handoff printed, 3 no source, 2 invalid invocation or failure.
#
# The compiled implementation is located through bin/lib/node-shim.sh (repo tree / installed
# package / control workspace via `aigentry-orchestrator` on PATH); the .mjs is the
# cross-platform entry and resolves it the same way, so native Windows needs no bash.
set -euo pipefail
# #930 — homebrew APPENDED as a fallback for `node`, never an override of the caller's PATH.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim context-handoff.sh dist/src/context-handoff/cli.js
exec node "$AIGENTRY_SHIM_SCRIPT_DIR/context-handoff.mjs" "$@"
