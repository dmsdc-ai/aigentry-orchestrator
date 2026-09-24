#!/usr/bin/env bash
# T28 — SessionProbe + Policy parity fixtures and INV-17 cleanup gate.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

python3 - "$REPO_ROOT" <<'PY'
import hashlib
import json
import subprocess
import sys
import tempfile
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
        if key not in got:
            raise AssertionError(f"{name}: {key} missing from result")
        actual = got[key]
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

    verify_action = run_json(
        [policy, "--status", "verify_started", "--state", "-"],
        stdin=json.dumps(state),
    )
    if "expect_verify_action" in case:
        expected = case["expect_verify_action"]
        if not isinstance(expected, dict) or not expected:
            raise AssertionError(f"{case['name']}: expect_verify_action must be a non-empty object")
        assert_subset(f"{case['name']} verify", verify_action, expected)
    if case["name"] in {"codex-init-spinner", "working-spinner"}:
        assert_subset(f"{case['name']} verify", verify_action, {"action": "NOOP", "status": "verified"})
    elif case["name"] == "unsubmitted-context-ref":
        assert_subset(
            f"{case['name']} verify",
            verify_action,
            {"action": "RESUBMIT_ENTER", "status": "verify_started", "key": "enter"},
        )

    tracker_action = run_json(
        [policy, "--status", "tracker_check", "--state", "-"],
        stdin=json.dumps(state),
    )
    if "expect_tracker_action" in case:
        expected = case["expect_tracker_action"]
        if not isinstance(expected, dict) or not expected:
            raise AssertionError(f"{case['name']}: expect_tracker_action must be a non-empty object")
        assert_subset(f"{case['name']} tracker", tracker_action, expected)
    cls = state["detail"]["tracker_class"]
    if cls == "welcome":
        assert_subset(f"{case['name']} tracker", tracker_action, {"action": "REDISPATCH", "status": "stuck_welcome"})
    elif cls == "error":
        assert_subset(f"{case['name']} tracker", tracker_action, {"action": "ESCALATE", "status": "stuck_error"})
    else:
        assert_subset(f"{case['name']} tracker", tracker_action, {"action": "NOOP"})


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

# ---------------------------------------------------------------------------
# #1136 - collapsed one-line Claude viewport: permanent regression oracles.
#
# telepty renders the whole Claude 2.1.281 TUI onto ONE physical line, so the
# idle glyph sits mid-line inside its input box and no positional arm in
# has_prompt reaches it. The session then reads ready=False / surface=unknown
# while it is in fact parked at an empty prompt, and dispatch waits on it
# forever. These oracles pin that shape so the miss cannot come back.
#
# The fixture is the viewport measured live on 2.1.281, embedded inline as
# documented segments: no new fixture file and no runtime host dependency.
# The digest assert below is what keeps those segments byte-faithful.
#
# Scope limit, stated on purpose: a verbatim copy of a whole viewport is
# indistinguishable from the viewport. These cases FRAME the glyph in its
# header-to-footer chrome; they do not authenticate it and they carry no
# currentness claim. That limit is inherent to reading text.
# ---------------------------------------------------------------------------

COLLAPSED_SHA256 = "530f53945237e2fd10d0bbf5b18cde8c2ded8f69223316a491088e59295bab32"

_PREFLIGHT = (
    "[sandbox] nb1170at-builder task=1170 "
    "attempt=7884dc50-b74a-422e-a508-7e307481f0c0 OS confinement preflight passed"
)
# Header identity + model/cwd chrome, a 79-column gap, then the mode indicator.
_HEAD = (
    " ▐▛███▛█Claude Codev2.1.281"
    "▝▜██████▀"
    "Opus 5 with medium effort \xb7 Claude Max  ▝▝ ▝▝  "
    "/Users/duckyoungkim/.aigentry/role-sandbox/builder-nb1170at-builder"
    + " " * 79
    + "◐ medium \xb7 /effort"
)
_RULE = "─" * 99                  # top and bottom rule of the input box
_GLYPH = "❯\xa0 "                 # glyph + NBSP + space == EMPTY input row
_FOOT = (
    "  ⏵⏵ accept edits on (shift+tab to cycle) \xb7 ← for agents"
    "    █▟█▟  ▟█▟█  ▛▛"
)
# The same footer with the mode-hint chrome removed: the half-framed negative.
_FOOT_BARE = (
    "  ⏵⏵ accept edits on \xb7 ← for agents"
    "    █▟█▟  ▟█▟█  ▛▛"
)

_BOX = _RULE + _GLYPH + _RULE
_COLLAPSED = _HEAD + _BOX + _FOOT
MEASURED_VIEWPORT = _PREFLIGHT + "\n" + _COLLAPSED + "\n"

_digest = hashlib.sha256(MEASURED_VIEWPORT.encode("utf-8")).hexdigest()
if _digest != COLLAPSED_SHA256:
    raise AssertionError(
        f"collapsed fixture drifted: sha256={_digest}, want {COLLAPSED_SHA256}"
    )

_READY = {"alive": True, "ready": True, "surface": "idle", "activity": "static", "cli": "claude"}
_READY_DETAIL = {
    "ready_reason": "prompt",
    "surface_detail": "idle prompt",
    # #1136 changes prompt POSITION handling only. tracker_class is untouched by
    # this slice and stays blank here; recorded, not adjusted.
    "tracker_class": "blank",
}
_MISS = {"alive": True, "ready": False, "surface": "unknown", "activity": "static", "cli": "claude"}
_MISS_DETAIL = {
    "ready_reason": "no-prompt",
    "surface_detail": "no known surface signal",
    "tracker_class": "blank",
}

COLLAPSED_CASES = [
    # 1 positive - the measured viewport reads as a ready, idle prompt.
    ("collapsed-claude-idle-measured", MEASURED_VIEWPORT, "claude", _READY, _READY_DETAIL),
    # 9 prose / blockquote / historical whitespace variants. Each quotes the box
    # in passing, carries it without full header-to-footer framing, and must
    # keep reading unknown.
    ("prose-chrome-without-header",
     "I saw the collapsed idle box render like this:\n" + _BOX + _FOOT + "\n",
     "claude", _MISS, _MISS_DETAIL),
    ("prose-chrome-without-footer",
     "Quoting the run:\n" + _HEAD + _BOX + _FOOT_BARE + "\n",
     "claude", _MISS, _MISS_DETAIL),
    ("prose-chrome-bare-inline",
     "we saw " + _BOX + " in the log\n",
     "claude", _MISS, _MISS_DETAIL),
    ("blockquote-box-quoted",
     "> " + _BOX + "\n",
     "claude", _MISS, _MISS_DETAIL),
    ("blockquote-box-indented-two",
     "  > " + _BOX + " (quoted)\n",
     "claude", _MISS, _MISS_DETAIL),
    ("historical-changelog-mention",
     "In v2.1.280 the idle row rendered as " + _BOX + " before the rework.\n",
     "claude", _MISS, _MISS_DETAIL),
    ("historical-prose-no-box",
     "Earlier transcript: Claude Code v2.1.281 started, then shift+tab to cycle appeared.\n",
     "claude", _MISS, _MISS_DETAIL),
    ("whitespace-glyph-no-gap",
     _HEAD + _RULE + "❯" + _RULE + _FOOT + "\n",
     "claude", _MISS, _MISS_DETAIL),
    ("whitespace-glyph-newline-split",
     _HEAD + _RULE + "❯ \n" + _RULE + _FOOT + "\n",
     "claude", _MISS, _MISS_DETAIL),
    # 7 structural guards on the shape itself.
    ("guard-header-only", _HEAD + _BOX + "\n", "claude", _MISS, _MISS_DETAIL),
    ("guard-footer-only", _BOX + _FOOT + "\n", "claude", _MISS, _MISS_DETAIL),
    ("guard-order-footer-before-header",
     _FOOT + _BOX + _HEAD + "\n", "claude", _MISS, _MISS_DETAIL),
    ("guard-occupied-input",
     _HEAD + _RULE + "❯\xa0 please run the tests" + _RULE + _FOOT + "\n",
     "claude", _MISS, _MISS_DETAIL),
    ("guard-fenced", "```\n" + _COLLAPSED + "\n", "claude", _MISS, _MISS_DETAIL),
    ("guard-indented", "Log excerpt:\n    " + _COLLAPSED + "\n", "claude", _MISS, _MISS_DETAIL),
    ("guard-nonfinal",
     _COLLAPSED + "\n[sandbox] session detached\n", "claude", _MISS, _MISS_DETAIL),
    # 2 other-CLI gates - the identical chrome must NOT be accepted off claude.
    ("other-cli-codex-full-chrome", MEASURED_VIEWPORT, "codex",
     dict(_MISS, cli="codex"), _MISS_DETAIL),
    ("other-cli-gemini-full-chrome", MEASURED_VIEWPORT, "gemini",
     dict(_MISS, cli="gemini"), _MISS_DETAIL),
    # 4 surface controls. The collapsed arm must not override a hard negative,
    # and must not erase or invent an error surface.
    ("control-collapsed-busy",
     _PREFLIGHT + "\n" + _HEAD + _BOX
     + "  ✶ Working… (12s \xb7 esc to interrupt) \xb7 (shift+tab to cycle)\n",
     "claude",
     {"alive": True, "ready": False, "surface": "working", "activity": "moving", "cli": "claude"},
     {"ready_reason": "hard-negative", "surface_detail": "working token", "tracker_class": "blank"}),
    ("control-collapsed-modal",
     "Do you trust the files in this folder?\n" + _COLLAPSED + "\n", "claude",
     {"alive": True, "ready": False, "surface": "modal", "activity": "static", "cli": "claude"},
     {"ready_reason": "hard-negative",
      "surface_detail": "trust-folder or continue modal", "tracker_class": "blank"}),
    ("control-collapsed-api-error",
     "API Error: 500 upstream connect error\n" + _COLLAPSED + "\n", "claude",
     {"alive": True, "ready": True, "surface": "error", "activity": "static", "cli": "claude"},
     {"ready_reason": "prompt",
      "surface_detail": "API/transport error banner", "tracker_class": "error"}),
    # The PRE-EXISTING api-error-plus-prompt semantic, pinned unchanged: a
    # line-start glyph under an error banner is ready=True AND surface=error on
    # baseline already. #1136 neither adds an error policy nor erases it.
    ("control-api-error-plus-linestart-prompt",
     "API Error: 500 upstream connect error\n❯ \n", "claude",
     {"alive": True, "ready": True, "surface": "error", "activity": "static", "cli": "claude"},
     {"ready_reason": "prompt",
      "surface_detail": "API/transport error banner", "tracker_class": "error"}),
]


def probe_synthetic(tmp_root, index, screen, command):
    """Drive the REAL probe entrypoint over synthetic, temporary screen/info files."""
    screen_file = tmp_root / f"case-{index}.screen"
    screen_file.write_text(screen, encoding="utf-8")
    info_file = tmp_root / f"case-{index}.info"
    info_file.write_text(
        json.dumps(
            {
                "id": "sid-A",
                "command": command,
                "healthStatus": "CONNECTED",
                "ready": True,
                "transport": {"ready": True, "bootstrap": {"ready": True}},
            }
        ),
        encoding="utf-8",
    )
    return run_json(
        [probe, "--sid", "sid-A", "--screen-file", screen_file, "--info-file", info_file]
    )


# Every new case reports, so one miss does not hide the rest; the run still
# raises afterwards. The temp root is owned by the context manager.
collapsed_failures = []
with tempfile.TemporaryDirectory(prefix="t28-collapsed-") as tmp_name:
    tmp_root = Path(tmp_name)
    for index, entry in enumerate(COLLAPSED_CASES):
        name, screen, command, want_state, want_detail = entry
        observed = probe_synthetic(tmp_root, index, screen, command)
        for label, got, want in (
            (f"collapsed/{name}", observed, want_state),
            (f"collapsed/{name} detail", observed["detail"], want_detail),
        ):
            try:
                assert_subset(label, got, want)
            except AssertionError as exc:
                collapsed_failures.append(str(exc))

if collapsed_failures:
    for failure in collapsed_failures:
        print(f"T28 COLLAPSED FAIL: {failure}", file=sys.stderr)
    raise AssertionError(
        f"#1136 collapsed-viewport oracles failed "
        f"{len(collapsed_failures)} of {len(COLLAPSED_CASES)} cases"
    )

print(
    f"T28 PASS cases={len(cases)} cleanup_gate=3 "
    f"collapsed_viewport={len(COLLAPSED_CASES)}"
)
PY
