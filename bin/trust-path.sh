#!/usr/bin/env bash
# trust-path.sh — Register a path as trusted in ~/.claude.json (Claude Code)
# Usage: trust-path.sh <absolute-path>
set -euo pipefail
# #930 — homebrew APPENDED: a fallback for `node`/`python3` under launchd, never an
# override of the caller's PATH. It was a prefix, which is #400's mechanism
# (bin/session-cleanup.sh:34-41). Identical in every shim on purpose — a policy that
# differed per shim is how the prefix survived four ports. tests/dispatch/T137 measures
# it and carries the host measurement behind the decision.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# `telepty` resolved EXPLICITLY into the seam the implementation reads, never left to a
# spawn-time PATH lookup; after the append, so the operator's wins where there is one
# and launchd still finds homebrew's. An already-set TELEPTY is never overridden.
: "${TELEPTY:=$(command -v telepty 2>/dev/null || true)}"
[ -n "$TELEPTY" ] || TELEPTY=telepty
export TELEPTY

path="${1:-}"
[ -z "$path" ] && { echo "Usage: trust-path.sh <absolute-path>"; exit 1; }
[ -d "$path" ] || { echo "ERR not a directory: $path"; exit 1; }

# Normalize to absolute path
path=$(cd "$path" && pwd)

CLAUDE_JSON="$HOME/.claude.json"
TMP=$(mktemp)
TRUST_RECORD='{
  "allowedTools": [],
  "mcpContextUris": [],
  "mcpServers": {},
  "enabledMcpjsonServers": [],
  "disabledMcpjsonServers": [],
  "hasTrustDialogAccepted": true,
  "projectOnboardingSeenCount": 0,
  "hasClaudeMdExternalIncludesApproved": false,
  "hasClaudeMdExternalIncludesWarningShown": false
}'

jq --arg p "$path" --argjson tr "$TRUST_RECORD" \
  '.projects[$p] = ((.projects[$p] // {}) + $tr)' "$CLAUDE_JSON" > "$TMP"
mv "$TMP" "$CLAUDE_JSON"

trust=$(jq -r --arg p "$path" '.projects[$p].hasTrustDialogAccepted' "$CLAUDE_JSON")
echo "Trusted: $path (hasTrustDialogAccepted=$trust)"
