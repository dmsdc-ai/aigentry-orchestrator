#Requires -Version 5.1
# bootstrap-trust.test.ps1 - tester-owned self-test (#1167) of the trust-root predicate shared by the "Cleanup backstop"
# and "Export verified receipts" steps of .github/workflows/windows-private-storage-prototype.yml.
# - Extracts the predicate body from the ACTUAL workflow at runtime (no frozen copy): exactly two occurrences, byte-identical,
#   equal to the pinned sha256, in the expected cleanup/export context. Any drift fails closed before evaluation.
# - Parses the body with the PowerShell AST (no parse errors; only an allowlisted command/member surface) and evaluates the
#   AST's own script block against in-memory System.Security.AccessControl descriptors through a stubbed Get-Acl.
# - Reads no host ACL, item, account, VHD or process state and writes nothing. Any failed case exits 1.
param([string]$WorkflowPath = (Join-Path $PSScriptRoot '..\..\..\.github\workflows\windows-private-storage-prototype.yml'))
$ErrorActionPreference = 'Stop'

$ExpectedBodySha256 = 'e924c8381b206a8362a42da1e7686016425b2d83c51ed639b314b54d5e8b0442'
$ExpectedOccurrences = 2
$ExpectedBodyLines = 15
$StartMarker = '$sd = $null; $ok = $false'
$EndMarker = '} catch { $ok = $false }'
$ContextBefore = '$t = @(Get-Item -LiteralPath $p -Force)'
$Labels = @('cleanup', 'export')
$AllowedCommands = @('Get-Acl', 'Where-Object', 'ForEach-Object', 'Sort-Object')
$AllowedMembers = @('new', 'GetSecurityDescriptorBinaryForm')

function Fatal([string]$Message) { Write-Host "FATAL $Message"; exit 1 }
function Get-Sha256Hex([byte[]]$Bytes) {
  $h = [System.Security.Cryptography.SHA256]::Create()
  try { -join ($h.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) } finally { $h.Dispose() }
}

# ---- 1. source binding: exact body, exact occurrences, exact context ----
if (-not (Test-Path -LiteralPath $WorkflowPath -PathType Leaf)) { Fatal "workflow not found: $WorkflowPath" }
$text = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $WorkflowPath).ProviderPath, (New-Object System.Text.UTF8Encoding($false, $true)))
if ($text.Contains("`r")) { Fatal 'workflow contains CR bytes (expected LF checkout)' }
$lines = $text.Split([char]10)
$starts = @(for ($i = 0; $i -lt $lines.Length; $i++) { if ($lines[$i].Trim() -ceq $StartMarker) { $i } })
if ($starts.Count -ne $ExpectedOccurrences) { Fatal "predicate start marker occurs $($starts.Count) times, expected $ExpectedOccurrences" }
$bodies = @()
for ($n = 0; $n -lt $starts.Count; $n++) {
  $s = $starts[$n]
  $indent = $lines[$s].Length - $lines[$s].TrimStart(' ').Length
  $e = $s
  while (($e -lt $lines.Length) -and ($lines[$e].Trim() -cne $EndMarker)) { $e++ }
  if ($e -ge $lines.Length) { Fatal "occurrence $n has no end marker" }
  if (($e - $s + 1) -ne $ExpectedBodyLines) { Fatal "occurrence $n has $($e - $s + 1) lines, expected $ExpectedBodyLines" }
  $chunk = @(for ($k = $s; $k -le $e; $k++) {
    if (($lines[$k].Length -lt $indent) -or ($lines[$k].Substring(0, $indent).Trim(' ').Length -ne 0)) { Fatal "occurrence $n line $($k + 1) breaks indentation" }
    $lines[$k].Substring($indent)
  })
  $body = $chunk -join "`n"
  $sha = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($body))
  if ($sha -cne $ExpectedBodySha256) { Fatal "occurrence $n (line $($s + 1)) body sha256 $sha != pinned $ExpectedBodySha256" }
  if (($s -lt 5) -or ($lines[$s - 5].Trim() -cne $ContextBefore)) { Fatal "occurrence $n is not preceded by the bound Get-Item line" }
  $refusal = 'if (-not $ok) { Write-Output "' + $Labels[$n] + ': refusing unverified trust root $($t[0].FullName) $sd"; exit 1 }'
  if ((($e + 1) -ge $lines.Length) -or ($lines[$e + 1].Trim() -cne $refusal)) { Fatal "occurrence $n is not followed by the $($Labels[$n]) refusal gate" }
  $bodies += $body
  Write-Output "source ok occurrence=$n label=$($Labels[$n]) lines=$($s + 1)-$($e + 1) sha256=$sha"
}
if ($bodies[0] -cne $bodies[1]) { Fatal 'cleanup and export predicate bodies differ' }

# ---- 2. AST parse of the extracted body; restrict its command/member surface ----
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($bodies[0], [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { Fatal ('predicate parse errors: ' + (($parseErrors | ForEach-Object { $_.Message }) -join '; ')) }
$cmdAsts = @($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true))
foreach ($c in $cmdAsts) {
  $name = $c.GetCommandName()
  if (($null -eq $name) -or ($AllowedCommands -cnotcontains $name) -or ($c.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown)) { Fatal "predicate invokes non-allowlisted command: $($c.Extent.Text)" }
}
if (@($cmdAsts | Where-Object { $_.GetCommandName() -ceq 'Get-Acl' }).Count -ne 1) { Fatal 'predicate must call Get-Acl exactly once' }
foreach ($m in @($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true))) {
  if ($AllowedMembers -cnotcontains $m.Member.Extent.Text) { Fatal "predicate invokes non-allowlisted member: $($m.Extent.Text)" }
}
$Predicate = $ast.GetScriptBlock()
Write-Output "ast ok commands=$($cmdAsts.Count) parseErrors=0"

# ---- 3. harness: evaluate the extracted predicate with a stubbed Get-Acl in an isolated function scope ----
function Invoke-Predicate {
  param([object[]]$Items, [string]$Leaf, [string]$StubMode, $StubAcl)
  $script:AclCalls = 0
  if ($Leaf) { [Environment]::SetEnvironmentVariable('PSP_TRUST_LEAF', $Leaf, 'Process') } else { [Environment]::SetEnvironmentVariable('PSP_TRUST_LEAF', $null, 'Process') }
  function Get-Acl {
    param([string]$LiteralPath)
    $script:AclCalls++
    if ($StubMode -ceq 'throw') { throw 'stub Get-Acl: access denied' }
    if ($StubMode -ceq 'null') { return }
    $StubAcl
  }
  $t = $Items
  $sd = 'unset'; $ok = 'unset'
  $null = . $Predicate
  [pscustomobject]@{ Ok = $ok; Calls = $script:AclCalls }
}

$Leaf0 = 'psp1167-trust-0123456789abcdef'
$DomUsers = 'S-1-5-21-1643835476-1616584234-1346609752-513'   # observed primary group, CI 37226598786
$DomUser = 'S-1-5-21-1643835476-1616584234-1346609752-1001'
$Observed = "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
# PS 5.1 enum construction. CI 37228188094 threw InvalidCastException on the former line here:
#   $OICI = [int]([System.Security.AccessControl.AceFlags]::ObjectInherit -bor [System.Security.AccessControl.AceFlags]::ContainerInherit)
# AceFlags and AceType are byte-backed enums. Each former/predicate form is probed in memory and only reported (value or
# exception, never trusted). Fixtures use .value__ for enum->int and [Enum]::ToObject for int->enum; their bit values must
# match the ACE header bytes .NET writes for SDDL OICI, or the self-test stops before any case is built.
$AF = [System.Security.AccessControl.AceFlags]
$AT = [System.Security.AccessControl.AceType]
function Probe([string]$Name, [scriptblock]$Expr) {
  try { $v = & $Expr; Write-Output "probe $Name => $v [$(if ($null -eq $v) { 'null' } else { $v.GetType().FullName })]" }
  catch { Write-Output "probe $Name => $($_.Exception.GetType().FullName): $($_.Exception.Message)" }
}
$SddlAce = [System.Security.AccessControl.RawSecurityDescriptor]::new('D:P(A;OICI;FA;;;SY)').DiscretionaryAcl[0]
Probe 'former-selftest-96 [int](AceFlags::OI -bor AceFlags::CI)' { [int]([System.Security.AccessControl.AceFlags]::ObjectInherit -bor [System.Security.AccessControl.AceFlags]::ContainerInherit) }
Probe 'previous-predicate-form [int]($af::OI -bor $af::CI)' { $af = [System.Security.AccessControl.AceFlags]; [int]($af::ObjectInherit -bor $af::ContainerInherit) }
Probe 'bor-only $AF::OI -bor $AF::CI' { $AF::ObjectInherit -bor $AF::ContainerInherit }
Probe 'cast-only [int]$AF::OI' { [int]$AF::ObjectInherit }
Probe 'predicate-form [int]$_.AceFlags (SDDL OICI ace)' { [int]$SddlAce.AceFlags }
Probe 'predicate-form AceType -eq AccessAllowed' { $SddlAce.AceType -eq [System.Security.AccessControl.AceType]::AccessAllowed }
Probe 'former-Ace-helper [AceFlags][int]3' { [System.Security.AccessControl.AceFlags]([int]3) }
Probe 'former-N-T03 [AceType]17' { [System.Security.AccessControl.AceType]17 }
Probe 'ControlFlags -bor (P08, predicate $need)' { [int]([System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent -bor [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) }
Probe 'FileAttributes -bor (N-I04)' { [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint }
function AceFlagsOf([int]$Value) { [System.Enum]::ToObject($AF, [byte]$Value) }
function HeaderOf($Ace) { $b = New-Object byte[] $Ace.BinaryLength; $Ace.GetBinaryForm($b, 0); , $b }
$OICI = [int]$AF::ObjectInherit.value__ -bor [int]$AF::ContainerInherit.value__
$sddlHdr = HeaderOf $SddlAce
$builtHdr = HeaderOf ([System.Security.AccessControl.CommonAce]::new((AceFlagsOf $OICI), [System.Security.AccessControl.AceQualifier]::AccessAllowed, 0x1F01FF,
  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), $false, $null))
$customAce17 = [System.Security.AccessControl.CustomAce]::new([System.Enum]::ToObject($AT, [byte]17), (AceFlagsOf $OICI), [byte[]](1, 1, 0, 0, 0, 0, 0, 16))
$customHdr = HeaderOf $customAce17
if (($OICI -isnot [int]) -or ($OICI -ne 3) -or ($sddlHdr[0] -ne 0) -or ($sddlHdr[1] -ne $OICI) -or ($SddlAce.AceFlags.value__ -ne $OICI) -or
    ($builtHdr[0] -ne 0) -or ($builtHdr[1] -ne $OICI) -or ((AceFlagsOf $OICI).value__ -ne $OICI) -or
    ((AceFlagsOf ($OICI -bor 0x40)).value__ -ne ($OICI -bor $AF::SuccessfulAccess.value__)) -or ((AceFlagsOf ($OICI -bor 0x80)).value__ -ne ($OICI -bor $AF::FailedAccess.value__)) -or
    ((AceFlagsOf ($OICI -bor 0x10)).value__ -ne ($OICI -bor $AF::Inherited.value__)) -or ($customHdr[0] -ne 17) -or ($customHdr[1] -ne $OICI) -or ($customAce17.AceType.value__ -ne 17)) {
  Fatal "enum construction mismatch OICI=$OICI sddlHdr=$($sddlHdr[0]),$($sddlHdr[1]) builtHdr=$($builtHdr[0]),$($builtHdr[1]) customHdr=$($customHdr[0]),$($customHdr[1])"
}
Write-Output "enum ok OICI=$OICI sddlHdr=$($sddlHdr[0]),$($sddlHdr[1]) builtHdr=$($builtHdr[0]),$($builtHdr[1]) customHdr=$($customHdr[0]),$($customHdr[1])"
$FA = 0x1F01FF
$CF = [System.Security.AccessControl.ControlFlags]

function Sid([string]$s) { New-Object System.Security.Principal.SecurityIdentifier($s) }
function New-FakeDir([string]$Name = $Leaf0, [bool]$Container = $true, [IO.FileAttributes]$Attr = [IO.FileAttributes]::Directory) {
  [pscustomobject]@{ FullName = "X:\psp1167-selftest-not-a-path\$Name"; Name = $Name; PSIsContainer = $Container; Attributes = $Attr }
}
function New-FakeAcl([byte[]]$Bytes, [string]$Sddl) {
  $o = [pscustomobject]@{ Sddl = $Sddl; Bytes = $Bytes }
  $o | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptorBinaryForm -Value { , ([byte[]]$this.Bytes) }
  $o
}
function Get-SdBytes($Rsd) { $b = New-Object byte[] $Rsd.BinaryLength; $Rsd.GetBinaryForm($b, 0); , $b }
function SddlBytes([string]$Sddl) { Get-SdBytes ([System.Security.AccessControl.RawSecurityDescriptor]::new($Sddl)) }
function Ace([string]$Sid, [int]$Flags = $OICI, [int]$Mask = $FA, [string]$Qualifier = 'AccessAllowed', [bool]$Callback = $false) {
  [System.Security.AccessControl.CommonAce]::new((AceFlagsOf $Flags), [System.Security.AccessControl.AceQualifier]$Qualifier, $Mask, (Sid $Sid), $Callback, $null)
}
function PartsBytes {
  param([int]$Flags = [int]$CF::DiscretionaryAclProtected, [string]$Owner = 'S-1-5-32-544', [string]$Group = $DomUsers, [object[]]$Aces = @(), [switch]$NoDacl, [switch]$EmptySacl, [byte]$Revision = 2)
  $dacl = $null; $sacl = $null
  if (-not $NoDacl) {
    $dacl = New-Object System.Security.AccessControl.RawAcl($Revision, [Math]::Max(1, $Aces.Count))
    for ($i = 0; $i -lt $Aces.Count; $i++) { $dacl.InsertAce($i, $Aces[$i]) }
    $Flags = $Flags -bor [int]$CF::DiscretionaryAclPresent
  }
  if ($EmptySacl) { $sacl = New-Object System.Security.AccessControl.RawAcl(2, 1); $Flags = $Flags -bor [int]$CF::SystemAclPresent }
  $o = if ($Owner) { Sid $Owner } else { $null }
  $g = if ($Group) { Sid $Group } else { $null }
  Get-SdBytes ([System.Security.AccessControl.RawSecurityDescriptor]::new([System.Security.AccessControl.ControlFlags]$Flags, $o, $g, $sacl, $dacl))
}
function Patch([byte[]]$Bytes, [int]$SetControl = 0, [int]$ClearControl = 0, [int]$At = -1, [byte[]]$Put = $null) {
  $c = [byte[]]$Bytes.Clone()
  $v = (([int]$c[2] -bor ([int]$c[3] -shl 8)) -bor $SetControl) -band (-bnot $ClearControl) -band 0xFFFF
  $c[2] = [byte]($v -band 0xFF); $c[3] = [byte](($v -shr 8) -band 0xFF)
  if ($At -ge 0) { [Array]::Copy($Put, 0, $c, $At, $Put.Length) }
  , $c
}
function Slice([byte[]]$Bytes, [int]$Count) { $c = New-Object byte[] $Count; [Array]::Copy($Bytes, $c, $Count); , $c }

$Cases = New-Object System.Collections.ArrayList
function Add-Case {
  param([string]$Name, [bool]$Expect, [byte[]]$Bytes = $null, [string]$Sddl = '', [object[]]$Items = @(New-FakeDir), [string]$Leaf = $Leaf0,
        [string]$Mode = 'bytes', $AclObject = $null, [bool]$ParseOk = $true, [scriptblock]$Sanity = $null)
  $null = $Cases.Add([pscustomobject]@{ Name = $Name; Expect = $Expect; Bytes = $Bytes; Sddl = $Sddl; Items = $Items; Leaf = $Leaf; Mode = $Mode; AclObject = $AclObject; ParseOk = $ParseOk; Sanity = $Sanity })
}
$Two = { param($p) ($p.Owner.Value -ceq 'S-1-5-32-544') -and ($null -ne $p.DiscretionaryAcl) -and ($p.DiscretionaryAcl.Count -eq 2) }

# ---- 4. positives (must be accepted; no widening beyond the documented shape) ----
$ObsBytes = SddlBytes $Observed
Add-Case 'P01 observed CI O:BAG:<domain>-513D:P SY,BA' $true -Bytes $ObsBytes -Sddl $Observed
Add-Case 'P02 observed with D:PAI' $true -Bytes (SddlBytes "O:BAG:${DomUsers}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'P03 D:P ACE order swap BA,SY' $true -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)")
Add-Case 'P04 D:PAI ACE order swap BA,SY' $true -Bytes (SddlBytes "O:BAG:${DomUsers}D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)")
Add-Case 'P05 setup-authored O:BAD:PAI (no group)' $true -Bytes (SddlBytes 'O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
Add-Case 'P06 primary group Everyone is ignored' $true -Bytes (SddlBytes 'O:BAG:WDD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
Add-Case 'P07 parts-built protected SY,BA' $true -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18'), (Ace 'S-1-5-32-544')))
Add-Case 'P08 parts-built protected+AI BA,SY' $true -Bytes (PartsBytes -Flags ([int]($CF::DiscretionaryAclProtected -bor $CF::DiscretionaryAclAutoInherited)) -Aces @((Ace 'S-1-5-32-544'), (Ace 'S-1-5-18')))
$ds1 = New-Object System.Security.AccessControl.DirectorySecurity; $ds1.SetSecurityDescriptorSddlForm($Observed)
Add-Case 'P09 in-memory DirectorySecurity of observed SDDL' $true -Mode 'object' -AclObject $ds1
$ds2 = New-Object System.Security.AccessControl.DirectorySecurity; $ds2.SetSecurityDescriptorSddlForm('O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
Add-Case 'P10 in-memory DirectorySecurity of O:BAD:PAI' $true -Mode 'object' -AclObject $ds2

# ---- 5. item / leaf negatives (descriptor is the accepted P01) ----
Add-Case 'N-I01 zero items' $false -Bytes $ObsBytes -Items @()
Add-Case 'N-I02 two items' $false -Bytes $ObsBytes -Items @((New-FakeDir), (New-FakeDir))
Add-Case 'N-I03 not a directory' $false -Bytes $ObsBytes -Items @(New-FakeDir -Container $false -Attr ([IO.FileAttributes]::Archive))
Add-Case 'N-I04 reparse-point directory' $false -Bytes $ObsBytes -Items @(New-FakeDir -Attr ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))
Add-Case 'N-I05 leaf differs in case' $false -Bytes $ObsBytes -Items @(New-FakeDir -Name $Leaf0.ToUpperInvariant())
Add-Case 'N-I06 other leaf' $false -Bytes $ObsBytes -Items @(New-FakeDir -Name 'psp1167-trust-fedcba9876543210')
Add-Case 'N-I07 leaf with suffix' $false -Bytes $ObsBytes -Items @(New-FakeDir -Name "$Leaf0.x")
Add-Case 'N-I08 binding env unset' $false -Bytes $ObsBytes -Leaf ''

# ---- 6. owner negatives ----
Add-Case 'N-O01 owner SYSTEM' $false -Bytes (SddlBytes "O:SYG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'N-O02 owner Users' $false -Bytes (SddlBytes "O:BUG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'N-O03 owner domain user' $false -Bytes (SddlBytes "O:${DomUser}G:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'N-O04 owner Everyone' $false -Bytes (SddlBytes "O:WDG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'N-O05 owner absent' $false -Bytes (PartsBytes -Owner '' -Aces @((Ace 'S-1-5-18'), (Ace 'S-1-5-32-544'))) -Sanity { param($p) $null -eq $p.Owner }
Add-Case 'N-O06 owner/group swapped (BA only as group)' $false -Bytes (SddlBytes "O:${DomUsers}G:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")

# ---- 7. DACL presence / protection negatives ----
Add-Case 'N-D01 no DACL' $false -Bytes (PartsBytes -NoDacl) -Sanity { param($p) $null -eq $p.DiscretionaryAcl }
Add-Case 'N-D02 protected NULL DACL (NO_ACCESS_CONTROL)' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:PNO_ACCESS_CONTROL") -Sanity { param($p) $null -eq $p.DiscretionaryAcl }
Add-Case 'N-D03 unprotected DACL' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'N-D04 AI without P' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'N-D05 protected empty DACL' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P") -Sanity { param($p) ($null -ne $p.DiscretionaryAcl) -and ($p.DiscretionaryAcl.Count -eq 0) }
Add-Case 'N-D06 PD cleared on PAI bytes' $false -Bytes (Patch (SddlBytes "O:BAG:${DomUsers}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)") -ClearControl 0x1000)
Add-Case 'N-D07 DP cleared' $false -Bytes (Patch $ObsBytes -ClearControl 0x0004)
Add-Case 'N-D08 SACL present (empty)' $false -Bytes (PartsBytes -EmptySacl -Aces @((Ace 'S-1-5-18'), (Ace 'S-1-5-32-544'))) -Sanity { param($p) $null -ne $p.SystemAcl }

# ---- 8. every other single control bit on the accepted bytes (DP/SR/PD/AI are the allowed set; SP is N-D08) ----
$BitNames = @{ 0x0001 = 'OwnerDefaulted'; 0x0002 = 'GroupDefaulted'; 0x0008 = 'DaclDefaulted'; 0x0020 = 'SaclDefaulted'; 0x0040 = 'DaclUntrusted';
  0x0080 = 'ServerSecurity'; 0x0100 = 'DaclAutoInheritRequired'; 0x0200 = 'SaclAutoInheritRequired'; 0x0800 = 'SaclAutoInherited'; 0x2000 = 'SaclProtected'; 0x4000 = 'RMControlValid' }
foreach ($bit in @(0x0001, 0x0002, 0x0008, 0x0020, 0x0040, 0x0080, 0x0100, 0x0200, 0x0800, 0x2000, 0x4000)) {
  $want = $bit
  Add-Case ('N-C{0:X4} control {1}' -f $bit, $BitNames[$bit]) $false -Bytes (Patch $ObsBytes -SetControl $bit) -Sanity ([scriptblock]::Create("param(`$p) (([int]`$p.ControlFlags -band $want) -eq $want) -and (`$p.DiscretionaryAcl.Count -eq 2)"))
}

# ---- 9. ACE set negatives (count / SIDs / duplicates / extra / deny) ----
Add-Case 'N-A01 only SY' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)")
Add-Case 'N-A02 only BA' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;BA)")
Add-Case 'N-A03 extra Users read' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)")
Add-Case 'N-A04 extra Everyone FA' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;WD)")
Add-Case 'N-A05 duplicate SY,SY' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;SY)") -Sanity $Two
Add-Case 'N-A06 duplicate BA,BA' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-A07 foreign Everyone replaces BA' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)") -Sanity $Two
Add-Case 'N-A08 foreign Authenticated Users replaces SY' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;AU)(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-A09 foreign domain user replaces SY' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;${DomUser})(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-A10 SY,BA,SY triple' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)")
Add-Case 'N-A11 leading deny Everyone + SY,BA' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(D;OICI;FA;;;WD)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
Add-Case 'N-A12 SY deny + BA allow' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(D;OICI;FA;;;SY)(A;OICI;FA;;;BA)") -Sanity $Two

# ---- 10. ACE type negatives (count 2, SIDs SY+BA; only the type is wrong) ----
Add-Case 'N-T01 callback allow SY' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18' -Callback $true), (Ace 'S-1-5-32-544'))) -Sanity $Two
$objAce = [System.Security.AccessControl.ObjectAce]::new((AceFlagsOf $OICI), [System.Security.AccessControl.AceQualifier]::AccessAllowed, $FA, (Sid 'S-1-5-32-544'),
  [System.Security.AccessControl.ObjectAceFlags]::ObjectAceTypePresent, [guid]'bf967aba-0de6-11d0-a285-00aa003049e2', [guid]::Empty, $false, $null)
Add-Case 'N-T02 object allow BA' $false -Bytes (PartsBytes -Revision 4 -Aces @((Ace 'S-1-5-18'), $objAce)) -Sanity $Two
$customAce = [System.Security.AccessControl.CustomAce]::new([System.Enum]::ToObject($AT, [byte]17), (AceFlagsOf $OICI), [byte[]](1, 1, 0, 0, 0, 0, 0, 16))
Add-Case 'N-T03 unknown ACE type 0x11 + SY' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18'), $customAce)) -Sanity { param($p) ($p.Owner.Value -ceq 'S-1-5-32-544') -and ($p.DiscretionaryAcl.Count -eq 2) }
Add-Case 'N-T04 audit-type ACE SY in DACL' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18' -Flags ($OICI -bor 0x40) -Qualifier 'SystemAudit'), (Ace 'S-1-5-32-544'))) -Sanity $Two
Add-Case 'N-T05 callback allow BA' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18'), (Ace 'S-1-5-32-544' -Callback $true))) -Sanity $Two

# ---- 11. ACE flag negatives ----
Add-Case 'N-F01 SY inherited (ID)' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICIID;FA;;;SY)(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-F02 SY OI only' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OI;FA;;;SY)(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-F03 BA CI only' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;CI;FA;;;BA)") -Sanity $Two
Add-Case 'N-F04 SY OICI+NP' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICINP;FA;;;SY)(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-F05 BA OICI+IO' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICIIO;FA;;;BA)") -Sanity $Two
Add-Case 'N-F06 SY no inheritance flags' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;;FA;;;SY)(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-F07 BA OICI+SuccessfulAccess' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18'), (Ace 'S-1-5-32-544' -Flags ($OICI -bor 0x40)))) -Sanity $Two
Add-Case 'N-F08 SY OICI+FailedAccess' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18' -Flags ($OICI -bor 0x80)), (Ace 'S-1-5-32-544'))) -Sanity $Two

# ---- 12. access mask negatives ----
Add-Case 'N-M01 SY FA minus one bit' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;0x1f01fe;;;SY)(A;OICI;FA;;;BA)") -Sanity $Two
Add-Case 'N-M02 BA GENERIC_ALL' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;GA;;;BA)") -Sanity $Two
Add-Case 'N-M03 SY FA|GENERIC_ALL' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18' -Mask ($FA -bor 0x10000000)), (Ace 'S-1-5-32-544'))) -Sanity $Two
Add-Case 'N-M04 BA FA|ACCESS_SYSTEM_SECURITY' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18'), (Ace 'S-1-5-32-544' -Mask ($FA -bor 0x01000000)))) -Sanity $Two
Add-Case 'N-M05 SY FA|MAXIMUM_ALLOWED' $false -Bytes (PartsBytes -Aces @((Ace 'S-1-5-18' -Mask ($FA -bor 0x02000000)), (Ace 'S-1-5-32-544'))) -Sanity $Two
Add-Case 'N-M06 BA read-only' $false -Bytes (SddlBytes "O:BAG:${DomUsers}D:P(A;OICI;FA;;;SY)(A;OICI;FR;;;BA)") -Sanity $Two

# ---- 13. fail-closed: unreadable / malformed ----
$thrower = [pscustomobject]@{ Sddl = $Observed }
$thrower | Add-Member -MemberType ScriptMethod -Name GetSecurityDescriptorBinaryForm -Value { throw 'stub: binary form unavailable' }
Add-Case 'N-E01 Get-Acl throws' $false -Mode 'throw'
Add-Case 'N-E02 Get-Acl returns nothing' $false -Mode 'null'
Add-Case 'N-E03 binary form throws' $false -Mode 'object' -AclObject $thrower
Add-Case 'N-E04 empty bytes' $false -Bytes (New-Object byte[] 0) -ParseOk $false
Add-Case 'N-E05 one byte' $false -Bytes ([byte[]](1)) -ParseOk $false
Add-Case 'N-E06 header only (19 bytes)' $false -Bytes (Slice $ObsBytes 19) -ParseOk $false
Add-Case 'N-E07 truncated by 4 bytes' $false -Bytes (Slice $ObsBytes ($ObsBytes.Length - 4)) -ParseOk $false
Add-Case 'N-E08 revision 2' $false -Bytes (Patch $ObsBytes -At 0 -Put ([byte[]](2))) -ParseOk $false
Add-Case 'N-E09 SelfRelative cleared' $false -Bytes (Patch $ObsBytes -ClearControl 0x8000) -ParseOk $false
Add-Case 'N-E10 owner offset past end' $false -Bytes (Patch $ObsBytes -At 4 -Put ([BitConverter]::GetBytes([int]0xFFFF))) -ParseOk $false
Add-Case 'N-E11 DACL offset past end' $false -Bytes (Patch $ObsBytes -At 16 -Put ([BitConverter]::GetBytes([int]0xFFFF))) -ParseOk $false
$daclOff = [BitConverter]::ToInt32($ObsBytes, 16)
Add-Case 'N-E12 DACL AceCount 3 with 2 ACEs' $false -Bytes (Patch $ObsBytes -At ($daclOff + 4) -Put ([byte[]](3, 0))) -ParseOk $false

# ---- 14. run ----
$pass = 0; $fail = 0; $pos = 0; $neg = 0
foreach ($c in $Cases) {
  if ($c.Expect) { $pos++ } else { $neg++ }
  $acl = $null
  if ($c.Mode -ceq 'bytes') {
    if ($c.ParseOk) {
      try {
        $parsed = [System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$c.Bytes, 0)
        if (($null -ne $c.Sanity) -and (-not (& $c.Sanity $parsed))) { Write-Output "not ok - $($c.Name): fixture sanity failed"; $fail++; continue }
      } catch { Write-Output "not ok - $($c.Name): fixture does not parse: $($_.Exception.Message)"; $fail++; continue }
    }
    $acl = New-FakeAcl $c.Bytes $c.Sddl
  } elseif ($c.Mode -ceq 'object') { $acl = $c.AclObject }
  try { $res = Invoke-Predicate -Items $c.Items -Leaf $c.Leaf -StubMode $c.Mode -StubAcl $acl }
  catch { Write-Output "not ok - $($c.Name): exception escaped the predicate: $($_.Exception.Message)"; $fail++; continue }
  if (-not ($res.Ok -is [bool])) { Write-Output "not ok - $($c.Name): predicate left non-boolean ok=$($res.Ok)"; $fail++ }
  elseif ($res.Ok -ne $c.Expect) { Write-Output "not ok - $($c.Name): expected accept=$($c.Expect) got accept=$($res.Ok)"; $fail++ }
  elseif ($res.Calls -ne 1) { Write-Output "not ok - $($c.Name): stub Get-Acl called $($res.Calls) times"; $fail++ }
  else { Write-Output "ok - $($c.Name) accept=$($res.Ok)"; $pass++ }
}
[Environment]::SetEnvironmentVariable('PSP_TRUST_LEAF', $null, 'Process')
Write-Output "summary cases=$($Cases.Count) positives=$pos negatives=$neg pass=$pass fail=$fail ps=$($PSVersionTable.PSVersion) clr=$($PSVersionTable.CLRVersion)"
if (($fail -ne 0) -or ($pass -ne $Cases.Count) -or ($pos -lt 10) -or ($neg -lt 70)) { Write-Output 'bootstrap-trust self-test FAILED'; exit 1 }
Write-Output 'bootstrap-trust self-test passed'
exit 0
