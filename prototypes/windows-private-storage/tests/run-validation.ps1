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
  [string]$ReceiptsDir = $(if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP 'psp1167-receipts' } else { $null }),
  [string]$StatePath = $(if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP 'psp1167-state.json' } else { $null }),
  [switch]$CleanupOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) {
  Write-Output 'refusing: run-validation.ps1 runs only on a disposable GitHub-hosted runner (GITHUB_ACTIONS, RUNNER_ENVIRONMENT=github-hosted, RUNNER_TEMP)'
  exit 3
}
$admin = (New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Output 'refusing: setup/cleanup needs the elevated runner token'; exit 3 }

. (Join-Path $PSScriptRoot 'setup-fixtures.ps1')
. (Join-Path $PSScriptRoot 'run-as-user.ps1')

[void](New-Item -ItemType Directory -Force -Path $ReceiptsDir)
$scratch = Join-Path $ReceiptsDir 'scratch'
[void](New-Item -ItemType Directory -Force -Path $scratch)

function Write-PspJson { param($Obj, [string]$Name) ($Obj | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath (Join-Path $ReceiptsDir $Name) -Encoding UTF8 }

function Invoke-PspCleanup { param($State)
  $c = [ordered]@{ vdisks = $null; root = $null; users = $null }
  $c.vdisks = @(Remove-PspVhds -State $State -ScratchDir $scratch)
  if ($State.root) { $c.root = Remove-PspFixtureRoot -Root $State.root }
  $c.users = @(Remove-PspFakeUsers -State $State)
  $c.ok = (@($c.vdisks | Where-Object { $_.error }).Count -eq 0) -and (($null -eq $c.root) -or $c.root.removed) -and (@($c.users | Where-Object { $_.error -and $_.error -ne 'not-present' }).Count -eq 0)
  return $c
}

if ($CleanupOnly) {
  if (-not (Test-Path -LiteralPath $StatePath)) { Write-Output 'cleanup: no state file; nothing was created'; exit 0 }
  $st = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  $st = [ordered]@{ root = $st.root; users = @($st.users); vdisks = @($st.vdisks) }
  if ($st.root) { Register-PspOwnedRoot $st.root }
  $c = Invoke-PspCleanup $st
  Write-PspJson $c 'cleanup-backstop.json'
  if ($c.ok) { exit 0 } else { exit 1 }
}

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
  ($Request | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $reqPath -Encoding UTF8
  $extra = $null; if ($Who -eq 'A') { $extra = $S.manifest.dirs.bin }
  $l = Invoke-PspAsUser -UserName $u.name -Password $S.passwords[$Who] -Mode $Mode -Request $reqPath -Receipt $recPath `
    -WorkDir $work -TempDir (Join-Path $work 'tmp') -ScriptPath (Join-Path $S.manifest.dirs.bin 'run-as-user.ps1') -ExtraPath $extra -TimeoutSec $TimeoutSec
  $l.tag = $Tag
  [void]$S.launches.Add($l)
  Write-PspJson $S.launches 'launches.json'
  if (-not $l.launched) { throw "credentialed launch as $Who blocked: $($l.prerequisite) (Win32 $($l.launchError))" }
  if (-not (Test-Path -LiteralPath $recPath)) { throw "child $Tag wrote no receipt (exit $($l.exitCode)) $($l.prerequisite)" }
  Copy-Item -LiteralPath $recPath -Destination (Join-Path $ReceiptsDir "$Tag.json") -Force
  $rec = Get-Content -LiteralPath $recPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($l.exitCode -ne 0 -and $Mode -ne 'node-test') { throw "child $Tag exit $($l.exitCode): $($rec.error)" }
  return $rec
}

function Invoke-PspSnapshotStage { param([string]$Tag, [string[]]$Extra = @())
  $paths = @($S.manifest.snapshotObjects) + @($S.manifest.cases | Where-Object { $_.snapshot -and $_.path } | ForEach-Object { $_.path }) + $Extra
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
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $envr.node = [ordered]@{ path = $node; sha256 = (Get-PspSha256 $node); version = (& $node --version); O_NOFOLLOW_admin = (& $node -p "String(require('fs').constants.O_NOFOLLOW)") }
    $S.nodeSrc = $node
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
    $tempLong = [Psp1167.Oracle]::LongPath([System.IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\'))
    if (-not $tempLong) { throw 'cannot resolve the long form of RUNNER_TEMP' }
    $root = Join-Path $tempLong ('psp1167-' + $env:GITHUB_RUN_ID + '-' + ([BitConverter]::ToString($b) -replace '-', '').ToLowerInvariant())
    if (Test-Path -LiteralPath $root) { throw "refusing: fixture root $root already exists" }
    Register-PspOwnedRoot $root
    $state.root = $root; Save-PspState $state $StatePath
    [void](New-Item -ItemType Directory -Path $root)
    $m = New-PspFixtures -Root $root -SidA $S.users.A.sid -SidB $S.users.B.sid -State $state -StatePath $StatePath -ScratchDir $scratch
    Add-PspVhdFixtures -Manifest $m -State $state -StatePath $StatePath -ScratchDir $scratch -SidA $S.users.A.sid
    $m.users = [ordered]@{ A = $S.users.A; B = $S.users.B }
    $bin = $m.dirs.bin
    Copy-Item -LiteralPath $S.nodeSrc -Destination (Join-Path $bin 'node.exe')
    if ((Get-PspSha256 (Join-Path $bin 'node.exe')) -ne $S.env.node.sha256) { throw 'copied node.exe hash differs from the pinned runner node' }
    foreach ($f in @('acl.test.mjs', 'run-as-user.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination (Join-Path $bin $f) }
    $m.helperInBin = $null
    $m.wrapperInBin = $null
    if ($S.env.helper.present -and $S.env.helper.matches -and $S.env.wrapper.present -and $S.env.wrapper.matches) {
      $m.helperInBin = Join-Path $bin (Split-Path -Leaf $HelperPath)
      Copy-Item -LiteralPath $HelperPath -Destination $m.helperInBin
      $m.wrapperInBin = Join-Path $bin 'private-storage.mjs'
      Copy-Item -LiteralPath $WrapperPath -Destination $m.wrapperInBin
    }
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
    Invoke-PspStage 'probe-B1' { [void](Invoke-PspChild 'B' 'probe' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workB 'tmp'); ops = @($S.manifest.probes.Bself) + @($S.manifest.probes.B1) }) 'probe-B1') } -Needs @('identity-B')
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
        foreach ($f in @('helper.tap', 'helper.stderr.txt', 'helper-receipt.json')) { $p = Join-Path $wa $f; if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $ReceiptsDir $f) -Force } }
      }
      if (-not (Test-Path -LiteralPath (Join-Path $ReceiptsDir 'helper-receipt.json'))) { throw "helper phase wrote no receipt (node exit $($rec.nodeExit))" }
      # A non-zero helper-phase TAP is reported by the verdict from the receipt; it is not masked here.
    } -Needs @('identity-A', 'snapshot-S1')
    Invoke-PspStage 'snapshot-S2' { Invoke-PspSnapshotStage 'S2' (@($S.manifest.mustStayAbsent) + @($S.manifest.measuredOnly) + @($S.manifest.cases | Where-Object { $_.phase -eq 'create' -and $_.object } | ForEach-Object { $_.object })) }
    Invoke-PspStage 'probe-B2' { [void](Invoke-PspChild 'B' 'probe' ([ordered]@{ tempDir = (Join-Path $S.manifest.dirs.workB 'tmp'); ops = @($S.manifest.probes.B2) }) 'probe-B2') } -Needs @('identity-B', 'helper-as-A')
    Invoke-PspStage 'snapshot-S3' { Invoke-PspSnapshotStage 'S3' (@($S.manifest.mustStayAbsent) + @($S.manifest.cases | Where-Object { $_.phase -eq 'create' -and $_.object } | ForEach-Object { $_.object })) }
  }

  Invoke-PspStage 'verdict' {
    Write-PspJson $run 'run.json'
    $vt = Join-Path $ReceiptsDir 'verdict.tap'; $ve = Join-Path $ReceiptsDir 'verdict.stderr.txt'
    $env:PSP_PHASE = 'verdict'; $env:PSP_RECEIPTS_DIR = $ReceiptsDir
    $np = Start-Process -FilePath $S.nodeSrc -ArgumentList @('--test', '--test-reporter=tap', (Join-Path $PSScriptRoot 'acl.test.mjs')) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $vt -RedirectStandardError $ve
    $S.verdictExit = $np.ExitCode
    if ($np.ExitCode -ne 0) { throw "verdict failed (node exit $($np.ExitCode)); see verdict.tap" }
  }
} finally {
  $c = $null
  try { $c = Invoke-PspCleanup $state } catch { $c = [ordered]@{ ok = $false; error = $_.Exception.Message } }
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
