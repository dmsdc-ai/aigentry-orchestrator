#!/usr/bin/env bash
# T66 — policy.py splits the overloaded ESCALATE (ADR 2026-07-26-hitl-gate-primitive §1).
# surface=error ⇒ AWAIT_USER; every ambiguity default stays ESCALATE (autonomy-boundary drift guard).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

python3 - "$REPO_ROOT" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

policy = Path(sys.argv[1]) / "bin" / "policy.py"


def decide(state, status="in_flight"):
    proc = subprocess.run(
        [str(policy), "--status", status, "--state", "-"],
        input=json.dumps(state),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)


def alive(surface, **detail):
    return {
        "alive": True,
        "ready": False,
        "surface": surface,
        "activity": "static",
        "cli": "claude",
        "detail": detail,
    }


# The one flipped row: operator classification is a human decision, not an ambiguity default.
got = decide(alive("error"))
if got["action"] != "AWAIT_USER":
    raise AssertionError(f"surface=error: action={got['action']!r}, want 'AWAIT_USER'")
if got["reason"] != "API/transport error requires operator classification":
    raise AssertionError(f"surface=error: reason drifted -> {got['reason']!r}")
if got["status"] != "stuck_error":
    raise AssertionError(f"surface=error: status={got['status']!r}, want 'stuck_error'")

# Drift guard — the ambiguity defaults (96.7% of today's escalation log) stay ESCALATE.
ambiguity = [
    ("surface=unknown", alive("unknown"), "in_flight"),
    ("probe failed", alive("unknown", probe_error="session-probe failed"), "in_flight"),
    ("unhandled surface", alive("teleported"), "in_flight"),
    ("not alive, death uncorroborated", {"alive": False, "surface": "idle", "detail": {}}, "in_flight"),
    ("verify did not start", alive("error"), "verify_started"),
    ("tracker class=error", alive("error", tracker_class="error"), "tracker_check"),
]
for name, state, status in ambiguity:
    got = decide(state, status)
    if got["action"] != "ESCALATE":
        raise AssertionError(f"{name}: action={got['action']!r}, want 'ESCALATE' (autonomy boundary moved)")

print(f"T66 PASS await_user=1 escalate_unchanged={len(ambiguity)}")
PY
