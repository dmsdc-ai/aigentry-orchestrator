#!/usr/bin/env python3
"""windows-nofollow-probe-1172.py — DIAGNOSTIC measurement only (#1172 phase 4).

WHAT THIS IS. A one-shot, unshipped diagnostic that measures the four native Windows
behaviours the task-queue lock's no-follow design depends on and that official
documentation does not settle. It exists so the design stops resting on inference:

  P0  a regular file opens through the designed CreateFileW flags, converts to a CRT fd,
      is non-inheritable, and is NOT truncated (invariant L2).
  P1  a symlink leaf is either detected on the converted handle or refused outright --
      never silently followed to its target. A directory junction is measured the same
      way and is equally REQUIRED (Q15): both reparse shapes must be observed, and an
      uncreatable fixture fails the run instead of passing quietly.
  P2  an ordinary directory at the lock leaf produces a refusal, with its EXACT Win32
      error recorded rather than guessed.
  P4  a byte-range lock taken with msvcrt.locking is actually released after the real
      Windows TerminateProcess, measured instead of inferred from two documents.

WHAT THIS IS NOT. Not product code, not shipped, not imported by anything, and not
native acceptance. It does not import, read or modify the task queue, the broker
(bin/lib/task-queue-lock.py), the transform, or any product source. Parsing this file
proves nothing: native support is established only by RUNNING it on native win32 and
reading its recorded observations. A clean exit means "these measurements were obtained
on that runner", never "Windows is supported".

SAFETY SURFACE, deliberately closed:
  * No path or command operand exists. The scratch layout is derived from __file__ plus
    fixed literals, so no caller input ever reaches a filesystem or handle call.
  * The ONLY accepted operand form is the closed child selector `--child-op hold-lock`,
    checked against a fixed tuple BEFORE any IO.
  * Standard library only. No network, no install, no registry, no service, no host
    process enumeration, and the only process ever signalled is this probe's own direct
    child.
  * One step DOES invoke a command interpreter, and that is stated plainly rather than
    glossed: the junction fixture runs `cmd /c mklink /J` because `mklink` is a cmd.exe
    builtin with no API equivalent here. It is a FIXED LITERAL command-interpreter
    invocation whose operands are module-derived constants. `subprocess` is called with
    shell=False, which means Python interpolates no shell string -- but cmd.exe is
    itself an interpreter, so this file does NOT claim "no shell anywhere". No caller
    input reaches it, because no caller input exists.
  * No symlink privilege is requested and Developer Mode is never enabled. Where a
    fixture cannot be created, that is recorded as an explicit NOTRUN gap -- never
    substituted, never reported as a success.

Output: ONE JSON document on stdout at the end; the workflow captures and uploads it.
Partial results are still emitted when a probe fails. Exit codes:

    0   every REQUIRED measurement obtained AND consistent with the design
    3   a required measurement was UNAVAILABLE (capability gap)
    4   an observation CONTRADICTS the design
    5   not running on win32 -- refused
    64  usage refusal (unexpected operands), before any IO

2 is never produced.
"""

from __future__ import annotations

import ctypes
import json
import os
import stat
import subprocess
import sys
import threading
import time

# ── exit codes ──────────────────────────────────────────────────────────────────────
EXIT_OK = 0
EXIT_GAP = 3
EXIT_CONTRADICTION = 4
EXIT_NOT_WIN32 = 5
EXIT_USAGE = 64

# ── the one closed child selector ───────────────────────────────────────────────────
CHILD_OPS = ("hold-lock",)

# ── owned scratch layout: derived from __file__ and fixed literals only ─────────────
SELF = os.path.abspath(__file__)
SCRIPT_DIR = os.path.dirname(SELF)
SCRATCH = os.path.join(SCRIPT_DIR, "_probe-1172-scratch")

P0_LOCK = os.path.join(SCRATCH, "p0-regular.lock")
P1_TARGET = os.path.join(SCRATCH, "p1-target.bin")
P1_LINK = os.path.join(SCRATCH, "p1-link.lock")
P1_JUNCTION_TARGET = os.path.join(SCRATCH, "p1-junction-target")
P1_JUNCTION = os.path.join(SCRATCH, "p1-junction.lock")
P1_JUNCTION_SENTINEL = os.path.join(P1_JUNCTION_TARGET, "sentinel.bin")
P2_DIR = os.path.join(SCRATCH, "p2-directory.lock")
P2_DIR_SENTINEL = os.path.join(P2_DIR, "sentinel.bin")
P4_LOCK = os.path.join(SCRATCH, "p4-contended.lock")

P0_SENTINEL = b"p0 sentinel: OPEN_ALWAYS must never truncate this\n"
P1_SENTINEL = b"p1 sentinel: a followed link would expose these bytes\n"
P2_SENTINEL = b"p2 sentinel: a directory refusal must not mutate this\n"
P4_SENTINEL = b"p4 sentinel: the contended lock file\n"
JUNCTION_SENTINEL = b"junction sentinel\n"

# ── bounded budgets (every wait in this file is bounded) ────────────────────────────
READINESS_WAIT_S = 30.0
CHILD_REAP_WAIT_S = 15.0
REACQUIRE_WINDOW_S = 10.0
REACQUIRE_POLL_S = 0.25
MKLINK_TIMEOUT_S = 20.0
CHILD_MAX_HOLD_S = 150.0

# ── Win32 constants, WITH PROVENANCE ────────────────────────────────────────────────
# Values marked DOC appear verbatim in the frozen CreateFileW reference verified in
# phase 3 (sha256 e41c7126db972d34854e54f614c444a57e6723a1e99a9bcca654208a3ab75c17).
# Values marked GENERIC-ACCESS-RIGHTS were raised as Q12 while unconfirmed and are now
# confirmed against the official Microsoft generic-access-rights reference
# (learn.microsoft.com/en-us/windows/win32/secauthz/generic-access-rights), which
# documents GENERIC_READ as 0x80000000 and GENERIC_WRITE as 0x40000000. The masks below
# are unchanged by that confirmation. The reference's own caveat is kept rather than
# dropped: these are GENERIC access-mask constants, and their object-specific mapping
# remains an operating-system contract, so confirming the constant is not a claim about
# what access a given object grants. The constant table is emitted in the JSON output so
# a wrong value is visible in the log instead of silently changing behaviour -- and a
# wrong access mask fails loudly at the open rather than quietly.
GENERIC_READ = 0x80000000   # official generic-access-rights reference (Q12 confirmed)
GENERIC_WRITE = 0x40000000  # official generic-access-rights reference (Q12 confirmed)
FILE_SHARE_READ = 0x00000001           # DOC: dwShareMode table
FILE_SHARE_WRITE = 0x00000002          # DOC: dwShareMode table
OPEN_ALWAYS = 4                        # DOC: dwCreationDisposition table
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000  # DOC: dwFlagsAndAttributes table

# FILE_SHARE_DELETE, FILE_FLAG_BACKUP_SEMANTICS, CREATE_ALWAYS and TRUNCATE_EXISTING are
# deliberately ABSENT. Omitting FILE_SHARE_DELETE keeps another handle from deleting or
# renaming the stable lock sibling while it is open; omitting FILE_FLAG_BACKUP_SEMANTICS
# is what makes a directory or junction fail at the open, which is P2's whole point.

CONSTANTS_USED = {
    "GENERIC_READ": {
        "value": GENERIC_READ,
        "provenance": "official Microsoft generic-access-rights reference (Q12 confirmed); "
                      "a GENERIC mask whose object-specific mapping stays an OS contract",
    },
    "GENERIC_WRITE": {
        "value": GENERIC_WRITE,
        "provenance": "official Microsoft generic-access-rights reference (Q12 confirmed); "
                      "a GENERIC mask whose object-specific mapping stays an OS contract",
    },
    "FILE_SHARE_READ": {"value": FILE_SHARE_READ, "provenance": "DOC CreateFileW dwShareMode"},
    "FILE_SHARE_WRITE": {"value": FILE_SHARE_WRITE, "provenance": "DOC CreateFileW dwShareMode"},
    "OPEN_ALWAYS": {"value": OPEN_ALWAYS, "provenance": "DOC CreateFileW dwCreationDisposition"},
    "FILE_FLAG_OPEN_REPARSE_POINT": {
        "value": FILE_FLAG_OPEN_REPARSE_POINT,
        "provenance": "DOC CreateFileW dwFlagsAndAttributes",
    },
    "omitted_deliberately": [
        "FILE_SHARE_DELETE",
        "FILE_FLAG_BACKUP_SEMANTICS",
        "CREATE_ALWAYS",
        "TRUNCATE_EXISTING",
    ],
}


class ProbeRefusal(Exception):
    """A measurement could not proceed. Carries a reason name and a bounded detail."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__("%s: %s" % (reason, detail))
        self.reason = reason
        self.detail = detail


def win_error_text(code: int) -> str:
    """FormatMessage text for a Win32 code, or an empty string if unavailable."""
    fmt = getattr(ctypes, "FormatError", None)
    if fmt is None:
        return ""
    try:
        return str(fmt(code))
    except Exception:  # pragma: no cover - diagnostic must never die formatting a message
        return ""


class Win32Opener:
    """The ONE opener under measurement: the exact phase-3 contract, declared once.

    Declaring argtypes/restype is mandatory, not cosmetic: ctypes documents that "by
    default functions are assumed to return the C int type", while CreateFileW returns a
    pointer-width HANDLE. INVALID_HANDLE_VALUE is COMPUTED rather than hardcoded.
    """

    def __init__(self) -> None:
        import ctypes.wintypes as wintypes  # win32-only; imported after the platform gate

        self.k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.k32.CreateFileW.argtypes = (
            wintypes.LPCWSTR,   # lpFileName
            wintypes.DWORD,     # dwDesiredAccess
            wintypes.DWORD,     # dwShareMode
            ctypes.c_void_p,    # lpSecurityAttributes
            wintypes.DWORD,     # dwCreationDisposition
            wintypes.DWORD,     # dwFlagsAndAttributes
            wintypes.HANDLE,    # hTemplateFile
        )
        self.k32.CreateFileW.restype = wintypes.HANDLE
        self.invalid_handle = ctypes.c_void_p(-1).value

    def raw_open(self, path: str) -> int:
        """CreateFileW with the designed flags. Returns a handle, or raises ProbeRefusal
        carrying the EXACT Win32 error -- never a guessed one."""
        ctypes.set_last_error(0)
        handle = self.k32.CreateFileW(
            path,
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_ALWAYS,
            FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        if handle is None or handle == self.invalid_handle:
            code = ctypes.get_last_error()
            raise ProbeRefusal(
                "createfilew_failed",
                "CreateFileW refused: winerror=%d (%s)" % (code, win_error_text(code)),
            )
        return handle

    def open_fd(self, path: str) -> int:
        """raw_open plus the documented CRT conversion.

        On conversion failure this REFUSES and the caller lets the process exit without
        calling CloseHandle: the documents do not state who owns the handle when
        _open_osfhandle fails, and controller disposition Q8 forbids a speculative close
        on uncertain ownership. Fixture process termination may clean it.

        os.O_NOINHERIT is REQUIRED: msvcrt.open_osfhandle fds are documented inheritable
        by default, whereas os.open fds are documented non-inheritable, so omitting it
        would silently change the lock fd's inheritance relative to the POSIX path.
        """
        import msvcrt  # win32-only; imported after the platform gate

        handle = self.raw_open(path)
        try:
            fd = msvcrt.open_osfhandle(handle, os.O_NOINHERIT)
        except OSError as exc:
            raise ProbeRefusal(
                "osfhandle_conversion_failed",
                "open_osfhandle refused (%s); refusing without a speculative CloseHandle "
                "because handle ownership on failure is undocumented (Q8/D7)" % exc,
            )
        if fd == -1:
            raise ProbeRefusal(
                "osfhandle_conversion_failed",
                "open_osfhandle returned -1; refusing without a speculative CloseHandle "
                "because handle ownership on failure is undocumented (Q8/D7)",
            )
        return fd


def describe_fd(fd: int) -> dict:
    """Everything the design needs to know, read off the fd we already hold.

    st_file_attributes is documented as the dwFileAttributes member of
    BY_HANDLE_FILE_INFORMATION returned by GetFileInformationByHandle, so this is a
    handle-based observation -- no second path lookup, nothing to race. st_reparse_tag is
    OPTIONAL on purpose: the stat docs describe it against os.lstat(), so whether an
    fstat of a converted handle populates it is exactly what P1 measures.
    """
    st = os.fstat(fd)
    attrs = getattr(st, "st_file_attributes", None)
    tag = getattr(st, "st_reparse_tag", None)
    reparse_const = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", None)
    dir_const = getattr(stat, "FILE_ATTRIBUTE_DIRECTORY", None)

    out = {
        "is_regular": bool(stat.S_ISREG(st.st_mode)),
        "st_mode_octal": oct(st.st_mode),
        "st_file_attributes": attrs,
        "st_file_attributes_hex": (hex(attrs) if isinstance(attrs, int) else None),
        "st_file_attributes_available": attrs is not None,
        "reparse_point_bit": (
            bool(attrs & reparse_const)
            if isinstance(attrs, int) and isinstance(reparse_const, int)
            else None
        ),
        "directory_bit": (
            bool(attrs & dir_const)
            if isinstance(attrs, int) and isinstance(dir_const, int)
            else None
        ),
        "st_reparse_tag": tag,
        "st_reparse_tag_hex": (hex(tag) if isinstance(tag, int) else None),
        "st_reparse_tag_available_on_fstat": tag is not None,
        "inheritable": os.get_inheritable(fd),
        "st_nlink": st.st_nlink,
        "identity": identity_strings(st),
    }
    return out


def identity_strings(st: os.stat_result) -> dict:
    """Exact decimal identity, plus the two facts the approved Q11 field design needs.

    The Windows identity is (volume serial, 64-bit file ID); a 64-bit value can exceed
    JS Number precision, so the faithful carrier is the decimal STRING. `number_safe` is
    the JS Number.isSafeInteger-equivalent and `decimal_roundtrip_exact` is the exact
    round-trip test -- a legacy numeric field is only safe when BOTH are true. This probe
    merely MEASURES those inputs; it implements no product change.
    """
    js_max_safe = 9007199254740991  # 2**53 - 1

    def one(value: int) -> dict:
        text = str(value)
        safe = abs(value) <= js_max_safe
        return {
            "exact_decimal": text,
            "number_safe": safe,
            "decimal_roundtrip_exact": safe and str(int(float(text))) == text,
            "bit_length": int(value).bit_length(),
        }

    return {"st_ino": one(st.st_ino), "st_dev": one(st.st_dev)}


def read_all(fd: int) -> bytes:
    """Read the whole file through the fd we hold, from offset 0, bounded."""
    os.lseek(fd, 0, os.SEEK_SET)
    chunks = []
    total = 0
    while total < 65536:
        part = os.read(fd, 4096)
        if not part:
            break
        chunks.append(part)
        total += len(part)
    return b"".join(chunks)


def write_file(path: str, data: bytes) -> None:
    with open(path, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())


def path_facts(path: str) -> dict:
    """Fixture-preservation facts ONLY. lstat appears here and nowhere else: it verifies
    that the planted fixture still exists in the shape we planted it. It is NEVER used to
    infer the converted fd's attributes, and it is NEVER offered as no-follow proof."""
    out = {"path_leaf": os.path.basename(path), "exists": False}
    try:
        lst = os.lstat(path)
    except OSError as exc:
        out["lstat_error"] = str(exc)
        return out
    out["exists"] = True
    out["is_symlink_by_lstat"] = bool(stat.S_ISLNK(lst.st_mode))
    out["is_dir_by_lstat"] = bool(stat.S_ISDIR(lst.st_mode))
    out["identity"] = identity_strings(lst)
    attrs = getattr(lst, "st_file_attributes", None)
    out["st_file_attributes_hex"] = hex(attrs) if isinstance(attrs, int) else None
    tag = getattr(lst, "st_reparse_tag", None)
    out["st_reparse_tag_hex"] = hex(tag) if isinstance(tag, int) else None
    return out


# ── P0 ──────────────────────────────────────────────────────────────────────────────
def probe_p0(opener: Win32Opener) -> dict:
    """Regular-file positive control. Without this, every refusal below is
    uninterpretable and a probe that refused everything could look like a success."""
    obs = {"probe": "P0", "required": True, "title": "regular file positive control"}
    write_file(P0_LOCK, P0_SENTINEL)
    fd = None
    try:
        fd = opener.open_fd(P0_LOCK)
        obs["fd_facts"] = describe_fd(fd)
        obs["bytes_after_open"] = len(read_all(fd))
        obs["sentinel_unchanged"] = read_all(fd) == P0_SENTINEL
    except ProbeRefusal as exc:
        obs["status"] = "CONTRADICTION"
        obs["reason"] = exc.reason
        obs["detail"] = exc.detail
        obs["note"] = "the designed flags could not open an ordinary regular file"
        return obs
    finally:
        if fd is not None:
            os.close(fd)  # exactly once; CloseHandle is never called on a converted fd

    facts = obs["fd_facts"]
    problems = []
    if not facts["is_regular"]:
        problems.append("a regular file was not reported as regular")
    if facts["reparse_point_bit"] is True:
        problems.append("a plain regular file reported the reparse-point bit")
    if facts["inheritable"]:
        problems.append("the converted fd is inheritable despite O_NOINHERIT")
    if not obs["sentinel_unchanged"]:
        problems.append("OPEN_ALWAYS truncated or altered the file (invariant L2 broken)")
    if not facts["st_file_attributes_available"]:
        problems.append("st_file_attributes is unavailable, so the refusal test has no input")

    obs["problems"] = problems
    obs["status"] = "OK" if not problems else "CONTRADICTION"
    return obs


# ── P1 ──────────────────────────────────────────────────────────────────────────────
def classify_link_open(opener: Win32Opener, link_path: str, target_identity: dict) -> dict:
    """Open a planted reparse leaf and classify the outcome.

    A refusal is recorded DISTINCTLY from a successful attribute observation: both are
    valid no-follow outcomes, and conflating them would hide which mechanism fired.
    Nothing is ever written through the handle here.
    """
    out = {}
    fd = None
    try:
        fd = opener.open_fd(link_path)
    except ProbeRefusal as exc:
        out["outcome"] = "REFUSED_AT_OPEN_OR_CONVERSION"
        out["reason"] = exc.reason
        out["detail"] = exc.detail
        out["status"] = "OK_REFUSED"
        return out
    try:
        facts = describe_fd(fd)
        out["fd_facts"] = facts
        out["outcome"] = "OPENED"

        # Tolerate a missing target identity rather than raising: if the fixture's identity
        # could not be read, "did this resolve to the target?" is unanswerable and must be
        # reported as such, not surfaced as an unexpected-error gap.
        def leg(identity: dict, field: str) -> str | None:
            value = identity.get(field) if isinstance(identity, dict) else None
            return value.get("exact_decimal") if isinstance(value, dict) else None

        fd_ino, fd_dev = leg(facts["identity"], "st_ino"), leg(facts["identity"], "st_dev")
        tgt_ino, tgt_dev = leg(target_identity, "st_ino"), leg(target_identity, "st_dev")
        if None in (fd_ino, fd_dev, tgt_ino, tgt_dev):
            same_as_target = None
            out["identity_comparable"] = False
        else:
            same_as_target = fd_ino == tgt_ino and fd_dev == tgt_dev
            out["identity_comparable"] = True
        out["identity_equals_target"] = same_as_target
        if facts["reparse_point_bit"] is True:
            out["status"] = "OK_DETECTED"
        elif same_as_target is True:
            out["status"] = "CONTRADICTION"
            out["note"] = "the handle resolved to the TARGET: the link was followed"
        else:
            out["status"] = "GAP_AMBIGUOUS"
            out["note"] = (
                "the reparse bit was clear and the identity did not match the target, so "
                "neither detection nor following can be concluded"
            )
    finally:
        os.close(fd)
    return out


def probe_p1(opener: Win32Opener) -> list:
    """File-symlink capability preflight + no-follow observation, then a directory-junction
    preflight recorded separately. No privilege is requested; Developer Mode is never
    enabled. An unavailable fixture is an explicit NOTRUN gap, never a substituted
    equivalent and never a success."""
    results = []

    # --- file symlink ---
    sym = {"probe": "P1-symlink", "required": True, "title": "file symlink leaf, no-follow"}
    write_file(P1_TARGET, P1_SENTINEL)
    target_before = path_facts(P1_TARGET)
    sym["target_before"] = target_before
    try:
        os.symlink(P1_TARGET, P1_LINK)
        sym["fixture_creation_supported"] = True
    except (OSError, NotImplementedError, AttributeError) as exc:
        sym["fixture_creation_supported"] = False
        sym["status"] = "NOTRUN_GAP"
        sym["reason"] = "symlink_fixture_unavailable"
        sym["detail"] = "os.symlink refused (%s); no privilege was requested and Developer " \
                        "Mode was not enabled, so the central no-follow case is an explicit " \
                        "ACCEPTANCE GAP, not a skipped success" % exc
        sym["winerror"] = getattr(exc, "winerror", None)
        sym["errno"] = getattr(exc, "errno", None)
        results.append(sym)
    else:
        sym["link_before"] = path_facts(P1_LINK)
        sym.update(classify_link_open(opener, P1_LINK, target_before.get("identity", {})))
        # The target must be byte- and identity-unchanged, and the fixture must still be a link.
        after = path_facts(P1_TARGET)
        sym["target_after"] = after
        try:
            with open(P1_TARGET, "rb") as fh:
                sym["target_bytes_unchanged"] = fh.read() == P1_SENTINEL
        except OSError as exc:
            sym["target_bytes_unchanged"] = False
            sym["target_read_error"] = str(exc)
        sym["target_identity_unchanged"] = (
            after.get("identity", {}).get("st_ino", {}).get("exact_decimal")
            == target_before.get("identity", {}).get("st_ino", {}).get("exact_decimal")
        )
        sym["fixture_still_symlink"] = bool(sym.get("link_before", {}).get("is_symlink_by_lstat"))
        if not sym["target_bytes_unchanged"] or not sym["target_identity_unchanged"]:
            sym["status"] = "CONTRADICTION"
            sym["note"] = "the target was modified or replaced during a no-follow open"
        results.append(sym)

    # --- directory junction, recorded separately but REQUIRED (Q15) ---
    # Promoted to required alongside the symlink: a junction needs no symlink privilege, so
    # on a stock runner it is the more reliably creatable of the two reparse shapes, and
    # leaving it optional would let the central reparse case go unmeasured while the run
    # still reported success. An unavailable fixture is therefore a NOTRUN_GAP that fails
    # the run, not a quiet skip.
    jun = {"probe": "P1-junction", "required": True, "title": "directory junction leaf"}
    try:
        os.makedirs(P1_JUNCTION_TARGET, exist_ok=True)
        write_file(P1_JUNCTION_SENTINEL, JUNCTION_SENTINEL)
        # A FIXED LITERAL command-interpreter invocation with module-derived operands,
        # bounded by MKLINK_TIMEOUT_S. `mklink` is a cmd.exe builtin with no API
        # equivalent available here, so `cmd /c` is required and this step really does
        # start an interpreter -- shell=False stops Python interpolating a shell string,
        # it does not make cmd.exe stop being one. Both operands are module-derived
        # constants and there is no caller operand source anywhere in this file.
        proc = subprocess.run(
            ["cmd", "/c", "mklink", "/J", P1_JUNCTION, P1_JUNCTION_TARGET],
            capture_output=True,
            timeout=MKLINK_TIMEOUT_S,
            shell=False,
        )
        jun["mklink_returncode"] = proc.returncode
        jun["mklink_stdout"] = proc.stdout.decode("utf-8", "replace")[:400]
        jun["mklink_stderr"] = proc.stderr.decode("utf-8", "replace")[:400]
        jun["fixture_creation_supported"] = proc.returncode == 0 and os.path.exists(P1_JUNCTION)
    except (OSError, subprocess.SubprocessError) as exc:
        jun["fixture_creation_supported"] = False
        jun["detail"] = "junction fixture could not be created: %s" % exc

    if jun.get("fixture_creation_supported"):
        jun["link_before"] = path_facts(P1_JUNCTION)
        jun_target_before = path_facts(P1_JUNCTION_TARGET)
        jun["target_before"] = jun_target_before
        jun.update(classify_link_open(opener, P1_JUNCTION, jun_target_before.get("identity", {})))
        try:
            with open(P1_JUNCTION_SENTINEL, "rb") as fh:
                jun["target_sentinel_unchanged"] = fh.read() == JUNCTION_SENTINEL
        except OSError as exc:
            jun["target_sentinel_unchanged"] = False
            jun["target_read_error"] = str(exc)
        jun_after = path_facts(P1_JUNCTION_TARGET)
        jun["target_after"] = jun_after
        jun["target_still_directory"] = bool(jun_after.get("is_dir_by_lstat"))
        # Q15: a modified target is a CONTRADICTION, exactly as it already is for the
        # symlink arm. Phase 4 recorded target_sentinel_unchanged here but never promoted
        # it, which left the two reparse arms inconsistent.
        if not jun.get("target_sentinel_unchanged") or not jun["target_still_directory"]:
            jun["status"] = "CONTRADICTION"
            jun["note"] = (
                "the junction's target was modified or replaced during a no-follow open"
            )
    else:
        jun["status"] = "NOTRUN_GAP"
        jun["reason"] = "junction_fixture_unavailable"
        jun.setdefault("detail", "mklink /J did not create the junction fixture")
    results.append(jun)
    return results


# ── P2 ──────────────────────────────────────────────────────────────────────────────
def probe_p2(opener: Win32Opener) -> dict:
    """An ordinary directory at the lock leaf. The EXACT Win32 error is recorded; nothing
    is guessed. Because FILE_FLAG_BACKUP_SEMANTICS is deliberately omitted and only
    OPEN_EXISTING is documented as valid for directories, the open is expected to fail --
    fail-closed by construction. An open that SUCCEEDS here contradicts the design."""
    obs = {"probe": "P2", "required": True, "title": "ordinary directory at the lock leaf"}
    os.makedirs(P2_DIR, exist_ok=True)
    write_file(P2_DIR_SENTINEL, P2_SENTINEL)
    before = path_facts(P2_DIR)
    obs["dir_before"] = before

    fd = None
    try:
        fd = opener.open_fd(P2_DIR)
    except ProbeRefusal as exc:
        obs["outcome"] = "REFUSED"
        obs["reason"] = exc.reason
        obs["detail"] = exc.detail
        obs["status"] = "OK"
    else:
        try:
            obs["outcome"] = "OPENED"
            obs["fd_facts"] = describe_fd(fd)
            obs["status"] = "CONTRADICTION"
            obs["note"] = (
                "a directory was opened without FILE_FLAG_BACKUP_SEMANTICS; the refusal "
                "the design relies on did not occur"
            )
        finally:
            os.close(fd)

    after = path_facts(P2_DIR)
    obs["dir_after"] = after
    obs["still_directory"] = bool(after.get("is_dir_by_lstat"))
    try:
        with open(P2_DIR_SENTINEL, "rb") as fh:
            obs["sentinel_unchanged"] = fh.read() == P2_SENTINEL
    except OSError as exc:
        obs["sentinel_unchanged"] = False
        obs["sentinel_read_error"] = str(exc)
    if not obs["still_directory"] or not obs["sentinel_unchanged"]:
        obs["status"] = "CONTRADICTION"
        obs["note"] = "the directory or its contents were mutated by a refused open"
    obs["product_mapping_note"] = (
        "if the recorded winerror is not a documented TYPE discriminator, the product must "
        "map a directory refusal to queue_unavailable rather than claiming lock_not_regular "
        "on an undocumented basis"
    )
    return obs


# ── P4 ──────────────────────────────────────────────────────────────────────────────
def child_hold_lock() -> int:
    """Child half of P4: take the byte-0 lock through the SAME no-follow conversion,
    announce readiness on stdout, then wait bounded to be terminated by the parent.

    It never unlinks or recreates the lock, and it signals only on its own stdout pipe.
    """
    import msvcrt

    try:
        opener = Win32Opener()
    except Exception as exc:
        # Announce the failure on the readiness channel instead of dying with a traceback:
        # the parent must be able to tell "the child could not bind the opener" apart from
        # "the child never spoke".
        sys.stdout.write(
            json.dumps({"ready": False, "reason": "child_opener_unavailable", "detail": str(exc)[:400]}) + "\n"
        )
        sys.stdout.flush()
        return EXIT_GAP

    try:
        fd = opener.open_fd(P4_LOCK)
    except ProbeRefusal as exc:
        sys.stdout.write(json.dumps({"ready": False, "reason": exc.reason, "detail": exc.detail}) + "\n")
        sys.stdout.flush()
        return EXIT_GAP
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError as exc:
        sys.stdout.write(json.dumps({"ready": False, "reason": "child_lock_failed", "detail": str(exc)}) + "\n")
        sys.stdout.flush()
        os.close(fd)
        return EXIT_GAP
    sys.stdout.write(json.dumps({"ready": True, "pid": os.getpid(), "locked_bytes": 1}) + "\n")
    sys.stdout.flush()
    # Bounded hold. The parent terminates this process long before the cap; the cap only
    # guarantees the child cannot outlive the job if the parent dies first.
    deadline = time.monotonic() + CHILD_MAX_HOLD_S
    while time.monotonic() < deadline:
        time.sleep(0.25)
    os.close(fd)
    return EXIT_OK


def probe_p4(opener: Win32Opener) -> dict:
    """Measure whether a msvcrt.locking lock is really released after the real Windows
    TerminateProcess. This replaces a two-document inference (D10b) with a measurement.

    The contention check comes FIRST: without observed contention the release measurement
    would be meaningless, and that is reported rather than quietly passed.
    """
    import msvcrt

    obs = {"probe": "P4", "required": True, "title": "msvcrt.locking release after TerminateProcess"}
    write_file(P4_LOCK, P4_SENTINEL)

    child = subprocess.Popen(
        [sys.executable, SELF, "--child-op", "hold-lock"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
    )
    obs["child_pid"] = child.pid

    # Bounded readiness read: a reader thread plus join(timeout). No unbounded read.
    holder = {}

    def read_line() -> None:
        try:
            holder["line"] = child.stdout.readline()
        except Exception as exc:  # pragma: no cover - diagnostic resilience
            holder["error"] = str(exc)

    reader = threading.Thread(target=read_line, daemon=True)
    reader.start()
    reader.join(READINESS_WAIT_S)
    raw = holder.get("line") or b""
    obs["readiness_raw"] = raw.decode("utf-8", "replace").strip()[:400]
    try:
        readiness = json.loads(raw.decode("utf-8")) if raw.strip() else {}
    except ValueError:
        readiness = {}
    obs["child_ready"] = bool(readiness.get("ready"))

    parent_fd = None
    try:
        if not obs["child_ready"]:
            obs["status"] = "GAP_NO_READINESS"
            obs["detail"] = "the child did not announce a held lock within the bounded wait"
            return obs

        # 1) contention FIRST
        try:
            parent_fd = opener.open_fd(P4_LOCK)
        except ProbeRefusal as exc:
            obs["status"] = "GAP_PARENT_OPEN_REFUSED"
            obs["reason"] = exc.reason
            obs["detail"] = exc.detail
            return obs
        os.lseek(parent_fd, 0, os.SEEK_SET)
        try:
            msvcrt.locking(parent_fd, msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            obs["contention_observed"] = True
            obs["contention_errno"] = getattr(exc, "errno", None)
            obs["contention_winerror"] = getattr(exc, "winerror", None)
            obs["contention_detail"] = str(exc)
        else:
            # We unexpectedly hold it: release immediately and report honestly.
            msvcrt.locking(parent_fd, msvcrt.LK_UNLCK, 1)
            obs["contention_observed"] = False
            obs["status"] = "GAP_NO_CONTENTION"
            obs["detail"] = (
                "the parent acquired the lock while the child claimed to hold it, so the "
                "subsequent release measurement would be meaningless"
            )
            return obs

        # 2) terminate ONLY this child, then wait for it, bounded
        kill_at = time.monotonic()
        child.kill()  # the real Windows TerminateProcess via Popen; never mocked
        try:
            child.wait(timeout=CHILD_REAP_WAIT_S)
            obs["child_reaped"] = True
        except subprocess.TimeoutExpired:
            obs["child_reaped"] = False
        obs["child_returncode"] = child.returncode
        obs["child_reap_seconds"] = round(time.monotonic() - kill_at, 3)

        # 3) bounded reacquisition window
        deadline = time.monotonic() + REACQUIRE_WINDOW_S
        attempts = 0
        last_error = None
        reacquired = False
        while time.monotonic() < deadline:
            attempts += 1
            os.lseek(parent_fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(parent_fd, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                last_error = {
                    "errno": getattr(exc, "errno", None),
                    "winerror": getattr(exc, "winerror", None),
                    "detail": str(exc),
                }
                time.sleep(REACQUIRE_POLL_S)
                continue
            reacquired = True
            msvcrt.locking(parent_fd, msvcrt.LK_UNLCK, 1)
            break
        obs["reacquire_attempts"] = attempts
        obs["reacquire_seconds"] = round(time.monotonic() - kill_at, 3)
        obs["reacquire_window_seconds"] = REACQUIRE_WINDOW_S
        obs["reacquired"] = reacquired
        obs["last_error"] = last_error
        if reacquired:
            obs["status"] = "OK_RELEASED"
            obs["note"] = (
                "the elapsed time is an OBSERVATION on this runner, not a promised OS "
                "unlock latency: LockFile documents release on termination but states the "
                "time depends upon available system resources"
            )
        else:
            obs["status"] = "GAP_NOT_REACQUIRED"
            obs["note"] = (
                "not reacquired within the bounded window; recorded as an observation gap, "
                "never as a passing release claim"
            )
        return obs
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        if child.poll() is None:
            child.kill()
            try:
                child.wait(timeout=CHILD_REAP_WAIT_S)
            except subprocess.TimeoutExpired:
                pass
        for stream in (child.stdout, child.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass


# ── cleanup, bounded and fixture-owned ──────────────────────────────────────────────
def cleanup() -> list:
    """Remove ONLY this probe's own fixtures, by their fixed names. The directory is
    never enumerated for deletion and nothing outside SCRATCH is touched. A junction is
    removed with rmdir, which unlinks the junction itself, not its target."""
    notes = []
    for path in (P1_JUNCTION, P1_LINK):
        try:
            if os.path.lexists(path):
                if os.path.isdir(path) and not os.path.islink(path):
                    os.rmdir(path)
                else:
                    os.unlink(path)
        except OSError as exc:
            notes.append("could not remove %s: %s" % (os.path.basename(path), exc))
    for path in (P0_LOCK, P1_TARGET, P4_LOCK, P2_DIR_SENTINEL, P1_JUNCTION_SENTINEL):
        try:
            if os.path.lexists(path):
                os.unlink(path)
        except OSError as exc:
            notes.append("could not remove %s: %s" % (os.path.basename(path), exc))
    for path in (P2_DIR, P1_JUNCTION_TARGET, SCRATCH):
        try:
            if os.path.isdir(path):
                os.rmdir(path)
        except OSError as exc:
            notes.append("could not remove dir %s: %s" % (os.path.basename(path), exc))
    return notes


# ── aggregation ─────────────────────────────────────────────────────────────────────
def overall_exit(observations: list) -> int:
    """A required measurement that contradicts the design outranks a gap. A probe that
    merely refused everything cannot reach 0, because P0 is required and must succeed.

    As of Q15 every probe in this file is required, so the non-required branch below is
    currently unreachable. It is kept deliberately: it is the rule for any future probe
    added as optional, and deleting it would invite the next author to assume optional
    gaps fail the run."""
    contradiction = False
    gap = False
    for obs in observations:
        status = str(obs.get("status", "GAP_UNRECORDED"))
        if not obs.get("required"):
            # An optional probe can still report a contradiction; a gap in one cannot
            # fail the run.
            if status == "CONTRADICTION":
                contradiction = True
            continue
        if status == "CONTRADICTION":
            contradiction = True
        elif not status.startswith("OK"):
            gap = True
    if contradiction:
        return EXIT_CONTRADICTION
    if gap:
        return EXIT_GAP
    return EXIT_OK


def emit(document: dict, code: int) -> int:
    document["overall_exit"] = code
    sys.stdout.write(json.dumps(document, indent=2, sort_keys=True, default=str) + "\n")
    sys.stdout.flush()
    return code


def parse_argv(argv: list) -> str | None:
    """Closed operand surface, resolved BEFORE any IO. Parent mode takes no operands;
    the only other accepted form is the single closed child selector."""
    if not argv:
        return None
    if len(argv) == 2 and argv[0] == "--child-op" and argv[1] in CHILD_OPS:
        return argv[1]
    sys.stderr.write(
        "windows-nofollow-probe-1172.py: refusing unexpected operands %r; this diagnostic "
        "accepts no path or command arguments, only --child-op <%s>\n"
        % (argv, "|".join(CHILD_OPS))
    )
    return "__refuse__"


def main(argv: list) -> int:
    selector = parse_argv(argv)
    if selector == "__refuse__":
        return EXIT_USAGE

    document = {
        "v": 1,
        "probe": "windows-nofollow-probe-1172",
        "task": 1172,
        "purpose": "measure the native Windows behaviours the no-follow lock design depends on",
        "not_a_claim": (
            "parsing or passing this probe is NOT native acceptance and NOT evidence that "
            "Windows is supported; it records measurements taken on one runner"
        ),
        "platform": sys.platform,
        "python_version": sys.version,
        "python_version_info": list(sys.version_info[:3]),
        "python_floor_note": (
            "st_file_attributes requires 3.5 and st_reparse_tag requires 3.8; the version "
            "string is context for the measurement and never a substitute for the actual "
            "capability checks recorded here (Q7)"
        ),
        "constants_used": CONSTANTS_USED,
        "scratch_root_leaf": os.path.basename(SCRATCH),
        "observations": [],
    }

    if sys.platform != "win32":
        document["refusal"] = {
            "reason": "not_win32",
            "detail": "this diagnostic measures native Windows behaviour and refuses to "
                      "simulate it on another platform; no fixture was created",
        }
        return emit(document, EXIT_NOT_WIN32)

    if selector == "hold-lock":
        # Child mode writes ONE readiness line and no JSON document: its stdout is the
        # parent's private pipe, not the run's machine-readable result.
        return child_hold_lock()

    os.makedirs(SCRATCH, exist_ok=True)
    observations = document["observations"]
    try:
        opener = Win32Opener()
    except Exception as exc:
        document["refusal"] = {
            "reason": "opener_unavailable",
            "detail": "could not bind CreateFileW through ctypes: %s" % exc,
        }
        document["cleanup_notes"] = cleanup()
        return emit(document, EXIT_GAP)

    for probe in (probe_p0, probe_p1, probe_p2, probe_p4):
        try:
            result = probe(opener)
        except ProbeRefusal as exc:
            result = {
                "probe": probe.__name__,
                "required": True,
                "status": "GAP_REFUSED",
                "reason": exc.reason,
                "detail": exc.detail,
            }
        except Exception as exc:  # every failure is recorded, never swallowed
            result = {
                "probe": probe.__name__,
                "required": True,
                "status": "GAP_UNEXPECTED_ERROR",
                "reason": type(exc).__name__,
                "detail": str(exc)[:600],
            }
        if isinstance(result, list):
            observations.extend(result)
        else:
            observations.append(result)

    document["cleanup_notes"] = cleanup()
    document["summary"] = {
        obs.get("probe", "?"): obs.get("status", "GAP_UNRECORDED") for obs in observations
    }
    return emit(document, overall_exit(observations))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
