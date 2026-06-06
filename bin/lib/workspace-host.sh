#!/usr/bin/env bash
# workspace-host.sh — Workspace Host adapter seam (ADR 2026-05-20 §Consequences).
#
# Source via:
#   source "$SCRIPT_DIR/lib/workspace-host.sh"
#
# Adapter selection (env override → auto-detect):
#   AIGENTRY_WORKSPACE_HOST=cmux     # force cmux
#   AIGENTRY_WORKSPACE_HOST=warp     # force warp (macOS UI-scripting; Warp has no
#                                    #   desktop CLI → never auto-detected, env-force only)
#   AIGENTRY_WORKSPACE_HOST=headless # no-op (CI / docker / windows-terminal fallback)
#   (unset)                          # auto: cmux if `cmux` on PATH, else headless
#
# Contract (5 methods — every adapter MUST implement all five):
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
#   wh_focus <host_id>
#       Bring the host workspace to the foreground (focus / raise). Best-effort
#       policy actuation owned by the orchestrator (verdict 2026-05-30 §4 — focus
#       moved off telepty). Idempotent; degrades to a logged no-op when the
#       mechanism is unavailable (§17).
#       Exit: 0 (focused or gracefully degraded).
#
# Additive sidebar-keeping methods (SPEC 2026-06-06-cmux-adaptor-prune-status;
# every adapter implements them — cmux acts, warp/headless no-op per §17):
#
#   wh_prune_orphans <live_ids_csv> <protected_refs_csv>
#       Close host workspaces whose session vanished from <live_ids_csv>, gated by
#       ownership + a seen-twice debounce ledger (SPEC §A). Prints count closed.
#       Exit: 0 (best-effort; never blocks the sweep).
#
#   wh_set_status <host_id> <state>     # state ∈ {working,idle,disconnected}
#       Push session state to the host sidebar pill (SPEC §B). Exit: 0 (always).
#
#   wh_clear_status <host_id>
#       Remove the aigentry status pill. Idempotent. Exit: 0 (always).
#
# Constitution §17 (무의존): every adapter degrades gracefully when its
# underlying tool is missing (e.g., cmux not installed → headless behavior).

# Idempotent guard so multiple `source` calls don't redefine.
if [ "${WORKSPACE_HOST_SH_LOADED:-0}" = "1" ]; then
  return 0
fi
WORKSPACE_HOST_SH_LOADED=1

# _wh_log <msg> — best-effort stderr line with the standard prefix. The reconciler
# tees its own `log`; the adapter only emits to stderr so it never blocks a sweep.
_wh_log() { echo "[workspace-host] $*" >&2; }

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
  # F9 fix: liveness via `sidebar-state` (the only per-handle probe). The handle
  # may be a UUID (cmuxWorkspaceId from telepty) or a ref (workspace:N); cmux
  # accepts <id|ref|index>. Judge by STDOUT content, not exit code (F7): a missing
  # tab prints an "Error:" line, so alive iff stdout is non-empty AND not an Error.
  local host_id="$1" out
  [ -z "$host_id" ] && return 1
  command -v cmux >/dev/null 2>&1 || return 1
  out=$(cmux sidebar-state --workspace "$host_id" 2>/dev/null)
  [ -z "$out" ] && return 1
  case "$out" in
    Error:*) return 1 ;;
  esac
  return 0
}

_wh_cmux_list_ids() {
  # F9 fix: the workspace listing carries NO UUID field (F3); `ref` (workspace:N)
  # is the stable per-workspace handle. wh_list_ids semantics are unchanged for
  # callers ("host_ids the adapter knows" = refs). Correct shape: `--json` is a
  # GLOBAL flag before the command (F2), and the array lives under `.workspaces`.
  command -v cmux >/dev/null 2>&1 || return 0
  cmux --json list-workspaces 2>/dev/null \
    | jq -r '.workspaces[].ref // empty' 2>/dev/null || true
}

# _wh_cmux_list_titles — emit one `ref<TAB>title<TAB>current_directory` row per
# workspace (F2/F3 correct shape). Title is the session-correlation key (F4);
# current_directory is the ownership signal (F5).
_wh_cmux_list_titles() {
  command -v cmux >/dev/null 2>&1 || return 0
  cmux --json list-workspaces 2>/dev/null \
    | jq -r '.workspaces[] | [.ref, .title, .current_directory] | @tsv' 2>/dev/null || true
}

# _wh_cmux_set_status <host_id> <state> — map an aigentry session state to the
# cmux sidebar pill under the DISTINCT key `aigentry` (F8: never clobber
# claude_code's own `claude_code` pill). Best-effort; always returns 0 (§17).
_wh_cmux_set_status() {
  local host_id="$1" state="$2" icon color
  [ -z "$host_id" ] && return 0
  command -v cmux >/dev/null 2>&1 || return 0
  case "$state" in
    working)      icon=hammer;          color="#ff9500" ;;
    idle)         icon=checkmark;       color="#34c759" ;;
    disconnected) icon=exclamationmark; color="#ff3b30" ;;
    *) return 0 ;; # unknown state — no-op (never emit a speculative pill)
  esac
  cmux set-status aigentry "$state" --icon "$icon" --color "$color" \
    --workspace "$host_id" >/dev/null 2>&1 || true
  return 0
}

# _wh_cmux_clear_status <host_id> — remove the `aigentry` pill. Idempotent; 0.
_wh_cmux_clear_status() {
  local host_id="$1"
  [ -z "$host_id" ] && return 0
  command -v cmux >/dev/null 2>&1 || return 0
  cmux clear-status aigentry --workspace "$host_id" >/dev/null 2>&1 || true
  return 0
}

# _wh_cmux_prune_orphans <live_ids_csv> <protected_refs_csv> — close cmux
# workspaces whose session has vanished from the live set, gated per SPEC §2:
#   orphan := title ∉ live_ids  AND  owned(W)  AND  ref ∉ protected_refs
#   owned(W) := current_directory under $AIGENTRY_ROLE_SANDBOX_DIR (F5).
# Two guards before any close (INV-17 style):
#   1. caller-supplied live_ids / protected_refs corroboration;
#   2. seen-twice debounce — a candidate is closed only if it was ALSO a candidate
#      on the previous tick (persisted in the ledger), giving a freshly-spawned
#      workspace ≥1 reconcile cycle to register with telepty (replaces the missing
#      creation timestamp, F3).
# Honors DRY_RUN (log-only, never closes). Prints the count closed; always 0.
_wh_cmux_prune_orphans() {
  local live_csv="$1" protected_csv="$2"
  command -v cmux >/dev/null 2>&1 || { echo 0; return 0; }
  local sandbox="${AIGENTRY_ROLE_SANDBOX_DIR:-$HOME/.aigentry/role-sandbox}"
  local ledger="${AIGENTRY_CMUX_ORPHAN_LEDGER:-${TMPDIR:-/tmp}/aigentry-cmux-orphan-ledger.json}"
  local dry="${DRY_RUN:-0}"
  local old_ledger now new_ledger closed=0 ref title cwd
  old_ledger=$(cat "$ledger" 2>/dev/null || echo '{}')
  printf '%s' "$old_ledger" | jq -e . >/dev/null 2>&1 || old_ledger='{}'
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
  new_ledger='{}'
  while IFS=$'\t' read -r ref title cwd; do
    [ -z "$ref" ] && continue
    [ -z "$title" ] && continue
    # live corroboration — never prune a live session's workspace.
    case ",$live_csv," in *",$title,"*) continue;; esac
    # protected refs (orchestrator) — never prune.
    case ",$protected_csv," in *",$ref,"*) continue;; esac
    # ownership gate (F5) — only aigentry-spawned role-sandbox workspaces.
    case "$cwd" in "$sandbox"/*|"$sandbox") ;; *) continue;; esac
    # ── candidate confirmed ── apply the seen-twice debounce via the ledger.
    if printf '%s' "$old_ledger" | jq -e --arg r "$ref" 'has($r)' >/dev/null 2>&1; then
      # seen on a previous tick → eligible to close.
      if [ "$dry" = "1" ]; then
        _wh_log "PRUNE would-close ref=$ref title=$title"
        # dry-run never advances the ledger past recording → carry the entry.
        new_ledger=$(printf '%s' "$new_ledger" | jq --arg r "$ref" --arg t "$now" '.[$r]=$t')
        continue
      fi
      if _wh_cmux_close "$ref"; then
        _wh_log "PRUNE closed ref=$ref title=$title"
        closed=$((closed + 1))
        # successfully closed → drop from ledger (do NOT carry forward).
      else
        _wh_log "PRUNE close-failed ref=$ref title=$title"
        # carry forward so it retries next tick.
        new_ledger=$(printf '%s' "$new_ledger" | jq --arg r "$ref" --arg t "$now" '.[$r]=$t')
      fi
    else
      # first sighting → record + skip (debounce floor).
      new_ledger=$(printf '%s' "$new_ledger" | jq --arg r "$ref" --arg t "$now" '.[$r]=$t')
    fi
  done <<EOF
$(_wh_cmux_list_titles)
EOF
  printf '%s\n' "$new_ledger" > "$ledger" 2>/dev/null || true
  echo "$closed"
  return 0
}

_wh_cmux_focus() {
  local host_id="$1"
  [ -z "$host_id" ] && return 0
  command -v cmux >/dev/null 2>&1 || return 0 # cmux not installed — no-op (§17)
  cmux select-workspace --workspace "$host_id" >/dev/null 2>&1
}

# -----------------------------------------------------------------------------
# warp adapter (macOS System Events UI-scripting + sentinel files)
# -----------------------------------------------------------------------------
# Warp exposes NO desktop CLI, AppleScript dictionary, or IPC (design
# 2026-05-29-warp-automanage-design.md). Spawn happens at the dispatch layer via
# a `warp://tab_config/` deeplink that (a) titles its window "telepty::<sid>" —
# the only find-handle — and (b) writes a sentinel
# ~/.aigentry/warp-surfaces/<sid>.live. This adapter owns close / focus / alive
# of an already-spawned Warp surface:
#   - host_id == the window marker "telepty::<sid>" (Warp supplies no id).
#   - liveness == sentinel-file presence, GATED by "is Warp running?" so a Warp
#     quit (all surfaces vanish at once) reports INDETERMINATE→alive, never
#     "gone" (INV-17 / #486 mass-kill guard).
#   - close / focus == macOS System Events with IME-safe physical `key code`s;
#     degrade to a logged no-op when osascript / AX / macOS is unavailable
#     (§17). close / focus NEVER throw or block teardown → always return 0.
AIGENTRY_WARP_SURFACE_DIR="${AIGENTRY_WARP_SURFACE_DIR:-$HOME/.aigentry/warp-surfaces}"

# _wh_warp_sid_from_marker <marker> — recover sid from the "telepty::<sid>" marker.
_wh_warp_sid_from_marker() { printf '%s' "${1#telepty::}"; }

# _wh_warp_can_uiscript — 0 if macOS + osascript present (UI-scripting possible).
# AX-permission denial surfaces later as a non-zero osascript exit (degrade).
_wh_warp_can_uiscript() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  command -v osascript >/dev/null 2>&1 || return 1
  return 0
}

# _wh_warp_app_running — 0 if a Warp desktop process is alive (caller guarantees pgrep).
_wh_warp_app_running() {
  pgrep -f 'Warp.app' >/dev/null 2>&1 && return 0      # macOS (exec name "stable")
  pgrep -f 'warp-terminal' >/dev/null 2>&1 && return 0 # Linux
  return 1
}

# _wh_warp_raise_window <marker> — best-effort: activate Warp and AXRaise the
# window whose title contains <marker>. marker passed as argv (no string-interp
# into AppleScript → injection-safe). 0 raised, non-zero not-found/denied.
_wh_warp_raise_window() {
  local marker="$1"
  osascript - "$marker" >/dev/null 2>&1 <<'OSA'
on run argv
  set marker to item 1 of argv
  tell application "Warp" to activate
  delay 0.3
  tell application "System Events"
    set procs to (every process whose name is "Warp" or name is "stable")
    repeat with p in procs
      try
        repeat with w in (windows of p)
          if (name of w as string) contains marker then
            perform action "AXRaise" of w
            return true
          end if
        end repeat
      end try
    end repeat
  end tell
  error "window not found"
end run
OSA
}

# _wh_warp_send_cmd_key <keycode> — System Events `key code <n> using command down`.
# Physical key codes ONLY (IME-immune; `keystroke "x"` mangles under Korean IME).
_wh_warp_send_cmd_key() {
  local code="$1"
  osascript - "$code" >/dev/null 2>&1 <<'OSA'
on run argv
  set kc to (item 1 of argv) as integer
  tell application "System Events" to key code kc using {command down}
end run
OSA
}

# _wh_warp_rm_tab_config <sid> — best-effort GC of the spawn-written TOML. The
# dispatch layer owns the exact (sanitized) name; this removes the documented
# default "telepty-<sid>.toml". A miss leaves a harmless stale config.
_wh_warp_rm_tab_config() {
  local sid="$1" dir
  case "$(uname -s)" in
    Darwin) dir="$HOME/.warp/tab_configs" ;;
    Linux)  dir="${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs" ;;
    *)      return 0 ;;
  esac
  rm -f "$dir/telepty-$sid.toml" 2>/dev/null || true
}

_wh_warp_lookup() {
  local sid="$1" info="${2:-}"
  if [ -z "$info" ]; then
    info=$(telepty list --json 2>/dev/null | jq -c --arg sid "$sid" '.[] | select(.id == $sid)' 2>/dev/null | head -1)
  fi
  [ -z "$info" ] && { echo ""; return 0; } # no telepty entry → no mapping
  local marker
  marker=$(printf '%s' "$info" | jq -r '.warpWindowMarker // .warpSurfaceId // empty' 2>/dev/null || true)
  # telepty may not persist the marker yet → synthesize the spawn-time contract.
  [ -z "$marker" ] && marker="telepty::$sid"
  printf '%s' "$marker"
}

_wh_warp_close() {
  local marker="$1"
  [ -z "$marker" ] && return 0
  local sid; sid=$(_wh_warp_sid_from_marker "$marker")
  # Always remove orchestrator-written surface state (sentinel + config).
  rm -f "$AIGENTRY_WARP_SURFACE_DIR/$sid.live" 2>/dev/null || true
  _wh_warp_rm_tab_config "$sid"
  if ! _wh_warp_can_uiscript; then
    # §17: no UI-scripting (non-macOS / no osascript) → orphan tab is cosmetic.
    echo "[workspace-host] warp close no-op (UI-scripting unavailable): $marker" >&2
    return 0
  fi
  if _wh_warp_raise_window "$marker"; then
    _wh_warp_send_cmd_key 13 \
      || echo "[workspace-host] warp close: Cmd+W failed for $marker (AX denied?)" >&2
  else
    # Never blind-close the frontmost: a wrong Cmd+W destroys unrelated work
    # (design §7.2). Leave the orphan tab rather than risk it.
    echo "[workspace-host] warp close: window '$marker' not found; left as orphan tab (no blind close)" >&2
  fi
  return 0
}

_wh_warp_alive() {
  local marker="$1"
  [ -z "$marker" ] && return 1
  command -v pgrep >/dev/null 2>&1 || return 0 # cannot probe Warp → INDETERMINATE→alive (INV-17)
  if ! _wh_warp_app_running; then
    return 0 # Warp down → all surfaces vanish at once → INDETERMINATE→alive (INV-17 #486 guard)
  fi
  local sid; sid=$(_wh_warp_sid_from_marker "$marker")
  [ -f "$AIGENTRY_WARP_SURFACE_DIR/$sid.live" ] && return 0
  return 1 # Warp up, sentinel gone → surface gone
}

_wh_warp_list_ids() {
  [ -d "$AIGENTRY_WARP_SURFACE_DIR" ] || return 0
  local f sid
  for f in "$AIGENTRY_WARP_SURFACE_DIR"/*.live; do
    [ -e "$f" ] || continue # no matches → glob stayed literal
    sid=$(basename "$f" .live)
    printf 'telepty::%s\n' "$sid"
  done
}

_wh_warp_focus() {
  local marker="$1"
  [ -z "$marker" ] && return 0
  if ! _wh_warp_can_uiscript; then
    echo "[workspace-host] warp focus no-op (UI-scripting unavailable): $marker" >&2
    return 0
  fi
  if ! _wh_warp_raise_window "$marker"; then
    # Never guess a blind Cmd+N index — a wrong index switches the user's tab
    # (design §7.2). No addressable focus → no-op.
    echo "[workspace-host] warp focus: window '$marker' not found; no-op (no blind index)" >&2
  fi
  return 0
}

# Warp has no status/listing CLI → prune/status degrade to no-ops (§17).
_wh_warp_prune_orphans() { echo 0; return 0; }
_wh_warp_set_status()    { return 0; }
_wh_warp_clear_status()  { return 0; }

# -----------------------------------------------------------------------------
# headless adapter (no-op — for CI/docker/windows-terminal/zellij stubs)
# -----------------------------------------------------------------------------
_wh_headless_lookup()        { echo ""; }
_wh_headless_close()         { return 0; }
_wh_headless_alive()         { return 1; }
_wh_headless_list_ids()      { :; }
_wh_headless_focus()         { return 0; }
_wh_headless_prune_orphans() { echo 0; return 0; }
_wh_headless_set_status()    { return 0; }
_wh_headless_clear_status()  { return 0; }

# -----------------------------------------------------------------------------
# dispatcher — selects adapter then forwards
# -----------------------------------------------------------------------------
_wh_adapter() {
  local pref="${AIGENTRY_WORKSPACE_HOST:-}"
  case "$pref" in
    cmux|warp|headless) printf '%s' "$pref"; return 0;;
  esac
  # Auto-detect: cmux if on PATH, else headless. NOTE: warp has no desktop CLI
  # (design 2026-05-29) so it is never auto-detected — select it explicitly via
  # AIGENTRY_WORKSPACE_HOST=warp.
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

wh_focus() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_focus" "$@"
}

# wh_prune_orphans <live_ids_csv> <protected_refs_csv> — close host workspaces
# whose session has vanished, gated (SPEC §A). Prints count closed; always 0.
wh_prune_orphans() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_prune_orphans" "$@"
}

# wh_set_status <host_id> <state> — push session state to the host sidebar
# (SPEC §B). state ∈ {working,idle,disconnected}. Best-effort; always 0.
wh_set_status() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_set_status" "$@"
}

# wh_clear_status <host_id> — remove the aigentry status pill. Idempotent; 0.
wh_clear_status() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_clear_status" "$@"
}

# Convenience composite: lookup + close for a sid in one call.
wh_close_for_sid() {
  local sid="$1" info="${2:-}" host_id
  host_id=$(wh_lookup "$sid" "$info")
  [ -z "$host_id" ] && return 0
  wh_close "$host_id"
}
