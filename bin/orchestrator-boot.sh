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
# #905 — the guard above kills PROCESSES. It does not, and until now could not,
# reconcile the daemon's REGISTRY RECORD, and on 2026-08-16 that combination made an
# orchestrator restart structurally impossible for 3h20m:
#
#   the daemon on :3848 was replaced; the orchestrator's bridge never re-registered and
#   its record went OWNER_DISCONNECTED_STALE with 0 clients. Re-running this script then
#   found no process to kill (killed=0) and exec'd a fresh `telepty allow`, which the
#   daemon refused — `Owner claim refused ... this bridge does not hold its current
#   credential` — because the STALE record was still holding the DEAD bridge's owner
#   token (telepty #815). A record nobody owns and nobody can claim: the one shape this
#   wrapper had no answer for. The manual fix was a DELETE of that record; step 2 below
#   is that fix, done in the one place that already knows it is about to become the new
#   owner.
#
# The reconcile is deliberately narrow. It deletes ONLY a record that is STALE with zero
# attached clients — the daemon's own verdict that the owner has been gone past the
# stale threshold, plus proof nobody is attached. Every other shape is left alone, and
# every UNKNOWN (daemon silent, listing unparseable, client count absent) is announced
# and skipped rather than resolved in favour of deleting. "Orchestrator cleanup is
# user-only" (#606) is intact: this removes a dead shell nobody owns, never a session.
#
# Usage:
#   bin/orchestrator-boot.sh        # reconcile stale record, guard bridges, then boot
#
# Env:
#   ORCHESTRATOR_SID   orchestrator session id (default: orchestrator) — same
#                      source as bin/dispatch-tracker.sh (Rule 16, no hardcode).
#   TELEPTY / CURL     tool seams (hermetic T40); TELEPTY_PORT (default 3848).
#
# Boot the orchestrator via THIS script, not a bare `telepty allow`. Worker
# sessions boot via bin/session-start.sh. See AGENTS.md.

set -uo pipefail

# The ONE sanctioned credential resolver (#824; tests/dispatch/T87 pins that there is
# exactly one). Sourced, never re-implemented — a divergent copy of a credential is how
# the two ends silently stop agreeing about who is calling.
# shellcheck source=lib/telepty-auth.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib/telepty-auth.sh"

# Configurable orchestrator sid — same source as bin/dispatch-tracker.sh:31.
ORCH_SID="${ORCHESTRATOR_SID:-orchestrator}"

# Test seams (hermetic T40): override the process lister + killer + self pid so
# the guard can be exercised with NO real process touched.
KILL_CMD="${KILL_CMD:-kill}"
SINGLETON_PS_CMD="${SINGLETON_PS_CMD:-ps}"
SINGLETON_SELF_PID="${SINGLETON_SELF_PID:-$$}"
# Registry seams: the listing query and the DELETE. Named from the repo-wide env vars
# (bin/lib/telepty-listing.sh, bin/session-reconciler.sh) so a caller sets what it
# already knows, and re-pinnable by name the way T40 re-pins the two above.
TELEPTY_CMD="${TELEPTY:-telepty}"
CURL_CMD="${CURL:-curl}"
TELEPTY_PORT="${TELEPTY_PORT:-3848}"

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

# orchestrator_registry_reconcile — delete the daemon's record for our own sid IF, and
# only if, it is a shell nobody owns: STALE (the daemon's own verdict that the owner has
# been disconnected past the stale threshold — daemon.js:1533 reports it as
# OWNER_DISCONNECTED_STALE) AND zero attached clients.
#
# Always returns 0. Every failure here is a reason to continue to the exec, not to
# block it: `telepty allow` reports its own error far better than a guess made here,
# and refusing to boot because the pre-flight was inconclusive would turn a recoverable
# outage into a permanent one — which is the failure mode this whole function exists to
# end.
#
# Every UNKNOWN resolves to "do not delete". A silent daemon, an unparseable listing and
# an absent client count are not evidence of an unowned record, and #835's invariant —
# a refusal must never authorise a destructive remediation — applies with full force to
# a DELETE aimed at the orchestrator's own id.
orchestrator_registry_reconcile() {
  local raw rec health clients http
  raw="$("$TELEPTY_CMD" list --json 2>/dev/null)" || {
    log "registry reconcile SKIPPED — '$TELEPTY_CMD list --json' did not answer; continuing to exec (allow will report its own error)"
    return 0
  }
  if ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    log "registry reconcile SKIPPED — the listing was not JSON (daemon/CLI version mismatch?); continuing to exec"
    return 0
  fi
  rec="$(printf '%s' "$raw" | jq -c --arg s "$ORCH_SID" '.[] | select(.id == $s)' 2>/dev/null | head -1)"
  if [ -z "$rec" ]; then
    log "registry reconcile: no record for '$ORCH_SID' — nothing to reconcile"
    return 0
  fi
  health="$(printf '%s' "$rec" | jq -r '.healthStatus // .status // ""' 2>/dev/null)"
  # No default: an absent count must stay distinguishable from a zero one.
  clients="$(printf '%s' "$rec" | jq -r 'if has("active_clients") then (.active_clients|tostring) elif has("activeClients") then (.activeClients|tostring) else "" end' 2>/dev/null)"

  if [ "$health" != "STALE" ]; then
    # DISCONNECTED is deliberately NOT reconciled. A bridge that dropped seconds ago is
    # very likely mid-reconnect (cli.js scheduleReconnect, unconditional since
    # 2026-03-14), and deleting its record would race a session that is coming back.
    # STALE is the daemon saying that window has already closed.
    log "registry reconcile: record for '$ORCH_SID' is $health (clients=${clients:-unknown}) — left alone; only a STALE record with 0 clients is reconciled"
    return 0
  fi
  if [ -z "$clients" ]; then
    log "registry reconcile: record for '$ORCH_SID' is STALE but the listing reports no client count — unknown is not zero, leaving it alone"
    return 0
  fi
  if [ "$clients" != "0" ]; then
    log "registry reconcile: record for '$ORCH_SID' is STALE but $clients client(s) are attached — leaving it alone"
    return 0
  fi

  log "registry reconcile: '$ORCH_SID' is STALE with 0 clients — a record whose owner is gone and whose owner token no new bridge can present (#815). Deleting it so this boot can claim the id."
  http="$("$CURL_CMD" -s -o /dev/null -w '%{http_code}' \
    -H "x-telepty-token: $(telepty_auth_token)" \
    -X DELETE "http://127.0.0.1:${TELEPTY_PORT}/api/sessions/${ORCH_SID}" 2>/dev/null || true)"
  case "$http" in
    200) log "DELETE /api/sessions/$ORCH_SID → 200 (stale record removed; the id is claimable)" ;;
    404) log "DELETE /api/sessions/$ORCH_SID → 404 (already gone — someone or something beat us to it)" ;;
    401|403) log "DELETE /api/sessions/$ORCH_SID → $http (daemon refused the credential — the STALE record STAYS and the exec below will very likely be refused the owner claim; check that authToken in ~/.telepty/config.json is readable)" ;;
    000|'') log "DELETE /api/sessions/$ORCH_SID → no answer from the daemon (the STALE record STAYS; nothing was removed)" ;;
    *)   log "DELETE /api/sessions/$ORCH_SID → $http (unexpected; the record may still be there)" ;;
  esac
  return 0
}

# The exec argv, as data, so T40 can assert its shape without running it.
#
# --auto-restart, MEASURED (cli.js 0.8.0, not inferred): the flag is extracted by
# indexOf over the args after `allow` and spliced out before `command = allowArgs[0]`
# (cli.js:1837-1846), so it must precede the command word — which is also where every
# worker carries it. Its behaviour is referenced at exactly two places, cli.js:2576 and
# :2605, both inside attachChildExitHandler: when the WRAPPED CHILD exits abnormally the
# bridge respawns it with exponential backoff (1s→8s, capped, MAX_CRASHES, counter reset
# after 30s of survival) instead of tearing the session down.
#
# So it is worth having — without it a `claude` crash takes the whole orchestrator
# session with it, and workers have had that protection all along — but it is NOT what
# saved the workers on 2026-08-16, and it would not have prevented that incident. WS
# reconnect and re-register are unconditional and have nothing to do with this flag
# (cli.js:2224-2256, scheduleReconnect, landed 2026-03-14). See the report for what the
# real differentiator was.
ORCH_EXEC_ARGV=(
  telepty allow --id "$ORCH_SID" --auto-restart
  claude --dangerously-skip-permissions --continue
)

main() {
  orchestrator_registry_reconcile
  orchestrator_singleton_guard
  log "exec ${ORCH_EXEC_ARGV[*]}"
  exec "${ORCH_EXEC_ARGV[@]}"
}

# Sourceable for hermetic tests: run main only when executed directly.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
