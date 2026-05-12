#!/usr/bin/env bash
# session-cleanup.sh — Cleanup orchestrator-spawned session (cmux workspace + telepty advisory).
#
# Closes the cmux workspace for a given session id and confirms the telepty session
# has moved to DISCONNECTED. Actual telepty session removal is pending telepty#17
# (telepty 0.3.5 has no `rm`/`prune` command); this helper emits an advisory line so
# operators know the disconnected entry will linger in `telepty list` until #17 lands.
#
# Enforces AGENTS.md Rule 28 by refusing to clean the protected `orchestrator` session
# unless --force is passed.
#
# Usage:
#   session-cleanup.sh <sid> [--force]
#   session-cleanup.sh --all-disconnected     # batch: prune all DISCONNECTED sessions
#   session-cleanup.sh --help
#
# Exit codes:
#   0 — success (including idempotent no-op when session already gone)
#   1 — usage error
#   2 — missing dependency
#
# Sibling: bin/open-session.sh (spawn counterpart).

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

PROTECTED_SID="orchestrator"

usage() {
  sed -n '2,20p' "$0"
  exit "${1:-0}"
}

err() { echo "ERR $*" >&2; }
log() { echo "[session-cleanup] $*"; }

require_deps() {
  for c in telepty jq; do
    command -v "$c" >/dev/null 2>&1 || { err "$c not found in PATH"; exit 2; }
  done
}

# session_info <sid> → json record on stdout (empty if not in telepty list)
session_info() {
  local sid="$1"
  telepty list --json 2>/dev/null | jq -c --arg sid "$sid" '.[] | select(.id == $sid)' | head -1
}

# disconnected_sids → one sid per line for DISCONNECTED sessions, excluding PROTECTED
disconnected_sids() {
  telepty list --json 2>/dev/null \
    | jq -r --arg p "$PROTECTED_SID" '
        .[]
        | select(.healthStatus == "DISCONNECTED" and .id != $p)
        | .id'
}

# close_cmux_workspace <sid> <session-json>
close_cmux_workspace() {
  local sid="$1" json="$2"
  if ! command -v cmux >/dev/null 2>&1; then
    log "cmux CLI not on PATH; skipping workspace close for $sid"
    return 0
  fi
  local ws_id
  ws_id=$(echo "$json" | jq -r '.cmuxWorkspaceId // empty')
  if [ -z "$ws_id" ]; then
    log "no cmux workspace mapped for $sid; skipping"
    return 0
  fi
  if cmux close-workspace --workspace "$ws_id" >/dev/null 2>&1; then
    log "cmux workspace closed: $sid ($ws_id)"
  else
    log "cmux close-workspace non-zero for $sid (already closed?)"
  fi
}

# poll_disconnected <sid> — return 0 if telepty marks sid as DISCONNECTED (or gone) within ~5s
poll_disconnected() {
  local sid="$1" deadline status
  deadline=$(( $(date +%s) + 5 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status=$(telepty list --json 2>/dev/null \
      | jq -r --arg sid "$sid" '.[] | select(.id == $sid) | .healthStatus' \
      | head -1 || true)
    [ -z "$status" ] && return 0
    [ "$status" = "DISCONNECTED" ] && return 0
    sleep 0.5
  done
  return 1
}

cleanup_one() {
  local sid="$1" force="${2:-0}"
  if [ "$sid" = "$PROTECTED_SID" ] && [ "$force" -ne 1 ]; then
    err "refusing to clean protected session '$PROTECTED_SID' (pass --force to override)"
    return 1
  fi
  local info
  info=$(session_info "$sid")
  if [ -z "$info" ]; then
    log "session not in telepty list: $sid (already cleaned or never registered)"
    return 0
  fi
  close_cmux_workspace "$sid" "$info"
  if poll_disconnected "$sid"; then
    log "telepty session DISCONNECTED; will be auto-pruned when telepty#17 lands (currently retained in list)."
  else
    log "telepty session $sid not yet DISCONNECTED — verify manually."
  fi
  return 0
}

cleanup_all_disconnected() {
  local sids count=0
  sids=$(disconnected_sids)
  if [ -z "$sids" ]; then
    echo "cleaned: 0 disconnected sessions (cmux workspace close attempted; telepty rm pending #17)"
    return 0
  fi
  while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    cleanup_one "$sid" 0 || true
    count=$((count + 1))
  done <<< "$sids"
  echo "cleaned: $count disconnected sessions (cmux workspace close attempted; telepty rm pending #17)"
}

main() {
  [ $# -eq 0 ] && usage 1
  require_deps

  local mode_all=0 force=0 sid=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage 0;;
      --all-disconnected) mode_all=1; shift;;
      --force) force=1; shift;;
      --*) err "unknown flag: $1"; exit 1;;
      *)
        [ -n "$sid" ] && { err "unexpected positional arg: $1"; exit 1; }
        sid="$1"; shift;;
    esac
  done

  if [ "$mode_all" -eq 1 ]; then
    [ -n "$sid" ] && { err "--all-disconnected does not take a sid argument"; exit 1; }
    cleanup_all_disconnected
    exit 0
  fi

  [ -z "$sid" ] && { err "<sid> required (or use --all-disconnected)"; usage 1; }
  cleanup_one "$sid" "$force"
}

main "$@"
