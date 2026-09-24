/*
 * advisor-storage-provenance — Windows helper.
 *
 * Answers one question about one already-resolved directory: is the volume
 * backing it fixed and non-hot-pluggable, removable, or a network share. It
 * implements the Windows selection in input/ADAPTER-DECISION.md:
 * GetVolumePathNameW to bind the path to its volume, GetDriveTypeW and
 * GetVolumeInformationW on that volume only, then, for a fixed-looking volume,
 * IOCTL_STORAGE_GET_HOTPLUG_INFO through the narrowest possible handle.
 *
 * Deliberate non-behaviours:
 *   - No device or volume ENUMERATION. Every call names the one volume the
 *     caller's path bound to; FindFirstVolume and friends are never used.
 *   - No administrator permission is requested. The device handle is opened with
 *     ZERO access rights -- query-only, which is what the hotplug IOCTL needs.
 *     If the open or the IOCTL is denied, the answer is `unknown`, never a retry
 *     with elevation.
 *   - No file CONTENT is read, and no volume label, GUID path, serial number or
 *     filesystem name is ever printed.
 *   - DRIVE_FIXED alone is NEVER reported as local-fixed. An external USB disk
 *     routinely enumerates as DRIVE_FIXED; only the hotplug IOCTL distinguishes
 *     it, and if that evidence is missing the volume stays unknown.
 *
 * Output grammar is identical to the Darwin helper; see darwin.c.
 *
 * `dev` is deliberately reported as `u`. Windows exposes a 32-bit volume serial
 * via GetVolumeInformationW, whereas this runtime's `st_dev` is derived from a
 * different source; their equality is NOT established, and printing a value whose
 * semantics are unverified would invite a false identity match. Establishing that
 * binding is an open Windows CI gate -- see README.md.
 *
 * There is no in-process watchdog here: every call below is a bounded, finite
 * Win32 query, and the calling process additionally enforces a hard wall-clock
 * timeout and kills this helper if it overruns.
 */

#include <windows.h>
#include <winioctl.h>

#include <stdio.h>
#include <wchar.h>

#define PROTOCOL "advisor-storage-provenance-v1"

static int emit(const char *status, const char *klass, const char *dev,
                const char *internal, const char *removable) {
  if (printf(PROTOCOL " status=%s class=%s dev=%s internal=%s removable=%s\n",
             status, klass, dev, internal, removable) < 0) {
    return 1;
  }
  return fflush(stdout) == 0 ? 0 : 1;
}

static int refuse(const char *status) { return emit(status, "unknown", "u", "u", "u"); }

/*
 * Build the query-only device path for a bound volume.
 *
 * A drive-letter volume "X:\" becomes "\\.\X:". A volume mounted on a directory
 * has no letter, so its unique volume name is used instead, with the trailing
 * backslash removed as CreateFileW requires for a device open.
 */
static BOOL device_path(const wchar_t *volume_path, wchar_t *out, DWORD out_chars) {
  if (volume_path[0] != L'\0' && volume_path[1] == L':' &&
      (volume_path[2] == L'\\' || volume_path[2] == L'\0')) {
    if (_snwprintf_s(out, out_chars, _TRUNCATE, L"\\\\.\\%c:", volume_path[0]) < 0) return FALSE;
    return TRUE;
  }
  wchar_t unique[MAX_PATH];
  if (!GetVolumeNameForVolumeMountPointW(volume_path, unique, MAX_PATH)) return FALSE;
  size_t length = wcsnlen(unique, MAX_PATH);
  if (length == 0 || length >= out_chars) return FALSE;
  if (unique[length - 1] == L'\\') unique[length - 1] = L'\0';
  if (wcsncpy_s(out, out_chars, unique, _TRUNCATE) != 0) return FALSE;
  return TRUE;
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 2) return refuse("error");

  wchar_t full[MAX_PATH];
  DWORD written = GetFullPathNameW(argv[1], MAX_PATH, full, NULL);
  if (written == 0 || written >= MAX_PATH) return refuse("error");

  DWORD attributes = GetFileAttributesW(full);
  if (attributes == INVALID_FILE_ATTRIBUTES) return refuse("denied");
  if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) return refuse("error");

  wchar_t volume_path[MAX_PATH];
  if (!GetVolumePathNameW(full, volume_path, MAX_PATH)) return refuse("denied");

  UINT drive = GetDriveTypeW(volume_path);
  if (drive == DRIVE_REMOTE) return emit("ok", "network", "u", "u", "u");
  if (drive == DRIVE_REMOVABLE || drive == DRIVE_CDROM) return emit("ok", "removable", "u", "u", "1");
  if (drive != DRIVE_FIXED) return emit("ok", "unknown", "u", "u", "u");

  /*
   * Confirm the bound volume is a real, described filesystem volume. The returned
   * label, serial and filesystem name are intentionally discarded: none of them is
   * provenance evidence and none of them may leave this process.
   */
  if (!GetVolumeInformationW(volume_path, NULL, 0, NULL, NULL, NULL, NULL, 0)) {
    return refuse("denied");
  }

  wchar_t device[MAX_PATH];
  if (!device_path(volume_path, device, MAX_PATH)) return refuse("unsupported");

  /* Zero desired access: a query-only handle, requiring no administrator right. */
  HANDLE handle = CreateFileW(device, 0,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, 0, NULL);
  if (handle == INVALID_HANDLE_VALUE) return refuse("denied");

  STORAGE_HOTPLUG_INFO hotplug;
  ZeroMemory(&hotplug, sizeof(hotplug));
  DWORD returned = 0;
  BOOL ok = DeviceIoControl(handle, IOCTL_STORAGE_GET_HOTPLUG_INFO, NULL, 0,
                            &hotplug, sizeof(hotplug), &returned, NULL);
  CloseHandle(handle);

  /* Without complete hotplug evidence a DRIVE_FIXED volume stays unknown. */
  if (!ok || returned != sizeof(hotplug)) return refuse("denied");

  if (hotplug.MediaRemovable) return emit("ok", "removable", "u", "u", "1");
  /*
   * DeviceHotplug marks the whole device as surprise-removable -- an external
   * enclosure that merely presents fixed media. That is not local-fixed storage.
   */
  if (hotplug.DeviceHotplug) return emit("ok", "removable", "u", "u", "0");

  return emit("ok", "local-fixed", "u", "1", "0");
}
