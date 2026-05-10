#!/usr/bin/env bash
# cmux-inject.sh — inject message to a session via cmux send + send-key
# Usage: cmux-inject.sh <session-id-or-workspace> "message"

TARGET="$1"
MESSAGE="$2"

if [[ -z "$TARGET" || -z "$MESSAGE" ]]; then
  echo "Usage: cmux-inject.sh <workspace-id> \"message\""
  exit 1
fi

# If target looks like a session ID, find workspace
if [[ "$TARGET" != workspace:* ]]; then
  WORKSPACE=$(cmux list-workspaces 2>/dev/null | grep "$TARGET" | head -1 | awk '{print $1}' | sed 's/\*//')
  if [[ -z "$WORKSPACE" ]]; then
    echo "✗ Session not found: $TARGET"
    exit 1
  fi
else
  WORKSPACE="$TARGET"
fi

# Send message + enter
cmux send --workspace "$WORKSPACE" "$MESSAGE" 2>/dev/null
sleep 0.2
cmux send-key --workspace "$WORKSPACE" return 2>/dev/null
echo "✓ ${TARGET}"
