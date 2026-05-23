#!/usr/bin/env bash
# workspace-host.sh — Workspace Host adapter seam (ADR 2026-05-20 §Consequences).
#
# Source via:
#   source "$SCRIPT_DIR/lib/workspace-host.sh"
#
# Adapter selection (env override → auto-detect):
#   AIGENTRY_WORKSPACE_HOST=cmux     # force cmux
#   AIGENTRY_WORKSPACE_HOST=headless # no-op (CI / docker / windows-terminal fallback)
#   (unset)                          # auto: cmux if `cmux` on PATH, else headless
#
# Contract (4 methods — every adapter MUST implement all four):
#
#   wh_lookup <sid> [<session_json>]
#       Print the host_id (e.g. cmux workspace id) for <sid> on stdout, or
#       empty string if the host has no mapping. Optional second arg is the
#       pre-fetched `telepty list --json` entry for <sid> — adapters MAY
#       use it to avoid an extra IPC call.
#       Exit: 0 (always — empty stdout is the "no mapping" signal).
#
#   wh_close <host_id>
#       Release the host workspace. Idempotent: 0 means "released or already
#       gone"; 1 means "real failure" (host still alive).
#
#   wh_alive <host_id>
#       Probe whether the host_id still exists.
#       Exit: 0 alive, 1 gone. Used by the reconciler to gate "orphan" claims.
#
#   wh_list_ids
#       Print every host_id the adapter currently knows about, one per line.
#       Used to detect host-side orphans (host has it, telepty doesn't).
#
# Constitution §17 (무의존): every adapter degrades gracefully when its
# underlying tool is missing (e.g., cmux not installed → headless behavior).

# Idempotent guard so multiple `source` calls don't redefine.
if [ "${WORKSPACE_HOST_SH_LOADED:-0}" = "1" ]; then
  return 0
fi
WORKSPACE_HOST_SH_LOADED=1

# -----------------------------------------------------------------------------
# cmux adapter
# -----------------------------------------------------------------------------
_wh_cmux_lookup() {
  local sid="$1" info="${2:-}"
  if [ -z "$info" ]; then
    info=$(telepty list --json 2>/dev/null | jq -c --arg sid "$sid" '.[] | select(.id == $sid)' 2>/dev/null | head -1)
  fi
  [ -z "$info" ] && { echo ""; return 0; }
  echo "$info" | jq -r '.cmuxWorkspaceId // empty' 2>/dev/null || true
}

_wh_cmux_close() {
  local host_id="$1"
  [ -z "$host_id" ] && return 0
  if ! command -v cmux >/dev/null 2>&1; then
    return 0 # cmux not installed — treat as already-gone (no-op)
  fi
  if cmux close-workspace --workspace "$host_id" >/dev/null 2>&1; then
    return 0
  fi
  # Re-probe: "close failed" often means "already closed" — confirm via alive.
  if ! _wh_cmux_alive "$host_id"; then
    return 0
  fi
  return 1
}

_wh_cmux_alive() {
  local host_id="$1"
  [ -z "$host_id" ] && return 1
  command -v cmux >/dev/null 2>&1 || return 1
  if cmux list-workspaces --json 2>/dev/null \
       | jq -e --arg id "$host_id" '.[] | select(.id == $id)' >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

_wh_cmux_list_ids() {
  command -v cmux >/dev/null 2>&1 || return 0
  cmux list-workspaces --json 2>/dev/null \
    | jq -r '.[].id // empty' 2>/dev/null || true
}

# -----------------------------------------------------------------------------
# headless adapter (no-op — for CI/docker/windows-terminal/zellij stubs)
# -----------------------------------------------------------------------------
_wh_headless_lookup()   { echo ""; }
_wh_headless_close()    { return 0; }
_wh_headless_alive()    { return 1; }
_wh_headless_list_ids() { :; }

# -----------------------------------------------------------------------------
# dispatcher — selects adapter then forwards
# -----------------------------------------------------------------------------
_wh_adapter() {
  local pref="${AIGENTRY_WORKSPACE_HOST:-}"
  case "$pref" in
    cmux|headless) printf '%s' "$pref"; return 0;;
  esac
  if command -v cmux >/dev/null 2>&1; then
    printf '%s' "cmux"
  else
    printf '%s' "headless"
  fi
}

wh_lookup() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_lookup" "$@"
}

wh_close() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_close" "$@"
}

wh_alive() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_alive" "$@"
}

wh_list_ids() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_list_ids" "$@"
}

# Convenience composite: lookup + close for a sid in one call.
wh_close_for_sid() {
  local sid="$1" info="${2:-}" host_id
  host_id=$(wh_lookup "$sid" "$info")
  [ -z "$host_id" ] && return 0
  wh_close "$host_id"
}
