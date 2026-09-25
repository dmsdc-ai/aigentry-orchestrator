"""Read-only current-viewport adapters. No historical or active-window fallback."""

from __future__ import annotations

import json
import re
import subprocess
from typing import Any, Callable


MAX_RESPONSE_BYTES = 262144
COMMAND_TIMEOUT_SECONDS = 3
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


class ScreenUnavailable(Exception):
    """A content-free reason; never forward command stderr or screen text."""


def capture(argv: list[str]) -> str:
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True,
                                timeout=COMMAND_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired:
        raise ScreenUnavailable("current-screen command timed out") from None
    except OSError:
        raise ScreenUnavailable("current-screen command unavailable") from None
    if result.returncode:
        raise ScreenUnavailable("current-screen command failed")
    if len(result.stdout) > MAX_RESPONSE_BYTES:
        raise ScreenUnavailable("current-screen response too large")
    try:
        return result.stdout.decode("utf-8", errors="strict")
    except UnicodeError:
        raise ScreenUnavailable("current-screen response is not UTF-8") from None


def capture_object(argv: list[str]) -> dict[str, Any]:
    try:
        value = json.loads(capture(argv))
    except (ValueError, TypeError):
        raise ScreenUnavailable("current-screen response is not JSON") from None
    if not isinstance(value, dict):
        raise ScreenUnavailable("current-screen response is not an object")
    return value


def session_binding(info: dict[str, Any], sid: str) -> tuple[Any, ...]:
    transport = info.get("transport")
    if not isinstance(transport, dict):
        raise ScreenUnavailable("session transport unavailable")
    if (info.get("id") != sid or info.get("host") != "127.0.0.1"
            or info.get("healthStatus") != "CONNECTED" or info.get("ready") is not True
            or transport.get("health_status") != "CONNECTED"
            or transport.get("ready") is not True):
        raise ScreenUnavailable("session is not locally connected and ready")
    owner = info.get("ownerPid")
    pty = info.get("ptyPid")
    if type(owner) is not int or owner <= 1 or type(pty) is not int or pty <= 1:
        raise ScreenUnavailable("session process identity unavailable")
    for key in ("createdAt", "lastConnectedAt"):
        if not isinstance(info.get(key), str) or not info[key]:
            raise ScreenUnavailable("session incarnation unavailable")
    return tuple(info.get(key) for key in (
        "id", "host", "backend", "ownerPid", "ptyPid", "createdAt", "lastConnectedAt",
        "cmuxWorkspaceId", "cmuxSurfaceId"))


def uuid(value: Any) -> str:
    if not isinstance(value, str) or UUID.fullmatch(value) is None:
        raise ScreenUnavailable("terminal UUID unavailable")
    return value.lower()


def same_uuid(value: Any, expected: str) -> bool:
    return isinstance(value, str) and value.lower() == expected


def process_identity(pid: int) -> tuple[str, str]:
    # Match the bridge's terminal, not its child PTY or any title-derived PID.
    parts = capture(["ps", "-p", str(pid), "-o", "pid=,tty=,lstart="]).strip().split(None, 2)
    if (len(parts) != 3 or parts[0] != str(pid)
            or not re.fullmatch(r"(?:ttys?[A-Za-z0-9]+|pts/[0-9]+)", parts[1])
            or not parts[2].strip()):
        raise ScreenUnavailable("owner process identity unavailable")
    return parts[1], parts[2]


def cmux_terminal(workspace: str, surface: str) -> tuple[str, str, str]:
    data = capture_object(["cmux", "--json", "--id-format", "uuids", "tree",
                           "--workspace", workspace])
    matches = []
    try:
        for window in data["windows"]:
            for item in window["workspaces"]:
                if not same_uuid(item.get("id"), workspace):
                    continue
                for pane in item["panes"]:
                    for target in pane["surfaces"]:
                        if same_uuid(target.get("id"), surface):
                            if target.get("type") != "terminal":
                                raise ScreenUnavailable("surface is not a terminal")
                            matches.append((uuid(window.get("id")), uuid(pane.get("id")),
                                            target.get("tty")))
    except (KeyError, TypeError, AttributeError):
        raise ScreenUnavailable("terminal mapping malformed") from None
    if len(matches) != 1 or not isinstance(matches[0][2], str):
        raise ScreenUnavailable("terminal mapping unavailable or ambiguous")
    return matches[0]


def cmux_screen(info: dict[str, Any]) -> str:
    workspace = uuid(info.get("cmuxWorkspaceId"))
    surface = uuid(info.get("cmuxSurfaceId"))
    owner = info["ownerPid"]
    process_before = process_identity(owner)
    terminal_before = cmux_terminal(workspace, surface)
    if terminal_before[2] != process_before[0]:
        raise ScreenUnavailable("owner TTY does not match terminal")
    # cmux --lines implies scrollback even without --scrollback. Omit BOTH.
    response = capture_object(["cmux", "--json", "--id-format", "uuids", "read-screen",
                               "--workspace", workspace, "--surface", surface])
    if (not same_uuid(response.get("workspace_id"), workspace)
            or not same_uuid(response.get("surface_id"), surface)
            or not same_uuid(response.get("window_id"), terminal_before[0])):
        raise ScreenUnavailable("screen target mismatch")
    text = response.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ScreenUnavailable("current screen is blank")
    if re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", text):
        raise ScreenUnavailable("current screen contains unrendered controls")
    if (cmux_terminal(workspace, surface) != terminal_before
            or process_identity(owner) != process_before):
        raise ScreenUnavailable("terminal owner changed during read")
    return text


# A backend must implement the same target/currentness checks before admission.
# Unsupported terminals do not borrow the controller's cmux surface or history.
ADAPTERS: dict[str, Callable[[dict[str, Any]], str]] = {"cmux": cmux_screen}


def read_current_screen(sid: str, info: dict[str, Any],
                        refresh_info: Callable[[], dict[str, Any]]) -> tuple[str, str]:
    binding = session_binding(info, sid)
    backend = info.get("backend")
    adapter = ADAPTERS.get(backend) if isinstance(backend, str) else None
    if adapter is None:
        raise ScreenUnavailable("current-screen adapter unsupported")
    text = adapter(info)
    if session_binding(refresh_info(), sid) != binding:
        raise ScreenUnavailable("session changed during screen read")
    return text, backend + ":current-viewport"
