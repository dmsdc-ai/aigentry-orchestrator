#!/usr/bin/env bash
# orchestrator-boot.sh — STANDARD control-tower (orchestrator) boot wrapper. (#539)
#
# The orchestrator ("control tower") session has NO scripted launcher: it was
# started manually via `telepty allow --id orchestrator claude ... --continue`.
# That let a stale duplicate bridge coexist with the live one — telepty's `--id`
# register is idempotent (a second `telepty allow --id orchestrator` is accepted
# and shares the SAME session). When the stale bridge was later killed with
# SIGTERM, its closeAllowSession→DELETE cascaded a 'Session destroyed' close to
# every co-bound client and the LIVE orchestrator self-exited (evidence
# 2026-06-07; telepty 0.5.3 added per-owner owner_token DELETE scoping as the
# other half of the defense — this wrapper is the orchestrator-side belt).
#
# This wrapper enforces singleton-at-boot: SIGKILL (kill -9, NOT SIGTERM — the
# DELETE cascade only runs on the SIGTERM handler) any pre-existing orchestrator
# bridge BEFORE exec'ing the new one. Self-protection is twofold:
#   1. Temporal — the guard runs strictly before `exec`, so the bridge this
#      script becomes does not exist yet at guard time.
#   2. Ancestry belt — never kill SELF or any ancestor of SELF, so running this
#      from inside an existing orchestrator (self-restart) cannot kill the
#      session it is launched from.
#
# Usage:
#   bin/orchestrator-boot.sh        # guard stale bridge(s), then boot orchestrator
#
# Env:
#   ORCHESTRATOR_SID   orchestrator session id (default: orchestrator) — same
#                      source as bin/dispatch-tracker.sh (Rule 16, no hardcode).
#
# Boot the orchestrator via THIS script, not a bare `telepty allow`. Worker
# sessions boot via bin/session-start.sh. See AGENTS.md.

set -uo pipefail

# Configurable orchestrator sid — same source as bin/dispatch-tracker.sh:31.
ORCH_SID="${ORCHESTRATOR_SID:-orchestrator}"

# Test seams (hermetic T40): override the process lister + killer + self pid so
# the guard can be exercised with NO real process touched.
KILL_CMD="${KILL_CMD:-kill}"
SINGLETON_PS_CMD="${SINGLETON_PS_CMD:-ps}"
SINGLETON_SELF_PID="${SINGLETON_SELF_PID:-$$}"

log() { echo "[orchestrator-boot] $*" >&2; }

# _ps_snapshot — "pid ppid command..." rows. The -o set is portable across
# BSD/macOS + GNU/Linux (same columns as bin/session-reconciler.sh).
_ps_snapshot() {
  "$SINGLETON_PS_CMD" -eo pid,ppid,command 2>/dev/null || true
}

# _self_ancestry <snapshot> — print SELF pid plus every ancestor pid (walk the
# ppid chain up). Used to never kill the bridge we are running inside.
_self_ancestry() {
  local snap="$1" pid="$SINGLETON_SELF_PID" ppid hops=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; do
    printf '%s\n' "$pid"
    ppid="$(awk -v p="$pid" '$1==p {print $2; exit}' <<<"$snap")"
    [ -z "$ppid" ] && break
    pid="$ppid"
    hops=$((hops + 1)); [ "$hops" -gt 64 ] && break   # cycle / runaway guard
  done
  return 0
}

# orchestrator_singleton_guard — SIGKILL every `telepty allow --id $ORCH_SID`
# process EXCEPT self + self ancestors. Idempotent: no-op for 0 bridges or a
# lone self bridge. MUST run BEFORE the new bridge exists (temporal protection).
orchestrator_singleton_guard() {
  local snap ancestry pid killed=0
  snap="$(_ps_snapshot)"
  ancestry="$(_self_ancestry "$snap")"
  # Trailing space in the marker avoids `orchestrator-2` prefix collisions —
  # mirrors session-reconciler.sh:415 / session-cleanup.sh:131.
  while read -r pid; do
    [ -z "$pid" ] && continue
    case "$pid" in (*[!0-9]*) continue ;; esac          # numeric pids only
    if grep -qxF "$pid" <<<"$ancestry"; then
      log "skip self/ancestor bridge pid=$pid ($ORCH_SID)"
      continue
    fi
    if "$KILL_CMD" -9 "$pid" 2>/dev/null; then
      log "SIGKILL stale orchestrator bridge pid=$pid ($ORCH_SID)"
      killed=$((killed + 1))
    else
      log "kill -9 pid=$pid failed (already gone?)"
    fi
  done < <(awk -v s="$ORCH_SID" '$0 ~ ("telepty allow --id " s " ") {print $1}' <<<"$snap")
  log "singleton guard done: killed=$killed stale bridge(s) for $ORCH_SID"
}

main() {
  orchestrator_singleton_guard
  log "exec telepty allow --id $ORCH_SID claude --continue"
  exec telepty allow --id "$ORCH_SID" claude --dangerously-skip-permissions --continue
}

# Sourceable for hermetic tests: run main only when executed directly.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
