#!/usr/bin/env bash
# session-cleanup.sh — Actually remove orchestrator-spawned sessions.
#
# Three-step removal per session:
#   1. Kill the parent `telepty allow --id <sid> ...` process via SIGTERM
#      (process tree dies → wrapped CLI dies, telepty auto-deregisters most cases).
#   2. cmux close-workspace (best-effort, harmless if cmux unavailable).
#   3. DELETE /api/sessions/<sid> on local daemon (force-remove from registry —
#      handles the edge case where parent kill alone did not propagate).
#
# Discovered 2026-05-17: prior version of this script only attempted cmux close +
# advisory "telepty#17 pending" emit, which left 21 wrapped sessions accumulated
# for days. The DELETE API existed in daemon.js:2367 but was unused by this helper.
# parent-PID SIGTERM is the load-bearing step (auto-deregisters in ~404 of cases);
# DELETE is the backup that handles residual entries.
#
# Enforces AGENTS.md Rule 28 by refusing to clean the protected `orchestrator`
# session unless --force is passed. The active-builder session(s) currently working
# may be additionally protected via --keep <sid>.
#
# Usage:
#   session-cleanup.sh <sid> [--force]
#   session-cleanup.sh --all-disconnected           # batch: only DISCONNECTED entries
#   session-cleanup.sh --all-unused [--keep <sid>]  # batch: every non-orchestrator session
#                                                    # (multiple --keep allowed for active builders)
#   session-cleanup.sh --help
#
# Exit codes:
#   0 — success (including idempotent no-op when session already gone)
#   1 — usage error
#   2 — missing dependency
#   3 — telepty list --json failed or returned non-JSON (binary/daemon mismatch)
#   4 — invoked from a worker session (AIGENTRY_WORKER_SESSION set) — refused;
#       session lifecycle is the orchestrator's exclusive domain (#524).
#
# Sibling: bin/open-session.sh (spawn counterpart).

set -euo pipefail

# Intentionally do NOT override PATH here. A previous hardcoded
# PATH="/opt/homebrew/bin:..." caused this script to pick a stale
# homebrew telepty (v0.4.0) while the running daemon was v0.3.5; the
# resulting "Daemon version mismatch" banner contaminated jq stdin
# and triggered "Invalid numeric literal at line 1, column 2" (task #400).
# `require_deps` is the gate — it fails loudly if telepty/jq are missing
# from the inherited PATH.

PROTECTED_SID="orchestrator"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/workspace-host.sh
. "$SCRIPT_DIR/lib/workspace-host.sh"

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

# telepty_list_json — fetch `telepty list --json` and fail-fast if the result
# is not parseable JSON. Prevents silent "session not found" reports when the
# real cause is a contaminated stdout (e.g., daemon-version-mismatch banner
# from the wrong telepty binary on PATH — see task #400 root cause).
telepty_list_json() {
  local raw
  raw=$(telepty list --json 2>/dev/null) || {
    err "telepty list --json exited non-zero"
    exit 3
  }
  if ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    err "telepty list --json returned non-JSON output (telepty binary/daemon version mismatch?)"
    err "first 200 bytes of stdout:"
    printf '%s' "$raw" | head -c 200 >&2
    echo >&2
    err "PATH=$PATH"
    err "which telepty: $(command -v telepty || echo NOT_FOUND)"
    exit 3
  fi
  printf '%s' "$raw"
}

# session_info <sid> → json record on stdout (empty if not in telepty list)
session_info() {
  local sid="$1"
  telepty_list_json | jq -c --arg sid "$sid" '.[] | select(.id == $sid)' | head -1
}

# disconnected_sids → one sid per line for DISCONNECTED sessions, excluding PROTECTED
disconnected_sids() {
  telepty_list_json \
    | jq -r --arg p "$PROTECTED_SID" '
        .[]
        | select(.healthStatus == "DISCONNECTED" and .id != $p)
        | .id'
}

# close_workspace_for <sid> <session-json>
# Routes through the Workspace Host adapter seam (bin/lib/workspace-host.sh).
# Adapters: cmux / warp / headless(no-op). ADR 2026-05-20.
# Per verdict 2026-05-30 this is the SOLE surface-close path — telepty no longer
# actuates surface close (it probes liveness + emits surface_orphaned only). The
# adapter's wh_close is idempotent, so a transient double-close during the
# telepty-side rollout is harmless (re-probe → already-gone → 0).
close_workspace_for() {
  local sid="$1" json="$2" host_id
  host_id=$(wh_lookup "$sid" "$json")
  if [ -z "$host_id" ]; then
    log "no workspace host id mapped for $sid; skipping"
    return 0
  fi
  if wh_close "$host_id"; then
    log "workspace host closed: $sid ($host_id)"
  else
    log "workspace host close non-zero for $sid (already closed?)"
  fi
}

# kill_parent_telepty_allow <sid> — find the `node ... telepty allow --id <sid> ...`
# process and SIGTERM it. Its child wrapped CLI (claude/codex/gemini/...) dies with it.
kill_parent_telepty_allow() {
  local sid="$1" pid
  pid=$(ps -eo pid,command 2>/dev/null \
    | awk -v s="$sid" '$0 ~ ("telepty allow --id " s " ") {print $1; exit}' || true)
  if [ -z "$pid" ]; then
    log "no parent telepty-allow process for $sid (already exited?)"
    return 0
  fi
  if kill -TERM "$pid" 2>/dev/null; then
    log "killed parent telepty-allow PID $pid for $sid"
  else
    log "kill -TERM PID $pid failed for $sid (may be exiting)"
  fi
}

# delete_session_registry <sid> — call DELETE /api/sessions/<sid> on local daemon
# (daemon.js:2367). 200 = removed, 404 = already gone (after parent kill).
delete_session_registry() {
  local sid="$1" port="${TELEPTY_PORT:-3848}" http
  http=$(curl -s -o /dev/null -w '%{http_code}' \
    -X DELETE "http://127.0.0.1:${port}/api/sessions/${sid}" 2>/dev/null || echo "000")
  case "$http" in
    200) log "DELETE /api/sessions/$sid → 200 (removed from registry)";;
    404) log "DELETE /api/sessions/$sid → 404 (already gone — parent kill propagated)";;
    *)   log "DELETE /api/sessions/$sid → $http (unexpected; manual verify)";;
  esac
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
    # telepty-orphan: gone from telepty but the terminal surface may still be
    # alive (idle worker deregistered → cmux workspace lingers, #323/#340). Step 4
    # requires BOTH surfaces cleaned regardless of telepty state. $info is EMPTY
    # here, so close BY SID (wh_close_for_sid) — close_workspace_for <sid> <empty>
    # would silent-no-op. DELETE backup still runs to drop any registry residue.
    log "session not in telepty list: $sid (already cleaned or never registered); closing terminal surface by sid"
    wh_close_for_sid "$sid"
    delete_session_registry "$sid"
    return 0
  fi
  # Step 1 — kill parent (load-bearing; auto-deregisters most cases)
  kill_parent_telepty_allow "$sid"
  # Step 2 — workspace host close via adapter seam (best-effort)
  close_workspace_for "$sid" "$info"
  # Brief settle so daemon notices parent death
  sleep 0.5
  # Step 3 — DELETE registry (force-remove residue)
  delete_session_registry "$sid"
  return 0
}

cleanup_all_disconnected() {
  local sids count=0
  sids=$(disconnected_sids)
  if [ -z "$sids" ]; then
    echo "cleaned: 0 disconnected sessions"
    return 0
  fi
  while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    cleanup_one "$sid" 0 || true
    count=$((count + 1))
  done <<< "$sids"
  echo "cleaned: $count disconnected sessions"
}

# cleanup_all_unused [--keep <sid> ...] — every session not in keep-list and not protected
cleanup_all_unused() {
  local keep_csv="$1" count=0
  local keep_csv_quoted
  keep_csv_quoted=$(jq -nc --arg s "$keep_csv" '$s | split(",") | map(select(length > 0))')
  local sids
  sids=$(telepty_list_json \
    | jq -r --argjson keep "$keep_csv_quoted" --arg p "$PROTECTED_SID" '
        .[]
        | select(.id != $p)
        | select(([.id] | inside($keep)) | not)
        | .id')
  if [ -z "$sids" ]; then
    echo "cleaned: 0 unused sessions"
    return 0
  fi
  while IFS= read -r sid; do
    [ -z "$sid" ] && continue
    cleanup_one "$sid" 0 || true
    count=$((count + 1))
  done <<< "$sids"
  echo "cleaned: $count unused sessions"
}

main() {
  [ $# -eq 0 ] && usage 1
  require_deps

  local mode_all_disc=0 mode_all_unused=0 force=0 sid=""
  local keep_list=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage 0;;
      --all-disconnected) mode_all_disc=1; shift;;
      --all-unused) mode_all_unused=1; shift;;
      --keep)
        [ $# -lt 2 ] && { err "--keep requires <sid>"; exit 1; }
        keep_list="${keep_list:+$keep_list,}$2"; shift 2;;
      --force) force=1; shift;;
      --*) err "unknown flag: $1"; exit 1;;
      *)
        [ -n "$sid" ] && { err "unexpected positional arg: $1"; exit 1; }
        sid="$1"; shift;;
    esac
  done

  # Worker-guard (#524, Defense in Depth): session lifecycle (spawn + de-spawn)
  # is the orchestrator's exclusive domain. A spawned worker carries
  # AIGENTRY_WORKER_SESSION=1 (dispatch.sh:97); refuse fail-fast before any
  # kill/close so a worker can never mass-kill peers via --all-unused. The
  # orchestrator and the autonomous reconciler daemon run WITHOUT this marker,
  # so both pass. Precedent: dispatch.sh:70 install_worker_git_guard.
  if [ -n "${AIGENTRY_WORKER_SESSION:-}" ]; then
    err "session-cleanup.sh is orchestrator-only — refusing to run from a worker session (AIGENTRY_WORKER_SESSION set). Session lifecycle is the orchestrator's domain."
    exit 4
  fi

  if [ "$mode_all_disc" -eq 1 ]; then
    [ -n "$sid" ] && { err "--all-disconnected does not take a sid argument"; exit 1; }
    cleanup_all_disconnected
    exit 0
  fi

  if [ "$mode_all_unused" -eq 1 ]; then
    [ -n "$sid" ] && { err "--all-unused does not take a sid argument"; exit 1; }
    cleanup_all_unused "$keep_list"
    exit 0
  fi

  [ -z "$sid" ] && { err "<sid> required (or use --all-disconnected / --all-unused)"; usage 1; }
  cleanup_one "$sid" "$force"
}

main "$@"
