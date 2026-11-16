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

sid=""; settle_ms=6000; quiet=0; resubmit=0; observe_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --settle-ms) settle_ms="$2"; shift 2;;
    --resubmit) resubmit=1; shift;;
    # Task 1270: observe, never act. For a busy-admitted (bound) delivery the session was
    # ALREADY working, so no key may be sent and a spinner that may predate the queued body
    # is not a receipt for it — this mode never resubmits and never prints VERIFIED.
    --observe-only) observe_only=1; shift;;
    --quiet) quiet=1; shift;;
    -h|--help) sed -n '2,22p' "$0"; exit 0;;
    -*) echo "dispatch-verify.sh: unknown arg: $1" >&2; exit 4;;
    *) sid="$1"; shift;;
  esac
done
case "$(uname -s)" in MINGW*|MSYS*) echo "dispatch-verify.sh: needs confined worker sessions, unavailable on native Windows (SANDBOX_PLATFORM_UNSUPPORTED); use WSL2" >&2; exit 78;; esac
[ -n "$sid" ] || { echo "dispatch-verify.sh: <sid> required" >&2; exit 4; }

say() { [ "$quiet" -eq 1 ] || echo "$@"; }

# Task 1270: run_check runs in a command substitution, so its policy answer cannot reach the
# resubmit gate through a variable. It is published here instead, and read back below. An
# unavailable temp dir must never fail a verification that used to need no temp file at all:
# the name stays empty, nothing is written, and the resubmit gate below fails closed.
POLICY_ACTION_FILE="$(mktemp "${TMPDIR:-/tmp}/dispatch-verify-action.XXXXXX" 2>/dev/null || true)"
trap '[ -n "$POLICY_ACTION_FILE" ] && rm -f "$POLICY_ACTION_FILE"' EXIT

# Task 1270: the Enter-resend is POLICY-controlled, not marker-controlled. policy.py answers
# RESUBMIT_ENTER only for the not-moving startup surfaces (unsubmitted/idle/welcome/modal/
# sandbox_prompt); a current_busy session (surface=working) gets ESCALATE instead. So a
# `[not-moving]` marker in the SUSPECT text can no longer send a bare Enter into a composer
# that is already carrying input. Fail closed: no readable action, no key.
policy_wants_enter() {
  [ -s "$POLICY_ACTION_FILE" ] || return 1
  grep -q '"action"[[:space:]]*:[[:space:]]*"RESUBMIT_ENTER"' "$POLICY_ACTION_FILE"
}

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
  if [ -n "$POLICY_ACTION_FILE" ]; then printf '%s' "$action_json" > "$POLICY_ACTION_FILE"; fi
  STATE_JSON="$state_json" ACTION_JSON="$action_json" SID="$sid" OBSERVE_ONLY="$observe_only" python3 - <<'PY'
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
    # Task 1270: a busy-admitted delivery may never be reported as freshly verified — the
    # spinner this reads can belong to the turn that was already running when the body was
    # queued. The observation is printed, the word VERIFIED is not.
    if os.environ.get("OBSERVE_ONLY") == "1":
        print(f"OBSERVED {sid} — CONNECTED + ready + clean + moving, but a working spinner may predate "
              "the queued body: accepted-pending, not started-verified.")
        sys.exit(0)
    print(f"VERIFIED {sid} — CONNECTED + ready + clean + moving (working-spinner). Started as intended.")
    sys.exit(0)

reason = "; ".join(str(p) for p in problems) if problems else action.get("reason", "not started")
print(f"SUSPECT {sid} — {reason}")
print("  → action: telepty read-screen "
      f"{sid} ; resolve the surface (answer modal / resend Enter / respawn) before treating as started.")
sys.exit(6)
PY
}

# Task 1275: `out=$(run_check); rc=$?` under `set -e` terminated the script on every non-zero
# verdict, so the SUSPECT print below and the whole --resubmit branch were unreachable. The
# verdict is captured without ending the run; nothing else about the exit contract changes.
rc=0
out=$(run_check) || rc=$?
say "$out"

if [ "$rc" -eq 6 ] && [ "$resubmit" -eq 1 ] && [ "$observe_only" -eq 0 ] && policy_wants_enter \
   && printf '%s' "$out" | grep -q '\[not-moving\]'; then
  say "dispatch-verify: not-moving → #412 submit-resend (send-key enter), re-verifying once..."
  "$TELEPTY" send-key "$sid" enter >/dev/null 2>&1 || true
  sleep 2
  rc=0
  out=$(run_check) || rc=$?
  say "$out"
  [ "$rc" -eq 0 ] && say "dispatch-verify: recovered via Enter-resend (the inject was unsubmitted — #412)."
fi

exit "$rc"
