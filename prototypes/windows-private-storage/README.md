# Windows private-storage prototype (task 1167, CONTRACT r2)

Isolated feasibility prototype for Windows owner-only auth storage. It is
**not** shipping integration:

- not imported by `src/hitl/web/auth.ts`; the win32 auth gate stays closed
- not in `package.json` `files`/`os`, no install script, no prebuild pipeline
- fake-data disposable CI only (fixtures under `RUNNER_TEMP`)
- no durability claim: G2 durability and OS-lock qualification remain open

Files (one coupled unit):

| file | role |
|---|---|
| `native/private_storage.c` | Node-API C, kernel32/advapi32 only |
| `native/build.ps1` | CI-only MSVC build with explicit pinned paths |
| `private-storage.mjs` | loader + argument/result validation |
| `README.md` | this API contract |

## Loading

```js
import { loadPrivateStorage } from './private-storage.mjs';
const loaded = loadPrivateStorage({ binaryPath: 'C:\\...\\private-storage.node', sha256: '<hex>' });
if (loaded.status !== 'ok') { /* { status: 'unavailable', reason, win32Error: 0 } */ }
const { inspectDir, readPrivateFile, createPrivateDir, createPrivateFileExclusive } = loaded.api;
```

- Non-win32 → `unavailable` / `platform_unsupported`. Nothing is loaded.
- Only the binary at `binaryPath` is loaded (absolute `X:\` path, already
  normalized, ending `.node`). No search path, no fallback, no download.
- `sha256` is required. A mismatch means `binary_hash_mismatch`. This check only
  catches packaging and arch mistakes. The file can change between hashing and
  `process.dlopen`.
- After loading, `abi` must equal `aigentry-private-storage-proto-1` and all
  four functions must exist. Otherwise the result is `abi_mismatch`.
- Other load reasons: `binary_path_invalid`, `binary_hash_invalid`,
  `binary_unreadable`, `load_failed`.

## API

All functions are synchronous and never throw. Each returns a frozen object:

```
{ status, reason, win32Error, created?, volumeSerial?, fileId?, bytes? }
```

| function | statuses | extra fields |
|---|---|---|
| `inspectDir(path)` | ok, missing, unsafe, unavailable | ok: volumeSerial, fileId |
| `readPrivateFile(path, max)` | ok, missing, unsafe, unavailable | ok: volumeSerial, fileId, `bytes` (Buffer) |
| `createPrivateDir(path)` | ok, missing, unsafe, exists, unavailable | `created` always; ok: volumeSerial, fileId |
| `createPrivateFileExclusive(path, bytes)` | ok, missing, unsafe, exists, unavailable | `created` always; ok: volumeSerial, fileId |

Status vocabulary:

- `ok`: the predicate held on the opened handle. `bytes` is present only here,
  and only for `readPrivateFile`.
- `missing`: `ERROR_FILE_NOT_FOUND` (2) or `ERROR_PATH_NOT_FOUND` (3) for the
  leaf or any ancestor. For create calls, the parent is missing.
- `unsafe`: the path grammar or a P-DIR/P-FILE predicate was refused. Also used
  for `size_limit`.
- `exists`: create target already exists (`ERROR_FILE_EXISTS` 80 /
  `ERROR_ALREADY_EXISTS` 183). Nothing is modified.
- `unavailable`: a Win32 or Node-API failure, an invalid argument, or a file
  whose DACL is empty (the owner has no data access). Fail closed.

`win32Error` is the original Win32 error number (0 when the result came from a
predicate). Cleanup errors never overwrite it. Results never contain the path,
input bytes, file bytes (except `bytes` on `ok`), or native/engine error text.
`volumeSerial` (16 hex) and `fileId` (32 hex) come from `FileIdInfo` on the
verified handle. They are oracle aids and not secret.

`created` on create results (every status, including wrapper failures) is
exactly one of:

| value | meaning | when |
|---|---|---|
| `false` | not created by this call | the native call never ran (`invalid_argument` in the wrapper), or native reported `false` |
| `true` | created by this call, even if a later step failed | native reported `true` |
| `null` | **UNKNOWN**: the object may or may not exist | native threw (`native_threw`), or returned a non-object or a non-boolean `created` (`native_result_invalid`) |

If native returned a valid boolean `created` but any other field is malformed,
the result is `unavailable` / `native_result_invalid` with that boolean kept.
The wrapper never reports `false` after an unknown side effect, and it never
retries or deletes. After `null`, the caller has to inspect the target, for
example with `inspectDir`/`readPrivateFile` or by listing it, before reusing it.
`inspectDir` and `readPrivateFile` results have no `created` field.

The wrapper reads each raw native property once, inside an exception boundary.
`status`, `reason` (which must be one of the native reason strings below),
`win32Error`, `volumeSerial`, `fileId` and `bytes` are type-checked. Nothing
else from the raw object is forwarded.

The prototype never deletes or repairs anything. Cleanup is the caller's
policy (auth.ts :1229 analogue). A create that fails verification has written no
bytes. A failure during the write can leave a partly written file that already
passed verification.

### Arguments

- `path`: a JS string of 1..32000 UTF-16 units, in the form `X:\comp[\comp...]`.
  Refused as `unsafe` / `path_grammar`:
  - UNC, `\\?\`, `\\.\`, forward slashes, relative or drive-relative paths
  - empty components, `.` / `..`, a trailing separator
  - `:` after the drive (ADS)
  - trailing dot or space in a component
  - reserved device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9, superscript
    1-3 variants, CONIN$, CONOUT$), with or without an extension
  - control characters and `<>"|?*`
  - a component longer than 255 units

  The module adds its own `\\?\` prefix before opening. It strips only the
  `\\?\X:\` form that `GetFinalPathNameByHandleW` returns. Any other final form
  (`\\?\UNC\`, volume GUID) is refused as `final_path_unrecognized`. The final
  path comparison is never skipped.
- `max`: a safe integer with `0 <= max <= 16777216`. Anything else is
  `unavailable` / `invalid_argument`.
- `bytes`: a `Uint8Array`/`Buffer` of length ≤ 16777216.

## What each function proves

Shared steps:

1. Grammar check.
2. Process `TokenUser` SID (process token; impersonation is not considered).
3. Ancestor walk: every proper ancestor, starting at the drive root, is opened
   separately with `FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS`
   and `FILE_READ_ATTRIBUTES`. A reparse point is `ancestor_reparse_point`; a
   non-directory is `ancestor_not_directory`. Each handle is closed before the
   next open.

Same-handle leaf checks, in order (`FILE_FLAG_OPEN_REPARSE_POINT`):

1. `GetFileType == FILE_TYPE_DISK`.
2. Basic and Standard info: not a reparse point; directory or non-directory as
   expected; files need `NumberOfLinks == 1` (else `link_count`).
3. `GetVolumeInformationByHandleW` reports `FILE_PERSISTENT_ACLS` (else
   `acl_not_persistent`).
4. `GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED|VOLUME_NAME_DOS)` equals
   `\\?\` + path, using `CompareStringOrdinal` ignore-case (else
   `final_path_mismatch`). This catches 8.3 names and link substitution at open
   time. The ordinal case fold may differ from the volume `$UpCase` table for
   rare characters. A difference only refuses, it never accepts.
5. `GetSecurityInfo(handle, OWNER|DACL)`:
   - owner == TokenUser (`owner_mismatch`)
   - `SE_DACL_PRESENT` (`dacl_absent`), DACL pointer non-NULL (`dacl_null`)
   - directories: `SE_DACL_PROTECTED` (`dacl_not_protected`)
   - a valid ACL (`dacl_invalid`)
   - empty DACL: directory → `unsafe`; file → `unavailable` (`dacl_empty`).
     Never vacuous success. Measured (CI 37241273202): `inspectDir` on an
     empty-DACL directory fails the leaf open with ACCESS_DENIED before this
     step, so it returns `unavailable` / `open_failed` (5). The tests pin that
     result as a fail-closed deviation. The directory `dacl_empty` branch has
     no live coverage; this is a recorded gap that the refusal does not cover.
   - ACE types: only ACCESS_ALLOWED and ACCESS_DENIED. Deny ACEs are tolerated.
     Every other type (object, callback, conditional, unknown) is
     `ace_unsupported`.
   - any allow ACE for another SID, whether explicit, inherited or
     inherit-only, is `ace_foreign_allow`. This includes CREATOR OWNER and
     OWNER RIGHTS, which are refused on purpose.
   - at least one non-inherit-only owner allow ACE whose generic-mapped mask
     covers:
     - directories: `FILE_LIST_DIRECTORY|FILE_ADD_FILE|FILE_ADD_SUBDIRECTORY|FILE_TRAVERSE`,
       with flags OI|CI
     - files: `FILE_READ_DATA|FILE_WRITE_DATA`

     Otherwise `owner_ace_missing`.
6. `FileIdInfo` (volume serial + 128-bit file id).

Per function:

- `inspectDir`: leaf opened `READ_CONTROL|FILE_READ_ATTRIBUTES`, share
  READ|WRITE (no DELETE), then P-DIR.
- `readPrivateFile`:
  - one handle `FILE_READ_DATA|READ_CONTROL|FILE_READ_ATTRIBUTES`, share READ
    only, then P-FILE
  - size check: `EndOfFile > max` is `unsafe` / `size_limit`
  - reads on the same handle into an `EndOfFile+1` buffer (source:
    `ps_read_all`). After the read:
    - more than `max` bytes read is `unsafe` / `size_limit`. Growth hits this
      only when the queried `EndOfFile == max`.
    - otherwise any count other than `EndOfFile` is `unavailable` /
      `size_changed`. That covers a short read, and growth when
      `EndOfFile < max`.
  - the native buffer is zeroed (`SecureZeroMemory`) and freed on every path
  - a directory at the leaf fails the open (`unavailable` / `open_failed`,
    usually 5)
  - an empty-DACL file usually fails the open with ACCESS_DENIED →
    `unavailable`
- `createPrivateDir`:
  - `CreateDirectoryW` with an absolute SD: owner = TokenUser, protected DACL,
    one ACE allow TokenUser `FILE_ALL_ACCESS` OI|CI. Non-recursive.
  - the new directory is re-opened by path and P-DIR is checked. A swap between
    create and re-open falls under the ancestor limit.
- `createPrivateFileExclusive`:
  - `CreateFileW(CREATE_NEW, share 0, FILE_FLAG_OPEN_REPARSE_POINT)` with the
    same SD (ACE without inherit flags)
  - P-FILE is checked on the creating handle before any byte is written
  - then a `WriteFile` loop (1 MiB chunks; zero or over-reported writes are
    `short_write`) and `FlushFileBuffers`
- An existing object is never re-owned or re-ACLed. There is no
  `SetSecurityInfo` anywhere.

### Reason strings

`ok`, `path_grammar`, `invalid_argument`, `not_found`, `already_exists`,
`ancestor_open_failed`, `ancestor_query_failed`, `ancestor_reparse_point`,
`ancestor_not_directory`, `open_failed`, `create_failed`, `type_query_failed`,
`attributes_query_failed`, `reparse_point`, `not_directory`, `not_regular_file`,
`link_count`, `volume_query_failed`, `acl_not_persistent`,
`final_path_query_failed`, `final_path_unrecognized`, `final_path_mismatch`,
`final_path_compare_failed`, `security_query_failed`, `owner_mismatch`,
`dacl_absent`, `dacl_null`, `dacl_not_protected`, `dacl_invalid`, `dacl_empty`,
`ace_unsupported`, `ace_foreign_allow`, `owner_ace_missing`,
`identity_query_failed`, `size_query_failed`, `size_limit`, `size_changed`,
`read_failed`, `write_failed`, `short_write`, `flush_failed`, `close_failed`,
`token_open_failed`, `token_query_failed`, `token_sid_invalid`,
`descriptor_build_failed`, `alloc_failed`, `internal_error`.

The wrapper adds: `platform_unsupported`, `binary_path_invalid`,
`binary_hash_invalid`, `binary_unreadable`, `binary_hash_mismatch`,
`load_failed`, `abi_mismatch`, `native_threw`, `native_result_invalid`.

Mapping these to auth.ts reasons (`storage_unsafe`, `storage_unavailable`,
`config_invalid`, `provision_conflict`, ...) is policy and out of scope here.

## Not proved (stated limits, CONTRACT r2 §3)

- **Ancestor race.** Components are checked one at a time, each on a fresh
  handle. The leaf final-path check only catches a swap visible when the leaf
  is opened. Ancestors are a trusted-owner precondition, as on POSIX
  (auth.ts:231). Whether a held handle blocks ancestor rename is UNVERIFIED.
- **Effective access.** DACL inspection is not an AccessCheck over every token.
  There is no claim against:
  - SeBackup, SeRestore, SeTakeOwnership or SeDebug holders
  - SYSTEM, Administrators using those privileges, and same-user processes
  - VSS snapshots and offline disk access
- **Durability.** `FlushFileBuffers` is not a power-loss or rename durability
  proof. G2 durability and OS-lock qualification remain an open prerequisite.
  No new persistence or lock engine is added here.
- Arch: win32-x64 only (`build.ps1`). arm64 and ia32 are recorded prototype gaps.
- Node-API: built for NAPI_VERSION 8 and linked against the supplied `node.lib`
  (host must be `node.exe`; no delay-load hook for renamed hosts).
- Native memory safety needs independent review.

## Validation fixture and diagnostics (fake-credential CI only)

- **Fixture F1.** `setup-fixtures.ps1` grants A `(CI)(RX)` on `fx` (was `(RX)`),
  so the four directory links `mklink` creates in `fx` inherit A:RX at creation.
  Nothing is written to a link or its target. B, the root and the other grants
  are unchanged; every non-link `fx` child is still re-protected afterwards.
- **linkacl.** A missing or non-`S-1-...` A SID now gives `aAllow=UNKNOWN
  missing=sidA`, never `none` (precedence snapshot > sddl > sidA > dacl). The
  first unparseable ACE reason (`rights` or `aceType`) is kept.
- **rbcause** (one line per read-back test). It partitions existing rows by
  already-recorded fields only: no new collection, open, API or SDDL change.
  - The rbsplit `flagMissing` rows, by the text that has no `D:`
    (getacl/oracle), and by class: nonAclVolume > oracleNull > unknown > other.
  - Rows with a Get-Acl error and non-directory/non-reparse rows with a nonzero or unmeasured hardlink exit, by
    manifest stream case path (D_ADS/F_ADS/F_DATA_STREAM) > unknown (a case path
    is missing) > nonAclVolume > unknown (no volume metadata) > other.
  - The counts are operands, not causes. Verdicts, readbackFindings and the gate
    are unchanged.
- **rbstate / streamjoin / hlprobe** (diagnostic only, one line each per read-back
  test). New snapshot fields are recorded next to the unchanged `getAclSddl` /
  `getAclError` / fsutil fields. No verdict, readbackFindings count, limit, gate
  or cleanup/export rule reads them. Missing, invalid or non-boolean input is
  unknown, never a match.
  - Oracle: `daclValid` / `daclPresent` / `daclNull` / `daclDefaulted` from
    `GetSecurityDescriptorDacl` on the SD of the same Take handle. A failed call
    leaves `daclValid=false` with `daclError` (unknown, not false).
  - Get-Acl: from the same Get-Acl object, the binary DACL-present / NULL flags,
    the rule count, and whether the only rule is a non-inherited `S-1-1-0` allow
    with its raw rights (`getAclBinValid`, or `getAclBinError` = exception type).
    The binary form cannot separate NULL from absent.
  - Bracket: a second Take after Get-Acl. It is `matching`, `stale` or
    `unmeasured`. It is correlation only: equal endpoints cannot exclude a change
    in between.
  - rbstate: the flagMissing rows by bracket. Only `matching` rows go into the
    oracle {null, absent, present (an empty DACL is present), unknown} ×
    getacl {absentAefa, absentNoAefa, present, unknown} cells. Also counted:
    the AEFA masks and the aclMatch control (`matchAefa`).
  - streamjoin: per stage, each unproved D_ADS/F_ADS/F_DATA_STREAM read-back is
    joined to the row whose path is exactly the manifest `case.object`. A join
    needs equal own-handle volume/file IDs and oracle SDDL, a `matching` host
    bracket, and the host's own read-back. The result is
    joinMatch / joinDiff / joinUnproved (with the first failing reason). It is
    not wired into readbackFindings; that is pending decision D-S.
  - hlprobe: for non-directory rows with a nonzero hardlink exit, one plain
    `FILE_READ_ATTRIBUTES` open without backup intent, plus one
    `FindFirstFileNameW` (bounded buffer, no retry). Only the numeric codes are
    kept, by rbcause class. This is a test-harness P/Invoke, not a runtime API.
    No fsutil cause is inferred.
  - rbctrl: the flagMissing rows. Oracle `sdControl` comes from
    `GetSecurityDescriptorControl` on the same SD that Take reads, before its
    `LocalFree`. Get-Acl `getAclCtrl` is `[int]` of `ControlFlags` on that row's
    existing `$raw`, built from `GetSecurityDescriptorBinaryForm`. Only
    bracket-`matching` rows with both values valid integers 0..65535 are XORed,
    over every bit with no mask. The output is matched / xor plus a histogram of
    the nonzero XOR values; anything else falls into the first unknown category.
    No expected bit is assumed.
  - aceraw: the aceOrder rows. The ordered binary forms of `$raw`'s DACL ACEs
    are compared with those of a `RawSecurityDescriptor` parsed from the same
    Take's oracle sddl: the count, then every byte at every index.
    NULL/absent/empty DACLs, a missing oracle sddl, more than 64 ACEs, a DACL
    over 65536 bytes or an exception give unknown, with a closed reason. These
    rows are crossed with `AreAccessRulesCanonical` (true/false/unknown).
  - Timing for both: read after `GetSecurityDescriptorBinaryForm` and
    `GetAccessRules`, and before the bracket Take. Each value is in its own
    try, so no old field and no gate can change. Get-Acl is never repeated.
    This compares two renderings for ORDER only. It is not storage or semantic
    proof, and `rawEq` alone is not proof of a rendering bug. Framework 4.x
    canonicalization behaviour is not assumed.
  - The selftest operand lines are synthetic vectors, not observations. Every
    value is unmeasured until an independent fake-CI run.
- **Status.** Actual CI 37243865183 on bff4f7a: 139 pass / 10 fail. Four link
  cases plus two cascades turning green is a FORECAST for the next CI run, not
  a result. Read-back stays unproved.

## Build (CI only)

```powershell
pwsh -NoProfile -File native\build.ps1 `
  -ClExe <abs cl.exe> -NodeIncludeDir <abs pinned include\node> `
  -NodeLib <abs pinned node.lib> -OutputPath <abs out\private-storage.node> `
  [-ExpectedNodeLibSha256 <hex>]
```

- Run it inside the CI-pinned MSVC developer environment (`INCLUDE`/`LIB` set).
- `cl` gets an argument array:
  - compile: `/LD /MT /O2 /W4 /sdl /GS /guard:cf`
  - link: `/NXCOMPAT /DYNAMICBASE /HIGHENTROPYVA /GUARD:CF`
  - libraries: node.lib, kernel32.lib, advapi32.lib
- Paths must be absolute `X:\...` with no `"*?<>|`, no `..`, and **no trailing
  `\` or `/`**. The trailing form is refused, not re-quoted: PowerShell quotes an
  argument that contains spaces, and a final `\` would turn the closing quote
  into `\"` under cl's argv parsing. Spaces and other characters stay literal
  argument text because nothing is shell-evaluated. Windows runtime quoting is
  not reproduced here (Darwin); the tester owns that check.
- The script refuses to overwrite the output and does not download anything.
- It writes `<OutputPath>.build.json` with:
  - cl path, file version, sha256 and arguments
  - source, header and node.lib sha256
  - output sha256
  - provenance (no credentials):
    - path, version and sha256 of the `link.exe` next to `cl.exe`. Expected only;
      which linker cl actually ran is not observed.
    - `INCLUDE`, `LIB`, `VCToolsVersion`, `WindowsSDKVersion`, `VSCMD_VER`
    - PowerShell version and `PSNativeCommandArgumentPassing`
  - Header and node.lib hashes are recorded, not compared against a pin, except
    the optional `-ExpectedNodeLibSha256`. The CI job compares them.

Compile status at hand-off: **COMPILE_PENDING**. The source was written on a
Darwin host with no Windows SDK/MSVC, so the CI builder is the first compiler.
