#!/usr/bin/env bash
# workspace-host.sh — Workspace Host adapter seam (ADR 2026-05-20 §Consequences).
#
# Source via:
#   source "$SCRIPT_DIR/lib/workspace-host.sh"
#
# Adapter selection (env override → per-sid record → auto-detect):
#   AIGENTRY_WORKSPACE_HOST=cmux     # force cmux
#   AIGENTRY_WORKSPACE_HOST=warp     # force warp (Warp shows, tmux controls — task 1304 D3;
#                                    #   lifecycle auto rule never picks it, the record does)
#   AIGENTRY_WORKSPACE_HOST=headless # no-op (CI / docker / windows-terminal fallback)
#   (unset)                          # the adapter recorded by wh_open for that sid/handle
#                                    #   (${AIGENTRY_WH_STATE_DIR:-~/.aigentry/workspace-host});
#                                    #   with no record: cmux if `cmux` on PATH, else headless,
#                                    #   plus one stderr line saying the adapter is unknown
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
#   wh_set_status <host_id> <state>     # state ∈ {working,idle,disconnected,connected,unknown}
#       Push session state to the host sidebar pill (SPEC §B). Exit: 0 (always).
#
#   wh_clear_status <host_id>
#       Remove the aigentry status pill. Idempotent. Exit: 0 (always).
#
# Screen read (task 1304 ADR D4 — reopens the verb boundary on purpose: dispatch
# readiness consumes it outside wh_open):
#
#   wh_read_screen <host_id|sid>
#       Print the CURRENT viewport text of the surface (no scrollback).
#       Exit: 0 text printed, 1 the read failed, 20 the adapter has no screen reader
#       (one labelled line `read_screen unsupported adapter=<name>` on stdout).
#
# Per-surface agent metadata (#1162 G2c, controller interface lock). Terminal-neutral
# verbs; cmux forwards to dist/src/session/agent-metadata.js, every other adapter is
# an explicit `unsupported` (20), never 127 and never a claimed compatibility:
#
#   wh_agent_meta_caps
#   wh_agent_meta_set <sid> --stage <abs_staging_root> --status-json <json>
#   wh_agent_meta_clear <sid> --stage <abs_staging_root>
#       [--expect-attempt <uuid> --expect-hash <hex64> --expect-surface <uuid>
#        --expect-lifecycle <uuid>]   optional exact pin, all four or none; a
#       sealed binding that no longer matches it is 10 (binding-drift), no RPC.
#       Exit: 0 applied/cleared/absent (caps: supported), 10 ownership/lifecycle
#       refusal, 20 unsupported host/capability/binding, 30 parse/transport/invalid.
#       Callers log non-zero and never gate a spawn on it.
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

# _wh_fail_category <text> — map a host tool's failure output to ONE generated
# token from a CLOSED vocabulary. #1162: a diagnostic must never carry an excerpt
# of host output (arbitrary terminal text: pane content, credentials, control
# sequences), but "why the close did not happen" is still what an operator needs.
# So the text is read here and never reproduced; unrecognised shapes are generic.
_wh_fail_category() {
  local t
  t=$(printf '%s' "${1-}" | LC_ALL=C tr '[:upper:]' '[:lower:]' | LC_ALL=C tr -d '\000-\037\177')
  case "$t" in
    "") printf 'no-output' ;;
    *"connection refused"*|*"failed to connect"*|*"connection reset"*|*"broken pipe"*|*daemon*|*"no such file or directory"*)
        printf 'host-unreachable' ;;
    *"timed out"*|*timeout*) printf 'host-timeout' ;;
    *refused*|*veto*|*busy*|*denied*|*"not permitted"*|*unsaved*) printf 'close-refused' ;;
    *) printf 'unknown-failure' ;;
  esac
}

# _wh_foreign_env_scrub <host> — task 1304 rounds 3–4 (incident 2026-11-23): the prefix
# every NON-cmux spawn puts in front of its worker command, so a worker hosted somewhere
# else never carries the controller's terminal identity. Measured: a worker in a tmux
# session inherited the tmux SERVER's environment, captured when the server was first
# started from the cmux controller's shell — first the cmux workspace/surface ids
# (telepty then attributed the worker to the controller's workspace and cleanup closed
# it), and, after round 3, still 39 other CMUX_* names (panel/tab ids, socket paths,
# agent-launch data, wrapper-shim paths, a token-file path).
#
# The prefix is `/bin/sh -c '<script>' sh <worker command…>`, run INSIDE the pane/worker
# command, so a stale tmux server environment cannot bring anything back. The script:
#   - unsets EVERY variable whose name starts with CMUX_. Names come from `env | sed`;
#     values are never printed, logged or kept;
#   - unsets TELEPTY_SESSION_ID (the controller's own session id);
#   - unsets ATERM_IPC_SOCKET unless aterm hosts the worker, and TMUX / TMUX_PANE
#     unless tmux does (a worker legitimately inside tmux keeps them: tmux sets them
#     for its own pane);
#   - keeps TERM_PROGRAM / TERM_PROGRAM_VERSION ONLY when TERM_PROGRAM is the host's own
#     value (tmux → "tmux", WezTerm → "WezTerm", iTerm → "iTerm.app"; measured on the Mac:
#     a tmux-hosted worker sees "tmux", which tmux sets for every pane). Anything else
#     — an older tmux that sets nothing, a value inherited from the controller — is
#     removed. With no visible host (headless, daemon fallback, aterm) both go;
#   - then `exec "$@"`, so the worker command runs exactly as before.
# POSIX sh, `env`, `sed` only (bash 3.2, macOS and Linux userland; no GNU-only flag).
# The script holds no single quote, so the prefix is one literal shell text that every
# spawn site embeds unchanged (#926's quoting rules are untouched). cmux spawns do not
# use it.
_wh_foreign_env_scrub() {
  local host="${1:-none}" drop="TELEPTY_SESSION_ID" own=""
  [ "$host" = "aterm" ] || drop="$drop ATERM_IPC_SOCKET"
  [ "$host" = "tmux" ] || drop="$drop TMUX TMUX_PANE"
  case "$host" in tmux) own="tmux" ;; wezterm) own="WezTerm" ;; iterm) own="iTerm.app" ;; esac
  printf '%s' "/bin/sh -c 'for v in \$(env | sed -n \"s/^\\(CMUX_[A-Za-z0-9_]*\\)=.*/\\1/p\"); do unset \"\$v\"; done; unset $drop; [ \"\${TERM_PROGRAM:-}\" = \"$own\" ] && [ -n \"$own\" ] || unset TERM_PROGRAM TERM_PROGRAM_VERSION; exec \"\$@\"' sh"
}

# _wh_refuse_own_surface <adapter> <host_id> — task 1304 round 3: 0, plus ONE labelled
# line, when <host_id> is the surface THIS process runs in, so the caller must not close
# it (the close verbs then answer 4 and close nothing). "Own" is knowable for:
#   cmux — the caller's CMUX_WORKSPACE_ID (a UUID; compared case-insensitively). A
#          `workspace:N` ref cannot be compared with it, so a ref is never refused here.
#   tmux — the window of the caller's TMUX_PANE.
#   warp — the warp tmux session the caller's TMUX_PANE is in.
# 1 means "not this process's surface, or not knowable": the close proceeds as before.
_wh_refuse_own_surface() {
  local adapter="$1" handle="${2:-}" mine="" name
  [ -n "$handle" ] || return 1
  case "$adapter" in
    cmux)
      mine="${CMUX_WORKSPACE_ID:-}"
      [ -n "$mine" ] || return 1
      [ "$(printf '%s' "$handle" | LC_ALL=C tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$mine" | LC_ALL=C tr '[:upper:]' '[:lower:]')" ] || return 1 ;;
    tmux|warp)
      [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1 || return 1
      if [ "$adapter" = "tmux" ]; then
        mine=$(tmux display-message -p -t "$TMUX_PANE" '#{window_id}' 2>/dev/null) || return 1
      else
        name=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || return 1
        case "$name" in "$_WH_WARP_TMUX_PREFIX"?*) mine="telepty::$(_wh_warp_tmux_sid "$name")" ;; *) return 1 ;; esac
      fi
      [ -n "$mine" ] && [ "$handle" = "$mine" ] || return 1 ;;
    *) return 1 ;;
  esac
  _wh_log "close REFUSED: $handle is the surface this process runs in (adapter=$adapter) — nothing was closed (wh_close_refused=own-surface wh_close_category=close-refused)"
  return 0
}

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
  # task 1304 r3: telepty attributes a session to cmux from the markers in its
  # ENVIRONMENT, and a worker hosted in tmux could inherit the controller's (incident
  # 2026-11-23: backend=cmux, terminal=tmux, cmuxWorkspaceId = the controller's). When
  # the session's own evidence says another host — its layer record/tombstone names a
  # non-cmux adapter, or telepty itself reports terminal/termProgram tmux — that id is
  # NOT this session's workspace and is not returned. Only a workspace TITLED with this
  # sid (the #523 fallback, the title cmux opens are renamed to) may still be returned.
  local elsewhere=""
  if _wh_safe_sid "$sid" && { _wh_record_read "$(_wh_state_dir)/$sid.rec" \
       || _wh_record_read "$(_wh_state_dir)/$sid.closed"; } && [ "$_WH_REC_ADAPTER" != "cmux" ]; then
    elsewhere="record adapter=$_WH_REC_ADAPTER"
  elif [ "$(echo "$info" | jq -r 'if (.terminal == "tmux" or .termProgram == "tmux") then "tmux" else empty end' 2>/dev/null)" = "tmux" ]; then
    elsewhere="telepty terminal=tmux"
  fi
  if [ -n "$elsewhere" ]; then
    _wh_log "cmux lookup: $sid is hosted outside cmux ($elsewhere) — its telepty cmuxWorkspaceId is not used; only a workspace titled $sid may be returned"
    _wh_cmux_list_titles | awk -F'\t' -v s="$sid" '$2==s {print $1; exit}'
    return 0
  fi
  echo "$info" | jq -r '.cmuxWorkspaceId // empty' 2>/dev/null || true
}

_wh_cmux_close() {
  local host_id="$1" out fcat
  [ -z "$host_id" ] && return 0
  _wh_refuse_own_surface cmux "$host_id" && return 4 # task 1304 r3: never the caller's own workspace
  if ! command -v cmux >/dev/null 2>&1; then
    return 0 # cmux not installed — treat as already-gone (no-op)
  fi
  # #1162: the attempt's own output is captured to CLASSIFY it, never to republish
  # it. Still exactly one close call and one re-probe.
  if out=$(cmux close-workspace --workspace "$host_id" 2>&1); then
    return 0
  fi
  # Re-probe: "close failed" often means "already closed" — confirm via alive.
  if ! _wh_cmux_alive "$host_id"; then
    return 0
  fi
  fcat=$(_wh_fail_category "$out")
  # #1162: the alive re-probe is an ACTUATION GUARD ("may I treat this as gone?"),
  # not an observation of what the failed close did. A conservative PRESENT and an
  # unanswerable probe are equally silent about whether anything was released —
  # a close can fail partway — so neither licenses "nothing was released". One
  # verdict: the close failed and the surface was not proven gone, therefore the
  # release is UNCONFIRMED. The category is a generated hint about the FAILURE,
  # never evidence of host state.
  _wh_log "close-workspace failed for $host_id and the surface was not proven gone — release UNCONFIRMED: neither release nor retention was observed (wh_close_status=unconfirmed wh_close_category=$fcat)"
  return 1
}

_wh_cmux_alive() {
  # F9: liveness via `sidebar-state` (the only per-handle probe). The handle may be
  # a UUID (cmuxWorkspaceId from telepty) or a ref (workspace:N); cmux accepts
  # <id|ref|index>. The gone-answer is an "Error:" line, not an exit code (F7).
  #
  # #835, two corrections that only make sense together:
  #
  # (a) That "Error:" line goes to STDERR, not stdout — verified against cmux
  #     0.64.20, which answers a missing handle with `Error: ERROR: Tab not found`
  #     on fd 2 and an EMPTY stdout. The probe discarded stderr, so it never
  #     matched the arm written for it; what actually detected a gone surface was
  #     the empty-stdout fallback. Only the stub fixtures ever took the Error path,
  #     because they print it on stdout. Both streams are read now, and the match
  #     is line-anchored so a workspace whose own state text contains "Error:"
  #     cannot be mistaken for the answer.
  #
  # (b) Silence is not an answer. Relying on the empty-stdout fallback meant a cmux
  #     that crashed, hung, or was off PATH manufactured a "gone" verdict for every
  #     session it was asked about. That verdict cannot authorize a teardown on its
  #     own — policy.py refuses surface_gone as a single signal (INV-17) and still
  #     requires a pid or aged-disconnect signal — but it is a fabricated entry in
  #     a corroboration set, it lands in the sweep's reasons string and its
  #     telemetry as though it had been observed, and it pulls a session that would
  #     otherwise have been skipped outright into the policy path. The warp adapter
  #     already gets this right — _wh_warp_alive maps "cannot probe" and "Warp is
  #     down" to INDETERMINATE→alive (#486). cmux now matches: only a real answer
  #     says gone.
  #
  # #1162, (c): "an Error: line somewhere in the capture" was still not an ANSWER.
  #     cmux reports a refused daemon socket in the same `Error:` shape, and a
  #     successful multiline state reply can carry the missing-handle text as one
  #     of its lines; both were read as absence, and _wh_cmux_close turned that
  #     into a successful close of a surface still on screen. So the answer must
  #     BE the reply: a FAILED probe whose entire output is exactly the measured
  #     text `Error: ERROR: Tab not found` (cmux 0.64.20). Everything else —
  #     transport refusal, timeout, silence, malformed, mixed or conflicting
  #     output, an unknown message from a future cmux — is a probe without an
  #     answer and stays INDETERMINATE→alive. That is the fail-safe direction:
  #     claiming PRESENT costs a non-zero close the operator can see, claiming
  #     GONE loses the workspace silently. That makes this boolean an ACTUATION
  #     GUARD, not an observation: PRESENT only ever means "do not treat as
  #     gone", so no caller may restate it as evidence about what a close did or
  #     did not release. (_WH_CMUX_PROBE_KIND still records which of the three
  #     the probe was; it has no consumer now that the close verdict has stopped
  #     branching on it.)
  local host_id="$1" out rc=0
  _WH_CMUX_PROBE_KIND=indeterminate
  [ -z "$host_id" ] && return 1
  if ! command -v cmux >/dev/null 2>&1; then
    return 0 # cannot probe → INDETERMINATE→alive (INV-17), never a close signal
  fi
  out=$(cmux sidebar-state --workspace "$host_id" 2>&1) || rc=$?
  # $(...) already stripped the trailing newline. A trailing CR is NOT accepted: a
  # CRLF-framed reply has never been measured against cmux, so it stays
  # indeterminate rather than becoming a new compatibility claim.
  if [ "$rc" -ne 0 ] && [ "$out" = "Error: ERROR: Tab not found" ]; then
    _WH_CMUX_PROBE_KIND=gone
    return 1                  # cmux answered: no such workspace → genuinely gone
  fi
  if [ "$rc" -ne 0 ]; then
    _wh_log "sidebar-state failed for $host_id (rc=$rc) — not cmux's missing-handle answer, so the probe is INDETERMINATE and the surface stays PRESENT (wh_probe_category=$(_wh_fail_category "$out"))"
    return 0
  fi
  if [ -n "$out" ]; then
    _WH_CMUX_PROBE_KIND=present
    return 0                  # cmux answered with state → alive
  fi
  _wh_log "sidebar-state said nothing for $host_id (rc=$rc) — treating the surface as PRESENT; an unanswered probe is not evidence that a surface is gone"
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
    # #1162: telepty CONNECTED is transport only — never idle, never working.
    connected)    icon="link";          color="#8e8e93" ;;
    # #1162 r3: legacy connection health unknown — neutral, replaces any stale
    # working/idle pill; never implies activity or completion.
    unknown)      icon=questionmark;    color="#8e8e93" ;;
    *) return 0 ;; # unrecognized state — no-op (never emit a speculative pill)
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

# _wh_cmux_agent_meta <caps|set|clear> [args...] — #1162 G2c. The structured work
# (host JSON, sealed binding, status JSON) is Node's, so no jq/eval touches it here;
# argv is forwarded 1:1 and the exit code is returned verbatim (0/10/20/30). The
# compiled entrypoint is resolved by lib/node-shim.sh — the same two-layout (repo
# tree / control workspace) resolution every bin/ shim uses — in a subshell, because
# that helper exits on a miss. A missing implementation is `unsupported` (20).
_wh_cmux_agent_meta() {
  local js
  js=$(
    AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
    # shellcheck source=node-shim.sh
    . "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
    aigentry_node_shim workspace-host.sh dist/src/session/agent-metadata.js 2>/dev/null
    printf '%s' "$AIGENTRY_SHIM_JS"
  ) || js=""
  if [ -z "$js" ] || ! command -v node >/dev/null 2>&1; then
    _wh_log "agent-meta $1: UNSUPPORTED — agent-metadata implementation not resolvable (rc=20)"
    [ "$1" = "caps" ] && printf 'agent_meta caps=unsupported adapter=cmux reason=implementation-missing\n'
    return 20
  fi
  node "$js" "$@"
}
_wh_cmux_agent_meta_caps()  { _wh_cmux_agent_meta caps "$@"; }
_wh_cmux_agent_meta_set()   { _wh_cmux_agent_meta set "$@"; }
_wh_cmux_agent_meta_clear() { _wh_cmux_agent_meta clear "$@"; }

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

# _wh_cmux_read_screen <workspace-ref> — task 1304 D4: cmux's own current-viewport read.
# No --lines: cmux --lines implies scrollback (bin/current_screen.py). cmux's exit status
# is unreliable (it prints `Error:` with rc 0, see _wh_cmux_wait_ready), so an `Error:`
# answer is a failed read too. Dispatch readiness for a cmux session does NOT come here:
# bin/current_screen.py keeps its bound in-process reader for cmux, unchanged.
_wh_cmux_read_screen() {
  local host_id="$1" cmux_bin="${CMUX:-cmux}" out
  [ -z "$host_id" ] && return 1
  command -v "$cmux_bin" >/dev/null 2>&1 || { _wh_log "read_screen: cmux not installed — cannot read $host_id"; return 1; }
  out=$("$cmux_bin" read-screen --workspace "$host_id" 2>&1) || return 1
  case "$out" in Error:*) return 1 ;; esac
  printf '%s\n' "$out"
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

# _wh_cmux_focus_option_supported <cmux-bin> — does THIS cmux document the exact option
# `new-workspace --focus <true|false>`? Called ONLY when background creation was explicitly
# opted into (AIGENTRY_CMUX_BACKGROUND_SPAWN=1), so neither answer can affect a default
# launch: an ordinary install never reaches this function.
#
# Exit: 0 = documented. 1 = the probe answered and does not document it. 2 = the probe
# itself could not be read. The caller owns the operator-facing message, so this is quiet.
#
# Why this is not `cmux --help | grep -qE 'new-workspace.*--focus'`. That form accepts three
# wrong answers:
#   (a) a longer option that merely BEGINS with `--focus` (`--focus-follows-mouse`) matches,
#       so an unrelated flag reads as support;
#   (b) it needs `new-workspace` and `--focus` on the SAME line, so a help layout that puts
#       a command's options on continuation lines reads as "unsupported" when the option is
#       there;
#   (c) the match runs inside a pipeline under `set -o pipefail` (bin/wh-cli.sh:67), so a cmux
#       that prints usable help and exits non-zero — or cannot run at all — also comes out as
#       "unsupported", i.e. "upgrade cmux" for what is really a broken probe.
# Hence: capture the help with NO pipeline (so the status is the binary's own), decline to
# interpret a failed or empty probe, cut out the `new-workspace` BLOCK (its own line plus
# every more-indented continuation line — that covers (b)), and require inside that block an
# exact `--focus` TOKEN followed DIRECTLY by a boolean value PLACEHOLDER: `<…>`, `[…]` or
# `{…}` naming true/false/bool, `=` plus a boolean word, or a bare `true|false` alternation.
# A bare switch `--focus` with no value, or a `--no-focus` spelling, is deliberately NOT
# accepted: passing `--focus false` to such a cmux would leave `false` as a positional. The
# placeholder shape is what keeps description text out: `--focus  (bool) focus it` or
# `--focus  true to focus` describes a bare switch and is refused.
#
# Limits, stated: this reads cmux's self-description, and only its TOP-LEVEL `--help`.
#   * A cmux that lists the option only under `cmux new-workspace --help` is refused as
#     UNSUPPORTED although the option exists. The subcommand's help is deliberately not run:
#     on a cmux whose new-workspace does not treat `--help` as help, that call could itself
#     create a workspace — in front of the operator who opted out of exactly that.
#   * A help layout outside the shapes above may be refused; that costs the opted-in launch
#     only, never a default one.
#   * A cmux that documents the option and then ignores it cannot be caught before spawning
#     by any check; it would need an observed selection, which costs a workspace. The
#     opted-in operator is told as much in the docs.
_wh_cmux_focus_option_supported() {
  local bin="$1" help rc=0 block
  local focus_value_re='(^|[^A-Za-z0-9_-])--focus((=|[[:space:]]+)(<[^>]*(true|false|bool|BOOL|TRUE|FALSE)[^>]*>|[[][^]]*(true|false|bool|BOOL|TRUE|FALSE)[^]]*[]]|[{][^}]*(true|false|bool|BOOL|TRUE|FALSE)[^}]*[}]|(true|false|TRUE|FALSE)[|](true|false|TRUE|FALSE))|=(true|false|bool|BOOL|TRUE|FALSE))'
  help=$("$bin" --help 2>&1) || rc=$?
  [ "$rc" -ne 0 ] && return 2
  [ -z "$(printf '%s' "$help" | tr -d '[:space:]')" ] && return 2
  # Every `new-workspace`-anchored block, not just the first: a CLI may name the command once
  # in a command list and again in a per-command options section.
  block=$(printf '%s\n' "$help" | awk '
    { ind = match($0, /[^ \t]/) }
    found && $0 ~ /^[ \t]*$/ { print; next }
    found && ind > indent     { print; next }
    { found = 0 }
    $0 ~ /(^|[^A-Za-z0-9_-])new-workspace([^A-Za-z0-9_-]|$)/ { found = 1; indent = ind; print; next }
  ')
  [ -z "$block" ] && return 1
  printf '%s\n' "$block" \
    | grep -Eq -- "$focus_value_re" \
    || return 1
  return 0
}

# _wh_cmux_open <sid> <cwd> <cli_cmd> — spawn a visible cmux workspace wrapping
# `telepty allow --id <sid>`, BLOCK until the ready-gate passes, then emit the
# workspace ref (workspace:N) as the host_id (ADR §3 D1 contract). Moved byte-for-byte
# from open-session.sh:open_in_terminal()'s cmux branch (#608 Phase 1, ADR §7).
# Exit contract (handle emitted ⇒ pane ready; no half-spawned surface on failure):
#   0  → ref printed on stdout (surface can accept send-key).
#   2  → new-workspace produced no ref (spawn failed); or AIGENTRY_WORKER_AUTO_RESTART or
#        AIGENTRY_CMUX_BACKGROUND_SPAWN held a value other than 0/1; or background creation
#        was opted into and this cmux cannot be shown to support it. Nothing to clean up.
#   3  → ready-gate timed out; the workspace is closed, NO ref emitted.
# CMUX seam: injectable cmux binary so the readiness gate is hermetically testable
# (BUG-A); defaults to the real `cmux` in production.
#
# AIGENTRY_WORKER_AUTO_RESTART (per launch; default 1 = unchanged behaviour)
#   1 or unset → the child command keeps `telepty allow … --auto-restart`, so the bridge
#                restarts the wrapped CLI after it exits.
#   0          → the flag is omitted for THIS launch: one child launch, no automatic
#                restart after it exits. The workspace itself is unaffected.
#   anything else → refused with exit 2 BEFORE anything is spawned. An unreadable
#                   retry budget is never silently treated as the default.
#
#   SCOPE: this setting is read HERE and therefore applies to the cmux adapter ONLY,
#   despite its general name. Every other backend in this file keeps its existing launch
#   command, and those commands are NOT all alike — so "they all pass --auto-restart" would
#   be wrong: the tmux, aterm, wezterm and iTerm arms wrap the CLI in
#   `telepty allow … --auto-restart`, whereas _wh_headless_open and the no-tmux branch of
#   _wh_fallback_spawn exec the CLI under `telepty spawn --id … --` and never pass that flag
#   at all (for those two there is no flag here for this setting to remove). The opt-in
#   legacy rollback arm (src/session/open-session/legacy-spawn.ts, reached with
#   AIGENTRY_WH_LEGACY_SPAWN=1) carries a verbatim copy of the pre-seam cmux command line,
#   `--auto-restart` included. Setting this to 0 for any backend other than cmux has NO
#   effect and is not an error.
#
# AIGENTRY_CMUX_BACKGROUND_SPAWN (per launch; default 0 = unchanged behaviour)
#   0, or unset → EXACTLY what this adapter has always done, on every cmux version: the same
#                 `new-workspace --cwd … --command …` argv, no support probe, and no new way
#                 to fail. An ordinary install is untouched by this setting's existence.
#   1           → the worker workspace is created in the BACKGROUND (`--focus false`), so a
#                 spawn no longer moves the operator's selection. The workspace is still in
#                 the sidebar and its CLI is still the foreground process of its own surface.
#                 Because a cmux that does not know the flag may IGNORE it and take focus
#                 anyway (or fail), support is established FIRST
#                 (_wh_cmux_focus_option_supported) and a cmux that cannot be shown to
#                 support it is refused with exit 2 before anything is spawned. That refusal
#                 is reachable ONLY under this setting.
#   anything else → refused with exit 2 before anything is spawned.
#
#   SCOPE: read HERE, so it applies to the cmux adapter only. No other backend in this file
#   and no other adapter verb reads it, and neither does the opt-in legacy rollback arm
#   (src/session/open-session/legacy-spawn.ts, AIGENTRY_WH_LEGACY_SPAWN=1), which carries a
#   verbatim copy of the pre-seam command line. Setting it for a non-cmux backend has no
#   effect and is not an error.
_wh_cmux_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  # cmux --command sends text+Enter; telepty allow runs as the workspace's foreground process.
  # bash -c 'cd ... && exec ...' wrapper: cmux --cwd only affects workspace shell, not the
  # telepty-allow-wrapped CLI. Explicit cd inside wrapper guarantees claude inherits cwd (#311).
  # #926: cwd and sid go on ARGV and are read as "$1"/"$2" inside the single-quoted
  # script — never interpolated into it. They are ALSO %q-quoted, because --command is
  # TYPED INTO the workspace shell (text+Enter, above), so a bare append would still
  # word-split a cwd containing a space. cli_cmd stays unquoted deliberately: it is a
  # COMMAND LINE (`claude --model … --effort …`), not a value, and must word-split.
  local CMUX_BIN="${CMUX:-cmux}"
  local out ref q_cwd q_sid child restart_arg background=0 sup=0
  # Per-launch retry budget; 0 permits one child launch without automatic retries.
  # Refused before the spawn, so an invalid value never opens a workspace.
  case "${AIGENTRY_WORKER_AUTO_RESTART-1}" in
    1) restart_arg=' --auto-restart';;
    0) restart_arg='';;
    *) echo 'ERR AIGENTRY_WORKER_AUTO_RESTART must be 0 or 1' >&2; return 2;;
  esac
  # Background creation is OPT-IN. Resolved before any work, so an unreadable value cannot
  # half-open anything; 0/unset falls through to the original single call below.
  case "${AIGENTRY_CMUX_BACKGROUND_SPAWN-0}" in
    0) ;;
    1) background=1;;
    *) echo 'ERR AIGENTRY_CMUX_BACKGROUND_SPAWN must be 0 or 1' >&2; return 2;;
  esac
  printf -v q_cwd '%q' "$cwd"; printf -v q_sid '%q' "$sid"
  # One child command line, used by both arms, so the two argvs differ in nothing but the
  # opted-in `--focus false`. With AIGENTRY_WORKER_AUTO_RESTART unset or 1, $restart_arg is
  # ' --auto-restart' and this is byte-for-byte the string the single call used to build.
  child="bash -c 'cd \"\$1\" && exec telepty allow --id \"\$2\"$restart_arg $cli_cmd' _ $q_cwd $q_sid"
  if [ "$background" = 1 ]; then
    _wh_cmux_focus_option_supported "$CMUX_BIN" || sup=$?
    case "$sup" in
      0) ;;
      2) echo "ERR CMUX_FOCUS_PROBE_FAILED: '$CMUX_BIN --help' could not be read (it failed or printed nothing), so new-workspace --focus support is UNKNOWN, not absent. Refusing to spawn $sid in the background rather than guess — fix or unset AIGENTRY_CMUX_BACKGROUND_SPAWN for the default foreground launch." >&2; return 2;;
      *) echo "ERR CMUX_FOCUS_UNSUPPORTED: this cmux's top-level --help documents no 'new-workspace --focus <true|false>', and a cmux that does not know the option may ignore it (opening the workspace in front of you) or fail. Refusing to spawn $sid in the background (upgrade cmux if it predates the option, or unset AIGENTRY_CMUX_BACKGROUND_SPAWN for the default foreground launch)." >&2; return 2;;
    esac
    out=$("$CMUX_BIN" new-workspace --focus false --cwd "$cwd" --command "$child" 2>&1)
  else
    out=$("$CMUX_BIN" new-workspace --cwd "$cwd" --command "$child" 2>&1)
  fi
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
# warp adapter — Warp shows, tmux controls (task 1304 ADR D3)
# -----------------------------------------------------------------------------
# Warp exposes NO desktop CLI, AppleScript dictionary or IPC: its URI scheme can open a
# tab (warp://tab_config/<file stem>, in the active window) and nothing else. So a Warp
# worker runs inside its OWN tmux session and the Warp tab only attaches to it — the tab
# config's single command is `tmux new-session -A -s <name> -c <cwd> <worker wrapper>`,
# which creates the session and attaches in one step, with no typed input. tmux then gives
# every primitive Warp lacks, on macOS and Linux alike, without Accessibility permission:
#   - host_id   == the marker "telepty::<sid>" (also the tab title, used by focus only).
#   - tmux name == "aigentry-warp-<sid>" with '.' spelled %2E (tmux forbids '.' and ':'
#                  in session names; a recordable sid never contains ':' or '%', so the
#                  mapping is exactly reversible — _wh_warp_tmux_sid).
#   - ready     == the tmux session exists (tmux has-session).
#   - alive     == tmux has-session; a probe tmux cannot answer stays INDETERMINATE→alive
#                  (INV-17, as cmux does). Only tmux's own "no such session / no server"
#                  answer says gone.
#   - close     == tmux kill-session, then the tab config and the pre-1304 sentinel are
#                  removed and the record becomes a tombstone (task 1304 r3). Measured on
#                  the Mac: Warp closes the tab when its `exec tmux` client exits, but the
#                  worker's `telepty allow` process can outlive the session and telepty
#                  keeps it CONNECTED. Ending that process and the registry entry is
#                  session-cleanup's job (parent kill with its #606 self/ancestor guard,
#                  then DELETE), not close's: close releases the SURFACE only, for every
#                  adapter, exactly as cmux close does.
#   - list/prune== tmux list-sessions filtered by the name prefix (no GUI action).
#   - read      == tmux capture-pane -p (current viewport, no scrollback).
#   - focus     == macOS Accessibility raise of the window whose title is EXACTLY the
#                  marker; a logged no-op where AX is unavailable.
# tmux is a REQUIREMENT of this adapter: without it `open` fails at once (exit 2) and
# leaves nothing behind — there is no silent fallback to an invisible worker.
AIGENTRY_WARP_SURFACE_DIR="${AIGENTRY_WARP_SURFACE_DIR:-$HOME/.aigentry/warp-surfaces}"
_WH_WARP_TMUX_PREFIX="aigentry-warp-"

# _wh_warp_sid_from_marker <marker> — recover sid from the "telepty::<sid>" marker.
_wh_warp_sid_from_marker() { printf '%s' "${1#telepty::}"; }

# _wh_warp_tmux_name <sid> / _wh_warp_tmux_sid <name> — the sid ↔ tmux session name map.
_wh_warp_tmux_name() { local sid="$1"; printf '%s%s' "$_WH_WARP_TMUX_PREFIX" "${sid//./%2E}"; }
_wh_warp_tmux_sid() { printf '%s' "${1#"$_WH_WARP_TMUX_PREFIX"}" | sed 's/%2E/./g'; }

# _wh_warp_session_for <marker|sid> — the tmux session name, or non-zero when the sid is
# not one this layer could have opened (an untrusted handle never reaches tmux or a path).
_wh_warp_session_for() {
  local sid; sid=$(_wh_warp_sid_from_marker "${1:-}")
  _wh_safe_sid "$sid" || return 1
  _wh_warp_tmux_name "$sid"
}

# _wh_sq <value> — POSIX single-quoted shell word ('it'\''s'). Used for the pane command,
# which Warp hands to the user's login shell as one command LINE (no argv channel).
_wh_sq() { local s="$1" q="'\\''"; printf "'%s'" "${s//\'/$q}"; }

# _wh_toml_str <value> — a TOML basic string: backslash and double quote escaped, control
# characters as \n \t \r or \u00XX. Bytes >= 0x80 pass through, so UTF-8 (Hangul) stays
# readable. Runs in a C-locale subshell so the loop walks bytes, not characters.
_wh_toml_str() (
  LC_ALL=C
  s="$1"; out=""; i=0; n=${#s}
  while [ "$i" -lt "$n" ]; do
    c="${s:$i:1}"
    case "$c" in
      '\') out="$out\\\\" ;;
      '"') out="$out\\\"" ;;
      $'\n') out="$out\\n" ;;
      $'\t') out="$out\\t" ;;
      $'\r') out="$out\\r" ;;
      *)
        printf -v code '%d' "'$c"
        if { [ "$code" -ge 0 ] && [ "$code" -lt 32 ]; } || [ "$code" -eq 127 ]; then
          printf -v c '\\u%04X' "$code"
        fi
        out="$out$c" ;;
    esac
    i=$((i + 1))
  done
  printf '"%s"' "$out"
)

# _wh_tmux_answer_gone <tmux output> — 0 when tmux ANSWERED that the target does not exist
# (no such session/window, or no server on this socket: the sessions die with the server).
# Anything else — permission denied, an unknown message, silence — is not an answer.
_wh_tmux_answer_gone() {
  case "$1" in
    *"can't find session"*|*"can't find window"*|*"no server running"*) return 0 ;;
    *"error connecting to"*"(No such file or directory)"*|*"error connecting to"*"(Connection refused)"*) return 0 ;;
  esac
  return 1
}

# _wh_tmux_session_state <name> — print present | gone | unknown for an exact session name.
_wh_tmux_session_state() {
  local name="$1" out
  command -v tmux >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  if out=$(tmux has-session -t "=$name" 2>&1); then printf 'present'; return 0; fi
  if _wh_tmux_answer_gone "$out"; then printf 'gone'; else printf 'unknown'; fi
}

# _wh_warp_can_uiscript — 0 if macOS + osascript present (UI-scripting possible).
# AX-permission denial surfaces later as a non-zero osascript exit (degrade).
_wh_warp_can_uiscript() {
  [ "$(uname -s)" = "Darwin" ] || return 1
  command -v osascript >/dev/null 2>&1 || return 1
  return 0
}

# _wh_warp_raise_window <marker> — best-effort: activate Warp and AXRaise the window whose
# title IS <marker> (exact: `telepty::w-1` must never raise `telepty::w-10`). marker passed
# as argv (no string-interp into AppleScript → injection-safe). 0 raised, non-zero
# not-found/denied. Focus is the only Accessibility use left in this adapter.
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
          if (name of w as string) is marker then
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

# _wh_warp_rm_tab_config <sid> — remove the spawn-written "telepty-<sid>.toml". Only a
# recordable sid ever names a file here (no path traversal from an untrusted handle).
_wh_warp_rm_tab_config() {
  local sid="$1" dir
  _wh_safe_sid "$sid" || return 0
  dir=$(_wh_warp_tab_config_dir) || return 0
  rm -f "$dir/telepty-$sid.toml" 2>/dev/null || true
}

_wh_warp_lookup() {
  local sid="$1" info="${2:-}"
  if [ -z "$info" ]; then
    info=$(telepty list --json 2>/dev/null | jq -c --arg sid "$sid" '.[] | select(.id == $sid)' 2>/dev/null | head -1)
  fi
  if [ -z "$info" ]; then
    # task 1304 D2: no telepty row (the worker exited or was deregistered), but a sid
    # opened as warp has its handle on record, so close-for-sid still reaches its tmux
    # session — the warp analogue of cmux's title fallback (#523). No record → no mapping.
    _wh_record_handle_for warp "$sid"
    return 0
  fi
  local marker
  marker=$(printf '%s' "$info" | jq -r '.warpWindowMarker // .warpSurfaceId // empty' 2>/dev/null || true)
  # telepty may not persist the marker yet → synthesize the spawn-time contract.
  [ -z "$marker" ] && marker="telepty::$sid"
  printf '%s' "$marker"
}

# _wh_warp_close <marker> — kill the worker's tmux session, then remove what open wrote.
# 0 released or already gone; 1 the release is UNCONFIRMED (tmux unreachable from this
# caller, or a failed kill that tmux did not answer as "no such session").
_wh_warp_close() {
  local marker="$1" sid name out
  [ -z "$marker" ] && return 0
  sid=$(_wh_warp_sid_from_marker "$marker")
  if ! _wh_safe_sid "$sid"; then
    _wh_log "warp close: '$marker' names no sid this layer opens — nothing to release"
    return 0
  fi
  name=$(_wh_warp_tmux_name "$sid")
  _wh_refuse_own_surface warp "telepty::$sid" && return 4 # task 1304 r3: never the caller's own session
  if ! command -v tmux >/dev/null 2>&1; then
    _wh_log "warp close: tmux is not on this caller's PATH, so session $name cannot be released — release UNCONFIRMED (wh_close_status=unconfirmed)"
    return 1
  fi
  if ! out=$(tmux kill-session -t "=$name" 2>&1) && ! _wh_tmux_answer_gone "$out" \
     && [ "$(_wh_tmux_session_state "$name")" != "gone" ]; then
    _wh_log "warp close: kill-session failed for $name and the session was not proven gone — release UNCONFIRMED (wh_close_status=unconfirmed wh_close_category=$(_wh_fail_category "$out"))"
    return 1
  fi
  rm -f "$AIGENTRY_WARP_SURFACE_DIR/$sid.live" 2>/dev/null || true # pre-1304 sentinel, if any
  _wh_warp_rm_tab_config "$sid"
  _wh_record_tombstone_sid "$sid"
  return 0
}

_wh_warp_alive() {
  local marker="$1" name
  [ -z "$marker" ] && return 1
  name=$(_wh_warp_session_for "$marker") || return 0 # unaddressable → cannot ask → INDETERMINATE→alive
  [ "$(_wh_tmux_session_state "$name")" = "gone" ] && return 1
  return 0 # present, or tmux could not answer → INDETERMINATE→alive (INV-17, as cmux)
}

_wh_warp_list_ids() {
  local out name
  command -v tmux >/dev/null 2>&1 || return 0
  out=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 0
  while IFS= read -r name; do
    case "$name" in "$_WH_WARP_TMUX_PREFIX"?*) printf 'telepty::%s\n' "$(_wh_warp_tmux_sid "$name")" ;; esac
  done <<EOF
$out
EOF
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

# _wh_warp_prune_orphans <live_ids_csv> <protected_refs_csv> — close warp tmux sessions
# (name prefix == ownership: only sessions this layer named) whose sid left the live set,
# with cmux's seen-twice debounce: a candidate is closed only if it was ALSO a candidate
# on the previous tick (ledger next to the records). Never a GUI action. Honors DRY_RUN.
# Prints the count closed; always 0.
_wh_warp_prune_orphans() {
  local live_csv="${1:-}" protected_csv="${2:-}" dry="${DRY_RUN:-0}"
  local ledger old new="" closed=0 marker sid nl=$'\n'
  command -v tmux >/dev/null 2>&1 || { echo 0; return 0; }
  ledger="$(_wh_state_dir)/warp-orphan-ledger"
  old=$(cat "$ledger" 2>/dev/null || true)
  while IFS= read -r marker; do
    [ -z "$marker" ] && continue
    sid=$(_wh_warp_sid_from_marker "$marker")
    case ",$live_csv," in *",$sid,"*) continue ;; esac
    case ",$protected_csv," in *",$marker,"*|*",$sid,"*) continue ;; esac
    case "$nl$old$nl" in
      *"$nl$marker$nl"*)
        if [ "$dry" = "1" ]; then
          _wh_log "PRUNE would-close warp $marker"
          new="$new$marker$nl"
        elif _wh_warp_close "$marker"; then
          _wh_log "PRUNE closed warp $marker"
          closed=$((closed + 1))
        else
          _wh_log "PRUNE close-failed warp $marker"
          new="$new$marker$nl"
        fi ;;
      *) new="$new$marker$nl" ;; # first sighting → record + skip (debounce floor)
    esac
  done <<EOF
$(_wh_warp_list_ids)
EOF
  if ( umask 077; mkdir -p "$(dirname "$ledger")" ) 2>/dev/null; then
    printf '%s' "$new" > "$ledger" 2>/dev/null || true
  fi
  echo "$closed"
  return 0
}

# Warp has no status CLI → status degrades to a no-op (§17).
_wh_warp_set_status()    { return 0; }
_wh_warp_clear_status()  { return 0; }

# _wh_warp_read_screen <marker|sid> — task 1304 D4: the current viewport of the worker's
# tmux pane (`capture-pane -p`, no -S: no scrollback). Non-zero when tmux cannot read it.
_wh_warp_read_screen() {
  local name
  name=$(_wh_warp_session_for "${1:-}") || return 1
  command -v tmux >/dev/null 2>&1 || { _wh_log "warp read_screen: tmux is not on PATH"; return 1; }
  tmux capture-pane -p -t "=$name:"
}

# _wh_warp_ready_attestation — capability metadata (§12 BC2). wh_open's gate proves the
# worker's tmux session exists, a process-level fact; the surface itself is read by
# dispatch readiness through wh_read_screen (capture-pane), not by this gate.
_wh_warp_ready_attestation() { printf 'process'; }

# _wh_warp_write_tab_config <toml> <marker> <cwd> <pane_cmd> — write the documented Warp
# tab config schema (ADR D5): top-level name + title, one [[panes]] with id, type =
# "terminal", directory and commands = [<one shell line>], every value a TOML basic string
# (_wh_toml_str), so a cwd with a space, an apostrophe, a double quote, a backslash or
# Hangul stays one value and can never add a key.
_wh_warp_write_tab_config() {
  local toml="$1" marker="$2" cwd="$3" pane_cmd="$4"
  mkdir -p "$(dirname "$toml")" 2>/dev/null || return 1
  {
    printf '# aigentry warp tab_config - generated by _wh_warp_open (task 1304 ADR D3/D5)\n'
    printf 'name = %s\n' "$(_wh_toml_str "$marker")"
    printf 'title = %s\n\n' "$(_wh_toml_str "$marker")"
    printf '[[panes]]\n'
    printf 'id = "main"\n'
    printf 'type = "terminal"\n'
    printf 'directory = %s\n' "$(_wh_toml_str "$cwd")"
    printf 'commands = [%s]\n' "$(_wh_toml_str "$pane_cmd")"
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

# _wh_warp_wait_ready <tmux-name> — the warp ready-gate: poll up to WARP_READY_TIMEOUT_MS
# for the worker's tmux session to exist (the tab ran its command). 0 ready, 1 timeout.
_wh_warp_wait_ready() {
  local name="$1"
  local timeout_ms="${WARP_READY_TIMEOUT_MS:-10000}"
  local interval_ms="${WARP_READY_INTERVAL_MS:-200}"
  local interval_s; interval_s=$(awk -v ms="$interval_ms" 'BEGIN{printf "%.3f", ms/1000}')
  local max_iters=$(( timeout_ms / interval_ms )); [ "$max_iters" -lt 1 ] && max_iters=1
  local i=0
  while [ "$i" -lt "$max_iters" ]; do
    [ "$(_wh_tmux_session_state "$name")" = "present" ] && return 0
    i=$((i+1))
    sleep "$interval_s"
  done
  return 1
}

# _wh_warp_open <sid> <cwd> <cli_cmd> — open a Warp tab attached to the worker's own tmux
# session, BLOCK until that session exists, then emit the marker "telepty::<sid>".
# Exit contract (handle emitted ⇒ session exists; nothing half-spawned on failure):
#   0  → marker printed on stdout.
#   2  → nothing opened, nothing left behind: tmux not on PATH; AIGENTRY_WORKER_AUTO_RESTART
#        not 0/1; a sid that cannot name a file; no tab_config path on this OS; the tab
#        config could not be written or the deeplink could not be opened (the tab config
#        is removed again).
#   3  → ready-gate timed out; tab config removed (and the session, should it appear late),
#        NO marker emitted.
# AIGENTRY_WORKER_AUTO_RESTART is honoured exactly as _wh_cmux_open does (1/unset keeps
# `--auto-restart`, 0 drops it, anything else is refused before anything is written).
_wh_warp_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  local marker="telepty::$sid" tmux_bin restart_arg tcdir toml name wrapper pane
  tmux_bin=$(command -v tmux 2>/dev/null || true)
  case "$tmux_bin" in
    /*) ;;
    *) echo "ERR warp adapter needs tmux, which is not on PATH (a Warp worker runs in its own tmux session that the Warp tab attaches to): install tmux, or choose another adapter with AIGENTRY_WORKSPACE_HOST — nothing was opened" >&2
       return 2 ;;
  esac
  case "${AIGENTRY_WORKER_AUTO_RESTART-1}" in
    1) restart_arg=' --auto-restart';;
    0) restart_arg='';;
    *) echo 'ERR AIGENTRY_WORKER_AUTO_RESTART must be 0 or 1' >&2; return 2;;
  esac
  if ! _wh_safe_sid "$sid"; then
    echo "ERR warp wh_open: the sid names the tab config file and the tmux session, so it must match [A-Za-z0-9][A-Za-z0-9._-]* — nothing was opened" >&2
    return 2
  fi
  tcdir=$(_wh_warp_tab_config_dir) || {
    echo "[workspace-host] warp wh_open: UNSUPPORTED — no Warp tab_config path on $(uname -s)" >&2
    return 2
  }
  toml="$tcdir/telepty-$sid.toml"
  name=$(_wh_warp_tmux_name "$sid")

  # The worker wrapper is what tmux runs (through its default shell) inside the session;
  # cli_cmd stays unquoted because it is a COMMAND LINE that must word-split. The pane
  # command is ONE shell line for the tab's login shell: every value in it is a POSIX
  # single-quoted word (an apostrophe or `$( )` in a cwd stays data), and tmux is called
  # by its absolute path so the tab's PATH cannot pick another binary.
  wrapper="$(_wh_foreign_env_scrub tmux) telepty allow --id $(_wh_sq "$sid")$restart_arg $cli_cmd"
  pane="exec $(_wh_sq "$tmux_bin") new-session -A -s $(_wh_sq "$name") -c $(_wh_sq "$cwd") $(_wh_sq "$wrapper")"

  if ! _wh_warp_write_tab_config "$toml" "$marker" "$cwd" "$pane"; then
    echo "[workspace-host] warp wh_open: failed to write tab_config $toml" >&2
    rm -f "$toml" 2>/dev/null || true
    return 2
  fi
  if ! _wh_warp_deeplink_open "telepty-$sid"; then
    echo "[workspace-host] warp wh_open: deeplink open failed (no open/xdg-open) — no surface spawned" >&2
    rm -f "$toml" 2>/dev/null || true
    return 2
  fi
  if ! _wh_warp_wait_ready "$name"; then
    echo "[workspace-host] warp wh_open: ready-gate timed out after ${WARP_READY_TIMEOUT_MS:-10000}ms — tmux session $name never appeared; removing the tab_config, no handle emitted." >&2
    rm -f "$toml" 2>/dev/null || true
    tmux kill-session -t "=$name" >/dev/null 2>&1 || true
    return 3
  fi
  printf '%s\n' "$marker"
}

# -----------------------------------------------------------------------------
# legacy terminal spawn adapters — aterm / tmux / wezterm / iterm (#608 Phase 3).
# Each _wh_<term>_open is the inline open-session.sh:open_in_terminal() spawn branch
# moved 1:1 (byte-equivalent — current behavior preserved, Rule 29). aterm/wezterm/iterm
# are SPAWN-only adapters: lifecycle verbs (lookup/close/alive/...) for them keep the
# default rule. tmux is not (task 1304 D3): its open returns the new window's id, and
# lookup/alive/close/list_ids/read_screen address that window. They consume platform.sh
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
  # #926: this function is the reason the fix could not stop at cmux/warp/aterm —
  # it is where EVERY other adapter lands when its terminal CLI is missing, so the
  # hole here survives a fix everywhere else by the user simply not having cmux.
  local _q_sid; printf -v _q_sid '%q' "$_sid"
  if command -v tmux >/dev/null 2>&1 && platform::has_tmux_session; then
    # cwd is NOT in this string: platform::spawn_tmux_window takes it as its own
    # argument and hands it to `tmux new-window -c "$cwd"` — argv, never shell text.
    # The sid IS in it, because tmux runs the 3rd argument through a shell and the
    # signature offers no argv channel for it; `%q` is that guarantee here (a real
    # shell parses it, so there is no second parser to fight — unlike iTerm).
    # task 1304: spawn_tmux_window now prints the new window's id; this branch keeps
    # handing back the sid, so that id is discarded here rather than doubling stdout.
    platform::spawn_tmux_window "$_sid" "$_cwd" "$(_wh_foreign_env_scrub tmux) telepty allow --id $_q_sid --auto-restart $_cli_cmd" >/dev/null
    # #1303: a spawn that did not happen hands back NO handle — _wh_iterm_open's contract (2).
    local _rc=$?
    [ "$_rc" -eq 0 ] || { echo "ERR tmux spawn failed (rc=$_rc) — the spawn command did not confirm success, so no handle is returned" >&2; return 2; }
    echo "$_sid"
  else
    # `telepty spawn -- …` execs its argv directly, so this takes the true argv
    # shape and needs no quoting pass at all.
    local _scrub; _scrub=$(_wh_foreign_env_scrub none)
    telepty spawn --id "$_sid" -- bash -c "cd \"\$1\" && exec $_scrub $_cli_cmd" _ "$_cwd" >/dev/null
    # #1303: same contract — a failed daemon spawn returns 2 with no handle and no attach hint.
    local _rc=$?
    [ "$_rc" -eq 0 ] || { echo "ERR telepty spawn failed (rc=$_rc) — the spawn command did not confirm success, so no handle is returned" >&2; return 2; }
    echo "⚠️  Session spawned as daemon (no visible terminal). Attach: telepty attach $_sid" >&2
    echo "$_sid"
  fi
}

# _wh_aterm_open <sid> <cwd> <cli_cmd> — aterm new-session, else fallback (Tier 2).
# bash -c wrapper for cwd propagation into claude (#311).
_wh_aterm_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  # #926: same shape as _wh_cmux_open — --cmd is shell text, so cwd and sid go on
  # argv, %q-quoted; cli_cmd stays unquoted because it is a command line.
  local q_cwd q_sid
  printf -v q_cwd '%q' "$cwd"; printf -v q_sid '%q' "$sid"
  if command -v aterm >/dev/null 2>&1 \
    && aterm new-session --cwd "$cwd" --cmd "$(_wh_foreign_env_scrub aterm) bash -c 'cd \"\$1\" && exec telepty allow --id \"\$2\" --auto-restart $cli_cmd' _ $q_cwd $q_sid" 2>/dev/null; then
    echo "$sid"
  else
    _wh_fallback_spawn "$sid" "$cwd" "$cli_cmd"
  fi
}

# _wh_tmux_open <sid> <cwd> <cli_cmd> — tmux new-window via platform:: (Tier 1).
# `tmux new-window -c` propagates cwd correctly. The window is still named $sid; the
# handle is its window id (`@N`, task 1304 D3), which tmux keeps unique per server and
# which the lifecycle verbs below can address later — not the sid.
_wh_tmux_open() {
  local sid="$1" cwd="$2" cli_cmd="$3" out id
  # #926: see _wh_fallback_spawn's tmux branch — cwd never enters this string, the
  # sid is %q-quoted because spawn_tmux_window's 3rd argument is shell text.
  local q_sid; printf -v q_sid '%q' "$sid"
  out=$(platform::spawn_tmux_window "$sid" "$cwd" "$(_wh_foreign_env_scrub tmux) telepty allow --id $q_sid --auto-restart $cli_cmd")
  # #1303: a spawn that did not happen hands back NO handle — _wh_iterm_open's contract (2).
  local rc=$?
  [ "$rc" -eq 0 ] || { echo "ERR tmux spawn failed (rc=$rc) — the spawn command did not confirm success, so no handle is returned" >&2; return 2; }
  id=$(printf '%s\n' "$out" | grep -E '^@[0-9]+$' | tail -n 1)
  [ -n "$id" ] || { echo "ERR tmux new-window printed no window id — no handle to return (a window named $sid may exist)" >&2; return 2; }
  echo "$id"
}

# tmux lifecycle on the window id (task 1304 D3). tmux's own "no such window / no
# server" answer is the only gone; a probe tmux cannot answer stays INDETERMINATE→alive.
_wh_tmux_lookup() { _wh_record_handle_for tmux "$1"; }

# _wh_tmux_window_state <@id> — present | gone | unknown.
_wh_tmux_window_state() {
  local id="$1" out nl=$'\n'
  command -v tmux >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  if ! out=$(tmux list-windows -a -F '#{window_id}' 2>&1); then
    if _wh_tmux_answer_gone "$out"; then printf 'gone'; else printf 'unknown'; fi
    return 0
  fi
  case "$nl$out$nl" in *"$nl$id$nl"*) printf 'present' ;; *) printf 'gone' ;; esac
}

_wh_tmux_alive() {
  local id="$1"
  case "$id" in @[0-9]*) ;; *) return 0 ;; esac # not a window id → cannot ask → alive
  [ "$(_wh_tmux_window_state "$id")" = "gone" ] && return 1
  return 0
}

_wh_tmux_close() {
  local id="$1" out
  case "$id" in @[0-9]*) ;; "") return 0 ;; *) _wh_log "tmux close: '$id' is not a window id — nothing to release"; return 0 ;; esac
  _wh_refuse_own_surface tmux "$id" && return 4 # task 1304 r3: never the caller's own window
  command -v tmux >/dev/null 2>&1 || { _wh_log "tmux close: tmux is not on this caller's PATH, so $id cannot be released — release UNCONFIRMED (wh_close_status=unconfirmed)"; return 1; }
  if ! out=$(tmux kill-window -t "$id" 2>&1) && ! _wh_tmux_answer_gone "$out" \
     && [ "$(_wh_tmux_window_state "$id")" != "gone" ]; then
    _wh_log "tmux close: kill-window failed for $id and the window was not proven gone — release UNCONFIRMED (wh_close_status=unconfirmed wh_close_category=$(_wh_fail_category "$out"))"
    return 1
  fi
  return 0
}

# _wh_tmux_list_ids — the recorded tmux handles whose window still exists.
_wh_tmux_list_ids() {
  local f
  for f in "$(_wh_state_dir)"/*.rec; do
    [ -e "$f" ] || continue
    _wh_record_read "$f" || continue
    [ "$_WH_REC_ADAPTER" = "tmux" ] || continue
    [ "$(_wh_tmux_window_state "$_WH_REC_HANDLE")" = "present" ] && printf '%s\n' "$_WH_REC_HANDLE"
  done
  return 0
}

_wh_tmux_read_screen() {
  local id="$1"
  case "$id" in @[0-9]*) ;; *) return 1 ;; esac
  command -v tmux >/dev/null 2>&1 || { _wh_log "tmux read_screen: tmux is not on PATH"; return 1; }
  tmux capture-pane -p -t "$id"
}

# _wh_wezterm_open <sid> <cwd> <cli_cmd> — wezterm cli spawn, else fallback (Tier 1).
# Explicit cd inside bash -c guarantees cwd propagation into claude (#311).
_wh_wezterm_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  if command -v wezterm >/dev/null 2>&1; then
    # #926: `wezterm cli spawn -- …` execs its argv directly (no shell re-parse),
    # so cwd and sid go on argv as-is — no %q pass needed.
    local scrub; scrub=$(_wh_foreign_env_scrub wezterm)
    wezterm cli spawn --cwd "$cwd" -- bash -c "cd \"\$1\" && exec $scrub telepty allow --id \"\$2\" --auto-restart $cli_cmd" _ "$cwd" "$sid" >/dev/null
    # #1303: a spawn that did not happen hands back NO handle — _wh_iterm_open's contract (2).
    local rc=$?
    [ "$rc" -eq 0 ] || { echo "ERR wezterm spawn failed (rc=$rc) — the spawn command did not confirm success, so no handle is returned" >&2; return 2; }
    echo "$sid"
  else
    _wh_fallback_spawn "$sid" "$cwd" "$cli_cmd"
  fi
}

# _wh_iterm_open <sid> <cwd> <cli_cmd> — iTerm tab via platform:: AppleScript (Tier 1).
# Legacy contract: spawn failure → exit 2 (here: return 2, no handle).
_wh_iterm_open() {
  local sid="$1" cwd="$2" cli_cmd="$3"
  # #926: the fix for this arm is in platform::spawn_iterm_tab, NOT here, and that is
  # the point. cwd/cmd used to be interpolated into an AppleScript literal that iTerm
  # then typed into a shell — TWO parsers — so no amount of quoting at THIS call site
  # could be right for both grammars (measured: `printf %q` makes osascript reject an
  # ordinary path with a space, and its `\"` still unescapes into a live payload).
  # Rule 26: the OS primitive owns its own quoting, so platform-unix.sh takes both
  # values on argv and applies `quoted form of` to the cwd there.
  #
  # What is left here is the ordinary thing every other adapter does: %q the SID,
  # because it is a value inside a command LINE, while cli_cmd stays unquoted because
  # it IS the command line and must word-split.
  local q_sid; printf -v q_sid '%q' "$sid"
  platform::spawn_iterm_tab "$cwd" "$(_wh_foreign_env_scrub iterm) telepty allow --id $q_sid --auto-restart $cli_cmd" \
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
  # #926: argv shape — `telepty spawn -- …` execs its argv directly.
  local scrub; scrub=$(_wh_foreign_env_scrub none)
  telepty spawn --id "$sid" -- bash -c "cd \"\$1\" && exec $scrub $cli_cmd" _ "$cwd" >/dev/null
  # #1303: a spawn that did not happen hands back NO handle — _wh_iterm_open's contract (2).
  local rc=$?
  [ "$rc" -eq 0 ] || { echo "ERR telepty spawn failed (rc=$rc) — the spawn command did not confirm success, so no handle is returned" >&2; return 2; }
  echo "⚠️  Session spawned as daemon (headless: no spawn-tab CLI)." >&2
  echo "    Attach via: telepty attach $sid" >&2
  echo "$sid"
}
_wh_headless_ready_attestation() { printf 'none'; }
_wh_headless_lookup()        { echo ""; }
_wh_headless_close()         { return 0; }
_wh_headless_alive()         { return 0; } # no host to ask → INDETERMINATE→alive (task 1304 D5, INV-17)
_wh_headless_list_ids()      { :; }
_wh_headless_focus()         { return 0; }
_wh_headless_prune_orphans() { echo 0; return 0; }
_wh_headless_set_status()    { return 0; }
_wh_headless_clear_status()  { return 0; }

# -----------------------------------------------------------------------------
# agent metadata on non-cmux hosts (#1162 G2c) — explicit, labelled unsupported
# -----------------------------------------------------------------------------
# Only cmux has a per-surface agent-metadata transport. Every other adapter answers
# 20 with a generated line — a truthful `unsupported`, not parity and not a no-op
# success (a 0 here would claim a pill that was never drawn).
_wh_agent_meta_unsupported() {
  local adapter="$1" verb="$2"
  _wh_log "agent-meta $verb: UNSUPPORTED — adapter=$adapter has no agent-metadata transport (rc=20)"
  [ "$verb" = "caps" ] && printf 'agent_meta caps=unsupported adapter=%s reason=not-implemented\n' "$adapter"
  return 20
}
_wh_warp_agent_meta_caps()      { _wh_agent_meta_unsupported warp caps; }
_wh_warp_agent_meta_set()       { _wh_agent_meta_unsupported warp set; }
_wh_warp_agent_meta_clear()     { _wh_agent_meta_unsupported warp clear; }
_wh_aterm_agent_meta_caps()     { _wh_agent_meta_unsupported aterm caps; }
_wh_aterm_agent_meta_set()      { _wh_agent_meta_unsupported aterm set; }
_wh_aterm_agent_meta_clear()    { _wh_agent_meta_unsupported aterm clear; }
_wh_tmux_agent_meta_caps()      { _wh_agent_meta_unsupported tmux caps; }
_wh_tmux_agent_meta_set()       { _wh_agent_meta_unsupported tmux set; }
_wh_tmux_agent_meta_clear()     { _wh_agent_meta_unsupported tmux clear; }
_wh_wezterm_agent_meta_caps()   { _wh_agent_meta_unsupported wezterm caps; }
_wh_wezterm_agent_meta_set()    { _wh_agent_meta_unsupported wezterm set; }
_wh_wezterm_agent_meta_clear()  { _wh_agent_meta_unsupported wezterm clear; }
_wh_iterm_agent_meta_caps()     { _wh_agent_meta_unsupported iterm caps; }
_wh_iterm_agent_meta_set()      { _wh_agent_meta_unsupported iterm set; }
_wh_iterm_agent_meta_clear()    { _wh_agent_meta_unsupported iterm clear; }
_wh_headless_agent_meta_caps()  { _wh_agent_meta_unsupported headless caps; }
_wh_headless_agent_meta_set()   { _wh_agent_meta_unsupported headless set; }
_wh_headless_agent_meta_clear() { _wh_agent_meta_unsupported headless clear; }

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
    warp)     [ "${TERM_PROGRAM:-}" = "WarpTerminal" ] ;; # task 1304 D2: a controller started inside Warp
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
# Exit: 0 registered, 1 an explicit miss (the table was read and <name> is not in it),
# 2 the table itself could not be read (it failed or came back empty) — never a miss.
_wh_is_registered() {
  local want="$1" name rest table
  table=$(_wh_registry) || return 2
  [ -n "$table" ] || return 2
  while IFS=$'\t' read -r name rest; do
    [ "$name" = "$want" ] && return 0
  done <<EOF
$table
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

# -----------------------------------------------------------------------------
# per-sid adapter record (task 1304 ADR D2) — the adapter follows the session
# -----------------------------------------------------------------------------
# A successful wh_open writes ONE line `v1<TAB><adapter><TAB><host_id>` to
# ${AIGENTRY_WH_STATE_DIR:-$HOME/.aigentry/workspace-host}/<sid>.rec; the close verbs
# remove it. Sids are untrusted: only a sid matching [A-Za-z0-9][A-Za-z0-9._-]{0,199}
# names a file (no '/', never '.' or '..'), and a record is DATA — read with `read -r`,
# checked field by field, its adapter accepted only if registered; nothing in it is
# ever evaluated. A malformed or symlinked record is treated as absent.
_WH_SID_CHARS='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

_wh_state_dir() { printf '%s' "${AIGENTRY_WH_STATE_DIR:-$HOME/.aigentry/workspace-host}"; }

# _wh_safe_sid <sid> — 0 when <sid> may name a record, a tab config or a tmux session.
_wh_safe_sid() {
  case "${1:-}" in
    ""|[!$_WH_SID_CHARS]*|*[!$_WH_SID_CHARS._-]*) return 1 ;;
  esac
  [ "${#1}" -le 200 ]
}

# _wh_record_read <file> — set _WH_REC_ADAPTER / _WH_REC_HANDLE from a record; non-zero
# (and both empty) when the file is absent, a symlink or malformed.
_wh_record_read() {
  local f="$1" ver="" adapter="" handle="" extra=""
  _WH_REC_ADAPTER=""; _WH_REC_HANDLE=""
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  { IFS=$'\t' read -r ver adapter handle extra || :; } < "$f" 2>/dev/null || return 1
  [ "$ver" = "v1" ] && [ -n "$handle" ] && [ -z "$extra" ] || return 1
  _wh_is_registered "$adapter" || return 1
  _WH_REC_ADAPTER="$adapter"; _WH_REC_HANDLE="$handle"
  return 0
}

# _wh_record_write <sid> <adapter> <host_id> — best-effort; a sid or handle that cannot be
# recorded is said once on stderr and later verbs fall back to the default rule.
_wh_record_write() {
  local sid="$1" adapter="$2" handle="$3" dir tmp
  if ! _wh_safe_sid "$sid"; then
    _wh_log "record: sid has characters a record name cannot carry — adapter=$adapter not remembered; later verbs use the default rule"
    return 0
  fi
  case "$handle" in
    ""|*$'\t'*|*$'\n'*|*$'\r'*) _wh_log "record: adapter=$adapter gave no single-line host id for $sid — not remembered"; return 0 ;;
  esac
  dir=$(_wh_state_dir)
  if ! ( umask 077; mkdir -p "$dir" ) 2>/dev/null; then
    _wh_log "record: state dir cannot be created — adapter=$adapter for $sid not remembered"
    return 0
  fi
  tmp="$dir/.$sid.rec.$$"
  if printf 'v1\t%s\t%s\n' "$adapter" "$handle" > "$tmp" 2>/dev/null && mv -f "$tmp" "$dir/$sid.rec" 2>/dev/null; then
    rm -f "$dir/$sid.closed" 2>/dev/null || true # a re-open supersedes an old tombstone
    return 0
  fi
  rm -f "$tmp" 2>/dev/null || true
  _wh_log "record: write failed — adapter=$adapter for $sid not remembered"
  return 0
}

# task 1304 r3 — the TOMBSTONE. A close does not forget which adapter owned the session:
# <sid>.rec is renamed to <sid>.closed (same line format), and the resolver still reads
# it. Measured incident: close-for-sid removed the record, a later session-cleanup of the
# same sid fell back to "cmux if installed", and cmux closed the CONTROLLER's workspace
# that telepty had wrongly attributed to the worker. With the tombstone that later call
# resolves the original adapter and its close is an idempotent no-op. A tombstone is
# removed by a re-open of the sid (_wh_record_write), when a close-for-sid finds no
# mapping at all (the session is gone from every host, so there is nothing to misroute),
# or by wh_prune_orphans once the sid has been absent from the live set on two ticks
# (_wh_tombstone_gc, round 4).

# _wh_record_drop_sid <sid> — remove that sid's record AND tombstone (idempotent).
_wh_record_drop_sid() {
  _wh_safe_sid "${1:-}" || return 0
  rm -f "$(_wh_state_dir)/$1.rec" "$(_wh_state_dir)/$1.closed" 2>/dev/null || true
}

# _wh_record_tombstone_sid <sid> — turn the live record into the tombstone (idempotent).
_wh_record_tombstone_sid() {
  local dir
  _wh_safe_sid "${1:-}" || return 0
  dir=$(_wh_state_dir)
  [ -f "$dir/$1.rec" ] && [ ! -L "$dir/$1.rec" ] && mv -f "$dir/$1.rec" "$dir/$1.closed" 2>/dev/null
  return 0
}

# _wh_record_tombstone_handle <adapter> <host_id> — tombstone every live record naming that pair.
_wh_record_tombstone_handle() {
  local adapter="$1" handle="$2" f
  [ -n "$handle" ] || return 0
  for f in "$(_wh_state_dir)"/*.rec; do
    [ -e "$f" ] || continue
    _wh_record_read "$f" || continue
    [ "$_WH_REC_ADAPTER" = "$adapter" ] && [ "$_WH_REC_HANDLE" = "$handle" ] \
      && mv -f "$f" "${f%.rec}.closed" 2>/dev/null
  done
  return 0
}

# _wh_record_handle_for <adapter> <sid> — print the recorded host_id when <sid> was opened
# by <adapter>; print nothing otherwise. Always 0 (lookup semantics).
_wh_record_handle_for() {
  local adapter="$1" sid="${2:-}"
  _wh_safe_sid "$sid" || return 0
  _wh_record_read "$(_wh_state_dir)/$sid.rec" || return 0
  [ "$_WH_REC_ADAPTER" = "$adapter" ] && printf '%s' "$_WH_REC_HANDLE"
  return 0
}

# _wh_resolve <sid|host_id> — the adapter for a verb about ONE session: an explicit,
# registered AIGENTRY_WORKSPACE_HOST wins; else the record (by sid, then by host_id);
# else today's rule (_wh_adapter) plus one stderr line saying the adapter is unknown.
# Sets _WH_ADAPTER, _WH_FROM (env|record|default) and _WH_RES_HANDLE (the recorded
# host_id when a record matched, else empty). Runs in the caller's shell.
_wh_resolve() {
  local key="${1:-}" pref="${AIGENTRY_WORKSPACE_HOST:-}" f sid
  _WH_RES_HANDLE=""
  if [ -n "$pref" ] && _wh_is_registered "$pref"; then
    _WH_ADAPTER="$pref"; _WH_FROM=env; return 0
  fi
  if [ -n "$key" ]; then
    if _wh_safe_sid "$key" && { _wh_record_read "$(_wh_state_dir)/$key.rec" \
         || _wh_record_read "$(_wh_state_dir)/$key.closed"; }; then
      _WH_ADAPTER="$_WH_REC_ADAPTER"; _WH_FROM=record; _WH_RES_HANDLE="$_WH_REC_HANDLE"; return 0
    fi
    for f in "$(_wh_state_dir)"/*.rec "$(_wh_state_dir)"/*.closed; do
      [ -e "$f" ] || continue
      _wh_record_read "$f" || continue
      [ "$_WH_REC_HANDLE" = "$key" ] || continue
      _WH_ADAPTER="$_WH_REC_ADAPTER"; _WH_FROM=record; _WH_RES_HANDLE="$_WH_REC_HANDLE"; return 0
    done
  fi
  _WH_ADAPTER=$(_wh_adapter); _WH_FROM=default
  sid=$(printf '%s' "$key" | LC_ALL=C tr -d '\000-\037\177')
  _wh_log "adapter unknown for '$sid' (no AIGENTRY_WORKSPACE_HOST, no record) — using the default rule: $_WH_ADAPTER"
  return 0
}

# _wh_resolve_verb <verb> <sid|host_id> — _wh_resolve, then make sure the adapter has
# that verb: a RECORDED adapter without it (aterm/wezterm/iterm are spawn-only, and tmux
# has no focus/status) keeps today's rule for that verb, said on stderr. An explicit
# AIGENTRY_WORKSPACE_HOST is never second-guessed.
_wh_resolve_verb() {
  local verb="$1"
  _wh_resolve "${2:-}"
  if [ "$_WH_FROM" = "record" ] && ! declare -F "_wh_${_WH_ADAPTER}_${verb}" >/dev/null 2>&1; then
    local d; d=$(_wh_adapter)
    _wh_log "adapter=$_WH_ADAPTER (recorded) has no $verb — using the default rule: $d"
    _WH_ADAPTER="$d"; _WH_FROM=default; _WH_RES_HANDLE=""
  fi
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
  # task 1304 D2: the handle is captured so the adapter can be recorded for this sid; it
  # is printed exactly as the adapter printed it (one line), and only after success.
  local out rc nl=$'\n'
  out=$("_wh_${adapter}_open" "$@"); rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  [ "$rc" -eq 0 ] && _wh_record_write "${1:-}" "$adapter" "${out##*"$nl"}"
  return "$rc"
}

# The verbs about ONE session resolve their adapter per session (task 1304 D2): explicit
# AIGENTRY_WORKSPACE_HOST, else the record wh_open wrote, else the default rule + a line.
wh_lookup() {
  _wh_resolve_verb lookup "${1:-}"
  "_wh_${_WH_ADAPTER}_lookup" "$@"
}

wh_close() {
  local rc=0
  _wh_resolve_verb close "${1:-}"
  "_wh_${_WH_ADAPTER}_close" "$@" || rc=$?
  [ "$rc" -eq 0 ] && _wh_record_tombstone_handle "$_WH_ADAPTER" "${1:-}"
  return "$rc"
}

wh_alive() {
  _wh_resolve_verb alive "${1:-}"
  "_wh_${_WH_ADAPTER}_alive" "$@"
}

wh_list_ids() {
  local adapter; adapter=$(_wh_adapter)
  "_wh_${adapter}_list_ids" "$@"
}

wh_focus() {
  _wh_resolve_verb focus "${1:-}"
  "_wh_${_WH_ADAPTER}_focus" "$@"
}

# wh_prune_orphans <live_ids_csv> <protected_refs_csv> — close host workspaces
# whose session has vanished, gated (SPEC §A). Prints count closed; always 0.
wh_prune_orphans() {
  local adapter rc=0; adapter=$(_wh_adapter)
  "_wh_${adapter}_prune_orphans" "$@" || rc=$?
  _wh_tombstone_gc "${1:-}"
  return "$rc"
}

# _wh_tombstone_gc <live_ids_csv> — task 1304 r4: the END of a tombstone's life. A
# tombstone whose sid is absent from the live set on TWO consecutive prune ticks (the
# same seen-twice debounce the host prunes use; ledger next to the records) is removed.
# The live set is the reconciler's telepty ids, so a session telepty still lists keeps
# its tombstone: through close-for-sid, through session-cleanup (whose DELETE comes after
# its surface close) and for as long as a leftover `telepty allow` keeps it registered.
# Once telepty has no row for the sid there is no telepty-provided host id left that the
# default rule could misroute. Prints nothing (the prune count stays the host prune's);
# honours DRY_RUN; logs the sid only.
_wh_tombstone_gc() {
  local live_csv="${1:-}" dry="${DRY_RUN:-0}" dir ledger old new="" f sid nl=$'\n'
  dir=$(_wh_state_dir)
  [ -d "$dir" ] || return 0
  ledger="$dir/tombstone-ledger"
  old=$(cat "$ledger" 2>/dev/null || true)
  for f in "$dir"/*.closed; do
    [ -e "$f" ] || continue
    sid="${f##*/}"; sid="${sid%.closed}"
    _wh_safe_sid "$sid" || continue
    case ",$live_csv," in *",$sid,"*) continue ;; esac
    case "$nl$old$nl" in
      *"$nl$sid$nl"*)
        if [ "$dry" = "1" ]; then
          _wh_log "PRUNE would-remove tombstone sid=$sid"
          new="$new$sid$nl"
        elif rm -f "$f" 2>/dev/null; then
          _wh_log "PRUNE removed tombstone sid=$sid (absent from the live set on two ticks)"
        else
          new="$new$sid$nl"
        fi ;;
      *) new="$new$sid$nl" ;; # first sighting → record + keep (debounce floor)
    esac
  done
  printf '%s' "$new" > "$ledger" 2>/dev/null || true
  return 0
}

# wh_set_status <host_id> <state> — push session state to the host sidebar
# (SPEC §B). state ∈ {working,idle,disconnected,connected,unknown}. Best-effort; always 0.
wh_set_status() {
  _wh_resolve_verb set_status "${1:-}"
  "_wh_${_WH_ADAPTER}_set_status" "$@"
}

# wh_clear_status <host_id> — remove the aigentry status pill. Idempotent; 0.
wh_clear_status() {
  _wh_resolve_verb clear_status "${1:-}"
  "_wh_${_WH_ADAPTER}_clear_status" "$@"
}

# wh_read_screen <host_id|sid> — task 1304 D4: the surface's CURRENT viewport text (no
# scrollback). cmux: its read-screen; warp and tmux: tmux capture-pane -p; every other
# adapter: unsupported — exit 20 and one labelled line on stdout, never a guess.
wh_read_screen() {
  local key="${1:-}" handle
  _wh_resolve "$key"
  if ! declare -F "_wh_${_WH_ADAPTER}_read_screen" >/dev/null 2>&1; then
    printf 'read_screen unsupported adapter=%s\n' "$_WH_ADAPTER"
    return 20
  fi
  handle="$_WH_RES_HANDLE"
  if [ -z "$handle" ] && declare -F "_wh_${_WH_ADAPTER}_lookup" >/dev/null 2>&1; then
    handle=$("_wh_${_WH_ADAPTER}_lookup" "$key" 2>/dev/null)
  fi
  "_wh_${_WH_ADAPTER}_read_screen" "${handle:-$key}"
}

# wh_agent_meta_{caps,set,clear} — #1162 G2c per-surface agent metadata; see the
# header. Forward 1:1 to the selected adapter; exit code returned verbatim. The
# declare -F guard turns an adapter with no implementation into 20, never 127.
_wh_agent_meta_dispatch() {
  local verb="$1" adapter; shift
  adapter=$(_wh_adapter)
  if ! declare -F "_wh_${adapter}_agent_meta_${verb}" >/dev/null 2>&1; then
    _wh_agent_meta_unsupported "$adapter" "$verb"
    return 20
  fi
  "_wh_${adapter}_agent_meta_${verb}" "$@"
}
wh_agent_meta_caps()  { _wh_agent_meta_dispatch caps "$@"; }
wh_agent_meta_set()   { _wh_agent_meta_dispatch set "$@"; }
wh_agent_meta_clear() { _wh_agent_meta_dispatch clear "$@"; }

# Convenience composite: lookup + close for a sid in one call.
# task 1304 D2: ONE resolution for both halves — the adapter that opened <sid> both looks
# it up and closes it — and the record goes once the session is released or unmapped.
wh_close_for_sid() {
  local sid="$1" info="${2:-}" host_id rc=0 lrc=0
  _wh_resolve_verb lookup "$sid"
  host_id=$("_wh_${_WH_ADAPTER}_lookup" "$sid" "$info") || lrc=$?
  # task 1304 r3: a lookup that FAILED is not "no mapping" — nothing was closed, say so.
  if [ "$lrc" -ne 0 ]; then
    _wh_log "close-for-sid: lookup failed for $sid (adapter=$_WH_ADAPTER rc=$lrc) — nothing was closed, release UNCONFIRMED (wh_close_status=unconfirmed)"
    return 1
  fi
  if [ -z "$host_id" ]; then
    _wh_record_drop_sid "$sid"
    return 0
  fi
  declare -F "_wh_${_WH_ADAPTER}_close" >/dev/null 2>&1 || _wh_resolve_verb close "$host_id"
  "_wh_${_WH_ADAPTER}_close" "$host_id" || rc=$?
  [ "$rc" -eq 0 ] && _wh_record_tombstone_sid "$sid"
  return "$rc"
}
