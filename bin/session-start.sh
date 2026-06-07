#!/usr/bin/env bash
# session-start.sh — Launch all aigentry sessions in kitty + telepty
#
# Usage:
#   session-start.sh              # Start all sessions
#   session-start.sh --kill       # Kill all sessions first, then start
#   session-start.sh --layout     # Start + arrange grid layout
#   session-start.sh --kill --layout  # Full reset: kill, start, layout
#
# NOTE (#539): this launches WORKER/project sessions. The orchestrator
# ("control tower") boots separately via bin/orchestrator-boot.sh, which enforces
# singleton-at-boot (SIGKILL any stale `telepty allow --id <orchestrator-sid>`
# bridge before exec). Boot the orchestrator via that wrapper, not a bare
# `telepty allow`.

set -uo pipefail

PROJECTS_DIR="$HOME/projects"
CLAUDE_BIN="claude"
LAYOUT_SCRIPT="$PROJECTS_DIR/aigentry-orchestrator/bin/session-layout.py"

# All aigentry projects (orchestrator is always included and centered)
PROJECTS=(
  aigentry-orchestrator
  aigentry-amplify
  aigentry-brain
  aigentry-deliberation
  aigentry-devkit
  aigentry-dustcraw
  aigentry-registry
  aigentry-ssot
  aigentry-telepty
)

# Parse args
KILL=false
LAYOUT=false
for arg in "$@"; do
  case "$arg" in
    --kill) KILL=true ;;
    --layout) LAYOUT=true ;;
    --help)
      echo "Usage: session-start.sh [--kill] [--layout]"
      echo "  --kill    Kill existing sessions before starting"
      echo "  --layout  Arrange windows in grid after starting"
      exit 0
      ;;
  esac
done

# Check prerequisites
if ! command -v kitty &>/dev/null; then
  echo "Error: kitty not found" >&2
  exit 1
fi

if ! command -v telepty &>/dev/null; then
  echo "Error: telepty not found" >&2
  exit 1
fi

# Kill existing sessions if requested
if $KILL; then
  echo "Killing existing sessions..."
  for project in "${PROJECTS[@]}"; do
    session_id="${project}-claude"
    # Find and kill existing kitty windows with this session
    kitty @ ls 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for os_win in data:
    for tab in os_win.get('tabs', []):
        title = tab.get('title', '')
        if '${session_id}' in title:
            print(os_win['id'])
            break
" 2>/dev/null | sort -u | while read os_id; do
      kitty @ close-window --match "os_window_id:${os_id}" 2>/dev/null && \
        echo "  Closed: ${session_id} (os_window ${os_id})" || true
    done
  done
  # Wait for cleanup
  sleep 2
  echo "Done killing."
fi

# Launch sessions
echo "Starting sessions..."
STARTED=0
SKIPPED=0

for project in "${PROJECTS[@]}"; do
  session_id="${project}-claude"
  project_dir="${PROJECTS_DIR}/${project}"

  # Check project dir exists
  if [[ ! -d "$project_dir" ]]; then
    echo "  SKIP: ${project} (directory not found)"
    ((SKIPPED++))
    continue
  fi

  # Check if session already has a kitty window
  existing=$(kitty @ ls 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for os_win in data:
    for tab in os_win.get('tabs', []):
        if '${session_id}' in tab.get('title', ''):
            print('exists')
            break
" 2>/dev/null || true)

  if [[ "$existing" == "exists" ]]; then
    echo "  SKIP: ${session_id} (already running)"
    ((SKIPPED++))
    continue
  fi

  # Launch new kitty OS window with telepty allow
  kitty @ launch \
    --type=os-window \
    --cwd="${project_dir}" \
    --title="⚡ telepty :: ${session_id}" \
    --dont-take-focus \
    telepty allow --id "${session_id}" ${CLAUDE_BIN} --dangerously-skip-permissions \
    2>/dev/null

  echo "  START: ${session_id}"
  ((STARTED++))

  # Brief pause to avoid overwhelming the system
  sleep 1
done

echo ""
echo "Started: ${STARTED}, Skipped: ${SKIPPED}, Total projects: ${#PROJECTS[@]}"

# Layout if requested
if $LAYOUT; then
  echo ""
  echo "Waiting for windows to initialize..."
  sleep 3
  echo "Arranging layout..."
  python3 "${LAYOUT_SCRIPT}" 2>/dev/null && echo "Layout applied." || echo "Layout failed."
fi

echo "Done."
