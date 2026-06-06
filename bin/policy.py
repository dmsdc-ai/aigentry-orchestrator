#!/usr/bin/env python3
"""Pure Session Reconcile Loop policy: (registry status, SessionState) -> Action."""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, TextIO


ACTIVE_STATUSES = {"", "in_flight", "re_dispatched", "stuck_welcome"}
VERIFY_STATUS = "verify_started"
TRACKER_STATUS = "tracker_check"
SURFACE_UNKNOWN = "unknown"
AGE_FLOOR_SECONDS = 300
DISCONNECT_FLOOR_SECONDS = 240


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Decide a reconcile Action for a SessionState.")
    parser.add_argument("--status", required=True, help="Dispatch Registry entry status.")
    parser.add_argument(
        "--state",
        required=True,
        type=argparse.FileType("r", encoding="utf-8"),
        help="Path to state JSON, or '-' for stdin.",
    )
    return parser.parse_args()


def load_state(handle: TextIO) -> dict[str, Any]:
    raw = handle.read()
    try:
        value = json.loads(raw or "{}")
    except Exception:
        return {
            "alive": False,
            "ready": False,
            "surface": SURFACE_UNKNOWN,
            "activity": "static",
            "cli": "unknown",
            "detail": {"probe_error": "state JSON parse failed"},
        }
    return value if isinstance(value, dict) else {}


def action(name: str, reason: str, status: str, key: str | None = None) -> dict[str, str]:
    value = {"action": name, "reason": reason, "status": status}
    if key:
        value["key"] = key
    return value


def detail(state: dict[str, Any]) -> dict[str, Any]:
    value = state.get("detail")
    return value if isinstance(value, dict) else {}


def cleanup_detail(state: dict[str, Any]) -> dict[str, Any]:
    d = detail(state)
    value = d.get("cleanup")
    if isinstance(value, dict):
        return value
    return {}


def int_value(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def cleanup_allowed(state: dict[str, Any]) -> tuple[bool, str]:
    cleanup = cleanup_detail(state)
    if not cleanup:
        return False, "no cleanup gate data"
    if cleanup.get("gc_root") is True:
        return False, "gc_root session excluded"
    if cleanup.get("keep_alive") is True:
        return False, "keep_alive session excluded"

    age = int_value(cleanup.get("age_seconds"))
    if age < AGE_FLOOR_SECONDS:
        return False, f"age floor not met ({age}s < {AGE_FLOOR_SECONDS}s)"

    raw_reasons = cleanup.get("reasons", [])
    if isinstance(raw_reasons, str):
        reasons = [part for part in re.split(r"[, ]+", raw_reasons) if part]
    elif isinstance(raw_reasons, list):
        reasons = [str(part) for part in raw_reasons if str(part)]
    else:
        reasons = []
    if not reasons:
        return False, "no cleanup corroboration"
    if reasons == ["surface_gone"]:
        return False, "INV-17: surface_gone single-signal"

    pid_signal = any(reason in {"pid_dead", "no_parent_pid"} for reason in reasons)
    disconnect_age = int_value(cleanup.get("disconnect_age_seconds"))
    disconnect_signal = any(reason.startswith("disconnected") for reason in reasons)
    if disconnect_signal and disconnect_age < DISCONNECT_FLOOR_SECONDS:
        disconnect_signal = False

    if not pid_signal and not disconnect_signal:
        return False, "INV-17: missing pid/disconnect corroboration"
    return True, "INV-17 cleanup gate satisfied"


def decide(status: str, state: dict[str, Any]) -> dict[str, str]:
    d = detail(state)
    surface = str(state.get("surface") or SURFACE_UNKNOWN)
    alive = bool(state.get("alive"))
    activity = str(state.get("activity") or "static")
    health = str(d.get("health") or "")

    if d.get("probe_error"):
        return action("ESCALATE", f"probe failed: {d.get('probe_error')}", status)
    if surface == SURFACE_UNKNOWN:
        return action("ESCALATE", "ambiguous SessionState surface=unknown", status)

    if status == VERIFY_STATUS:
        if d.get("verify_started") is True:
            return action("NOOP", "session verified started-working", "verified")
        if surface == "thinking_block":
            return action("RESPAWN", "thinking-block / invalid request", status)
        if surface in {"unsubmitted", "idle", "welcome", "modal", "sandbox_prompt"}:
            return action("RESUBMIT_ENTER", "not-moving startup surface", status, key="enter")
        return action("ESCALATE", "session did not verify started-working", status)

    if status == TRACKER_STATUS:
        cls = str(d.get("tracker_class") or "blank")
        if cls == "error":
            return action("ESCALATE", "tracker legacy class=error", "stuck_error")
        if cls == "welcome":
            return action("REDISPATCH", "tracker legacy class=welcome", "stuck_welcome")
        if cls == "active":
            return action("NOOP", "tracker legacy class=active", "in_flight")
        return action("NOOP", f"tracker legacy class={cls}; auto-report candidate", "in_flight")

    allow_cleanup, cleanup_reason = cleanup_allowed(state)
    if allow_cleanup:
        return action("CLEANUP", cleanup_reason, "cleanup_due")

    if not alive and health.upper() == "DISCONNECTED":
        return action("REDISPATCH", "session disconnected while dispatch is active", "re_dispatched")
    if not alive:
        return action("ESCALATE", "session is not alive but death is not corroborated", status)

    if surface == "unsubmitted":
        return action("RESUBMIT_ENTER", "context-ref is still at live prompt", status, key="enter")
    if surface in {"modal", "sandbox_prompt"}:
        return action("SEND_KEY", f"{surface} can be advanced with Enter", status, key="enter")
    if surface == "thinking_block":
        return action("RESPAWN", "thinking-block / invalid request requires respawn", "respawn_requested")
    if surface in {"raw_shell", "crash"}:
        return action("REDISPATCH", f"{surface} means wrapped CLI exited or crashed", "re_dispatched")
    if surface == "error":
        return action("ESCALATE", "API/transport error requires operator classification", "stuck_error")
    if surface == "welcome" and status in ACTIVE_STATUSES:
        return action("REDISPATCH", "session is still at welcome/bootstrap prompt", "re_dispatched")
    if surface == "working" or activity == "moving":
        return action("NOOP", "session is actively working", status)
    if surface == "idle":
        return action("NOOP", "idle prompt; wait for REPORT or auto-report evidence", status)
    return action("ESCALATE", f"unhandled surface={surface}", status)


def main() -> int:
    args = parse_args()
    state = load_state(args.state)
    result = decide(args.status, state)
    json.dump(result, sys.stdout, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
