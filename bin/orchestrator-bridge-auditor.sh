#!/usr/bin/env bash
# orchestrator-bridge-auditor.sh — warn-only duplicate orchestrator-bridge
# detector (tq#620, the belt for the #618 recurrence).
#
# Problem (#618): a raw orchestrator restart — a bare `telepty allow --id
# orchestrator …` typed into the cmux pane instead of bin/orchestrator-boot.sh —
# leaves a STALE duplicate bridge alive next to the live one. telepty's `--id`
# register is idempotent (a 2nd allow shares the SAME session) but the daemon
# keeps routing every `inject … orchestrator` to the registered-FIRST owner, so
# worker REPORTs reach the stale/dead bridge and ZERO arrive at the live TUI —
# a silent multi-hour failure. orchestrator-boot.sh prevents this WHEN invoked;
# this auditor is the runtime belt for when the restart path bypasses it.
#
# It DETECTS >1 live `telepty allow --id <ORCH_SID> ` bridge and pushes ONE HOLD
# inject to the orchestrator naming every bridge PID (with `etime` age, oldest
# flagged as the likely-stale candidate) and the exact `kill -9 <pid>` remedy.
#
# ⚠️ HARD CONSTRAINT — warn, NEVER kill. Orchestrator bridge cleanup/kill is
# USER-ONLY (#606): a background reconcile process is neither the user nor an
# ancestor of either bridge, so it cannot safely apply boot.sh's self/ancestor
# protection and could kill the LIVE bridge. The belt DETECTS + WARNS/HOLDs
# only; the user (or boot.sh at next boot) performs the kill. The HOLD never
# asserts a kill target with certainty — it flags the oldest pid as *likely*
# stale and tells the operator to confirm the live-TUI pid first (§13). This
# mirrors bin/session-comms-auditor.sh's warn-mode (detect/escalate, no in-band
# action), and is wired into bin/session-reconciler.sh (step 0d), not a new daemon.
#
# Article 17 (무의존): pure bash + telepty. No npm runtime deps, no python.
# Cross-OS: `ps -eo pid,etime,command` (BSD/macOS + GNU/Linux; mirrors the column
# set of bin/orchestrator-boot.sh:48).
#
# Usage:
#   orchestrator-bridge-auditor.sh            # one audit pass (act: HOLD on duplicate)
#   orchestrator-bridge-auditor.sh --dry-run  # detect + log only, never inject
#
# Env:
#   ORCHESTRATOR_SID  orchestrator sid (default: orchestrator) — same source as
#                     bin/orchestrator-boot.sh:36 (Rule 16, no hardcode).
# Test seams (hermetic T57, mirror orchestrator-boot.sh:40-42):
#   SINGLETON_PS_CMD  process lister (default: ps)
#   TELEPTY           telepty binary (default: telepty)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ORCH_SID="${ORCHESTRATOR_SID:-orchestrator}"
SINGLETON_PS_CMD="${SINGLETON_PS_CMD:-ps}"
TELEPTY="${TELEPTY:-telepty}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
ALERTS_LOG="$STATE_DIR/alerts.log"

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    -h|--help) sed -n '30,40p' "$0"; exit 0;;
    *) echo "unknown: $1" >&2; exit 4;;
  esac
done

now_iso() {
  if [ -n "${AUDITOR_NOW:-}" ]; then printf '%s' "$AUDITOR_NOW"; return; fi
  python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"))' 2>/dev/null \
    || date -u +%Y-%m-%dT%H:%M:%SZ
}

emit_alert() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s %s\n' "$(now_iso)" "$1" | tee -a "$ALERTS_LOG" >&2
}

# Snapshot once, then awk over the captured string (no pipeline self-match). The
# trailing space in the marker avoids `orchestrator-2` prefix collisions — same
# marker as orchestrator-boot.sh:88 / session-reconciler.sh:415. etime is parsed
# to seconds ([[DD-]HH:]MM:SS) so the oldest bridge is found portably. Output:
#   line 1 = count; lines 2.. = "pid etime oldestflag(*|-)".
snapshot="$("$SINGLETON_PS_CMD" -eo pid,etime,command 2>/dev/null || true)"
parsed="$(awk -v s="$ORCH_SID" '
  function etime_secs(e,   d, t, n, a, m) {
    d = 0; t = e
    n = split(e, a, "-"); if (n == 2) { d = a[1]; t = a[2] }
    m = split(t, a, ":")
    if (m == 3) return d*86400 + a[1]*3600 + a[2]*60 + a[3]
    if (m == 2) return d*86400 + a[1]*60 + a[2]
    return d*86400 + a[1]
  }
  $0 ~ ("telepty allow --id " s " ") {
    if ($0 ~ /<defunct>/) next        # skip zombies
    if ($1 ~ /[^0-9]/) next           # numeric pids only
    n++; pid[n] = $1; et[n] = $2; ss[n] = etime_secs($2)
  }
  END {
    print n + 0
    maxi = 0; maxs = -1
    for (i = 1; i <= n; i++) if (ss[i] > maxs) { maxs = ss[i]; maxi = i }
    for (i = 1; i <= n; i++) printf "%s %s %s\n", pid[i], et[i], (i == maxi ? "*" : "-")
  }' <<<"$snapshot")"

count="$(printf '%s\n' "$parsed" | sed -n '1p')"
[ -z "$count" ] && count=0

# count <= 1 → the normal case. Silent no-op (must not be noisy on every tick).
if [ "$count" -le 1 ]; then
  exit 0
fi

# Duplicate: build "pid(etime)" list + the oldest (likely-stale) pid.
pids_str=""; oldest_pid=""
while read -r pid et flag; do
  [ -z "$pid" ] && continue
  pids_str="${pids_str:+$pids_str, }${pid}(${et})"
  [ "$flag" = "*" ] && oldest_pid="$pid"
done < <(printf '%s\n' "$parsed" | sed -n '2,$p')

msg="HOLD: orchestrator-bridge DUPLICATE | N=${count} bridges (expected 1) | pids: ${pids_str} | likely-stale=oldest=${oldest_pid} | remedy: confirm the live-TUI pid, then \`kill -9 <stale-pid>\` — USER-ONLY (automation must NOT kill). ref #618"

emit_alert "ORCH_BRIDGE_DUPLICATE count=${count} pids=[${pids_str}] likely_stale=${oldest_pid} dry_run=${DRY_RUN}"

# Act-only: the HOLD inject is skipped under --dry-run (mirrors the reconciler's
# act-only auditor wiring). Best-effort — the alert above already recorded it.
if [ "$DRY_RUN" -eq 0 ]; then
  "$TELEPTY" inject --submit "$ORCH_SID" "$msg" >/dev/null 2>&1 || true
else
  emit_alert "ORCH_BRIDGE_DUPLICATE would-HOLD (dry-run) → $ORCH_SID"
fi

exit 0
