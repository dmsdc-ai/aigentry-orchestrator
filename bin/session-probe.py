#!/usr/bin/env python3
"""Observe one telepty Session and emit a SessionState JSON value."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Any


SURFACE_UNKNOWN = "unknown"
BRAILLE = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f"

BANNERS = {
    "claude": r"Welcome back|Tips for getting started|Trust this folder|Do you want to enable|Press Enter to continue",
    "codex": r"Welcome to .*Codex|OpenAI Codex CLI|Loading\u2026|Initializing",
    "gemini": r"Welcome to Gemini|Loading model|Initializing|Authenticating",
}
PROMPTS = {"claude": r"\u276f", "codex": r"\u203a", "gemini": r"\u203a|\u2502 >"}
HARD_NEG = r"Working\.\.\.|Thinking|esc to interrupt|Press Enter to continue|Do you trust"

TRUST_MODAL = r"trust this folder|do you trust|Yes, (proceed|I trust)|Press Enter to continue"
SANDBOX_PROMPT = r"Allow command\?|sandbox.*approv|approve this command|Do you want to (run|allow)"
API_ERROR = r"API Error|api error|status 400|overloaded_error|rate.?limit|529|ECONNREFUSED|ETIMEDOUT"
THINKING_BLOCK = r"thinking.*block|invalid_request_error"
CRASH = r"panic:|Traceback \(most recent|Segmentation fault|core dumped"
UNSUBMITTED = r"\[context-ref\]|/shared/[0-9a-f]{6,}\.md"
WORKING = r"esc to interrupt|Working\s*\(|Working\.\.\.|\u273b|\u23fa|\u27f3|Thinking|Compacting|Esc to interrupt"
TRACKER_ERR = r"error:|traceback|panic:|command not found|killed:|exited [0-9]+"
TRACKER_WELCOME = r"Welcome back|Tips for getting started|Trust this folder|Press Enter to continue"
TRACKER_ACTIVE_TEXT = r"\(esc to interrupt\)|thinking with xhigh effort|\u23f5\s*\d+s"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Emit SessionState JSON for a telepty sid.")
    parser.add_argument("--sid", required=True)
    parser.add_argument("--screen-file", help="Read captured screen text instead of telepty.")
    parser.add_argument("--info-file", help="Read captured session-info JSON instead of telepty.")
    parser.add_argument("--cli", help="Override CLI kind for caller-owned readiness checks.")
    parser.add_argument("--screen-lines", type=int, default=60)
    parser.add_argument("--telepty", default=os.environ.get("TELEPTY", "telepty"))
    return parser.parse_args()


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def load_json_text(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text or "{}")
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def run_capture(argv: list[str]) -> tuple[int, str, str]:
    proc = subprocess.run(argv, check=False, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def field(data: dict[str, Any], *path: str, default: Any = None) -> Any:
    cur: Any = data
    for part in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part, default)
    return cur


def nonempty_lines(text: str) -> list[str]:
    return [line.rstrip() for line in text.splitlines() if line.strip()]


def tail(lines: list[str], count: int) -> str:
    return "\n".join(lines[-count:])


def cli_from_info_or_screen(info: dict[str, Any], screen: str, override: str = "") -> str:
    if override:
        return override
    raw = " ".join(
        str(v or "")
        for v in (
            info.get("command"),
            info.get("cli"),
            field(info, "transport", "command"),
            field(info, "transport", "cli"),
        )
    ).lower()
    if "codex" in raw:
        return "codex"
    if "gemini" in raw:
        return "gemini"
    if "claude" in raw:
        return "claude"
    if re.search(r"OpenAI Codex CLI|Welcome to .*Codex", screen, re.I):
        return "codex"
    if re.search(r"Welcome to Gemini", screen, re.I):
        return "gemini"
    return "claude"


def tracker_class(screen: str) -> str:
    lines = nonempty_lines(screen)
    if not lines:
        return "blank"
    tail20 = tail(lines, 20)
    last3 = tail(lines, 3)
    if re.search(TRACKER_ERR, tail20, re.I):
        return "error"
    welcome_in_tail = re.search(TRACKER_WELCOME, tail20, re.I)
    prompt_in_last3 = (
        re.search(r"^[\u276f\u203a]", last3, flags=re.MULTILINE) is not None
        or "\u276f" in last3
        or "\u203a" in last3
    )
    placeholder = re.search(r'[\u276f\u203a]\s+Try "[^"]+"', last3)
    if welcome_in_tail and (placeholder or prompt_in_last3):
        return "welcome"
    if any(ch in tail20 for ch in BRAILLE) or re.search(TRACKER_ACTIVE_TEXT, tail20, re.I):
        return "active"
    if prompt_in_last3:
        return "done"
    return "blank"


def ready_by_screen(cli: str, screen: str) -> tuple[bool, str]:
    lines = nonempty_lines(screen)
    if not lines:
        return False, "blank-screen"
    tail20 = tail(lines, 20)
    last3 = tail(lines, 3)
    banner = BANNERS.get(cli, r"Welcome|Initializing|Loading|Tips for getting started")
    prompt = PROMPTS.get(cli, r"\u276f|\u203a")

    if re.search(HARD_NEG, last3, re.I):
        return False, "hard-negative"
    if re.search(rf'(?m){prompt}\s+Try "[^"]+"', tail20) or re.search(prompt, tail20):
        return True, "prompt"
    if re.search(banner, tail20, re.I):
        return False, "banner"
    return False, "no-prompt"


def classify_surface(cli: str, screen: str) -> tuple[str, str]:
    lines = nonempty_lines(screen)
    if not lines:
        return SURFACE_UNKNOWN, "blank screen"
    tail20 = tail(lines, 20)
    last4 = tail(lines, 4)

    if re.search(THINKING_BLOCK, tail20, re.I):
        return "thinking_block", "thinking-block / invalid request"
    if re.search(SANDBOX_PROMPT, tail20, re.I):
        return "sandbox_prompt", "sandbox approval prompt"
    if re.search(TRUST_MODAL, tail20, re.I):
        return "modal", "trust-folder or continue modal"
    if re.search(CRASH, tail20, re.I):
        return "crash", "crash / traceback"
    if re.search(API_ERROR, tail20, re.I):
        return "error", "API/transport error banner"
    if re.search(r"(\$|%|\u279c)\s*$", tail20) and not re.search(
        r"esc to interrupt|Working|\u276f|\u203a|\u273b|Esc to", tail20, re.I
    ):
        return "raw_shell", "raw shell prompt at tail"
    if re.search(UNSUBMITTED, last4):
        return "unsubmitted", "context-ref still at live prompt"
    if re.search(WORKING, tail20, re.I) or any(ch in tail20 for ch in BRAILLE):
        return "working", "working token"

    banner = BANNERS.get(cli, r"Welcome|Initializing|Loading|Tips for getting started")
    prompt = PROMPTS.get(cli, r"\u276f|\u203a")
    if re.search(banner, tail20, re.I):
        return "welcome", "welcome/bootstrap banner"
    if re.search(prompt, tail20):
        return "idle", "idle prompt"
    return SURFACE_UNKNOWN, "no known surface signal"


def verification_problems(
    health: str,
    transport_ready: bool,
    bootstrap_ready: bool,
    surface: str,
    activity: str,
    screen: str,
) -> list[str]:
    problems: list[str] = []
    if health and "CONNECTED" not in health.upper():
        problems.append(f"transport {health} (not CONNECTED)")
    if not transport_ready or not bootstrap_ready:
        problems.append("not ready / bootstrap not ready")
    if surface == "modal":
        problems.append("trust-folder modal - needs an answer")
    elif surface == "sandbox_prompt":
        problems.append("codex sandbox approval prompt - answer it")
    elif surface == "error":
        problems.append("API/transport error banner")
    elif surface == "thinking_block":
        problems.append("thinking-block / invalid request")
    elif surface == "crash":
        problems.append("crash / traceback")
    elif surface == "raw_shell":
        problems.append("raw shell prompt at tail - wrapped CLI may have exited")
    elif surface == "unsubmitted":
        problems.append("injected context-ref still at the live prompt - unsubmitted inject [not-moving]")
    elif activity != "moving":
        churn_note = "idle/static"
        if re.search(r"Initializing|Loading|Welcome", screen, re.I):
            churn_note = "likely spawn-init"
        problems.append(f"no working spinner ({churn_note}) [not-moving]")
    return problems


def observe(args: argparse.Namespace) -> dict[str, Any]:
    probe_error = ""
    if args.info_file:
        info_text = read_text(args.info_file)
        info = load_json_text(info_text)
    else:
        rc, out, err = run_capture([args.telepty, "session", "info", args.sid, "--json"])
        info = load_json_text(out)
        if rc != 0 or not out.strip():
            probe_error = (err or "session info unavailable").strip()

    if args.screen_file:
        screen = read_text(args.screen_file)
    else:
        rc, out, err = run_capture(
            [args.telepty, "read-screen", args.sid, "--lines", str(args.screen_lines)]
        )
        screen = out
        if rc != 0 and not probe_error:
            probe_error = (err or "read-screen unavailable").strip()

    cli = cli_from_info_or_screen(info, screen, args.cli or "")
    health = str(field(info, "healthStatus") or field(info, "transport", "health_status") or "")
    transport_ready = bool(field(info, "ready")) or bool(field(info, "transport", "ready"))
    raw_bootstrap = field(info, "transport", "bootstrap", "ready")
    bootstrap_ready = True if raw_bootstrap is None else bool(raw_bootstrap)
    alive = bool(info) and (not health or "CONNECTED" in health.upper())

    surface, surface_detail = classify_surface(cli, screen)
    unsubmitted = surface == "unsubmitted"
    working_token = surface == "working"
    activity = "moving" if working_token and not unsubmitted else "static"
    screen_ready, ready_reason = ready_by_screen(cli, screen)
    ready = bool(alive and transport_ready and bootstrap_ready and screen_ready)
    problems = verification_problems(
        health, transport_ready, bootstrap_ready, surface, activity, screen
    )
    verified_started = bool(alive and transport_ready and bootstrap_ready and not problems)

    detail: dict[str, Any] = {
        "health": health,
        "transport_ready": transport_ready,
        "bootstrap_ready": bootstrap_ready,
        "ready_reason": ready_reason,
        "surface_detail": surface_detail,
        "tracker_class": tracker_class(screen),
        "verify_started": verified_started,
        "verify_problems": problems,
    }
    if probe_error:
        detail["probe_error"] = probe_error

    return {
        "alive": alive,
        "ready": ready,
        "surface": surface,
        "activity": activity,
        "cli": cli,
        "detail": detail,
    }


def main() -> int:
    args = parse_args()
    state = observe(args)
    json.dump(state, sys.stdout, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
