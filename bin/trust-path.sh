#!/usr/bin/env bash
# trust-path.sh — Register a path as trusted in ~/.claude.json (Claude Code)
# Usage: trust-path.sh <absolute-path>
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

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
