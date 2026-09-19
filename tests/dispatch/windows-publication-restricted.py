"""Restricted-own-token supervisor; API compatibility only, never activation.

Native use (CPython 3.12.10):
  python -I tests/dispatch/windows-publication-restricted.py --probe ABS_PROBE \
    --parent ABS_DISPOSABLE_NTFS_PARENT --artifact ABS_DIAGNOSTIC \
    --attest-local-unsynced-disposable-parent

Independent testers may import validate_token, validate_receipt, check_hash and
api_failure on any platform. --negative-case only injects failures, never success:
elevated/admin/unknown corrupt actual-child evidence before ResumeThread; hash
rejects before launch; api1314/access-denied reject at the launch boundary; timeout
expires while the owned child is suspended. Native prerequisite refusals can occur
before a selected seam is reached; negativeCaseReached distinguishes that case.
"""

import argparse
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


PINNED_PROBE_HASHES = {
    "8e453d014bdd04ee237c108eb6062cf6783c5fded97649e9d030df365c4c615e",  # LF
    "628a49675c0bedcf30813285577a6a334cfa69c493f44e2b59518389a3c10290",  # CRLF
}
OPERATIONS = ("same_handle_new", "same_handle_replace", "move_new", "move_replace",
              "nonempty_directory", "exclusive_backup", "sqlite_initial")
INVARIANTS = {"allocationExact", "terminatedNameFits", "filenameBytesMatch",
              "nulTerminated", "lengthExcludesNul", "headerPreserved",
              "viewSharesBuffer", "bufferAligned"}
OBLIGATIONS = {key: "unresolved" for key in ("O1", "O2", "O3", "O4", "O5")}
ADMIN_SID = bytes.fromhex("01020000000000052000000020020000")
MEDIUM_SID = bytes.fromhex("010100000000001000200000")
OUTPUT_LIMIT = 8 * 1024 * 1024
TIMEOUT = 240


class Failure(Exception):
    def __init__(self, reason, code=1, api=None, error=None):
        self.reason, self.code, self.api, self.error = reason, code, api, error


def require(condition, reason):
    if not condition:
        raise Failure(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def api_failure(name, error):
    return Failure("unavailable_capability" if error in (5, 1314) else "api_failure",
                   2 if error in (5, 1314) else 1, name, error)


def check_hash(actual, expected):
    require(actual == expected and actual in PINNED_PROBE_HASHES, "probe_hash_mismatch")


def validate_token(state, parent):
    require(state.get("known") is True, "unknown_token_evidence")
    require(state.get("elevated") is False, "elevated_child")
    require(type(state.get("tokenType")) is int
            and state["tokenType"] == 1, "nonprimary_child")
    require(type(state.get("integrityRid")) is int
            and state["integrityRid"] == 8192, "nonmedium_child")
    require(state.get("userSha256") == parent.get("userSha256")
            and bool(parent.get("userSha256")), "child_user_mismatch")
    require(type(state.get("adminSidPresent")) is bool
            and state.get("adminEnabled") is False
            and state.get("adminDenyOnly") is state["adminSidPresent"], "admin_child")
    require(type(state.get("extraPrivilegeCount")) is int
            and state["extraPrivilegeCount"] == 0, "extra_child_privileges")
    require(type(state.get("privileges")) is list
            and all(p.get("name") == "SeChangeNotifyPrivilege"
                    for p in state["privileges"]), "unknown_child_privileges")


def validate_receipt(child, actual, source, exit_code, diagnostic):
    require(type(child) is dict and type(child.get("schema")) is int
            and child["schema"] == 1
            and child.get("probe") == "windows-publication", "malformed_receipt")
    require(child.get("powerLossProven") is False
            and child.get("activationAuthorized") is False
            and child.get("obligations") == OBLIGATIONS, "invalid_proof_claim")
    identity = child.get("sourceIdentity", {})
    check_hash(identity.get("probe", {}).get("sha256"), source["probe"])
    if identity.get("workflow", {}).get("status") == "unavailable":
        raise Failure("child_workflow_read_refused", 2)
    require(identity.get("workflow", {}).get("sha256") == source["workflow"],
            "workflow_hash_mismatch")
    # The pinned probe emits only fixture-relative paths, hashes, API numbers and
    # fixed diagnostics. Never retain stdout until this provenance check passes.
    diagnostic["childReceipt"] = child
    token = child.get("processToken", {})
    require(token.get("evidenceClass") ==
            "non_elevated_admin_disabled_api_compatibility_only"
            and "diagnosticError" not in token, "unknown_child_report_token")
    for field in ("elevated", "elevationType", "adminSidPresent", "adminEnabled",
                  "adminDenyOnly"):
        scalar_type = int if field == "elevationType" else bool
        require(type(token.get(field)) is scalar_type
                and type(actual.get(field)) is scalar_type
                and token[field] == actual[field], "child_token_mismatch")
    rows = child.get("operations", [])
    require(type(rows) is list and all(type(r) is dict for r in rows), "invalid_operations")
    renames = [event for row in rows for event in row.get("events", [])
               if event.get("check") == "FILE_RENAME_INFO_buffer"]
    diagnostic["measuredCounts"] = {
        "operationRecords": len(rows), "renameBufferRecords": len(renames),
        "apiCompatible": sum(r.get("outcome") == "api_compatible" for r in rows)}
    # Preserve incomplete diagnostics without treating fewer records as acceptance.
    for row in [child] + rows:
        if "getLastError" in row:
            require(type(row["getLastError"]) is int, "child_harness_failure")
        for event in row.get("preflight", row.get("events", [])):
            if "lastErrorMeaningful" in event:
                require(type(event["lastErrorMeaningful"]) is bool,
                        "child_harness_failure")
            if "getLastError" in event:
                require(type(event["getLastError"]) is int, "child_harness_failure")
    failures = [event for row in [child] + rows
                for event in row.get("preflight", row.get("events", []))
                if event.get("lastErrorMeaningful") is True
                and event.get("getLastError") in (5, 1314)]
    unexplained = [row for row in rows if row.get("outcome") == "harness_failure"
                   and not (row.get("failedApi") and row.get("getLastError") in (5, 1314))]
    require(not unexplained, "child_harness_failure")
    if failures or child.get("status") in ("preflight_refusal", "unresolved_capability"):
        raise Failure("child_acl_mic_or_publication_refusal", 2)
    require(type(exit_code) is int and exit_code == 0
            and child.get("status") == "api_compatible_only",
            "child_harness_failure")
    expected = {(op, rep) for op in OPERATIONS for rep in range(1, 11)}
    require(len(rows) == 70 and all(type(r.get("repetition")) is int for r in rows)
            and {(r.get("operation"), r.get("repetition"))
                                for r in rows} == expected, "operation_count_or_identity")
    counts = child.get("counts")
    require(type(child.get("repetitions")) is int and child["repetitions"] == 10
            and type(counts) is dict and all(type(v) is int for v in counts.values())
            and counts == {
        "api_compatible": 70, "capability_refusal": 0, "harness_failure": 0}, "child_counts")
    require(len(renames) == 30, "rename_count")
    for row in rows:
        require(row.get("outcome") == "api_compatible"
                and row.get("powerLossProven") is False, "operation_failed")
        payload = json.dumps({"fixture": "disposable", "epoch": row["repetition"],
                              "mode": "PROBE", "operation": row["operation"]},
                             sort_keys=True).encode()
        verification = row.get("verification", {})
        require(row.get("expectedSha256") == digest(payload)
                and verification.get("documentSha256", verification.get("sha256"))
                == digest(payload) and verification.get("preservedHex") == payload.hex(),
                "fixture_hash_mismatch")
        if row["operation"] == "sqlite_initial":
            settings = row.get("settings")
            require(type(settings) is dict and type(settings.get("synchronous")) is int
                    and settings == {"journalMode": "delete", "lockingMode": "normal",
                                           "synchronous": 3}
                    and verification.get("integrity") == "ok", "sqlite_verification")
        events = [e for e in row["events"] if e.get("check") == "FILE_RENAME_INFO_buffer"]
        require(len(events) == (1 if row["operation"] in
                ("same_handle_new", "same_handle_replace", "nonempty_directory") else 0),
                "rename_distribution")
    for event in renames:
        layout = event.get("layout", {})
        pointer = layout.get("pointerBytes")
        require(all(type(layout.get(key)) is int for key in
                    ("pointerBytes", "booleanBytes", "dwordBytes", "wcharBytes",
                     "structBytes", "structAlignment"))
                and type(layout.get("fieldOffsets")) is list
                and all(type(offset) is int for offset in layout["fieldOffsets"])
                and pointer in (4, 8) and layout.get("booleanBytes") == 1
                and layout.get("dwordBytes") == 4 and layout.get("wcharBytes") == 2
                and layout.get("fieldOffsets") == [0, pointer, 2 * pointer, 2 * pointer + 4]
                and layout.get("structBytes") == (24 if pointer == 8 else 16)
                and layout.get("structAlignment") == pointer
                and event.get("layoutValid") is True, "rename_layout")
        invariants = event.get("invariants", {})
        require(set(invariants) == INVARIANTS and all(v is True for v in invariants.values()),
                "rename_invariants")
        length = event.get("filenameBytes")
        require(type(length) is int and length > 0 and length % 2 == 0
                and all(type(event.get(key)) is int for key in
                        ("filenameLength", "terminatorOffset", "bufferBytes"))
                and event.get("filenameLength") == length
                and event.get("terminatorOffset") == 2 * pointer + 4 + length
                and event.get("terminatorHex") == "0000"
                and event.get("bufferBytes") == max(layout["structBytes"],
                                                     2 * pointer + 4 + length + 2),
                "rename_buffer_size")


class SidAttributes(C.Structure):
    _fields_ = [("sid", W.LPVOID), ("attributes", W.DWORD)]


class Groups(C.Structure):
    _fields_ = [("count", W.DWORD), ("entries", SidAttributes * 1)]


class Luid(C.Structure):
    _fields_ = [("low", W.DWORD), ("high", W.LONG)]


class Privilege(C.Structure):
    _fields_ = [("luid", Luid), ("attributes", W.DWORD)]


class Privileges(C.Structure):
    _fields_ = [("count", W.DWORD), ("entries", Privilege * 1)]


class SecurityAttributes(C.Structure):
    _fields_ = [("length", W.DWORD), ("descriptor", W.LPVOID), ("inherit", W.BOOL)]


class StartupInfo(C.Structure):
    _fields_ = [("cb", W.DWORD), ("reserved", W.LPWSTR), ("desktop", W.LPWSTR),
                ("title", W.LPWSTR), ("x", W.DWORD), ("y", W.DWORD),
                ("xSize", W.DWORD), ("ySize", W.DWORD), ("xChars", W.DWORD),
                ("yChars", W.DWORD), ("fill", W.DWORD), ("flags", W.DWORD),
                ("show", W.WORD), ("reservedSize", W.WORD), ("reservedBytes", W.LPVOID),
                ("stdin", W.HANDLE), ("stdout", W.HANDLE), ("stderr", W.HANDLE)]


class StartupInfoEx(C.Structure):
    _fields_ = [("startup", StartupInfo), ("attributes", W.LPVOID)]


class ProcessInfo(C.Structure):
    _fields_ = [("process", W.HANDLE), ("thread", W.HANDLE),
                ("processId", W.DWORD), ("threadId", W.DWORD)]


class Native:
    def __init__(self):
        self.handles = []
        self.token_query_stage = "unknown"
        self.token_queries = {"records": [], "limit": 64, "truncated": False,
                              "recordingFailed": False}
        pointer = C.sizeof(W.HANDLE)
        require(pointer in (4, 8) and C.sizeof(W.DWORD) == 4 and C.sizeof(W.WCHAR) == 2
                and C.sizeof(Luid) == 8 and C.sizeof(Privilege) == 12
                and C.sizeof(StartupInfo) == (104 if pointer == 8 else 68)
                and C.sizeof(StartupInfoEx) == (112 if pointer == 8 else 72)
                and C.sizeof(ProcessInfo) == (24 if pointer == 8 else 16), "windows_abi")
        kernel = C.WinDLL("kernel32", use_last_error=True)
        security = C.WinDLL("advapi32", use_last_error=True)
        p = C.POINTER
        signatures = {
            "GetCurrentProcess": (kernel, W.HANDLE, []),
            "CloseHandle": (kernel, W.BOOL, [W.HANDLE]),
            "SetHandleInformation": (kernel, W.BOOL, [W.HANDLE, W.DWORD, W.DWORD]),
            "CreatePipe": (kernel, W.BOOL, [p(W.HANDLE), p(W.HANDLE), p(SecurityAttributes), W.DWORD]),
            "PeekNamedPipe": (kernel, W.BOOL, [W.HANDLE, W.LPVOID, W.DWORD, p(W.DWORD), p(W.DWORD), p(W.DWORD)]),
            "ReadFile": (kernel, W.BOOL, [W.HANDLE, W.LPVOID, W.DWORD, p(W.DWORD), W.LPVOID]),
            "InitializeProcThreadAttributeList": (kernel, W.BOOL, [W.LPVOID, W.DWORD, W.DWORD, p(C.c_size_t)]),
            "UpdateProcThreadAttribute": (kernel, W.BOOL, [W.LPVOID, W.DWORD, C.c_size_t, W.LPVOID, C.c_size_t, W.LPVOID, p(C.c_size_t)]),
            "DeleteProcThreadAttributeList": (kernel, None, [W.LPVOID]),
            "ResumeThread": (kernel, W.DWORD, [W.HANDLE]),
            "WaitForSingleObject": (kernel, W.DWORD, [W.HANDLE, W.DWORD]),
            "TerminateProcess": (kernel, W.BOOL, [W.HANDLE, W.UINT]),
            "GetExitCodeProcess": (kernel, W.BOOL, [W.HANDLE, p(W.DWORD)]),
            "GetFileAttributesW": (kernel, W.DWORD, [W.LPCWSTR]),
            "GetVolumePathNameW": (kernel, W.BOOL, [W.LPCWSTR, W.LPWSTR, W.DWORD]),
            "GetDriveTypeW": (kernel, W.UINT, [W.LPCWSTR]),
            "GetVolumeInformationW": (kernel, W.BOOL, [W.LPCWSTR, W.LPWSTR, W.DWORD, p(W.DWORD), p(W.DWORD), p(W.DWORD), W.LPWSTR, W.DWORD]),
            "OpenProcessToken": (security, W.BOOL, [W.HANDLE, W.DWORD, p(W.HANDLE)]),
            "GetTokenInformation": (security, W.BOOL, [W.HANDLE, C.c_int, W.LPVOID, W.DWORD, p(W.DWORD)]),
            "LookupPrivilegeValueW": (security, W.BOOL, [W.LPCWSTR, W.LPCWSTR, p(Luid)]),
            "CreateRestrictedToken": (security, W.BOOL, [W.HANDLE, W.DWORD, W.DWORD, p(SidAttributes), W.DWORD, p(Privilege), W.DWORD, p(SidAttributes), p(W.HANDLE)]),
            "SetTokenInformation": (security, W.BOOL, [W.HANDLE, C.c_int, W.LPVOID, W.DWORD]),
            "CreateProcessAsUserW": (security, W.BOOL, [W.HANDLE, W.LPCWSTR, W.LPWSTR, W.LPVOID, W.LPVOID, W.BOOL, W.DWORD, W.LPVOID, W.LPCWSTR, p(StartupInfoEx), p(ProcessInfo)]),
        }
        for name, (dll, result, arguments) in signatures.items():
            function = getattr(dll, name)
            function.restype, function.argtypes = result, arguments
            setattr(self, name, function)

    def call(self, name, *args, invalid=0):
        C.set_last_error(0)
        result = getattr(self, name)(*args)
        if result == invalid:
            raise api_failure(name, C.get_last_error())
        return result

    def own(self, handle):
        value = handle.value if isinstance(handle, W.HANDLE) else handle
        self.handles.append(value)
        self.call("SetHandleInformation", value, 1, 0)
        return value

    def close(self, handle):
        self.call("CloseHandle", handle)
        self.handles.remove(handle)

    def token(self, process, rights):
        handle = W.HANDLE()
        self.call("OpenProcessToken", process, rights, C.byref(handle))
        return self.own(handle)

    def record_token_query(self, kind, phase, requested, returned, result, error):
        # Only allowlisted labels and bounded scalars; never inspect token memory.
        # Diagnostics must not replace an API/validation failure with their own.
        try:
            if (self.token_query_stage not in ("unknown", "parent", "restricted", "actual_child")
                    or phase not in ("sizing", "data")
                    or any(type(value) is not int or not 0 <= value <= 0xFFFFFFFF
                           for value in (kind, requested, returned, error))):
                self.token_queries["recordingFailed"] = True
                return
            record = {"stage": self.token_query_stage, "informationClass": kind,
                      "phase": phase, "requestedBytes": requested, "returnedBytes": returned,
                      "result": bool(result), "lastError": error,
                      "lastErrorMeaningful": not bool(result)}
            records = self.token_queries["records"]
            if len(records) < self.token_queries["limit"]:
                records.append(record)
            else:
                # Retain the first 63 records and the latest (possibly failing) query.
                self.token_queries["truncated"] = True
                records[-1] = record
        except Exception:
            self.token_queries["recordingFailed"] = True

    def info(self, token, kind):
        size = W.DWORD()
        C.set_last_error(0)
        result = self.GetTokenInformation(token, kind, None, 0, C.byref(size))
        error = C.get_last_error()
        self.record_token_query(kind, "sizing", 0, size.value, result, error)
        if result or error != 122:
            raise Failure("unknown_token_evidence", api="GetTokenInformation", error=error)
        require(4 <= size.value <= 1024 * 1024, "token_size")
        buffer = C.create_string_buffer(size.value)
        result = self.GetTokenInformation(token, kind, buffer, len(buffer), C.byref(size))
        error = C.get_last_error()
        self.record_token_query(kind, "data", len(buffer), size.value, result, error)
        if not result:
            raise Failure("unknown_token_evidence", api="GetTokenInformation",
                          error=error)
        require(size.value == len(buffer), "token_return_size")
        return buffer

    @staticmethod
    def sid(buffer, pointer):
        start = C.addressof(buffer)
        require(pointer is not None and start <= pointer <= start + len(buffer) - 8,
                "token_sid_bounds")
        prefix = C.string_at(pointer, 8)
        length = 8 + 4 * prefix[1]
        require(prefix[0] == 1 and prefix[1] <= 15
                and pointer + length <= start + len(buffer), "token_sid_length")
        return C.string_at(pointer, length)

    def summary(self, token):
        state = {"known": True}
        for kind, key in ((8, "tokenType"), (18, "elevationType"), (20, "elevated")):
            buffer = self.info(token, kind)
            require(len(buffer) == 4, "token_scalar_size")
            value = W.DWORD.from_buffer(buffer).value
            if key == "elevated":
                require(value in (0, 1), "unknown_elevation")
                value = bool(value)
            state[key] = value
        require(state["elevationType"] in (1, 2, 3), "unknown_elevation_type")
        for kind, key in ((1, "userSha256"), (25, "integrityRid")):
            buffer = self.info(token, kind)
            require(len(buffer) >= C.sizeof(SidAttributes), "token_label_size")
            sid = self.sid(buffer, SidAttributes.from_buffer(buffer).sid)
            if key == "integrityRid":
                require(sid[:8] == MEDIUM_SID[:8], "unknown_integrity_sid")
                state[key] = int.from_bytes(sid[-4:], "little")
            else:
                state[key] = digest(sid)
        buffer = self.info(token, 2)
        count = W.DWORD.from_buffer(buffer).value
        require(Groups.entries.offset + count * C.sizeof(SidAttributes) <= len(buffer),
                "token_groups_bounds")
        state.update(adminSidPresent=False, adminEnabled=False, adminDenyOnly=False)
        for entry in (SidAttributes * count).from_buffer(buffer, Groups.entries.offset):
            if self.sid(buffer, entry.sid) == ADMIN_SID:
                require(not state["adminSidPresent"], "duplicate_admin_sid")
                state.update(adminSidPresent=True, adminEnabled=bool(entry.attributes & 4),
                             adminDenyOnly=bool(entry.attributes & 16))
        names = {}
        for name in ("SeChangeNotifyPrivilege", "SeIncreaseQuotaPrivilege"):
            luid = Luid()
            self.call("LookupPrivilegeValueW", None, name, C.byref(luid))
            names[(luid.low, luid.high)] = name
        buffer = self.info(token, 3)
        count = W.DWORD.from_buffer(buffer).value
        require(Privileges.entries.offset + count * C.sizeof(Privilege) <= len(buffer),
                "token_privileges_bounds")
        state["privileges"] = [{"name": names.get((p.luid.low, p.luid.high), "other"),
                                "attributes": p.attributes}
                               for p in (Privilege * count).from_buffer(buffer, Privileges.entries.offset)]
        state["extraPrivilegeCount"] = sum(p["name"] != "SeChangeNotifyPrivilege"
                                           for p in state["privileges"])
        return state

    def pipe(self, inherit_read):
        read, write = W.HANDLE(), W.HANDLE()
        attributes = SecurityAttributes(C.sizeof(SecurityAttributes), None, True)
        self.call("CreatePipe", C.byref(read), C.byref(write), C.byref(attributes), 0)
        # Register both before any fallible call, so partial setup is closed too.
        self.handles.extend((read.value, write.value))
        self.call("SetHandleInformation", write if inherit_read else read, 1, 0)
        return read.value, write.value

    def drain(self, handle, output, totals, key):
        available = W.DWORD()
        if not self.PeekNamedPipe(handle, None, 0, None, C.byref(available), None):
            error = C.get_last_error()
            if error == 109:
                return False
            raise api_failure("PeekNamedPipe", error)
        if available.value:
            buffer = C.create_string_buffer(min(available.value, 65536))
            size = W.DWORD()
            self.call("ReadFile", handle, buffer, len(buffer), C.byref(size), None)
            totals[key] += size.value
            require(totals[key] <= OUTPUT_LIMIT, "child_output_limit")
            if output is not None:
                output.extend(buffer.raw[:size.value])
        return True


def attest_parent(api, parent):
    if (not parent.is_absolute() or str(parent).startswith(("\\\\", "//"))
            or ":" in str(parent)[2:] or parent.is_reserved()
            or any(part.endswith((".", " ")) for part in parent.parts)
            or os.path.normcase(str(parent.resolve(strict=True))) != os.path.normcase(str(parent))):
        raise Failure("unsafe_parent", 2)
    for path in (parent, *parent.parents):
        flags = api.call("GetFileAttributesW", str(path), invalid=0xFFFFFFFF)
        if flags & (0x400 | 0x1000 | 0x40000 | 0x400000) or not flags & 0x10:
            raise Failure("unsafe_parent_attributes", 2)
    volume, filesystem = C.create_unicode_buffer(261), C.create_unicode_buffer(64)
    api.call("GetVolumePathNameW", str(parent), volume, len(volume))
    api.call("GetVolumeInformationW", volume.value, None, 0, None, None, None,
             filesystem, len(filesystem))
    if api.GetDriveTypeW(volume.value) != 3 or filesystem.value.upper() != "NTFS":
        raise Failure("requires_fixed_ntfs", 2)


def execute(args, receipt):
    if sys.platform != "win32":
        raise Failure("native_windows_required", 2)
    require(sys.version_info[:3] == (3, 12, 10), "python_version_mismatch")
    if not args.attest_local_unsynced_disposable_parent:
        raise Failure("parent_not_attested", 2)
    probe, parent = Path(args.probe), Path(args.parent)
    require(probe.is_absolute() and parent.is_absolute() and Path(args.artifact).is_absolute(),
            "absolute_paths_required")
    workflow = probe.parents[2] / ".github/workflows/windows-publication-probe.yml"
    paths = {"probe": probe, "workflow": workflow, "supervisor": Path(__file__).resolve()}
    source = {key: digest(path.read_bytes()) for key, path in paths.items()}
    receipt["sourceHashes"] = source
    if args.negative_case == "hash":
        receipt["negativeCaseReached"] = True
        check_hash("0" * 64, source["probe"])
    check_hash(source["probe"], source["probe"])
    api = Native()
    # Share the live bounded evidence so exceptions and cleanup cannot discard it.
    receipt["tokenQueryDiagnostics"] = api.token_queries
    process = None
    attributes = None
    attribute_ready = False
    reaped = False
    try:
        attest_parent(api, parent)
        receipt["parentAttestation"] = "caller_attested_local_unsynced_disposable_fixed_ntfs"
        root = parent / ("windows-publication-restricted-" + uuid.uuid4().hex)
        require(not root.exists(), "root_collision")
        receipt["parentRights"] = {"requiredTokenRightsAvailable": False,
                                   "increaseQuotaAvailable": False}
        own_token = api.token(api.GetCurrentProcess(), 0x008F)
        receipt["parentRights"]["requiredTokenRightsAvailable"] = True
        api.token_query_stage = "parent"
        parent_token = api.summary(own_token)
        receipt["parentTokenSummary"] = parent_token
        require(parent_token["tokenType"] == 1, "parent_not_primary")
        quota = any(p["name"] == "SeIncreaseQuotaPrivilege" and not p["attributes"] & 4
                    for p in parent_token["privileges"])
        receipt["parentRights"]["increaseQuotaAvailable"] = quota
        if not quota:
            raise Failure("increase_quota_unavailable", 2)
        admin = C.create_string_buffer(ADMIN_SID)
        disabled = SidAttributes(C.addressof(admin), 0)
        restricted = W.HANDLE()
        api.call("CreateRestrictedToken", own_token, 0x5, 1, C.byref(disabled),
                 0, None, 0, None, C.byref(restricted))
        token = api.own(restricted)
        medium = C.create_string_buffer(MEDIUM_SID)
        label = SidAttributes(C.addressof(medium), 0x20)
        api.call("SetTokenInformation", token, 25, C.byref(label),
                 C.sizeof(label) + len(MEDIUM_SID))
        api.token_query_stage = "restricted"
        restricted_summary = api.summary(token)
        receipt["restrictedTokenSummary"] = restricted_summary
        validate_token(restricted_summary, parent_token)
        stdin_read, stdin_write = api.pipe(True)
        stdout_read, stdout_write = api.pipe(False)
        stderr_read, stderr_write = api.pipe(False)
        api.close(stdin_write)  # Child stdin is EOF; no inherited console handle.
        size = C.c_size_t()
        C.set_last_error(0)
        result = api.InitializeProcThreadAttributeList(None, 1, 0, C.byref(size))
        require(not result and C.get_last_error() == 122 and 0 < size.value <= 65536,
                "attribute_list_size")
        attributes = C.create_string_buffer(size.value)
        api.call("InitializeProcThreadAttributeList", attributes, 1, 0, C.byref(size))
        attribute_ready = True
        handles = (W.HANDLE * 3)(stdin_read, stdout_write, stderr_write)
        api.call("UpdateProcThreadAttribute", attributes, 0, 0x20002, handles,
                 C.sizeof(handles), None, None)
        startup = StartupInfoEx()
        startup.startup.cb = C.sizeof(startup)
        startup.startup.flags = 0x100
        startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = handles
        startup.attributes = C.addressof(attributes)
        command = C.create_unicode_buffer(subprocess.list2cmdline([
            sys.executable, "-I", str(probe), "--root", str(root), "--receipt",
            str(root / "receipt.json"), "--attest-local-unsynced-disposable-parent"]))
        # NULL environment preserves the caller's environment/proxy/CA in memory;
        # the account is unchanged. No environment values enter this diagnostic.
        receipt["launch"] = {"api": "CreateProcessAsUserW", "attempted": False,
                             "suspended": True, "inheritedHandleCount": 3}
        if args.negative_case in ("api1314", "access-denied"):
            receipt["negativeCaseReached"] = True
            raise api_failure("CreateProcessAsUserW", 1314 if args.negative_case == "api1314" else 5)
        info = ProcessInfo()
        receipt["launch"]["attempted"] = True
        api.call("CreateProcessAsUserW", token, sys.executable, command, None, None, True,
                 0x4 | 0x08000000 | 0x400 | 0x80000, None, str(probe.parents[2]),
                 C.byref(startup), C.byref(info))
        # Own both handles immediately, even if a later handle-flag check fails.
        process = info.process
        api.handles.extend((info.process, info.thread))
        api.call("SetHandleInformation", info.process, 1, 0)
        api.call("SetHandleInformation", info.thread, 1, 0)
        for handle in (stdin_read, stdout_write, stderr_write):
            api.close(handle)
        try:
            child_token = api.token(process, 0x8)
        except Failure as error:
            raise Failure("unknown_actual_child_token", api=error.api, error=error.error) from None
        api.token_query_stage = "actual_child"
        actual = api.summary(child_token)
        receipt["actualChildTokenSummary"] = actual
        candidate = dict(actual)
        if args.negative_case in ("elevated", "admin", "unknown"):
            receipt["negativeCaseReached"] = True
            candidate[{"elevated": "elevated", "admin": "adminEnabled",
                       "unknown": "known"}[args.negative_case]] = args.negative_case != "unknown"
        validate_token(candidate, parent_token)
        require(actual == restricted_summary, "restricted_actual_token_mismatch")
        if args.negative_case == "timeout":
            receipt["negativeCaseReached"] = True
            raise Failure("child_timeout")
        require(api.call("ResumeThread", info.thread, invalid=0xFFFFFFFF) == 1,
                "unexpected_suspend_count")
        receipt["launch"]["resumed"] = True
        output = bytearray()
        totals = {"stdoutBytes": 0, "stderrBytesDiscarded": 0}
        receipt["output"] = totals
        deadline = time.monotonic() + TIMEOUT
        while True:
            out_open = api.drain(stdout_read, output, totals, "stdoutBytes")
            err_open = api.drain(stderr_read, None, totals, "stderrBytesDiscarded")
            wait = api.call("WaitForSingleObject", process, 10, invalid=0xFFFFFFFF)
            require(wait in (0, 258), "unknown_wait_result")
            if wait == 0:
                reaped = True
                if not out_open and not err_open:
                    break
            if time.monotonic() >= deadline:
                raise Failure("child_timeout")
        code = W.DWORD()
        api.call("GetExitCodeProcess", process, C.byref(code))
        receipt["childExitCode"] = code.value
        for key, path in paths.items():
            require(digest(path.read_bytes()) == source[key], "source_changed_during_run")
        if not output and code.value in (2, 5, 0xC0000022, 0xC0000135):
            raise Failure("child_launch_acl_mic_or_dependency_refusal", 2)
        child = json.loads(output.decode("utf-8"))
        validate_receipt(child, actual, source, code.value, receipt)
        receipt["status"] = "restricted_api_compatible_only"
        receipt["ordinaryUserEvidence"] = "restricted_own_token_conditions_observed_only"
        return 0
    finally:
        errors = []
        if process is not None and not reaped:
            try:
                wait = api.call("WaitForSingleObject", process, 0, invalid=0xFFFFFFFF)
                if wait != 0:
                    # The child can exit between the wait and termination request.
                    if not api.TerminateProcess(process, 1):
                        error = C.get_last_error()
                        if api.call("WaitForSingleObject", process, 0, invalid=0xFFFFFFFF) != 0:
                            raise api_failure("TerminateProcess", error)
                require(api.call("WaitForSingleObject", process, 5000,
                                 invalid=0xFFFFFFFF) == 0, "child_reap_timeout")
                receipt["ownedChildReaped"] = True
            except Failure as error:
                errors.append(error.reason)
        elif reaped:
            receipt["ownedChildReaped"] = True
        if attribute_ready:
            api.DeleteProcThreadAttributeList(attributes)
        for handle in list(reversed(api.handles)):
            try:
                api.close(handle)
            except Failure as error:
                errors.append(error.reason)
        receipt["ownedHandlesClosed"] = not api.handles
        if errors:
            receipt["cleanupErrors"] = errors
            raise Failure("cleanup_failure")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("probe", "parent", "artifact"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--attest-local-unsynced-disposable-parent", action="store_true")
    parser.add_argument("--negative-case", choices=("elevated", "admin", "unknown", "hash",
                                                  "api1314", "access-denied", "timeout"))
    args = parser.parse_args()
    receipt = {"schema": 1, "probe": "windows-publication-restricted",
               "status": "harness_failure", "powerLossProven": False,
               "activationAuthorized": False, "obligations": OBLIGATIONS,
               "ordinaryUserEvidence": "unresolved", "negativeCase": args.negative_case,
               "negativeCaseReached": False, "timeoutSeconds": TIMEOUT,
               "limits": ["Restricted same-account API test; not all ordinary-user environments",
                          "Elevated baseline does not establish ordinary-user capability",
                          "No power-loss, recovery, migration or activation proof"]}
    artifact = Path(args.artifact)
    code = 1
    try:
        # Refuse clobbering an existing caller-selected artifact or source file.
        with artifact.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(receipt) + "\n")
    except Exception as error:
        print("Restricted publication: diagnostic_create_failed; " + type(error).__name__)
        return 1
    try:
        code = execute(args, receipt)
    except Failure as error:
        code = error.code
        receipt.update(status="capability_refusal" if code == 2 else "harness_failure",
                       reason=error.reason, failedApi=error.api, winError=error.error)
    except Exception as error:
        receipt.update(status="harness_failure", reason="unexpected_harness_error",
                       errorType=type(error).__name__)
    try:
        artifact.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except Exception as error:
        print("Restricted publication: diagnostic_write_failed; " + type(error).__name__)
        return 1
    print("Restricted publication: " + receipt["status"] + "; powerLossProven=false; O1-O5 unresolved")
    return code


if __name__ == "__main__":
    sys.exit(main())
