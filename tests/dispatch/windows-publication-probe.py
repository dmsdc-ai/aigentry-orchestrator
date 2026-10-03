"""Disposable NTFS API compatibility measurements; never a durability certificate.

No migration, fault injection, process termination, or production data access.
The caller must attest that the fresh root's parent is local and not synchronized;
DRIVE_FIXED alone cannot establish that fact. Refusals are receipt outcomes (exit
0), harness failures exit 1, and unsafe preflight refusals exit 2. Every receipt
keeps O1-O5 unresolved, including when every API succeeds.
"""

import argparse
import ctypes
from ctypes import wintypes as W
import hashlib
import json
import os
from pathlib import Path
import platform
import sqlite3
import sys
from contextlib import contextmanager


READ, WRITE, DELETE = 0x80000000, 0x40000000, 0x00010000
SHARE, CREATE_NEW, OPEN_EXISTING = 7, 1, 3
NORMAL, WRITE_THROUGH, BACKUP = 0x80, 0x80000000, 0x02000000
REPARSE, DIRECTORY = 0x400, 0x10
UNSAFE_ATTRIBUTES = REPARSE | 0x1000 | 0x40000 | 0x400000
REPETITIONS = 10
# Invalid parameter is deliberately NOT a capability refusal: a malformed
# FILE_RENAME_INFO or binding must surface as a harness/API failure.
CAPABILITY_ERRORS = {1, 5, 50, 1314}  # invalid function, denied, unsupported, privilege


class Refusal(Exception):
    pass


class ApiFailure(Exception):
    def __init__(self, api, error):
        self.api, self.error = api, error


class FileInfo(ctypes.Structure):
    _fields_ = [("attributes", W.DWORD), ("created", W.FILETIME),
                ("accessed", W.FILETIME), ("written", W.FILETIME),
                ("volume", W.DWORD), ("size_high", W.DWORD),
                ("size_low", W.DWORD), ("links", W.DWORD),
                ("index_high", W.DWORD), ("index_low", W.DWORD)]


class RenameInfo(ctypes.Structure):
    _fields_ = [("replace", W.BOOLEAN), ("root", W.HANDLE),
                ("length", W.DWORD), ("name", W.WCHAR * 1)]


class SidAndAttributes(ctypes.Structure):
    _fields_ = [("sid", W.LPVOID), ("attributes", W.DWORD)]


class TokenGroups(ctypes.Structure):
    _fields_ = [("count", W.DWORD), ("groups", SidAndAttributes * 1)]


class WinAPI:
    def __init__(self, receipt):
        self.receipt = receipt
        self.events = receipt["preflight"]
        self.dll = ctypes.WinDLL("kernel32", use_last_error=True)
        self.security = ctypes.WinDLL("advapi32", use_last_error=True)
        self.functions = {}
        signatures = {
            "CreateFileW": (W.HANDLE, [W.LPCWSTR, W.DWORD, W.DWORD, W.LPVOID,
                                       W.DWORD, W.DWORD, W.HANDLE]),
            "CloseHandle": (W.BOOL, [W.HANDLE]),
            "GetCurrentProcess": (W.HANDLE, []),
            "FlushFileBuffers": (W.BOOL, [W.HANDLE]),
            "WriteFile": (W.BOOL, [W.HANDLE, W.LPCVOID, W.DWORD,
                                    ctypes.POINTER(W.DWORD), W.LPVOID]),
            "GetFileInformationByHandle": (W.BOOL, [W.HANDLE, ctypes.POINTER(FileInfo)]),
            "SetFileInformationByHandle": (W.BOOL, [W.HANDLE, ctypes.c_int,
                                                      W.LPVOID, W.DWORD]),
            "MoveFileExW": (W.BOOL, [W.LPCWSTR, W.LPCWSTR, W.DWORD]),
            "CreateDirectoryW": (W.BOOL, [W.LPCWSTR, W.LPVOID]),
            "GetFileAttributesW": (W.DWORD, [W.LPCWSTR]),
            "GetVolumePathNameW": (W.BOOL, [W.LPCWSTR, W.LPWSTR, W.DWORD]),
            "GetDriveTypeW": (W.UINT, [W.LPCWSTR]),
            "GetVolumeInformationW": (W.BOOL, [W.LPCWSTR, W.LPWSTR, W.DWORD,
                ctypes.POINTER(W.DWORD), ctypes.POINTER(W.DWORD),
                ctypes.POINTER(W.DWORD), W.LPWSTR, W.DWORD]),
        }
        for name, (result, args) in signatures.items():
            function = getattr(self.dll, name)
            function.restype, function.argtypes = result, args
            self.functions[name] = function
        for name, args in {
            "OpenProcessToken": [W.HANDLE, W.DWORD, ctypes.POINTER(W.HANDLE)],
            "GetTokenInformation": [W.HANDLE, ctypes.c_int, W.LPVOID, W.DWORD,
                                    ctypes.POINTER(W.DWORD)],
        }.items():
            function = getattr(self.security, name)
            function.restype, function.argtypes = W.BOOL, args
            self.functions[name] = function

    def call(self, name, *args, invalid=0, **detail):
        ctypes.set_last_error(0)
        result = self.functions[name](*args)
        error = ctypes.get_last_error()
        self.events.append({"api": name, "result": result, "getLastError": error,
                            "lastErrorMeaningful": result == invalid, **detail})
        if result == invalid:
            raise ApiFailure(name, error)
        return result

    @contextmanager
    def handle(self, path, *, create=False, directory=False, writable=True, access=None):
        if access is None:
            access = READ | WRITE | DELETE if writable else READ
        flags = (BACKUP if directory else NORMAL) | (WRITE_THROUGH if writable else 0)
        handle = self.call("CreateFileW", str(path), access, SHARE, None,
                           CREATE_NEW if create else OPEN_EXISTING, flags, None,
                           invalid=ctypes.c_void_p(-1).value, path=path.name,
                           access=access, share=SHARE, flags=flags,
                           disposition=CREATE_NEW if create else OPEN_EXISTING)
        try:
            yield handle
        finally:
            self.call("CloseHandle", handle, handle=handle)

    def identity(self, handle):
        info = FileInfo()
        self.call("GetFileInformationByHandle", handle, ctypes.byref(info), handle=handle)
        identity = {"volumeSerial": info.volume,
                    "fileIndex": (info.index_high << 32) | info.index_low,
                    "size": (info.size_high << 32) | info.size_low,
                    "links": info.links, "attributes": info.attributes}
        self.events[-1]["identity"] = identity
        return identity

    def flush(self, handle):
        self.call("FlushFileBuffers", handle, handle=handle)

    def write(self, handle, data):
        written = W.DWORD()
        buffer = ctypes.create_string_buffer(data)
        self.call("WriteFile", handle, buffer, len(data), ctypes.byref(written), None,
                  requestedBytes=len(data), handle=handle)
        self.events[-1]["writtenBytes"] = written.value
        if written.value != len(data):
            raise RuntimeError("short_write")

    def rename(self, handle, target, replace=False):
        name = str(target).encode("utf-16-le")
        pointer_bytes = ctypes.sizeof(W.HANDLE)
        offsets = [getattr(RenameInfo, field).offset
                   for field in ("replace", "root", "length", "name")]
        layout = {"pointerBytes": pointer_bytes, "booleanBytes": ctypes.sizeof(W.BOOLEAN),
                  "dwordBytes": ctypes.sizeof(W.DWORD), "wcharBytes": ctypes.sizeof(W.WCHAR),
                  "structBytes": ctypes.sizeof(RenameInfo),
                  "structAlignment": ctypes.alignment(RenameInfo), "fieldOffsets": offsets}
        evidence = {"check": "FILE_RENAME_INFO_buffer", "layout": layout,
                    "filenameBytes": len(name), "filenameSha256": digest(name)}
        self.events.append(evidence)
        # FileRenameInfo uses BOOLEAN ReplaceIfExists, with native HANDLE alignment.
        layout_valid = (pointer_bytes in (4, 8) and layout["booleanBytes"] == 1
                        and layout["dwordBytes"] == 4 and layout["wcharBytes"] == 2
                        and offsets == [0, pointer_bytes, 2 * pointer_bytes,
                                        2 * pointer_bytes + 4]
                        and layout["structBytes"] == (24 if pointer_bytes == 8 else 16)
                        and layout["structAlignment"] == pointer_bytes)
        evidence["layoutValid"] = layout_valid
        check(layout_valid, "rename_buffer_layout")
        check(name and len(name) % 2 == 0 and "\0" not in str(target), "rename_filename_encoding")
        # FileNameLength excludes the NUL; FileName still gets an explicit WCHAR NUL.
        terminated_name = name + b"\0\0"
        size = max(ctypes.sizeof(RenameInfo), RenameInfo.name.offset + len(terminated_name))
        check(size <= 0xFFFFFFFF, "rename_buffer_dword_size")
        buffer = ctypes.create_string_buffer(size)
        # This view and its owning buffer remain alive through the synchronous call.
        info = RenameInfo.from_buffer(buffer)
        info.replace, info.root, info.length = replace, None, len(name)
        ctypes.memmove(ctypes.addressof(buffer) + RenameInfo.name.offset,
                       terminated_name, len(terminated_name))
        name_end = RenameInfo.name.offset + len(name)
        raw = buffer.raw
        invariants = {
            "allocationExact": len(raw) == size,
            "terminatedNameFits": name_end + 2 <= size,
            "filenameBytesMatch": raw[RenameInfo.name.offset:name_end] == name,
            "nulTerminated": raw[name_end:name_end + 2] == b"\0\0",
            "lengthExcludesNul": info.length == len(name),
            "headerPreserved": info.replace == replace and info.root is None,
            "viewSharesBuffer": ctypes.addressof(info) == ctypes.addressof(buffer),
            "bufferAligned": ctypes.addressof(buffer) % ctypes.alignment(RenameInfo) == 0,
        }
        evidence.update(bufferBytes=size, filenameLength=info.length,
                        terminatorOffset=name_end, terminatorHex=raw[name_end:name_end + 2].hex(),
                        invariants=invariants)
        check(all(invariants.values()), "rename_buffer_invariants")
        self.call("SetFileInformationByHandle", handle, 3, buffer, size,
                  infoClass="FileRenameInfo", replaceIfExists=replace,
                  filenameBytes=len(name), bufferBytes=size, target=target.name,
                  handle=handle)

    def safe_existing(self, path):
        # Inspect lexical ancestors BEFORE resolution; resolving first hides links.
        for part in reversed((path, *path.parents)):
            attrs = self.call("GetFileAttributesW", str(part), invalid=0xFFFFFFFF,
                              pathType="ancestor" if part != path else "leaf")
            if attrs & UNSAFE_ATTRIBUTES:
                raise Refusal("reparse_offline_or_recall_path")
        return attrs


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def process_token(api, receipt):
    """Read the primary process token; never adjust privileges or impersonate."""
    token = W.HANDLE()
    state = {"elevated": None, "adminSidPresent": None, "adminEnabled": None,
             "adminDenyOnly": None, "ordinaryUserEvidence": "unresolved",
             "evidenceClass": "token_unknown_api_compatibility_only", "events": []}
    receipt["processToken"] = state
    previous_events, api.events = api.events, state["events"]
    try:
        # GetCurrentProcess returns a pseudo handle: only the real token is closed.
        process = api.call("GetCurrentProcess")
        api.call("OpenProcessToken", process, 0x0008, ctypes.byref(token), access="TOKEN_QUERY")
        try:
            returned = W.DWORD()
            for info_class, field in ((20, "elevated"), (18, "elevationType")):
                value = W.DWORD()
                api.call("GetTokenInformation", token, info_class, ctypes.byref(value),
                         ctypes.sizeof(value), ctypes.byref(returned), infoClass=info_class)
                check(returned.value == ctypes.sizeof(value), "token_value_size")
                state[field] = bool(value.value) if field == "elevated" else value.value
            result = api.call("GetTokenInformation", token, 2, None, 0,
                              ctypes.byref(returned), invalid=None, infoClass="TokenGroups",
                              expectedError=122, lastErrorMeaningful=True)
            check(result == 0 and api.events[-1]["getLastError"] == 122,
                  "token_groups_size_query")
            check(0 < returned.value <= 1024 * 1024, "token_groups_size_bound")
            buffer = ctypes.create_string_buffer(returned.value)
            api.call("GetTokenInformation", token, 2, buffer, len(buffer),
                     ctypes.byref(returned), infoClass="TokenGroups")
            groups = TokenGroups.from_buffer(buffer)
            check(TokenGroups.groups.offset + groups.count * ctypes.sizeof(SidAndAttributes)
                  <= len(buffer), "token_groups_bounds")
            entries = (SidAndAttributes * groups.count).from_buffer(buffer, TokenGroups.groups.offset)
            # Binary S-1-5-32-544 (BUILTIN Administrators), independent of locale.
            admin_sid = bytes.fromhex("01020000000000052000000020020000")
            state.update(adminSidPresent=False, adminEnabled=False, adminDenyOnly=False)
            for entry in entries:
                prefix = ctypes.string_at(entry.sid, 8)
                check(prefix[1] <= 15, "token_sid_size_bound")
                if ctypes.string_at(entry.sid, 8 + 4 * prefix[1]) == admin_sid:
                    state.update(adminSidPresent=True, adminAttributes=entry.attributes,
                                 adminEnabled=bool(entry.attributes & 0x4),
                                 adminDenyOnly=bool(entry.attributes & 0x10))
            if state["elevated"] or state["adminEnabled"]:
                state["evidenceClass"] = "elevated_or_admin_enabled_api_compatibility_only"
            else:
                state["evidenceClass"] = "non_elevated_admin_disabled_api_compatibility_only"
                state["ordinaryUserEvidence"] = "token_conditions_observed_only"
        finally:
            api.call("CloseHandle", token, handle=token.value)
    except Exception as error:
        state.update(diagnosticError=type(error).__name__, ordinaryUserEvidence="unresolved",
                     evidenceClass="token_unknown_api_compatibility_only")
    finally:
        api.events = previous_events


def preflight(api, args, receipt):
    root, target = Path(args.root), Path(args.receipt)
    for path in (root, target):
        text = str(path)
        if (not path.is_absolute() or path.is_reserved() or text.startswith(("\\\\", "//"))
                or len(text) > 200 or ":" in text[2:]
                or any(p in ("..", ".") or p.endswith((".", " ")) for p in path.parts)):
            raise Refusal("unsafe_path")
    if target != root / "receipt.json" or root.exists():
        raise Refusal("requires_fresh_root_and_fixed_receipt_name")
    if not args.attest_local_unsynced_disposable_parent:
        raise Refusal("unsynchronized_disposable_parent_not_attested")
    if not api.safe_existing(root.parent) & DIRECTORY:
        raise Refusal("parent_is_not_directory")
    resolved = root.parent.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(root.parent)):
        raise Refusal("noncanonical_parent")
    if any(p.lower().startswith(("onedrive", "dropbox", "google drive", "icloud"))
           for p in root.parts):
        raise Refusal("known_sync_path")
    for key in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        value = os.environ.get(key)
        if value and (root == Path(value) or Path(value) in root.parents):
            raise Refusal("known_sync_root")
    volume = ctypes.create_unicode_buffer(261)
    api.call("GetVolumePathNameW", str(resolved), volume, len(volume))
    drive = api.call("GetDriveTypeW", volume.value)
    serial, max_component, flags = W.DWORD(), W.DWORD(), W.DWORD()
    fs = ctypes.create_unicode_buffer(64)
    api.call("GetVolumeInformationW", volume.value, None, 0, ctypes.byref(serial),
             ctypes.byref(max_component), ctypes.byref(flags), fs, len(fs))
    receipt["storage"] = {"driveType": drive, "filesystem": fs.value,
                          "volumeSerial": serial.value, "filesystemFlags": flags.value,
                          "maxComponentLength": max_component.value,
                          "unsyncedParent": "caller_attestation_plus_path_checks",
                          "syncSoftwareDetectionComplete": False}
    if drive != 3 or fs.value.upper() != "NTFS":
        raise Refusal("requires_identified_fixed_ntfs")
    api.call("CreateDirectoryW", str(root), None, path="private_fixture_root")
    return root, target


def snapshot(api, directory):
    result = []
    for path in sorted(directory.rglob("*")):
        attrs = api.safe_existing(path)
        if attrs & DIRECTORY:
            continue
        with api.handle(path, writable=False) as handle:
            identity = api.identity(handle)
        data = path.read_bytes()
        entry = {"path": path.relative_to(directory).as_posix(), "pathType": "regular_file",
                 "identity": identity, "sha256": digest(data), "bytes": len(data)}
        # SQLite bytes and journals are never edited or exported. Fixture text only.
        if path.suffix != ".db" and "-journal" not in path.name:
            entry["preservedHex"] = data.hex()
        result.append(entry)
    return result


def create_file(api, path, data):
    with api.handle(path, create=True) as handle:
        api.write(handle, data)
        api.flush(handle)
        return api.identity(handle)


def verify_file(api, path, data, identity=None):
    api.safe_existing(path)
    with api.handle(path, writable=False) as handle:
        actual = api.identity(handle)
    observed = path.read_bytes()  # fresh independent reader; cache is not power-loss proof
    check(observed == data, "reopened_bytes_mismatch")
    if identity:
        check((actual["volumeSerial"], actual["fileIndex"]) ==
              (identity["volumeSerial"], identity["fileIndex"]), "identity_mismatch")
    return {"sha256": digest(observed), "preservedHex": observed.hex(), "identity": actual}


def publication(api, directory, data, comparison=False, replace=False):
    source, target = directory / "export.tmp", directory / "rollback.json"
    if replace:
        create_file(api, target, b"previous disposable rollback export\n")
    if comparison:
        identity = create_file(api, source, data)
        flags = 0x8 | (0x1 if replace else 0)
        api.call("MoveFileExW", str(source), str(target), flags, flags=flags,
                 source=source.name, target=target.name)
        with api.handle(target, access=WRITE) as handle:
            api.flush(handle)
    else:
        with api.handle(source, create=True) as handle:
            api.write(handle, data)
            api.flush(handle)
            identity = api.identity(handle)
            api.rename(handle, target, replace)
            api.flush(handle)
            after = api.identity(handle)
            check(after["fileIndex"] == identity["fileIndex"], "same_handle_identity_changed")
    check(not source.exists(), "source_name_remains")
    return verify_file(api, target, data, identity)


def barrier(api, directory, data):
    staged, target = directory / "barrier.tmp", directory / "active.json"
    api.call("CreateDirectoryW", str(staged), None, path=staged.name)
    marker = staged / "authority.json"
    marker_id = create_file(api, marker, data)
    verify_file(api, marker, data, marker_id)
    with api.handle(staged, directory=True) as handle:
        identity = api.identity(handle)
        api.rename(handle, target)
        api.flush(handle)
        check(api.identity(handle)["fileIndex"] == identity["fileIndex"],
              "directory_identity_changed")
    check(not staged.exists(), "staged_directory_name_remains")
    return verify_file(api, target / "authority.json", data, marker_id)


def backup(api, directory, data):
    source, target = directory / "source.json", directory / "source.pre-sqlite.bak"
    source_id = create_file(api, source, data)
    backup_id = create_file(api, target, data)
    result = verify_file(api, target, data, backup_id)
    # Exercise exclusive-create rejection separately from capability errors.
    try:
        with api.handle(target, create=True):
            raise RuntimeError("exclusive_create_overwrote_fixture")
    except ApiFailure as error:
        if error.api != "CreateFileW" or error.error not in (80, 183):
            raise
        result["exclusiveCreateCollision"] = {"getLastError": error.error,
                                               "outcome": "expected_collision"}
    verify_file(api, source, data, source_id)
    verify_file(api, target, data, backup_id)
    return result


def sqlite_probe(api, directory, data, record):
    path = directory / "active.db"
    uri = path.as_uri() + "?mode=rwc&vfs=win32"
    connection = sqlite3.connect(uri, uri=True, timeout=2, isolation_level=None)
    try:
        build = {"version": connection.execute("SELECT sqlite_version()").fetchone()[0],
                 "sourceId": connection.execute("SELECT sqlite_source_id()").fetchone()[0],
                 "compileOptions": [row[0] for row in connection.execute("PRAGMA compile_options")],
                 "vfs": "win32", "vfsEvidence": "explicit URI vfs=win32 accepted by SQLite"}
        record["sqlite"] = build
        if not build["compileOptions"] or any("OMIT_COMPILEOPTION_DIAGS" in option
                                              for option in build["compileOptions"]):
            raise Refusal("sqlite_compile_options_unavailable")
        if any("NO_SYNC" in option or "OMIT_DISKIO" in option
               for option in build["compileOptions"]):
            raise Refusal("sqlite_build_disables_storage_or_sync")
        settings = {"journalMode": connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0],
                    "lockingMode": connection.execute("PRAGMA locking_mode=NORMAL").fetchone()[0]}
        connection.execute("PRAGMA synchronous=EXTRA")
        settings["synchronous"] = connection.execute("PRAGMA synchronous").fetchone()[0]
        record["settings"] = settings
        if settings != {"journalMode": "delete", "lockingMode": "normal", "synchronous": 3}:
            raise Refusal("sqlite_settings_not_supported")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("CREATE TABLE fixture(epoch INTEGER, mode TEXT, document BLOB)")
        connection.execute("INSERT INTO fixture VALUES (1, 'PROBE', ?)", (data,))
        connection.execute("COMMIT")
        record["commit"] = "returned_success"
    finally:
        connection.close()
        record["close"] = "returned_success"
    with api.handle(path, access=WRITE) as handle:
        api.flush(handle)
        identity = api.identity(handle)
    reader = sqlite3.connect(path.as_uri() + "?mode=ro&vfs=win32", uri=True,
                             timeout=2, isolation_level=None)
    try:
        row = reader.execute("SELECT epoch, mode, document FROM fixture").fetchone()
        integrity = reader.execute("PRAGMA integrity_check").fetchone()[0]
        check(row == (1, "PROBE", data) and integrity == "ok", "sqlite_reopen_mismatch")
        check(reader.execute("PRAGMA journal_mode").fetchone()[0] == "delete",
              "sqlite_reopen_journal_mismatch")
        return {"epoch": row[0], "mode": row[1], "documentSha256": digest(row[2]),
                "preservedHex": row[2].hex(), "integrity": integrity, "identity": identity,
                "lockOutcome": "BEGIN IMMEDIATE succeeded; no contention experiment"}
    finally:
        reader.close()


def run_operations(api, root, receipt):
    operations = ("same_handle_new", "same_handle_replace", "move_new", "move_replace",
                  "nonempty_directory", "exclusive_backup", "sqlite_initial")
    for operation in operations:
        for repetition in range(1, REPETITIONS + 1):
            record = {"operation": operation, "repetition": repetition, "events": [],
                      "outcome": "harness_failure", "powerLossProven": False}
            receipt["operations"].append(record)
            api.events = record["events"]
            directory = root / f"{operation}-{repetition:02d}"
            data = json.dumps({"fixture": "disposable", "epoch": repetition,
                               "mode": "PROBE", "operation": operation}, sort_keys=True).encode()
            record["expectedSha256"] = digest(data)
            try:
                api.call("CreateDirectoryW", str(directory), None, path=directory.name)
                if operation.startswith(("same_handle", "move")):
                    result = publication(api, directory, data, operation.startswith("move"),
                                         operation.endswith("replace"))
                elif operation == "nonempty_directory":
                    result = barrier(api, directory, data)
                elif operation == "exclusive_backup":
                    result = backup(api, directory, data)
                else:
                    result = sqlite_probe(api, directory, data, record)
                record.update(outcome="api_compatible", verification=result)
            except Refusal as error:
                record.update(outcome="capability_refusal", reason=str(error))
            except ApiFailure as error:
                # Only publication capability boundaries permit known refusals.
                boundary = error.api in ("FlushFileBuffers", "SetFileInformationByHandle",
                                         "MoveFileExW") or (
                    operation == "nonempty_directory" and error.api == "CreateFileW"
                    and record["events"][-1].get("flags", 0) & BACKUP)
                record.update(outcome="capability_refusal" if boundary and
                              error.error in CAPABILITY_ERRORS else "harness_failure",
                              failedApi=error.api, getLastError=error.error)
            except sqlite3.Error as error:
                record.update(errorType=type(error).__name__,
                              sqliteErrorCode=getattr(error, "sqlite_errorcode", None),
                              sqliteErrorName=getattr(error, "sqlite_errorname", None))
            except Exception as error:
                record["errorType"] = type(error).__name__  # never exception paths/env
            finally:
                try:
                    record["preservedFixtures"] = snapshot(api, directory)
                except Exception as error:
                    record.update(outcome="harness_failure", snapshotError=type(error).__name__)
                persist(root / "receipt.json", receipt)


def persist(path, receipt):
    # Only our fixed receipt is rewritten; fixtures remain for the runner to discard.
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--attest-local-unsynced-disposable-parent", action="store_true")
    args = parser.parse_args()
    receipt = {"schema": 1, "probe": "windows-publication", "powerLossProven": False,
               "obligations": {name: "unresolved" for name in ("O1", "O2", "O3", "O4", "O5")},
               "activationAuthorized": False, "repetitions": REPETITIONS,
               "preflight": [], "operations": [], "status": "preflight_refusal",
               "limits": ["API compatibility only; reads may be cached",
                          "No power loss, process-kill, migration, or recovery proof",
                          "No launch drain, sibling lock, or old-writer fencing experiment"],
               "python": {"version": sys.version, "implementation": platform.python_implementation(),
                          "pointerBits": ctypes.sizeof(ctypes.c_void_p) * 8}}
    target = None
    code = 2
    try:
        if sys.platform != "win32":
            raise Refusal("native_windows_required")
        version = sys.getwindowsversion()
        receipt["windows"] = {"major": version.major, "minor": version.minor,
                              "build": version.build, "platformVersion": list(version.platform_version)}
        api = WinAPI(receipt)
        process_token(api, receipt)
        script = Path(__file__).resolve()
        receipt["sourceIdentity"] = {
            "probe": {"path": "tests/dispatch/windows-publication-probe.py",
                      "sha256": digest(script.read_bytes())},
            "workflow": {"path": ".github/workflows/windows-publication-probe.yml"}}
        workflow = script.parents[2] / ".github/workflows/windows-publication-probe.yml"
        try:
            receipt["sourceIdentity"]["workflow"]["sha256"] = digest(workflow.read_bytes())
        except OSError:
            receipt["sourceIdentity"]["workflow"]["status"] = "unavailable"
        root, target = preflight(api, args, receipt)
        receipt["status"] = "running"
        persist(target, receipt)
        run_operations(api, root, receipt)
        counts = {name: sum(row["outcome"] == name for row in receipt["operations"])
                  for name in ("api_compatible", "capability_refusal", "harness_failure")}
        receipt["counts"] = counts
        code = 1 if counts["harness_failure"] else 0
        receipt["status"] = ("harness_failure" if code else "unresolved_capability"
                             if counts["capability_refusal"] else "api_compatible_only")
    except Refusal as error:
        receipt["reason"] = str(error)
    except Exception as error:
        code = 1
        receipt.update(status="harness_failure", errorType=type(error).__name__)
    finally:
        if target is not None:
            try:
                persist(target, receipt)
            except Exception as error:
                code = 1
                receipt.update(status="harness_failure", receiptError=type(error).__name__)
        print(json.dumps(receipt, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
