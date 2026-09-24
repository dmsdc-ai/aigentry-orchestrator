# Storage-provenance helpers

Package-owned, read-only helpers that answer one question about one directory:
is the volume backing it internal and fixed, removable, reached over a network,
or not established.

They exist because a filesystem **format** is not **provenance**. `statfs` will
happily report `apfs`, `ext4` or `ntfs` for a USB stick, so format can never show
that a store lives on local fixed media. Node core exposes no API that can, hence
these helpers.

Source of the API selection: `input/ADAPTER-DECISION.md`. Requirement they
satisfy: `input/CONTRACT.md` §1.

## What they are

Ordinary executables that take one path argument and print one line.

They are **not** Node addons. No N-API, no node-gyp, no ABI coupling to a Node
release, so a Node upgrade cannot silently invalidate them. The adapter spawns
them with an argument array and `shell: false`.

## What they never do

- **No enumeration.** Every OS query names the single volume the caller's path
  bound to. Nothing iterates disks, mounts or devices.
- **No elevation.** Ordinary process permissions only. No prompt, no setuid, no
  root fallback. A denial is reported as `unknown`; it is never retried with more
  authority.
- **No content.** No byte of the target directory or of any file in it is read.
- **No identifiers.** No volume label, UUID, GUID path, device serial, BSD name
  or filesystem name is ever printed.
- **No side effects.** Nothing is created, written, mounted or modified.

## Wire protocol

`advisor-storage-provenance-v1`. Exactly one line on stdout, nothing else:

```
advisor-storage-provenance-v1 status=S class=C dev=D internal=I removable=R
```

| Field | Values | Meaning |
|---|---|---|
| `status` | `ok` `denied` `unsupported` `error` | whether the query completed |
| `class` | `local-fixed` `removable` `network` `unknown` | the verdict; `unknown` unless `status=ok` |
| `dev` | decimal, or `u` | device identity of the resolved target |
| `internal` | `1` `0` `u` | device reported internal |
| `removable` | `1` `0` `u` | media reported removable |

The helper exits `0` after printing a well-formed line, so a refusal parses as a
refusal instead of being mistaken for a crash.

The caller parses this under a strict grammar: fixed token count, fixed key order,
enumerated values. Anything else — extra tokens, an unknown value, oversize
output, a non-zero exit, a timeout, a signal — is refused. The caller also
enforces a contradiction guard: a `local-fixed` verdict is rejected unless it is
accompanied by `internal=1 removable=0`, so a verdict can never arrive without
the evidence that supports it.

## Platforms

### Darwin — `darwin.c`

`statfs(2)` for the mount point, then Disk Arbitration
(`DADiskCreateFromVolumePath` + `DADiskCopyDescription`) for that one volume.

`local-fixed` requires **all three** documented keys to be present and to agree:
`kDADiskDescriptionDeviceInternalKey` true,
`kDADiskDescriptionMediaRemovableKey` false,
`kDADiskDescriptionVolumeNetworkKey` false. A missing key is not a false — it
means the property was not described, which is `unknown`.

`dev` is the resolved target's `st_dev`, widened exactly as libuv widens it, so
the caller can confirm the helper described the same volume this process bound.
On Darwin that confirmation is **required**: without it the answer is `unknown`.

Self-bounded by `alarm(2)`.

### Windows — `windows.c`

`GetVolumePathNameW` to bind the path to its volume, then `GetDriveTypeW` and
`GetVolumeInformationW` on that volume only. For a fixed-looking volume, a
**zero-access** (query-only) handle and `IOCTL_STORAGE_GET_HOTPLUG_INFO`.

`DRIVE_FIXED` alone is **never** reported as `local-fixed`. An external USB disk
routinely enumerates as `DRIVE_FIXED`; only the hotplug IOCTL separates them. If
the handle or the IOCTL is denied, the volume stays `unknown`. `MediaRemovable`
is removable; `DeviceHotplug` is also removable, because an external enclosure
presenting fixed media is not local fixed storage.

`dev` is deliberately `u`. Windows exposes a 32-bit volume serial via
`GetVolumeInformationW`, while this runtime's `st_dev` comes from a different
source; **their equality is not established**. Printing a value whose semantics
are unverified would invite a false identity match. The caller therefore falls
back to its own before/after `realpath`/`lstat`/`statfs` binding and records the
binding strength as `node-only`.

No in-process watchdog: every call is a bounded, finite Win32 query, and the
calling process enforces a hard wall-clock timeout and kills an overrunning
helper.

### Linux — no helper

The Linux adapter is pure Node and lives in
`src/task-advisor/storage-provenance.ts`. It matches the canonical path to one
unambiguous longest entry in `/proc/self/mountinfo`, then reads only the selected
`/sys` attributes for that exact device.

`removable == 0` is **never** accepted on its own. A fixed-looking disk behind a
USB bridge reports `0` too, so the device topology must also resolve under
`/sys/devices/` with no hot-pluggable transport segment (`usb`, `mmc`,
`firewire`, `ieee1394`, `thunderbolt`). Two entries sharing the longest mount
point is an over-mount and is refused. Any unreadable attribute, unresolvable
topology or namespace ambiguity is `unknown`.

## Building

Explicit and opt-in. Nothing runs at install time; no compiler is invoked and no
binary is downloaded when this package is installed.

```sh
npm run build:advisor-storage
```

or, for an independent CI builder, `CMakeLists.txt` in this directory.

Output must land at the exact fixed names the adapter resolves relative to the
package root:

```
native/task-advisor-storage/bin/advisor-storage-provenance-<platform>-<arch>[.exe]
```

The adapter locates that path by walking up from its own module to the package
manifest. It is never taken from `PATH`, an environment variable, configuration
or a workspace file — all of those are caller-controlled, and a caller-controlled
binary could simply claim `local-fixed`. The resolved file must be a real,
non-symlink regular file.

**A missing helper is safe.** The adapter reports `unknown` and production writes
refuse. That is the correct answer when provenance has not been measured.

## Status of evidence

Building these helpers qualifies **nothing**. It builds the measurement path
only. The qualification catalog stays empty until a controller reviews exact B1
evidence, so production writes still refuse.

Open gates for these helpers specifically:

- **Windows is UNCOMPILED here.** It requires the independent Windows CI builder
  with MSVC. Not ready for release until that builds it warning-clean.
- **Windows volume-identity binding is UNVERIFIED.** Whether the
  `GetVolumeInformationW` serial can be made to correspond to this runtime's
  `st_dev` must be established before `dev` stops being `u`.
- **No helper has been executed against real media.** Internal, USB, network,
  virtual and controller-attached cases are all unrun, as are access-denied,
  race, malicious-helper and bounded-cost cases. Those belong to the independent
  tester, not to the author of this code.
- **Virtual and exotic storage controllers are not claimed to be covered** by
  these APIs. Where they are not, the answer must be `unknown`.
