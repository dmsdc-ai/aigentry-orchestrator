#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

CLAUDE_JSON="$HOME/.claude.json"
TMP=$(mktemp)
cp "$CLAUDE_JSON" "$TMP"

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

# aigentry-* projects + /tmp/bench-orch
PATHS=()
for p in "$HOME"/projects/aigentry-*; do
  [ -d "$p" ] && PATHS+=("$p")
done
PATHS+=("/tmp/bench-orch")

for path in "${PATHS[@]}"; do
  jq --arg p "$path" --argjson tr "$TRUST_RECORD" \
    '.projects[$p] = ((.projects[$p] // {}) + $tr)' "$TMP" > "$TMP.new"
  mv "$TMP.new" "$TMP"
done

mv "$TMP" "$CLAUDE_JSON"

echo "--- verification ---"
for p in "$HOME"/projects/aigentry-*; do
  name=$(basename "$p")
  trust=$(jq -r --arg p "$p" '.projects[$p].hasTrustDialogAccepted // "MISSING"' "$CLAUDE_JSON")
  printf "  %-6s %s\n" "$trust" "$name"
done
bench_trust=$(jq -r '.projects["/tmp/bench-orch"].hasTrustDialogAccepted // "MISSING"' "$CLAUDE_JSON")
echo "  $bench_trust  /tmp/bench-orch"
