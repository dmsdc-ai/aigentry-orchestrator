#!/usr/bin/env bash
# T28 — SessionProbe + Policy parity fixtures and INV-17 cleanup gate.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

python3 - "$REPO_ROOT" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
fixtures = root / "tests" / "fixtures" / "session-state"
probe = root / "bin" / "session-probe.py"
policy = root / "bin" / "policy.py"


def run_json(argv, stdin=None):
    proc = subprocess.run(
        [str(arg) for arg in argv],
        input=stdin,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(proc.stdout)


def assert_subset(name, got, want):
    for key, expected in want.items():
        actual = got.get(key)
        if actual != expected:
            raise AssertionError(f"{name}: {key}={actual!r}, want {expected!r}")


cases = json.loads((fixtures / "cases.json").read_text(encoding="utf-8"))
for case in cases:
    state = run_json(
        [
            probe,
            "--sid",
            "sid-A",
            "--screen-file",
            fixtures / case["screen"],
            "--info-file",
            fixtures / case["info"],
        ]
    )
    assert_subset(case["name"], state, case["expect_state"])
    assert_subset(f"{case['name']} detail", state["detail"], case["expect_detail"])
    decided = run_json(
        [policy, "--status", case["status"], "--state", "-"],
        stdin=json.dumps(state),
    )
    assert_subset(f"{case['name']} action", decided, case["expect_action"])


def decide(state, status="orphaned"):
    return run_json([policy, "--status", status, "--state", "-"], stdin=json.dumps(state))


base_cleanup_state = {
    "alive": True,
    "ready": False,
    "surface": "idle",
    "activity": "static",
    "cli": "claude",
    "detail": {"cleanup": {"age_seconds": 600, "gc_root": False, "keep_alive": False}},
}

surface_only = json.loads(json.dumps(base_cleanup_state))
surface_only["detail"]["cleanup"]["reasons"] = ["surface_gone"]
if decide(surface_only)["action"] == "CLEANUP":
    raise AssertionError("INV-17 regression: surface_gone alone produced CLEANUP")

corroborated = json.loads(json.dumps(base_cleanup_state))
corroborated["detail"]["cleanup"]["reasons"] = ["surface_gone", "disconnected"]
corroborated["detail"]["cleanup"]["disconnect_age_seconds"] = 360
clean = decide(corroborated)
assert_subset("cleanup corroborated", clean, {"action": "CLEANUP", "status": "cleanup_due"})

unknown = json.loads(json.dumps(corroborated))
unknown["surface"] = "unknown"
esc = decide(unknown)
assert_subset("unknown cleanup default", esc, {"action": "ESCALATE", "status": "orphaned"})

print(f"T28 PASS cases={len(cases)} cleanup_gate=3")
PY
