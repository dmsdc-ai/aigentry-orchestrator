"""Read-only current-viewport adapters. No historical or active-window fallback."""

from __future__ import annotations

import json
import os
import re
import stat
import subprocess
from typing import Any, Callable


MAX_RESPONSE_BYTES = 262144
COMMAND_TIMEOUT_SECONDS = 12
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
# Task 1304 D2/D4: the adapter record bin/lib/workspace-host.sh writes at open, and the
# layer door that reads a non-cmux screen. Same sid rule and line format as the layer.
RECORD_SID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")
RECORD_ADAPTER = re.compile(r"[a-z]{1,32}")
WH_CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wh-cli.sh")
LAYER_UNSUPPORTED = 20


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
    bootstrap = transport.get("bootstrap")
    if bootstrap is not None and (not isinstance(bootstrap, dict)
                                  or bootstrap.get("ready") is not True):
        raise ScreenUnavailable("session bootstrap not ready")
    owner = info.get("ownerPid")
    pty = info.get("ptyPid")
    if type(owner) is not int or owner <= 1 or type(pty) is not int or pty <= 1:
        raise ScreenUnavailable("session process identity unavailable")
    for key in ("createdAt", "lastConnectedAt"):
        if not isinstance(info.get(key), str) or not info[key]:
            raise ScreenUnavailable("session incarnation unavailable")
    return (bootstrap.get("ready") if isinstance(bootstrap, dict) else None,) + tuple(info.get(key) for key in (
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


def recorded_adapter(sid: str) -> str | None:
    """The adapter that opened `sid`, from the layer's record; None when there is none.

    The record is data: one `v1<TAB>adapter<TAB>host_id` line, read without following a
    symlink, never executed. Anything malformed is treated as absent.

    No file name is composed from the sid: the state directory is opened once as a
    directory, its entries are LISTED, and only the entry whose name equals the expected
    record name is opened — relative to that directory's descriptor, with O_NOFOLLOW, and
    kept only if fstat says it is a regular file. A directory entry name carries no '/',
    so the open cannot leave the directory. Where the platform has no descriptor-relative
    open (Windows), there is no record: the reader stays the unchanged default below.
    """
    if RECORD_SID.fullmatch(sid) is None:
        return None
    o_directory = getattr(os, "O_DIRECTORY", None)
    o_nofollow = getattr(os, "O_NOFOLLOW", None)
    if (o_directory is None or o_nofollow is None or os.open not in os.supports_dir_fd
            or os.scandir not in os.supports_fd):
        return None
    want = sid + ".rec"
    root = os.environ.get("AIGENTRY_WH_STATE_DIR") or os.path.join(
        os.path.expanduser("~"), ".aigentry", "workspace-host")
    raw = b""
    dir_fd = -1
    try:
        dir_fd = os.open(root, os.O_RDONLY | o_directory)
        with os.scandir(dir_fd) as entries:
            name = next((e.name for e in entries
                         if e.name == want and e.is_file(follow_symlinks=False)), None)
        if name is None:
            return None
        fd = os.open(name, os.O_RDONLY | o_nofollow | getattr(os, "O_NONBLOCK", 0), dir_fd=dir_fd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return None
            raw = os.read(fd, 4097)
        finally:
            os.close(fd)
    except OSError:
        return None
    finally:
        if dir_fd >= 0:
            os.close(dir_fd)
    if len(raw) > 4096:
        return None
    try:
        fields = raw.decode("utf-8").split("\n", 1)[0].split("\t")
    except UnicodeError:
        return None
    if (len(fields) != 3 or fields[0] != "v1" or not fields[2]
            or RECORD_ADAPTER.fullmatch(fields[1]) is None):
        return None
    return fields[1]


def layer_screen(sid: str, adapter: str) -> str:
    """The current viewport through `wh-cli.sh read-screen` (tmux capture-pane for warp/tmux).

    Exit 20 is the layer saying this adapter has no screen reader: readiness cannot be
    attested, and the reason names the adapter so dispatch can stop at once.
    """
    try:
        result = subprocess.run(["bash", WH_CLI, "read-screen", sid], stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=COMMAND_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired:
        raise ScreenUnavailable("current-screen command timed out") from None
    except OSError:
        raise ScreenUnavailable("current-screen command unavailable") from None
    if result.returncode == LAYER_UNSUPPORTED:
        named = re.search(rb"adapter=([a-z]{1,32})", result.stdout)
        name = named.group(1).decode("ascii") if named else adapter
        raise ScreenUnavailable(f"READINESS_UNATTESTABLE adapter={name}")
    if result.returncode:
        raise ScreenUnavailable("current-screen command failed")
    if len(result.stdout) > MAX_RESPONSE_BYTES:
        raise ScreenUnavailable("current-screen response too large")
    try:
        text = result.stdout.decode("utf-8", errors="strict")
    except UnicodeError:
        raise ScreenUnavailable("current-screen response is not UTF-8") from None
    if not text.strip():
        raise ScreenUnavailable("current screen is blank")
    if re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", text):
        raise ScreenUnavailable("current screen contains unrendered controls")
    return text


def read_current_screen(sid: str, info: dict[str, Any],
                        refresh_info: Callable[[], dict[str, Any]]) -> tuple[str, str]:
    binding = session_binding(info, sid)
    # Task 1304 D4: the reader follows the adapter that OPENED the session. A cmux record,
    # or no record at all, keeps the bound in-process cmux reader below exactly as it was;
    # any other recorded adapter is read through the layer.
    recorded = recorded_adapter(sid)
    if recorded is not None and recorded != "cmux":
        text = layer_screen(sid, recorded)
        source = recorded
    else:
        backend = info.get("backend")
        adapter = ADAPTERS.get(backend) if isinstance(backend, str) else None
        if adapter is None:
            raise ScreenUnavailable("current-screen adapter unsupported")
        text = adapter(info)
        source = backend
    if session_binding(refresh_info(), sid) != binding:
        raise ScreenUnavailable("session changed during screen read")
    return text, source + ":current-viewport"
