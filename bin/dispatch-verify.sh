#!/usr/bin/env bash
# dispatch-verify.sh — Rule 33 started-working verification wrapper.
#
# Classification now lives in session-probe.py and decisions in policy.py. This
# file preserves the legacy CLI/exit codes while acting only as glue.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TELEPTY="${TELEPTY:-telepty}"
SESSION_PROBE_PY="${SESSION_PROBE_PY:-$SCRIPT_DIR/session-probe.py}"
POLICY_PY="${POLICY_PY:-$SCRIPT_DIR/policy.py}"

sid=""; settle_ms=6000; quiet=0; resubmit=0
while [ $# -gt 0 ]; do
  case "$1" in
    --settle-ms) settle_ms="$2"; shift 2;;
    --resubmit) resubmit=1; shift;;
    --quiet) quiet=1; shift;;
    -h|--help) sed -n '2,22p' "$0"; exit 0;;
    -*) echo "dispatch-verify.sh: unknown arg: $1" >&2; exit 4;;
    *) sid="$1"; shift;;
  esac
done
[ -n "$sid" ] || { echo "dispatch-verify.sh: <sid> required" >&2; exit 4; }

say() { [ "$quiet" -eq 1 ] || echo "$@"; }

run_check() {
  local pre_info state_json action_json
  pre_info=$("$TELEPTY" session info "$sid" --json 2>/dev/null || true)
  if [ -z "$pre_info" ]; then
    echo "SUSPECT $sid — session not found / no transport info (spawn failed or wrong sid)"
    return 2
  fi
  sleep "$(python3 -c "print(max(0,$settle_ms)/1000)")"
  state_json=$(TELEPTY="$TELEPTY" "$SESSION_PROBE_PY" --sid "$sid" --screen-lines 40 2>/dev/null || true)
  if [ -z "$state_json" ]; then
    echo "SUSPECT $sid — session-probe failed"
    return 2
  fi
  action_json=$(printf '%s\n' "$state_json" | "$POLICY_PY" --status verify_started --state - 2>/dev/null || true)
  if [ -z "$action_json" ]; then
    echo "SUSPECT $sid — policy failed"
    return 6
  fi
  STATE_JSON="$state_json" ACTION_JSON="$action_json" SID="$sid" python3 - <<'PY'
import json, os, sys

sid = os.environ["SID"]
state = json.loads(os.environ["STATE_JSON"])
action = json.loads(os.environ["ACTION_JSON"])
detail = state.get("detail") if isinstance(state.get("detail"), dict) else {}
problems = detail.get("verify_problems") if isinstance(detail.get("verify_problems"), list) else []
probe_error = detail.get("probe_error")

if probe_error:
    print(f"SUSPECT {sid} — {probe_error}")
    sys.exit(2)

if action.get("action") == "NOOP" and action.get("status") == "verified":
    print(f"VERIFIED {sid} — CONNECTED + ready + clean + moving (working-spinner). Started as intended.")
    sys.exit(0)

reason = "; ".join(str(p) for p in problems) if problems else action.get("reason", "not started")
print(f"SUSPECT {sid} — {reason}")
print("  → action: telepty read-screen "
      f"{sid} ; resolve the surface (answer modal / resend Enter / respawn) before treating as started.")
sys.exit(6)
PY
}

out=$(run_check); rc=$?
say "$out"

if [ "$rc" -eq 6 ] && [ "$resubmit" -eq 1 ] && printf '%s' "$out" | grep -q '\[not-moving\]'; then
  say "dispatch-verify: not-moving → #412 submit-resend (send-key enter), re-verifying once..."
  "$TELEPTY" send-key "$sid" enter >/dev/null 2>&1 || true
  sleep 2
  out=$(run_check); rc=$?
  say "$out"
  [ "$rc" -eq 0 ] && say "dispatch-verify: recovered via Enter-resend (the inject was unsubmitted — #412)."
fi

exit "$rc"
