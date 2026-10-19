"""Bounded diagnostic, not a production adapter or native-safety acceptance.

Source contract: task511 DECISION and cleanup supplement. See ABI_SOURCE below.
MS-FSA's WRITE_DATA|WRITE_ATTRIBUTES predicate is a hypothesis for local NTFS.
Win32 SET documentation states a general symbolic-link privilege requirement;
IFS and MS-FSA describe tag/nonempty conditions. No privilege is enabled here.
C12 observes ordinary DeleteFileW, not isolated parent-FILE_DELETE_CHILD power.
Single-process ordering is not simultaneous-race or descendant-containment proof.
"""
import ctypes as C
import hashlib
import json
import ntpath
import os
import re
import struct
import sys
import time

ABI_SOURCE = {
    "fileapi.h": "CreateFileW:93, BY_HANDLE_FILE_INFORMATION:641, volume:889",
    "winnt.h": "rights:10578,15799-15856; TOKEN_USER:12475; mount tag:16294",
    "WinBase.h": "directory/reparse flags:145,148",
    "libloaderapi.h": "SYSTEM32:372",
    "ioapiset.h": "DeviceIoControl:85",
    "winioctl.h": "CTL_CODE:271; FSCTL functions41/42/43:11340-11342",
    "SDK_commit": "c16762d41f1bd641ff8c4389ebf16ee50747129f (ioapiset/winioctl)",
    "delete_contract_sha256": "53a59d56176c8d23d637d302a1dcbc1bca2222a1cfe7ef0eb739bea7f0c82a8c",
    "reparse_layout": "staged REPARSE_DATA_BUFFER: ULONG,USHORT,USHORT + mount union",
    "token_signatures": "staged GetTokenInformation/IsValidSid official pages",
}
READ_ATTRIBUTES, WRITE_ATTRIBUTES, WRITE_DATA, WRITE_EA = 0x80, 0x100, 2, 0x10
PIN = 0x20000 | 1 | READ_ATTRIBUTES | 0x100000
GENERIC_WRITE = 0x40000000
SHARE_ALL, SHARE_READ = 7, 1
FLAGS = 0x02000000 | 0x00200000
REPARSE, DIRECTORY, MOUNT = 0x400, 0x10, 0xA0000003
SET, GET, DELETE = 0x900A4, 0x900A8, 0x900AC
OPEN_EXISTING, CREATE_NEW = 3, 1
MAX_REPARSE = 16384
NAMES = [
    "capable-positive", "attributes-only", "data-only", "zero-access",
    "ea-only", "attributes-before-pin", "attributes-after-pin",
    "data-before-pin", "data-after-pin", "first-marker-window",
    "nonempty-live-marker", "ordinary-delete-live-marker",
]
D, B, H, P, W = C.c_uint32, C.c_int32, C.c_void_p, C.c_void_p, C.c_wchar_p
INVALID = C.c_void_p(-1).value


class FileInfo(C.Structure):
    _fields_ = [(name, D) for name in (
        "attributes", "creationLow", "creationHigh", "accessLow", "accessHigh",
        "writeLow", "writeHigh", "volume", "sizeHigh", "sizeLow", "links",
        "indexHigh", "indexLow")]


class TokenUser(C.Structure):
    _fields_ = [("sid", P), ("attributes", D)]


class Incomplete(Exception):
    pass


def validate_root(value):
    # Exact supervisor-owned shape; never normalize untrusted lexical inputs.
    if not isinstance(value, str) or not 20 <= len(value) <= 180:
        raise Incomplete("root length")
    if not re.fullmatch(r"[A-Za-z]:\\[A-Za-z0-9_. -]+(?:\\[A-Za-z0-9_. -]+)*", value):
        raise Incomplete("root lexical form")
    parts = value[3:].split("\\")
    for part in parts:
        if part in (".", "..") or part.endswith((".", " ")):
            raise Incomplete("root component")
        if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part):
            raise Incomplete("reserved root component")
    if parts[-1] != "fixture" or not re.fullmatch(r"bootstrap1238-[A-Za-z0-9]{6}", parts[-2]):
        raise Incomplete("root ownership shape")
    if ntpath.normpath(value) != value:
        raise Incomplete("root normalization")
    return value


def mount_buffer(target):
    substitute = ("\\??\\" + target).encode("utf-16-le")
    printable = target.encode("utf-16-le")
    paths = substitute + b"\0\0" + printable + b"\0\0"
    data = struct.pack("<HHHH", 0, len(substitute), len(substitute) + 2, len(printable)) + paths
    result = struct.pack("<IHH", MOUNT, len(data), 0) + data
    if len(result) > MAX_REPARSE:
        raise Incomplete("mount buffer bound")
    return result


def decode_mount(data):
    if len(data) < 16:
        raise Incomplete("short mount GET")
    tag, length, reserved, so, sl, po, pl = struct.unpack_from("<IHHHHHH", data)
    if tag != MOUNT or length + 8 != len(data):
        raise Incomplete("mount GET tag/length")
    paths = data[16:]
    for offset, size in ((so, sl), (po, pl)):
        if offset % 2 or size % 2 or offset + size > len(paths):
            raise Incomplete("mount GET offsets")
    return {"tag": tag, "reserved": reserved,
            "substitute": paths[so:so + sl].decode("utf-16-le"),
            "print": paths[po:po + pl].decode("utf-16-le")}


class Native:
    def __init__(self, report):
        self.report = report
        self.events = report["setup"]
        self.handles = {}
        self.serial = 0
        self.cleanup_error = False
        # ctypes explicitly selects LoadLibraryExW SYSTEM32 search; no fallback.
        k = C.WinDLL("Kernel32.dll", use_last_error=True, winmode=0x800)
        a = C.WinDLL("Advapi32.dll", use_last_error=True, winmode=0x800)
        self.dlls = (k, a)
        signatures = [
            (k, "CreateFileW", H, [W, D, D, P, D, D, H]),
            (k, "CreateDirectoryW", B, [W, P]),
            (k, "DeleteFileW", B, [W]), (k, "RemoveDirectoryW", B, [W]),
            (k, "CloseHandle", B, [H]),
            (k, "GetFileInformationByHandle", B, [H, C.POINTER(FileInfo)]),
            (k, "GetVolumeInformationByHandleW", B,
             [H, W, D, C.POINTER(D), C.POINTER(D), C.POINTER(D), W, D]),
            (k, "DeviceIoControl", B, [H, D, P, D, P, D, C.POINTER(D), P]),
            (k, "GetCurrentProcess", H, []),
            (a, "OpenProcessToken", B, [H, D, C.POINTER(H)]),
            (a, "GetTokenInformation", B, [H, C.c_int32, P, D, C.POINTER(D)]),
            (a, "IsValidSid", B, [P]),
        ]
        for dll, name, result, args in signatures:
            fn = getattr(dll, name)
            fn.restype, fn.argtypes = result, args
            setattr(self, name, fn)
        if C.sizeof(D) != 4 or C.sizeof(B) != 4 or C.sizeof(C.c_wchar) != 2:
            raise Incomplete("unsupported ABI widths")
        if C.sizeof(FileInfo) != 52 or FileInfo.volume.offset != 28:
            raise Incomplete("unsupported FileInfo layout")
        self.event("ABI", pointer_bytes=C.sizeof(H), file_info_bytes=C.sizeof(FileInfo),
                   token_user_bytes=C.sizeof(TokenUser), source=ABI_SOURCE)

    def event(self, op, **facts):
        self.serial += 1
        self.events.append({"order": self.serial, "op": op, **facts})

    def call(self, name, args, **facts):
        C.set_last_error(0)
        value = getattr(self, name)(*args)
        error = None if name in ("IsValidSid", "GetCurrentProcess") else C.get_last_error()
        self.event(name, result=value, last_error=error, **facts)
        return value, error

    def info(self, handle, label):
        value = FileInfo()
        ok, error = self.call("GetFileInformationByHandle", (handle, C.byref(value)),
                              handle=handle, label=label)
        if not ok:
            raise Incomplete("identity unavailable: " + label + ":" + str(error))
        fact = {"id": [value.volume, value.indexHigh, value.indexLow],
                "attributes": value.attributes, "links": value.links,
                "size": (value.sizeHigh << 32) | value.sizeLow}
        self.handles[handle]["id"] = fact["id"]
        self.event("identity", handle=handle, label=label, **fact)
        return fact

    def open(self, path, access, share, label, disposition=OPEN_EXISTING, flags=FLAGS):
        handle, error = self.call("CreateFileW",
                                  (path, access, share, None, disposition, flags, None),
                                  path=path, access=access, share=share,
                                  disposition=disposition, flags=flags, label=label)
        if handle == INVALID:
            return None
        if handle is None:
            raise Incomplete("unexpected NULL CreateFileW")
        self.handles[handle] = {"path": path, "label": label}
        return handle

    def close(self, handle):
        if handle is None:
            return
        owner = self.handles.pop(handle, None)
        if owner is None:
            raise Incomplete("unowned/double close")
        ok, _ = self.call("CloseHandle", (handle,), handle=handle, owner=owner)
        if not ok:
            self.cleanup_error = True  # Do not retry ambiguous handle lifetime.

    def close_all(self):
        for handle in list(self.handles)[::-1]:
            self.close(handle)

    def ioctl(self, handle, code, data=b""):
        source = C.create_string_buffer(data, len(data)) if data else None
        output = C.create_string_buffer(MAX_REPARSE) if code == GET else None
        count = D()
        ok, error = self.call("DeviceIoControl",
                              (handle, code, source, len(data), output,
                               MAX_REPARSE if output is not None else 0,
                               C.byref(count), None),
                              handle=handle, code=code, input_hex=data.hex(),
                              input_sha256=hashlib.sha256(data).hexdigest())
        if output is not None and count.value > MAX_REPARSE:
            raise Incomplete("GET returned size exceeds buffer")
        raw = output.raw[:count.value] if output is not None else b""
        self.event("ioctl-output", code=code, returned_count=count.value,
                   count_meaningful=output is not None, output_hex=raw.hex(),
                   output_sha256=hashlib.sha256(raw).hexdigest())
        return bool(ok), error, raw

    def observe(self, path, label, allow_absent=False, follow=False):
        handle = self.open(path, READ_ATTRIBUTES, SHARE_ALL, label,
                           flags=0x02000000 if follow else FLAGS)
        if handle is None:
            # Distinguish absence from all other failures using the open receipt.
            error = self.events[-1]["last_error"]
            if allow_absent and error in (2, 3):
                self.event("absent", path=path, label=label, error=error)
                return None
            raise Incomplete("observation open failed: " + label)
        try:
            return self.info(handle, label)
        finally:
            self.close(handle)

    def principal(self):
        token = H()
        process, _ = self.call("GetCurrentProcess", ())
        ok, _ = self.call("OpenProcessToken", (process, 8, C.byref(token)),
                          access=8, pseudo_process=process)
        if not ok:
            raise Incomplete("OpenProcessToken")
        self.handles[token.value] = {"label": "process-token", "path": None}
        try:
            data, size = C.create_string_buffer(4096), D()
            ok, _ = self.call("GetTokenInformation", (token, 1, data, 4096, C.byref(size)),
                              information_class=1, capacity=4096)
            if not ok or not C.sizeof(TokenUser) <= size.value <= 4096:
                raise Incomplete("TokenUser bounded query")
            user = TokenUser.from_buffer(data)
            offset = (user.sid or 0) - C.addressof(data)
            if offset < C.sizeof(TokenUser) or offset + 8 > size.value:
                raise Incomplete("TokenUser SID pointer")
            raw = data.raw
            if raw[offset + 1] > 15:
                raise Incomplete("SID subauthority bound")
            sid_size = 8 + raw[offset + 1] * 4
            if offset + sid_size > size.value:
                raise Incomplete("TokenUser SID extent")
            ok, _ = self.call("IsValidSid", (user.sid,))
            if not ok:
                raise Incomplete("invalid SID")
            self.event("process-token-user", sid_hex=raw[offset:offset + sid_size].hex(),
                       attributes=user.attributes, privileges_adjusted=False,
                       scope="fresh process token; no impersonation is performed")
        finally:
            self.close(token.value)

    def volume(self, handle):
        label, filesystem = C.create_unicode_buffer(261), C.create_unicode_buffer(261)
        serial, component, flags = D(), D(), D()
        ok, _ = self.call("GetVolumeInformationByHandleW",
                          (handle, label, 261, C.byref(serial), C.byref(component),
                           C.byref(flags), filesystem, 261))
        self.event("volume", ok=bool(ok), filesystem=filesystem.value, serial=serial.value,
                   component_max=component.value, flags=flags.value)
        if not ok or filesystem.value != "NTFS":
            raise Incomplete("unsupported filesystem")
        # NTFS name and successful by-handle volume query are observations;
        # runner labels are not volume evidence.


def require(value, dependency):
    if value is None or value is False:
        raise Incomplete(dependency)
    return value


def same(actual, expected, label):
    if actual is None or actual["id"] != expected["id"]:
        raise Incomplete("identity mismatch: " + label)


def run_case(api, root, number, positive):
    record = api.report["cases"][number - 1]
    api.events = record["events"]
    src = root + "\\C%02d-source" % number
    dst = root + "\\C%02d-target" % number
    made = []
    identities = {}
    marker_id = None
    marker_created = False
    set_ok = False
    try:
        for path in (src, dst):
            ok, _ = api.call("CreateDirectoryW", (path, None), path=path)
            require(bool(ok), "fresh directory creation")
            made.append(path)
            identities[path] = api.observe(path, "baseline")
            if identities[path]["attributes"] & REPARSE:
                raise Incomplete("fresh directory unexpectedly reparse")
        payload = mount_buffer(dst)
        record["interpretation_positive_control_valid"] = positive
        pin = mutator = marker = None
        if number in (11, 12):
            marker = require(api.open(src + "\\marker", READ_ATTRIBUTES, SHARE_READ,
                                      "live-marker", CREATE_NEW, 0x80), "marker CREATE_NEW")
            marker_created = True
            marker_id = api.info(marker, "live-marker-before")
        access = {1: GENERIC_WRITE, 2: WRITE_ATTRIBUTES, 3: WRITE_DATA,
                  4: 0, 5: WRITE_EA, 6: WRITE_ATTRIBUTES, 7: WRITE_ATTRIBUTES,
                  8: WRITE_DATA, 9: WRITE_DATA, 10: WRITE_ATTRIBUTES,
                  11: WRITE_ATTRIBUTES}
        if number in (6, 8):
            mutator = api.open(src, access[number], SHARE_ALL, "mutator-before-pin")
            if mutator is not None:
                same(api.info(mutator, "mutator"), identities[src], "mutator")
            pin = api.open(src, PIN, SHARE_READ, "pin")
        elif number >= 7:
            pin = api.open(src, PIN, SHARE_READ, "pin")
        if pin is not None:
            same(api.info(pin, "pin"), identities[src], "pin")
        if number not in (6, 8, 12):
            if number >= 7 and pin is None:
                raise Incomplete("successful exact pin not reached")
            mutator = api.open(src, access[number], SHARE_ALL, "mutator")
            if mutator is not None:
                same(api.info(mutator, "mutator"), identities[src], "mutator")
        if number == 12:
            require(pin, "C12 pin")
            before = api.observe(src + "\\marker", "marker-path-before-delete")
            same(before, marker_id, "before ordinary delete")
            ok, error = api.call("DeleteFileW", (src + "\\marker",),
                                 path=src + "\\marker", protected_period=True)
            if ok:
                record["finding"] = "ordinary-held-marker-delete-succeeded"
            held = api.info(marker, "held-marker-after-delete")
            same(held, marker_id, "held marker")
            after = api.observe(src + "\\marker", "marker-path-after-delete", allow_absent=True)
            if ok or after is None or after["id"] != marker_id["id"]:
                record["finding"] = "ordinary-held-marker-delete-or-identity-loss"
            record["delete_result"] = {"ok": bool(ok), "error": error}
        else:
            if mutator is None or (number in (6, 8) and pin is None):
                api.event("dependency-not-reached", dependency="mutator and, when required, successful pin",
                          mutator_open=mutator is not None, pin_open=pin is not None)
                # Expected incompatible opens remain raw measurements, not successful pins.
                if number in (1, 6, 7, 10, 11):
                    raise Incomplete("mutation prerequisites")
                record["status"] = "observed-open-denial"
                return False
            if number == 10:
                last = api.info(pin, "last-non-reparse-check")
                require(not (last["attributes"] & REPARSE), "last clear reparse attribute")
            set_ok, _, _ = api.ioctl(mutator, SET, payload)
            got = None
            if set_ok:
                ok, _, raw = api.ioctl(mutator, GET)
                require(ok, "GET after successful SET")
                got = decode_mount(raw)
                require(got["substitute"] == "\\??\\" + dst and got["print"] == dst,
                        "GET matching owned target")
                api.event("verified-mount-payload", **got)
            if number == 1:
                require(set_ok and got is not None, "valid positive control")
                record["positive_valid"] = True
            if number == 10:
                # An attempted but rejected SET is a measured negative; still observe marker placement.
                marker = require(api.open(src + "\\marker", READ_ATTRIBUTES, SHARE_READ,
                                          "window-marker", CREATE_NEW, 0x80), "window marker CREATE_NEW")
                marker_created = True
                marker_id = api.info(marker, "window-marker")
                at_source = api.observe(src + "\\marker", "marker-via-source")
                at_target = api.observe(dst + "\\marker", "marker-via-target", allow_absent=True)
                source_object = api.observe(src, "source-nofollow")
                target_object = api.observe(dst, "target-nofollow")
                traversed = api.observe(src, "source-follow", follow=True)
                same(source_object, identities[src], "original source")
                same(target_object, identities[dst], "original target")
                same(at_source, marker_id, "source marker lookup")
                if at_target is not None and at_target["id"] == marker_id["id"]:
                    same(traversed, identities[dst], "redirected directory")
                    record["finding"] = "unsafe-bootstrap-marker-redirection"
                else:
                    same(traversed, identities[src], "unredirected directory")
                    require(at_target is None, "unexpected target marker")
            if number == 11:
                same(api.info(marker, "held-marker-after-mutation"), marker_id, "held marker")
                after = api.observe(src + "\\marker", "marker-path-after-mutation", allow_absent=True)
                if after is None or after["id"] != marker_id["id"]:
                    record["finding"] = "nonempty-marker-identity-loss"
        same(api.observe(src, "source-final-nofollow"), identities[src], "source final")
        same(api.observe(dst, "target-final-nofollow"), identities[dst], "target final")
        record["status"] = "observed"
    except Exception as exc:
        record["status"] = "incomplete"
        record["dependency_not_reached"] = str(exc)
        api.event("dependency-not-reached", reason=str(exc))
    finally:
        api.event("cleanup-begin", experimental_rights_finished=True)
        api.close_all()
        clear = src not in made
        cleanup_failed = False
        if src in made:
            cleanup = None
            try:
                cleanup = require(api.open(src, GENERIC_WRITE, SHARE_ALL, "cleanup-source"),
                                  "cleanup open")
                info = api.info(cleanup, "cleanup-source")
                same(info, identities[src], "cleanup source ownership")
                if info["attributes"] & REPARSE:
                    ok, _, raw = api.ioctl(cleanup, GET)
                    require(ok, "cleanup GET")
                    parsed = decode_mount(raw)
                    require(parsed["substitute"] == "\\??\\" + dst and parsed["print"] == dst,
                            "cleanup known owned target")
                    ok, _, _ = api.ioctl(cleanup, DELETE, struct.pack("<IHH", MOUNT, 0, 0))
                    require(ok, "cleanup matching-tag DELETE")
                    info = api.info(cleanup, "cleanup-after-delete")
                    same(info, identities[src], "cleanup retained source")
                require(not (info["attributes"] & REPARSE), "cleanup source reparse clear")
                clear = True
            except Exception as exc:
                cleanup_failed = True
                api.event("cleanup-error", reason=str(exc), residual=src)
            finally:
                api.close(cleanup)
        if clear:
            # Only the two known marker names, after removal of any source reparse data.
            if marker_created:
                for parent in (src, dst):
                    path = parent + "\\marker"
                    try:
                        info = api.observe(path, "cleanup-marker", allow_absent=True)
                        if info is not None:
                            same(info, marker_id, "cleanup marker ownership")
                            require(not (info["attributes"] & (REPARSE | DIRECTORY)),
                                    "cleanup marker type")
                            ok, _ = api.call("DeleteFileW", (path,), path=path, cleanup=True)
                            require(bool(ok), "cleanup marker DeleteFileW")
                    except Exception as exc:
                        cleanup_failed = True
                        api.event("cleanup-error", reason=str(exc), residual=path)
            for path in made[::-1]:
                try:
                    same(api.observe(path, "cleanup-directory"), identities[path], "directory ownership")
                    ok, _ = api.call("RemoveDirectoryW", (path,), path=path, cleanup=True)
                    require(bool(ok), "cleanup directory removal")
                except Exception as exc:
                    cleanup_failed = True
                    api.event("cleanup-error", reason=str(exc), residual=path)
        else:
            api.event("cleanup-residual", paths=made, reason="source not verified clear; no fallback")
            cleanup_failed = True
        api.close_all()
        record["cleanup_failed"] = cleanup_failed or api.cleanup_error
    return record.get("positive_valid", False)


def main():
    report = {"schema": 1, "diagnostic_only": True, "native_safety": "NOT_ESTABLISHED",
              "setup": [], "cases": [{"case": "C%02d" % n, "name": name,
                                     "status": "dependency-not-reached", "events": []}
                                    for n, name in enumerate(NAMES, 1)],
              "final": [], "limits": {"pairs": 12, "fixture_bytes_max": 1048576,
                                      "markers": "zero bytes", "processes": 1}}
    api = None
    root = None
    root_created = False
    positive = False
    started = time.monotonic()
    try:
        if sys.platform != "win32" or len(sys.argv) != 2:
            raise Incomplete("Windows and exactly one owned root argument required")
        root = validate_root(sys.argv[1])
        parent = os.lstat(ntpath.dirname(root))
        if not (parent.st_file_attributes & DIRECTORY) or parent.st_file_attributes & REPARSE:
            raise Incomplete("owned parent must be a plain directory")
        executable_hash = hashlib.sha256()
        with open(sys.executable, "rb") as executable:
            for block in iter(lambda: executable.read(65536), b""):
                executable_hash.update(block)
        report["python"] = {"executable": sys.executable, "version": sys.version,
                            "windows": list(sys.getwindowsversion()),
                            "sha256": executable_hash.hexdigest()}
        api = Native(report)
        api.principal()
        ok, _ = api.call("CreateDirectoryW", (root, None), path=root)
        require(bool(ok), "exclusive fixture root creation")
        root_created = True
        handle = require(api.open(root, READ_ATTRIBUTES, SHARE_ALL, "fixture-root"), "root handle")
        root_identity = api.info(handle, "fixture-root")
        require(not (root_identity["attributes"] & REPARSE), "root non-reparse")
        api.volume(handle)
        api.close(handle)
        for n in range(1, 13):
            valid = run_case(api, root, n, positive)
            if n == 1:
                positive = valid
    except Exception as exc:
        report["setup_error"] = str(exc)
        for record in report["cases"]:
            if record["status"] == "dependency-not-reached":
                record["dependency_not_reached"] = "setup: " + str(exc)
    finally:
        if api is not None:
            api.events = report["final"]
            api.close_all()
            if root_created:
                try:
                    info = api.observe(root, "root-cleanup")
                    same(info, root_identity, "root cleanup ownership")
                    require(not (info["attributes"] & REPARSE), "root cleanup non-reparse")
                    ok, _ = api.call("RemoveDirectoryW", (root,), path=root, cleanup=True)
                    require(bool(ok), "root cleanup")
                except Exception as exc:
                    report["cleanup_error"] = str(exc)
            api.close_all()
            if api.cleanup_error:
                report["handle_close_error"] = True
    incomplete = any(r["status"] not in ("observed", "observed-open-denial")
                     or r.get("cleanup_failed") for r in report["cases"])
    findings = [r["case"] + ":" + r["finding"] for r in report["cases"] if "finding" in r]
    failed = (not positive or incomplete or findings or "setup_error" in report
              or "cleanup_error" in report or "handle_close_error" in report)
    report["classification"] = ("unsafe-finding" if findings else
                                "incomplete-or-invalid-positive" if failed else
                                "complete-diagnostic-no-safety-grant")
    report["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    encoded = json.dumps(report, separators=(",", ":"), ensure_ascii=True)
    # Supervisor retains bounded raw bytes and fails on overflow; no receipt replacement.
    print(encoded, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
