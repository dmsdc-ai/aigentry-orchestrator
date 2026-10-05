# rawacl-api.selftest.ps1 - tester-authored (nv1167agg-tester, task 1167). Test-only; NOT the candidate's product code and NOT a
# copy of its predicate. A focused IN-MEMORY probe of the exact .NET APIs the candidate Get-PspSnapshot rbctrl/aceraw block uses:
#   RawSecurityDescriptor(string) and (byte[], 0), .DiscretionaryAcl, RawAcl.Count / .BinaryLength / .Item(index),
#   GenericAce.BinaryLength / GetBinaryForm(byte[], 0), [byte[]]::new(n), [int]<ControlFlags>, ObjectSecurity.AreAccessRulesCanonical,
#   ObjectSecurity.GetSecurityDescriptorBinaryForm() on fake in-memory FileSecurity / DirectorySecurity objects.
# No path, file, ACL, account, token, privilege, process, registry or network access: synthetic SIDs and SDDL constants only
# (no account-name lookup), objects built by the parameterless constructors + SetSecurityDescriptorSddlForm on the fake object.
# No P/Invoke, no Add-Type. An unsupported/throwing exact API FAILS its case (no skip, no fallback, no custom parser).
# Two row kinds:
#   case      hard assertions (API exists and behaves; counts, bytes, typed flags; binary-format facts) -> FAIL on any miss.
#   srcexpect informational comparison with published .NET Framework reference source (microsoft/referencesource @ main; the CI
#             CLR build is UNVERIFIED); 'DIFF' is reported and counted but is NOT a failure, and 'match' is NOT proof of CLR behaviour.
#             CommonAcl may sort/compact on construction (acl.cs CommonAcl ctor), so a Get-Acl-style rendering is never assumed to be
#             raw on-disk order.
# Output: closed tokens and bounded integers only (no SDDL, SID, message text). Exit 0 only if every case passed and the case count
# equals $ExpectedCases; otherwise exit 1. PowerShell 5.1 compatible.
[CmdletBinding()] param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedCases = 18
$script:Cases = 0; $script:Pass = 0; $script:Fail = 0; $script:SrcMatch = 0; $script:SrcDiff = 0
$script:Log = New-Object 'System.Collections.Generic.List[string]'
$MaxLog = 96

function Add-Log([string]$Line) { if ($script:Log.Count -lt $MaxLog) { $script:Log.Add($Line) } }
function Assert-True([bool]$Cond, [string]$Token) { if (-not $Cond) { throw [System.InvalidOperationException]::new('assert:' + $Token) } }
function Test-SrcExpect([string]$Id, [string]$Check, [bool]$Cond) {
  if ($Cond) { $script:SrcMatch++ } else { $script:SrcDiff++ }
  Add-Log ('rawacl-probe srcexpect case=' + $Id + ' check=' + $Check + ' result=' + $(if ($Cond) { 'match' } else { 'DIFF' }))
}
function Invoke-Case([string]$Id, [scriptblock]$Body) {
  $script:Cases++
  $detail = 'ok'; $ok = $true
  try { $null = & $Body }
  catch {
    $ok = $false
    $msg = [string]$_.Exception.Message
    if ($msg -cmatch '^assert:[A-Za-z0-9-]{1,48}\z') { $detail = $msg }
    else {
      $tn = $_.Exception.GetType().Name
      if ($tn -cnotmatch '^[A-Za-z]{1,64}\z') { $tn = 'Other' }
      $detail = 'threw:' + $tn
    }
  }
  if ($ok) { $script:Pass++ } else { $script:Fail++ }
  Add-Log ('rawacl-probe case=' + $Id + ' result=' + $(if ($ok) { 'PASS' } else { 'FAIL' }) + ' detail=' + $detail)
}

# ---- synthetic constants (no lookup: explicit SID strings; S-1-1-0 is the fixed Everyone SID) ----
$SidA = 'S-1-5-21-1167-2-3-1001'; $SidB = 'S-1-5-21-1167-2-3-1002'; $SidC = 'S-1-5-21-1167-2-3-1003'
$Own = 'O:' + $SidA + 'G:' + $SidA
$AllowA = '(A;;FA;;;' + $SidA + ')'; $DenyB = '(D;;FA;;;' + $SidB + ')'; $AllowC = '(A;;FA;;;' + $SidC + ')'
$Ordered = $Own + 'D:P' + $AllowA + $DenyB              # allow before deny (non-canonical)
$Reversed = $Own + 'D:P' + $DenyB + $AllowA             # same ACEs, reversed (canonical: explicit deny first)
$Three = $Own + 'D:P' + $AllowA + $DenyB + $AllowC
$Empty = $Own + 'D:P'
$NullDacl = $Own + 'D:NO_ACCESS_CONTROL'
$Absent = $Own
$DirNonCanon = $Own + 'D:P(A;OICI;FA;;;' + $SidA + ')(D;OICI;FA;;;' + $SidB + ')'
function New-ManySddl([int]$N) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append($Own + 'D:P')
  for ($i = 0; $i -lt $N; $i++) { [void]$sb.Append('(A;;FA;;;S-1-5-21-1167-2-3-' + (2000 + $i) + ')') }
  return $sb.ToString()
}

# ---- exact-API helpers (the same calls the candidate makes; no fallback path) ----
function New-RawSd([string]$Sddl) { return [System.Security.AccessControl.RawSecurityDescriptor]::new($Sddl) }
function Get-AceBlobs($Acl) {
  $list = New-Object 'System.Collections.Generic.List[byte[]]'
  for ($i = 0; $i -lt $Acl.Count; $i++) {
    $ace = $Acl.Item($i)
    Assert-True ($ace -is [System.Security.AccessControl.GenericAce]) 'item-not-genericace'
    $b = [byte[]]::new($ace.BinaryLength)
    $ace.GetBinaryForm($b, 0)
    $list.Add($b)
  }
  return ,$list
}
function Test-BytesEqual([byte[]]$X, [byte[]]$Y) {
  if ($X.Length -ne $Y.Length) { return $false }
  for ($j = 0; $j -lt $X.Length; $j++) { if ($X[$j] -ne $Y[$j]) { return $false } }
  return $true
}
# Ordered comparison: count first, then BinaryLength and every byte at every index (via Item/GetBinaryForm).
function Compare-Ordered($Ga, $Oa) {
  $eq = ($Ga.Count -eq $Oa.Count)
  for ($i = 0; $eq -and ($i -lt $Ga.Count); $i++) {
    $ax = $Ga.Item($i); $ay = $Oa.Item($i)
    if ($ax.BinaryLength -ne $ay.BinaryLength) { $eq = $false; break }
    $bx = [byte[]]::new($ax.BinaryLength); $ax.GetBinaryForm($bx, 0)
    $by = [byte[]]::new($ay.BinaryLength); $ay.GetBinaryForm($by, 0)
    if (-not (Test-BytesEqual $bx $by)) { $eq = $false }
  }
  return @{ eq = [bool]$eq; ga = [int]$Ga.Count; oa = [int]$Oa.Count }
}
function Get-Multiset($Acl) {
  $hex = @(foreach ($b in (Get-AceBlobs $Acl)) { [System.BitConverter]::ToString($b) })
  return (($hex | Sort-Object -CaseSensitive) -join '|')
}
function Get-CtlInt($Sd) {
  $c = [int]$Sd.ControlFlags
  Assert-True ($c.GetType().FullName -ceq 'System.Int32') 'ctl-not-int32'
  Assert-True (($c -ge 0) -and ($c -le 65535)) 'ctl-out-of-word'
  return $c
}
# Fake in-memory security object -> the candidate's rendering path: RawSecurityDescriptor([byte[]]GetSecurityDescriptorBinaryForm(), 0).
function New-FakeSec([string]$Kind, [string]$Sddl) {
  if ($Kind -ceq 'file') { $sec = New-Object System.Security.AccessControl.FileSecurity }
  else { $sec = New-Object System.Security.AccessControl.DirectorySecurity }
  $sec.SetSecurityDescriptorSddlForm($Sddl)
  return $sec
}
function Get-Rendering($Sec) { return [System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$Sec.GetSecurityDescriptorBinaryForm(), 0) }
function Get-Canonical($Sec) {
  $can = $Sec.AreAccessRulesCanonical
  Assert-True ($can -is [bool]) 'canonical-not-bool'
  return $can
}

# ================================ raw (SDDL -> RawSecurityDescriptor) cases ================================
Invoke-Case 'api-types' {
  $sd = New-RawSd $Ordered
  Assert-True ($sd.DiscretionaryAcl -is [System.Security.AccessControl.RawAcl]) 'dacl-not-rawacl'
  Assert-True ($sd.ControlFlags -is [System.Security.AccessControl.ControlFlags]) 'flags-not-enum'
  Assert-True ($sd.DiscretionaryAcl.Item(0) -is [System.Security.AccessControl.CommonAce]) 'item-not-commonace'
  $c = Get-CtlInt $sd
  Assert-True (($c -band 0x8000) -ne 0) 'selfrelative-missing'
  Assert-True (($c -band 0x0004) -ne 0) 'daclpresent-missing'
  Test-SrcExpect 'api-types' 'protected-0x1000' (($c -band 0x1000) -ne 0)
}
Invoke-Case 'ace-bytes' {
  $acl = (New-RawSd $Ordered).DiscretionaryAcl
  $bl = Get-AceBlobs $acl
  Assert-True ($bl.Count -eq 2) 'count'
  # ACCESS_ALLOWED_ACE / ACCESS_DENIED_ACE: type, flags, size LE, mask LE (FA = 0x001F01FF), SID rev 1, 5 subauthorities, NT authority 5.
  foreach ($k in 0, 1) {
    $b = $bl[$k]
    Assert-True ($b.Length -eq 36) 'ace-length'
    Assert-True (($b[2] + 256 * $b[3]) -eq 36) 'ace-size-field'
    Assert-True (($b[4] -eq 0xFF) -and ($b[5] -eq 0x01) -and ($b[6] -eq 0x1F) -and ($b[7] -eq 0x00)) 'ace-mask'
    Assert-True (($b[8] -eq 1) -and ($b[9] -eq 5) -and ($b[15] -eq 5) -and ($b[10] -eq 0) -and ($b[14] -eq 0)) 'ace-sid-header'
    Assert-True ($b[1] -eq 0) 'ace-flags'
  }
  Assert-True (($bl[0][0] -eq 0) -and ($bl[1][0] -eq 1)) 'ace-type-order'
  Assert-True ($acl.BinaryLength -eq (8 + 72)) 'acl-binarylength'
}
Invoke-Case 'equal-ordered' {
  $r = Compare-Ordered (New-RawSd $Ordered).DiscretionaryAcl (New-RawSd $Ordered).DiscretionaryAcl
  Assert-True ($r.eq -and ($r.ga -eq 2) -and ($r.oa -eq 2)) 'equal'
}
Invoke-Case 'reversed' {
  $x = (New-RawSd $Ordered).DiscretionaryAcl; $y = (New-RawSd $Reversed).DiscretionaryAcl
  $r = Compare-Ordered $x $y
  Assert-True ((-not $r.eq) -and ($r.ga -eq 2) -and ($r.oa -eq 2)) 'reversed-not-ne'
  $bx = Get-AceBlobs $x; $by = Get-AceBlobs $y
  Assert-True ((Test-BytesEqual $bx[0] $by[1]) -and (Test-BytesEqual $bx[1] $by[0])) 'raw-order-not-preserved'
  Assert-True ((Get-Multiset $x) -ceq (Get-Multiset $y)) 'multiset'
}
Invoke-Case 'count-mismatch' {
  $r = Compare-Ordered (New-RawSd $Ordered).DiscretionaryAcl (New-RawSd $Three).DiscretionaryAcl
  Assert-True ((-not $r.eq) -and ($r.ga -eq 2) -and ($r.oa -eq 3)) 'count-mismatch'
}
Invoke-Case 'empty' {
  $sd = New-RawSd $Empty
  Assert-True ($null -ne $sd.DiscretionaryAcl) 'empty-is-null'
  Assert-True (($sd.DiscretionaryAcl.Count -eq 0) -and ($sd.DiscretionaryAcl.BinaryLength -eq 8)) 'empty-shape'
  Assert-True ((Get-AceBlobs $sd.DiscretionaryAcl).Count -eq 0) 'empty-blobs'
  Assert-True (((Get-CtlInt $sd) -band 0x0004) -ne 0) 'empty-daclpresent'
}
Invoke-Case 'null' {
  $sd = New-RawSd $NullDacl
  Assert-True ($null -eq $sd.DiscretionaryAcl) 'null-not-null'
  Test-SrcExpect 'null' 'daclpresent-set' (((Get-CtlInt $sd) -band 0x0004) -ne 0)
}
Invoke-Case 'absent' {
  $sd = New-RawSd $Absent
  Assert-True ($null -eq $sd.DiscretionaryAcl) 'absent-not-null'
  Test-SrcExpect 'absent' 'daclpresent-clear' (((Get-CtlInt $sd) -band 0x0004) -eq 0)
}
Invoke-Case 'bounds-64' {
  $acl = (New-RawSd (New-ManySddl 64)).DiscretionaryAcl
  Assert-True (($acl.Count -eq 64) -and ($acl.BinaryLength -eq (8 + 64 * 36))) 'shape-64'
  $bl = Get-AceBlobs $acl
  Assert-True ($bl.Count -eq 64) 'blobs-64'
  foreach ($b in $bl) { Assert-True ($b.Length -eq 36) 'blob-length-64' }
}
Invoke-Case 'bounds-65' {
  $acl = (New-RawSd (New-ManySddl 65)).DiscretionaryAcl
  Assert-True (($acl.Count -eq 65) -and ($acl.BinaryLength -eq (8 + 65 * 36))) 'shape-65'
  Assert-True ($acl.Item(64) -is [System.Security.AccessControl.GenericAce]) 'item-64'
}
Invoke-Case 'item-out-of-range' {
  $acl = (New-RawSd $Ordered).DiscretionaryAcl
  foreach ($ix in @(2, -1)) {
    $threw = $false
    try { $null = $acl.Item($ix) } catch { $threw = $true }
    Assert-True $threw 'item-out-of-range-no-throw'
  }
}

# ================================ fake in-memory FileSecurity / DirectorySecurity renderings ================================
Invoke-Case 'filesecurity-canonical' {
  $sec = New-FakeSec 'file' $Reversed
  $raw = Get-Rendering $sec
  $src = (New-RawSd $Reversed).DiscretionaryAcl
  Assert-True ($null -ne $raw.DiscretionaryAcl) 'rendering-dacl-null'
  Assert-True ($raw.DiscretionaryAcl.Count -eq 2) 'rendering-count'
  Assert-True ((Get-Multiset $raw.DiscretionaryAcl) -ceq (Get-Multiset $src)) 'rendering-multiset'
  $c = Get-CtlInt $raw
  Assert-True ((($c -band 0x8000) -ne 0) -and (($c -band 0x0004) -ne 0)) 'rendering-flags'
  $can = Get-Canonical $sec
  Test-SrcExpect 'filesecurity-canonical' 'order-equal' ((Compare-Ordered $raw.DiscretionaryAcl $src).eq)
  Test-SrcExpect 'filesecurity-canonical' 'canonical-true' ($can -eq $true)
}
Invoke-Case 'filesecurity-noncanonical' {
  $sec = New-FakeSec 'file' $Ordered
  $raw = Get-Rendering $sec
  $src = (New-RawSd $Ordered).DiscretionaryAcl
  Assert-True (($null -ne $raw.DiscretionaryAcl) -and ($raw.DiscretionaryAcl.Count -eq 2)) 'rendering-count'
  Assert-True ((Get-Multiset $raw.DiscretionaryAcl) -ceq (Get-Multiset $src)) 'rendering-multiset'
  $null = Get-CtlInt $raw
  $can = Get-Canonical $sec
  Test-SrcExpect 'filesecurity-noncanonical' 'order-preserved' ((Compare-Ordered $raw.DiscretionaryAcl $src).eq)
  Test-SrcExpect 'filesecurity-noncanonical' 'canonical-false' ($can -eq $false)
}
Invoke-Case 'directorysecurity-noncanonical' {
  $sec = New-FakeSec 'dir' $DirNonCanon
  $raw = Get-Rendering $sec
  $src = (New-RawSd $DirNonCanon).DiscretionaryAcl
  Assert-True (($null -ne $raw.DiscretionaryAcl) -and ($raw.DiscretionaryAcl.Count -eq 2)) 'rendering-count'
  Assert-True ((Get-Multiset $raw.DiscretionaryAcl) -ceq (Get-Multiset $src)) 'rendering-multiset'
  $null = Get-CtlInt $raw
  $can = Get-Canonical $sec
  Test-SrcExpect 'directorysecurity-noncanonical' 'order-preserved' ((Compare-Ordered $raw.DiscretionaryAcl $src).eq)
  Test-SrcExpect 'directorysecurity-noncanonical' 'canonical-false' ($can -eq $false)
}
Invoke-Case 'filesecurity-null' {
  $sec = New-FakeSec 'file' $NullDacl
  $raw = Get-Rendering $sec
  $c = Get-CtlInt $raw
  $null = Get-Canonical $sec
  # Source: a NULL DACL becomes a crafted Everyone-full DACL whose binary form clears DaclPresent and writes no DACL.
  Test-SrcExpect 'filesecurity-null' 'rendering-dacl-null' ($null -eq $raw.DiscretionaryAcl)
  Test-SrcExpect 'filesecurity-null' 'rendering-daclpresent-clear' (($c -band 0x0004) -eq 0)
}
Invoke-Case 'filesecurity-absent' {
  $sec = New-FakeSec 'file' $Absent
  $raw = Get-Rendering $sec
  $c = Get-CtlInt $raw
  $null = Get-Canonical $sec
  Test-SrcExpect 'filesecurity-absent' 'rendering-dacl-null' ($null -eq $raw.DiscretionaryAcl)
  Test-SrcExpect 'filesecurity-absent' 'rendering-daclpresent-clear' (($c -band 0x0004) -eq 0)
}
Invoke-Case 'filesecurity-empty' {
  $sec = New-FakeSec 'file' $Empty
  $raw = Get-Rendering $sec
  $null = Get-CtlInt $raw
  $null = Get-Canonical $sec
  if ($null -ne $raw.DiscretionaryAcl) { Assert-True ($raw.DiscretionaryAcl.Count -eq 0) 'rendering-empty-has-aces' }
  Test-SrcExpect 'filesecurity-empty' 'rendering-dacl-present' ($null -ne $raw.DiscretionaryAcl)
}
Invoke-Case 'read-only-getters' {
  $sec = New-FakeSec 'file' $Ordered
  $b1 = [byte[]]$sec.GetSecurityDescriptorBinaryForm()
  $null = Get-Canonical $sec; $null = Get-Canonical $sec
  $null = Get-AceBlobs (Get-Rendering $sec).DiscretionaryAcl
  $b2 = [byte[]]$sec.GetSecurityDescriptorBinaryForm()
  Assert-True (Test-BytesEqual $b1 $b2) 'getter-mutated-descriptor'
}

$ps = $PSVersionTable.PSVersion; $clr = [System.Environment]::Version
foreach ($l in $script:Log) { Write-Output $l }
Write-Output ('rawacl-probe-summary cases=' + $script:Cases + ' expected=' + $ExpectedCases + ' pass=' + $script:Pass + ' fail=' + $script:Fail +
  ' srcExpectMatch=' + $script:SrcMatch + ' srcExpectDiff=' + $script:SrcDiff + ' ps=' + $ps.Major + '.' + $ps.Minor + ' clr=' + $clr.Major + '.' + $clr.Minor + '.' + $clr.Build + '.' + $clr.Revision)
if (($script:Fail -ne 0) -or ($script:Cases -ne $ExpectedCases) -or ($script:Pass -ne $ExpectedCases)) { exit 1 }
exit 0
