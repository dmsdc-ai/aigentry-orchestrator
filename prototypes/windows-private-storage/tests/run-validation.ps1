# run-validation.ps1 - #1167 Windows private-storage ACL prototype, test-only orchestrator.
# Runs ELEVATED on a disposable GitHub-hosted Windows runner. The admin token only: creates/removes the two
# fake standard accounts, builds/removes owned fixtures and VHDs, and takes oracle snapshots. The helper is
# loaded ONLY by acl.test.mjs (PSP_PHASE=helper) running as fake standard user A. B's attempts run as B.
# Final pass/fail is acl.test.mjs PSP_PHASE=verdict over the receipts (it never loads the helper).
# A green run is a FEASIBILITY receipt only: no product, release, install, durability or security acceptance.
# Exit 0 only if every stage ran and the verdict passed. Unavailable essential fixture => nonzero (HOLD).
[CmdletBinding()]
param(
  [string]$HelperPath = $env:PSP_HELPER_PATH,
  [string]$HelperSha256 = $env:PSP_HELPER_SHA256,
  [string]$WrapperPath = $env:PSP_WRAPPER_PATH,
  [string]$WrapperSha256 = $env:PSP_WRAPPER_SHA256,
  [string]$TrustRoot,
  [switch]$CleanupOnly,
  [switch]$ExportOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  Write-Output 'refusing: run-validation.ps1 runs only on a disposable GitHub-hosted runner (GITHUB_ACTIONS, RUNNER_ENVIRONMENT=github-hosted, RUNNER_TEMP)'
  exit 3
}
$admin = (New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Output 'refusing: setup/cleanup needs the elevated runner token'; exit 3 }

# Elevated native tools and modules resolve only from SystemRoot: tool-cache PATH entries may be writable
# by the fake users. node.exe is resolved once here, before any fake account exists.
$nodeSrc = $null
if (-not $CleanupOnly -and -not $ExportOnly) { $nodeSrc = (Get-Command node.exe -ErrorAction Stop).Source }
$env:PATH = (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot + ';' + (Join-Path $env:SystemRoot 'System32\Wbem') + ';' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'

. (Join-Path $PSScriptRoot 'setup-fixtures.ps1')
. (Join-Path $PSScriptRoot 'run-as-user.ps1')

$tempLong = Get-PspTempLong
$adminSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Write-PspJson { param($Obj, [string]$Name) ($Obj | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath (Join-Path $ReceiptsDir $Name) -Encoding UTF8 }

function Invoke-PspCleanup { param($State)
  $c = [ordered]@{ stateProblems = @(Test-PspCleanupState -State $State -TempLong $tempLong -RunId $env:GITHUB_RUN_ID); vdisks = $null; root = $null; users = $null; ok = $false }
  if ($c.stateProblems.Count -gt 0) { return $c }   # tampered/unknown state: no destructive action at all
  $c.vdisks = @(Remove-PspVhds -State $State -ScratchDir $scratch -Root $State.root)
  if ($State.root) { $c.root = Remove-PspFixtureRoot -Root $State.root -TempLong $tempLong -RunId $env:GITHUB_RUN_ID -WriterSids @(@($State.users) | ForEach-Object { $_.sid }) }
  $c.users = @(Remove-PspFakeUsers -State $State)
  $c.ok = (@($c.vdisks | Where-Object { $_.error }).Count -eq 0) -and (($null -eq $c.root) -or $c.root.removed) -and (@($c.users | Where-Object { $_.error -and $_.error -ne 'not-present' }).Count -eq 0)
  return $c
}

# The bound trust root: exactly RUNNER_TEMP\<PSP_TRUST_LEAF>, the name the workflow bound before any fake
# account existed; canonical, and the root this trusted copy runs from. Never a root found by globbing.
function Test-PspBoundTrustRoot { param([string]$TrustRoot)
  $i = $TrustRoot.LastIndexOf('\')
  return -not (($i -lt 0) -or ($TrustRoot.Substring(0, $i) -cne $tempLong) -or ($TrustRoot.Substring($i + 1) -cnotmatch '^psp1167-trust-[0-9a-f]{16}$') -or
    ($TrustRoot.Substring($i + 1) -cne $env:PSP_TRUST_LEAF) -or ([System.IO.Path]::GetFullPath($TrustRoot) -cne $TrustRoot) -or ((Split-Path -Parent $PSScriptRoot) -ne $TrustRoot))
}

# Upload source. Copies the bound root's receipts (plain single-link files only, Oracle.Capture) into a NEW
# protected export dir, only while no fake-user process is alive and trust.json binds the root to this run.
# Any problem => exit 1 and the workflow uploads nothing (no fallback path).
function Export-PspEvidence { param($Trust)
  $x = [ordered]@{ schema = 'aigentry/1167-psp-export/v1'; task = '1167'; trustRoot = $Trust.root; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; liveWriters = @(); files = @(); problems = @() }
  $tj = Join-Path $Trust.receipts 'trust.json'
  $bound = $null; if (Test-Path -LiteralPath $tj) { $bound = Get-Content -LiteralPath $tj -Raw | ConvertFrom-Json }
  if (($null -eq $bound) -or ($bound.root -cne $Trust.root) -or ($bound.runId -cne $env:GITHUB_RUN_ID) -or ($bound.runAttempt -cne $env:GITHUB_RUN_ATTEMPT)) { $x.problems += 'trust.json does not bind this root to this run' }
  $sids = @()
  if (Test-Path -LiteralPath $Trust.statePath) {
    $st = Get-Content -LiteralPath $Trust.statePath -Raw | ConvertFrom-Json
    $sp = @(Test-PspCleanupState -State $st -TempLong $tempLong -RunId $env:GITHUB_RUN_ID)
    if ($sp.Count -gt 0) { $x.problems += ('state: ' + ($sp -join ',')) } else { $sids = @(@($st.users) | ForEach-Object { $_.sid }) }
  }
  $x.liveWriters = @(Get-PspLiveSidProcesses $sids)
  if ($x.liveWriters.Count -gt 0) { $x.problems += 'fake-user processes alive' }
  $out = Join-Path $Trust.root 'export'
  if ($x.problems.Count -eq 0) {
    $e = [Psp1167.Oracle]::CreateProtectedDir($out, $script:PspTrustSddl)
    if ($e -ne 0) { $x.problems += "export dir not created (Win32 $e)" }
    else {
      foreach ($f in @(Get-ChildItem -LiteralPath $Trust.receipts -Force)) {
        if ($f.PSIsContainer -or (($f.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { $x.problems += "not a plain file: $($f.Name)"; continue }
        $d = Join-Path $out $f.Name
        $c = [Psp1167.Oracle]::Capture($f.FullName, $d, 16MB)
        if ($c -ne 0) { $x.problems += "capture of $($f.Name) refused ($c)"; continue }
        $x.files += ,([ordered]@{ name = $f.Name; bytes = (Get-Item -LiteralPath $d -Force).Length; sha256 = (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash.ToLowerInvariant() })
      }
      foreach ($need in @('trust.json', 'run.json')) { if (@($x.files | Where-Object { $_.name -ceq $need }).Count -ne 1) { $x.problems += "required evidence $need missing" } }
      $rb = Test-PspTrustedObject $out @($script:PspSidAdmins) -Protected
      if ($rb.problems.Count -gt 0) { $x.problems += ('export dir readback: ' + ($rb.problems -join ',')) }
      ($x | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $out 'export-manifest.json') -Encoding UTF8
    }
  }
  Write-Host ('export: files={0} problems={1}' -f @($x.files).Count, ($x.problems -join '; '))   # host stream: the return value stays the exit code
  if ($x.problems.Count -eq 0) { return 0 } else { return 1 }
}

# DIAGNOSTIC only (host stream; tainted until the trusted export; never verdict acceptance). Pure: no command, no I/O.
# Fixed prefix plus numeric / hex / closed-enum fields only: never a test name, YAML block, stack, value, path or control
# character. A failing test is its TAP number, depth and sha256 of the UTF-8 TAP name field (for local matching only).
# Bounds: more than 50000 LF lines => nothing parsed (tap=too-many-lines); first 64 'not ok' listed, the rest counted.
function Format-PspVerdictDiag { param($NodeExit, [string]$ReadStatus, [string]$Text, $Bytes)
  $ne = 'none'; if (($NodeExit -is [int]) -and ([string]$NodeExit -cmatch '^-?[0-9]{1,10}\z')) { $ne = [string]$NodeExit }
  $rs = 'UNKNOWN'; if (@('ok', 'missing', 'unexpected-path', 'reparse', 'not-file', 'too-large', 'read-failed', 'decode-failed') -ccontains $ReadStatus) { $rs = $ReadStatus }
  $by = 'none'; if (($Bytes -is [long]) -and ($Bytes -ge 0)) { $by = [string]$Bytes }
  $n = [ordered]@{ lines = 'none'; plan = 'none'; tests = 'none'; pass = 'none'; fail = 'none'; cancelled = 'none'; skipped = 'none'; todo = 'none'; okLines = 'none'; notOkLines = 'none'; bail = 'none'; listed = 0; clipped = 0 }
  $fails = @()
  if ($rs -ceq 'ok') {
    $lines = $Text.Split([char]10)
    $n.lines = [string]$lines.Count
    if ($lines.Count -gt 50000) { $rs = 'too-many-lines' }
    else {
      $ok = 0; $nok = 0; $bail = 0
      foreach ($raw in $lines) {
        $l = $raw.TrimEnd([char]13)
        if ($l -cmatch '^((?:    ){0,16})(not ok|ok) ([0-9]{1,9})(?: - (.*))?\z') {
          $ind = $Matches[1]; $kind = $Matches[2]; $num = $Matches[3]; $nm = $Matches[4]
          if ($kind -ceq 'ok') { $ok++; continue }
          $nok++
          if ($fails.Count -ge 64) { $n.clipped = $n.clipped + 1; continue }
          $h = 'none'
          if ($null -ne $nm) {
            $s = [System.Security.Cryptography.SHA256]::Create()
            try { $h = ([System.BitConverter]::ToString($s.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($nm))) -replace '-', '').ToLowerInvariant() } finally { $s.Dispose() }
          }
          $dir = 0; if (($null -ne $nm) -and ($nm -imatch '\s#\s*(TODO|SKIP)\b')) { $dir = 1 }
          $fails += ('psp-diag verdict-fail n=' + $num + ' depth=' + [string][int]($ind.Length / 4) + ' directive=' + $dir + ' nameSha256=' + $h)
        }
        elseif ($l -cmatch '^# (tests|pass|fail|cancelled|skipped|todo) ([0-9]{1,9})\z') { $n[$Matches[1]] = $Matches[2] }
        elseif ($l -cmatch '^1\.\.([0-9]{1,9})\z') { $n.plan = $Matches[1] }
        elseif ($l -cmatch '^\s*Bail out!') { $bail++ }
      }
      $n.okLines = [string]$ok; $n.notOkLines = [string]$nok; $n.bail = [string]$bail; $n.listed = $fails.Count
    }
  }
  $head = 'psp-diag verdict nodeExit=' + $ne + ' tap=' + $rs + ' bytes=' + $by
  foreach ($k in @('lines', 'plan', 'tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'okLines', 'notOkLines', 'bail', 'listed', 'clipped')) { $head += (' ' + $k + '=' + $n[$k]) }
  return @($head + ' trust=diagnostic-only') + $fails
}

# Reads ONLY the literal owned receipts\verdict.tap (plain file, no reparse point, at most 4MB, strict UTF-8) and writes
# the Format-PspVerdictDiag lines to the host stream. Any refusal is a closed read status; it never throws.
function Write-PspVerdictDiag { param([string]$Path, $NodeExit)
  $rs = 'read-failed'; $text = ''; $bytes = $null
  try {
    $want = Join-Path $ReceiptsDir 'verdict.tap'
    if (($Path -cne $want) -or ([System.IO.Path]::GetFullPath($Path) -cne $want)) { $rs = 'unexpected-path' }
    elseif (-not ([System.IO.File]::Exists($Path) -or [System.IO.Directory]::Exists($Path))) { $rs = 'missing' }
    else {
      $attr = [System.IO.File]::GetAttributes($Path)
      if (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { $rs = 'reparse' }
      elseif (($attr -band [System.IO.FileAttributes]::Directory) -ne 0) { $rs = 'not-file' }
      else {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        try {
          $bytes = [long]$fs.Length
          if ($bytes -gt 4MB) { $rs = 'too-large' }
          else {
            $buf = New-Object byte[] ([int]$bytes)
            $got = 0; while ($got -lt $buf.Length) { $k = $fs.Read($buf, $got, $buf.Length - $got); if ($k -le 0) { break }; $got += $k }
            if ($got -ne $buf.Length) { $rs = 'read-failed' }
            else { try { $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($buf); $rs = 'ok' } catch { $rs = 'decode-failed' } }
          }
        } finally { $fs.Dispose() }
      }
    }
  } catch { $rs = 'read-failed' }
  try { foreach ($l in @(Format-PspVerdictDiag $NodeExit $rs $text $bytes)) { Write-Host $l } } catch { Write-Host 'psp-diag verdict summary=failed' }
  try { foreach ($l in @(Format-PspVerdictOpDiag $rs $text)) { Write-Host $l } } catch { Write-Host 'psp-diag verdict-op summary=failed' }
}

# DIAGNOSTIC only: one fixed line from an Invoke-PspCleanup result (or the in-run catch record). Pure: no command, no
# I/O. Counts, booleans and closed enums only; never a raw error, path, name or SID. Unrecognised root errors are UNKNOWN.
function Format-PspCleanupDiag { param([string]$Phase, $C)
  $ph = 'UNKNOWN'; if (@('in-run', 'backstop') -ccontains $Phase) { $ph = $Phase }
  $line = 'psp-diag cleanup phase=' + $ph
  if (-not ($C -is [System.Collections.IDictionary])) { return ($line + ' summary=none') }
  $ok = 'false'; if (($C['ok'] -is [bool]) -and $C['ok']) { $ok = 'true' }
  $exc = 'false'; if ($null -ne $C['error']) { $exc = 'true' }
  $sp = 0; foreach ($x in @($C['stateProblems'])) { if ($null -ne $x) { $sp++ } }
  $vd = 'none'; $vde = 'none'
  if ($null -ne $C['vdisks']) {
    $vd = 0; $vde = 0
    foreach ($v in @($C['vdisks'])) { $vd++; if ((-not ($v -is [System.Collections.IDictionary])) -or ($null -ne $v['error'])) { $vde++ } }
  }
  $rt = 'none'; $re = 'none'; $lw = 'none'; $r = $C['root']
  if ($r -is [System.Collections.IDictionary]) {
    $rt = 'kept'; if (($r['removed'] -is [bool]) -and $r['removed']) { $rt = 'removed' }
    $lw = 0; foreach ($x in @($r['liveWriters'])) { if ($null -ne $x) { $lw++ } }
    $e = $r['error']
    if ($null -eq $e) { $re = 'none' }
    elseif (-not ($e -is [string])) { $re = 'UNKNOWN' }
    elseif ($e -ceq 'refusing: process enumeration failed (live writer state unknown)') { $re = 'owner-unknown-enumeration' }
    elseif ($e -ceq 'refusing: process owner query failed (live writer state unknown)') { $re = 'owner-unknown-query' }
    elseif ($e -ceq 'refusing: process owner query returned a nonzero or missing ReturnValue (live writer state unknown)') { $re = 'owner-unknown-rv' }
    elseif ($e -ceq 'refusing: process owner SID missing or invalid (live writer state unknown)') { $re = 'owner-unknown-sid' }
    elseif ($e -ceq 'fixture root not fully removed (explicit cleanup failure)') { $re = 'not-fully-removed' }
    elseif ($e.StartsWith('refusing: fake-user processes still alive: ', [System.StringComparison]::Ordinal)) { $re = 'live-writers' }
    elseif ($e.StartsWith('refusing unowned root ', [System.StringComparison]::Ordinal)) { $re = 'unowned-root' }
    elseif ($e.StartsWith('refusing non-canonical root ', [System.StringComparison]::Ordinal)) { $re = 'non-canonical-root' }
    elseif ($e.StartsWith('refusing reparse-point root ', [System.StringComparison]::Ordinal)) { $re = 'reparse-root' }
    elseif ($e.StartsWith('cannot enable Se', [System.StringComparison]::Ordinal)) { $re = 'privilege' }
    elseif ($e.StartsWith('refusing: link pair ', [System.StringComparison]::Ordinal) -or $e.StartsWith('refusing: delete ', [System.StringComparison]::Ordinal) -or $e.StartsWith('refusing: reopen ', [System.StringComparison]::Ordinal)) { $re = 'link-pair' }
    else { $re = 'UNKNOWN' }
  } elseif ($null -ne $r) { $rt = 'UNKNOWN'; $re = 'UNKNOWN' }
  $us = 'none'; $ur = 'none'; $un = 'none'; $ue = 'none'
  if ($null -ne $C['users']) {
    $us = 0; $ur = 0; $un = 0; $ue = 0
    foreach ($u in @($C['users'])) {
      $us++
      if (-not ($u -is [System.Collections.IDictionary])) { $ue++; continue }
      if (($u['removed'] -is [bool]) -and $u['removed']) { $ur++ }
      if ($u['error'] -ceq 'not-present') { $un++ } elseif ($null -ne $u['error']) { $ue++ }
    }
  }
  return ($line + ' ok=' + $ok + ' exception=' + $exc + ' stateProblems=' + $sp + ' vdisks=' + $vd + ' vdiskErrors=' + $vde + ' root=' + $rt + ' rootError=' + $re + ' liveWriters=' + $lw + ' users=' + $us + ' usersRemoved=' + $ur + ' usersNotPresent=' + $un + ' userErrors=' + $ue)
}

# DIAGNOSTIC only (host stream; tainted until the trusted export; never verdict acceptance). Pure: no command, no I/O.
# Second reader of the same in-memory verdict.tap text: only column-0 '# psp-op/1 ' comments (acl.test.mjs opDiag via
# t.diagnostic at depth 0) whose every token matches the closed per-kind schema below are re-emitted; anything else is
# only counted, never echoed (indented look-alikes, e.g. inside a YAML error block, count as 'indented').
# Twin vocabulary: acl.test.mjs OP_* (same literals). Bounds: the 50000-line cap of Format-PspVerdictDiag, 1411 chars per
# line, one line per kind/key (later duplicates counted), at most 128 listed lines (the rest counted as clipped).
function Format-PspVerdictOpDiag { param([string]$ReadStatus, [string]$Text)
  $rs = 'UNKNOWN'; if (@('ok', 'missing', 'unexpected-path', 'reparse', 'not-file', 'too-large', 'read-failed', 'decode-failed') -ccontains $ReadStatus) { $rs = $ReadStatus }
  $cand = 0; $acc = 0; $clip = 0; $mal = 0; $over = 0; $dup = 0; $ind = 0; $err = 0
  $out = @()
  if ($rs -ceq 'ok') {
    $lines = $Text.Split([char]10)
    if ($lines.Count -gt 50000) { $rs = 'too-many-lines' }
    else {
      $voc = @{
        bool = @('true', 'false'); pres = @('present', 'absent'); shape = @('array', 'single'); seq = @('match', 'differ'); test = @('contradict', 'unproved'); who = @('A', 'B')
        tag = @('identity-A', 'identity-B', 'probe-Actl', 'move-measure', 'probe-Atrust', 'probe-Btrust', 'probe-B1', 'helper-run', 'probe-B2')
        mode = @('identity', 'probe', 'move-measure', 'node-test')
        status = @('ok', 'missing', 'unsafe', 'exists', 'unavailable')
        cls = @('ok', 'unsafe', 'missing', 'unavailable', 'exists', 'error')
        op = @('inspectDir', 'readPrivateFile', 'createPrivateDir', 'createPrivateFileExclusive')
        reason = @('ok', 'path_grammar', 'invalid_argument', 'not_found', 'already_exists', 'ancestor_open_failed', 'ancestor_query_failed', 'ancestor_reparse_point',
          'ancestor_not_directory', 'open_failed', 'create_failed', 'type_query_failed', 'attributes_query_failed', 'reparse_point', 'not_directory', 'not_regular_file',
          'link_count', 'volume_query_failed', 'acl_not_persistent', 'final_path_query_failed', 'final_path_unrecognized', 'final_path_mismatch',
          'final_path_compare_failed', 'security_query_failed', 'owner_mismatch', 'dacl_absent', 'dacl_null', 'dacl_not_protected', 'dacl_invalid', 'dacl_empty',
          'ace_unsupported', 'ace_foreign_allow', 'owner_ace_missing', 'identity_query_failed', 'size_query_failed', 'size_limit', 'size_changed', 'read_failed',
          'write_failed', 'short_write', 'flush_failed', 'close_failed', 'token_open_failed', 'token_query_failed', 'token_sid_invalid', 'descriptor_build_failed',
          'alloc_failed', 'internal_error', 'platform_unsupported', 'binary_path_invalid', 'binary_hash_invalid', 'binary_unreadable', 'binary_hash_mismatch',
          'load_failed', 'abi_mismatch', 'native_threw', 'native_result_invalid')
        oreason = @('grammar:empty', 'grammar:prefix', 'grammar:not-drive-absolute', 'grammar:colon', 'grammar:empty-component', 'grammar:dot-component',
          'grammar:trailing-dot-or-space', 'grammar:reserved-name', 'no-snapshot', 'missing', 'ancestor-reparse', 'reparse', 'non-acl-volume', 'final-path-mismatch',
          'owner', 'dacl-absent', 'null-dacl', 'unknown-ace', 'foreign-allow', 'not-protected', 'no-owner-ace', 'empty-dacl', 'no-owner-rw-ace', 'not-dir', 'not-file',
          'hardlink', 'fixture-unavailable', 'vhd-flags-unmeasured', 'exists', 'object-not-present', 'open-error', 'info-error', 'volume-error', 'final-path-error',
          'sddl-error')
        case = @('D_OK', 'D_NEST_OK', 'D_B_OWNED', 'D_B_ACE', 'D_NULL', 'D_EMPTY', 'D_NONPROT', 'D_ADMIN', 'D_UNKNOWN', 'D_JUNCTION', 'D_SYMLINK', 'D_UNDER_JUNCTION',
          'D_NOT_DIR', 'D_MISSING', 'D_SHORTNAME', 'D_TRAILDOT', 'D_TRAILSPACE', 'D_ADS', 'D_UNC', 'D_LONGPREFIX', 'D_DEVPREFIX', 'D_RESERVED', 'F_OK', 'F_B_OWNED',
          'F_B_ACE', 'F_NULL', 'F_EMPTY', 'F_ADMIN', 'F_UNKNOWN', 'F_INHERITED_FOREIGN', 'F_NLINK2', 'F_SYMLINK', 'F_UNDER_JUNCTION', 'F_NOT_FILE', 'F_MISSING',
          'F_SHORTNAME', 'F_TRAILDOT', 'F_ADS', 'F_DATA_STREAM', 'F_UNC', 'F_LONGPREFIX', 'C_DIR', 'C_DIR_INSPECT', 'C_DIR_AGAIN', 'C_FILE', 'C_FILE_READ',
          'C_FILE_AGAIN', 'C_DANGLING', 'C_DIR_TRAILDOT', 'C_FILE_ADS', 'D_FAT', 'F_FAT', 'C_DIR_FAT', 'C_FILE_FAT', 'D_EXFAT', 'F_EXFAT', 'C_DIR_EXFAT', 'C_FILE_EXFAT')
        privs = @('SeAssignPrimaryTokenPrivilege', 'SeAuditPrivilege', 'SeBackupPrivilege', 'SeChangeNotifyPrivilege', 'SeCreateGlobalPrivilege',
          'SeCreatePagefilePrivilege', 'SeCreatePermanentPrivilege', 'SeCreateSymbolicLinkPrivilege', 'SeCreateTokenPrivilege', 'SeDebugPrivilege',
          'SeDelegateSessionUserImpersonatePrivilege', 'SeEnableDelegationPrivilege', 'SeImpersonatePrivilege', 'SeIncreaseBasePriorityPrivilege',
          'SeIncreaseQuotaPrivilege', 'SeIncreaseWorkingSetPrivilege', 'SeLoadDriverPrivilege', 'SeLockMemoryPrivilege', 'SeMachineAccountPrivilege',
          'SeManageVolumePrivilege', 'SeProfileSingleProcessPrivilege', 'SeRelabelPrivilege', 'SeRemoteShutdownPrivilege', 'SeRestorePrivilege',
          'SeSecurityPrivilege', 'SeShutdownPrivilege', 'SeSyncAgentPrivilege', 'SeSystemEnvironmentPrivilege', 'SeSystemProfilePrivilege', 'SeSystemtimePrivilege',
          'SeTakeOwnershipPrivilege', 'SeTcbPrivilege', 'SeTimeZonePrivilege', 'SeTrustedCredManAccessPrivilege', 'SeUndockPrivilege', 'SeUnsolicitedInputPrivilege')
        aclerr = @('UnauthorizedAccessException', 'PrivilegeNotHeldException', 'ItemNotFoundException', 'FileNotFoundException', 'DirectoryNotFoundException',
          'PathTooLongException', 'IOException', 'ArgumentException', 'NotSupportedException', 'InvalidOperationException', 'SecurityException', 'Win32Exception')
        lcase = @('D_JUNCTION', 'D_SYMLINK', 'D_UNDER_JUNCTION', 'F_UNDER_JUNCTION'); need = @('rcra', 'ra')
        owncls = @('A', 'B', 'admins', 'system', 'adminUser', 'other'); allowk = @('explicit', 'inherited', 'both')
        missing = @('snapshot', 'sddl', 'sidA', 'dacl', 'aceType', 'rights', 'groupMembership')
      }
      # Field order and value class per kind, exactly as acl.test.mjs writes them.
      $schema = @{
        priv = 'who:who receipt:pres shape:shape whoamiExit:int entries:cnt enabled:cnt disabled:cnt otherState:cnt unknownName:cnt enabledUnknownName:cnt enabledKnown:privs'
        launch = 'tag:tag receipt:pres sidMatch:bool ok:bool mode:mode nodeExit:int error:bool problems:cnt'
        helperrun = 'receipt:pres loaded:bool loadStatus:status loadReason:reason loadWinErr:int loadError:bool results:cnt threw:cnt abiBad:cnt notRun:cnt promise:cnt'
        bindseq = 'seq:seq entries:cnt problems:cnt'
        bind = 'tag:tag hits:cnt user:bool mode:bool launched:bool timedOut:bool exit:int launchError:int prerequisite:bool self:pres selfOk:bool selfMode:bool selfNodeExit:int'
        helper = 'case:case op:op result:pres threw:bool abiOk:bool status:status reason:reason winErr:int created:bool bytes:int volId:bool want:cls oracle:cls oracleReason:oreason oracleCode:int problems:cnt'
        readback = 'test:test snapProblems:cnt objects:cnt skipped:cnt aclMatch:cnt aclDiffNonReparse:cnt aclDiffReparse:cnt aclUnavailNonReparse:cnt aclUnavailReparse:cnt aclErrPresent:cnt hlMatch:cnt hlDiff:cnt hlReparse:cnt hlExitNonzero:cnt rpNotOracle:cnt rpExitNonzero:cnt contradictions:cnt unproved:cnt'
        rbdiff = 'test:test dir:cnt file:cnt owner:cnt group:cnt daclFlags:cnt aceCount:cnt aceOrder:cnt aceFlags:cnt aceSet:cnt textOnly:cnt unparsed:cnt hlExits:hist hlExitsOther:cnt rpExits:hist rpExitsOther:cnt'
        rbsplit = 'test:test flagProtected:cnt flagAutoInherited:cnt flagIsNull:cnt flagMissing:cnt flagUnparsed:cnt orderDenyRelChanged:cnt orderDenyRelUnchanged:cnt orderDenyRelUnknown:cnt aclErrTypes:ehist aclErrOther:cnt aclErrAbsent:cnt'
        linkacl = 'case:lcase need:need link:pres reparse:bool owner:owncls aAllow:allowk missing:missing aDeny:cnt adminAllow:cnt otherAllow:cnt otherDeny:cnt'
        rbcause = 'test:test missGetacl:cnt missOracle:cnt missSideUnknown:cnt missNonAclVolume:cnt missOracleNull:cnt missOther:cnt missUnknown:cnt errStream:cnt errNonAclVolume:cnt errOther:cnt errUnknown:cnt hlNzStream:cnt hlNzNonAclVolume:cnt hlNzOther:cnt hlNzUnknown:cnt'
        rbstate = 'test:test bindOk:cnt bindStale:cnt bindUnmeasured:cnt nullAbsentAefa:cnt nullAbsentNoAefa:cnt nullPresent:cnt nullUnknown:cnt absentAbsentAefa:cnt absentAbsentNoAefa:cnt absentPresent:cnt absentUnknown:cnt presentAbsentAefa:cnt presentAbsentNoAefa:cnt presentPresent:cnt presentUnknown:cnt unknownAbsentAefa:cnt unknownAbsentNoAefa:cnt unknownPresent:cnt unknownUnknown:cnt aefaMasks:hist aefaMasksOther:cnt matchAefa:cnt matchUnknown:cnt'
        streamjoin = 'test:test aclRows:cnt hlRows:cnt joinMatch:cnt joinDiff:cnt joinUnproved:cnt uManifest:cnt uStreamRow:cnt uHostRow:cnt uOpen:cnt uIdentity:cnt uSddl:cnt uBracket:cnt uReadback:cnt'
        hlprobe = 'test:test rows:cnt streamBothOk:cnt streamFfnErr:cnt streamPlainErr:cnt streamUnknown:cnt nonAclBothOk:cnt nonAclFfnErr:cnt nonAclPlainErr:cnt nonAclUnknown:cnt otherBothOk:cnt otherFfnErr:cnt otherPlainErr:cnt otherUnknown:cnt unknownBothOk:cnt unknownFfnErr:cnt unknownPlainErr:cnt unknownUnknown:cnt plainErrs:hist plainErrsOther:cnt plainUnknown:cnt ffnErrs:hist ffnErrsOther:cnt ffnUnknown:cnt'
        rbctrl = 'test:test rows:cnt uStale:cnt uUnmeasured:cnt uOracle:cnt uGetacl:cnt matched:cnt xor:cnt ctrlXor:hist ctrlXorOther:cnt'
        aceraw = 'test:test rows:cnt bindOk:cnt bindStale:cnt bindUnmeasured:cnt eqTrue:cnt eqFalse:cnt eqUnknown:cnt neTrue:cnt neFalse:cnt neUnknown:cnt unknownTrue:cnt unknownFalse:cnt unknownUnknown:cnt neCount:cnt uNoBinary:cnt uOracleSddl:cnt uGetAclDacl:cnt uOracleDacl:cnt uEmpty:cnt uBounds:cnt uError:cnt uInvalid:cnt'
      }
      $keyed = @('priv', 'launch', 'bind', 'helper', 'readback', 'rbdiff', 'rbsplit', 'linkacl', 'rbcause', 'rbstate', 'streamjoin', 'hlprobe', 'rbctrl', 'aceraw')
      $seen = @{}
      foreach ($raw in $lines) {
        $l = $raw.TrimEnd([char]13)
        if (-not $l.StartsWith('# psp-op/', [System.StringComparison]::Ordinal)) {
          if ($l.TrimStart().StartsWith('# psp-op/', [System.StringComparison]::Ordinal)) { $ind++ }
          continue
        }
        $cand++
        if ($l.Length -gt 1411) { $over++; continue }
        if (-not ($l -cmatch '^# psp-op/1 (kind=[a-z]{1,16}(?: [A-Za-z]{1,24}=[A-Za-z0-9_.,:-]{1,1400})*)\z')) { $mal++; continue }
        $body = $Matches[1]
        $tok = $body.Split([char]32)
        $kind = $tok[0].Substring(5)
        if ($kind -ceq 'error') { if ($tok.Count -eq 1) { $err++ } else { $mal++ }; continue }
        if (-not $schema.ContainsKey($kind)) { $mal++; continue }
        $fields = $schema[$kind].Split([char]32)
        $bad = ($tok.Count -ne ($fields.Count + 1))
        for ($i = 0; (-not $bad) -and ($i -lt $fields.Count); $i++) {
          $f = $fields[$i].Split([char]58)
          if (-not $tok[$i + 1].StartsWith($f[0] + '=', [System.StringComparison]::Ordinal)) { $bad = $true; continue }
          $v = $tok[$i + 1].Substring($f[0].Length + 1); $cl = $f[1]
          if ($cl -ceq 'cnt') { $bad = ($v -cnotmatch '^[0-9]{1,5}\z') }
          elseif ($cl -ceq 'int') { $bad = ($v -cnotmatch '^(?:none|UNKNOWN|-?[0-9]{1,10})\z') }
          elseif ($cl -ceq 'hist') {
            if ($v -cne 'none') {
              $hs = $v.Split([char]44)
              if ($hs.Count -gt 4) { $bad = $true }
              foreach ($h in $hs) { if ($h -cnotmatch '^-?[0-9]{1,10}:[0-9]{1,5}\z') { $bad = $true } }
            }
          }
          elseif ($cl -ceq 'privs') {
            if ($v -cne 'none') {
              $ps = $v.Split([char]44); $u = @{}
              if ($ps.Count -gt $voc['privs'].Count) { $bad = $true }
              foreach ($p in $ps) { if (($voc['privs'] -cnotcontains $p) -or $u.ContainsKey($p)) { $bad = $true } else { $u[$p] = $true } }
            }
          }
          elseif ($cl -ceq 'ehist') {
            if ($v -cne 'none') {
              $es = $v.Split([char]44); $u = @{}
              if ($es.Count -gt $voc['aclerr'].Count) { $bad = $true }
              foreach ($e in $es) {
                if (-not ($e -cmatch '^([A-Za-z0-9]{1,40}):[0-9]{1,5}\z')) { $bad = $true; continue }
                $en = $Matches[1]
                if (($voc['aclerr'] -cnotcontains $en) -or $u.ContainsKey($en)) { $bad = $true } else { $u[$en] = $true }
              }
            }
          }
          else { $bad = -not ((@('none', 'UNKNOWN') -ccontains $v) -or ($voc[$cl] -ccontains $v)) }
        }
        if ($bad) { $mal++; continue }
        $key = $kind; if ($keyed -ccontains $kind) { $key = $kind + ' ' + $tok[1] }
        if ($seen.ContainsKey($key)) { $dup++; continue }
        $seen[$key] = $true
        $acc++
        if ($out.Count -ge 128) { $clip++; continue }
        $out += ('psp-diag verdict-op ' + $body)
      }
    }
  }
  $head = 'psp-diag verdict-op-summary tap=' + $rs + ' candidates=' + $cand + ' accepted=' + $acc + ' listed=' + $out.Count + ' clipped=' + $clip + ' malformed=' + $mal + ' oversize=' + $over + ' duplicates=' + $dup + ' indented=' + $ind + ' errors=' + $err
  return @($head + ' trust=diagnostic-only') + $out
}

if ($ExportOnly) {
  if (-not $TrustRoot -or -not (Test-PspBoundTrustRoot $TrustRoot)) { Write-Output "export: refusing trust root '$TrustRoot' (not the bound, canonical root of this script)"; exit 1 }
  $trust = Get-PspTrustLayout $TrustRoot
  $bad = @(Get-PspTrustReadback $trust $adminSid | Where-Object { $_.problems.Count -gt 0 } | ForEach-Object { "$($_.path)=$($_.problems -join ',')" })
  if ($bad.Count -gt 0) { Write-Output ('export: refusing, trust readback failed: ' + ($bad -join '; ')); exit 1 }
  exit (Export-PspEvidence $trust)
}

if ($CleanupOnly) {
  # The workflow bootstrap passes the exact bound trust root; this copy must run from inside it.
  if (-not $TrustRoot) { Write-Output 'cleanup: no trust root; nothing was created'; exit 0 }
  if (-not (Test-PspBoundTrustRoot $TrustRoot)) {
    Write-Output "cleanup: refusing trust root $TrustRoot (not the bound name, not canonical, not under RUNNER_TEMP, or not this script's root)"; exit 1
  }
  $trust = Get-PspTrustLayout $TrustRoot
  $bad = @(Get-PspTrustReadback $trust $adminSid | Where-Object { $_.problems.Count -gt 0 } | ForEach-Object { "$($_.path)=$($_.problems -join ',')" })
  if ($bad.Count -gt 0) { Write-Output ('cleanup: refusing, trust readback failed: ' + ($bad -join '; ')); exit 1 }
  $ReceiptsDir = $trust.receipts; $scratch = $trust.scratch
  if (-not (Test-Path -LiteralPath $trust.statePath)) { Write-Output 'cleanup: refusing, trust root has no state file'; exit 1 }
  $c = Invoke-PspCleanup (Get-Content -LiteralPath $trust.statePath -Raw | ConvertFrom-Json)
  try { Write-Host (Format-PspCleanupDiag 'backstop' $c) } catch { Write-Host 'psp-diag cleanup phase=backstop summary=failed' }
  Write-PspJson $c ('cleanup-backstop-' + [guid]::NewGuid().ToString('N') + '.json')
  Write-Output ('cleanup: ok={0} stateProblems={1}' -f $c.ok, ($c.stateProblems -join ','))
  if ($c.ok) { exit 0 } else { exit 1 }
}

# Trusted root BEFORE any account or lower-privileged process; a failure here creates nothing else.
$trust = Initialize-PspTrustRoot -TempLong $tempLong -SourceDir $PSScriptRoot -AdminSid $adminSid -Leaf $env:PSP_TRUST_LEAF
$ReceiptsDir = $trust.receipts; $scratch = $trust.scratch; $StatePath = $trust.statePath
$tempAcl = [Psp1167.Oracle]::Take($tempLong, $null)
$trust.runnerTemp = [ordered]@{ path = $tempLong; sddl = $tempAcl.sddl; sddlError = $tempAcl.sddlError; icacls = (Invoke-PspNative 'icacls-runner-temp' 'icacls.exe' @($tempLong) -AllowFail).output }
$trust.adminSid = $adminSid
$trust.runId = $env:GITHUB_RUN_ID; $trust.runAttempt = $env:GITHUB_RUN_ATTEMPT
Write-PspJson $trust 'trust.json'
# The earlier wrapper-test TAP sits in a RUNNER_TEMP dir with inherited ACLs: captured now, while no fake user exists.
$wrapperTap = Join-Path $env:RUNNER_TEMP 'psp1167-receipts\wrapper-test.tap'
if (Test-Path -LiteralPath $wrapperTap) { Copy-PspCapture $wrapperTap (Join-Path $ReceiptsDir 'wrapper-test.tap') }

$S = @{ }   # shared mutable stage state (reference type: stage scriptblocks mutate it)
$run = [ordered]@{ schema = 'aigentry/1167-psp-run/v1'; task = '1167'; status = 'FAILED'; feasibilityOnly = $true; productAcceptance = $false
  releaseAcceptance = $false; github = [ordered]@{ runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; job = $env:GITHUB_JOB; sha = $env:GITHUB_SHA; ref = $env:GITHUB_REF }
  stages = New-Object System.Collections.ArrayList }
$state = [ordered]@{ schema = 'aigentry/1167-psp-state/v1'; root = $null; users = @(); vdisks = @() }
Save-PspState $state $StatePath

function Invoke-PspStage { param([string]$Name, [scriptblock]$Body, [string[]]$Needs = @())
  $rec = [ordered]@{ name = $Name; status = 'ok'; error = $null; startedUtc = (Get-Date).ToUniversalTime().ToString('o') }
  foreach ($n in $Needs) {
    $dep = @($run.stages | Where-Object { $_.name -eq $n })
    if ($dep.Count -eq 0 -or $dep[0].status -ne 'ok') { $rec.status = 'blocked'; $rec.error = "needs stage $n"; [void]$run.stages.Add($rec); Write-PspJson $run 'run.json'; return }
  }
  try { & $Body } catch { $rec.status = 'failed'; $rec.error = $_.Exception.Message }
  $rec.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
  [void]$run.stages.Add($rec)
  Write-PspJson $run 'run.json'
  Write-Output ("stage {0}: {1} {2}" -f $Name, $rec.status, $rec.error)
}

function Get-PspSha256 { param([string]$Path) (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

$S.launches = New-Object System.Collections.ArrayList
function Invoke-PspChild { param([string]$Who, [string]$Mode, $Request, [string]$Tag, [int]$TimeoutSec = 900)
  $u = $S.users[$Who]; $work = $S.manifest.dirs["work$Who"]
  $reqPath = Join-Path $work "$Tag-request.json"; $recPath = Join-Path $work "$Tag-receipt.json"
  # CreateNew: a name pre-planted in the fake user's outbox (file, link or junction) is refused, never followed.
  $fs = [System.IO.File]::Open($reqPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Request | ConvertTo-Json -Depth 10)); $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
  $extra = $null; if ($Who -eq 'A') { $extra = $S.manifest.dirs.bin }
  $l = Invoke-PspAsUser -UserName $u.name -Password $S.passwords[$Who] -Mode $Mode -Request $reqPath -Receipt $recPath `
    -WorkDir $work -TempDir (Join-Path $work 'tmp') -ScriptPath (Join-Path $S.manifest.dirs.bin 'run-as-user.ps1') -ExtraPath $extra -TimeoutSec $TimeoutSec
  $l.tag = $Tag
  [void]$S.launches.Add($l)
  Write-PspJson $S.launches 'launches.json'
  if (-not $l.launched) { throw "credentialed launch as $Who blocked: $($l.prerequisite) (Win32 $($l.launchError))" }
  if (-not (Test-Path -LiteralPath $recPath)) { throw "child $Tag wrote no receipt (exit $($l.exitCode)) $($l.prerequisite)" }
  # Stable capture into the trusted receipts dir; only the captured copy is parsed.
  Copy-PspCapture $recPath (Join-Path $ReceiptsDir "$Tag.json") 4MB
  $rec = Get-Content -LiteralPath (Join-Path $ReceiptsDir "$Tag.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($l.exitCode -ne 0 -and $Mode -ne 'node-test') { throw "child $Tag exit $($l.exitCode): $($rec.error)" }
  return $rec
}

function Invoke-PspSnapshotStage { param([string]$Tag, [string[]]$Extra = @())
  $paths = @($S.manifest.snapshotObjects) + @($S.manifest.cases | Where-Object { $_.snapshot -and $_.path } | ForEach-Object { $_.path }) + @($S.manifest.trustObjects) + @($S.manifest.binObjects) + $Extra
  $snap = Get-PspSnapshot -Paths @($paths | Select-Object -Unique) -AncestorFloor $S.manifest.root -WithFsutil
  Write-PspJson ([ordered]@{ tag = $Tag; takenUtc = (Get-Date).ToUniversalTime().ToString('o'); objects = $snap }) "snap-$Tag.json"
}

$exitCode = 1
try {
  Invoke-PspStage 'environment' {
    $envr = [ordered]@{ os = [System.Environment]::OSVersion.VersionString; is64 = [System.Environment]::Is64BitOperatingSystem; psVersion = $PSVersionTable.PSVersion.ToString() }
    $svc = Get-Service -Name seclogon -ErrorAction SilentlyContinue
    $envr.seclogon = if ($svc) { [ordered]@{ status = $svc.Status.ToString(); startType = $svc.StartType.ToString() } } else { 'absent' }
    $drive = $env:RUNNER_TEMP.Substring(0, 2)
    $envr.eightDotThree = (Invoke-PspNative 'fsutil-8dot3' 'fsutil.exe' @('8dot3name', 'query', $drive) -AllowFail)
    $cfg = Join-Path $scratch 'user-rights.inf'
    $se = Invoke-PspNative 'secedit-export' 'secedit.exe' @('/export', '/areas', 'USER_RIGHTS', '/cfg', $cfg) -AllowFail
    $rights = [ordered]@{ exit = $se.code }
    if (Test-Path -LiteralPath $cfg) {
      foreach ($line in Get-Content -LiteralPath $cfg) {
        if ($line -match '^(Se(Backup|Restore|TakeOwnership|Debug|Impersonate)Privilege|SeInteractiveLogonRight|SeDenyInteractiveLogonRight|SeBatchLogonRight)\s*=\s*(.*)$') { $rights[$Matches[1]] = $Matches[3].Trim() }
      }
    }
    $envr.userRightsHolders = $rights
    $probe = Join-Path $scratch 'default-owner-probe.bin'
    [System.IO.File]::WriteAllBytes($probe, [byte[]](0))
    $envr.elevatedDefaultOwnerSddl = ([Psp1167.Oracle]::Take($probe, $null)).sddl
    $wp = Invoke-PspNative 'whoami-admin-priv' 'whoami.exe' @('/priv', '/fo', 'csv', '/nh') -AllowFail
    $envr.adminWhoamiPriv = $wp.output
    $node = $nodeSrc
    $envr.node = [ordered]@{ path = $node; sha256 = (Get-PspSha256 $node); version = (& $node --version); O_NOFOLLOW_admin = (& $node -p "String(require('fs').constants.O_NOFOLLOW)")
      pinnedSha256 = $env:PSP_NODE_EXE_SHA256; pinnedVersion = "v$env:PSP_NODE_VERSION" }
    # In-script pin: the elevated runtime is the same approved build the workflow pin step checked.
    if (($envr.node.pinnedSha256 -cnotmatch '^[0-9a-f]{64}$') -or ($envr.node.sha256 -cne $envr.node.pinnedSha256) -or ($envr.node.version -cne $envr.node.pinnedVersion)) {
      throw "runner node $($envr.node.sha256) $($envr.node.version) != pin $($envr.node.pinnedSha256) $($envr.node.pinnedVersion)"
    }
    $envr.adminSid = $adminSid
    # Every later elevated or fake-user node run uses this trusted copy, never the tool-cache file.
    $S.nodeTrusted = Join-Path $trust.src 'node.exe'
    Copy-Item -LiteralPath $node -Destination $S.nodeTrusted
    if ((Get-PspSha256 $S.nodeTrusted) -ne $envr.node.sha256) { throw 'trusted node.exe copy differs from the runner node' }
    $envr.helper = [ordered]@{ path = $HelperPath; expectedSha256 = $HelperSha256; present = $false; sha256 = $null; matches = $false }
    if ($HelperPath -and (Test-Path -LiteralPath $HelperPath)) {
      $envr.helper.present = $true; $envr.helper.sha256 = Get-PspSha256 $HelperPath
      $envr.helper.matches = ($HelperSha256 -and ($envr.helper.sha256 -eq $HelperSha256.ToLowerInvariant()))
    }
    $envr.wrapper = [ordered]@{ path = $WrapperPath; expectedSha256 = $WrapperSha256; present = $false; sha256 = $null; matches = $false }
    if ($WrapperPath -and (Test-Path -LiteralPath $WrapperPath)) {
      $envr.wrapper.present = $true; $envr.wrapper.sha256 = Get-PspSha256 $WrapperPath
      $envr.wrapper.matches = ($WrapperSha256 -and ($envr.wrapper.sha256 -eq $WrapperSha256.ToLowerInvariant()))
    }
    $envr.harness = [ordered]@{}
    foreach ($f in @('acl.test.mjs', 'setup-fixtures.ps1', 'run-as-user.ps1', 'run-validation.ps1')) { $envr.harness[$f] = Get-PspSha256 (Join-Path $PSScriptRoot $f) }
    $S.env = $envr
    Write-PspJson $envr 'env.json'
  }

  Invoke-PspStage 'fake-users' {
    $b = New-Object byte[] 3; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
    $suffix = ([BitConverter]::ToString($b) -replace '-', '').ToLowerInvariant()
    $S.passwords = @{ A = (New-PspPassword); B = (New-PspPassword) }
    $S.users = @{ }
    $S.users['A'] = New-PspFakeUser -Name "pspa$suffix" -Password $S.passwords.A -State $state -StatePath $StatePath
    $S.users['B'] = New-PspFakeUser -Name "pspb$suffix" -Password $S.passwords.B -State $state -StatePath $StatePath
    Write-PspJson ([ordered]@{ A = $S.users.A; B = $S.users.B }) 'users.json'
  } -Needs @('environment')

  Invoke-PspStage 'fixtures' {
    $b = New-Object byte[] 4; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($b); $rng.Dispose()
    $root = Join-Path $tempLong ('psp1167-' + $env:GITHUB_RUN_ID + '-' + ([BitConverter]::ToString($b) -replace '-', '').ToLowerInvariant())
    if (Test-Path -LiteralPath $root) { throw "refusing: fixture root $root already exists" }
    Register-PspOwnedRoot $root
    $state.root = $root; Save-PspState $state $StatePath
    [void](New-Item -ItemType Directory -Path $root)
    $m = New-PspFixtures -Root $root -SidA $S.users.A.sid -SidB $S.users.B.sid -State $state -StatePath $StatePath -ScratchDir $scratch -Trust $trust
    Add-PspVhdFixtures -Manifest $m -State $state -StatePath $StatePath -ScratchDir $scratch -SidA $S.users.A.sid
    $m.users = [ordered]@{ A = $S.users.A; B = $S.users.B }
    $bin = $m.dirs.bin
    Copy-Item -LiteralPath $S.nodeTrusted -Destination (Join-Path $bin 'node.exe')
    if ((Get-PspSha256 (Join-Path $bin 'node.exe')) -ne $S.env.node.sha256) { throw 'copied node.exe hash differs from the pinned runner node' }
    foreach ($f in @('acl.test.mjs', 'run-as-user.ps1')) {
      Copy-Item -LiteralPath (Join-Path $trust.src $f) -Destination (Join-Path $bin $f)
      if ((Get-PspSha256 (Join-Path $bin $f)) -ne $trust.srcSha256[$f]) { throw "bin copy of $f differs from the trusted source" }
    }
    $m.helperInBin = $null
    $m.wrapperInBin = $null
    if ($S.env.helper.present -and $S.env.helper.matches -and $S.env.wrapper.present -and $S.env.wrapper.matches) {
      $m.helperInBin = Join-Path $bin (Split-Path -Leaf $HelperPath)
      Copy-Item -LiteralPath $HelperPath -Destination $m.helperInBin
      $m.wrapperInBin = Join-Path $bin 'private-storage.mjs'
      Copy-Item -LiteralPath $WrapperPath -Destination $m.wrapperInBin
    }
    # Trusted objects the oracle snapshots S0..S3: A/B must never be able to alter them (verdict trustProblems).
    $m.trust = [ordered]@{ root = $trust.root; statePath = $trust.statePath; adminSid = $adminSid }
    $m.trustObjects = @(Get-PspTrustObjects $trust)
    $m.binObjects = @($bin) + @(@('node.exe', 'acl.test.mjs', 'run-as-user.ps1', 'manifest.json') | ForEach-Object { Join-Path $bin $_ }) + @(@($m.helperInBin, $m.wrapperInBin) | Where-Object { $_ })
    $S.manifest = $m
    ($m | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath (Join-Path $bin 'manifest.json') -Encoding UTF8
    Write-PspJson $m 'manifest.json'
    Write-PspJson $script:PspLog 'setup-log.json'
    if (@($m.unavailable).Count -gt 0) { throw ('essential fixture unavailable (HOLD, not skipped): ' + (@($m.unavailable) -join '; ')) }
  } -Needs @('fake-users')

  # Snapshots run even when 'fixtures' recorded unavailable fixtures, as long as a manifest exists.
  if ($S.ContainsKey('manifest')) {
    Invoke-PspStage 'snapshot-S0' { Invoke-PspSnapshotStage 'S0' }
    Invoke-PspStage 'identity-A' { [void](Invoke-PspChild 'A' 'identity' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workA 'tmp'); node = (Join-Path $S.manifest.dirs.bin 'node.exe') }) 'identity-A') } -Needs @('snapshot-S0')
    Invoke-PspStage 'identity-B' { [void](Invoke-PspChild 'B' 'identity' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workB 'tmp'); node = (Join-Path $S.manifest.dirs.bin 'node.exe') }) 'identity-B') } -Needs @('snapshot-S0')
    Invoke-PspStage 'controls-A' { [void](Invoke-PspChild 'A' 'probe' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workA 'tmp'); ops = @($S.manifest.probes.Actl) }) 'probe-Actl') } -Needs @('identity-A')
    Invoke-PspStage 'move-measure-A' { [void](Invoke-PspChild 'A' 'move-measure' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workA 'tmp'); srcDir = $S.manifest.moveMeasure.srcDir; dstDir = $S.manifest.moveMeasure.dstDir }) 'move-measure') } -Needs @('identity-A')
    Invoke-PspStage 'trust-probe-A' { [void](Invoke-PspChild 'A' 'probe' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workA 'tmp'); ops = @($S.manifest.probes.Atrust) }) 'probe-Atrust') } -Needs @('identity-A')
    Invoke-PspStage 'trust-probe-B' { [void](Invoke-PspChild 'B' 'probe' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workB 'tmp'); ops = @($S.manifest.probes.Btrust) }) 'probe-Btrust') } -Needs @('identity-B')
    Invoke-PspStage 'probe-B1' { [void](Invoke-PspChild 'B' 'probe' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workB 'tmp'); ops = @($S.manifest.probes.B1self) + @($S.manifest.probes.B1) }) 'probe-B1') } -Needs @('identity-B')
    Invoke-PspStage 'snapshot-S1' { Invoke-PspSnapshotStage 'S1' }
    Invoke-PspStage 'helper-as-A' {
      if (-not $S.manifest.helperInBin) { throw 'helper/wrapper not supplied or sha256 mismatch: helper phase not executed (blocker, not a pass)' }
      $wa = $S.manifest.dirs.workA
      $rq = [ordered]@{ tempDir = (Join-Path $wa 'tmp'); node = (Join-Path $S.manifest.dirs.bin 'node.exe'); testFile = (Join-Path $S.manifest.dirs.bin 'acl.test.mjs')
        tapFile = (Join-Path $wa 'helper.tap'); stderrFile = (Join-Path $wa 'helper.stderr.txt')
        env = [ordered]@{ PSP_PHASE = 'helper'; PSP_MANIFEST = (Join-Path $S.manifest.dirs.bin 'manifest.json'); PSP_HELPER_PATH = $S.manifest.helperInBin
          PSP_HELPER_SHA256 = $HelperSha256.ToLowerInvariant(); PSP_WRAPPER_PATH = $S.manifest.wrapperInBin
          PSP_WRAPPER_SHA256 = $WrapperSha256.ToLowerInvariant(); PSP_HELPER_RECEIPT = (Join-Path $wa 'helper-receipt.json') } }
      $rec = $null
      try { $rec = Invoke-PspChild 'A' 'node-test' $rq 'helper-run' -TimeoutSec 1200 }
      finally {
        foreach ($f in @('helper.tap', 'helper.stderr.txt', 'helper-receipt.json')) { $p = Join-Path $wa $f; if (Test-Path -LiteralPath $p) { Copy-PspCapture $p (Join-Path $ReceiptsDir $f) } }
      }
      if (-not (Test-Path -LiteralPath (Join-Path $ReceiptsDir 'helper-receipt.json'))) { throw "helper phase wrote no receipt (node exit $($rec.nodeExit))" }
      # A non-zero helper-phase TAP is reported by the verdict from the receipt; it is not masked here.
    } -Needs @('identity-A', 'snapshot-S1')
    Invoke-PspStage 'snapshot-S2' { Invoke-PspSnapshotStage 'S2' (@($S.manifest.mustStayAbsent) + @($S.manifest.measuredOnly) + @($S.manifest.cases | Where-Object { $_.phase -eq 'create' -and $_.object } | ForEach-Object { $_.object })) }
    Invoke-PspStage 'probe-B2' { [void](Invoke-PspChild 'B' 'probe' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workB 'tmp'); ops = @($S.manifest.probes.B2self) + @($S.manifest.probes.B2) }) 'probe-B2') } -Needs @('identity-B', 'helper-as-A')
    Invoke-PspStage 'snapshot-S3' { Invoke-PspSnapshotStage 'S3' (@($S.manifest.mustStayAbsent) + @($S.manifest.cases | Where-Object { $_.phase -eq 'create' -and $_.object } | ForEach-Object { $_.object })) }
  }

  Invoke-PspStage 'verdict' {
    Write-PspJson $run 'run.json'
    $vt = Join-Path $ReceiptsDir 'verdict.tap'; $ve = Join-Path $ReceiptsDir 'verdict.stderr.txt'
    Copy-Item -LiteralPath $StatePath -Destination (Join-Path $ReceiptsDir 'state.json') -Force
    # Elevated verdict runs only trusted copies, re-hashed immediately before use.
    $vtest = Join-Path $trust.src 'acl.test.mjs'
    if ((Get-PspSha256 $vtest) -ne $trust.srcSha256['acl.test.mjs'] -or (Get-PspSha256 $S.nodeTrusted) -ne $S.env.node.sha256) { throw 'trusted verdict runtime changed' }
    $env:PSP_PHASE = 'verdict'; $env:PSP_RECEIPTS_DIR = $ReceiptsDir; $env:PSP_RUN_ID = $env:GITHUB_RUN_ID; $env:PSP_TEMP_LONG = $tempLong
    $np = Start-Process -FilePath $S.nodeTrusted -ArgumentList @('--test', '--test-reporter=tap', $vtest) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $vt -RedirectStandardError $ve
    $S.verdictExit = $np.ExitCode
    Write-PspVerdictDiag $vt $np.ExitCode
    if ($np.ExitCode -ne 0) { throw "verdict failed (node exit $($np.ExitCode)); see verdict.tap" }
  }
} finally {
  $c = $null
  try { $c = Invoke-PspCleanup $state } catch { $c = [ordered]@{ ok = $false; error = $_.Exception.Message } }
  try { Write-Host (Format-PspCleanupDiag 'in-run' $c) } catch { Write-Host 'psp-diag cleanup phase=in-run summary=failed' }
  Write-PspJson $c 'cleanup.json'
  [void]$run.stages.Add([ordered]@{ name = 'cleanup'; status = $(if ($c.ok) { 'ok' } else { 'failed' }); error = $null })

  # Leak guard: no generated password may appear in any preserved receipt (UTF-8 or UTF-16 scan).
  $leak = $false
  if ($S.ContainsKey('passwords')) {
    foreach ($k in @('A', 'B')) {
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($S.passwords[$k])
      try {
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        foreach ($f in Get-ChildItem -LiteralPath $ReceiptsDir -Recurse -File) {
          $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
          $hit = ([System.Text.Encoding]::UTF8.GetString($bytes).Contains($plain)) -or ([System.Text.Encoding]::Unicode.GetString($bytes).Contains($plain))
          if ($hit) { $leak = $true; [System.IO.File]::WriteAllText($f.FullName, '[REDACTED by psp1167 leak guard]') }
        }
        $plain = $null
      } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
      $S.passwords[$k].Dispose()
    }
  }
  [void]$run.stages.Add([ordered]@{ name = 'leak-guard'; status = $(if ($leak) { 'failed' } else { 'ok' }); error = $(if ($leak) { 'password material found and redacted' } else { $null }) })
  $allOk = (@($run.stages | Where-Object { $_.status -ne 'ok' }).Count -eq 0)
  $run.status = $(if ($allOk) { 'FEASIBILITY_RECEIPTS_PASSED' } else { 'FAILED' })
  Write-PspJson $run 'run.json'
  if ($allOk) { $exitCode = 0 } else { $exitCode = 1 }
}
Write-Output "run status: $($run.status)"
exit $exitCode
