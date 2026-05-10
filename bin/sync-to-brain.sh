#!/bin/bash
# Sync orchestrator state to brain inbox
# Usage: ./bin/sync-to-brain.sh [lessons|tasks|all]
# Brain picks up files from ~/.aigentry/inbox/ asynchronously

INBOX="$HOME/.aigentry/inbox"
STATE_DIR="$HOME/.aigentry/data"
TIMESTAMP=$(date +%s)

mkdir -p "$INBOX"

sync_file() {
  local src="$1"
  local type="$2"
  if [ -f "$src" ]; then
    local dest="$INBOX/${type}-${TIMESTAMP}.json"
    cat <<EOF > "$dest"
{
  "type": "$type",
  "source": "orchestrator",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "payload": $(cat "$src")
}
EOF
    echo "synced: $type -> $dest"
  else
    echo "skip: $src not found"
  fi
}

case "${1:-all}" in
  lessons)
    sync_file "$STATE_DIR/lessons.json" "lessons"
    ;;
  tasks)
    sync_file "$STATE_DIR/task-queue.json" "task_queue"
    ;;
  all)
    sync_file "$STATE_DIR/lessons.json" "lessons"
    sync_file "$STATE_DIR/task-queue.json" "task_queue"
    ;;
  *)
    echo "Usage: $0 [lessons|tasks|all]"
    exit 1
    ;;
esac
