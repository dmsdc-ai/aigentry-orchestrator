#!/usr/bin/env bash
# dispatch-autoverify.sh — AUTONOMOUS post-dispatch session-start verification.
#
# Session verification is the orchestrator's role and must be AUTOMATIC — neither
# the user nor the interactive orchestrator turn should have to react to a
# TASK_IDLE_UNCONFIRMED notification by hand. This runs on the reconciler's 60s
# launchd cadence (com.aigentry.reconciler.plist → session-reconciler.sh) over
# every still-in-flight dispatched session and:
#   - runs `dispatch-verify.sh <sid> --resubmit` (auto-resends Enter if the inject
#     sat unsubmitted at a freshly-spawned codex prompt — #412/#508 init race),
#   - on VERIFIED: drops a marker so the session is not re-verified/re-Entered
#     again (don't disturb a session that's working or HOLDing),
#   - on SUSPECT: appends an escalation line the orchestrator reads — a GENUINE
#     problem surfaces; a false-positive TASK_IDLE is silently absorbed.
#
# Idempotent + safe: an Enter on an already-working session is a harmless empty
# submit; the marker bounds resends to the startup window. Dead sessions leave
# active.json via the tracker/reconciler cleanup, which stops auto-verify for them.
#
# Usage: dispatch-autoverify.sh            (one sweep — called by the reconciler)
#        dispatch-autoverify.sh --once     (alias, same)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
STATE_DIR="${AIGENTRY_DISPATCH_STATE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd -P)/state/dispatch}"
ACTIVE_JSON="$STATE_DIR/active.json"
MARKER_DIR="$STATE_DIR/verify-started"
ESCALATION="$STATE_DIR/verify-escalations.jsonl"
VERIFY_SH="$SCRIPT_DIR/dispatch-verify.sh"
TELEPTY="${TELEPTY:-telepty}"

[ -f "$ACTIVE_JSON" ] || exit 0       # nothing dispatched → no-op
[ -x "$VERIFY_SH" ] || exit 0
mkdir -p "$MARKER_DIR" 2>/dev/null || true

# in-flight sids that still need a started-working confirmation
sids=$(python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for e in (d if isinstance(d,list) else []):
    sid=e.get("sid"); st=e.get("status","")
    # only sessions still awaiting their first started-working confirmation
    if sid and st in ("in_flight","re_dispatched","stuck_welcome",""):
        print(sid)
' "$ACTIVE_JSON" 2>/dev/null || true)

# prune stale markers: a session that left active.json (completed/cleaned) must be
# re-verified if its sid is ever reused (e.g. a respawn) — drop its marker.
if [ -d "$MARKER_DIR" ]; then
  for m in "$MARKER_DIR"/*; do
    [ -e "$m" ] || continue
    msid=$(basename "$m")
    printf '%s\n' "$sids" | grep -qx "$msid" || rm -f "$m"
  done
fi

[ -z "$sids" ] && exit 0

now_iso() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))'; }

printf '%s\n' "$sids" | while IFS= read -r sid; do
  [ -z "$sid" ] && continue
  [ -f "$MARKER_DIR/$sid" ] && continue           # already verified working once → leave it alone
  if TELEPTY="$TELEPTY" "$VERIFY_SH" "$sid" --resubmit --quiet --settle-ms 3500 >/dev/null 2>&1; then
    : > "$MARKER_DIR/$sid"                          # VERIFIED → stop re-verifying/re-Entering
  else
    rc=$?
    [ "$rc" -eq 2 ] && continue                    # session gone → tracker/reconciler cleans it up
    # SUSPECT (rc 6): a genuine not-started problem (or still-unsubmitted after resend).
    detail=$(TELEPTY="$TELEPTY" "$VERIFY_SH" "$sid" --quiet 2>&1 | head -1 | tr -d '\n' | sed 's/"/\\"/g')
    printf '{"sid":"%s","ts":"%s","rc":%s,"detail":"%s"}\n' "$sid" "$(now_iso)" "$rc" "$detail" >> "$ESCALATION"
  fi
done

exit 0
