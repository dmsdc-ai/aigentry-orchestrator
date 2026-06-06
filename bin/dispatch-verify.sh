#!/usr/bin/env bash
# dispatch-verify.sh — Post-dispatch session-START verification (Rule 33).
#
# WHY THIS EXISTS:
#   dispatch.sh --verify-delivered confirms the inject LANDED (placeholder
#   cleared / first ref line echoed). That is NOT the same as "the session
#   actually started working as intended". A session can accept an inject and
#   then sit at a trust-folder modal, an API-error banner, a codex sandbox
#   approval prompt, a raw shell prompt, or a crash — delivered, but not started.
#   Rule 33: after EVERY delegation, verify the session started as intended.
#   Do not declare "started" from a garbled screen + a printed plan alone.
#
# WHAT IT CHECKS (two probes ~settle apart):
#   1. ALIVE  — transport healthStatus CONNECTED + ready + bootstrap.ready
#   2. CLEAN  — no stuck/error surface on screen (trust modal, API error,
#               crash/traceback, raw shell prompt, codex sandbox approval)
#   3. MOVING — actively progressing: a working spinner is shown, OR the screen
#               churns / lastActivityAt advances between the two probes
#
# --resubmit (#412 codex submit race): if the only problem is "not moving"
#   (idle = the submit CR likely never registered — codex paste/spinner race
#   leaves the injected text unsubmitted, the "Enter 안눌렸어" failure mode),
#   send a single `telepty send-key <sid> enter` and re-probe once before
#   declaring SUSPECT. Recovers the unsubmitted-inject case without re-injecting.
#
# Usage:
#   dispatch-verify.sh <sid> [--settle-ms 6000] [--resubmit] [--quiet]
# Exit codes:
#   0  verified — session started working as intended
#   2  session not found / no transport info
#   4  usage error
#   6  SUSPECT — delivered but NOT started as intended (act on the printed reason)
set -euo pipefail

TELEPTY="${TELEPTY:-telepty}"

sid=""; settle_ms=6000; quiet=0; resubmit=0
while [ $# -gt 0 ]; do
  case "$1" in
    --settle-ms) settle_ms="$2"; shift 2;;
    --resubmit) resubmit=1; shift;;
    --quiet) quiet=1; shift;;
    -h|--help) sed -n '2,40p' "$0"; exit 0;;
    -*) echo "dispatch-verify.sh: unknown arg: $1" >&2; exit 4;;
    *) sid="$1"; shift;;
  esac
done
[ -n "$sid" ] || { echo "dispatch-verify.sh: <sid> required" >&2; exit 4; }

# run_check — one full verification cycle (two probes ~settle apart). Prints the
# VERIFIED/SUSPECT verdict line(s) to stdout; returns 0 / 2 / 6.
run_check() {
  local info1 screen1 info2 screen2
  info1=$("$TELEPTY" session info "$sid" --json 2>/dev/null || true)
  if [ -z "$info1" ]; then
    echo "SUSPECT $sid — session not found / no transport info (spawn failed or wrong sid)"
    return 2
  fi
  screen1=$("$TELEPTY" read-screen "$sid" --lines 40 2>/dev/null || true)
  sleep "$(python3 -c "print(max(0,$settle_ms)/1000)")"
  info2=$("$TELEPTY" session info "$sid" --json 2>/dev/null || true)
  screen2=$("$TELEPTY" read-screen "$sid" --lines 40 2>/dev/null || true)

  INFO1="$info1" INFO2="$info2" SCREEN1="$screen1" SCREEN2="$screen2" SID="$sid" python3 - <<'PY'
import json, os, re, sys

sid = os.environ["SID"]
def load(k):
    try: return json.loads(os.environ.get(k, "") or "{}")
    except Exception: return {}
i1, i2 = load("INFO1"), load("INFO2")
s1, s2 = os.environ.get("SCREEN1", ""), os.environ.get("SCREEN2", "")

def field(d, *path, default=None):
    cur = d
    for p in path:
        if not isinstance(cur, dict): return default
        cur = cur.get(p, default)
    return cur

health = field(i2, "healthStatus") or field(i2, "transport", "health_status") or ""
ready  = bool(field(i2, "ready")) or bool(field(i2, "transport", "ready"))
boot_ready = field(i2, "transport", "bootstrap", "ready")
boot_ready = True if boot_ready is None else bool(boot_ready)  # absent ⇒ don't penalize
last1 = str(field(i1, "lastActivityAt") or "")
last2 = str(field(i2, "lastActivityAt") or "")

tail = "\n".join([l for l in s2.splitlines() if l.strip()][-18:])

# --- 1. ALIVE ---
problems = []
if health and "CONNECTED" not in health.upper():
    problems.append(f"transport {health} (not CONNECTED)")
if not ready or not boot_ready:
    problems.append("not ready / bootstrap not ready (still booting or gated)")

# --- 2. CLEAN (stuck/error surfaces) ---
HARD = [
    (r"trust this folder|do you trust|Yes, (proceed|I trust)", "trust-folder modal — needs an answer"),
    (r"API Error|api error|status 400|overloaded_error|rate.?limit|529|ECONNREFUSED|ETIMEDOUT", "API/transport error banner"),
    (r"thinking.*block|invalid_request_error", "thinking-block / invalid request (claude #502 — respawn, do not nudge)"),
    (r"panic:|Traceback \(most recent|Segmentation fault|core dumped", "crash / traceback"),
    (r"Allow command\?|sandbox.*approv|approve this command|Do you want to (run|allow)", "codex sandbox approval prompt — answer it (Rule 30 autonomy)"),
]
for rx, why in HARD:
    if re.search(rx, tail, re.I):
        problems.append(why)

# raw shell prompt at tail with no CLI chrome ⇒ the CLI exited
if re.search(r"(\$|%|➜)\s*$", tail) and not re.search(r"esc to interrupt|Working|❯|›|✻|Esc to", tail, re.I):
    problems.append("raw shell prompt at tail — wrapped CLI may have exited")

# --- 3. MOVING ---
working_tok = re.search(r"esc to interrupt|Working\s*\(|✻|⠋|⠙|⠹|⠸|Thinking|Compacting|Esc to interrupt", s2, re.I)
churned = (s1 != s2) or (last1 and last2 and last1 != last2)
moving = bool(working_tok) or bool(churned)
# Tag the not-moving case distinctly so the caller can try a submit-resend (#412).
NOT_MOVING_TAG = "[not-moving]"
if not moving:
    problems.append(f"no activity across probes {NOT_MOVING_TAG} (idle/stuck, unsubmitted inject, or finished without reporting)")

if problems:
    print(f"SUSPECT {sid} — {'; '.join(problems)}")
    print(f"  → action: telepty read-screen {sid} ; resolve the surface (answer modal / resend Enter / respawn) before treating as started.")
    sys.exit(6)

sig = "working-spinner" if working_tok else "screen-churn/activity"
print(f"VERIFIED {sid} — CONNECTED + ready + clean + moving ({sig}). Started as intended.")
sys.exit(0)
PY
}

say() { [ "$quiet" -eq 1 ] || echo "$@"; }

out=$(run_check); rc=$?
say "$out"

# #412 recovery: the ONLY problem is "not moving" (unsubmitted inject) → the
# submit CR likely never registered. Send a single Enter and re-verify once.
if [ "$rc" -eq 6 ] && [ "$resubmit" -eq 1 ] && printf '%s' "$out" | grep -q '\[not-moving\]'; then
  say "dispatch-verify: not-moving → #412 submit-resend (send-key enter), re-verifying once…"
  "$TELEPTY" send-key "$sid" enter >/dev/null 2>&1 || true
  sleep 2
  out=$(run_check); rc=$?
  say "$out"
  [ "$rc" -eq 0 ] && say "dispatch-verify: ✅ recovered via Enter-resend (the inject was unsubmitted — #412)."
fi

exit $rc
