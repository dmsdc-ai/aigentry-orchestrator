#Requires -Version 5.1
# live-process-shape.probe.ps1 - tester-owned DIAGNOSTIC probe (#1167, ANALYSIS-rev2 section 4). Not a fix, not acceptance.
# - Binds setup-fixtures.ps1 by sha256, parses it with the PowerShell AST and takes the single top-level
#   FunctionDefinitionAst Get-PspLiveSidProcesses (lines 684-692, pinned Extent.Text sha256, only the commands
#   Get-CimInstance and Invoke-CimMethod). Only that Extent.Text is evaluated, UNMODIFIED; the file is never dot-sourced.
# - The caller forms below are checked verbatim against run-validation.ps1:75-76 and setup-fixtures.ps1:708-709.
# - Get-CimInstance / Invoke-CimMethod are script-scope mock functions over fake objects (numeric PIDs, mock.exe,
#   synthetic SIDs). Binding is proven via Get-Command (CommandType Function) and fake call counters, and module
#   autoloading is off, before the frozen function runs. No host process, WMI, account, ACL or file-system state is read
#   or changed apart from the two pinned sources and the bounded JSON written to -OutPath.
# - Records the observed return shape per case and caller form (R-A nested / R-B flat / UNKNOWN). Exit 0 = the full
#   matrix executed with every guard intact, WHATEVER the shape; exit 1 = guard failure or incomplete matrix.
param(
  [string]$SourcePath = (Join-Path $PSScriptRoot 'setup-fixtures.ps1'),
  [string]$CallerPath = (Join-Path $PSScriptRoot 'run-validation.ps1'),
  [string]$OutPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0   # as run-validation.ps1:19, the scope both real callers run under

$ExpectedSourceSha256 = '002c2f8f4faeb0439737f0e73c926c2be266078eb28edbfed1436ff841c68de2'
$ExpectedCallerSha256 = 'b0de2104769f04809ad4df8cee0b802556bc48092000ef53528f383f1f0c09ee'
$ExpectedExtentSha256 = 'b460bab2746846988518ade81b10f3760668a9ccb18d15add29cb936c26de332'
$FunctionName = 'Get-PspLiveSidProcesses'
$ExpectedStartLine = 684
$ExpectedEndLine = 692
$MockNames = @('Get-CimInstance', 'Invoke-CimMethod')
$MaxJsonChars = 65536

$Report = [ordered]@{
  schema = 'aigentry/1167-psp-shape/v1'; task = '1167'; diagnosticOnly = $true; productAcceptance = $false
  status = 'FAILED'; failure = $null; environment = $null; source = $null; binding = $null; cases = @(); outcome = $null
}

function Limit([string]$Text, [int]$Max = 300) { if ($Text.Length -gt $Max) { $Text.Substring(0, $Max) + '...' } else { $Text } }
function Save-Report {
  $json = $Report | ConvertTo-Json -Depth 8
  if ($json.Length -gt $MaxJsonChars) {
    $Report.status = 'FAILED'
    $json = [ordered]@{ schema = $Report.schema; task = '1167'; diagnosticOnly = $true; productAcceptance = $false; status = 'FAILED'; failure = "report exceeded $MaxJsonChars chars" } | ConvertTo-Json
  }
  if ($OutPath) { [System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding($false))) }
  $json
}
function Fatal([string]$Message) {
  $Report.status = 'FAILED'; $Report.failure = Limit $Message
  Write-Host (Save-Report)
  Write-Host "FATAL $Message"
  exit 1
}
function Get-Sha256Hex([byte[]]$Bytes) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { -join ($h.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}
function Read-PinnedLf([string]$Path, [string]$Sha) {
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not [System.IO.File]::Exists($full)) { Fatal "source not found: $Path" }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $actual = Get-Sha256Hex $bytes
  if ($actual -cne $Sha) { Fatal "$([System.IO.Path]::GetFileName($full)) sha256 $actual does not match pin $Sha" }
  $text = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($bytes)
  if ($text.Contains("`r")) { Fatal "$([System.IO.Path]::GetFileName($full)) contains CR bytes (expected LF checkout)" }
  [pscustomobject]@{ Full = $full; Sha = $actual; Lines = $text.Split([char]10) }
}

try {
  # ---- 0. environment: Windows PowerShell 5.1 Desktop only; no profile-provided command can shadow anything ----
  Import-Module -Name Microsoft.PowerShell.Utility, Microsoft.PowerShell.Management -ErrorAction Stop
  $PSModuleAutoLoadingPreference = 'None'
  $psv = $PSVersionTable.PSVersion
  $Report.environment = [ordered]@{
    psVersion = $psv.ToString(); psEdition = [string]$PSVersionTable.PSEdition; clrVersion = [string]$PSVersionTable.CLRVersion
    buildVersion = [string]$PSVersionTable.BuildVersion; os = [System.Environment]::OSVersion.VersionString
    is64BitProcess = [System.Environment]::Is64BitProcess; languageMode = [string]$ExecutionContext.SessionState.LanguageMode
    strictMode = '2.0'; moduleAutoLoading = [string]$PSModuleAutoLoadingPreference; cimCmdletsLoaded = [bool](Get-Module -Name CimCmdlets)
  }
  Write-Host ('env psVersion={0} edition={1} clr={2} os={3}' -f $Report.environment.psVersion, $Report.environment.psEdition, $Report.environment.clrVersion, $Report.environment.os)
  if (($psv.Major -ne 5) -or ($psv.Minor -ne 1) -or ($Report.environment.psEdition -cne 'Desktop')) { Fatal "not Windows PowerShell 5.1 Desktop: $($psv) $($Report.environment.psEdition)" }
  if ($Report.environment.cimCmdletsLoaded) { Fatal 'CimCmdlets is already loaded: real CIM cmdlets could be reachable (binding uncertain)' }

  # ---- 1. source binding: pinned files, exact caller lines, single top-level FunctionDefinitionAst at 684-692 ----
  $src = Read-PinnedLf $SourcePath $ExpectedSourceSha256
  $caller = Read-PinnedLf $CallerPath $ExpectedCallerSha256
  $CallerChecks = @(
    @($caller, 75, '$x.liveWriters = @(Get-PspLiveSidProcesses $sids)', 'Invoke-ExportForm'),
    @($caller, 76, 'if ($x.liveWriters.Count -gt 0) { $x.problems += ''fake-user processes alive'' }', 'Invoke-ExportForm'),
    @($src, 708, '$r.liveWriters = @(Get-PspLiveSidProcesses $WriterSids)', 'Invoke-CleanupForm'),
    @($src, 709, 'if ($r.liveWriters.Count -gt 0) { throw (''refusing: fake-user processes still alive: '' + ($r.liveWriters -join '', '')) }', 'Invoke-CleanupForm')
  )
  $tokens = $null; $parseErrors = $null
  $root = [System.Management.Automation.Language.Parser]::ParseFile($src.Full, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -ne 0) { Fatal ('setup-fixtures.ps1 parse errors: ' + (($parseErrors | ForEach-Object { $_.Message }) -join '; ')) }
  $named = @($root.FindAll({ param($a) ($a -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($a.Name -ceq $FunctionName) }, $true))
  if ($named.Count -ne 1) { Fatal "$FunctionName FunctionDefinitionAst occurs $($named.Count) times, expected 1" }
  $fnAst = $named[0]
  if (($fnAst.Extent.StartLineNumber -ne $ExpectedStartLine) -or ($fnAst.Extent.EndLineNumber -ne $ExpectedEndLine)) { Fatal "$FunctionName extent is lines $($fnAst.Extent.StartLineNumber)-$($fnAst.Extent.EndLineNumber), expected $ExpectedStartLine-$ExpectedEndLine" }
  if (-not (($fnAst.Parent -is [System.Management.Automation.Language.NamedBlockAst]) -and ($fnAst.Parent.Parent -eq $root))) { Fatal "$FunctionName is not a top-level definition" }
  $extentText = $fnAst.Extent.Text
  $extentSha = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($extentText))
  if ($extentSha -cne $ExpectedExtentSha256) { Fatal "$FunctionName Extent.Text sha256 $extentSha != pinned $ExpectedExtentSha256" }
  if ($extentText -cne (($src.Lines[($ExpectedStartLine - 1)..($ExpectedEndLine - 1)]) -join "`n")) { Fatal 'Extent.Text differs from raw source lines 684-692' }
  $cmdAsts = @($fnAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true))
  $cmdNames = @($cmdAsts | ForEach-Object { $_.GetCommandName() })
  foreach ($c in $cmdAsts) { if ($c.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) { Fatal "frozen function uses an invocation operator: $($c.Extent.Text)" } }
  if (($cmdNames.Count -ne 2) -or ($cmdNames[0] -cne $MockNames[0]) -or ($cmdNames[1] -cne $MockNames[1])) { Fatal ('frozen function command surface is not exactly Get-CimInstance, Invoke-CimMethod: ' + ($cmdNames -join ', ')) }
  if (@($fnAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)).Count -ne 0) { Fatal 'frozen function invokes a .NET member' }
  if (@($fnAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)).Count -ne 1) { Fatal 'frozen function contains a nested function definition' }
  $Report.source = [ordered]@{
    setupFixturesSha256 = $src.Sha; runValidationSha256 = $caller.Sha; function = $FunctionName
    lines = "$($fnAst.Extent.StartLineNumber)-$($fnAst.Extent.EndLineNumber)"; extentTextSha256 = $extentSha; extentTextChars = $extentText.Length
    commandSurface = $cmdNames; parseErrors = 0; callerLinesChecked = @($CallerChecks | ForEach-Object { "$([System.IO.Path]::GetFileName($_[0].Full)):$($_[1])" })
  }
  Write-Host "source ok setup-fixtures.ps1 sha256=$($src.Sha) $FunctionName lines=$($Report.source.lines) extentSha256=$extentSha commands=$($cmdNames -join ',')"

  # ---- 2. mocks: script-scope functions shadowing the CIM cmdlets; fake objects only ----
  $script:CimCalls = 0; $script:OwnerCalls = 0; $script:CimClassNames = @(); $script:OwnerMethods = @()
  $script:Procs = @(); $script:Owners = @{}; $script:OwnerThrow = @(); $script:CimThrow = $false
  function Get-CimInstance { [CmdletBinding()] param([string]$ClassName)
    $script:CimCalls++; $script:CimClassNames += $ClassName
    if ($script:CimThrow) { throw 'mock-cim' }
    $script:Procs
  }
  function Invoke-CimMethod { [CmdletBinding()] param($InputObject, [string]$MethodName)
    $script:OwnerCalls++; $script:OwnerMethods += $MethodName
    if ($script:OwnerThrow -contains [int]$InputObject.ProcessId) { throw 'mock-owner' }
    $script:Owners[[int]$InputObject.ProcessId]
  }
  function New-Proc([int]$Id) { [pscustomobject]@{ ProcessId = [uint32]$Id; Name = 'mock.exe' } }
  function New-Owner([uint32]$Rv, [string]$Sid) { [pscustomobject]@{ ReturnValue = $Rv; Sid = $Sid } }

  $bindings = @()
  foreach ($n in $MockNames) {
    $found = @(Get-Command -Name $n -ErrorAction SilentlyContinue)
    $types = @($found | ForEach-Object { [string]$_.CommandType })
    $bindings += ,([ordered]@{ name = $n; resolved = $types })
    if (($found.Count -ne 1) -or ($found[0].CommandType -ne [System.Management.Automation.CommandTypes]::Function) -or ($found[0].ScriptBlock.ToString() -cne (Get-Item -LiteralPath "function:$n").ScriptBlock.ToString())) { Fatal "$n does not resolve solely to the script mock function: $($types -join ',')" }
  }
  # Preflight from a nested function scope (same resolution chain as the frozen function): counters must move.
  function Test-MockBinding {
    $script:CimCalls = 0; $script:OwnerCalls = 0; $script:Procs = @(); $script:CimThrow = $false; $script:Owners = @{}; $script:OwnerThrow = @()
    $p = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $o = Invoke-CimMethod -InputObject (New-Proc 1) -MethodName GetOwnerSid -ErrorAction Stop
    ($script:CimCalls -eq 1) -and ($script:OwnerCalls -eq 1) -and ($p.Count -eq 0) -and ($null -eq $o)
  }
  if (-not (Test-MockBinding)) { Fatal 'mock preflight: fake call counters did not move as expected' }

  # ---- 3. the frozen function: Extent.Text evaluated UNMODIFIED (defines only that function) ----
  Invoke-Expression -Command $extentText
  $fn = @(Get-Command -Name $FunctionName -CommandType Function -ErrorAction SilentlyContinue)
  if (($fn.Count -ne 1) -or ($fn[0].ScriptBlock.Ast.Extent.Text -cne $extentText)) { Fatal "$FunctionName is not bound to the extracted Extent.Text" }
  foreach ($n in $MockNames) { if ((Get-Command -Name $n).CommandType -ne [System.Management.Automation.CommandTypes]::Function) { Fatal "$n binding changed after definition" } }
  $Report.binding = [ordered]@{ mocks = $bindings; preflight = 'ok'; frozenFunction = 'Invoke-Expression of Extent.Text; Get-Command type Function; Ast.Extent.Text equal' }
  Write-Host ('binding ok ' + (($bindings | ForEach-Object { "$($_.name)=$($_.resolved -join '/')" }) -join ' '))

  # ---- 4. caller forms (verbatim lines; scope/EAP as in Export-PspEvidence and Remove-PspFixtureRoot) + contrast ----
  function Invoke-ExportForm { param($sids)
    $ErrorActionPreference = 'Stop'
    $x = [ordered]@{ liveWriters = @(); problems = @() }
    $x.liveWriters = @(Get-PspLiveSidProcesses $sids)
    if ($x.liveWriters.Count -gt 0) { $x.problems += 'fake-user processes alive' }
    return $x
  }
  function Invoke-CleanupForm { param([string[]]$WriterSids = @())
    $ErrorActionPreference = 'Continue'
    $r = [ordered]@{ error = $null; liveWriters = @(); passedGate = $false }
    try {
      $r.liveWriters = @(Get-PspLiveSidProcesses $WriterSids)
      if ($r.liveWriters.Count -gt 0) { throw ('refusing: fake-user processes still alive: ' + ($r.liveWriters -join ', ')) }
      $r.passedGate = $true
    } catch { $r.error = $_.Exception.Message }
    return $r
  }
  function Invoke-ContrastForm { param($sids)
    $ErrorActionPreference = 'Stop'
    $w = [ordered]@{ liveWriters = $null }
    $w.liveWriters = Get-PspLiveSidProcesses $sids
    return $w
  }
  foreach ($chk in $CallerChecks) {
    $srcLine = $chk[0].Lines[$chk[1] - 1].Trim()
    $formLines = @((Get-Item -LiteralPath "function:$($chk[3])").ScriptBlock.ToString().Split([char]10) | ForEach-Object { $_.Trim() })
    if (($srcLine -cne $chk[2]) -or ($formLines -cnotcontains $srcLine)) { Fatal "caller line $([System.IO.Path]::GetFileName($chk[0].Full)):$($chk[1]) is not used verbatim by $($chk[3])" }
  }

  function Measure-Shape { param($Value)
    $m = [ordered]@{ outerType = 'null'; outerCount = $null; firstType = $null; firstCount = $null; countGtZero = $null; allElementsString = $null; joinLength = $null; shape = 'UNKNOWN' }
    if ($null -eq $Value) { return $m }
    $m.outerType = $Value.GetType().FullName
    if ($Value -is [System.Collections.ICollection]) {
      $m.outerCount = $Value.Count
      $m.countGtZero = ($Value.Count -gt 0)
      if ($Value.Count -ge 1) {
        $f = $Value[0]
        if ($null -eq $f) { $m.firstType = 'null' } else { $m.firstType = $f.GetType().FullName }
        $m.firstCount = @($f).Count
      }
      $all = $true; foreach ($e in $Value) { if (-not ($e -is [string])) { $all = $false } }
      $m.allElementsString = $all
      if (($Value.Count -eq 1) -and ($m.firstType -ceq 'System.Object[]')) { $m.shape = 'R-A-nested' }
      elseif ($all) { $m.shape = 'R-B-flat' }
    }
    $m.joinLength = ($Value -join ', ').Length
    return $m
  }
  function Get-HitPids { param($Value)
    $out = @()
    foreach ($e in @($Value)) { foreach ($s in @($e)) { if (($s -is [string]) -and ($s -match '^(\d+):')) { $out += [int]$Matches[1] } } }
    , $out
  }

  $A = 'S-1-5-21-1-2-3-1001'; $B = 'S-1-5-21-1-2-3-1002'
  $Cases = @(
    [ordered]@{ id = 'a'; label = 'empty Sids'; sids = @(); procs = @(); owners = @{}; ownerThrow = @(); cimThrow = $false; fixtureMatchingOwners = 0 }
    [ordered]@{ id = 'b'; label = '2 Sids, 0 procs'; sids = @($A, $B); procs = @(); owners = @{}; ownerThrow = @(); cimThrow = $false; fixtureMatchingOwners = 0 }
    [ordered]@{ id = 'c'; label = '2 Sids, 3 procs, 0 matching'; sids = @($A, $B); procs = @((New-Proc 101), (New-Proc 102), (New-Proc 103))
      owners = @{ 101 = (New-Owner 0 'S-1-5-21-1-2-3-2001'); 102 = (New-Owner 0 'S-1-5-21-1-2-3-2002'); 103 = (New-Owner 0 'S-1-5-21-1-2-3-2003') }; ownerThrow = @(); cimThrow = $false; fixtureMatchingOwners = 0 }
    [ordered]@{ id = 'd'; label = '1 hit'; sids = @($A, $B); procs = @((New-Proc 201), (New-Proc 202))
      owners = @{ 201 = (New-Owner 0 $A); 202 = (New-Owner 0 'S-1-5-21-1-2-3-2001') }; ownerThrow = @(); cimThrow = $false; fixtureMatchingOwners = 1 }
    [ordered]@{ id = 'e'; label = '2 hits (one per SID)'; sids = @($A, $B); procs = @((New-Proc 301), (New-Proc 302), (New-Proc 303))
      owners = @{ 301 = (New-Owner 0 $A); 302 = (New-Owner 0 $B); 303 = (New-Owner 0 'S-1-5-21-1-2-3-2001') }; ownerThrow = @(); cimThrow = $false; fixtureMatchingOwners = 2 }
    [ordered]@{ id = 'f'; label = 'ReturnValue=2 on a matching SID'; sids = @($A, $B); procs = @((New-Proc 401))
      owners = @{ 401 = (New-Owner 2 $A) }; ownerThrow = @(); cimThrow = $false; fixtureMatchingOwners = 0 }
    [ordered]@{ id = 'g'; label = 'owner query throws for one proc, another hits'; sids = @($A, $B); procs = @((New-Proc 501), (New-Proc 502))
      owners = @{ 502 = (New-Owner 0 $B) }; ownerThrow = @(501); cimThrow = $false; fixtureMatchingOwners = 1 }
    [ordered]@{ id = 'h'; label = 'SID differs only in case'; sids = @($A, $B); procs = @((New-Proc 601))
      owners = @{ 601 = (New-Owner 0 's-1-5-21-1-2-3-1001') }; ownerThrow = @(); cimThrow = $false; fixtureMatchingOwners = 0 }
    [ordered]@{ id = 'i'; label = 'Get-CimInstance throws'; sids = @($A, $B); procs = @((New-Proc 901))
      owners = @{ 901 = (New-Owner 0 $A) }; ownerThrow = @(); cimThrow = $true; fixtureMatchingOwners = 1 }
  )

  $verbatimShapes = @()
  foreach ($case in $Cases) {
    $forms = @()
    foreach ($form in @('export', 'cleanup', 'contrast')) {
      $script:CimCalls = 0; $script:OwnerCalls = 0; $script:CimClassNames = @(); $script:OwnerMethods = @()
      $script:Procs = $case.procs; $script:Owners = $case.owners; $script:OwnerThrow = $case.ownerThrow; $script:CimThrow = $case.cimThrow
      $rec = [ordered]@{ form = $form; escaped = $false; errorKind = $null; errorLength = $null; gateFired = $null; shape = $null; hitPids = @(); cimCalls = 0; ownerCalls = 0 }
      $res = $null
      try {
        switch ($form) {
          'export' { $res = Invoke-ExportForm $case.sids }
          'cleanup' { $res = Invoke-CleanupForm -WriterSids $case.sids }
          'contrast' { $res = Invoke-ContrastForm $case.sids }
        }
      } catch { $rec.escaped = $true; $rec.errorKind = Limit $_.Exception.Message 60; $rec.errorLength = $_.Exception.Message.Length }
      $rec.cimCalls = $script:CimCalls; $rec.ownerCalls = $script:OwnerCalls
      # Mock guards (hard-fail): exactly the fake calls the frozen function's own control flow implies.
      $expCim = 0; $expOwner = 0
      if (@($case.sids).Count -gt 0) { $expCim = 1; if (-not $case.cimThrow) { $expOwner = @($case.procs).Count } }
      if (($script:CimCalls -ne $expCim) -or ($script:OwnerCalls -ne $expOwner)) { Fatal "case $($case.id) $form mock counters cim=$($script:CimCalls)/$expCim owner=$($script:OwnerCalls)/$expOwner (real cmdlet reached or mock bypassed?)" }
      if ((@($script:CimClassNames | Where-Object { $_ -cne 'Win32_Process' }).Count -ne 0) -or (@($script:OwnerMethods | Where-Object { $_ -cne 'GetOwnerSid' }).Count -ne 0)) { Fatal "case $($case.id) $form mock received unexpected class/method" }
      if ($null -ne $res) {
        if (($form -ceq 'cleanup') -and ($null -ne $res.error)) {
          $rec.errorLength = ([string]$res.error).Length
          if (([string]$res.error).StartsWith('refusing: fake-user processes still alive: ', [System.StringComparison]::Ordinal)) { $rec.errorKind = 'gate-refusal' } else { $rec.errorKind = Limit ([string]$res.error) 60 }
        }
        # A non-gate error in the cleanup form leaves liveWriters at its initial @(): not a return-shape measurement.
        if (($null -eq $rec.errorKind) -or ($rec.errorKind -ceq 'gate-refusal')) {
          $rec.shape = Measure-Shape $res.liveWriters
          $rec.hitPids = Get-HitPids $res.liveWriters
          if ($form -ceq 'export') { $rec.gateFired = (@($res.problems) -ccontains 'fake-user processes alive') }
          if ($form -ceq 'cleanup') { $rec.gateFired = ($rec.errorKind -ceq 'gate-refusal') }
          if ($form -cne 'contrast') { $verbatimShapes += $rec.shape.shape }
        }
      } elseif (-not $rec.escaped) { Fatal "case $($case.id) $form produced no result and no error (incomplete matrix)" }
      $s = $rec.shape
      if ($null -eq $s) { Write-Host "case=$($case.id) form=$form escaped=$($rec.escaped) error=$($rec.errorKind) cim=$($rec.cimCalls) owner=$($rec.ownerCalls)" }
      else { Write-Host "case=$($case.id) form=$form outerType=$($s.outerType) outerCount=$($s.outerCount) firstType=$($s.firstType) firstCount=$($s.firstCount) countGtZero=$($s.countGtZero) joinLength=$($s.joinLength) shape=$($s.shape) gateFired=$($rec.gateFired) error=$($rec.errorKind) hitPids=$($rec.hitPids -join ',') cim=$($rec.cimCalls) owner=$($rec.ownerCalls)" }
      $forms += ,$rec
    }
    $Report.cases += ,([ordered]@{ id = $case.id; label = $case.label; sidsCount = @($case.sids).Count; procCount = @($case.procs).Count; ownerThrowPids = $case.ownerThrow; cimThrow = $case.cimThrow; fixtureMatchingOwners = $case.fixtureMatchingOwners; forms = $forms })
  }

  # ---- 5. outcome: observation only, never acceptance ----
  if ($Report.cases.Count -ne $Cases.Count) { Fatal 'matrix incomplete' }
  $distinct = @($verbatimShapes | Sort-Object -Unique)
  $overall = 'MIXED-OR-UNKNOWN'
  if (($distinct.Count -eq 1) -and ($distinct[0] -ceq 'R-A-nested')) { $overall = 'R-A' }
  if (($distinct.Count -eq 1) -and ($distinct[0] -ceq 'R-B-flat')) { $overall = 'R-B' }
  $ci = $Report.cases | Where-Object { $_.id -ceq 'i' }
  $cg = $Report.cases | Where-Object { $_.id -ceq 'g' }
  $Report.outcome = [ordered]@{
    verbatimCallerForms = $overall; verbatimShapesSeen = $distinct; verbatimMeasurements = $verbatimShapes.Count
    cimThrowEscapesExportUnderStop = $ci.forms[0].escaped; cimThrowLandsInCleanupError = ($ci.forms[1].errorKind -ceq 'mock-cim')
    ownerThrowPidInAnyHits = (@($cg.forms | Where-Object { @($_.hitPids) -contains 501 }).Count -gt 0)
    note = 'Diagnostic evidence of PS 5.1 return shape only. Not product, test or gate acceptance; no live-process fact of any real run follows from it.'
  }
  $Report.status = 'COMPLETED'
  Write-Host ("OUTCOME verbatimCallerForms=$overall shapesSeen=$($distinct -join ',') cimThrowEscapesExport=$($Report.outcome.cimThrowEscapesExportUnderStop) cimThrowLandsInCleanupError=$($Report.outcome.cimThrowLandsInCleanupError) ownerThrowPidInAnyHits=$($Report.outcome.ownerThrowPidInAnyHits)")
  Write-Host (Save-Report)
  exit 0
} catch {
  Fatal ("unhandled: " + $_.Exception.Message)
}
