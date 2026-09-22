"""U1 disposable private-storage fixture; ordinary-principal DAC observations only.

Native use (CPython 3.12.10) under ONE ordinary disposable test principal:
  python -I tests/dispatch/windows-private-auth-probe.py --role owner \
    --parent ABS_DISPOSABLE_FIXED_NTFS_PARENT --receipt ABS_RECEIPT \
    --run-id HEX --attest-local-unsynced-disposable-parent
  python -I tests/dispatch/windows-private-auth-probe.py --role other \
    --root ABS_ROOT_RECORDED_BY_THE_OWNER_RUN --receipt ABS_RECEIPT \
    --attest-local-unsynced-disposable-parent

The caller must attest that the parent is local, unsynchronized and disposable;
DRIVE_FIXED alone cannot establish that. This probe verifies its OWN token SID,
elevation and integrity through the API and never infers a principal from a
username, environment variable or command line. It creates private objects with
an explicit owner-only protected DACL AT CREATION, inspects the real handle
owner/DACL/type/identity BEFORE any fixture byte, and never repairs, chmods,
takes ownership of or deletes wrong/inherited/insecure existing state.

API error and phase are recorded separately from execution status: a call that
never ran, or a leaf that was absent, is explicitly NOT denial evidence. An
unavailable control is labelled "open", never passed by skip. Every receipt keeps
namespace durability, crash/restart and power loss OUT of scope, and keeps
O1-O5 unresolved and activationAuthorized=false even when every API succeeds.

Independent testers may import safe_path, control, denial_attempt and digest on
any platform. Exit 0 receipt emitted, 1 harness failure, 2 bounded refusal.
"""

import argparse
import ctypes as C
from ctypes import wintypes as W
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import time


READ, WRITE, DELETE = 0x80000000, 0x40000000, 0x00010000
READ_CONTROL, WRITE_DAC = 0x00020000, 0x00040000
LIST_DIRECTORY, FILE_ALL_ACCESS = 0x0001, 0x1F01FF
SHARE, CREATE_NEW, OPEN_EXISTING = 7, 1, 3
NORMAL, WRITE_THROUGH, BACKUP = 0x80, 0x80000000, 0x02000000
REPARSE, DIRECTORY = 0x400, 0x10
UNSAFE_ATTRIBUTES = REPARSE | 0x1000 | 0x40000 | 0x400000
OWNER_INFORMATION, DACL_INFORMATION = 0x00000001, 0x00000004
SE_FILE_OBJECT, SDDL_REVISION_1, ACL_SIZE_INFORMATION = 1, 1, 2
SE_DACL_PRESENT, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED = 0x0004, 0x0400, 0x1000
ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, INHERITED_ACE = 0, 1, 0x10
ACCESS_DENIED, MORE_DATA_EXPECTED = 5, 122
COLLISION_ERRORS = (80, 183)
MEDIUM_SID_PREFIX = bytes.fromhex("010100000000001000200000")[:8]
ADMIN_SID = bytes.fromhex("01020000000000052000000020020000")
MEDIUM_INTEGRITY_RID = 8192
ROOT_PREFIX = "windows-private-auth-"
DEADLINE_SECONDS = 120
OBLIGATIONS = {key: "unresolved" for key in ("O1", "O2", "O3", "O4", "O5")}
FIXTURE_BYTES = json.dumps({"fixture": "disposable", "mode": "U1",
                            "purpose": "private-dac-observation"},
                           sort_keys=True).encode()


class Refusal(Exception):
    """A bounded capability/preflight refusal; never a pass and never a repair."""


class ApiFailure(Exception):
    def __init__(self, api, error):
        self.api, self.error = api, error


class Deadline:
    def __init__(self, seconds):
        self.limit = min(seconds, DEADLINE_SECONDS)
        self.start = time.monotonic()

    def check(self, phase):
        if self.limit - (time.monotonic() - self.start) <= 0:
            raise Refusal("measurement_deadline_exceeded_at_" + phase)


class FileInfo(C.Structure):
    _fields_ = [("attributes", W.DWORD), ("created", W.FILETIME),
                ("accessed", W.FILETIME), ("written", W.FILETIME),
                ("volume", W.DWORD), ("size_high", W.DWORD),
                ("size_low", W.DWORD), ("links", W.DWORD),
                ("index_high", W.DWORD), ("index_low", W.DWORD)]


class RenameInfo(C.Structure):
    _fields_ = [("replace", W.BOOLEAN), ("root", W.HANDLE),
                ("length", W.DWORD), ("name", W.WCHAR * 1)]


class SidAttributes(C.Structure):
    _fields_ = [("sid", W.LPVOID), ("attributes", W.DWORD)]


class Groups(C.Structure):
    _fields_ = [("count", W.DWORD), ("entries", SidAttributes * 1)]


class SecurityAttributes(C.Structure):
    _fields_ = [("length", W.DWORD), ("descriptor", W.LPVOID), ("inherit", W.BOOL)]


class AclSizeInformation(C.Structure):
    _fields_ = [("aceCount", W.DWORD), ("bytesInUse", W.DWORD), ("bytesFree", W.DWORD)]


class AceHeader(C.Structure):
    _fields_ = [("type", C.c_ubyte), ("flags", C.c_ubyte), ("size", W.WORD)]


class AccessAce(C.Structure):
    _fields_ = [("header", AceHeader), ("mask", W.DWORD), ("sidStart", W.DWORD)]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def check(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def safe_path(path):
    text = str(path)
    return not (not path.is_absolute() or path.is_reserved()
                or text.startswith(("\\\\", "//")) or len(text) > 200
                or ":" in text[2:]
                or any(part in ("..", ".") or part.endswith((".", " "))
                       for part in path.parts))


def control(receipt, name, state, **detail):
    """Controls are passed/refused/open; an unavailable control is never a pass."""
    check(state in ("passed", "refused", "open"), "unknown_control_state")
    receipt["controls"].append({"control": name, "state": state, **detail})


def denial_attempt(receipt, name, path, invoke):
    """Denial is a real access-check result; nothing else may stand in for it."""
    granted, error = invoke()
    if granted:
        control(receipt, name, "refused", getLastError=0, path=path,
                observation="other_principal_was_granted_access")
        return False
    if error == ACCESS_DENIED:
        control(receipt, name, "passed", getLastError=error, path=path,
                observation="denied_by_access_check")
        return True
    # An absent leaf, unavailable path or any other status is NOT denial evidence.
    control(receipt, name, "open", getLastError=error, path=path,
            observation="inconclusive_not_denial_evidence")
    return False


class WinAPI:
    """Win32 surface reused from the existing dispatch probe conventions.

    Never adjusts privileges, impersonates, changes ownership, repairs an ACL,
    queries a SACL or touches an object outside the run-owned fixture root.
    """

    def __init__(self, events):
        self.events = events
        self.functions = {}
        pointer = C.sizeof(W.HANDLE)
        check(pointer in (4, 8) and C.sizeof(W.DWORD) == 4 and C.sizeof(W.WCHAR) == 2
              and C.sizeof(W.BOOLEAN) == 1 and C.sizeof(AceHeader) == 4
              and AccessAce.sidStart.offset == 8, "windows_abi")
        kernel = C.WinDLL("kernel32", use_last_error=True)
        security = C.WinDLL("advapi32", use_last_error=True)
        p = C.POINTER
        attributes = p(SecurityAttributes)
        signatures = {
            "CreateFileW": (kernel, W.HANDLE, [W.LPCWSTR, W.DWORD, W.DWORD, attributes,
                                               W.DWORD, W.DWORD, W.HANDLE]),
            "CloseHandle": (kernel, W.BOOL, [W.HANDLE]),
            "GetCurrentProcess": (kernel, W.HANDLE, []),
            "GetCurrentProcessId": (kernel, W.DWORD, []),
            "FlushFileBuffers": (kernel, W.BOOL, [W.HANDLE]),
            "WriteFile": (kernel, W.BOOL, [W.HANDLE, W.LPCVOID, W.DWORD,
                                           p(W.DWORD), W.LPVOID]),
            "ReadFile": (kernel, W.BOOL, [W.HANDLE, W.LPVOID, W.DWORD,
                                          p(W.DWORD), W.LPVOID]),
            "GetFileInformationByHandle": (kernel, W.BOOL, [W.HANDLE, p(FileInfo)]),
            "SetFileInformationByHandle": (kernel, W.BOOL, [W.HANDLE, C.c_int,
                                                            W.LPVOID, W.DWORD]),
            "CreateDirectoryW": (kernel, W.BOOL, [W.LPCWSTR, attributes]),
            "CreateHardLinkW": (kernel, W.BOOL, [W.LPCWSTR, W.LPCWSTR, attributes]),
            "CreateSymbolicLinkW": (kernel, W.BOOLEAN, [W.LPCWSTR, W.LPCWSTR, W.DWORD]),
            "DeleteFileW": (kernel, W.BOOL, [W.LPCWSTR]),
            "GetFileAttributesW": (kernel, W.DWORD, [W.LPCWSTR]),
            "GetVolumePathNameW": (kernel, W.BOOL, [W.LPCWSTR, W.LPWSTR, W.DWORD]),
            "GetDriveTypeW": (kernel, W.UINT, [W.LPCWSTR]),
            "GetVolumeInformationW": (kernel, W.BOOL, [W.LPCWSTR, W.LPWSTR, W.DWORD,
                                                       p(W.DWORD), p(W.DWORD),
                                                       p(W.DWORD), W.LPWSTR, W.DWORD]),
            "LocalFree": (kernel, W.HANDLE, [W.HANDLE]),
            "OpenProcessToken": (security, W.BOOL, [W.HANDLE, W.DWORD, p(W.HANDLE)]),
            "GetTokenInformation": (security, W.BOOL, [W.HANDLE, C.c_int, W.LPVOID,
                                                       W.DWORD, p(W.DWORD)]),
            "ConvertSidToStringSidW": (security, W.BOOL, [W.LPVOID, p(W.LPWSTR)]),
            "EqualSid": (security, W.BOOL, [W.LPVOID, W.LPVOID]),
            "GetAclInformation": (security, W.BOOL, [W.LPVOID, p(AclSizeInformation),
                                                     W.DWORD, C.c_int]),
            "GetAce": (security, W.BOOL, [W.LPVOID, W.DWORD, p(W.LPVOID)]),
            "GetSecurityDescriptorControl": (security, W.BOOL, [W.LPVOID, p(W.WORD),
                                                                p(W.DWORD)]),
            "ConvertStringSecurityDescriptorToSecurityDescriptorW":
                (security, W.BOOL, [W.LPCWSTR, W.DWORD, p(W.LPVOID), p(W.ULONG)]),
            # GetSecurityInfo returns a Win32 status, not a BOOL, and does not set
            # last error; status_call keeps it off the BOOL call() path.
            "GetSecurityInfo": (security, W.DWORD, [W.HANDLE, C.c_int, W.DWORD,
                                                    p(W.LPVOID), p(W.LPVOID),
                                                    p(W.LPVOID), p(W.LPVOID),
                                                    p(W.LPVOID)]),
        }
        for name, (dll, result, arguments) in signatures.items():
            function = getattr(dll, name)
            function.restype, function.argtypes = result, arguments
            self.functions[name] = function

    def call(self, name, *args, invalid=0, **detail):
        C.set_last_error(0)
        result = self.functions[name](*args)
        error = C.get_last_error()
        self.events.append({"api": name, "result": result, "getLastError": error,
                            "lastErrorMeaningful": result == invalid, **detail})
        if result == invalid:
            raise ApiFailure(name, error)
        return result

    def attempt(self, name, *args, invalid=0, **detail):
        """Record an expected-to-fail call without raising; returns (ok, error)."""
        try:
            self.call(name, *args, invalid=invalid, **detail)
            return True, 0
        except ApiFailure as failure:
            return False, failure.error

    def status_call(self, name, *args, **detail):
        result = self.functions[name](*args)
        self.events.append({"api": name, "win32Status": result,
                            "statusMeaningful": True, **detail})
        if result != 0:
            raise ApiFailure(name, result)
        return result

    def free(self, pointer):
        address = getattr(pointer, "value", pointer)
        if address:
            leftover = self.functions["LocalFree"](address)
            self.events.append({"api": "LocalFree", "released": not leftover})

    # ---- identity -------------------------------------------------------

    def token_info(self, token, kind):
        size = W.DWORD(C.sizeof(W.DWORD) if kind in (8, 18, 20) else 0)
        if kind not in (8, 18, 20):
            C.set_last_error(0)
            result = self.functions["GetTokenInformation"](token, kind, None, 0,
                                                           C.byref(size))
            error = C.get_last_error()
            self.events.append({"api": "GetTokenInformation", "infoClass": kind,
                                "phase": "sizing", "result": result,
                                "getLastError": error,
                                "lastErrorMeaningful": not result})
            if result or error != MORE_DATA_EXPECTED:
                raise ApiFailure("GetTokenInformation", error)
        check(4 <= size.value <= 1024 * 1024, "token_size_bound")
        buffer = C.create_string_buffer(size.value)
        self.call("GetTokenInformation", token, kind, buffer, len(buffer),
                  C.byref(size), infoClass=kind, phase="data")
        check(size.value == len(buffer), "token_return_size")
        return buffer

    @staticmethod
    def bounded_sid(buffer, pointer):
        start = C.addressof(buffer)
        check(pointer is not None and start <= pointer <= start + len(buffer) - 8,
              "token_sid_bounds")
        prefix = C.string_at(pointer, 8)
        length = 8 + 4 * prefix[1]
        check(prefix[0] == 1 and prefix[1] <= 15
              and pointer + length <= start + len(buffer), "token_sid_length")
        return C.string_at(pointer, length)

    def sid_text(self, pointer):
        text = W.LPWSTR()
        self.call("ConvertSidToStringSidW", pointer, C.byref(text))
        try:
            return text.value
        finally:
            # Free the returned buffer itself, never the decoded Python string.
            self.free(C.cast(text, C.c_void_p))

    def token_identity(self):
        """Verified SID/elevation/integrity of the REAL running token only."""
        handle = W.HANDLE()
        process = self.call("GetCurrentProcess")
        self.call("OpenProcessToken", process, 0x0008, C.byref(handle),
                  access="TOKEN_QUERY")
        token = handle.value
        try:
            state = {"evidenceSource": "primary_process_token_api",
                     "processId": self.functions["GetCurrentProcessId"]()}
            for kind, key in ((8, "tokenType"), (18, "elevationType"), (20, "elevated")):
                buffer = self.token_info(token, kind)
                check(len(buffer) == 4, "token_scalar_size")
                value = W.DWORD.from_buffer(buffer).value
                if key == "elevated":
                    check(value in (0, 1), "unknown_elevation")
                    value = bool(value)
                state[key] = value
            check(state["elevationType"] in (1, 2, 3), "unknown_elevation_type")
            buffer = self.token_info(token, 1)
            check(len(buffer) >= C.sizeof(SidAttributes), "token_user_size")
            user = SidAttributes.from_buffer(buffer).sid
            state["userSidSha256"] = digest(self.bounded_sid(buffer, user))
            state["userSid"] = self.sid_text(user)
            buffer = self.token_info(token, 25)
            check(len(buffer) >= C.sizeof(SidAttributes), "token_label_size")
            label = self.bounded_sid(buffer, SidAttributes.from_buffer(buffer).sid)
            check(label[:8] == MEDIUM_SID_PREFIX, "unknown_integrity_sid")
            state["integrityRid"] = int.from_bytes(label[-4:], "little")
            buffer = self.token_info(token, 2)
            count = W.DWORD.from_buffer(buffer).value
            check(Groups.entries.offset + count * C.sizeof(SidAttributes) <= len(buffer),
                  "token_groups_bounds")
            state.update(adminSidPresent=False, adminEnabled=False, adminDenyOnly=False)
            entries = (SidAttributes * count).from_buffer(buffer, Groups.entries.offset)
            for entry in entries:
                # Binary S-1-5-32-544 (BUILTIN Administrators), independent of locale.
                if self.bounded_sid(buffer, entry.sid) == ADMIN_SID:
                    check(not state["adminSidPresent"], "duplicate_admin_sid")
                    state.update(adminSidPresent=True,
                                 adminEnabled=bool(entry.attributes & 0x4),
                                 adminDenyOnly=bool(entry.attributes & 0x10))
            ordinary = (state["elevated"] is False and state["adminEnabled"] is False
                        and state["elevationType"] != 2 and state["tokenType"] == 1
                        and state["integrityRid"] == MEDIUM_INTEGRITY_RID)
            state["ordinaryPrincipalVerified"] = ordinary
            state["evidenceClass"] = ("ordinary_principal_token_verified" if ordinary
                                      else "elevated_or_unknown_token_not_ordinary")
            return state
        finally:
            self.call("CloseHandle", token, handle=token)

    # ---- private descriptor and inspection ------------------------------

    def private_descriptor(self, sid_text):
        """Owner-only protected DACL supplied AT CREATION, built from OUR token SID."""
        sddl = "O:{0}G:{0}D:P(A;;FA;;;{0})".format(sid_text)
        descriptor, size = W.LPVOID(), W.ULONG()
        self.call("ConvertStringSecurityDescriptorToSecurityDescriptorW", sddl,
                  SDDL_REVISION_1, C.byref(descriptor), C.byref(size),
                  sddlShape="O:OWNER G:OWNER D:P(A;;FA;;;OWNER)")
        attributes = SecurityAttributes(C.sizeof(SecurityAttributes),
                                        descriptor.value, False)
        return attributes, descriptor

    def describe_security(self, handle, label):
        owner, dacl, descriptor = W.LPVOID(), W.LPVOID(), W.LPVOID()
        self.status_call("GetSecurityInfo", handle, SE_FILE_OBJECT,
                         OWNER_INFORMATION | DACL_INFORMATION, C.byref(owner), None,
                         C.byref(dacl), None, C.byref(descriptor), object=label)
        try:
            flags, revision = W.WORD(), W.DWORD()
            self.call("GetSecurityDescriptorControl", descriptor, C.byref(flags),
                      C.byref(revision), object=label)
            value = flags.value
            result = {"object": label, "ownerSid": self.sid_text(owner),
                      "control": value,
                      "daclPresent": bool(value & SE_DACL_PRESENT),
                      "daclProtected": bool(value & SE_DACL_PROTECTED),
                      "daclAutoInherited": bool(value & SE_DACL_AUTO_INHERITED),
                      "daclNull": not dacl.value, "aces": []}
            if not result["daclPresent"] or result["daclNull"]:
                # An absent or NULL DACL grants everyone; it is never acceptable.
                result["verdict"] = "absent_or_null_dacl"
                return result
            info = AclSizeInformation()
            self.call("GetAclInformation", dacl, C.byref(info), C.sizeof(info),
                      ACL_SIZE_INFORMATION, object=label)
            for index in range(info.aceCount):
                entry_pointer = W.LPVOID()
                self.call("GetAce", dacl, index, C.byref(entry_pointer), object=label,
                          aceIndex=index)
                header = AceHeader.from_address(entry_pointer.value)
                entry = {"aceType": header.type, "aceFlags": header.flags,
                         "aceBytes": header.size,
                         "inherited": bool(header.flags & INHERITED_ACE)}
                if (entry["aceType"] in (ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE)
                        and header.size >= C.sizeof(AccessAce)):
                    ace = AccessAce.from_address(entry_pointer.value)
                    trustee = entry_pointer.value + AccessAce.sidStart.offset
                    entry.update(mask=ace.mask, trusteeSid=self.sid_text(trustee),
                                 trusteeIsOwner=bool(
                                     self.functions["EqualSid"](trustee, owner)))
                else:
                    # Unknown, conditional or object ACE forms are never interpreted.
                    entry["form"] = "unknown_or_object_ace"
                result["aces"].append(entry)
            return result
        finally:
            self.free(descriptor)

    # ---- files ----------------------------------------------------------

    def open_handle(self, path, access, *, create=False, directory=False,
                    attributes=None, writable=False, label=None):
        flags = (BACKUP if directory else NORMAL) | (WRITE_THROUGH if writable else 0)
        return self.call("CreateFileW", str(path), access, SHARE,
                         None if attributes is None else C.byref(attributes),
                         CREATE_NEW if create else OPEN_EXISTING, flags, None,
                         invalid=C.c_void_p(-1).value, object=label or path.name,
                         access=access, share=SHARE, flags=flags,
                         disposition=CREATE_NEW if create else OPEN_EXISTING,
                         creationDescriptor=attributes is not None)

    def identity(self, handle, label):
        info = FileInfo()
        self.call("GetFileInformationByHandle", handle, C.byref(info), object=label)
        identity = {"volumeSerial": info.volume,
                    "fileIndex": (info.index_high << 32) | info.index_low,
                    "size": (info.size_high << 32) | info.size_low,
                    "links": info.links, "attributes": info.attributes,
                    "isDirectory": bool(info.attributes & DIRECTORY),
                    "isReparse": bool(info.attributes & REPARSE)}
        self.events[-1]["identity"] = identity
        return identity

    def write(self, handle, data, label):
        written = W.DWORD()
        buffer = C.create_string_buffer(data)
        self.call("WriteFile", handle, buffer, len(data), C.byref(written), None,
                  requestedBytes=len(data), object=label)
        self.events[-1]["writtenBytes"] = written.value
        check(written.value == len(data), "short_write")

    def read(self, handle, limit, label):
        buffer = C.create_string_buffer(limit)
        read = W.DWORD()
        self.call("ReadFile", handle, buffer, limit, C.byref(read), None,
                  requestedBytes=limit, object=label)
        self.events[-1]["readBytes"] = read.value
        return buffer.raw[:read.value]

    def rename(self, handle, target, label, replace=False):
        """FILE_RENAME_INFO buffer construction reused from the publication probe."""
        name = str(target).encode("utf-16-le")
        pointer_bytes = C.sizeof(W.HANDLE)
        offsets = [getattr(RenameInfo, field).offset
                   for field in ("replace", "root", "length", "name")]
        layout = {"pointerBytes": pointer_bytes, "booleanBytes": C.sizeof(W.BOOLEAN),
                  "dwordBytes": C.sizeof(W.DWORD), "wcharBytes": C.sizeof(W.WCHAR),
                  "structBytes": C.sizeof(RenameInfo),
                  "structAlignment": C.alignment(RenameInfo), "fieldOffsets": offsets}
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
        check(name and len(name) % 2 == 0 and "\0" not in str(target),
              "rename_filename_encoding")
        # FileNameLength excludes the NUL; FileName still gets an explicit WCHAR NUL.
        terminated_name = name + b"\0\0"
        size = max(C.sizeof(RenameInfo), RenameInfo.name.offset + len(terminated_name))
        check(size <= 0xFFFFFFFF, "rename_buffer_dword_size")
        buffer = C.create_string_buffer(size)
        # This view and its owning buffer remain alive through the synchronous call.
        info = RenameInfo.from_buffer(buffer)
        info.replace, info.root, info.length = replace, None, len(name)
        C.memmove(C.addressof(buffer) + RenameInfo.name.offset,
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
            "viewSharesBuffer": C.addressof(info) == C.addressof(buffer),
            "bufferAligned": C.addressof(buffer) % C.alignment(RenameInfo) == 0,
        }
        evidence.update(bufferBytes=size, filenameLength=info.length,
                        terminatorOffset=name_end,
                        terminatorHex=raw[name_end:name_end + 2].hex(),
                        invariants=invariants)
        check(all(invariants.values()), "rename_buffer_invariants")
        self.call("SetFileInformationByHandle", handle, 3, buffer, size,
                  infoClass="FileRenameInfo", replaceIfExists=replace,
                  filenameBytes=len(name), bufferBytes=size, object=label)

    def safe_existing(self, path, label):
        """Lexical ancestors BEFORE resolution; resolving first hides links."""
        attributes = None
        for part in reversed((path, *path.parents)):
            attributes = self.call("GetFileAttributesW", str(part), invalid=0xFFFFFFFF,
                                   pathType="ancestor" if part != path else "leaf",
                                   object=label)
            if attributes & UNSAFE_ATTRIBUTES:
                raise Refusal("reparse_offline_or_recall_path")
        return attributes


def require_private(security, expected_owner_sid):
    """Owner-only, protected, non-inherited, exactly one full-control ACE."""
    findings = {
        "ownerMatchesToken": security["ownerSid"] == expected_owner_sid,
        "daclPresent": security["daclPresent"],
        "daclProtected": security["daclProtected"],
        "daclNotNull": not security["daclNull"],
        "noInheritedAce": all(not ace["inherited"] for ace in security["aces"]),
        "singleAce": len(security["aces"]) == 1,
        "knownAceForm": all("form" not in ace for ace in security["aces"]),
        "ownerOnlyFullControl": all(
            ace.get("aceType") == ACCESS_ALLOWED_ACE_TYPE
            and ace.get("trusteeIsOwner") is True
            and ace.get("trusteeSid") == expected_owner_sid
            and ace.get("mask") == FILE_ALL_ACCESS
            for ace in security["aces"]),
    }
    security["privateFindings"] = findings
    security["verdict"] = "private" if all(findings.values()) else "not_private"
    if security["verdict"] != "private":
        # Preserved, never repaired: no chmod, SetSecurityInfo or take-ownership.
        raise Refusal("insecure_existing_state_refused_and_preserved")
    return security


def inspect_private(api, handle, label, sid, receipt):
    security = require_private(api.describe_security(handle, label), sid)
    receipt["security"].append(security)
    return security


def volume_facts(api, path, receipt):
    volume = C.create_unicode_buffer(261)
    api.call("GetVolumePathNameW", str(path), volume, len(volume))
    drive = api.call("GetDriveTypeW", volume.value)
    serial, component, flags = W.DWORD(), W.DWORD(), W.DWORD()
    filesystem = C.create_unicode_buffer(64)
    api.call("GetVolumeInformationW", volume.value, None, 0, C.byref(serial),
             C.byref(component), C.byref(flags), filesystem, len(filesystem))
    receipt["storage"] = {"driveType": drive, "filesystem": filesystem.value,
                          "volumeSerial": serial.value, "filesystemFlags": flags.value,
                          "maxComponentLength": component.value,
                          "unsyncedParent": "caller_attestation_plus_path_checks",
                          "syncSoftwareDetectionComplete": False}
    if drive != 3 or filesystem.value.upper() != "NTFS":
        raise Refusal("requires_identified_fixed_ntfs")


def owner_run(api, args, receipt, clock):
    parent = Path(args.parent)
    if not safe_path(parent):
        raise Refusal("unsafe_parent_path")
    if not api.safe_existing(parent, "fixture_parent") & DIRECTORY:
        raise Refusal("parent_is_not_directory")
    resolved = parent.resolve(strict=True)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(parent)):
        raise Refusal("noncanonical_parent")
    if any(part.lower().startswith(("onedrive", "dropbox", "google drive", "icloud"))
           for part in parent.parts):
        raise Refusal("known_sync_path")
    for name in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        value = os.environ.get(name)
        if value and (parent == Path(value) or Path(value) in parent.parents):
            raise Refusal("known_sync_root")
    volume_facts(api, resolved, receipt)
    sid = receipt["identity"]["userSid"]
    root = parent / (ROOT_PREFIX + args.run_id)
    if not safe_path(root):
        raise Refusal("unsafe_root_path")
    if root.exists():
        # Wrong or pre-existing state is refused and preserved, never reused.
        raise Refusal("requires_fresh_root")
    receipt["fixtureRoot"] = str(root)
    attributes, descriptor = api.private_descriptor(sid)
    try:
        clock.check("create_root")
        api.call("CreateDirectoryW", str(root), C.byref(attributes),
                 object="private_fixture_root", creationDescriptor=True)
        receipt["createdObjects"].append(str(root))
        handle = api.open_handle(root, READ | READ_CONTROL, directory=True,
                                 label="private_fixture_root")
        try:
            inspect_private(api, handle, "private_fixture_root", sid, receipt)
            identity = api.identity(handle, "private_fixture_root")
            check(identity["isDirectory"] and not identity["isReparse"],
                  "root_is_not_a_plain_directory")
            receipt["rootIdentity"] = identity
        finally:
            api.call("CloseHandle", handle, object="private_fixture_root")

        clock.check("create_secret")
        secret = root / "auth-metadata.json"
        handle = api.open_handle(secret, READ | WRITE | DELETE | READ_CONTROL,
                                 create=True, attributes=attributes, writable=True,
                                 label="private_secret")
        try:
            # The real handle is inspected BEFORE a single fixture byte is written.
            inspect_private(api, handle, "private_secret", sid, receipt)
            identity = api.identity(handle, "private_secret_precreate")
            check(not identity["isDirectory"] and not identity["isReparse"],
                  "secret_is_not_a_regular_file")
            check(identity["links"] == 1, "secret_has_extra_links")
            check(identity["size"] == 0, "secret_not_empty_at_creation")
            receipt["secretPreWriteIdentity"] = identity
            api.write(handle, FIXTURE_BYTES, "private_secret")
            api.call("FlushFileBuffers", handle, object="private_secret")
            receipt["secretIdentity"] = api.identity(handle, "private_secret")
        finally:
            api.call("CloseHandle", handle, object="private_secret")
        receipt["createdObjects"].append(str(secret))

        clock.check("owner_readback")
        handle = api.open_handle(secret, READ | READ_CONTROL, label="owner_readback")
        try:
            observed = api.read(handle, len(FIXTURE_BYTES) + 16, "owner_readback")
            inspect_private(api, handle, "owner_readback", sid, receipt)
        finally:
            api.call("CloseHandle", handle, object="owner_readback")
        check(observed == FIXTURE_BYTES, "owner_readback_mismatch")
        control(receipt, "owner_read_write", "passed",
                fixtureSha256=digest(FIXTURE_BYTES), readBytes=len(observed))

        clock.check("collision_control")
        granted, error = api.attempt("CreateFileW", str(secret), READ | WRITE, SHARE,
                                     C.byref(attributes), CREATE_NEW, NORMAL, None,
                                     invalid=C.c_void_p(-1).value,
                                     object="collision_probe", disposition=CREATE_NEW)
        check(not granted, "exclusive_create_overwrote_fixture")
        control(receipt, "exclusive_create_collision",
                "passed" if error in COLLISION_ERRORS else "open",
                getLastError=error, expected=list(COLLISION_ERRORS))

        clock.check("link_control")
        linked, link_name = root / "linkcheck.bin", root / "linkcheck.link"
        handle = api.open_handle(linked, READ | WRITE | READ_CONTROL, create=True,
                                 attributes=attributes, label="link_fixture")
        api.call("CloseHandle", handle, object="link_fixture")
        receipt["createdObjects"].append(str(linked))
        granted, error = api.attempt("CreateHardLinkW", str(link_name), str(linked),
                                     None, object="link_control")
        if granted:
            receipt["createdObjects"].append(str(link_name))
            handle = api.open_handle(linked, READ | READ_CONTROL, label="link_fixture")
            try:
                identity = api.identity(handle, "link_fixture")
            finally:
                api.call("CloseHandle", handle, object="link_fixture")
            control(receipt, "extra_hard_link_detected",
                    "passed" if identity["links"] == 2 else "open",
                    observedLinks=identity["links"],
                    note="detection only; an extra-link secret is refused, not repaired")
        else:
            control(receipt, "extra_hard_link_detected", "open", getLastError=error,
                    note="hard link unavailable here; the detection path is unexercised")

        clock.check("reparse_control")
        reparse = root / "reparse.link"
        granted, error = api.attempt("CreateSymbolicLinkW", str(reparse), str(linked),
                                     0, object="reparse_control")
        if granted:
            receipt["createdObjects"].append(str(reparse))
            try:
                api.safe_existing(reparse, "reparse_control")
                control(receipt, "reparse_refusal", "open",
                        note="symlink created but the no-follow walk did not refuse it")
            except Refusal as refusal:
                control(receipt, "reparse_refusal", "passed", reason=str(refusal))
        else:
            control(receipt, "reparse_refusal", "open", getLastError=error,
                    note=("symlink creation unavailable to this ordinary principal; "
                          "the refusal path is unexercised"))

        clock.check("publication")
        staged, published = root / "publish.tmp", root / args.target_name
        handle = api.open_handle(staged, READ | WRITE | DELETE | READ_CONTROL,
                                 create=True, attributes=attributes, writable=True,
                                 label="publication_staged")
        try:
            inspect_private(api, handle, "publication_staged", sid, receipt)
            before = api.identity(handle, "publication_staged")
            api.write(handle, FIXTURE_BYTES, "publication_staged")
            api.call("FlushFileBuffers", handle, object="publication_staged")
            api.rename(handle, published, "publication_staged")
            api.call("FlushFileBuffers", handle, object="publication_renamed")
            after = api.identity(handle, "publication_renamed")
            check(after["fileIndex"] == before["fileIndex"],
                  "same_handle_identity_changed")
        finally:
            api.call("CloseHandle", handle, object="publication_staged")
        receipt["createdObjects"].append(str(published))
        check(not staged.exists(), "staged_name_remains")
        handle = api.open_handle(published, READ | READ_CONTROL,
                                 label="publication_reopened")
        try:
            observed = api.read(handle, len(FIXTURE_BYTES) + 16, "publication_reopened")
            inspect_private(api, handle, "publication_reopened", sid, receipt)
        finally:
            api.call("CloseHandle", handle, object="publication_reopened")
        check(observed == FIXTURE_BYTES, "publication_reopen_mismatch")
        # A successful reopen is an API observation, never a durability certificate.
        control(receipt, "private_publication_api_sequence", "passed",
                sequence=["write", "flush", "FileRenameInfo", "flush", "fresh_reopen"])
        control(receipt, "namespace_durability_barrier", "open",
                note=("no qualifying ordinary-user namespace, crash-recovery or "
                      "power-loss barrier is established by these calls"))
        receipt["otherPrincipalTargets"] = {"root": str(root), "file": str(published),
                                            "secret": str(secret)}
        receipt["status"] = "owner_private_api_observed_only"
        return 0
    finally:
        api.free(descriptor)


def other_run(api, args, receipt, clock):
    root = Path(args.root)
    if not safe_path(root) or not root.name.startswith(ROOT_PREFIX):
        raise Refusal("unsafe_or_unrecognised_fixture_root")
    for part in root.parents:
        # Ancestors are only inspected for reparse substitution, never modified;
        # the leaf DACL is the object actually under test.
        api.attempt("GetFileAttributesW", str(part), invalid=0xFFFFFFFF,
                    pathType="ancestor", object="other_ancestor")
    targets = {"root": root, "file": root / args.target_name,
               "secret": root / "auth-metadata.json"}
    receipt["otherPrincipalTargets"] = {key: str(value)
                                        for key, value in targets.items()}
    invalid = C.c_void_p(-1).value

    def open_attempt(path, access, flags, label):
        return lambda: api.attempt("CreateFileW", str(path), access, SHARE, None,
                                   OPEN_EXISTING, flags, None, invalid=invalid,
                                   object=label, access=access, flags=flags)

    cases = (
        ("other_read_denied", targets["file"],
         open_attempt(targets["file"], READ, NORMAL, "other_read")),
        ("other_write_denied", targets["file"],
         open_attempt(targets["file"], WRITE, NORMAL, "other_write")),
        ("other_delete_open_denied", targets["file"],
         open_attempt(targets["file"], DELETE, NORMAL, "other_delete")),
        ("other_delete_api_denied", targets["file"],
         lambda: api.attempt("DeleteFileW", str(targets["file"]),
                             object="other_unlink")),
        ("other_secret_read_denied", targets["secret"],
         open_attempt(targets["secret"], READ, NORMAL, "other_secret_read")),
        ("other_write_dac_denied", targets["file"],
         open_attempt(targets["file"], WRITE_DAC, NORMAL, "other_write_dac")),
        ("other_list_directory_denied", targets["root"],
         open_attempt(targets["root"], LIST_DIRECTORY, BACKUP, "other_list")),
    )
    denied = []
    for name, path, invoke in cases:
        clock.check(name)
        denied.append(denial_attempt(receipt, name, str(path), invoke))
    receipt["deniedControlCount"] = sum(denied)
    receipt["deniedControlTotal"] = len(denied)
    receipt["status"] = ("other_principal_denied_by_access_check" if all(denied)
                         else "other_principal_denial_unresolved")
    return 0 if all(denied) else 2


def persist(path, receipt):
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", required=True, choices=("owner", "other"))
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--parent")
    parser.add_argument("--root")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--target-name", default="published.json")
    parser.add_argument("--deadline-seconds", type=int, default=DEADLINE_SECONDS)
    parser.add_argument("--attest-local-unsynced-disposable-parent", action="store_true")
    args = parser.parse_args()
    receipt = {"schema": 1, "probe": "windows-private-auth", "role": args.role,
               "status": "preflight_refusal", "powerLossProven": False,
               "activationAuthorized": False, "obligations": dict(OBLIGATIONS),
               "ordinaryUserEvidence": "unresolved", "controls": [], "security": [],
               "createdObjects": [], "events": [],
               "limits": ["Discretionary access-check observations only, not auth support",
                          "No namespace durability, crash/restart or power-loss proof",
                          "Administrator and SYSTEM remain outside this DAC boundary",
                          "No product runtime dependency on Python or PowerShell",
                          "One disposable principal per run; no real account or secret"],
               "python": {"version": sys.version,
                          "implementation": platform.python_implementation(),
                          "pointerBits": C.sizeof(C.c_void_p) * 8}}
    clock = Deadline(args.deadline_seconds)
    target, code = Path(args.receipt), 2
    try:
        if sys.platform != "win32":
            raise Refusal("native_windows_required")
        version = sys.getwindowsversion()
        receipt["windows"] = {"major": version.major, "minor": version.minor,
                              "build": version.build,
                              "platformVersion": list(version.platform_version)}
        if not safe_path(target):
            raise Refusal("unsafe_receipt_path")
        if not args.attest_local_unsynced_disposable_parent:
            raise Refusal("unsynchronized_disposable_parent_not_attested")
        if not args.target_name or args.target_name != Path(args.target_name).name:
            raise Refusal("unsafe_target_name")
        script = Path(__file__).resolve()
        receipt["sourceIdentity"] = {
            "probe": {"path": "tests/dispatch/windows-private-auth-probe.py",
                      "sha256": digest(script.read_bytes())}}
        api = WinAPI(receipt["events"])
        receipt["identity"] = api.token_identity()
        if not receipt["identity"]["ordinaryPrincipalVerified"]:
            # The measurement is only meaningful under a real ordinary principal.
            raise Refusal("not_an_ordinary_principal_token")
        receipt["ordinaryUserEvidence"] = "verified_token_sid_integrity_and_elevation"
        if args.role == "owner":
            if not args.parent or not args.run_id:
                raise Refusal("owner_role_requires_parent_and_run_id")
            code = owner_run(api, args, receipt, clock)
        else:
            if not args.root:
                raise Refusal("other_role_requires_root")
            code = other_run(api, args, receipt, clock)
    except Refusal as refusal:
        code = 2
        receipt.update(status="capability_refusal", reason=str(refusal))
    except ApiFailure as failure:
        code = 1
        receipt.update(status="harness_failure", failedApi=failure.api,
                       getLastError=failure.error)
    except Exception as error:  # never exception text, paths or environment values
        code = 1
        receipt.update(status="harness_failure", errorType=type(error).__name__)
    finally:
        receipt.update(powerLossProven=False, activationAuthorized=False,
                       obligations=dict(OBLIGATIONS),
                       elapsedSeconds=round(time.monotonic() - clock.start, 3))
        try:
            persist(target, receipt)
        except Exception as error:
            code = 1
            receipt.update(status="harness_failure",
                           receiptError=type(error).__name__)
        print(json.dumps(receipt, sort_keys=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
