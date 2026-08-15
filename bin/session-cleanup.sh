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
#   3 — telepty list --json unusable: non-zero exit, non-JSON stdout (binary/daemon
#       mismatch), or an EMPTY list the daemon would not corroborate with a 200 —
#       i.e. a refusal/outage wearing the shape of "there is nothing here" (#835).
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

# Test seams (#606, mirrors orchestrator-boot.sh:40-42): override the process
# lister + killer + self pid so the self/ancestor guard is exercisable with NO
# real process touched.
CLEANUP_PS_CMD="${CLEANUP_PS_CMD:-ps}"
KILL_CMD="${KILL_CMD:-kill}"
CLEANUP_SELF_PID="${CLEANUP_SELF_PID:-$$}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Test seam (#540): the registry component is called to take a cleaned session
# out of the pollers' way. telepty#60 Stage A — lifecycle only; there is no
# operation here that could mark a dispatch reported, because a session vanishing
# is not a task completing.
DISPATCH_REGISTRY_PY="${DISPATCH_REGISTRY_PY:-$SCRIPT_DIR/dispatch-registry.py}"

# registry_cleaned <sid> — best-effort: a cleaned session often has no dispatch
# record at all (a hand-spawned or already-pruned one), and that must not fail
# the cleanup.
#
# --all (#853): a sid carries ONE RECORD PER DISPATCH, and this is a fact about
# the SESSION — it is gone, so every live record for it is gone. Without --all
# the registry's singular lookup retired exactly one and left the rest in the
# --live set permanently, polled forever and HOLDing on every reconcile tick.
# The more a worker was talked to, the more ghosts its cleanup left behind; the
# only way to drain them was to re-run this by hand, once per ghost.
registry_cleaned() {
  local sid="$1"
  [ -x "$DISPATCH_REGISTRY_PY" ] || return 0
  "$DISPATCH_REGISTRY_PY" observe --sid "$sid" --kind session_absent_observed --all \
    >/dev/null 2>&1 || return 0
  "$DISPATCH_REGISTRY_PY" set-lifecycle --sid "$sid" --state cleaned --all >/dev/null 2>&1 || true
}
# shellcheck source=lib/workspace-host.sh
. "$SCRIPT_DIR/lib/workspace-host.sh"
# The one daemon-credential resolver (#824). delete_session_registry is a direct
# HTTP call, so it has to present the token itself. Resolution never fails — an
# unreadable config yields no credential, which is what keeps this teardown path
# working (degraded) instead of aborting.
# shellcheck source=lib/telepty-auth.sh
. "$SCRIPT_DIR/lib/telepty-auth.sh"
# An empty session list is what a REFUSED list request looks like (#835). Every
# destructive step below draws its evidence from telepty_list_json, so the trust
# check lives there and this is what it calls.
# shellcheck source=lib/telepty-listing.sh
. "$SCRIPT_DIR/lib/telepty-listing.sh"

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
#
# It is also the SINGLE choke point for this script's evidence: kill_parent_…,
# close_workspace_for, wh_close_for_sid and delete_session_registry are all
# downstream of it, on both the single-sid and the batch paths. That is why the
# #835 trust check belongs here and nowhere else — one guard covers every
# destructive step, and no path can reach a teardown without passing it.
telepty_list_json() {
  local raw verdict
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
  # `jq -e .` is loud on empty input (exit 4) but exits 0 on `[]`, so the check
  # above passes a refusal straight through — the #400 guard was built for the
  # THROW-shaped failure and an auth refusal is not that shape. An empty list is
  # the only ambiguous answer, and it is precisely the answer that authorizes
  # destruction, so it has to be corroborated before it is believed.
  if ! verdict=$(telepty_listing_trusted "$raw"); then
    err "telepty list --json returned [] but the daemon answered '$verdict' — that is a refusal/failure, not an absence, and an absence is the only thing that may authorize closing a surface or deleting a registry entry. Refusing to clean anything."
    case "$verdict" in
      unauthorized) err "the daemon rejected the credential — check authToken in ~/.telepty/config.json is readable, then re-run";;
      unreachable)  err "no answer from the daemon on 127.0.0.1:${TELEPTY_PORT:-3848} — every live session is its child, so 'unreachable' is not evidence that any session is gone";;
      broken)       err "the daemon answered with an error status — treat the listing as unusable, not as empty";;
    esac
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

# _ps_snapshot — "pid ppid command..." rows. The -o set is portable across
# BSD/macOS + GNU/Linux (same columns as orchestrator-boot.sh:48 /
# session-reconciler.sh). Routed through CLEANUP_PS_CMD so tests can inject a
# fixed table without touching the real process list.
_ps_snapshot() {
  "$CLEANUP_PS_CMD" -eo pid,ppid,command 2>/dev/null || true
}

# _self_ancestry <snapshot> — print SELF pid plus every ancestor pid (walk the
# ppid chain up to pid 1). Mirrors orchestrator-boot.sh:54 (#539): used to never
# SIGTERM the bridge we are running inside.
_self_ancestry() {
  local snap="$1" pid="$CLEANUP_SELF_PID" ppid hops=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    printf '%s\n' "$pid"
    ppid="$(awk -v p="$pid" '$1==p {print $2; exit}' <<<"$snap")"
    [ -z "$ppid" ] && break
    pid="$ppid"
    hops=$((hops + 1)); [ "$hops" -gt 64 ] && break   # cycle / runaway guard
  done
  return 0
}

# pid_is_self_or_ancestor <pid> — true (0) when <pid> is the cleanup process
# itself ($$), one of its ancestors, or an explicitly env-provided orchestrator
# bridge PID (ORCHESTRATOR_BRIDGE_PIDS, comma/space separated). #606 (cleanup
# side of #539): SIGTERMing such a PID fires inside the orchestrator's own
# process tree and cascades a DELETE 'Session destroyed' close to the live
# control tower. This happens when <sid> was spawned surface-less (forbidden) so
# its `telepty allow` process is a sibling/child under the tower.
pid_is_self_or_ancestor() {
  local pid="$1" snap ancestry bp bridge_pids
  [ -z "$pid" ] && return 1
  case "$pid" in (*[!0-9]*) return 1 ;; esac          # numeric pids only
  snap="$(_ps_snapshot)"
  ancestry="$(_self_ancestry "$snap")"
  grep -qxF "$pid" <<<"$ancestry" && return 0
  bridge_pids="${ORCHESTRATOR_BRIDGE_PIDS:-}"
  for bp in ${bridge_pids//,/ }; do
    [ "$pid" = "$bp" ] && return 0
  done
  return 1
}

# kill_parent_telepty_allow <sid> — find the `node ... telepty allow --id <sid> ...`
# process and SIGTERM it. Its child wrapped CLI (claude/codex/gemini/...) dies with it.
kill_parent_telepty_allow() {
  local sid="$1" pid
  pid=$(_ps_snapshot \
    | awk -v s="$sid" '$0 ~ ("telepty allow --id " s " ") {print $1; exit}' || true)
  if [ -z "$pid" ]; then
    log "no parent telepty-allow process for $sid (already exited?)"
    return 0
  fi
  # #606/#539 self/ancestor guard — refuse to SIGTERM a PID inside the
  # orchestrator's own process tree. Skip the kill ONLY; cleanup_one still runs
  # the surface close + registry DELETE. Applies regardless of --force, because
  # force only gates the PROTECTED_SID string check in cleanup_one, never this
  # kill — so no force path can ever signal our own tree.
  if pid_is_self_or_ancestor "$pid"; then
    err "refusing to SIGTERM PID $pid for $sid — it is in the orchestrator's own process tree; this session was spawned surface-less (forbidden). Close it from the user's terminal."
    return 0
  fi
  if "$KILL_CMD" -TERM "$pid" 2>/dev/null; then
    log "killed parent telepty-allow PID $pid for $sid"
  else
    log "kill -TERM PID $pid failed for $sid (may be exiting)"
  fi
}

# delete_session_registry <sid> — call DELETE /api/sessions/<sid> on local daemon
# (daemon.js:2367). 200 = removed, 404 = already gone (after parent kill).
delete_session_registry() {
  local sid="$1" port="${TELEPTY_PORT:-3848}" http
  # `|| true`, not `|| echo "000"`: with -w '%{http_code}' curl prints `000` on a
  # connect failure and ALSO exits non-zero, so the echo idiom appended a second
  # copy and produced `000000` — matching no arm and reaching the catch-all. That
  # is why the no-answer case never had a voice here even after it was given one.
  http=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "x-telepty-token: $(telepty_auth_token)" \
    -X DELETE "http://127.0.0.1:${port}/api/sessions/${sid}" 2>/dev/null || true)
  case "$http" in
    200) log "DELETE /api/sessions/$sid → 200 (removed from registry)";;
    404) log "DELETE /api/sessions/$sid → 404 (already gone — parent kill propagated)";;
    # A refusal is not an unexpected status. Folded into the catch-all it read as
    # "unexpected; manual verify", which says nothing about what to verify — while
    # the actual consequence is a session left in the daemon registry forever,
    # accumulating exactly the way the 21 stale entries of 2026-05-17 did. Named
    # separately, and on stderr, because the operator has to act on it.
    401|403) err "DELETE /api/sessions/$sid → $http (daemon refused the credential — the entry STAYS in the daemon registry; check authToken in ~/.telepty/config.json is readable, then re-run)";;
    # curl's own failure lands here as the literal "000" the || arm above prints.
    # It shares the refusal's consequence — the entry stays in the registry — but
    # not its cause, and "unexpected" told the operator neither. (#835)
    000) err "DELETE /api/sessions/$sid → no answer from the daemon (the entry STAYS in the daemon registry; nothing was removed — re-run once the daemon answers)";;
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
    # #540 — take the cleaned session out of the pollers' way. telepty#60 Stage A:
    # this is LIFECYCLE only. A session disappearing is not a task completing, so
    # the outcome stays unknown and the record keeps its history.
    registry_cleaned "$sid"
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
  # #540 — same lifecycle-only mark on the normal kill+close+DELETE path.
  registry_cleaned "$sid"
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

# Sourceable for hermetic tests (mirrors orchestrator-boot.sh:99): run main only
# when executed directly, not when sourced (T52 calls the functions in isolation).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
