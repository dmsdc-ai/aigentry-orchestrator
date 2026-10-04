#Requires -Version 5.1
# live-process-results.selftest.ps1 - tester-owned self-test (#1167) of the Get-PspLiveSidProcesses result contract.
# - Binds setup-fixtures.ps1 and run-validation.ps1 by sha256, parses setup-fixtures.ps1 with the PowerShell AST and takes
#   the single top-level FunctionDefinitionAst Get-PspLiveSidProcesses (lines 688-703, pinned Extent.Text sha256, only the
#   commands Get-CimInstance and Invoke-CimMethod, only the member call GetType()). Only that Extent.Text is evaluated,
#   UNMODIFIED; the file is never dot-sourced.
# - Negative control: the frozen pre-fix extent (setup-fixtures.ps1 002c2f8f lines 684-692, sha256 b460bab2...) must still
#   show the nested known-empty false positive. It is control evidence only and never counts as a product PASS.
# - Both real caller forms are built from the pinned source lines (run-validation.ps1:75-76, setup-fixtures.ps1:719-720).
# - Get-CimInstance / Invoke-CimMethod are script-scope mock functions over fake objects (numeric PIDs, mock.exe, synthetic
#   SIDs). Binding is proven via Get-Command (CommandType Function) and fake call counters, with module autoloading off,
#   before any function under test runs. No host process, CIM, account, ACL or file-system state is read or changed apart
#   from the two pinned sources and the optional bounded JSON at -OutPath. Mock faults are markers; the receipt records
#   classified message ids only, never raw messages.
# - Exit 0 = full matrix ran, every guard held, the control reproduced the defect and every candidate case passed.
#   Exit 1 otherwise. Not product, release or security acceptance.
param(
  [string]$SourcePath = (Join-Path $PSScriptRoot 'setup-fixtures.ps1'),
  [string]$CallerPath = (Join-Path $PSScriptRoot 'run-validation.ps1'),
  [string]$OutPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0   # as setup-fixtures.ps1:10 / run-validation.ps1:19, the scope both real callers run under

$ExpectedSourceSha256 = 'bb11958d43fa28075addf3386b746431c8aac5766ac65d7b9790e8dce6015231'
$ExpectedCallerSha256 = 'b0de2104769f04809ad4df8cee0b802556bc48092000ef53528f383f1f0c09ee'
$ExpectedExtentSha256 = 'fdf39a2f841d1d32524c2bd7e24b69484f98b060dfb4a99b3cac4ffb2d8f06f0'
$BaselineExtentSha256 = 'b460bab2746846988518ade81b10f3760668a9ccb18d15add29cb936c26de332'
$FunctionName = 'Get-PspLiveSidProcesses'
$ExpectedStartLine = 688
$ExpectedEndLine = 703
$MockNames = @('Get-CimInstance', 'Invoke-CimMethod')
$MaxJsonChars = 65536
$GatePrefix = 'refusing: fake-user processes still alive: '
$Fixed = [ordered]@{
  R_ENUM = 'refusing: process enumeration failed (live writer state unknown)'
  R_OWNER = 'refusing: process owner query failed (live writer state unknown)'
  R_RV = 'refusing: process owner query returned a nonzero or missing ReturnValue (live writer state unknown)'
  R_SID = 'refusing: process owner SID missing or invalid (live writer state unknown)'
}

# Frozen negative control: setup-fixtures.ps1 002c2f8f lines 684-692 byte for byte (LF joined); sha256 checked below.
$BaselineExtent = @(
  'function Get-PspLiveSidProcesses { param([string[]]$Sids = @())'
  '  $hits = @()'
  '  if (@($Sids).Count -eq 0) { return ,$hits }'
  '  foreach ($p in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)) {'
  '    $o = $null; try { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction Stop } catch { $o = $null }'
  '    if ($o -and ($o.ReturnValue -eq 0) -and ($Sids -ccontains $o.Sid)) { $hits += ,("$($p.ProcessId):$($p.Name):$($o.Sid)") }'
  '  }'
  '  return ,$hits'
  '}'
) -join "`n"

$Report = [ordered]@{
  schema = 'aigentry/1167-psp-live-results/v1'; task = '1167'; productAcceptance = $false; negativeControlCountsAsProductPass = $false
  status = 'FAILED'; failure = $null; environment = $null; source = $null; binding = $null
  negativeControl = $null; candidate = $null; postGuards = $null; failures = @()
}

function Limit([string]$Text, [int]$Max = 200) { if ($Text.Length -gt $Max) { $Text.Substring(0, $Max) + '...' } else { $Text } }
function Save-Report {
  $json = $Report | ConvertTo-Json -Depth 8 -Compress
  if ($json.Length -gt $MaxJsonChars) {
    $Report.status = 'FAILED'
    $json = [ordered]@{ schema = $Report.schema; task = '1167'; productAcceptance = $false; status = 'FAILED'; failure = "report exceeded $MaxJsonChars chars" } | ConvertTo-Json
  }
  if ($OutPath) { [System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding($false))) }
  $json
}
function Fatal([string]$Message) {
  $Report.status = 'FAILED'; $Report.failure = Limit $Message 300
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
# Command surface of a function under test: exactly the two CIM commands (no invocation operator), exactly the allowed
# instance member calls with no arguments, and no nested function definition.
function Test-FunctionSurface($FnAst, [string[]]$AllowedMembers, [string]$Label) {
  $cmdAsts = @($FnAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true))
  $cmdNames = @($cmdAsts | ForEach-Object { $_.GetCommandName() })
  foreach ($c in $cmdAsts) { if ($c.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) { Fatal "$Label uses an invocation operator: $($c.Extent.Text)" } }
  if (($cmdNames.Count -ne 2) -or ($cmdNames[0] -cne $MockNames[0]) -or ($cmdNames[1] -cne $MockNames[1])) { Fatal ("$Label command surface is not exactly Get-CimInstance, Invoke-CimMethod: " + ($cmdNames -join ', ')) }
  $members = @($FnAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true))
  if ((@($members | ForEach-Object { $_.Member.Extent.Text }) -join ',') -cne ($AllowedMembers -join ',')) { Fatal "$Label member calls are not exactly: $($AllowedMembers -join ',')" }
  foreach ($m in $members) { if ($m.Static -or (($null -ne $m.Arguments) -and ($m.Arguments.Count -ne 0))) { Fatal "$Label member call is static or has arguments: $($m.Extent.Text)" } }
  if (@($FnAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)).Count -ne 1) { Fatal "$Label contains a nested function definition" }
  $cmdNames
}
function Assert-FunctionBound([string]$Text, [string]$Label) {
  $fn = @(Get-Command -Name $FunctionName -CommandType Function -ErrorAction SilentlyContinue)
  if (($fn.Count -ne 1) -or ($fn[0].ScriptBlock.Ast.Extent.Text -cne $Text)) { Fatal "$FunctionName is not bound to the $Label extent" }
  foreach ($n in $MockNames) {
    $found = @(Get-Command -Name $n -ErrorAction SilentlyContinue)
    if (($found.Count -ne 1) -or ($found[0].CommandType -ne [System.Management.Automation.CommandTypes]::Function)) { Fatal "$n binding changed ($Label)" }
  }
}
function Get-MsgId($Message) {
  if ($null -eq $Message) { return $null }
  $m = [string]$Message
  foreach ($k in $Fixed.Keys) { if ($m -ceq $Fixed[$k]) { return $k } }
  if ($m.StartsWith($GatePrefix, [System.StringComparison]::Ordinal)) { return 'GATE' }
  if ($m.StartsWith('mock-fault:', [System.StringComparison]::Ordinal)) { return 'MOCK-MARKER' }
  return "OTHER(len=$($m.Length))"
}

try {
  # ---- 0. environment: Windows PowerShell 5.1 Desktop only; no profile- or module-provided CIM command ----
  Import-Module -Name Microsoft.PowerShell.Utility, Microsoft.PowerShell.Management -ErrorAction Stop
  $PSModuleAutoLoadingPreference = 'None'
  $psv = $PSVersionTable.PSVersion
  $Report.environment = [ordered]@{
    psVersion = $psv.ToString(); psEdition = [string]$PSVersionTable.PSEdition; clrVersion = [string]$PSVersionTable.CLRVersion
    os = [System.Environment]::OSVersion.VersionString; languageMode = [string]$ExecutionContext.SessionState.LanguageMode
    strictMode = '2.0'; moduleAutoLoading = [string]$PSModuleAutoLoadingPreference; cimCmdletsLoaded = [bool](Get-Module -Name CimCmdlets)
  }
  Write-Host ('env psVersion={0} edition={1} clr={2} os={3}' -f $Report.environment.psVersion, $Report.environment.psEdition, $Report.environment.clrVersion, $Report.environment.os)
  if (($psv.Major -ne 5) -or ($psv.Minor -ne 1) -or ($Report.environment.psEdition -cne 'Desktop')) { Fatal "not Windows PowerShell 5.1 Desktop: $($psv) $($Report.environment.psEdition)" }
  if ($Report.environment.cimCmdletsLoaded) { Fatal 'CimCmdlets is already loaded: real CIM cmdlets could be reachable (binding uncertain)' }

  # ---- 1. source binding: pinned files, exact caller lines, single top-level FunctionDefinitionAst at 688-703 ----
  $src = Read-PinnedLf $SourcePath $ExpectedSourceSha256
  $caller = Read-PinnedLf $CallerPath $ExpectedCallerSha256
  $CallerChecks = @(
    @($caller, 75, '$x.liveWriters = @(Get-PspLiveSidProcesses $sids)'),
    @($caller, 76, 'if ($x.liveWriters.Count -gt 0) { $x.problems += ''fake-user processes alive'' }'),
    @($src, 719, '$r.liveWriters = @(Get-PspLiveSidProcesses $WriterSids)'),
    @($src, 720, 'if ($r.liveWriters.Count -gt 0) { throw (''refusing: fake-user processes still alive: '' + ($r.liveWriters -join '', '')) }')
  )
  $L = @()
  foreach ($chk in $CallerChecks) {
    $line = $chk[0].Lines[$chk[1] - 1].Trim()
    if ($line -cne $chk[2]) { Fatal "caller line $([System.IO.Path]::GetFileName($chk[0].Full)):$($chk[1]) differs from the pinned text" }
    $L += $line
  }
  $tokens = $null; $parseErrors = $null
  $root = [System.Management.Automation.Language.Parser]::ParseFile($src.Full, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -ne 0) { Fatal ('setup-fixtures.ps1 parse errors: ' + (($parseErrors | ForEach-Object { $_.Message }) -join '; ')) }
  $named = @($root.FindAll({ param($a) ($a -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($a.Name -ceq $FunctionName) }, $true))
  if ($named.Count -ne 1) { Fatal "$FunctionName FunctionDefinitionAst occurs $($named.Count) times, expected 1" }
  $fnAst = $named[0]
  if (($fnAst.Extent.StartLineNumber -ne $ExpectedStartLine) -or ($fnAst.Extent.EndLineNumber -ne $ExpectedEndLine)) { Fatal "$FunctionName extent is lines $($fnAst.Extent.StartLineNumber)-$($fnAst.Extent.EndLineNumber), expected $ExpectedStartLine-$ExpectedEndLine" }
  if (-not (($fnAst.Parent -is [System.Management.Automation.Language.NamedBlockAst]) -and ($fnAst.Parent.Parent -eq $root))) { Fatal "$FunctionName is not a top-level definition" }
  $CandidateExtent = $fnAst.Extent.Text
  $extentSha = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($CandidateExtent))
  if ($extentSha -cne $ExpectedExtentSha256) { Fatal "$FunctionName Extent.Text sha256 $extentSha != pinned $ExpectedExtentSha256" }
  if ($CandidateExtent -cne (($src.Lines[($ExpectedStartLine - 1)..($ExpectedEndLine - 1)]) -join "`n")) { Fatal "Extent.Text differs from raw source lines $ExpectedStartLine-$ExpectedEndLine" }
  $candCmds = Test-FunctionSurface $fnAst @('GetType') 'candidate'
  foreach ($k in $Fixed.Keys) { if (-not $CandidateExtent.Contains("throw '" + $Fixed[$k] + "'")) { Fatal "candidate extent has no fixed refusal $k" } }

  $baseSha = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($BaselineExtent))
  if ($baseSha -cne $BaselineExtentSha256) { Fatal "frozen baseline extent sha256 $baseSha != pinned $BaselineExtentSha256" }
  $bTokens = $null; $bErrors = $null
  $bRoot = [System.Management.Automation.Language.Parser]::ParseInput($BaselineExtent, [ref]$bTokens, [ref]$bErrors)
  if ($bErrors.Count -ne 0) { Fatal 'frozen baseline extent has parse errors' }
  $bNamed = @($bRoot.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
  if (($bNamed.Count -ne 1) -or ($bNamed[0].Name -cne $FunctionName) -or ($bNamed[0].Extent.Text -cne $BaselineExtent) -or ($bNamed[0].Parent.Parent -ne $bRoot)) { Fatal 'frozen baseline extent is not exactly one top-level definition' }
  $null = Test-FunctionSurface $bNamed[0] @() 'baseline'
  $Report.source = [ordered]@{
    setupFixturesSha256 = $src.Sha; runValidationSha256 = $caller.Sha; function = $FunctionName
    lines = "$($fnAst.Extent.StartLineNumber)-$($fnAst.Extent.EndLineNumber)"; extentTextSha256 = $extentSha; extentTextChars = $CandidateExtent.Length
    commandSurface = $candCmds; memberCalls = @('GetType'); baselineExtentSha256 = $baseSha; parseErrors = 0
    callerLinesChecked = @($CallerChecks | ForEach-Object { "$([System.IO.Path]::GetFileName($_[0].Full)):$($_[1])" })
  }
  Write-Host "source ok setup-fixtures.ps1 sha256=$($src.Sha) $FunctionName lines=$($Report.source.lines) extentSha256=$extentSha baselineExtentSha256=$baseSha"

  # ---- 2. real caller forms, built from the pinned source lines (scope/EAP as Export-PspEvidence and Remove-PspFixtureRoot) ----
  $script:ExportForm = [scriptblock]::Create((@(
    'param($sids)', '$ErrorActionPreference = ''Stop''', '$x = [ordered]@{ liveWriters = @(); problems = @() }', $L[0], $L[1], 'return $x'
  ) -join "`n"))
  $script:CleanupForm = [scriptblock]::Create((@(
    'param([string[]]$WriterSids = @())', '$ErrorActionPreference = ''Continue''', '$r = [ordered]@{ error = $null; liveWriters = @(); passedGate = $false }',
    'try {', $L[2], $L[3], '$r.passedGate = $true', '} catch { $r.error = $_.Exception.Message }', 'return $r'
  ) -join "`n"))

  # ---- 3. mocks: script-scope functions shadowing the CIM cmdlets; fake objects only ----
  $script:CimCalls = 0; $script:OwnerCalls = 0; $script:CimClassNames = @(); $script:OwnerMethods = @(); $script:MockAnomalies = 0
  $script:Procs = @(); $script:Owners = @{}; $script:CimThrow = $false
  function Get-CimInstance { [CmdletBinding()] param([string]$ClassName)
    $script:CimCalls++; $script:CimClassNames += $ClassName
    if ($script:CimThrow) { throw 'mock-fault:cim' }
    $script:Procs
  }
  function Invoke-CimMethod { [CmdletBinding()] param($InputObject, [string]$MethodName)
    $script:OwnerCalls++; $script:OwnerMethods += $MethodName
    if ($null -eq $InputObject) { $script:MockAnomalies++; throw 'mock-fault:null-input' }
    $spec = $script:Owners[[int]$InputObject.ProcessId]
    if ($null -eq $spec) { $script:MockAnomalies++; throw 'mock-fault:no-spec' }
    switch ($spec.kind) {
      'throw' { throw 'mock-fault:owner' }
      'none' { return }
      'null' { return $null }
      'obj' { return $spec.obj }
      'multi' { $spec.obj; $spec.obj; return }
      default { $script:MockAnomalies++; throw 'mock-fault:bad-spec' }
    }
  }
  function New-Proc([int]$Id) { [pscustomobject]@{ ProcessId = [uint32]$Id; Name = 'mock.exe' } }
  function Own($Rv, $Sid) { @{ kind = 'obj'; obj = [pscustomobject]@{ ReturnValue = $Rv; Sid = $Sid } } }

  $bindings = @()
  foreach ($n in $MockNames) {
    $found = @(Get-Command -Name $n -ErrorAction SilentlyContinue)
    $types = @($found | ForEach-Object { [string]$_.CommandType })
    $bindings += ,([ordered]@{ name = $n; resolved = $types })
    if (($found.Count -ne 1) -or ($found[0].CommandType -ne [System.Management.Automation.CommandTypes]::Function)) { Fatal "$n does not resolve solely to the script mock function: $($types -join ',')" }
  }
  # Preflight from a nested function scope (same resolution chain as the function under test): counters must move.
  function Test-MockBinding {
    $script:CimCalls = 0; $script:OwnerCalls = 0; $script:Procs = @(); $script:CimThrow = $false; $script:Owners = @{ 1 = @{ kind = 'none' } }
    $p = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $o = @(Invoke-CimMethod -InputObject (New-Proc 1) -MethodName GetOwnerSid -ErrorAction Stop)
    ($script:CimCalls -eq 1) -and ($script:OwnerCalls -eq 1) -and ($p.Count -eq 0) -and ($o.Count -eq 0)
  }
  if (-not (Test-MockBinding)) { Fatal 'mock preflight: fake call counters did not move as expected' }
  $Report.binding = [ordered]@{ mocks = $bindings; preflight = 'ok'; functionUnderTest = 'Invoke-Expression of pinned Extent.Text; Get-Command type Function; Ast.Extent.Text equal' }
  Write-Host ('binding ok ' + (($bindings | ForEach-Object { "$($_.name)=$($_.resolved -join '/')" }) -join ' '))

  # ---- 4. cases: fake data only. expect = candidate contract; base = frozen-control observation (original 9 only) ----
  $A = 'S-1-5-21-1-2-3-1001'; $B = 'S-1-5-21-1-2-3-1002'; $N1 = 'S-1-5-21-1-2-3-2001'; $N2 = 'S-1-5-21-1-2-3-2002'; $N3 = 'S-1-5-21-1-2-3-2003'
  $AB = @($A, $B); $T = @{ kind = 'throw' }
  $K = @{ kind = 'known0' }
  function Hits([int[]]$Pids) { @{ kind = 'hits'; pids = $Pids } }
  function Ref([string]$Id) { @{ kind = 'refuse'; msg = $Id } }
  function Nest([int]$Inner) { @{ kind = 'nested'; inner = $Inner } }
  $Cases = @(
    [ordered]@{ id = 'a'; sids = @(); pids = @(); owners = @{}; cimThrow = $false; expect = $K; owner = 0; base = (Nest 0) }
    [ordered]@{ id = 'a2-empty-sids-cim-would-throw'; sids = @(); pids = @(901); owners = @{ 901 = (Own ([uint32]0) $A) }; cimThrow = $true; expect = $K; owner = 0; base = $null }
    [ordered]@{ id = 'b'; sids = $AB; pids = @(); owners = @{}; cimThrow = $false; expect = $K; owner = 0; base = (Nest 0) }
    [ordered]@{ id = 'c'; sids = $AB; pids = @(101, 102, 103); owners = @{ 101 = (Own ([uint32]0) $N1); 102 = (Own ([uint32]0) $N2); 103 = (Own ([uint32]0) $N3) }; cimThrow = $false; expect = $K; owner = 3; base = (Nest 0) }
    [ordered]@{ id = 'd'; sids = $AB; pids = @(201, 202); owners = @{ 201 = (Own ([uint32]0) $A); 202 = (Own ([uint32]0) $N1) }; cimThrow = $false; expect = (Hits @(201)); owner = 2; base = (Nest 1) }
    [ordered]@{ id = 'e'; sids = $AB; pids = @(301, 302, 303); owners = @{ 301 = (Own ([uint32]0) $A); 302 = (Own ([uint32]0) $B); 303 = (Own ([uint32]0) $N1) }; cimThrow = $false; expect = (Hits @(301, 302)); owner = 3; base = (Nest 2) }
    [ordered]@{ id = 'f'; sids = $AB; pids = @(401); owners = @{ 401 = (Own ([uint32]2) $A) }; cimThrow = $false; expect = (Ref 'R_RV'); owner = 1; base = (Nest 0) }
    [ordered]@{ id = 'g'; sids = $AB; pids = @(501, 502); owners = @{ 501 = $T; 502 = (Own ([uint32]0) $B) }; cimThrow = $false; expect = (Ref 'R_OWNER'); owner = 1; base = (Nest 1) }
    [ordered]@{ id = 'h'; sids = $AB; pids = @(601); owners = @{ 601 = (Own ([uint32]0) 's-1-5-21-1-2-3-1001') }; cimThrow = $false; expect = $K; owner = 1; base = (Nest 0) }
    [ordered]@{ id = 'i'; sids = $AB; pids = @(901); owners = @{ 901 = (Own ([uint32]0) $A) }; cimThrow = $true; expect = (Ref 'R_ENUM'); owner = 0; base = @{ kind = 'marker' } }
    [ordered]@{ id = 'j-owner-no-result'; sids = $AB; pids = @(1001); owners = @{ 1001 = @{ kind = 'none' } }; cimThrow = $false; expect = (Ref 'R_OWNER'); owner = 1; base = $null }
    [ordered]@{ id = 'k-owner-null'; sids = $AB; pids = @(1101); owners = @{ 1101 = @{ kind = 'null' } }; cimThrow = $false; expect = (Ref 'R_OWNER'); owner = 1; base = $null }
    [ordered]@{ id = 'l-owner-multiple'; sids = $AB; pids = @(1201); owners = @{ 1201 = @{ kind = 'multi'; obj = [pscustomobject]@{ ReturnValue = [uint32]0; Sid = $A } } }; cimThrow = $false; expect = (Ref 'R_OWNER'); owner = 1; base = $null }
    [ordered]@{ id = 'm-rv-missing'; sids = $AB; pids = @(1301); owners = @{ 1301 = @{ kind = 'obj'; obj = [pscustomobject]@{ Sid = $A } } }; cimThrow = $false; expect = (Ref 'R_RV'); owner = 1; base = $null }
    [ordered]@{ id = 'n-rv-null'; sids = $AB; pids = @(1401); owners = @{ 1401 = (Own $null $A) }; cimThrow = $false; expect = (Ref 'R_RV'); owner = 1; base = $null }
    [ordered]@{ id = 'o-rv-string0'; sids = $AB; pids = @(1501); owners = @{ 1501 = (Own '0' $A) }; cimThrow = $false; expect = (Ref 'R_RV'); owner = 1; base = $null }
    [ordered]@{ id = 'p-rv-bool'; sids = $AB; pids = @(1601); owners = @{ 1601 = (Own $false $A) }; cimThrow = $false; expect = (Ref 'R_RV'); owner = 1; base = $null }
    [ordered]@{ id = 'q-rv-double'; sids = $AB; pids = @(1701); owners = @{ 1701 = (Own ([double]0) $A) }; cimThrow = $false; expect = (Ref 'R_RV'); owner = 1; base = $null }
    [ordered]@{ id = 'r-rv-int32-hit'; sids = $AB; pids = @(1801, 1802); owners = @{ 1801 = (Own ([int32]0) $A); 1802 = (Own ([uint32]0) $N1) }; cimThrow = $false; expect = (Hits @(1801)); owner = 2; base = $null }
    [ordered]@{ id = 's-sid-missing'; sids = $AB; pids = @(1901); owners = @{ 1901 = @{ kind = 'obj'; obj = [pscustomobject]@{ ReturnValue = [uint32]0 } } }; cimThrow = $false; expect = (Ref 'R_SID'); owner = 1; base = $null }
    [ordered]@{ id = 't-sid-null'; sids = $AB; pids = @(2001); owners = @{ 2001 = (Own ([uint32]0) $null) }; cimThrow = $false; expect = (Ref 'R_SID'); owner = 1; base = $null }
    [ordered]@{ id = 'u-sid-nonstring'; sids = $AB; pids = @(2101); owners = @{ 2101 = (Own ([uint32]0) ([int]1001)) }; cimThrow = $false; expect = (Ref 'R_SID'); owner = 1; base = $null }
    [ordered]@{ id = 'v-sid-malformed'; sids = $AB; pids = @(2201); owners = @{ 2201 = (Own ([uint32]0) 'not-a-sid') }; cimThrow = $false; expect = (Ref 'R_SID'); owner = 1; base = $null }
    [ordered]@{ id = 'v2-sid-trailing-lf'; sids = $AB; pids = @(2301); owners = @{ 2301 = (Own ([uint32]0) ($A + "`n")) }; cimThrow = $false; expect = (Ref 'R_SID'); owner = 1; base = $null }
    [ordered]@{ id = 'w-hit-then-owner-throw'; sids = $AB; pids = @(2401, 2402); owners = @{ 2401 = (Own ([uint32]0) $A); 2402 = $T }; cimThrow = $false; expect = (Ref 'R_OWNER'); owner = 2; base = $null }
    [ordered]@{ id = 'x-hit-then-rv2'; sids = $AB; pids = @(2501, 2502); owners = @{ 2501 = (Own ([uint32]0) $B); 2502 = (Own ([uint32]2) $N1) }; cimThrow = $false; expect = (Ref 'R_RV'); owner = 2; base = $null }
    [ordered]@{ id = 'y-hit-then-bad-sid'; sids = $AB; pids = @(2601, 2602); owners = @{ 2601 = (Own ([uint32]0) $A); 2602 = (Own ([uint32]0) 'S-1-5') }; cimThrow = $false; expect = (Ref 'R_SID'); owner = 2; base = $null }
  )
  foreach ($case in $Cases) { foreach ($id in @($case.pids)) { if (-not $case.owners.ContainsKey($id)) { Fatal "case $($case.id) has no owner spec for pid $id" } } }

  # One real caller form over one case: classified message ids, counts, element types, pids, gate result. No flattening.
  function Invoke-Form([string]$Form, $Case) {
    $script:CimCalls = 0; $script:OwnerCalls = 0; $script:CimClassNames = @(); $script:OwnerMethods = @(); $script:MockAnomalies = 0
    $script:Procs = @(@($Case.pids) | ForEach-Object { New-Proc $_ }); $script:Owners = $Case.owners; $script:CimThrow = $Case.cimThrow
    $rec = [ordered]@{ escaped = $false; msg = $null; outerType = $null; count = $null; types = @(); inner = $null; pids = @(); flatOk = $null; gate = $null; passedGate = $null; joinOk = $null; cim = 0; owner = 0; anomalies = 0; classOk = $true }
    $res = $null; $err = $null
    try {
      if ($Form -ceq 'export') { $res = & $script:ExportForm $Case.sids } else { $res = & $script:CleanupForm -WriterSids $Case.sids }
    } catch { $rec.escaped = $true; $err = $_.Exception.Message }
    $rec.cim = $script:CimCalls; $rec.owner = $script:OwnerCalls; $rec.anomalies = $script:MockAnomalies
    $rec.classOk = (@($script:CimClassNames | Where-Object { $_ -cne 'Win32_Process' }).Count -eq 0) -and (@($script:OwnerMethods | Where-Object { $_ -cne 'GetOwnerSid' }).Count -eq 0)
    if ($null -ne $res) {
      $lw = $res.liveWriters
      if ($null -eq $lw) { $rec.outerType = 'null' } else {
        $rec.outerType = $lw.GetType().FullName
        $rec.count = @($lw).Count
        $rec.types = @(foreach ($e in $lw) { if ($null -eq $e) { 'null' } else { $e.GetType().FullName } })
        if ((@($rec.types).Count -ge 1) -and ($rec.types[0] -ceq 'System.Object[]')) { $rec.inner = @($lw[0]).Count }
        $flat = $true; $p = @()
        foreach ($e in $lw) {
          if (($e -is [string]) -and ($e -cmatch '^(\d+):mock\.exe:(S-1-[0-9]+(?:-[0-9]+)+)$') -and (@($Case.sids) -ccontains $Matches[2])) { $p += [int]$Matches[1] } else { $flat = $false }
        }
        $rec.pids = $p; $rec.flatOk = $flat
      }
      if ($Form -ceq 'export') { $rec.gate = (@($res.problems) -ccontains 'fake-user processes alive') }
      else {
        $rec.passedGate = [bool]$res.passedGate; $err = $res.error
        if (($null -ne $err) -and ($null -ne $lw)) { $rec.joinOk = ([string]$err -ceq ($GatePrefix + ($lw -join ', '))) }
      }
    }
    $rec.msg = Get-MsgId $err
    $rec
  }
  function Test-Common($Case, $Rec, [int]$ExpOwner) {
    $expCim = 1; if (@($Case.sids).Count -eq 0) { $expCim = 0 }
    if ($Rec.cim -ne $expCim) { "cim=$($Rec.cim)/$expCim" }
    if ($Rec.owner -ne $ExpOwner) { "owner=$($Rec.owner)/$ExpOwner" }
    if (-not $Rec.classOk) { 'unexpected class/method' }
    if ($Rec.anomalies -ne 0) { "mock anomalies=$($Rec.anomalies)" }
  }
  # Candidate contract: known-empty => 0 and gate open; known hits => flat strings and gate refuses; unknown => fixed refusal, no partial result.
  function Test-Product($Case, [string]$Form, $Rec) {
    Test-Common $Case $Rec $Case.owner
    $e = $Case.expect
    if ($e.kind -ceq 'refuse') {
      if ($Form -ceq 'export') { if ((-not $Rec.escaped) -or ($Rec.msg -cne $e.msg)) { "expected escape $($e.msg), got escaped=$($Rec.escaped) msg=$($Rec.msg)" } }
      else {
        if ($Rec.escaped -or ($Rec.msg -cne $e.msg) -or ($Rec.passedGate -ne $false)) { "expected error $($e.msg), got escaped=$($Rec.escaped) msg=$($Rec.msg) passedGate=$($Rec.passedGate)" }
        if (($Rec.outerType -cne 'System.Object[]') -or ($Rec.count -ne 0)) { "partial result after refusal: $($Rec.outerType)/$($Rec.count)" }
      }
      return
    }
    if ($Rec.escaped) { "unexpected escape msg=$($Rec.msg)"; return }
    $expPids = @(); if ($e.kind -ceq 'hits') { $expPids = @($e.pids) }
    $n = $expPids.Count
    if (($Rec.outerType -cne 'System.Object[]') -or ($Rec.count -ne $n)) { "shape $($Rec.outerType)/$($Rec.count), expected System.Object[]/$n" }
    if ((@($Rec.types | Where-Object { $_ -cne 'System.String' }).Count -ne 0) -or ($Rec.flatOk -ne $true)) { "elements not flat PID:Name:SID strings: $($Rec.types -join ',')" }
    if ((@($Rec.pids) -join ',') -cne ($expPids -join ',')) { "pids $(@($Rec.pids) -join ',') expected $($expPids -join ',')" }
    if ($n -eq 0) {
      if (($Form -ceq 'export') -and ($Rec.gate -ne $false)) { 'known-empty fired the export gate' }
      if (($Form -ceq 'cleanup') -and (($Rec.passedGate -ne $true) -or ($null -ne $Rec.msg))) { "known-empty did not pass the cleanup gate: msg=$($Rec.msg)" }
    } else {
      if (($Form -ceq 'export') -and ($Rec.gate -ne $true)) { 'hits did not fire the export gate' }
      if (($Form -ceq 'cleanup') -and (($Rec.passedGate -ne $false) -or ($Rec.msg -cne 'GATE') -or ($Rec.joinOk -ne $true))) { "hits did not refuse cleanup with the flat join: msg=$($Rec.msg) joinOk=$($Rec.joinOk)" }
    }
  }
  # Frozen-control observation (receipt eebca544 shape): every non-throwing case nests one inner array and fires the gate.
  function Test-Baseline($Case, [string]$Form, $Rec) {
    $o = 0; if ((@($Case.sids).Count -gt 0) -and (-not $Case.cimThrow)) { $o = @($Case.pids).Count }
    Test-Common $Case $Rec $o
    $b = $Case.base
    if ($b.kind -ceq 'marker') {
      if ($Form -ceq 'export') { if ((-not $Rec.escaped) -or ($Rec.msg -cne 'MOCK-MARKER')) { "control: expected raw marker escape, got $($Rec.msg)" } }
      elseif ($Rec.escaped -or ($Rec.msg -cne 'MOCK-MARKER') -or ($Rec.passedGate -ne $false)) { "control: expected raw marker cleanup error, got $($Rec.msg)" }
      return
    }
    if ($Rec.escaped -or ($Rec.outerType -cne 'System.Object[]') -or ($Rec.count -ne 1) -or ($Rec.types[0] -cne 'System.Object[]') -or ($Rec.inner -ne $b.inner)) { "control: expected nested Object[]/1 inner=$($b.inner), got $($Rec.outerType)/$($Rec.count)/$($Rec.types -join ',') inner=$($Rec.inner)" }
    if (($Form -ceq 'export') -and ($Rec.gate -ne $true)) { 'control: export gate did not fire' }
    if (($Form -ceq 'cleanup') -and (($Rec.msg -cne 'GATE') -or ($Rec.passedGate -ne $false))) { "control: cleanup gate did not fire: $($Rec.msg)" }
  }
  function Format-Rec($Id, [string]$Form, $Rec, [int]$FailCount) {
    "case=$Id form=$Form escaped=$($Rec.escaped) msg=$($Rec.msg) outerType=$($Rec.outerType) count=$($Rec.count) types=$($Rec.types -join ',') inner=$($Rec.inner) pids=$(@($Rec.pids) -join ',') gate=$($Rec.gate) passedGate=$($Rec.passedGate) joinOk=$($Rec.joinOk) cim=$($Rec.cim) owner=$($Rec.owner) fails=$FailCount"
  }

  # ---- 5. negative control: the frozen pre-fix extent, original cases only ----
  Invoke-Expression -Command $BaselineExtent
  Assert-FunctionBound $BaselineExtent 'frozen baseline'
  $ctl = @(); $ctlFail = 0; $rejects = @()
  foreach ($case in @($Cases | Where-Object { $null -ne $_.base })) {
    $c = [ordered]@{ id = $case.id; ok = $true; fails = @() }
    foreach ($form in @('export', 'cleanup')) {
      $rec = Invoke-Form $form $case
      $f = @(Test-Baseline $case $form $rec)
      if ($case.expect.kind -ceq 'known0') { $rejects += ,([ordered]@{ id = $case.id; form = $form; productFails = @(Test-Product $case $form $rec).Count }) }
      Write-Host ('control ' + (Format-Rec $case.id $form $rec $f.Count))
      $c[$form] = [ordered]@{ escaped = $rec.escaped; msg = $rec.msg; outerType = $rec.outerType; count = $rec.count; types = $rec.types; inner = $rec.inner; gate = $rec.gate; passedGate = $rec.passedGate; cim = $rec.cim; owner = $rec.owner }
      foreach ($x in $f) { $c.ok = $false; $c.fails += (Limit $x); $Report.failures += (Limit "control $($case.id)/$form $x") }
    }
    if (-not $c.ok) { $ctlFail++ }
    $ctl += ,$c
  }
  $rejected = (@($rejects).Count -gt 0) -and (@($rejects | Where-Object { $_.productFails -eq 0 }).Count -eq 0)
  if (-not $rejected) { $Report.failures += 'control: product checks did not reject the frozen known-empty results' }
  $Report.negativeControl = [ordered]@{
    extentSha256 = $baseSha; cases = $ctl; casesFailed = $ctlFail; productChecksRejectBaselineKnownEmpty = $rejected; productCheckRuns = $rejects
    verdict = $(if (($ctlFail -eq 0) -and $rejected) { 'DEFECT-REPRODUCED' } else { 'CONTROL-INVALID' }); countsAsProductPass = $false
  }

  # ---- 6. candidate: the pinned extent, full matrix ----
  Invoke-Expression -Command $CandidateExtent
  Assert-FunctionBound $CandidateExtent 'candidate'
  $cand = @(); $candFail = 0
  foreach ($case in $Cases) {
    $c = [ordered]@{ id = $case.id; expect = $case.expect.kind; ok = $true; fails = @() }
    foreach ($form in @('export', 'cleanup')) {
      $rec = Invoke-Form $form $case
      $f = @(Test-Product $case $form $rec)
      Write-Host ('candidate ' + (Format-Rec $case.id $form $rec $f.Count))
      $c[$form] = [ordered]@{ escaped = $rec.escaped; msg = $rec.msg; outerType = $rec.outerType; count = $rec.count; types = $rec.types; pids = $rec.pids; gate = $rec.gate; passedGate = $rec.passedGate; cim = $rec.cim; owner = $rec.owner }
      foreach ($x in $f) { $c.ok = $false; $c.fails += (Limit $x); $Report.failures += (Limit "candidate $($case.id)/$form $x") }
    }
    if (-not $c.ok) { $candFail++ }
    $cand += ,$c
  }
  $Report.candidate = [ordered]@{ extentSha256 = $extentSha; cases = $cand; casesRun = $cand.Count; casesExpected = $Cases.Count; casesFailed = $candFail }

  # ---- 7. post guards: still no host CIM module, mocks still bound, matrix complete ----
  $Report.postGuards = [ordered]@{ cimCmdletsLoaded = [bool](Get-Module -Name CimCmdlets); mocksBound = $true }
  foreach ($n in $MockNames) { $found = @(Get-Command -Name $n -ErrorAction SilentlyContinue); if (($found.Count -ne 1) -or ($found[0].CommandType -ne [System.Management.Automation.CommandTypes]::Function)) { $Report.postGuards.mocksBound = $false } }
  if ($Report.postGuards.cimCmdletsLoaded -or (-not $Report.postGuards.mocksBound)) { $Report.failures += 'post guard: CimCmdlets loaded or mock binding changed' }
  if ($cand.Count -ne $Cases.Count) { $Report.failures += 'candidate matrix incomplete' }
  if (@($Report.failures).Count -gt 50) { $Report.failures = @($Report.failures[0..49]) + @('... more failures truncated') }

  $pass = ($Report.negativeControl.verdict -ceq 'DEFECT-REPRODUCED') -and ($candFail -eq 0) -and ($cand.Count -eq $Cases.Count) -and (-not $Report.postGuards.cimCmdletsLoaded) -and $Report.postGuards.mocksBound
  if ($pass) { $Report.status = 'PASS' } else { $Report.status = 'FAILED'; $Report.failure = 'see failures' }
  Write-Host ("OUTCOME status=$($Report.status) control=$($Report.negativeControl.verdict) candidateCases=$($cand.Count) candidateFailed=$candFail failures=$(@($Report.failures).Count)")
  Write-Host (Save-Report)
  if ($pass) { exit 0 } else { exit 1 }
} catch {
  Fatal ('unhandled: ' + $_.Exception.Message)
}
