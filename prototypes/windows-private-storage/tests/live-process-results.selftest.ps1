#Requires -Version 5.1
# live-process-results.selftest.ps1 - tester-owned self-test (#1167) of the Get-PspLiveSidProcesses result contract.
# - Binds setup-fixtures.ps1 and run-validation.ps1 by sha256, parses setup-fixtures.ps1 with the PowerShell AST and takes
#   the single top-level FunctionDefinitionAst Get-PspLiveSidProcesses (lines 730-776, pinned Extent.Text sha256, only the
#   commands Get-CimInstance, Write-Host, Invoke-CimMethod, Write-Host, Write-Host in that order, only the member calls GetType(),
#   GetType()). Only that Extent.Text is evaluated, UNMODIFIED; the file is never dot-sourced.
# - Its DIAGNOSTIC lines (host stream) are captured by a Write-Host mock function defined in the caller-form scope and
#   must equal the expected closed-grammar lines exactly: per refusal the first-unknown line, plus the row-count line
#   unless enumeration failed; none otherwise.
# - Negative control: the frozen pre-fix extent (setup-fixtures.ps1 002c2f8f lines 684-692, sha256 b460bab2...) must still
#   show the nested known-empty false positive. It is control evidence only and never counts as a product PASS.
# - Both real caller forms are built from the pinned source lines (run-validation.ps1:75-76, setup-fixtures.ps1:792-793).
# - The pure diagnostic formatters Format-PspVerdictDiag (run-validation.ps1 lines 103-140), Format-PspCleanupDiag
#   (lines 175-218) and Format-PspVerdictOpDiag (lines 226-354) are taken the same way (pinned Extent.Text sha256, no command
#   at all, pinned member-name set) and run over in-memory TAP text / cleanup records with injection payloads; every line
#   must match its closed grammar exactly.
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

$ExpectedSourceSha256 = '2811ca4174da3471ccad829d5515b60ccddc10ce53b6a534b6929eb8d2f8be14'
$ExpectedCallerSha256 = 'bc44b257f4cd2e2212380be5ef328eccbda84f543788a569ebaae727b1bc603f'
$ExpectedExtentSha256 = '907ebffaa853db841e02c7e3ab0fad0a805b88f8b038b57ba428bbee6cef8473'
$BaselineExtentSha256 = 'b460bab2746846988518ade81b10f3760668a9ccb18d15add29cb936c26de332'
$FunctionName = 'Get-PspLiveSidProcesses'
$ExpectedStartLine = 730
$ExpectedEndLine = 776
$MockNames = @('Get-CimInstance', 'Invoke-CimMethod')
$CandidateCommands = @('Get-CimInstance', 'Write-Host', 'Invoke-CimMethod', 'Write-Host', 'Write-Host')
$CandidateMembers = @('GetType', 'GetType')
# Pure diagnostic formatters in run-validation.ps1: no command at all; member-name set (sorted, unique) pinned.
$Formatters = @(
  [ordered]@{ name = 'Format-PspVerdictDiag'; start = 103; end = 140; sha = 'c4ebd70638fc576fc3dd904c77ab6b26612841b35f766988ce53174507703329'; members = @('ComputeHash', 'Create', 'Dispose', 'GetBytes', 'Split', 'ToLowerInvariant', 'ToString', 'TrimEnd') }
  [ordered]@{ name = 'Format-PspCleanupDiag'; start = 175; end = 218; sha = '06795a7cab97e9ed3e138046c821cdf188544cda95efa4ae06b466c9bfbafe43'; members = @('StartsWith') }
  [ordered]@{ name = 'Format-PspVerdictOpDiag'; start = 226; end = 354; sha = '52a4e1c7138f72f8fb3327f526e5862c227fda6335b7375a8c1e28e600450132'; members = @('ContainsKey', 'Split', 'StartsWith', 'Substring', 'TrimEnd', 'TrimStart') }
)
$DiagOwnerPattern = '^psp-diag owner-unknown cat=(enumeration|query|shape|rv-missing|rv-type|rv-nonzero|sid-invalid) pid=(none|[0-9]{1,10}) rv=(none|-?[0-9]{1,20})\z'
$DiagOwnerCountsPattern = '^psp-diag owner-unknown-counts rows=[0-9]{1,10} hits=[0-9]{1,10} query=[0-9]{1,10} shape=[0-9]{1,10} rv-missing=[0-9]{1,10} rv-type=[0-9]{1,10} rv-nonzero=[0-9]{1,10} sid-invalid=[0-9]{1,10}\z'
$N9 = '(none|[0-9]{1,9})'
$DiagVerdictPattern = '^psp-diag verdict nodeExit=(none|-?[0-9]{1,10}) tap=(ok|missing|unexpected-path|reparse|not-file|too-large|read-failed|decode-failed|too-many-lines|UNKNOWN) bytes=(none|[0-9]{1,19})' + ((@('lines', 'plan', 'tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'okLines', 'notOkLines', 'bail') | ForEach-Object { " $_=$N9" }) -join '') + ' listed=[0-9]{1,2} clipped=[0-9]{1,9} trust=diagnostic-only\z'
$DiagVerdictFailPattern = '^psp-diag verdict-fail n=[0-9]{1,9} depth=[0-9]{1,2} directive=[01] nameSha256=(none|[0-9a-f]{64})\z'
$RootCats = 'none|owner-unknown-enumeration|owner-unknown-query|owner-unknown-rv|owner-unknown-sid|not-fully-removed|live-writers|unowned-root|non-canonical-root|reparse-root|privilege|link-pair|UNKNOWN'
$DiagCleanupPattern = '^psp-diag cleanup phase=(in-run|backstop|UNKNOWN) (summary=none|ok=(true|false) exception=(true|false) stateProblems=[0-9]{1,9} vdisks=' + $N9 + ' vdiskErrors=' + $N9 + ' root=(none|removed|kept|UNKNOWN) rootError=(' + $RootCats + ') liveWriters=' + $N9 + ' users=' + $N9 + ' usersRemoved=' + $N9 + ' usersNotPresent=' + $N9 + ' userErrors=' + $N9 + ')\z'
$DiagOpSummaryPattern = '^psp-diag verdict-op-summary tap=(ok|missing|unexpected-path|reparse|not-file|too-large|read-failed|decode-failed|too-many-lines|UNKNOWN)' + ((@('candidates', 'accepted', 'listed', 'clipped', 'malformed', 'oversize', 'duplicates', 'indented', 'errors') | ForEach-Object { " $_=[0-9]{1,9}" }) -join '') + ' trust=diagnostic-only\z'
$DiagOpPattern = '^psp-diag verdict-op kind=[a-z]{1,16}( [A-Za-z]{1,24}=[A-Za-z0-9_.,:-]{1,1400})*\z'
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
  negativeControl = $null; candidate = $null; formatters = $null; postGuards = $null; failures = @()
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
# Command surface of a function under test: exactly the expected commands in source order (no invocation operator),
# exactly the allowed instance member calls with no arguments, and no nested function definition.
function Test-FunctionSurface($FnAst, [string[]]$AllowedMembers, [string]$Label, [string[]]$Commands = $MockNames) {
  $cmdAsts = @($FnAst.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true))
  $cmdNames = @($cmdAsts | ForEach-Object { $_.GetCommandName() })
  foreach ($c in $cmdAsts) { if ($c.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) { Fatal "$Label uses an invocation operator: $($c.Extent.Text)" } }
  if (($cmdNames -join ',') -cne ($Commands -join ',')) { Fatal ("$Label command surface is not exactly $($Commands -join ', '): " + ($cmdNames -join ', ')) }
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
    @($src, 792, '$r.liveWriters = @(Get-PspLiveSidProcesses $WriterSids)'),
    @($src, 793, 'if ($r.liveWriters.Count -gt 0) { throw (''refusing: fake-user processes still alive: '' + ($r.liveWriters -join '', '')) }')
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
  $candCmds = Test-FunctionSurface $fnAst $CandidateMembers 'candidate' $CandidateCommands
  foreach ($k in $Fixed.Keys) { if (-not $CandidateExtent.Contains("throw '" + $Fixed[$k] + "'")) { Fatal "candidate extent has no fixed refusal $k" } }

  # Pure formatters from the pinned run-validation.ps1: top-level, exact lines, pinned extent, no command, pinned members.
  $cTokens = $null; $cErrors = $null
  $cRoot = [System.Management.Automation.Language.Parser]::ParseFile($caller.Full, [ref]$cTokens, [ref]$cErrors)
  if ($cErrors.Count -ne 0) { Fatal ('run-validation.ps1 parse errors: ' + (($cErrors | ForEach-Object { $_.Message }) -join '; ')) }
  $FormatterExtents = [ordered]@{}; $fmtSource = @()
  foreach ($fm in $Formatters) {
    $fa = @($cRoot.FindAll({ param($a) ($a -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($a.Name -ceq $fm.name) }, $true))
    if ($fa.Count -ne 1) { Fatal "$($fm.name) FunctionDefinitionAst occurs $($fa.Count) times, expected 1" }
    $f0 = $fa[0]
    if (($f0.Extent.StartLineNumber -ne $fm.start) -or ($f0.Extent.EndLineNumber -ne $fm.end)) { Fatal "$($fm.name) extent is lines $($f0.Extent.StartLineNumber)-$($f0.Extent.EndLineNumber), expected $($fm.start)-$($fm.end)" }
    if (-not (($f0.Parent -is [System.Management.Automation.Language.NamedBlockAst]) -and ($f0.Parent.Parent -eq $cRoot))) { Fatal "$($fm.name) is not a top-level definition" }
    $ft = $f0.Extent.Text
    $fsha = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($ft))
    if ($fsha -cne $fm.sha) { Fatal "$($fm.name) Extent.Text sha256 $fsha != pinned $($fm.sha)" }
    if ($ft -cne (($caller.Lines[($fm.start - 1)..($fm.end - 1)]) -join "`n")) { Fatal "$($fm.name) Extent.Text differs from raw source lines" }
    if (@($f0.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)).Count -ne 0) { Fatal "$($fm.name) invokes a command (expected none)" }
    if (@($f0.FindAll({ param($a) $a -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)).Count -ne 1) { Fatal "$($fm.name) contains a nested function definition" }
    $mn = @(@($f0.FindAll({ param($a) $a -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) | ForEach-Object { $_.Member.Extent.Text } | Sort-Object -Unique -CaseSensitive)
    if (($mn -join ',') -cne ($fm.members -join ',')) { Fatal "$($fm.name) member-name set is not exactly: $($fm.members -join ',')" }
    $FormatterExtents[$fm.name] = $ft
    $fmtSource += ,([ordered]@{ function = $fm.name; lines = "$($fm.start)-$($fm.end)"; extentTextSha256 = $fsha; commands = 0; members = $mn })
  }

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
    commandSurface = $candCmds; memberCalls = $CandidateMembers; baselineExtentSha256 = $baseSha; parseErrors = 0; formatters = $fmtSource
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
    $spec = $script:Owners[[int]$InputObject.MockKey]
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
  # MockKey selects the owner spec; ProcessId is [uint32]$Id unless the case overrides it ('<absent>' = no such property).
  function New-Proc([int]$Id, $Over) {
    if (($null -ne $Over) -and $Over.ContainsKey($Id)) {
      $v = $Over[$Id]
      if (($v -is [string]) -and ($v -ceq '<absent>')) { return [pscustomobject]@{ Name = 'mock.exe'; MockKey = $Id } }
      return [pscustomobject]@{ ProcessId = $v; Name = 'mock.exe'; MockKey = $Id }
    }
    [pscustomobject]@{ ProcessId = [uint32]$Id; Name = 'mock.exe'; MockKey = $Id }
  }
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
  # Row refusals: the first-unknown line, then the count line over every enumerated row (Cnt). Enumeration: first line only.
  function Ref([string]$Id, [string]$Cat, [string]$P, [string]$Rv, $Counts) { $d = @("psp-diag owner-unknown cat=$Cat pid=$P rv=$Rv"); if ($null -ne $Counts) { $d += $Counts }; @{ kind = 'refuse'; msg = $Id; diag = $d } }
  function Cnt([int]$Rows, [int]$Hits, [hashtable]$C = @{}) {
    $s = "psp-diag owner-unknown-counts rows=$Rows hits=$Hits"
    foreach ($k in @('query', 'shape', 'rv-missing', 'rv-type', 'rv-nonzero', 'sid-invalid')) { $x = 0; if ($C.ContainsKey($k)) { $x = $C[$k] }; $s += " $k=$x" }
    $s
  }
  function Nest([int]$Inner) { @{ kind = 'nested'; inner = $Inner } }
  $Cases = @(
    [ordered]@{ id = 'a'; sids = @(); pids = @(); owners = @{}; cimThrow = $false; expect = $K; owner = 0; base = (Nest 0) }
    [ordered]@{ id = 'a2-empty-sids-cim-would-throw'; sids = @(); pids = @(901); owners = @{ 901 = (Own ([uint32]0) $A) }; cimThrow = $true; expect = $K; owner = 0; base = $null }
    [ordered]@{ id = 'b'; sids = $AB; pids = @(); owners = @{}; cimThrow = $false; expect = $K; owner = 0; base = (Nest 0) }
    [ordered]@{ id = 'c'; sids = $AB; pids = @(101, 102, 103); owners = @{ 101 = (Own ([uint32]0) $N1); 102 = (Own ([uint32]0) $N2); 103 = (Own ([uint32]0) $N3) }; cimThrow = $false; expect = $K; owner = 3; base = (Nest 0) }
    [ordered]@{ id = 'd'; sids = $AB; pids = @(201, 202); owners = @{ 201 = (Own ([uint32]0) $A); 202 = (Own ([uint32]0) $N1) }; cimThrow = $false; expect = (Hits @(201)); owner = 2; base = (Nest 1) }
    [ordered]@{ id = 'e'; sids = $AB; pids = @(301, 302, 303); owners = @{ 301 = (Own ([uint32]0) $A); 302 = (Own ([uint32]0) $B); 303 = (Own ([uint32]0) $N1) }; cimThrow = $false; expect = (Hits @(301, 302)); owner = 3; base = (Nest 2) }
    [ordered]@{ id = 'f'; sids = $AB; pids = @(401); owners = @{ 401 = (Own ([uint32]2) $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' '401' '2' (Cnt 1 0 @{ 'rv-nonzero' = 1 })); owner = 1; base = (Nest 0) }
    [ordered]@{ id = 'g'; sids = $AB; pids = @(501, 502); owners = @{ 501 = $T; 502 = (Own ([uint32]0) $B) }; cimThrow = $false; expect = (Ref 'R_OWNER' 'query' '501' 'none' (Cnt 2 1 @{ query = 1 })); owner = 2; base = (Nest 1) }
    [ordered]@{ id = 'h'; sids = $AB; pids = @(601); owners = @{ 601 = (Own ([uint32]0) 's-1-5-21-1-2-3-1001') }; cimThrow = $false; expect = $K; owner = 1; base = (Nest 0) }
    [ordered]@{ id = 'i'; sids = $AB; pids = @(901); owners = @{ 901 = (Own ([uint32]0) $A) }; cimThrow = $true; expect = (Ref 'R_ENUM' 'enumeration' 'none' 'none'); owner = 0; base = @{ kind = 'marker' } }
    [ordered]@{ id = 'j-owner-no-result'; sids = $AB; pids = @(1001); owners = @{ 1001 = @{ kind = 'none' } }; cimThrow = $false; expect = (Ref 'R_OWNER' 'shape' '1001' 'none' (Cnt 1 0 @{ shape = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'k-owner-null'; sids = $AB; pids = @(1101); owners = @{ 1101 = @{ kind = 'null' } }; cimThrow = $false; expect = (Ref 'R_OWNER' 'shape' '1101' 'none' (Cnt 1 0 @{ shape = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'l-owner-multiple'; sids = $AB; pids = @(1201); owners = @{ 1201 = @{ kind = 'multi'; obj = [pscustomobject]@{ ReturnValue = [uint32]0; Sid = $A } } }; cimThrow = $false; expect = (Ref 'R_OWNER' 'shape' '1201' 'none' (Cnt 1 0 @{ shape = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'm-rv-missing'; sids = $AB; pids = @(1301); owners = @{ 1301 = @{ kind = 'obj'; obj = [pscustomobject]@{ Sid = $A } } }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-missing' '1301' 'none' (Cnt 1 0 @{ 'rv-missing' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'n-rv-null'; sids = $AB; pids = @(1401); owners = @{ 1401 = (Own $null $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-missing' '1401' 'none' (Cnt 1 0 @{ 'rv-missing' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'o-rv-string0'; sids = $AB; pids = @(1501); owners = @{ 1501 = (Own '0' $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-type' '1501' 'none' (Cnt 1 0 @{ 'rv-type' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'p-rv-bool'; sids = $AB; pids = @(1601); owners = @{ 1601 = (Own $false $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-type' '1601' 'none' (Cnt 1 0 @{ 'rv-type' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'q-rv-double'; sids = $AB; pids = @(1701); owners = @{ 1701 = (Own ([double]0) $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-type' '1701' 'none' (Cnt 1 0 @{ 'rv-type' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'r-rv-int32-hit'; sids = $AB; pids = @(1801, 1802); owners = @{ 1801 = (Own ([int32]0) $A); 1802 = (Own ([uint32]0) $N1) }; cimThrow = $false; expect = (Hits @(1801)); owner = 2; base = $null }
    [ordered]@{ id = 's-sid-missing'; sids = $AB; pids = @(1901); owners = @{ 1901 = @{ kind = 'obj'; obj = [pscustomobject]@{ ReturnValue = [uint32]0 } } }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '1901' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 't-sid-null'; sids = $AB; pids = @(2001); owners = @{ 2001 = (Own ([uint32]0) $null) }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '2001' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'u-sid-nonstring'; sids = $AB; pids = @(2101); owners = @{ 2101 = (Own ([uint32]0) ([int]1001)) }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '2101' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'v-sid-malformed'; sids = $AB; pids = @(2201); owners = @{ 2201 = (Own ([uint32]0) 'not-a-sid') }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '2201' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'v2-sid-trailing-lf'; sids = $AB; pids = @(2301); owners = @{ 2301 = (Own ([uint32]0) ($A + "`n")) }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '2301' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'w-hit-then-owner-throw'; sids = $AB; pids = @(2401, 2402); owners = @{ 2401 = (Own ([uint32]0) $A); 2402 = $T }; cimThrow = $false; expect = (Ref 'R_OWNER' 'query' '2402' 'none' (Cnt 2 1 @{ query = 1 })); owner = 2; base = $null }
    [ordered]@{ id = 'x-hit-then-rv2'; sids = $AB; pids = @(2501, 2502); owners = @{ 2501 = (Own ([uint32]0) $B); 2502 = (Own ([uint32]2) $N1) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' '2502' '2' (Cnt 2 1 @{ 'rv-nonzero' = 1 })); owner = 2; base = $null }
    [ordered]@{ id = 'y-hit-then-bad-sid'; sids = $AB; pids = @(2601, 2602); owners = @{ 2601 = (Own ([uint32]0) $A); 2602 = (Own ([uint32]0) 'S-1-5') }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '2602' '0' (Cnt 2 1 @{ 'sid-invalid' = 1 })); owner = 2; base = $null }
    # Bounded diagnostic of the FIRST unknown: malformed / payload PID and RV values must render as 'none' or digits only.
    [ordered]@{ id = 'z1-diag-pid-string-payload'; sids = $AB; pids = @(3101); pidv = @{ 3101 = "31`n::error::pwn" }; owners = @{ 3101 = (Own ([uint32]2) $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' 'none' '2' (Cnt 1 0 @{ 'rv-nonzero' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z2-diag-pid-negative'; sids = $AB; pids = @(3201); pidv = @{ 3201 = [int]-5 }; owners = @{ 3201 = $T }; cimThrow = $false; expect = (Ref 'R_OWNER' 'query' 'none' 'none' (Cnt 1 0 @{ query = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z3-diag-pid-over-uint32'; sids = $AB; pids = @(3301); pidv = @{ 3301 = [long]4294967296 }; owners = @{ 3301 = (Own ([uint32]5) $N1) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' 'none' '5' (Cnt 1 0 @{ 'rv-nonzero' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z4-diag-pid-absent-sid-payload'; sids = $AB; pids = @(3401); pidv = @{ 3401 = '<absent>' }; owners = @{ 3401 = (Own ([uint32]0) '::error::pwn') }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' 'none' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z5-diag-pid-uint32-max'; sids = $AB; pids = @(3501); pidv = @{ 3501 = [uint32]::MaxValue }; owners = @{ 3501 = (Own ([uint32]3) $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' '4294967295' '3' (Cnt 1 0 @{ 'rv-nonzero' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z6-diag-pid-bool'; sids = $AB; pids = @(3601); pidv = @{ 3601 = $true }; owners = @{ 3601 = (Own ([uint32]0) $null) }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' 'none' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z7-diag-pid-double'; sids = $AB; pids = @(3701); pidv = @{ 3701 = [double]37 }; owners = @{ 3701 = $T }; cimThrow = $false; expect = (Ref 'R_OWNER' 'query' 'none' 'none' (Cnt 1 0 @{ query = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z8-diag-rv-uint64-max'; sids = $AB; pids = @(3801); owners = @{ 3801 = (Own ([uint64]::MaxValue) $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' '3801' '18446744073709551615' (Cnt 1 0 @{ 'rv-nonzero' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z9-diag-rv-negative'; sids = $AB; pids = @(3901); owners = @{ 3901 = (Own ([int32]-1) $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' '3901' '-1' (Cnt 1 0 @{ 'rv-nonzero' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z10-diag-rv-string-payload'; sids = $AB; pids = @(4001); owners = @{ 4001 = (Own "0`r`n::set-output name=x::y" $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-type' '4001' 'none' (Cnt 1 0 @{ 'rv-type' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z11-diag-sid-control-payload'; sids = $AB; pids = @(4101); owners = @{ 4101 = (Own ([uint32]0) ($A + "`r`n::warning::pwn")) }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '4101' '0' (Cnt 1 0 @{ 'sid-invalid' = 1 })); owner = 1; base = $null }
    [ordered]@{ id = 'z12-diag-first-unknown-only'; sids = $AB; pids = @(4201, 4202, 4203); owners = @{ 4201 = (Own ([uint32]0) $A); 4202 = $T; 4203 = (Own ([uint32]7) $N1) }; cimThrow = $false; expect = (Ref 'R_OWNER' 'query' '4202' 'none' (Cnt 3 1 @{ query = 1; 'rv-nonzero' = 1 })); owner = 3; base = $null }
    # Every enumerated row is classified: two unknowns are both counted, a known hit is only counted (no partial hit list),
    # and the refusal is still the FIRST unknown's. Malformed rows never leak a payload into either line.
    [ordered]@{ id = 'aa-hit-then-two-unknown'; sids = $AB; pids = @(5001, 5002, 5003); owners = @{ 5001 = (Own ([uint32]0) $A); 5002 = (Own ([uint32]2) $A); 5003 = $T }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-nonzero' '5002' '2' (Cnt 3 1 @{ query = 1; 'rv-nonzero' = 1 })); owner = 3; base = $null }
    [ordered]@{ id = 'ab-two-unknown-same-cat'; sids = $AB; pids = @(5101, 5102); owners = @{ 5101 = (Own $null $A); 5102 = @{ kind = 'obj'; obj = [pscustomobject]@{ Sid = $B } } }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-missing' '5101' 'none' (Cnt 2 0 @{ 'rv-missing' = 2 })); owner = 2; base = $null }
    [ordered]@{ id = 'ac-unknown-then-hit'; sids = $AB; pids = @(5201, 5202); owners = @{ 5201 = (Own ([uint32]0) 'not-a-sid'); 5202 = (Own ([uint32]0) $B) }; cimThrow = $false; expect = (Ref 'R_SID' 'sid-invalid' '5201' '0' (Cnt 2 1 @{ 'sid-invalid' = 1 })); owner = 2; base = $null }
    [ordered]@{ id = 'ad-malformed-rows'; sids = $AB; pids = @(5301, 5302, 5303, 5304, 5305); pidv = @{ 5301 = "53`n::error::pwn"; 5304 = [double]1 }; owners = @{ 5301 = (Own "0`r`n::error::pwn" $A); 5302 = (Own ([uint32]0) '::error::pwn'); 5303 = @{ kind = 'multi'; obj = [pscustomobject]@{ ReturnValue = [uint32]0; Sid = $A } }; 5304 = $T; 5305 = (Own ([uint32]0) $A) }; cimThrow = $false; expect = (Ref 'R_RV' 'rv-type' 'none' 'none' (Cnt 5 1 @{ query = 1; shape = 1; 'rv-type' = 1; 'sid-invalid' = 1 })); owner = 5; base = $null }
  )
  foreach ($case in $Cases) { foreach ($id in @($case.pids)) { if (-not $case.owners.ContainsKey($id)) { Fatal "case $($case.id) has no owner spec for pid $id" } } }

  # One real caller form over one case: classified message ids, counts, element types, pids, gate result. No flattening.
  function Invoke-Form([string]$Form, $Case) {
    $script:CimCalls = 0; $script:OwnerCalls = 0; $script:CimClassNames = @(); $script:OwnerMethods = @(); $script:MockAnomalies = 0
    # pidv is optional (z-cases only): strict mode 2.0 throws on member access of an absent [ordered] key, so test presence.
    $over = $null; if ($Case.Contains('pidv')) { $over = $Case['pidv'] }
    $script:Procs = @(@($Case.pids) | ForEach-Object { New-Proc $_ $over }); $script:Owners = $Case.owners; $script:CimThrow = $Case.cimThrow
    $rec = [ordered]@{ escaped = $false; msg = $null; outerType = $null; count = $null; types = @(); inner = $null; pids = @(); flatOk = $null; gate = $null; passedGate = $null; joinOk = $null; cim = 0; owner = 0; anomalies = 0; classOk = $true; hostBound = $false; diag = @() }
    # Host-stream capture: a Write-Host function in THIS scope shadows the cmdlet for the caller form and the function under
    # test (dynamic scope), never for the self-test's own report lines. Preflight from a nested scope must be captured.
    $script:HostLines = @()
    function Write-Host { [CmdletBinding()] param([Parameter(Position = 0)]$Object) $script:HostLines += ,$Object }
    & { Write-Host 'psp-selftest-preflight' }
    $rec.hostBound = (@($script:HostLines).Count -eq 1) -and ($script:HostLines[0] -ceq 'psp-selftest-preflight')
    $script:HostLines = @()
    $res = $null; $err = $null
    try {
      if ($Form -ceq 'export') { $res = & $script:ExportForm $Case.sids } else { $res = & $script:CleanupForm -WriterSids $Case.sids }
    } catch { $rec.escaped = $true; $err = $_.Exception.Message }
    $rec.diag = @($script:HostLines)
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
    # Diagnostic: for a refusal the exact closed-grammar lines (first unknown, then the row counts unless enumeration
    # failed), none otherwise.
    if ($Rec.hostBound -ne $true) { 'Write-Host capture preflight failed' }
    $dl = @($Rec.diag); $expDiag = @(); if ($e.kind -ceq 'refuse') { $expDiag = @($e.diag) }
    foreach ($d in $dl) { if (-not (($d -is [string]) -and (($d -cmatch $DiagOwnerPattern) -or ($d -cmatch $DiagOwnerCountsPattern)) -and (-not $d.Contains('::')))) { "diag line outside the closed grammar (len=$(([string]$d).Length))" } }
    if (($dl.Count -ne $expDiag.Count) -or ((@($dl | ForEach-Object { [string]$_ }) -join '|') -cne ($expDiag -join '|'))) { "diag lines=$($dl.Count) expected=$($expDiag.Count) or text differs" }
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
    "case=$Id form=$Form escaped=$($Rec.escaped) msg=$($Rec.msg) outerType=$($Rec.outerType) count=$($Rec.count) types=$($Rec.types -join ',') inner=$($Rec.inner) pids=$(@($Rec.pids) -join ',') gate=$($Rec.gate) passedGate=$($Rec.passedGate) joinOk=$($Rec.joinOk) cim=$($Rec.cim) owner=$($Rec.owner) diag=$(@($Rec.diag).Count) fails=$FailCount"
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
      $c[$form] = [ordered]@{ escaped = $rec.escaped; msg = $rec.msg; outerType = $rec.outerType; count = $rec.count; types = $rec.types; pids = $rec.pids; gate = $rec.gate; passedGate = $rec.passedGate; cim = $rec.cim; owner = $rec.owner; diagLines = @($rec.diag).Count }
      foreach ($x in $f) { $c.ok = $false; $c.fails += (Limit $x); $Report.failures += (Limit "candidate $($case.id)/$form $x") }
    }
    if (-not $c.ok) { $candFail++ }
    $cand += ,$c
  }
  $Report.candidate = [ordered]@{ extentSha256 = $extentSha; cases = $cand; casesRun = $cand.Count; casesExpected = $Cases.Count; casesFailed = $candFail }

  # ---- 6b. pure diagnostic formatters: pinned extents over in-memory TAP text / cleanup records (no file, no host state) ----
  foreach ($k in $FormatterExtents.Keys) {
    Invoke-Expression -Command $FormatterExtents[$k]
    $fb = @(Get-Command -Name $k -CommandType Function -ErrorAction SilentlyContinue)
    if (($fb.Count -ne 1) -or ($fb[0].ScriptBlock.Ast.Extent.Text -cne $FormatterExtents[$k])) { Fatal "$k is not bound to the pinned extent" }
  }
  function Get-NameSha([string]$S) { Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($S)) }
  # Independent oracle of the expected verdict lines (fields absent from $V print 'none'; listed/clipped default 0).
  function VHead([string]$Ne, [string]$Tap, [string]$By, [hashtable]$V) {
    $s = "psp-diag verdict nodeExit=$Ne tap=$Tap bytes=$By"
    foreach ($k in @('lines', 'plan', 'tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'okLines', 'notOkLines', 'bail')) { $x = 'none'; if ($V.ContainsKey($k)) { $x = [string]$V[$k] }; $s += " $k=$x" }
    $l = 0; if ($V.ContainsKey('listed')) { $l = $V['listed'] }
    $c = 0; if ($V.ContainsKey('clipped')) { $c = $V['clipped'] }
    $s + " listed=$l clipped=$c trust=diagnostic-only"
  }
  function VFail([int]$N, [int]$D, [int]$Dir, $Name) { $h = 'none'; if ($null -ne $Name) { $h = Get-NameSha ([string]$Name) }; "psp-diag verdict-fail n=$N depth=$D directive=$Dir nameSha256=$h" }
  $Esc = [string][char]27
  $Inner = 'inner ::error file=x::pwn' + "`r" + 'mid' + $Esc + '[31m'
  $T1 = @('TAP version 13', '# Subtest: outer', ('    # Subtest: ' + $Inner), ('    not ok 1 - ' + $Inner), '      ---', '      duration_ms: 1.5',
    "      error: 'C:\Users\pspa000000\secret-value'", '      stack: |-', '        at C:\x\acl.test.mjs:765:7', '      ...', '    1..1',
    'not ok 1 - outer', '  ---', '  ...', '# Subtest: good', 'ok 2 - good', '1..2', '# tests 3', '# suites 0', '# pass 1', '# fail 2',
    '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 5.2')
  $T2 = @(@(1..70 | ForEach-Object { "not ok $_ - t$_" }) + @('1..70'))
  $T3 = @('not ok 1234567890 - x', '# tests 99999999999', '1..1e3', '    Bail out! ::error::pwn', 'not ok 5', 'not ok 6 - y # TODO later',
    '          not ok 7 - deep', 'ok 8 - fine # SKIP', ('not ok 9 - crlf' + "`r"), '')
  $VCases = @(
    [ordered]@{ id = 'tv-nested-injection'; ne = [int]1; rs = 'ok'; text = ($T1 -join "`n"); by = [long]1234; forbid = @('pwn', 'secret-value', 'C:\', 'acl.test.mjs', 'inner', 'outer', 'Subtest')
      expect = @((VHead '1' 'ok' '1234' @{ lines = $T1.Count; plan = 2; tests = 3; pass = 1; fail = 2; cancelled = 0; skipped = 0; todo = 0; okLines = 1; notOkLines = 2; bail = 0; listed = 2 }), (VFail 1 1 0 $Inner), (VFail 1 0 0 'outer')) }
    [ordered]@{ id = 'tv-clipped-64'; ne = [int]1; rs = 'ok'; text = ($T2 -join "`n"); by = [long]1; forbid = @('t70')
      expect = @(@(VHead '1' 'ok' '1' @{ lines = $T2.Count; plan = 70; okLines = 0; notOkLines = 70; bail = 0; listed = 64; clipped = 6 }) + @(1..64 | ForEach-Object { VFail $_ 0 0 "t$_" })) }
    [ordered]@{ id = 'tv-too-many-lines'; ne = [int]1; rs = 'ok'; text = ("`n" * 50000); by = [long]50000; forbid = @()
      expect = @(VHead '1' 'too-many-lines' '50000' @{ lines = 50001 }) }
    [ordered]@{ id = 'tv-bounds-directive-crlf'; ne = [int]0; rs = 'ok'; text = ($T3 -join "`n"); by = [long]9; forbid = @('pwn', 'deep', 'crlf')
      expect = @((VHead '0' 'ok' '9' @{ lines = $T3.Count; okLines = 1; notOkLines = 3; bail = 1; listed = 3 }), (VFail 5 0 0 $null), (VFail 6 0 1 'y # TODO later'), (VFail 9 0 0 'crlf')) }
    [ordered]@{ id = 'tv-read-status-not-enum'; ne = [int]1; rs = "ok`n::error::pwn"; text = 'not ok 1 - leak'; by = [long]15; forbid = @('pwn', 'leak')
      expect = @(VHead '1' 'UNKNOWN' '15' @{}) }
    [ordered]@{ id = 'tv-read-status-reparse'; ne = [int]1; rs = 'reparse'; text = 'not ok 1 - leak'; by = [long]15; forbid = @('leak')
      expect = @(VHead '1' 'reparse' '15' @{}) }
    [ordered]@{ id = 'tv-nodeexit-string-payload'; ne = "1`n::error::pwn"; rs = 'missing'; text = ''; by = $null; forbid = @('pwn')
      expect = @(VHead 'none' 'missing' 'none' @{}) }
    [ordered]@{ id = 'tv-nodeexit-null-bytes-negative'; ne = $null; rs = 'too-large'; text = ''; by = [long]-1; forbid = @()
      expect = @(VHead 'none' 'too-large' 'none' @{}) }
    [ordered]@{ id = 'tv-nodeexit-long-bytes-int'; ne = [long]1; rs = 'decode-failed'; text = ''; by = [int]7; forbid = @()
      expect = @(VHead 'none' 'decode-failed' 'none' @{}) }
  )
  function URec([string]$Name, $Removed, $Err) { [ordered]@{ name = $Name; sid = 'S-1-5-21-1-2-3-1001'; removed = $Removed; profileRemoved = $false; error = $Err } }
  function VRec($Err) { [ordered]@{ file = 'C:\secret\vhd-fat32.vhdx'; detached = $true; deleted = $true; error = $Err } }
  function RootRec($Err, $Removed = $false, [object[]]$Lw = @()) { [ordered]@{ root = 'C:\secret\root'; removed = $Removed; error = $Err; liveWriters = $Lw; walk = $null } }
  function CRec($Root, $Users, $Vdisks, $Ok = $false) { [ordered]@{ stateProblems = @(); vdisks = $Vdisks; root = $Root; users = $Users; ok = $Ok } }
  $NoneTail = 'users=none usersRemoved=none usersNotPresent=none userErrors=none'
  $LwHit = '7:mock.exe:S-1-5-21-1-2-3-1001'
  $CCases = @(
    [ordered]@{ id = 'tc-null'; ph = 'in-run'; c = $null; expect = 'psp-diag cleanup phase=in-run summary=none' }
    [ordered]@{ id = 'tc-not-dict'; ph = 'backstop'; c = 'C:\secret ::error::pwn'; expect = 'psp-diag cleanup phase=backstop summary=none' }
    [ordered]@{ id = 'tc-exception'; ph = 'in-run'; c = [ordered]@{ ok = $false; error = ('C:\secret' + "`r`n" + '::error::pwn') }
      expect = "psp-diag cleanup phase=in-run ok=false exception=true stateProblems=0 vdisks=none vdiskErrors=none root=none rootError=none liveWriters=none $NoneTail" }
    [ordered]@{ id = 'tc-state-problems'; ph = 'backstop'; c = [ordered]@{ stateProblems = @('root-leaf', 'vdisk-file:fat32'); vdisks = $null; root = $null; users = $null; ok = $false }
      expect = "psp-diag cleanup phase=backstop ok=false exception=false stateProblems=2 vdisks=none vdiskErrors=none root=none rootError=none liveWriters=none $NoneTail" }
    [ordered]@{ id = 'tc-owner-unknown-rv'; ph = 'in-run'; c = (CRec (RootRec $Fixed.R_RV) @((URec 'pspa000001' $true $null), (URec 'pspb000001' $false 'not-present')) @((VRec $null), (VRec 'refusing unowned vdisk path C:\secret ::error::pwn')))
      expect = 'psp-diag cleanup phase=in-run ok=false exception=false stateProblems=0 vdisks=2 vdiskErrors=1 root=kept rootError=owner-unknown-rv liveWriters=0 users=2 usersRemoved=1 usersNotPresent=1 userErrors=0' }
    [ordered]@{ id = 'tc-live-writers'; ph = 'backstop'; c = (CRec (RootRec ($GatePrefix + $LwHit) $false @($LwHit)) @((URec 'pspa000001' $false ('sid-name-mismatch:evil' + "`n" + '::error::pwn')), (URec 'pspb000001' $true $null)) @())
      expect = 'psp-diag cleanup phase=backstop ok=false exception=false stateProblems=0 vdisks=0 vdiskErrors=0 root=kept rootError=live-writers liveWriters=1 users=2 usersRemoved=1 usersNotPresent=0 userErrors=1' }
    [ordered]@{ id = 'tc-all-removed'; ph = 'in-run'; c = (CRec (RootRec $null $true) @((URec 'pspa000001' $true $null), (URec 'pspb000001' $true $null)) @() $true)
      expect = 'psp-diag cleanup phase=in-run ok=true exception=false stateProblems=0 vdisks=0 vdiskErrors=0 root=removed rootError=none liveWriters=0 users=2 usersRemoved=2 usersNotPresent=0 userErrors=0' }
    [ordered]@{ id = 'tc-phase-payload-nonbool'; ph = ('in-run' + "`n" + '::error::pwn'); c = (CRec (RootRec $null 'true') $null $null 'true')
      expect = "psp-diag cleanup phase=UNKNOWN ok=false exception=false stateProblems=0 vdisks=none vdiskErrors=none root=kept rootError=none liveWriters=0 $NoneTail" }
    [ordered]@{ id = 'tc-root-not-dict'; ph = 'backstop'; c = (CRec 'C:\secret ::error::pwn' $null $null)
      expect = "psp-diag cleanup phase=backstop ok=false exception=false stateProblems=0 vdisks=none vdiskErrors=none root=UNKNOWN rootError=UNKNOWN liveWriters=none $NoneTail" }
    [ordered]@{ id = 'tc-entries-not-dict'; ph = 'backstop'; c = (CRec $null @('pspa000001 ::error::pwn') @('C:\secret'))
      expect = 'psp-diag cleanup phase=backstop ok=false exception=false stateProblems=0 vdisks=1 vdiskErrors=1 root=none rootError=none liveWriters=none users=1 usersRemoved=0 usersNotPresent=0 userErrors=1' }
  )
  # Root error categories: each fixed source message maps to its enum; near misses and raw exceptions are UNKNOWN.
  $RootErrs = @(
    @($Fixed.R_ENUM, 'owner-unknown-enumeration'), @($Fixed.R_OWNER, 'owner-unknown-query'), @($Fixed.R_SID, 'owner-unknown-sid'),
    @('fixture root not fully removed (explicit cleanup failure)', 'not-fully-removed'), @('refusing unowned root C:\secret ::error::pwn', 'unowned-root'),
    @('refusing non-canonical root or root outside RUNNER_TEMP: C:\secret', 'non-canonical-root'), @('refusing reparse-point root C:\secret', 'reparse-root'),
    @('cannot enable SeBackupPrivilege (1300)', 'privilege'), @('refusing: link pair open 5/0', 'link-pair'), @('refusing: delete C:\secret: 5', 'link-pair'),
    @('refusing: something else ::error::pwn', 'UNKNOWN'), @(($Fixed.R_RV + ' '), 'UNKNOWN'), @($Fixed.R_RV.ToUpperInvariant(), 'UNKNOWN'), @([int]5, 'UNKNOWN'),
    @(('Exception calling "RemoveTree": C:\secret' + "`n" + '::error::pwn'), 'UNKNOWN')
  )
  for ($i = 0; $i -lt $RootErrs.Count; $i++) {
    $CCases += ,([ordered]@{ id = "tc-root-error-$i"; ph = 'backstop'; c = (CRec (RootRec $RootErrs[$i][0]) $null $null)
      expect = "psp-diag cleanup phase=backstop ok=false exception=false stateProblems=0 vdisks=none vdiskErrors=none root=kept rootError=$($RootErrs[$i][1]) liveWriters=0 $NoneTail" })
  }
  $CForbid = @('secret', 'evil', 'mock.exe', 'S-1-', 'pspa0', 'pspb0', 'RemoveTree', 'RUNNER_TEMP')
  # Verdict operand reader: valid '# psp-op/1' lines of every kind are re-emitted after the fixed prefix; every hostile
  # look-alike is only counted. Expected lines are written out literally here (independent of the reader's tables).
  function OpSum([string]$Tap, [int[]]$C) { "psp-diag verdict-op-summary tap=$Tap candidates=$($C[0]) accepted=$($C[1]) listed=$($C[2]) clipped=$($C[3]) malformed=$($C[4]) oversize=$($C[5]) duplicates=$($C[6]) indented=$($C[7]) errors=$($C[8]) trust=diagnostic-only" }
  $AllPrivs = @('SeAssignPrimaryTokenPrivilege', 'SeAuditPrivilege', 'SeBackupPrivilege', 'SeChangeNotifyPrivilege', 'SeCreateGlobalPrivilege', 'SeCreatePagefilePrivilege',
    'SeCreatePermanentPrivilege', 'SeCreateSymbolicLinkPrivilege', 'SeCreateTokenPrivilege', 'SeDebugPrivilege', 'SeDelegateSessionUserImpersonatePrivilege',
    'SeEnableDelegationPrivilege', 'SeImpersonatePrivilege', 'SeIncreaseBasePriorityPrivilege', 'SeIncreaseQuotaPrivilege', 'SeIncreaseWorkingSetPrivilege',
    'SeLoadDriverPrivilege', 'SeLockMemoryPrivilege', 'SeMachineAccountPrivilege', 'SeManageVolumePrivilege', 'SeProfileSingleProcessPrivilege', 'SeRelabelPrivilege',
    'SeRemoteShutdownPrivilege', 'SeRestorePrivilege', 'SeSecurityPrivilege', 'SeShutdownPrivilege', 'SeSyncAgentPrivilege', 'SeSystemEnvironmentPrivilege',
    'SeSystemProfilePrivilege', 'SeSystemtimePrivilege', 'SeTakeOwnershipPrivilege', 'SeTcbPrivilege', 'SeTimeZonePrivilege', 'SeTrustedCredManAccessPrivilege',
    'SeUndockPrivilege', 'SeUnsolicitedInputPrivilege')
  $OpV = @(
    'kind=priv who=A receipt=present shape=array whoamiExit=0 entries=5 enabled=2 disabled=3 otherState=0 unknownName=1 enabledUnknownName=1 enabledKnown=SeChangeNotifyPrivilege'
    ('kind=priv who=B receipt=present shape=array whoamiExit=0 entries=36 enabled=36 disabled=0 otherState=0 unknownName=0 enabledUnknownName=0 enabledKnown=' + ($AllPrivs -join ','))
    'kind=launch tag=helper-run receipt=present sidMatch=true ok=false mode=node-test nodeExit=1 error=false problems=2'
    'kind=helperrun receipt=present loaded=true loadStatus=ok loadReason=ok loadWinErr=0 loadError=false results=58 threw=0 abiBad=0 notRun=0 promise=0'
    'kind=bindseq seq=match entries=9 problems=1'
    'kind=bind tag=helper-run hits=1 user=true mode=true launched=true timedOut=false exit=1 launchError=none prerequisite=false self=present selfOk=false selfMode=true selfNodeExit=1'
    'kind=helper case=D_JUNCTION op=inspectDir result=present threw=false abiOk=true status=unavailable reason=open_failed winErr=5 created=none bytes=0 volId=false want=unsafe oracle=unsafe oracleReason=reparse oracleCode=none problems=3'
    'kind=helper case=UNKNOWN op=UNKNOWN result=absent threw=none abiOk=none status=none reason=none winErr=none created=none bytes=none volId=none want=error oracle=error oracleReason=open-error oracleCode=-2147483648 problems=1'
    'kind=readback test=contradict snapProblems=0 objects=400 skipped=8 aclMatch=380 aclDiffNonReparse=4 aclDiffReparse=8 aclUnavailNonReparse=0 aclUnavailReparse=0 aclErrPresent=0 hlMatch=200 hlDiff=0 hlReparse=4 hlExitNonzero=0 rpNotOracle=0 rpExitNonzero=0 contradictions=4 unproved=12'
    'kind=rbdiff test=unproved dir=3 file=1 owner=0 group=1 daclFlags=0 aceCount=0 aceOrder=0 aceFlags=2 aceSet=0 textOnly=1 unparsed=0 hlExits=1:3,-1:2 hlExitsOther=0 rpExits=none rpExitsOther=0'
    'kind=rbsplit test=contradict flagProtected=1 flagAutoInherited=2 flagIsNull=0 flagMissing=0 flagUnparsed=0 orderDenyRelChanged=1 orderDenyRelUnchanged=3 orderDenyRelUnknown=0 aclErrTypes=UnauthorizedAccessException:8,NotSupportedException:4 aclErrOther=1 aclErrAbsent=0'
    'kind=linkacl case=D_JUNCTION need=rcra link=present reparse=true owner=admins aAllow=none missing=none aDeny=0 adminAllow=2 otherAllow=0 otherDeny=0'
    'kind=linkacl case=F_UNDER_JUNCTION need=ra link=present reparse=true owner=adminUser aAllow=UNKNOWN missing=groupMembership aDeny=0 adminAllow=1 otherAllow=1 otherDeny=0'
    'kind=linkacl case=D_SYMLINK need=rcra link=present reparse=true owner=admins aAllow=UNKNOWN missing=sidA aDeny=0 adminAllow=2 otherAllow=0 otherDeny=0'
    'kind=rbcause test=unproved missGetacl=24 missOracle=4 missSideUnknown=0 missNonAclVolume=16 missOracleNull=8 missOther=3 missUnknown=1 errStream=12 errNonAclVolume=0 errOther=0 errUnknown=0 hlNzStream=4 hlNzNonAclVolume=20 hlNzOther=60 hlNzUnknown=1'
    'kind=rbstate test=contradict bindOk=3 bindStale=1 bindUnmeasured=2 nullAbsentAefa=1 nullAbsentNoAefa=0 nullPresent=0 nullUnknown=0 absentAbsentAefa=0 absentAbsentNoAefa=0 absentPresent=0 absentUnknown=0 presentAbsentAefa=0 presentAbsentNoAefa=1 presentPresent=0 presentUnknown=0 unknownAbsentAefa=0 unknownAbsentNoAefa=0 unknownPresent=0 unknownUnknown=1 aefaMasks=2032127:1,-1:1 aefaMasksOther=0 matchAefa=0 matchUnknown=4'
    'kind=streamjoin test=unproved aclRows=3 hlRows=2 joinMatch=1 joinDiff=1 joinUnproved=3 uManifest=0 uStreamRow=0 uHostRow=1 uOpen=0 uIdentity=0 uSddl=0 uBracket=2 uReadback=0'
    'kind=hlprobe test=unproved rows=7 streamBothOk=0 streamFfnErr=0 streamPlainErr=2 streamUnknown=0 nonAclBothOk=1 nonAclFfnErr=0 nonAclPlainErr=0 nonAclUnknown=0 otherBothOk=0 otherFfnErr=3 otherPlainErr=0 otherUnknown=1 unknownBothOk=0 unknownFfnErr=0 unknownPlainErr=0 unknownUnknown=0 plainErrs=0:4,5:2 plainErrsOther=0 plainUnknown=1 ffnErrs=0:1,5:3 ffnErrsOther=0 ffnUnknown=3'
    'kind=rbctrl test=unproved rows=28 uStale=0 uUnmeasured=1 uOracle=1 uGetacl=0 matched=2 xor=24 ctrlXor=4:23,1028:1 ctrlXorOther=0'
    'kind=aceraw test=contradict rows=16 bindOk=15 bindStale=0 bindUnmeasured=1 eqTrue=0 eqFalse=6 eqUnknown=0 neTrue=0 neFalse=8 neUnknown=0 unknownTrue=0 unknownFalse=1 unknownUnknown=0 neCount=0 uNoBinary=0 uOracleSddl=0 uGetAclDacl=0 uOracleDacl=0 uEmpty=0 uBounds=1 uError=0 uInvalid=0'
  )
  $OpP = '# psp-op/1 '
  $O1 = @('TAP version 13', '# Subtest: x', 'not ok 1 - x', '  ---', '  ...') + @(for ($i = 0; $i -lt $OpV.Count; $i++) { if ($i -eq 4) { $OpP + $OpV[$i] + "`r" } else { $OpP + $OpV[$i] } }) + @('1..1', '# tests 1', '# pass 0', '# fail 1')
  $O2 = @(
    ('    ' + $OpP + $OpV[0]), ("`t" + $OpP + $OpV[4])
    ($OpP + $OpV[0].Replace('enabledKnown=SeChangeNotifyPrivilege', 'enabledKnown=SeEvilPrivilege'))
    ($OpP + $OpV[2].Replace('nodeExit=1', ('nodeExit=1' + $Esc + '[31m')))
    ($OpP + 'kind=bindseq seq=match::error::pwn entries=9 problems=0'), ($OpP + 'kind=shell cmd=pwn'), ('# psp-op/2 ' + $OpV[4])
    ($OpP + 'kind=bindseq seq=match entries=9'), ($OpP + 'kind=bindseq entries=9 seq=match problems=0'), ($OpP + $OpV[2].Replace('nodeExit=1', 'nodeExit=99999999999'))
    ($OpP + $OpV[4]), ($OpP + 'kind=bindseq seq=differ entries=1 problems=5'), ($OpP + 'kind=priv who=B ' + ('x' * 1400)), ($OpP + 'kind=error'), ($OpP + 'kind=error extra=1')
    ($OpP + $OpV[1].Replace('enabledKnown=SeAssignPrimaryTokenPrivilege,', 'enabledKnown=SeChangeNotifyPrivilege,'))
    ($OpP + $OpV[9].Replace('hlExits=1:3,-1:2', 'hlExits=1:1,2:1,3:1,4:1,5:1')), ($OpP + 'kind=PRIV who=A'), ($OpP + $OpV[4] + ' '), ($OpP + $OpV[4].Replace(' seq=', '  seq='))
    ($OpP + $OpV[4].Replace('seq=match', 'seq=\#match')), ($OpP + $OpV[2].Replace('tag=helper-run', 'tag=S-1-5-21-1-2-3-1001'))
    ($OpP + $OpV[0].Replace('enabledKnown=SeChangeNotifyPrivilege', 'enabledKnown=sechangenotifyprivilege')), ($OpP + $OpV[6].Replace('case=D_JUNCTION', 'case=d_junction'))
    ($OpP + $OpV[8].Replace('objects=400', 'objects=100000')), ($OpP + $OpV[6]), ($OpP + $OpV[6].Replace('status=unavailable', 'status=ok')), ($OpP + 'kind=helper case=D_OK op=inspectDir')
    ($OpP + $OpV[2].Replace('sidMatch=true', 'sidMatch=yes')), ($OpP + $OpV[5] + ' extra=1')
    # rbsplit / linkacl: closed error-type histogram and closed link enums; raw SIDs, unlisted names, duplicates, lowercase,
    # over-long counts and missing fields are malformed; an UNKNOWN case is accepted as UNKNOWN; a repeated key is a duplicate.
    ($OpP + $OpV[10].Replace('NotSupportedException:4', 'EvilException:4'))
    ($OpP + $OpV[10].Replace('UnauthorizedAccessException:8,NotSupportedException:4', 'UnauthorizedAccessException:1,UnauthorizedAccessException:1'))
    ($OpP + $OpV[10].Replace('UnauthorizedAccessException:8', 'UnauthorizedAccessException:123456'))
    ($OpP + $OpV[10].Replace('UnauthorizedAccessException:8', 'unauthorizedaccessexception:8'))
    ($OpP + $OpV[11].Replace('owner=admins', 'owner=S-1-5-32-544')), ($OpP + $OpV[11].Replace('case=D_JUNCTION', 'case=D_OK'))
    ($OpP + $OpV[11].Replace('aAllow=none', 'aAllow=granted')), ($OpP + $OpV[11].Replace(' otherDeny=0', ''))
    ($OpP + 'kind=linkacl case=UNKNOWN need=UNKNOWN link=absent reparse=none owner=none aAllow=UNKNOWN missing=snapshot aDeny=0 adminAllow=0 otherAllow=0 otherDeny=0')
    ($OpP + $OpV[11]), ($OpP + $OpV[11])
    # rbcause / linkacl sidA: a valid and an UNKNOWN-test rbcause are accepted, a repeat is a duplicate; a missing or extra field,
    # an over-long count, a raw SID or raw path value and an unlisted or lowercase missing-input name are malformed.
    ($OpP + $OpV[14]), ($OpP + $OpV[14]), ($OpP + $OpV[14].Replace('test=unproved', 'test=UNKNOWN'))
    ($OpP + $OpV[14].Replace(' hlNzUnknown=1', '')), ($OpP + $OpV[14] + ' hlNzExtra=1'), ($OpP + $OpV[14].Replace('hlNzOther=60', 'hlNzOther=100000'))
    ($OpP + $OpV[14].Replace('test=unproved', 'test=S-1-5-21-1-2-3-1001')), ($OpP + $OpV[14].Replace('errStream=12', 'errStream=C:\fx\secret.bin:alt'))
    ($OpP + $OpV[13].Replace('missing=sidA', 'missing=sida')), ($OpP + $OpV[13].Replace('missing=sidA', 'missing=sidB'))
    # rbstate / streamjoin / hlprobe: a valid line of each and an UNKNOWN-test hlprobe are accepted, a repeat is a duplicate; a missing or
    # extra field, an unknown kind, a five-value or non-numeric histogram, an over-long count, a raw SID or path value are malformed;
    # an over-long line is oversize.
    ($OpP + $OpV[15]), ($OpP + $OpV[15]), ($OpP + $OpV[15].Replace(' matchUnknown=4', '')), ($OpP + $OpV[15] + ' rbExtra=1')
    ($OpP + $OpV[15].Replace('aefaMasks=2032127:1,-1:1', 'aefaMasks=1:1,2:1,3:1,4:1,5:1')), ($OpP + $OpV[15].Replace('aefaMasks=2032127:1,-1:1', 'aefaMasks=S-1-1-0'))
    ($OpP + $OpV[15].Replace('kind=rbstate', 'kind=rbstatex'))
    ($OpP + $OpV[16]), ($OpP + $OpV[16].Replace('joinMatch=1', 'joinMatch=100000')), ($OpP + $OpV[16].Replace('uHostRow=1', 'uHostRow=C:\fx\h.bin'))
    ($OpP + $OpV[17]), ($OpP + $OpV[17].Replace('test=unproved', 'test=UNKNOWN')), ($OpP + $OpV[17].Replace(' ffnUnknown=3', ''))
    ($OpP + $OpV[17].Replace('plainErrs=0:4,5:2', 'plainErrs=AccessDenied:5')), ($OpP + $OpV[17] + ' pad=' + ('x' * 1400))
    # rbctrl / aceraw: a valid line of each and an UNKNOWN-test aceraw are accepted, a repeat is a duplicate; a missing or extra
    # field, a five-value or hex histogram, an over-long count, a raw SID value, a non-enum test and an unknown kind are malformed.
    ($OpP + $OpV[18]), ($OpP + $OpV[18]), ($OpP + $OpV[18].Replace(' ctrlXorOther=0', '')), ($OpP + $OpV[18].Replace('ctrlXor=4:23,1028:1', 'ctrlXor=1:1,2:1,3:1,4:1,5:1'))
    ($OpP + $OpV[18].Replace('ctrlXor=4:23,1028:1', 'ctrlXor=0x0004:23')), ($OpP + $OpV[18].Replace('test=unproved', 'test=true'))
    ($OpP + $OpV[19]), ($OpP + $OpV[19].Replace('test=contradict', 'test=UNKNOWN')), ($OpP + $OpV[19] + ' rawExtra=1'), ($OpP + $OpV[19].Replace('eqFalse=6', 'eqFalse=100000'))
    ($OpP + $OpV[19].Replace('kind=aceraw', 'kind=acerawx')), ($OpP + $OpV[19].Replace('uBounds=1', 'uBounds=S-1-1-0'))
  )
  $OCases = @(
    [ordered]@{ id = 'to-valid-all-kinds'; rs = 'ok'; text = ($O1 -join "`n"); forbid = @('Subtest', 'not ok', 'TAP', '#')
      expect = @(@(OpSum 'ok' @(20, 20, 20, 0, 0, 0, 0, 0, 0)) + @($OpV | ForEach-Object { 'psp-diag verdict-op ' + $_ })) }
    [ordered]@{ id = 'to-hostile'; rs = 'ok'; text = ($O2 -join "`n"); forbid = @('pwn', 'SeEvil', 'S-1-', 'xxxx', 'sechangenotify', 'd_junction', 'PRIV', 'shell', '[31m', 'differ', 'status=ok', '100000', '99999999999', '#', 'extra', 'Evil', 'unauthorized', '123456', 'D_OK', 'granted', 'hlNzExtra', 'secret', 'sida', 'sidB', 'rbExtra', 'rbstatex', 'AccessDenied', 'h.bin', 'pad=', 'rawExtra', 'acerawx', '0x0004', 'test=true')
      expect = @((OpSum 'ok' @(76, 13, 13, 0, 54, 2, 6, 2, 1)), ('psp-diag verdict-op ' + $OpV[4]), ('psp-diag verdict-op ' + $OpV[6]),
        'psp-diag verdict-op kind=linkacl case=UNKNOWN need=UNKNOWN link=absent reparse=none owner=none aAllow=UNKNOWN missing=snapshot aDeny=0 adminAllow=0 otherAllow=0 otherDeny=0',
        ('psp-diag verdict-op ' + $OpV[11]), ('psp-diag verdict-op ' + $OpV[14]), ('psp-diag verdict-op ' + $OpV[14].Replace('test=unproved', 'test=UNKNOWN')),
        ('psp-diag verdict-op ' + $OpV[15]), ('psp-diag verdict-op ' + $OpV[16]), ('psp-diag verdict-op ' + $OpV[17]),
        ('psp-diag verdict-op ' + $OpV[17].Replace('test=unproved', 'test=UNKNOWN')), ('psp-diag verdict-op ' + $OpV[18]), ('psp-diag verdict-op ' + $OpV[19]),
        ('psp-diag verdict-op ' + $OpV[19].Replace('test=contradict', 'test=UNKNOWN'))) }
    [ordered]@{ id = 'to-too-many-lines'; rs = 'ok'; text = ($OpP + $OpV[4] + ("`n" * 50000)); forbid = @('bindseq')
      expect = @(OpSum 'too-many-lines' @(0, 0, 0, 0, 0, 0, 0, 0, 0)) }
    [ordered]@{ id = 'to-read-status-not-enum'; rs = "ok`n::error::pwn"; text = ($OpP + $OpV[4]); forbid = @('pwn', 'bindseq')
      expect = @(OpSum 'UNKNOWN' @(0, 0, 0, 0, 0, 0, 0, 0, 0)) }
    [ordered]@{ id = 'to-read-status-missing'; rs = 'missing'; text = ($OpP + $OpV[4]); forbid = @('bindseq')
      expect = @(OpSum 'missing' @(0, 0, 0, 0, 0, 0, 0, 0, 0)) }
    [ordered]@{ id = 'to-empty-ok'; rs = 'ok'; text = ''; forbid = @()
      expect = @(OpSum 'ok' @(0, 0, 0, 0, 0, 0, 0, 0, 0)) }
  )

  function Test-DiagLines($Out, [bool]$Thrown, [string[]]$Expect, [string[]]$Forbid, [string[]]$Patterns) {
    if ($Thrown) { 'formatter threw'; return }
    $o = @($Out)
    foreach ($l in $o) {
      if (-not ($l -is [string])) { 'non-string line'; continue }
      $okp = $false; foreach ($pt in $Patterns) { if ($l -cmatch $pt) { $okp = $true } }
      if (-not $okp) { "line outside the closed grammar (len=$($l.Length))" }
      if ($l -cmatch '[\x00-\x1f\x7f]') { 'control character in line' }
      if ($l.Contains('::')) { 'annotation marker in line' }
      foreach ($fw in $Forbid) { if ($l.Contains($fw)) { 'forbidden payload fragment echoed' } }
    }
    if (($o.Count -ne $Expect.Count) -or ((@($o | ForEach-Object { [string]$_ }) -join "`n") -cne ($Expect -join "`n"))) { "lines=$($o.Count) expected=$($Expect.Count) or text differs" }
  }
  $fmt = @(); $fmtFail = 0; $vRun = 0; $cRun = 0; $oRun = 0
  foreach ($vc in $VCases) {
    $out = $null; $thrown = $false
    try { $out = @(Format-PspVerdictDiag $vc.ne $vc.rs $vc.text $vc.by) } catch { $thrown = $true }
    $f = @(Test-DiagLines $out $thrown $vc.expect $vc.forbid @($DiagVerdictPattern, $DiagVerdictFailPattern))
    $vRun++
    Write-Host "formatter case=$($vc.id) lines=$(@($out).Count) fails=$($f.Count)"
    $fmt += ,([ordered]@{ id = $vc.id; lines = @($out).Count; ok = ($f.Count -eq 0) })
    if ($f.Count -gt 0) { $fmtFail++; foreach ($x in $f) { $Report.failures += (Limit "formatter $($vc.id) $x") } }
  }
  foreach ($cc in $CCases) {
    $out = $null; $thrown = $false
    try { $out = @(Format-PspCleanupDiag $cc.ph $cc.c) } catch { $thrown = $true }
    $f = @(Test-DiagLines $out $thrown @($cc.expect) $CForbid @($DiagCleanupPattern))
    $cRun++
    Write-Host "formatter case=$($cc.id) lines=$(@($out).Count) fails=$($f.Count)"
    $fmt += ,([ordered]@{ id = $cc.id; lines = @($out).Count; ok = ($f.Count -eq 0) })
    if ($f.Count -gt 0) { $fmtFail++; foreach ($x in $f) { $Report.failures += (Limit "formatter $($cc.id) $x") } }
  }
  foreach ($oc in $OCases) {
    $out = $null; $thrown = $false
    try { $out = @(Format-PspVerdictOpDiag $oc.rs $oc.text) } catch { $thrown = $true }
    $f = @(Test-DiagLines $out $thrown $oc.expect $oc.forbid @($DiagOpSummaryPattern, $DiagOpPattern))
    $oRun++
    Write-Host "formatter case=$($oc.id) lines=$(@($out).Count) fails=$($f.Count)"
    $fmt += ,([ordered]@{ id = $oc.id; lines = @($out).Count; ok = ($f.Count -eq 0) })
    if ($f.Count -gt 0) { $fmtFail++; foreach ($x in $f) { $Report.failures += (Limit "formatter $($oc.id) $x") } }
  }
  $Report.formatters = [ordered]@{ verdictCasesRun = $vRun; verdictCasesExpected = $VCases.Count; cleanupCasesRun = $cRun; cleanupCasesExpected = $CCases.Count
    operandCasesRun = $oRun; operandCasesExpected = $OCases.Count; casesFailed = $fmtFail; cases = $fmt }

  # ---- 7. post guards: still no host CIM module, mocks still bound, matrix complete ----
  $Report.postGuards = [ordered]@{ cimCmdletsLoaded = [bool](Get-Module -Name CimCmdlets); mocksBound = $true }
  foreach ($n in $MockNames) { $found = @(Get-Command -Name $n -ErrorAction SilentlyContinue); if (($found.Count -ne 1) -or ($found[0].CommandType -ne [System.Management.Automation.CommandTypes]::Function)) { $Report.postGuards.mocksBound = $false } }
  if ($Report.postGuards.cimCmdletsLoaded -or (-not $Report.postGuards.mocksBound)) { $Report.failures += 'post guard: CimCmdlets loaded or mock binding changed' }
  if ($cand.Count -ne $Cases.Count) { $Report.failures += 'candidate matrix incomplete' }
  if (@($Report.failures).Count -gt 50) { $Report.failures = @($Report.failures[0..49]) + @('... more failures truncated') }

  if (($vRun -ne $VCases.Count) -or ($cRun -ne $CCases.Count) -or ($oRun -ne $OCases.Count)) { $Report.failures += 'formatter matrix incomplete' }
  $pass = ($Report.negativeControl.verdict -ceq 'DEFECT-REPRODUCED') -and ($candFail -eq 0) -and ($cand.Count -eq $Cases.Count) -and (-not $Report.postGuards.cimCmdletsLoaded) -and $Report.postGuards.mocksBound -and
    ($fmtFail -eq 0) -and ($vRun -eq $VCases.Count) -and ($cRun -eq $CCases.Count) -and ($oRun -eq $OCases.Count)
  if ($pass) { $Report.status = 'PASS' } else { $Report.status = 'FAILED'; $Report.failure = 'see failures' }
  Write-Host ("OUTCOME status=$($Report.status) control=$($Report.negativeControl.verdict) candidateCases=$($cand.Count) candidateFailed=$candFail formatterCases=$($vRun + $cRun) operandFormatterCases=$oRun formatterFailed=$fmtFail failures=$(@($Report.failures).Count)")
  Write-Host (Save-Report)
  if ($pass) { exit 0 } else { exit 1 }
} catch {
  Fatal ('unhandled: ' + $_.Exception.Message)
}
