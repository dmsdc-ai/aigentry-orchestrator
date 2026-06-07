#!/usr/bin/env python3
"""
Regression test for #547 — CWE-78 (OS/AppleScript command injection) in
bin/session-layout.py:position_windows.

Snyk traced a taint flow: the `--orchestrator=<value>` CLI argument
(sys.argv) → orchestrator_id → arrange_sessions → ordered → session_id →
win_map.get(session_id) → interpolated into the osascript program.

The fix coerces every interpolated value to int() right before building the
AppleScript. This test locks in two properties:

  1. (fail-closed) A non-integer / malicious win_map value never reaches the
     osascript sink — int() raises ValueError first, so no command is run.
  2. (behavior identical) Legitimate integer geometry still produces a
     well-formed AppleScript whose interpolated tokens are pure integers.

Run: python3 tests/bin/session-layout-injection.test.py
Exit 0 = pass, non-zero = fail. No external deps (stdlib only).
"""

import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODULE_PATH = os.path.join(ROOT, "bin", "session-layout.py")

spec = importlib.util.spec_from_file_location("session_layout", MODULE_PATH)
sl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sl)


def _patch(captured, bounds=(0, 25, 1800, 1169)):
    """Stub get_screen_bounds() and capture every run() call without exec."""
    sl.get_screen_bounds = lambda: bounds

    class _Res:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **kwargs):
        captured.append(cmd)
        return _Res()

    sl.run = fake_run


def test_malicious_winmap_value_fails_closed():
    """A non-integer win_map value must raise before reaching osascript."""
    captured = []
    _patch(captured)

    payload = '1}, {0, 0}\n" & (do shell script "touch /tmp/pwned") & "'
    ordered = ["aigentry-orchestrator-claude"]
    win_map = {"aigentry-orchestrator-claude": payload}

    raised = False
    try:
        sl.position_windows(ordered, 1, 1, win_map)
    except (ValueError, TypeError):
        raised = True

    assert raised, "expected int() coercion to reject the malicious win_idx"
    # The sink must never have been invoked with the payload.
    assert all(payload not in part for cmd in captured for part in cmd), \
        "payload reached the osascript command — injection not neutralized"
    print("PASS: malicious win_map value fails closed (no osascript call)")


def test_legitimate_path_unchanged():
    """Legitimate integer geometry still positions the window correctly."""
    captured = []
    _patch(captured)

    ordered = ["aigentry-orchestrator-claude"]
    win_map = {"aigentry-orchestrator-claude": 3}

    positioned, skipped = sl.position_windows(ordered, 1, 1, win_map)

    assert positioned == 1, f"expected 1 positioned window, got {positioned}"
    assert skipped == [], f"expected no skips, got {skipped}"
    assert len(captured) == 1, f"expected exactly 1 osascript call, got {len(captured)}"

    cmd = captured[0]
    assert cmd[0] == "osascript" and cmd[1] == "-e", f"unexpected sink cmd: {cmd!r}"
    script = cmd[2]
    # Window index 3 and integer geometry must appear as bare integers.
    assert "window 3" in script, f"window index not interpolated as int: {script!r}"
    assert "do shell script" not in script, "unexpected shell escape in script"
    print("PASS: legitimate integer path unchanged (window positioned)")


if __name__ == "__main__":
    test_malicious_winmap_value_fails_closed()
    test_legitimate_path_unchanged()
    print("ALL PASS (#547 CWE-78 regression)")
