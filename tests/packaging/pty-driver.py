#!/usr/bin/env python3
"""pty-driver.py — a bounded pseudo-terminal harness for the orchestrator boot wizard.

OWNED TEST HARNESS (#1181 acceptance, bt1181jm). It exists for exactly one reason: the
wizard's contract is a SHAPE OF FILE DESCRIPTORS, and no `isTTY` stub can stand in for it.

    bin/orchestrator-boot.sh runs   ORCH_BOOT_ARGV_RAW="$(node "$AIGENTRY_SHIM_JS")"

so on a real boot from a real terminal:

    fd 0  the operator's TERMINAL      (the wizard reads it)
    fd 1  a PIPE                        (command substitution — the exec-argv channel)
    fd 2  the operator's TERMINAL      (the wizard draws on it)

This driver reproduces that exactly: one openpty() whose slave is handed to the child as
BOTH stdin and stderr, while stdout is an ordinary pipe. `process.stdin.isTTY` and
`process.stderr.isTTY` are then true because the kernel says so, not because a test said
so — which is the whole point, since WIZARD_TTY gates every interactive path in cli.js.

BOUNDS, because this drives a script whose successor becomes a shell:
  * only the command it is given runs; the caller is responsible for a fake PATH.
  * every read is under a deadline and the whole run is under a wall-clock timeout.
  * on timeout the child is SIGKILLed in its OWN process group (setsid), so nothing
    outside this harness's own subtree is ever signalled.
  * no terminal automation, no cmux, no real telepty: this drives a child process's
    pty and nothing else.

Protocol — argv[1] is a JSON spec file:

    {"cmd": [...], "cwd": "...", "env": {...},
     "steps": [{"expect": "substring", "send": "text"} | {"expect": ..., "eof": true}
               | {"expect": ..., "sig": "INT"}],
     "timeout": 20.0}

`send` is written to the pty master verbatim (add "\n" yourself). `eof` closes the
master, which is what the operator's Ctrl-D / a vanished terminal looks like. `sig`
sends the control character for the named signal (INT -> 0x03) INTO the pty, so it
arrives through the line discipline exactly as a real Ctrl-C does — not as an
out-of-band kill.

Result on stdout, as JSON:

    {"rc": int|null, "signal": int|null, "stdout": str, "terminal": str,
     "steps_done": int, "timed_out": bool, "note": str}

`stdout` is the PIPE — the exec-argv contract channel, byte for byte.
`terminal` is everything the child drew on the pty (its stderr).
"""

import errno
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time

CTRL = {"INT": b"\x03", "QUIT": b"\x1c", "EOT": b"\x04"}


def main() -> int:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    cmd = spec["cmd"]
    cwd = spec.get("cwd") or os.getcwd()
    env = spec.get("env") or {}
    steps = spec.get("steps") or []
    timeout = float(spec.get("timeout", 20.0))

    master, slave = pty.openpty()
    # Deterministic geometry, and NO ECHO: the wizard's own prompts are the only thing
    # that may appear on the terminal transcript. With echo on, every keystroke this
    # driver sends would be echoed back by the line discipline and an assertion on the
    # transcript would be matching its own input.
    attrs = termios.tcgetattr(slave)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(slave, termios.TCSANOW, attrs)

    stdout_r, stdout_w = os.pipe()

    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdin=slave,
        stdout=stdout_w,
        stderr=slave,
        close_fds=True,
        start_new_session=True,  # own process group: a timeout kill cannot escape
    )
    os.close(slave)
    os.close(stdout_w)

    terminal = bytearray()
    out = bytearray()
    at = 0
    matched_upto = 0  # only look for the next `expect` in text not already consumed
    timed_out = False
    note = ""
    deadline = time.monotonic() + timeout
    master_open = True

    while True:
        if proc.poll() is not None and not master_open:
            break
        if time.monotonic() > deadline:
            timed_out = True
            note = "wall-clock timeout; child SIGKILLed in its own process group"
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait(timeout=5)
            break

        watch = [stdout_r]
        if master_open:
            watch.append(master)
        try:
            ready, _, _ = select.select(watch, [], [], 0.05)
        except (OSError, ValueError):
            break

        for fd in ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as exc:
                # The slave side closing raises EIO on the master. That is the child
                # exiting, not an error.
                if exc.errno in (errno.EIO, errno.EBADF):
                    chunk = b""
                else:
                    raise
            if fd == master:
                if not chunk:
                    master_open = False
                    try:
                        os.close(master)
                    except OSError:
                        pass
                    continue
                terminal += chunk
            else:
                if not chunk:
                    continue
                out += chunk

        if at < len(steps) and master_open:
            step = steps[at]
            want = step["expect"].encode("utf-8")
            hit = terminal.find(want, matched_upto)
            if hit != -1:
                matched_upto = hit + len(want)
                if step.get("eof"):
                    master_open = False
                    try:
                        os.close(master)
                    except OSError:
                        pass
                elif step.get("sig"):
                    os.write(master, CTRL[step["sig"]])
                else:
                    os.write(master, step.get("send", "").encode("utf-8"))
                at += 1

        if proc.poll() is not None:
            # Drain whatever is still buffered, then stop.
            for fd in (master, stdout_r):
                if fd == master and not master_open:
                    continue
                try:
                    while True:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        if fd == master:
                            terminal += chunk
                        else:
                            out += chunk
                except OSError:
                    pass
            break

    try:
        while True:
            chunk = os.read(stdout_r, 65536)
            if not chunk:
                break
            out += chunk
    except OSError:
        pass
    os.close(stdout_r)
    if master_open:
        try:
            os.close(master)
        except OSError:
            pass

    rc = proc.poll()
    if rc is None:
        try:
            rc = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            rc = None

    if at < len(steps) and not timed_out:
        note = note or f"child exited with {len(steps) - at} step(s) unconsumed"

    json.dump(
        {
            "rc": None if rc is None else (rc if rc >= 0 else None),
            "signal": None if rc is None or rc >= 0 else -rc,
            "stdout": out.decode("utf-8", "replace"),
            "terminal": terminal.decode("utf-8", "replace"),
            "steps_done": at,
            "steps_total": len(steps),
            "timed_out": timed_out,
            "note": note,
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
