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
  if [ -z "$info" ]; then
    # FALLBACK: telepty has no record (orphan) → resolve by cmux title == sid so a
    # manual `wh_close_for_sid` still closes a deregistered worker's surface (#523).
    _wh_cmux_list_titles | awk -F'\t' -v s="$sid" '$2==s {print $1; exit}'
    return 0
  fi
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
  # CMUX seam (${CMUX:-cmux}): same injectable binary _wh_cmux_open uses, so the #616
  # spawn-time set_status wiring is hermetically testable and NEVER reaches the live
  # cmux daemon 3848 under test (open-session.sh prepends the real cmux to PATH, so a
  # bare `cmux` here would escape the stub). Defaults to the real `cmux` in production.
  local host_id="$1" state="$2" icon color cmux_bin="${CMUX:-cmux}"
  [ -z "$host_id" ] && return 0
  command -v "$cmux_bin" >/dev/null 2>&1 || return 0
  case "$state" in
    working)      icon=hammer;          color="#ff9500" ;;
    idle)         icon=checkmark;       color="#34c759" ;;
    disconnected) icon=exclamationmark; color="#ff3b30" ;;
    *) return 0 ;; # unknown state — no-op (never emit a speculative pill)
  esac
  "$cmux_bin" set-status aigentry "$state" --icon "$icon" --color "$color" \
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

# _wh_cmux_ready_attestation — capability metadata (§12 BC2). ready_attestation ∈
# {surface,process,none}: HOW this adapter's wh_open ready-gate attests pane
# readiness. cmux reads the pane content (read-screen) → surface-attested. This is
# a declared capability FIELD, not a 10th lifecycle verb (the 9-verb boundary is
# invariant, BC2 — readiness stays an internal obligation of wh_open, D3). Note:
# warp(process/AX) + headless(none) declarations land with their phases (2/3).
_wh_cmux_ready_attestation() { printf 'surface'; }

# _wh_cmux_wait_ready <workspace-ref> [cmux-bin] — readiness barrier for a freshly
# created cmux workspace (BUG-A: close the daemon submit-race at the source, Rule 27).
# Moved byte-for-byte from open-session.sh:_cmux_wait_ready (#608 Phase 1, ADR §7) so
# the ready-gate is an internal obligation of _wh_cmux_open (D3), not a public verb.
#
# `cmux new-workspace` returns `workspace:N` on a string-parse, but the pane's surface PTY
# + `telepty allow` foreground proc come up async AFTER that. Returning the ref before the
# surface can accept `send-key` lets the daemon submit fire into a not-yet-live socket
# ("Failed to write to socket") → the worker's Enter is lost → it never starts. This gate
# makes the returned ref mean "the pane is ready to receive keys".
#
# Proof is 3-part, re-checked each poll. cmux's EXIT STATUS IS UNRELIABLE (it prints
# "Error:" lines with rc=0) and a BOGUS REF SILENTLY FALLS BACK to the caller's own surface
# — so every check inspects OUTPUT TEXT, and existence is anchored on list-workspaces (which
# never lists a bogus ref):
#   (a) list-workspaces contains the exact ref → workspace registered (fallback-immune)
#   (b) surface-health shows a `type=terminal` line and no `Error:` → pane surface exists
#   (c) read-screen returns non-empty content and no `Error:`      → surface renders/responds
# Checks short-circuit existence-first, so the fallback-prone probes are never consulted for
# an unregistered ref. The cmux branch is macOS-only, so the loop uses only portable
# primitives (awk/sleep/grep) — no OS abstraction needed (Rule 26).
_wh_cmux_wait_ready() {
  local ref="$1" cmux_bin="${2:-cmux}"
  local timeout_ms="${CMUX_READY_TIMEOUT_MS:-10000}"
  local interval_ms="${CMUX_READY_INTERVAL_MS:-200}"
  local interval_s; interval_s=$(awk -v ms="$interval_ms" 'BEGIN{printf "%.3f", ms/1000}')
  local max_iters=$(( timeout_ms / interval_ms )); [ "$max_iters" -lt 1 ] && max_iters=1
  local i=0 lw sh rs
  while [ "$i" -lt "$max_iters" ]; do
    lw=$("$cmux_bin" list-workspaces 2>/dev/null || true)
    if printf '%s\n' "$lw" | grep -qE "(^|[[:space:]])${ref}([[:space:]]|$)"; then
      sh=$("$cmux_bin" surface-health --workspace "$ref" 2>&1 || true)
      if printf '%s\n' "$sh" | grep -q 'type=terminal' \
         && ! printf '%s\n' "$sh" | grep -q '^Error:'; then
        rs=$("$cmux_bin" read-screen --workspace "$ref" --lines 1 2>&1 || true)
        if [ -n "$(printf '%s' "$rs" | tr -d '[:space:]')" ] \
           && ! printf '%s\n' "$rs" | grep -q '^Error:'; then
          return 0
        fi
      fi
    fi
    i=$((i+1))
    sleep "$interval_s"
  done
  return 1
}

# _wh_cmux_open <sid> <cwd> <cli_cmd> — spawn a visible cmux workspace wrapping
# `telepty allow --id <sid>`, BLOCK until the ready-gate passes, then emit the
# workspace ref (workspace:N) as the host_id (ADR §3 D1 contract). Moved byte-for-byte
# from open-session.sh:open_in_terminal()'s cmux branch (#608 Phase 1, ADR §7).
# Exit contract (handle emitted ⇒ pane ready; no half-spawned surface on failure):
#   0  → ref printed on stdout (surface can accept send-key).
#   2  → new-workspace produced no ref (spawn failed); nothing to clean up.
#   3  → ready-gate timed out; the workspace is closed, NO ref emitted.
# CMUX seam: injectable cmux binary so the readiness gate is hermetically testable
# (BUG-A); defaults to the real `cmux` in production.
_wh_cmux_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  # cmux --command sends text+Enter; telepty allow runs as the workspace's foreground process.
  # bash -c 'cd ... && exec ...' wrapper: cmux --cwd only affects workspace shell, not the
  # telepty-allow-wrapped CLI. Explicit cd inside wrapper guarantees claude inherits cwd (#311).
  local CMUX_BIN="${CMUX:-cmux}"
  local out ref
  out=$("$CMUX_BIN" new-workspace --cwd "$cwd" --command "bash -c 'cd $cwd && exec telepty allow --id $sid --auto-restart $cli_cmd'" 2>&1)
  ref=$(echo "$out" | grep -oE 'workspace:[0-9]+' | head -1)
  [ -z "$ref" ] && { echo "ERR cmux new-workspace failed: $out" >&2; return 2; }
  # title == sid (open-session.sh SID convention); rename to the stable handle.
  "$CMUX_BIN" rename-workspace --workspace "$ref" "$sid" >/dev/null 2>&1 || true
  # Readiness barrier (BUG-A, Rule 27): emit the ref ONLY once the pane surface can
  # accept `send-key`, so the daemon submit never races a not-yet-live socket.
  if ! _wh_cmux_wait_ready "$ref" "$CMUX_BIN"; then
    echo "ERR cmux workspace $ref pane not ready after ${CMUX_READY_TIMEOUT_MS:-10000}ms — surface cannot accept send-key (daemon submit would race 'Failed to write to socket'). Not returning a ref for a dead workspace." >&2
    "$CMUX_BIN" close-workspace --workspace "$ref" >/dev/null 2>&1 || true
    return 3
  fi
  echo "$ref"
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

# _wh_warp_tab_config_dir — resolve the Warp tab_config directory (ADR §5 D5
# path). Single source so the spawn-time WRITER (_wh_warp_open) and its GC dual
# (_wh_warp_rm_tab_config) can never disagree on the path. AIGENTRY_WARP_TAB_CONFIG_DIR
# overrides for hermetic tests (mirrors AIGENTRY_WARP_SURFACE_DIR). Non-zero on an
# OS with no documented Warp tab_config location.
_wh_warp_tab_config_dir() {
  if [ -n "${AIGENTRY_WARP_TAB_CONFIG_DIR:-}" ]; then
    printf '%s' "$AIGENTRY_WARP_TAB_CONFIG_DIR"; return 0
  fi
  case "$(uname -s)" in
    Darwin) printf '%s' "$HOME/.warp/tab_configs" ;;
    Linux)  printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs" ;;
    *)      return 1 ;;
  esac
}

# _wh_warp_rm_tab_config <sid> — best-effort GC of the spawn-written TOML. The
# dispatch layer owns the exact (sanitized) name; this removes the documented
# default "telepty-<sid>.toml". A miss leaves a harmless stale config.
_wh_warp_rm_tab_config() {
  local sid="$1" dir
  dir=$(_wh_warp_tab_config_dir) || return 0
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

# ---- warp wh_open: deeplink spawn + sentinel writer + V2 ready-gate (#608 P2) --
# Closes G5 (warp spawn was a comment, no `warp://` call site) and G6 (the
# sentinel ~/.aigentry/warp-surfaces/<sid>.live that alive/list_ids read had no
# writer → warp surfaces were born-orphaned). ADR §5 D5 + §12 BC1/BC2/BC3.

# _wh_warp_ready_attestation — capability metadata (§12 BC2). HOW warp's wh_open
# ready-gate attests pane readiness, per the runtime's AX capability:
#   surface — macOS + osascript present → bounded AX read-screen (V2, BC1).
#   process — no AX, but Warp liveness is probeable → sentinel+Warp-alive only.
#   none    — cannot even probe (no pgrep) → readiness is unattestable.
# A declared FIELD, not a 10th verb (BC2 9-verb boundary invariant; readiness is
# an internal obligation of wh_open, D3). Asymmetry vs cmux(surface) is the
# honest bounded declaration of a platform limit (Warp has no CLI), not a defect
# (BC6). Mirrors _wh_cmux_ready_attestation.
_wh_warp_ready_attestation() {
  if _wh_warp_can_uiscript; then printf 'surface'; return 0; fi
  command -v pgrep >/dev/null 2>&1 && { printf 'process'; return 0; }
  printf 'none'
}

# _wh_warp_write_tab_config <toml> <marker> <cwd> <wrapper> — write the Warp
# tab_config (ADR §5 D5 step 1): one tab whose window title is the find-handle
# marker "telepty::<sid>" and whose command is the sentinel-writing wrapper. This
# is the missing dual of _wh_warp_rm_tab_config. The wrapper has no single quotes
# (TOML literal strings cannot contain one), so a literal string is injection-safe.
_wh_warp_write_tab_config() {
  local toml="$1" marker="$2" cwd="$3" wrapper="$4"
  mkdir -p "$(dirname "$toml")" 2>/dev/null || return 1
  {
    printf '# aigentry warp tab_config — generated by _wh_warp_open (#608 Phase 2, ADR §5 D5)\n'
    printf "name = '%s'\n\n" "$marker"
    printf '[[tabs]]\n'
    printf "title = '%s'\n" "$marker"
    printf "cwd = '%s'\n" "$cwd"
    printf "command = '%s'\n" "$wrapper"
  } > "$toml" 2>/dev/null || return 1
  return 0
}

# _wh_warp_deeplink_open <config_name> — open the surface via the `warp://`
# deeplink (ADR §5 D5 step 3 — the call site G5 says is missing). macOS open(1)
# / Linux xdg-open. Non-zero when no opener is available.
_wh_warp_deeplink_open() {
  local name="$1" opener
  case "$(uname -s)" in
    Darwin) opener="open" ;;
    Linux)  opener="xdg-open" ;;
    *)      return 1 ;;
  esac
  command -v "$opener" >/dev/null 2>&1 || return 1
  "$opener" "warp://tab_config/$name" >/dev/null 2>&1
}

# _wh_warp_read_screen <marker> — bounded AX read of the Warp window's visible
# text for <marker> (BC1 V2 — the surface-attested analogue of cmux read-screen;
# Warp has no read-screen CLI). Prints whatever AX yields; non-zero if the window
# is absent / AX denied. macOS+osascript only (caller gates via can_uiscript).
# marker via argv → injection-safe.
_wh_warp_read_screen() {
  local marker="$1"
  osascript - "$marker" 2>/dev/null <<'OSA'
on run argv
  set marker to item 1 of argv
  tell application "System Events"
    set procs to (every process whose name is "Warp" or name is "stable")
    repeat with p in procs
      try
        repeat with w in (windows of p)
          if (name of w as string) contains marker then
            return (name of w as string)
          end if
        end repeat
      end try
    end repeat
  end tell
  error "window not found"
end run
OSA
}

# _wh_warp_wait_ready <sid> <marker> — the warp ready-gate (BC1 V2). Polls up to
# WARP_READY_TIMEOUT_MS for the process floor (Warp-app-alive AND sentinel present);
# when AX is usable it ALSO tries to surface-attest via an AX read-screen. Prints
# the attestation LEVEL achieved on stdout and signals via exit code:
#   "surface" rc0 — AX read-screen returned content (V2 strong, == cmux semantics).
#   "process" rc0 — the surface DID spawn (Warp-alive + sentinel) but could not be
#                   surface-attested in time (no AX, AX denied, or slow render).
#                   DEGRADED success — spawn worked; ready-attestation is the bounded
#                   asymmetry (BC6), NOT a failure. Caller declares it loudly.
#   ""        rc1 — the process floor was NEVER met → the surface never spawned →
#                   genuine timeout (caller GCs + returns non-zero, no handle).
# REJECTS V1 (no `telepty allow --on-ready` hook): the sentinel is written by the
# in-surface wrapper's own `touch`, and surface readiness is proven by reading the
# Warp window (AX), never by a transport/process callback — Warp's `warp://` is an
# async launchd handoff with no surface-ready IPC (BC1).
_wh_warp_wait_ready() {
  local sid="$1" marker="$2"
  local sentinel="$AIGENTRY_WARP_SURFACE_DIR/$sid.live"
  local timeout_ms="${WARP_READY_TIMEOUT_MS:-10000}"
  local interval_ms="${WARP_READY_INTERVAL_MS:-200}"
  local interval_s; interval_s=$(awk -v ms="$interval_ms" 'BEGIN{printf "%.3f", ms/1000}')
  local max_iters=$(( timeout_ms / interval_ms )); [ "$max_iters" -lt 1 ] && max_iters=1
  local ax=0; _wh_warp_can_uiscript && ax=1
  local i=0 proc_seen=0 rs
  while [ "$i" -lt "$max_iters" ]; do
    if _wh_warp_app_running && [ -f "$sentinel" ]; then
      proc_seen=1
      if [ "$ax" = "1" ]; then
        rs=$(_wh_warp_read_screen "$marker" || true)
        [ -n "$(printf '%s' "$rs" | tr -d '[:space:]')" ] && { printf 'surface'; return 0; }
        # AX present but no readable surface yet (rendering… or AX denied) → keep polling
        # for the stronger signal; degrade to process-attested only after the timeout.
      else
        printf 'process'; return 0  # no AX capability → process floor is the ceiling
      fi
    fi
    i=$((i+1))
    sleep "$interval_s"
  done
  # Timed out: if the surface ever spawned (process floor met) but stayed
  # un-surface-attested (AX denied / slow render), that is DEGRADED success (BC6),
  # not a failure — spawn worked. Only a never-spawned surface is a real timeout.
  [ "$proc_seen" = "1" ] && { printf 'process'; return 0; }
  return 1
}

# _wh_warp_open <sid> <cwd> <cli_cmd> — spawn a VISIBLE Warp surface wrapping
# `telepty allow --id <sid>`, BLOCK until the ready-gate passes, then emit the
# marker "telepty::<sid>" as the host_id (ADR §3 D1 contract; the handle every
# other warp verb already consumes). Tier 2 (fire-and-forget spawn — BC3): Warp
# has no CLI to drive the surface, so spawn is a deeplink handoff + a sentinel
# written by the in-surface wrapper.
# Exit contract (handle emitted ⇒ surface ready; no half-spawned surface on fail):
#   0  → marker printed on stdout (surface ready; DEGRADED line on stderr if AX absent).
#   2  → spawn could not be issued (no tab_config path / deeplink open failed);
#        tab_config + sentinel GC'd, no handle.
#   3  → ready-gate timed out; tab_config + sentinel GC'd, NO marker emitted.
_wh_warp_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  local marker="telepty::$sid"
  local sentinel="$AIGENTRY_WARP_SURFACE_DIR/$sid.live"
  local tcdir toml
  tcdir=$(_wh_warp_tab_config_dir) || {
    echo "[workspace-host] warp wh_open: UNSUPPORTED — no Warp tab_config path on $(uname -s)" >&2
    return 2
  }
  toml="$tcdir/telepty-$sid.toml"
  mkdir -p "$AIGENTRY_WARP_SURFACE_DIR" 2>/dev/null || true

  # In-surface wrapper (ADR §5 D5 step 2): cd, write the sentinel (G6 fix — gives
  # alive/list_ids the writer they lacked), then exec telepty allow. NO `--on-ready`
  # (BC1: no V1 code path ships — readiness is proven by the ready-gate, not a hook).
  local wrapper="cd $cwd && touch $sentinel && exec telepty allow --id $sid --auto-restart $cli_cmd"

  if ! _wh_warp_write_tab_config "$toml" "$marker" "$cwd" "$wrapper"; then
    echo "[workspace-host] warp wh_open: failed to write tab_config $toml" >&2
    return 2
  fi

  # Spawn (G5 fix): the `warp://tab_config/` deeplink — the call site that was a comment.
  if ! _wh_warp_deeplink_open "telepty-$sid"; then
    echo "[workspace-host] warp wh_open: deeplink open failed (no open/xdg-open) — no surface spawned" >&2
    rm -f "$toml" "$sentinel" 2>/dev/null || true
    return 2
  fi

  # Ready-gate (BC1 V2). att = attestation level achieved; rc!=0 ⇒ the surface
  # never spawned → leave no half-spawned surface (GC TOML+sentinel).
  local att; att=$(_wh_warp_wait_ready "$sid" "$marker"); local grc=$?
  if [ "$grc" -ne 0 ]; then
    echo "[workspace-host] warp wh_open: ready-gate timed out after ${WARP_READY_TIMEOUT_MS:-10000}ms — surface never spawned (no Warp-alive+sentinel); GCing tab_config+sentinel, no handle emitted." >&2
    rm -f "$toml" "$sentinel" 2>/dev/null || true
    return 3
  fi

  # BC1/BC6: the surface spawned but readiness is only process-attested (AX absent
  # or denied) — declare it LOUDLY so the orchestrator does NOT route
  # guaranteed-visible-foreground work to this degraded surface (no silent no-op, §13).
  if [ "$att" != "surface" ]; then
    echo "[workspace-host] warp wh_open: DEGRADED ready-gate ($att-attested) — surface readiness could not be AX-attested (osascript/AX unavailable or denied); readiness rests on sentinel+Warp-alive, NOT a surface read. Do not route guaranteed-visible-foreground work here (BC1/BC6)." >&2
  fi

  printf '%s\n' "$marker"
}

# -----------------------------------------------------------------------------
# legacy terminal spawn adapters — aterm / tmux / wezterm / iterm (#608 Phase 3).
# Each _wh_<term>_open is the inline open-session.sh:open_in_terminal() spawn branch
# moved 1:1 (byte-equivalent — current behavior preserved, Rule 29). These are
# SPAWN-only adapters: the orchestrator runs inside cmux, so lifecycle verbs
# (lookup/close/alive/...) keep routing through the cmux adapter — only `open`
# dispatches to the host the user is actually in. They consume platform.sh
# primitives (platform::spawn_*), sourced by the caller (open-session.sh) and by
# the Tier-1 contract tests; cmux/warp/headless paths never touch them.
#
# BC3 tier classification (declared per the §12 BC3 gate; mirrored in the contract
# tests): Tier 1 = full-lifecycle-IPC host (queryable/ready-gateable surface) —
# cmux, tmux, wezterm, iterm. Tier 2 = fire-and-forget spawn (no surface-ready
# proof) — aterm, warp, headless (the ghostty/generic daemon fold). The 1:1 move
# adds NO ready-gate to tmux/wezterm/iterm (none existed in the legacy branches),
# so their ready_attestation is honestly `none` (BC2 / §13) — the Tier-1 label is
# the capability ceiling (these hosts CAN be ready-gated), not a claim of one today.

# _wh_fallback_spawn <sid> <cwd> <cli_cmd> — shared spawn fallback when a preferred
# terminal CLI is unavailable (moved 1:1 from open-session.sh:fallback_spawn).
# tmux window if inside a tmux session, else a daemon PTY with attach instructions.
# Goes through platform.sh (Rule 26) so a Windows backend can satisfy the tmux
# branch natively. Caller must have sourced platform.sh (open-session.sh does).
_wh_fallback_spawn() {
  local _sid="$1" _cwd="$2" _cli_cmd="$3"
  if command -v tmux >/dev/null 2>&1 && platform::has_tmux_session; then
    platform::spawn_tmux_window "$_sid" "$_cwd" "telepty allow --id '$_sid' --auto-restart $_cli_cmd"
    echo "$_sid"
  else
    telepty spawn --id "$_sid" -- bash -c "cd '$_cwd' && exec $_cli_cmd" >/dev/null
    echo "⚠️  Session spawned as daemon (no visible terminal). Attach: telepty attach $_sid" >&2
    echo "$_sid"
  fi
}

# _wh_aterm_open <sid> <cwd> <cli_cmd> — aterm new-session, else fallback (Tier 2).
# bash -c wrapper for cwd propagation into claude (#311).
_wh_aterm_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  if command -v aterm >/dev/null 2>&1 \
    && aterm new-session --cwd "$cwd" --cmd "bash -c 'cd $cwd && exec telepty allow --id $sid --auto-restart $cli_cmd'" 2>/dev/null; then
    echo "$sid"
  else
    _wh_fallback_spawn "$sid" "$cwd" "$cli_cmd"
  fi
}

# _wh_tmux_open <sid> <cwd> <cli_cmd> — tmux new-window via platform:: (Tier 1).
# `tmux new-window -c` propagates cwd correctly. (Legacy used $title == $sid.)
_wh_tmux_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  platform::spawn_tmux_window "$sid" "$cwd" "telepty allow --id '$sid' --auto-restart $cli_cmd"
  echo "$sid"
}

# _wh_wezterm_open <sid> <cwd> <cli_cmd> — wezterm cli spawn, else fallback (Tier 1).
# Explicit cd inside bash -c guarantees cwd propagation into claude (#311).
_wh_wezterm_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  if command -v wezterm >/dev/null 2>&1; then
    wezterm cli spawn --cwd "$cwd" -- bash -c "cd '$cwd' && exec telepty allow --id $sid --auto-restart $cli_cmd" >/dev/null
    echo "$sid"
  else
    _wh_fallback_spawn "$sid" "$cwd" "$cli_cmd"
  fi
}

# _wh_iterm_open <sid> <cwd> <cli_cmd> — iTerm tab via platform:: AppleScript (Tier 1).
# Legacy contract: spawn failure → exit 2 (here: return 2, no handle).
_wh_iterm_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  platform::spawn_iterm_tab "$cwd" "telepty allow --id $sid --auto-restart $cli_cmd" \
    || { echo "ERR iTerm spawn failed" >&2; return 2; }
  echo "$sid"
}

# ready_attestation declarations (BC2): the byte-equivalent moves carry no ready-gate
# → none. A declared FIELD per adapter, not a 10th verb (9-verb boundary invariant).
_wh_aterm_ready_attestation()   { printf 'none'; }
_wh_tmux_ready_attestation()    { printf 'none'; }
_wh_wezterm_ready_attestation() { printf 'none'; }
_wh_iterm_ready_attestation()   { printf 'none'; }

# -----------------------------------------------------------------------------
# headless adapter (no-op — for CI/docker/windows-terminal/zellij stubs)
# -----------------------------------------------------------------------------
# _wh_headless_open <sid> <cwd> <cli_cmd> — daemon-PTY spawn with attach instructions
# (Tier 2; moved 1:1 from open-session.sh's `ghostty|generic|*` branch — the generic
# fallback, ADR §7 Phase 3 "generic→headless adapter"). No visible UI surface.
_wh_headless_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  telepty spawn --id "$sid" -- bash -c "cd '$cwd' && exec $cli_cmd" >/dev/null
  echo "⚠️  Session spawned as daemon (headless: no spawn-tab CLI)." >&2
  echo "    Attach via: telepty attach $sid" >&2
  echo "$sid"
}
_wh_headless_ready_attestation() { printf 'none'; }
_wh_headless_lookup()        { echo ""; }
_wh_headless_close()         { return 0; }
_wh_headless_alive()         { return 1; }
_wh_headless_list_ids()      { :; }
_wh_headless_focus()         { return 0; }
_wh_headless_prune_orphans() { echo 0; return 0; }
_wh_headless_set_status()    { return 0; }
_wh_headless_clear_status()  { return 0; }

# -----------------------------------------------------------------------------
# D2 — single terminal adapter registry (ADR §D2, #608 Phase 3). Collapses the two
# formerly-disjoint vocabularies — open-session.sh:detect_terminal() and _wh_adapter()
# (G4) — into ONE ordered data table. Each row: NAME<TAB>AUTO_DETECTABLE<TAB>TIER.
#   AUTO_DETECTABLE — may _wh_adapter pick it WITHOUT an explicit env-force? Only
#     cmux + headless (the orchestrator's spawn/lifecycle host & its fallback). warp
#     has no desktop CLI (design 2026-05-29) and aterm/tmux/wezterm/iterm are
#     reached only via detect_terminal→env-force, so all four are auto_detectable=no
#     — _wh_adapter's lifecycle selection stays cmux-or-headless (T25 §4 invariant).
#   TIER (BC3) — 1 = full-lifecycle-IPC host (cmux,tmux,wezterm,iterm);
#     2 = fire-and-forget spawn (aterm,warp,headless[=ghostty/generic fold]).
# Order = detection precedence — detect_terminal returns the FIRST row whose detect
# predicate matches; headless is the always-matching catch-all terminator. The detect
# predicate is shell (env / TERM_PROGRAM / PATH) so it cannot be a table cell — it is
# keyed by NAME in _wh_detect_match — but there is ONE list, ONE vocabulary (G4 gone).
_wh_registry() {
  cat <<'EOF'
cmux	yes	1
aterm	no	2
tmux	no	1
wezterm	no	1
iterm	no	1
warp	no	2
headless	yes	2
EOF
}

# _wh_detect_match <name> — "am I running INSIDE this terminal" (context probe, used
# by detect_terminal; byte-identical to the legacy open-session.sh:detect_terminal
# env/TERM_PROGRAM checks). cmux here is CMUX_WORKSPACE_ID (the in-pane env), NOT a
# PATH probe — _wh_adapter uses the separate host-availability probe below, so this
# stays a faithful "which terminal am I in" check.
_wh_detect_match() {
  case "$1" in
    cmux)     [ -n "${CMUX_WORKSPACE_ID:-}" ] ;;
    aterm)    [ -n "${ATERM_IPC_SOCKET:-}" ] ;;
    tmux)     [ -n "${TMUX:-}" ] ;;
    wezterm)  [ "${TERM_PROGRAM:-}" = "WezTerm" ] ;;
    iterm)    [ "${TERM_PROGRAM:-}" = "iTerm.app" ] ;;
    warp)     return 1 ;;     # no desktop CLI → never auto-detected (env-force only)
    headless) return 0 ;;     # always matches — folds the ghostty/generic fallback
    *)        return 1 ;;
  esac
}

# _wh_host_available <name> — "can I SPAWN into this host right now" (availability
# probe, used by _wh_adapter for auto_detectable rows). Distinct from the context
# probe above: cmux availability is the binary on PATH (what the legacy _wh_adapter
# checked, T25 §4); headless is always available (daemon-PTY fallback). The generic
# arm is future-proofing — no current auto_detectable adapter reaches it.
_wh_host_available() {
  case "$1" in
    cmux)     command -v cmux >/dev/null 2>&1 ;;
    headless) return 0 ;;
    *)        command -v "$1" >/dev/null 2>&1 ;;
  esac
}

# _wh_is_registered <name> — 0 if <name> is a registry adapter (env-force validation).
_wh_is_registered() {
  local want="$1" name rest
  while IFS=$'\t' read -r name rest; do
    [ "$name" = "$want" ] && return 0
  done <<EOF
$(_wh_registry)
EOF
  return 1
}

# detect_terminal — the host terminal the caller is running inside, as a registry
# adapter NAME (ADR §D2; moved here from open-session.sh, #608 Phase 3 — both
# detect_terminal and _wh_adapter now derive from the single _wh_registry, so G4's
# two disjoint vocabularies are unrepresentable). "First adapter whose detect
# predicate matches"; headless is the catch-all (the legacy ghostty/generic daemon
# branch). open-session.sh sources this lib, so it still calls detect_terminal.
detect_terminal() {
  local name auto tier
  while IFS=$'\t' read -r name auto tier; do
    [ -z "$name" ] && continue
    if _wh_detect_match "$name"; then printf '%s\n' "$name"; return 0; fi
  done <<EOF
$(_wh_registry)
EOF
  printf '%s\n' "headless"
}

# -----------------------------------------------------------------------------
# dispatcher — selects adapter then forwards
# -----------------------------------------------------------------------------
# _wh_adapter — adapter selection for the lifecycle verbs (ADR §D2): an explicit
# AIGENTRY_WORKSPACE_HOST env-force (any REGISTERED adapter) wins; else the first
# auto_detectable adapter that is an available host; else headless. Shares the single
# registry with detect_terminal (G4 resolved). Only cmux + headless are
# auto_detectable, so auto-selection stays "cmux if on PATH, else headless" exactly
# as before (T25 §4) — terminal SPAWN routing comes from detect_terminal→env-force in
# open-session.sh, never from auto-detect here.
_wh_adapter() {
  local pref="${AIGENTRY_WORKSPACE_HOST:-}"
  if [ -n "$pref" ] && _wh_is_registered "$pref"; then
    printf '%s' "$pref"; return 0
  fi
  local name auto tier
  while IFS=$'\t' read -r name auto tier; do
    [ -z "$name" ] && continue
    [ "$auto" = "yes" ] || continue
    if _wh_host_available "$name"; then printf '%s' "$name"; return 0; fi
  done <<EOF
$(_wh_registry)
EOF
  printf '%s' "headless"
}

# wh_open <sid> <cwd> <cli_cmd> — spawn a visible surface wrapping
# `telepty allow --id <sid>`, block until the per-adapter ready-gate passes (an
# internal obligation — NOT a public verb, BC2/D3), then print the stable host_id.
# Exit 0 only when the surface can accept input; non-zero ⇒ no handle emitted.
# BC4 (observability): logs the selected adapter so a rollback can be traced.
# Migrated adapters: cmux (Phase 1), warp (Phase 2), aterm/tmux/wezterm/iterm/headless
# (Phase 3). An adapter with no `_wh_<name>_open` fails LOUDLY with a labelled
# UNSUPPORTED line rather than a raw "command not found" or a silent no-op (§2
# explicit-error policy — never a silent surface failure).
wh_open() {
  local adapter; adapter=$(_wh_adapter)
  _wh_log "open: adapter=$adapter sid=${1:-}"
  if ! declare -F "_wh_${adapter}_open" >/dev/null 2>&1; then
    _wh_log "$adapter wh_open: UNSUPPORTED — no _wh_${adapter}_open spawn adapter registered (#608: cmux/warp/aterm/tmux/wezterm/iterm/headless migrated)"
    return 64
  fi
  "_wh_${adapter}_open" "$@"
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
