#!/usr/bin/env python3
"""task-queue-lock.py — the ONLY holder of the task-queue advisory lock (#1172 U3).

Node has no `fcntl` and no `msvcrt` built in, so a real OS advisory lock cannot be
taken from JavaScript. This broker is the fixed-purpose Python half of the shared
task-queue transaction: it takes the lock, runs the packaged Node transform as its
child inside that lock, and releases. It never parses, mutates or serialises the
queue — `task-queue-write.mjs` owns every byte of that, because JS
`JSON.stringify(doc, null, 2) + "\\n"` is the shape the file is committed in by
`src/dispatch/cli.ts:939` and `bin/init/cli.mjs:420`, and Python's json module does
not reproduce it.

FIXED PURPOSE, deliberately not a subprocess door:
  * The ONLY child it can ever spawn is `task-queue-write.mjs`, resolved from this
    file's own directory. There is no command, path or executable in the request, no
    shell anywhere, and nothing is ever taken from a queue field.
  * The request is one JSON document on stdin; the response is one JSON document on
    stdout. That is the whole protocol.

The lock is an exclusive `flock`/`msvcrt.locking` on `<queue>.lock`, a STABLE SIBLING
that is created once and never unlinked — never the queue inode, because the
transform's `rename` replaces that inode and two writers would hold locks on
different inodes while both believed they were exclusive. Same reasoning, same
constants and the same contention test as `bin/dispatch-registry.py:227-275`; that
file stays the single writer of the dispatch registry and is not touched here.

If neither locking module imports, this exits 6 `lock_capability_unavailable` and
writes nothing. There is no unlocked fallback: an unlocked write is the defect U3
exists to remove.

Usage (callers only; not an operator command):
  task-queue-lock.py --queue <abs-path> --node <abs-exe> [--timeout <sec>]  < request.json

`--node` is REQUIRED and must be an absolute path to an existing regular executable.
It is always the calling process's own `process.execPath`: every caller is itself Node
(`bin/tq-note.mjs`, `src/dispatch/cli.ts` taskLedgerUpdate, and the suite), and the two
non-Node callers reach this file THROUGH `bin/tq-note.mjs` rather than directly
(`bin/tq-focus.sh` runs `node .../tq-note.mjs`; `bin/init/cli.mjs` imports its
`callBroker`). There is deliberately no `AIGENTRY_TQ_NODE` and no `PATH` lookup: an
earlier version had both, nothing in the tree ever set them, and an ambient fallback only
widens which executable this file can start. Removing it is a reduction of an unused
internal selection surface — NOT a trust boundary against a same-UID caller, who can edit
this file anyway. Snyk python/CommandInjection
6a365508-cd04-4257-908b-b46857eb504b named the flow; the fix is that there is no longer
an ambient source for it to come from.
"""

from __future__ import annotations

import errno
import json
import os
import secrets
import stat
import subprocess
import sys
import time

if os.name == "nt":
    try:
        import msvcrt
    except ImportError:  # pragma: no cover - probed by the capability refusal below
        msvcrt = None  # type: ignore[assignment]
    fcntl = None  # type: ignore[assignment]
else:
    msvcrt = None  # type: ignore[assignment]
    try:
        import fcntl
    except ImportError:  # pragma: no cover - probed by the capability refusal below
        fcntl = None  # type: ignore[assignment]

LOCK_TIMEOUT_S = 10.0
"""Matches bin/dispatch-registry.py:57. A caller that cannot get the lock in 10s is
told so by name; it never proceeds unlocked."""

CHILD_TIMEOUT_S = 30.0
MAX_REQUEST_BYTES = 1 * 1024 * 1024
DRAIN_CEILING_BYTES = 64 * 1024 * 1024

TRANSFORM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "task-queue-write.mjs")

# Exit codes. Identical table in task-queue-write.mjs; 2 is never produced.
EXIT_OK = 0
EXIT_STATE = 3
EXIT_USAGE = 4
EXIT_CAPABILITY = 6
EXIT_CORRUPT = 9


def respond(reason: str, detail: str, code: int) -> "NoReturn":  # type: ignore[valid-type]
    """One JSON object on stdout, the human sentence on stderr. Nothing was written."""
    sys.stdout.write(json.dumps({
        "v": 1, "applied": False, "reason": reason, "detail": detail, "exit": code,
    }, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.stderr.write("task-queue-lock.py: %s: %s\n" % (reason, detail))
    sys.exit(code)


def fault(name: str) -> bool:
    """Test seam, mirroring AIGENTRY_REGISTRY_FAULT at bin/dispatch-registry.py:220."""
    return os.environ.get("AIGENTRY_TQ_NOTE_FAULT", "") == name


def parse_argv(argv: list[str]) -> dict[str, str]:
    opts: dict[str, str] = {}
    rest = list(argv)
    while rest:
        a = rest.pop(0)
        if a in ("--queue", "--timeout", "--node"):
            if not rest:
                respond("invalid_argument", "%s requires a value" % a, EXIT_USAGE)
            opts[a[2:]] = rest.pop(0)
        elif a in ("-h", "--help"):
            sys.stdout.write(__doc__ or "")
            sys.exit(EXIT_OK)
        else:
            respond("invalid_argument", "unknown argument: %s" % a, EXIT_USAGE)
    if "queue" not in opts:
        respond("invalid_argument", "--queue is required", EXIT_USAGE)
    if not os.path.isabs(opts["queue"]):
        respond("invalid_argument", "--queue must be absolute: %s" % opts["queue"], EXIT_USAGE)
    if not opts.get("node"):
        # Required, with no ambient fallback to fall back TO. Every caller is a Node
        # process passing its own process.execPath; see the module docstring.
        respond("invalid_argument",
                "--node is required and must be the calling process's own executable "
                "(an absolute path to an existing regular executable); there is no "
                "environment or PATH fallback", EXIT_USAGE)
    return opts


def resolve_node(explicit: str) -> str:
    """The ONE Node executable this file may start: the one the caller named on `--node`,
    which is always that caller's own `process.execPath`.

    There is no second source. No environment variable, no `PATH` search, and — as
    everywhere else in this file — nothing from a queue field. The value must be an
    absolute path to an existing REGULAR, EXECUTABLE file; anything else is a named
    refusal and nothing is written."""
    if not os.path.isabs(explicit):
        respond("node_invalid",
                "--node must be absolute: %s" % explicit, EXIT_USAGE)
    try:
        st = os.stat(explicit)
    except OSError as exc:
        respond("node_invalid",
                "--node does not resolve to a usable file (%s): %s" % (explicit, exc),
                EXIT_CAPABILITY)
    if not stat.S_ISREG(st.st_mode):
        respond("node_invalid",
                "--node is not a regular file: %s" % explicit, EXIT_CAPABILITY)
    if not os.access(explicit, os.X_OK):
        respond("node_invalid",
                "--node is not executable: %s" % explicit, EXIT_CAPABILITY)
    return explicit


class Lock:
    """Exclusive lock on the stable `<queue>.lock` sibling.

    Released in __exit__, and by the kernel on fd close if this process dies anyway —
    so no path, including a kill, leaves the lock held."""

    def __init__(self, queue: str, deadline_s: float) -> None:
        self.path = queue + ".lock"
        self.deadline_s = deadline_s
        self.fh = None
        self.acquired = False
        self.inode = None

    def __enter__(self) -> "Lock":
        if fault("lock"):
            respond("queue_unavailable", "lock acquisition faulted (test seam)", EXIT_STATE)
        if (os.name == "nt" and msvcrt is None) or (os.name != "nt" and fcntl is None):
            respond("lock_capability_unavailable",
                    "this Python has neither fcntl nor msvcrt, so no OS advisory lock is "
                    "available; refusing rather than writing the task queue unlocked",
                    EXIT_CAPABILITY)
        try:
            self.fh = open(self.path, "a+b", buffering=0)
            self.inode = os.fstat(self.fh.fileno()).st_ino
            deadline = time.monotonic() + self.deadline_s
            while True:
                if os.name == "nt":
                    # Append-open may start beyond zero. Lock [0, 1), even at EOF.
                    self.fh.seek(0, os.SEEK_SET)
                try:
                    if os.name == "nt":
                        msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    if os.name == "nt":
                        contended = (exc.errno == errno.EACCES
                                     and getattr(exc, "winerror", None) in (None, 33))
                    else:
                        contended = exc.errno in (errno.EAGAIN, errno.EACCES)
                    if not contended:
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        respond("queue_unavailable",
                                "lock timeout after %ss on %s" % (self.deadline_s, self.path),
                                EXIT_STATE)
                    time.sleep(min(0.05, remaining))
                else:
                    self.acquired = True
                    return self
        except OSError as exc:
            self.release()
            respond("queue_unavailable", "lock failed: %s" % exc, EXIT_STATE)

    def __exit__(self, *_exc_info: object) -> None:
        self.release()

    def release(self) -> None:
        if self.fh is None:
            return
        try:
            if self.acquired:
                if os.name == "nt":
                    self.fh.seek(0, os.SEEK_SET)
                    msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(self.fh, fcntl.LOCK_UN)
        except OSError:
            # The fd close below releases it regardless; a failed explicit unlock is
            # never reported as a queue state error.
            pass
        finally:
            self.acquired = False
            try:
                self.fh.close()
            except OSError:
                pass
            self.fh = None


def canonical_queue(raw: str) -> tuple[str, str]:
    """The ONE normalisation every writer gets, so "same canonical queue path and stable
    lock inode" is a property of the code rather than of caller discipline.

    The DIRECTORY is realpath'd — two callers reaching the same queue through different
    symlinked parents must land on the same `<queue>.lock` inode. The LEAF is not
    resolved: a symlinked queue file is refused by the transform rather than followed,
    because `rename` would replace the link and silently detach its target."""
    directory = os.path.dirname(os.path.abspath(raw))
    if not os.path.isdir(directory):
        respond("queue_dir_missing",
                "the queue's directory does not exist: %s" % directory, EXIT_CORRUPT)
    try:
        directory = os.path.realpath(directory)
    except OSError as exc:
        respond("queue_dir_missing", "cannot resolve %s: %s" % (directory, exc), EXIT_CORRUPT)
    return os.path.join(directory, os.path.basename(os.path.abspath(raw))), directory


def main(argv: list[str]) -> int:
    opts = parse_argv(argv)
    queue, directory = canonical_queue(opts["queue"])

    try:
        timeout = float(opts.get("timeout", CHILD_TIMEOUT_S))
    except ValueError:
        respond("invalid_argument", "--timeout must be a number", EXIT_USAGE)
    if not (timeout > 0):
        respond("invalid_argument", "--timeout must be positive", EXIT_USAGE)

    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        # Drain before answering. Exiting with the writer still pushing gives the CALLER an
        # EPIPE, which it can only report as a transport failure — so a legitimate size
        # refusal would arrive under the wrong name. Bounded: a stream that will not end is
        # abandoned rather than followed forever.
        drained = len(raw)
        while drained < DRAIN_CEILING_BYTES:
            chunk = sys.stdin.buffer.read(256 * 1024)
            if not chunk:
                break
            drained += len(chunk)
        respond("request_too_large",
                "request exceeds %d bytes (read %d); refused rather than truncated"
                % (MAX_REQUEST_BYTES, drained),
                EXIT_USAGE)
    if not raw.strip():
        respond("invalid_argument", "no request on stdin", EXIT_USAGE)
    try:
        request = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        # Shape is the transform's business; this only confirms it is JSON at all, so a
        # malformed caller is named here rather than inside the lock.
        respond("invalid_argument", "request is not valid JSON: %s" % exc, EXIT_USAGE)
    if not isinstance(request, dict):
        respond("invalid_argument", "request root is not an object", EXIT_USAGE)
    # The transform operates on the canonical path, always — the caller's spelling of it
    # never reaches the mutator. Re-serialising the REQUEST is safe: only the queue
    # document's bytes are contractual, and the Node transform alone produces those.
    request["queue"] = queue
    raw = json.dumps(request, ensure_ascii=False).encode("utf-8")

    if not os.path.isfile(TRANSFORM):
        respond("transform_missing",
                "the packaged transform is absent at %s; this install is incomplete and "
                "nothing was written" % TRANSFORM, EXIT_CAPABILITY)

    node = resolve_node(opts["node"])
    env = dict(os.environ)
    env["AIGENTRY_TQ_LOCK_TOKEN"] = secrets.token_hex(16)
    env["AIGENTRY_TQ_LOCK_PATH"] = queue + ".lock"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    with Lock(queue, LOCK_TIMEOUT_S) as lock:
        env["AIGENTRY_TQ_LOCK_INODE"] = str(lock.inode)
        # argv is a fixed two-element list: the resolved Node and the packaged transform.
        # No shell, no caller-supplied command, no queue-derived path.
        try:
            child = subprocess.Popen(
                [node, TRANSFORM], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, env=env, cwd=directory, shell=False,
            )
        except OSError as exc:
            respond("transform_unavailable", "could not start the transform: %s" % exc,
                    EXIT_CAPABILITY)
        try:
            out, err = child.communicate(input=raw, timeout=timeout)
        except subprocess.TimeoutExpired:
            # Only this broker's OWN direct child is signalled. No host pid is probed,
            # listed or signalled, and no other process is touched.
            child.kill()
            try:
                out, err = child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                out, err = b"", b""
            if err:
                sys.stderr.buffer.write(err)
            respond("transform_timeout",
                    "the transform exceeded %ss and was killed; the queue is either the old "
                    "or the new complete document and the lock is released" % timeout,
                    EXIT_STATE)
        if err:
            sys.stderr.buffer.write(err)
        if out:
            sys.stdout.buffer.write(out)
            sys.stdout.flush()
        if not out.strip() and child.returncode == 0:
            respond("transform_silent",
                    "the transform exited 0 without a response document", EXIT_STATE)
        return child.returncode if child.returncode is not None else EXIT_STATE


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:  # pragma: no cover - the lock is released by fd close
        sys.exit(EXIT_STATE)
