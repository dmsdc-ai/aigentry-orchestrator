"""Bounded owned-child debug startup diagnostic; never publication acceptance.

Native use (CPython 3.12.10):
  python -I tests/dispatch/windows-publication-startup-debug.py --probe ABS_PROBE \
    --parent ABS_DISPOSABLE_NTFS_PARENT --artifact ABS_DIAGNOSTIC \
    --attest-local-unsynced-disposable-parent

This diagnostic preserves the frozen supervisor and its unused receipt validator.
Only the fixed marker payload runs; no publication receipt is parsed or accepted.
Independent testers may import validate_token, check_hash and api_failure. --negative-case only injects failures, never success:
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
PINNED_SUPERVISOR_HASHES = {
    "8e37b3eb085a38a1968849728a0bb87e19f8225b9d2edeeff1e877adac18bf7e",  # LF
    "918111bc18ddb1884fad59ccff60b8953475447b298d5d513838bd7f1d0cd7f7",  # CRLF
}
PINNED_STARTUP_HASHES = {
    "be41602dc7720b66ee608484e501493f9cc504b3faa3355f7adda11fcefed150",  # LF
    "6d905dd891be0dd26b5ce8868d03b4ace7725de6cf8f8e37ed27428e59cef8f6",  # CRLF
}
# Exact fixed line only; allow LF and Windows CRLF, never strip other bytes.
STARTUP_MARKERS = (b"restricted-startup-v1\n", b"restricted-startup-v1\r\n")
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



# Only same-bitness, creation-time events for the fixed owned child are decoded.
class ExceptionRecord(C.Structure):
    _fields_ = [("code", W.DWORD), ("flags", W.DWORD), ("nested", W.LPVOID),
                ("address", W.LPVOID), ("count", W.DWORD),
                ("information", C.c_size_t * 15)]


class ExceptionDebugInfo(C.Structure):
    _fields_ = [("record", ExceptionRecord), ("firstChance", W.DWORD)]


class CreateThreadDebugInfo(C.Structure):
    _fields_ = [("thread", W.HANDLE), ("tls", W.LPVOID), ("start", W.LPVOID)]


class CreateProcessDebugInfo(C.Structure):
    _fields_ = [("file", W.HANDLE), ("process", W.HANDLE), ("thread", W.HANDLE),
                ("base", W.LPVOID), ("debugOffset", W.DWORD), ("debugSize", W.DWORD),
                ("tls", W.LPVOID), ("start", W.LPVOID), ("imageName", W.LPVOID),
                ("unicode", W.WORD)]


class ExitDebugInfo(C.Structure):
    _fields_ = [("code", W.DWORD)]


class LoadDllDebugInfo(C.Structure):
    _fields_ = [("file", W.HANDLE), ("base", W.LPVOID), ("debugOffset", W.DWORD),
                ("debugSize", W.DWORD), ("imageName", W.LPVOID), ("unicode", W.WORD)]


class UnloadDllDebugInfo(C.Structure):
    _fields_ = [("base", W.LPVOID)]


class OutputDebugStringInfo(C.Structure):
    _fields_ = [("data", W.LPVOID), ("unicode", W.WORD), ("length", W.WORD)]


class RipInfo(C.Structure):
    _fields_ = [("error", W.DWORD), ("type", W.DWORD)]


class DebugUnion(C.Union):
    _fields_ = [("exception", ExceptionDebugInfo), ("createThread", CreateThreadDebugInfo),
                ("createProcess", CreateProcessDebugInfo), ("exitThread", ExitDebugInfo),
                ("exitProcess", ExitDebugInfo), ("loadDll", LoadDllDebugInfo),
                ("unloadDll", UnloadDllDebugInfo), ("string", OutputDebugStringInfo),
                ("rip", RipInfo)]


class DebugEvent(C.Structure):
    _fields_ = [("kind", W.DWORD), ("pid", W.DWORD), ("tid", W.DWORD), ("data", DebugUnion)]


def check_debug_abi():
    pointer = C.sizeof(W.HANDLE)
    # Size, alignment and every field offset, including the native union padding.
    layouts = (
        (ExceptionRecord, 152, 80, [0, 4, 8, 16, 24, 32], [0, 4, 8, 12, 16, 20]),
        (ExceptionDebugInfo, 160, 84, [0, 152], [0, 80]),
        (CreateThreadDebugInfo, 24, 12, [0, 8, 16], [0, 4, 8]),
        (CreateProcessDebugInfo, 72, 40, [0, 8, 16, 24, 32, 36, 40, 48, 56, 64],
         [0, 4, 8, 12, 16, 20, 24, 28, 32, 36]),
        (ExitDebugInfo, 4, 4, [0], [0]),
        (LoadDllDebugInfo, 40, 24, [0, 8, 16, 20, 24, 32], [0, 4, 8, 12, 16, 20]),
        (UnloadDllDebugInfo, 8, 4, [0], [0]),
        (OutputDebugStringInfo, 16, 8, [0, 8, 10], [0, 4, 6]),
        (RipInfo, 8, 8, [0, 4], [0, 4]),
        (DebugUnion, 160, 84, [0] * 9, [0] * 9),
        (DebugEvent, 176, 96, [0, 4, 8, 16], [0, 4, 8, 12]),
    )
    require(pointer in (4, 8) and C.sizeof(W.WORD) == 2
            and C.sizeof(C.c_size_t) == pointer, "debug_scalar_abi")
    for structure, size64, size32, offsets64, offsets32 in layouts:
        alignment = 4 if structure in (ExitDebugInfo, RipInfo) else pointer
        require(C.sizeof(structure) == (size64 if pointer == 8 else size32)
                and C.alignment(structure) == alignment
                and [getattr(structure, name).offset for name, _ in structure._fields_]
                == (offsets64 if pointer == 8 else offsets32), "debug_event_abi")


DBG_CONTINUE = 0x00010002
DBG_EXCEPTION_NOT_HANDLED = 0x80010001
DEBUG_RECORD_LIMIT = 512
DEBUG_BYTE_LIMIT = 256 * 1024
DEBUG_STRING_LIMIT = 64 * 1024
MODULE_NAMES = frozenset(("python.exe", "python312.dll", "python3.dll", "ntdll.dll",
                         "kernel32.dll", "kernelbase.dll", "user32.dll", "gdi32.dll",
                         "gdi32full.dll", "win32u.dll", "ucrtbase.dll",
                         "vcruntime140.dll", "vcruntime140_1.dll", "advapi32.dll",
                         "sechost.dll", "rpcrt4.dll", "msvcrt.dll"))
EVENT_NAMES = {1: "exception", 2: "create_thread", 3: "create_process",
               4: "exit_thread", 5: "exit_process", 6: "load_dll",
               7: "unload_dll", 8: "output_debug_string", 9: "rip"}


class DebugCapture:
    def __init__(self, api, receipt):
        self.api = api
        self.started = time.monotonic()
        self.deadline = self.started + TIMEOUT
        self.creator = api.GetCurrentThreadId()
        self.pid = self.tid = None
        self.process = self.debug_process = None
        self.reaped = False
        self.system_threads = {}
        self.modules = {}
        self.pending = None
        self.pending_record = None
        self.pending_status = DBG_CONTINUE
        self.pending_image_attempted = False
        self.armed = True
        self.first_exception = False
        self.healthy = True
        self.sequence = self.record_bytes = 0
        self.image_close_failed = False
        self.state = {
            "complete": False, "records": [], "eventRecordLimit": DEBUG_RECORD_LIMIT,
            "serializedByteLimit": DEBUG_BYTE_LIMIT, "debugStringReadLimit": 4096,
            "debugStringTotalLimit": DEBUG_STRING_LIMIT, "debugStringBytesRequested": 0,
            "debugStringBytesRead": 0, "createProcessObserved": False,
            "exitProcessContinued": False, "exitEventCode": None,
            "exitReconciled": False, "initialBreakpointIdentified": False,
            "initialBreakpointContinued": False, "collectorFailure": None,
            "initialBreakpointIdentification": "not_observed",
            "imageHandlesReceived": 0, "imageCloseAttempts": 0, "imageHandlesClosed": 0,
            "systemHandlesReleased": False, "manualHandleAliasesTransferred": 0,
            "identificationBasis": "documented_new_process_initial_breakpoint_order",
            "identificationScope": "controlled_fixed_child_uninterrupted_creation_debug",
            "initialBreakpointPredicate": [
                "owned_creation_pid", "primary_creation_tid", "matching_create_process",
                "uninterrupted_collection", "first_exception_event",
                "first_chance", "exception_breakpoint", "continuable_exception",
                "one_shot_armed"],
            "unknowns": ["No universal exception origin signature",
                         "Runtime image bytes and initialization success unmeasured",
                         "Debug-string length is low16 bytes; absence proves nothing",
                         "Debug marker cannot resolve prior uninstrumented failure"],
        }
        receipt["debug"] = self.state

    def failed(self, reason):
        self.healthy = False
        self.armed = False
        self.state["complete"] = False
        if self.state["collectorFailure"] is None:
            self.state["collectorFailure"] = reason

    def owned(self, info):
        self.pid, self.tid, self.process = info.processId, info.threadId, info.process
        self.state.update(ownedPid=self.pid, primaryTid=self.tid,
                          creatingThreadId=self.creator)

    def adopt_system_handle(self, handle):
        require(bool(handle), "missing_debug_system_handle")
        if handle in self.api.handles:
            try:
                if handle == self.process:
                    # A separate manual handle must survive continued EXIT_PROCESS.
                    duplicate = W.HANDLE()
                    own = self.api.GetCurrentProcess()
                    self.api.call("DuplicateHandle", own, handle, own,
                                  C.byref(duplicate), 0, False, 2)
                    self.process = duplicate.value
                    self.api.handles.append(duplicate.value)
            finally:
                # Never CloseHandle an event-managed alias, even after failure.
                self.api.handles.remove(handle)
                self.state["manualHandleAliasesTransferred"] += 1

    def image_identity(self, handle, row, cleanup):
        if not handle or handle == C.c_void_p(-1).value:
            row["imageIdentity"] = {"status": "unknown_no_file_handle"}
            return
        self.state["imageHandlesReceived"] += 1
        try:
            require(handle not in self.api.handles and handle != self.debug_process
                    and handle not in self.system_threads.values(), "image_handle_alias")
            if cleanup:
                row["imageIdentity"] = {"status": "unknown_cleanup_only"}
                return
            buffer = C.create_unicode_buffer(32768)
            C.set_last_error(0)
            length = self.api.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0x8)
            if not length:
                error = C.get_last_error()
                row["imageIdentity"] = {"status": "unknown_api_refusal", "winError": error}
                raise api_failure("GetFinalPathNameByHandleW", error)
            require(length < len(buffer), "image_name_limit")
            name = buffer.value.replace("/", "\\").rsplit("\\", 1)[-1].lower()
            row["imageIdentity"] = ({"basename": name} if name in MODULE_NAMES else
                                    {"openedNameSha256": digest(buffer.value.encode(
                                        "utf-16-le", errors="surrogatepass"))})
        finally:
            # Each event owns one image-handle close attempt; do not retry it.
            if (handle not in self.api.handles and handle != self.debug_process
                    and handle not in self.system_threads.values()):
                self.state["imageCloseAttempts"] += 1
                C.set_last_error(0)
                if self.api.CloseHandle(handle):
                    self.state["imageHandlesClosed"] += 1
                else:
                    error = C.get_last_error()
                    self.image_close_failed = True
                    raise api_failure("CloseHandle", error)
            else:
                self.image_close_failed = True

    def debug_string(self, info, row):
        length = int(info.length)  # Documented low 16-bit BYTE count, not WCHARs.
        size = min(length, 4096, DEBUG_STRING_LIMIT - self.state["debugStringBytesRequested"])
        row.update(reportedBytesLow16=length, unicode=bool(info.unicode),
                   requestedBytes=size, lengthMayWrap=True, rawTextRetained=False)
        require(not length or size > 0, "debug_string_total_limit")
        if not length:
            row["stringStatus"] = "unknown_zero_or_wrapped_length"
            raise Failure("debug_string_length_unknown")
        require(bool(self.debug_process), "missing_debug_process_handle")
        buffer = C.create_string_buffer(size)
        count = C.c_size_t()
        self.state["debugStringBytesRequested"] += size
        C.set_last_error(0)
        ok = self.api.ReadProcessMemory(self.debug_process, info.data, buffer,
                                       size, C.byref(count))
        error = C.get_last_error() if not ok else None
        row.update(bytesRead=min(count.value, size), readSucceeded=bool(ok))
        if error is not None:
            row["winError"] = error
        require(count.value <= size, "debug_string_read_length")
        self.state["debugStringBytesRead"] += count.value
        row["partial"] = count.value != size or size < length or not ok
        if not ok:
            raise api_failure("ReadProcessMemory", error)
        # Decode only the returned bytes, then persist fixed templates/codes.
        raw = buffer.raw[:count.value]
        try:
            value = raw.decode("utf-16-le" if info.unicode else "mbcs").rstrip("\0")
        except UnicodeError:
            row["stringStatus"] = "unknown_encoding"
            raise Failure("debug_string_encoding") from None
        else:
            lower = value.lower()
            row["templateIds"] = []
            row["objectCategories"] = []
            if "access is denied" in lower or "access denied" in lower:
                row["templateIds"].append("emitted_access_denied_phrase")
                for phrase, category in (("window station", "window_station"),
                                         ("winsta", "window_station"), ("desktop", "desktop")):
                    if phrase in lower and category not in row["objectCategories"]:
                        row["objectCategories"].append(category)
            if "initialization failed" in lower or "initialization failure" in lower:
                row["templateIds"].append("emitted_initialization_failure_phrase")
            row["statusCodes"] = [code for code in
                                  ("0xc0000142", "0xc0000022", "0xc0000135")
                                  if code in lower]
            row["stringStatus"] = "sanitized_emitted_report_only"
        require(not row["partial"], "debug_string_partial_read")

    def record(self, row):
        # Leave 16 KiB for fixed terminal, limit, ownership and error fields.
        size = len(json.dumps(row, separators=(",", ":"), ensure_ascii=True).encode())
        require(len(self.state["records"]) < DEBUG_RECORD_LIMIT
                and self.record_bytes + size + 1 <= DEBUG_BYTE_LIMIT - 16384,
                "debug_capture_limit")
        self.state["records"].append(row)
        self.record_bytes += size + 1

    def continue_pending(self, cleanup=False):
        event = self.pending
        require(event is not None and event.pid == self.pid, "unowned_pending_event")
        status = (DBG_EXCEPTION_NOT_HANDLED if cleanup and event.kind == 1
                  else self.pending_status)
        C.set_last_error(0)
        if not self.api.ContinueDebugEvent(event.pid, event.tid, status):
            error = C.get_last_error()
            self.failed("continue_debug_event_failed")
            raise api_failure("ContinueDebugEvent", error)
        if self.pending_record is not None:
            self.pending_record.update(continued=True, continueStatus=status)
        if event.kind == 1 and status == DBG_CONTINUE:
            self.state["initialBreakpointContinued"] = True
        if event.kind == 4:
            self.system_threads.pop(event.tid, None)
        if event.kind == 5:
            self.state["exitProcessContinued"] = True
            self.state["exitEventCode"] = int(event.data.exitProcess.code)
            self.system_threads.clear()
            self.debug_process = None
            self.state["systemHandlesReleased"] = True
        self.pending = self.pending_record = None

    def poll(self, cleanup=False):
        require(self.api.GetCurrentThreadId() == self.creator, "debug_thread_changed")
        if self.pending is not None:
            self.continue_pending(cleanup=True)
            return
        if self.state["exitProcessContinued"]:
            return
        event = DebugEvent()
        C.set_last_error(0)
        if not self.api.WaitForDebugEventEx(C.byref(event), 10):
            error = C.get_last_error()
            if error == 121:  # ERROR_SEM_TIMEOUT; not a successful-call lastError.
                return
            self.failed("wait_debug_event_failed")
            raise api_failure("WaitForDebugEventEx", error)
        self.pending = event
        self.pending_image_attempted = False
        self.pending_status = DBG_EXCEPTION_NOT_HANDLED if event.kind == 1 else DBG_CONTINUE
        self.sequence += 1
        row = {"sequence": self.sequence, "elapsedMilliseconds":
               int((time.monotonic() - self.started) * 1000), "pid": int(event.pid),
               "tid": int(event.tid), "kind": EVENT_NAMES.get(event.kind, "unknown"),
               "continued": False, "continueStatus": self.pending_status}
        failure = None
        try:
            require(event.pid == self.pid, "debug_pid_mismatch")
            require(event.kind in EVENT_NAMES, "unknown_debug_event")
            if event.kind == 3:
                info = event.data.createProcess
                row.update(processHandleOwner="system_debug_event",
                           threadHandleOwner="system_debug_event",
                           manualProcessAlias=info.process in self.api.handles,
                           manualThreadAlias=info.thread in self.api.handles)
                # Adopt all event system handles before any fallible image query.
                self.debug_process = info.process
                self.system_threads[event.tid] = info.thread
                try:
                    try:
                        self.adopt_system_handle(info.process)
                    finally:
                        self.adopt_system_handle(info.thread)
                    require(self.sequence == 1 and event.tid == self.tid
                            and not self.state["createProcessObserved"], "debug_create_order")
                    self.state["createProcessObserved"] = True
                    row["moduleBase"] = int(info.base or 0)
                finally:
                    self.pending_image_attempted = True
                    self.image_identity(info.file, row, cleanup)
                self.modules[int(info.base or 0)] = row["imageIdentity"]
            else:
                if event.kind == 6:
                    info = event.data.loadDll
                    row["moduleBase"] = int(info.base or 0)
                    self.pending_image_attempted = True
                    self.image_identity(info.file, row, cleanup)
                    require(len(self.modules) < DEBUG_RECORD_LIMIT, "module_tracking_limit")
                    self.modules[int(info.base or 0)] = row["imageIdentity"]
                require(self.state["createProcessObserved"], "missing_debug_create")
                if event.kind == 2:
                    handle = event.data.createThread.thread
                    row.update(threadHandleOwner="system_debug_event",
                               manualThreadAlias=handle in self.api.handles)
                    self.adopt_system_handle(handle)
                    require(event.tid not in self.system_threads
                            and len(self.system_threads) < DEBUG_RECORD_LIMIT, "debug_thread_order")
                    self.system_threads[event.tid] = handle
                else:
                    require(event.tid in self.system_threads, "unknown_debug_thread")
                if event.kind == 1:
                    info = event.data.exception
                    eligible = (self.armed and not self.first_exception and self.healthy
                                and not cleanup and event.tid == self.tid
                                and info.record.code == 0x80000003 and info.firstChance != 0
                                and not info.record.flags & 1)
                    row.update(exceptionCode=int(info.record.code),
                               exceptionFlags=int(info.record.flags),
                               exceptionAddress=int(info.record.address or 0),
                               firstChance=int(info.firstChance),
                               firstExceptionEvent=not self.first_exception,
                               oneShotArmed=self.armed,
                               identifiedInitialBreakpoint=eligible)
                    self.first_exception, self.armed = True, False
                    if eligible:
                        self.state["initialBreakpointIdentified"] = True
                        self.state["initialBreakpointIdentification"] = "scoped_ordering_inference"
                        row["identificationBasis"] = self.state["identificationBasis"]
                        self.pending_status = DBG_CONTINUE
                    else:
                        if row["firstExceptionEvent"]:
                            self.state["initialBreakpointIdentification"] = "inconclusive_first_exception"
                        if info.record.code == 0x80000003:
                            self.failed("unrecognized_breakpoint")
                elif event.kind == 4:
                    row["exitCode"] = int(event.data.exitThread.code)
                elif event.kind == 5:
                    row["exitCode"] = int(event.data.exitProcess.code)
                elif event.kind == 7:
                    base = int(event.data.unloadDll.base or 0)
                    row.update(moduleBase=base, imageIdentity=self.modules.pop(
                        base, {"status": "unknown_unmatched_module"}))
                elif event.kind == 8 and not cleanup:
                    self.debug_string(event.data.string, row)
                elif event.kind == 9:
                    row.update(ripError=int(event.data.rip.error), ripType=int(event.data.rip.type))
                    self.failed("rip_event")
            row["continueStatus"] = self.pending_status
            if not cleanup:
                self.record(row)
                self.pending_record = row
        except Exception as error:
            self.failed(error.reason if isinstance(error, Failure) else "debug_collector_error")
            if event.kind == 1:
                self.first_exception, self.armed = True, False
                self.pending_status = DBG_EXCEPTION_NOT_HANDLED
            failure = error
            row["collectionFailed"] = True
            row["continueStatus"] = self.pending_status
            if not cleanup and self.pending_record is None:
                try:
                    self.record(row)
                    self.pending_record = row
                except Failure:
                    self.state["recordLimitReached"] = True
        finally:
            # Never wait/reap while intentionally holding an event.
            try:
                if event.kind in (3, 6) and not self.pending_image_attempted:
                    self.pending_image_attempted = True
                    info = event.data.createProcess if event.kind == 3 else event.data.loadDll
                    self.image_identity(info.file, row, cleanup=True)
            finally:
                self.continue_pending(cleanup=cleanup)
        if failure is not None:
            raise failure

    def reap(self):
        require(self.state["exitProcessContinued"], "exit_event_not_continued")
        wait = self.api.call("WaitForSingleObject", self.process, 0, invalid=0xFFFFFFFF)
        require(wait in (0, 258), "unknown_wait_result")
        if wait:
            return False
        self.reaped = True
        code = W.DWORD()
        self.api.call("GetExitCodeProcess", self.process, C.byref(code))
        self.state["processExitCode"] = code.value
        require(code.value == self.state["exitEventCode"], "debug_exit_code_mismatch")
        self.state["exitReconciled"] = True
        return True

    def cleanup(self):
        self.failed("observation_aborted")
        deadline = time.monotonic() + 5
        errors = []
        failure = None
        reconciled = False
        C.set_last_error(0)
        if not self.state["exitProcessContinued"] and not self.api.TerminateProcess(self.process, 1):
            error = C.get_last_error()
            failure = api_failure("TerminateProcess", error)
            errors.append({"reason": failure.reason, "api": failure.api, "winError": error})
        while time.monotonic() < deadline:
            try:
                if self.state["exitProcessContinued"]:
                    if self.reap():
                        reconciled = True
                        break
                    # Finite wait only after EXIT_PROCESS was continued.
                    self.api.call("WaitForSingleObject", self.process, 10, invalid=0xFFFFFFFF)
                else:
                    self.poll(cleanup=True)
            except Exception as error:
                if failure is None:
                    failure = (error if isinstance(error, Failure)
                               else Failure("cleanup_collector_error"))
                if len(errors) < 16:
                    errors.append({"reason": error.reason if isinstance(error, Failure)
                                   else "cleanup_collector_error",
                                   "api": getattr(error, "api", None),
                                   "winError": getattr(error, "error", None)})
        self.state["cleanupApiErrors"] = errors
        # Surface errors only after bounded best-effort event draining and reaping.
        if failure is not None:
            raise failure
        if reconciled:
            return True
        raise Failure("debug_cleanup_timeout")


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
        check_debug_abi()
        kernel = C.WinDLL("kernel32", use_last_error=True)
        security = C.WinDLL("advapi32", use_last_error=True)
        p = C.POINTER
        signatures = {
            "GetCurrentProcess": (kernel, W.HANDLE, []),
            "GetCurrentThreadId": (kernel, W.DWORD, []),
            "WaitForDebugEventEx": (kernel, W.BOOL, [p(DebugEvent), W.DWORD]),
            "ContinueDebugEvent": (kernel, W.BOOL, [W.DWORD, W.DWORD, W.DWORD]),
            "ReadProcessMemory": (kernel, W.BOOL, [W.HANDLE, W.LPVOID, W.LPVOID, C.c_size_t, p(C.c_size_t)]),
            "GetFinalPathNameByHandleW": (kernel, W.DWORD, [W.HANDLE, W.LPWSTR, W.DWORD, W.DWORD]),
            "DuplicateHandle": (kernel, W.BOOL, [W.HANDLE, W.HANDLE, W.HANDLE, p(W.HANDLE), W.DWORD, W.BOOL, W.DWORD]),
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
        # TokenElevation (20) returns TOKEN_ELEVATION: one DWORD.
        size = W.DWORD(C.sizeof(W.DWORD) if kind == 20 else 0)
        C.set_last_error(0)
        if kind != 20:
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
    paths = {"probe": probe, "workflow": workflow,
             "supervisor": probe.with_name("windows-publication-restricted.py"),
             "startup": probe.with_name("windows-publication-startup.py"),
             "diagnostic": Path(__file__).resolve()}
    source = {key: digest(path.read_bytes()) for key, path in paths.items()}
    receipt["sourceHashes"] = source
    if args.negative_case == "hash":
        receipt["negativeCaseReached"] = True
        check_hash("0" * 64, source["probe"])
    check_hash(source["probe"], source["probe"])
    # Hash raw bytes: the frozen LF and CRLF identities are distinct pins.
    require(source["supervisor"] in PINNED_SUPERVISOR_HASHES,
            "supervisor_hash_mismatch")
    require(source["startup"] in PINNED_STARTUP_HASHES, "startup_hash_mismatch")
    api = Native()
    # Share the live bounded evidence so exceptions and cleanup cannot discard it.
    receipt["tokenQueryDiagnostics"] = api.token_queries
    process = None
    attributes = None
    attribute_ready = False
    reaped = False
    debug = None
    observation_ready = False
    try:
        attest_parent(api, parent)
        receipt["parentAttestation"] = "caller_attested_local_unsynced_disposable_fixed_ntfs"
        root = parent / ("windows-startup-debug-" + uuid.uuid4().hex)
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
            sys.executable, "-I", "-c", "print('restricted-startup-v1', flush=True)"]))
        # NULL environment preserves the caller's environment/proxy/CA in memory;
        # the account is unchanged. No environment values enter this diagnostic.
        receipt["launch"] = {"api": "CreateProcessAsUserW", "attempted": False,
                             "suspended": True, "inheritedHandleCount": 3}
        if args.negative_case in ("api1314", "access-denied"):
            receipt["negativeCaseReached"] = True
            raise api_failure("CreateProcessAsUserW", 1314 if args.negative_case == "api1314" else 5)
        info = ProcessInfo()
        debug = DebugCapture(api, receipt)  # Deadline starts before creation.
        receipt["launch"].update(attempted=True, debugOnlyThisProcess=True,
                                 creationFlags=0x08080406)
        api.call("CreateProcessAsUserW", token, sys.executable, command, None, None, True,
                 0x4 | 0x08000000 | 0x400 | 0x80000 | 0x2, None, str(probe.parents[2]),
                 C.byref(startup), C.byref(info))
        # Own both handles immediately, even if a later handle-flag check fails.
        process = info.process
        api.handles.extend((info.process, info.thread))
        debug.owned(info)
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
        require(time.monotonic() < debug.deadline, "child_timeout")
        receipt["launch"]["actualTokenValidatedBeforeResume"] = True
        require(api.call("ResumeThread", info.thread, invalid=0xFFFFFFFF) == 1,
                "unexpected_suspend_count")
        receipt["launch"]["resumed"] = True
        output = bytearray()
        totals = {"stdoutBytes": 0, "stderrBytesDiscarded": 0}
        receipt["output"] = totals
        while True:
            require(time.monotonic() < debug.deadline, "child_timeout")
            out_open = api.drain(stdout_read, output, totals, "stdoutBytes")
            err_open = api.drain(stderr_read, None, totals, "stderrBytesDiscarded")
            debug.poll()
            require(debug.healthy, "incomplete_debug_trace")
            if debug.state["exitProcessContinued"]:
                reaped = debug.reap()
                if reaped and not out_open and not err_open:
                    break
        code = W.DWORD()
        api.call("GetExitCodeProcess", debug.process, C.byref(code))
        receipt["childExitCode"] = code.value
        receipt["markerMatched"] = output in STARTUP_MARKERS
        receipt["startupObservation"] = "inconclusive"
        for key, path in paths.items():
            require(digest(path.read_bytes()) == source[key], "source_changed_during_run")
        require(debug.healthy and debug.state["createProcessObserved"]
                and debug.state["initialBreakpointContinued"]
                and debug.state["exitReconciled"], "incomplete_debug_trace")
        if code.value == 0 and receipt["markerMatched"] and not totals["stderrBytesDiscarded"]:
            receipt["startupObservation"] = "python_output_reached_under_debug"
        elif code.value == 0xC0000142 and not output and not totals["stderrBytesDiscarded"]:
            receipt["startupObservation"] = "initialization_failure_reproduced_under_debug"
        else:
            raise Failure("inconclusive_startup_result")
        receipt["outcome"] = "diagnostic_observation_complete"
        observation_ready = True
        return 0
    except Exception as error:
        if debug is not None:
            debug.failed(error.reason if isinstance(error, Failure) else "harness_error")
        raise
    finally:
        errors = []
        cleanup_error = None
        if process is not None and not reaped:
            try:
                debug.cleanup()
            except Exception as error:
                cleanup_error = error
                errors.append(error.reason if isinstance(error, Failure) else "cleanup_error")
            finally:
                # A cleanup error cannot erase a successfully signaled process wait.
                reaped = debug.reaped
                receipt["ownedChildReaped"] = reaped
        elif reaped:
            receipt["ownedChildReaped"] = True
        if attribute_ready:
            try:
                api.DeleteProcThreadAttributeList(attributes)
            except Exception as error:
                if cleanup_error is None:
                    cleanup_error = error
                errors.append(error.reason if isinstance(error, Failure) else "cleanup_error")
        for handle in list(reversed(api.handles)):
            try:
                api.close(handle)
            except Exception as error:
                if cleanup_error is None:
                    cleanup_error = error
                errors.append(error.reason if isinstance(error, Failure) else "cleanup_error")
        receipt["ownedHandlesClosed"] = not api.handles
        if debug is not None and process is not None:
            state = debug.state
            if (debug.image_close_failed or
                    state["imageHandlesReceived"] != state["imageHandlesClosed"]
                    or not state["systemHandlesReleased"] or debug.pending is not None):
                errors.append("debug_handle_cleanup_incomplete")
            state["eventCountObserved"] = debug.sequence
            state["complete"] = bool(observation_ready and debug.healthy and reaped
                                     and not api.handles and not errors)
            if len(json.dumps(state, separators=(",", ":"), ensure_ascii=True).encode()) > DEBUG_BYTE_LIMIT:
                state["complete"] = False
                errors.append("debug_serialized_limit")
        # Check identities on all post-launch paths, including failures/cleanup.
        try:
            for key, path in paths.items():
                require(digest(path.read_bytes()) == source[key], "source_changed_during_run")
            receipt["sourceHashesUnchangedAfterCleanup"] = True
        except Exception:
            receipt["sourceHashesUnchangedAfterCleanup"] = False
            errors.append("source_changed_or_unreadable_after_cleanup")
        if errors:
            if debug is not None:
                debug.failed("cleanup_failure")
            receipt["cleanupErrors"] = errors
            if cleanup_error is not None:
                raise Failure("cleanup_failure", api=getattr(cleanup_error, "api", None),
                              error=getattr(cleanup_error, "error", None)) from None
            raise Failure("cleanup_failure")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("probe", "parent", "artifact"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--attest-local-unsynced-disposable-parent", action="store_true")
    parser.add_argument("--negative-case", choices=("elevated", "admin", "unknown", "hash",
                                                  "api1314", "access-denied", "timeout"))
    args = parser.parse_args()
    receipt = {"schema": "windows-startup-debug-v1", "probe": "windows-startup-debug",
               "status": "startup_diagnostic_only", "outcome": "harness_failure",
               "debug": {"complete": False}, "ownedChildReaped": False,
               "ownedHandlesClosed": False,
               "startupObservation": "not_observed", "markerMatched": None,
               "powerLossProven": False,
               "activationAuthorized": False, "obligations": OBLIGATIONS,
               "ordinaryUserEvidence": "unresolved", "negativeCase": args.negative_case,
               "negativeCaseReached": False, "timeoutSeconds": TIMEOUT,
               "limits": ["Fixed-marker startup diagnostic only; no publication operations",
                          "Elevated baseline does not establish ordinary-user capability",
                          "No power-loss, recovery, migration or activation proof",
                          "Loaded image is not evidence of successful initialization",
                          "Cause of earlier uninstrumented failure remains unknown"]}
    artifact = Path(args.artifact)
    code = 1
    try:
        # Refuse clobbering an existing caller-selected artifact or source file.
        with artifact.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(receipt) + "\n")
    except Exception as error:
        print("Restricted startup debug: diagnostic_create_failed; " + type(error).__name__)
        return 1
    try:
        code = execute(args, receipt)
    except Failure as error:
        code = error.code
        receipt.update(outcome="capability_refusal" if code == 2 else "harness_failure",
                       reason=error.reason, failedApi=error.api, winError=error.error)
    except Exception as error:
        receipt.update(outcome="harness_failure", reason="unexpected_harness_error",
                       errorType=type(error).__name__)
    try:
        payload = json.dumps(receipt, separators=(",", ":"), sort_keys=True) + "\n"
        if len(payload.encode("utf-8")) > DEBUG_BYTE_LIMIT:
            # A receipt overflow must itself fit the bound, including terminal fields.
            # Keep ownership, exit and identity evidence; explicitly omit bulk data.
            code = 1
            receipt.update(outcome="harness_failure", reason="receipt_size_limit",
                           receiptTruncated=True)
            debug_state = receipt["debug"]
            debug_state["complete"] = False
            debug_state["omittedEventRecords"] = len(debug_state.get("records", []))
            debug_state["records"] = []
            for key in ("parentTokenSummary", "restrictedTokenSummary", "actualChildTokenSummary"):
                if key in receipt:
                    receipt[key] = {"known": False, "omitted": "receipt_size_limit"}
            payload = json.dumps(receipt, separators=(",", ":"), sort_keys=True) + "\n"
        require(len(payload.encode("utf-8")) <= DEBUG_BYTE_LIMIT, "receipt_size_limit")
        artifact.write_text(payload, encoding="utf-8")
    except Exception as error:
        print("Restricted startup debug: diagnostic_write_failed; " + type(error).__name__)
        return 1
    print("Restricted startup debug: " + receipt["status"] + "; " + receipt["outcome"]
          + "; powerLossProven=false; O1-O5 unresolved")
    return code


if __name__ == "__main__":
    sys.exit(main())
