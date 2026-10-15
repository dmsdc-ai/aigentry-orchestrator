#!/usr/bin/env python3
"""Read one confined report request through inherited attempt-root fd 3."""
import base64
from contextlib import ExitStack
import hashlib
import json
import os
import re
import stat
import sys

ITEM = re.compile(r'^(?:(REPORT|HOLD)-([1-9]|[12][0-9]|3[0-2])|(TURN)-([1-9]|[1-5][0-9]|6[0-4]))\.md$')
MARKER = re.compile(r'^\.hook-degraded-([a-z_]{1,32})$')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
SID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')
HEX = re.compile(r'^[0-9a-f]{64}$')


class Refusal(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def open_at(stack, parent, name, flags, code):
    try:
        fd = os.open(name, flags, dir_fd=parent)
    except OSError as exc:
        if exc.errno == 2 and code == 'request_invalid':
            return None
        raise Refusal(code) from exc
    stack.callback(os.close, fd)
    return fd


def regular_read(stack, parent, name, limit, code):
    try:
        pre = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except OSError as exc:
        raise Refusal(code) from exc
    require(stat.S_ISREG(pre.st_mode), 'symlink' if stat.S_ISLNK(pre.st_mode) else 'not_regular')
    require(pre.st_nlink == 1, 'hardlink')
    require(pre.st_size <= limit, 'too_large')
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except OSError as exc:
        raise Refusal('symlink' if exc.errno == 40 else code) from exc
    stack.callback(os.close, fd)
    before = os.fstat(fd)
    require(stat.S_ISREG(before.st_mode), 'not_regular')
    require((before.st_dev, before.st_ino) == (pre.st_dev, pre.st_ino), 'race')
    require(before.st_nlink == 1, 'hardlink')
    require(before.st_size <= limit, 'too_large')
    chunks = []
    size = 0
    try:
        while size <= limit:
            part = os.read(fd, min(65536, limit + 1 - size))
            if not part:
                break
            chunks.append(part)
            size += len(part)
    except OSError as exc:
        raise Refusal('io_error') from exc
    require(size <= limit, 'too_large')
    after = os.fstat(fd)
    require((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) ==
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns), 'race')
    require(size == before.st_size, 'race')
    return b''.join(chunks)


def scan(stack, request, sid, attempt, digest):
    require(os.name == 'posix' and all(hasattr(os, name) for name in ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK'))
            and os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd and
            os.stat in os.supports_follow_symlinks and os.listdir in os.supports_fd,
            'anchored_read_unsupported')
    require((request == '_unbound' or UUID.fullmatch(request)) and SID.fullmatch(sid) and
            UUID.fullmatch(attempt) and HEX.fullmatch(digest), 'helper_bad_args')
    root = 3
    require(stat.S_ISDIR(os.fstat(root).st_mode), 'helper_root_invalid')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        raw = regular_read(stack, root, 'manifest.json', 1048576, 'helper_manifest_invalid')
        require(hashlib.sha256(raw).hexdigest() == digest, 'helper_manifest_mismatch')
        manifest = json.loads(raw)
        require(isinstance(manifest, dict) and manifest.get('sid') == sid and manifest.get('attempt') == attempt,
                'helper_manifest_mismatch')
    except (ValueError, UnicodeError) as exc:
        raise Refusal('helper_manifest_invalid') from exc
    home = open_at(stack, root, 'home', flags, 'outbox_root_invalid')
    outbox = open_at(stack, home, 'report-outbox', flags, 'outbox_root_invalid')
    require(stat.S_ISDIR(os.fstat(home).st_mode) and stat.S_ISDIR(os.fstat(outbox).st_mode), 'outbox_root_invalid')
    try:
        names = os.listdir(outbox)
        require(len(names) <= 512, 'outbox_entry_limit')
        markers = sorted([m.group(1) for name in names if (m := MARKER.fullmatch(name))])[:16]
    except OSError as exc:
        raise Refusal('outbox_root_invalid') from exc
    req = open_at(stack, outbox, request, flags, 'request_invalid')
    if req is None:
        return {'v': 1, 'status': 'missing_request', 'ignored': 0, 'markers': markers, 'entries': []}
    require(stat.S_ISDIR(os.fstat(req).st_mode), 'request_invalid')
    try:
        names = os.listdir(req)
    except OSError as exc:
        raise Refusal('request_invalid') from exc
    require(len(names) <= 512, 'outbox_entry_limit')
    selected = [name for name in names if ITEM.fullmatch(name)]
    require(len(selected) <= 128, 'outbox_entry_limit')
    selected.sort(key=lambda n: (ITEM.fullmatch(n).group(1) or ITEM.fullmatch(n).group(3),
                                 int(ITEM.fullmatch(n).group(2) or ITEM.fullmatch(n).group(4))))
    entries = []
    for name in selected:
        limit = 8192 if name.startswith('TURN-') else 65536
        try:
            data = regular_read(stack, req, name, limit, 'race')
            entries.append({'name': name, 'bytes_b64': base64.b64encode(data).decode('ascii')})
        except Refusal as exc:
            entries.append({'name': name, 'refusal_code': str(exc)})
    return {'v': 1, 'status': 'ok', 'ignored': len(names) - len(selected), 'markers': markers, 'entries': entries}


def main():
    try:
        with ExitStack() as stack:
            stack.callback(os.close, 3)
            args = sys.argv[1:]
            require(len(args) == 4, 'helper_bad_args')
            result = scan(stack, *args)
    except Refusal as exc:
        result = {'v': 1, 'status': 'refused', 'error': str(exc), 'ignored': 0, 'markers': [], 'entries': []}
    except (OSError, TypeError):
        result = {'v': 1, 'status': 'refused', 'error': 'io_error', 'ignored': 0, 'markers': [], 'entries': []}
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
