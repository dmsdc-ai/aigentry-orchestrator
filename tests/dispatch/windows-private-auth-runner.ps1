<#
.SYNOPSIS
  U1 ordinary-principal harness: two disposable CI test accounts, owner access
  and other-user denial, always-cleanup. Never a durability or auth certificate.

.DESCRIPTION
  Runs ONLY inside a disposable GitHub-hosted Windows job. It creates exactly two
  uniquely prefixed local accounts, neither joining Administrators nor receiving
  any additional privilege, launches the pinned probe once under each account's
  real ordinary token, and removes exactly those recorded accounts, profiles and
  fixture paths at job end even when an assertion or a child process fails.

  Passwords are random job-local synthetic secrets held only as SecureString.
  They are never printed, artifacted, written or passed as command-line
  arguments. No real account, credential or auth token is used or read.

  Bounded by construction: every create and every delete names an exact recorded
  SID, process identity or fixture path. There is no wildcard account removal,
  no taskkill by name, no ambient-user change, no desktop ACL grant, no
  machine-wide policy change and no process enumeration used as lifetime proof.
  A child that never started is recorded as a launch failure, never as denial
  evidence, and its rights are never broadened to obtain a pass.

  Exit 0 observed, 1 harness failure, 2 bounded capability refusal.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WorkRoot,
    [Parameter(Mandatory = $true)][string]$Probe,
    [Parameter(Mandatory = $true)][string]$Receipt,
    [int]$OverallTimeoutSeconds = 120,
    [int]$ChildTimeoutSeconds = 60
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:AccountPrefix = 'wpa'
$script:UsersGroupSid = [System.Security.Principal.SecurityIdentifier]'S-1-5-32-545'
$script:AdminGroupSid = [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544'
$script:SystemSid = [System.Security.Principal.SecurityIdentifier]'S-1-5-18'
$script:StartupFailureExit = 3221225794  # 0xC0000142, the prior launcher failure

$receipt = [ordered]@{
    schema                = 1
    probe                 = 'windows-private-auth-runner'
    status                = 'harness_failure'
    powerLossProven       = $false
    activationAuthorized  = $false
    ordinaryUserEvidence  = 'unresolved'
    obligations           = [ordered]@{ O1 = 'unresolved'; O2 = 'unresolved'; O3 = 'unresolved'
                                        O4 = 'unresolved'; O5 = 'unresolved' }
    accounts              = @()
    children              = @()
    controls              = @()
    cleanup               = [ordered]@{ attempted = $false; accountsRemoved = @()
                                        profilesRemoved = @(); fixtureRemoved = $false
                                        errors = @() }
    limits                = @(
        'Discretionary access-check observations only; not Windows auth support',
        'No namespace durability, crash/restart or power-loss proof',
        'Administrator and SYSTEM remain outside this DAC boundary',
        'Disposable hosted runner only; never a personal or production machine',
        'Python and PowerShell are CI measurement tools, not runtime dependencies')
}

function Add-Control {
    param([string]$Name, [ValidateSet('passed', 'refused', 'open')][string]$State,
          [hashtable]$Detail = @{})
    $entry = [ordered]@{ control = $Name; state = $State }
    foreach ($key in ($Detail.Keys | Sort-Object)) { $entry[$key] = $Detail[$key] }
    $script:receipt.controls += , $entry
}

function New-JobLocalPassword {
    <#  Random synthetic job-local secret. It exists only as a SecureString and
        is never converted back to a String, logged, written or passed as an
        argument. Category coverage is explicit so account policy cannot reject
        it and force a weaker retry. #>
    $sets = @('ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz',
              '23456789', '!@#$%^&*()-_=+')
    $characters = [System.Collections.Generic.List[char]]::new()
    foreach ($set in $sets) {
        $characters.Add($set[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($set.Length)])
    }
    $all = -join $sets
    for ($index = $characters.Count; $index -lt 40; $index++) {
        $characters.Add($all[[System.Security.Cryptography.RandomNumberGenerator]::GetInt32($all.Length)])
    }
    for ($index = $characters.Count - 1; $index -gt 0; $index--) {
        $swap = [System.Security.Cryptography.RandomNumberGenerator]::GetInt32($index + 1)
        $held = $characters[$index]; $characters[$index] = $characters[$swap]
        $characters[$swap] = $held
    }
    $secure = [System.Security.SecureString]::new()
    foreach ($character in $characters) { $secure.AppendChar($character) }
    $characters.Clear()
    $secure.MakeReadOnly()
    return $secure
}

function New-DisposableAccount {
    param([Parameter(Mandatory = $true)][string]$Name,
          [Parameter(Mandatory = $true)][string]$Role)
    $password = New-JobLocalPassword
    $user = New-LocalUser -Name $Name -Password $password -AccountNeverExpires `
        -PasswordNeverExpires -UserMayNotChangePassword `
        -Description 'Disposable U1 CI test principal; removed at job end'
    # Ordinary baseline membership only. Administrators is never joined and no
    # privilege, right assignment or policy is granted anywhere in this script.
    Add-LocalGroupMember -SID $script:UsersGroupSid -Member $user.SID
    $administrators = @(Get-LocalGroupMember -SID $script:AdminGroupSid |
        Where-Object { $_.SID.Value -eq $user.SID.Value })
    if ($administrators.Count -ne 0) {
        throw "disposable_account_unexpectedly_in_administrators"
    }
    $credential = [System.Management.Automation.PSCredential]::new(
        ".\$Name", $password)
    return [pscustomobject]@{
        Role       = $Role
        Name       = $Name
        Sid        = $user.SID.Value
        Credential = $credential
    }
}

function Set-ExactDirectoryAccess {
    <#  Replaces a run-owned directory's DACL with an exact protected list.
        Applies only to directories this script created under WorkRoot; it never
        touches a user profile, a desktop, a window station or a system path. #>
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][hashtable]$Rights)
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRule($existing) }
    $grants = @{ $script:AdminGroupSid.Value = 'FullControl'
                 $script:SystemSid.Value = 'FullControl' }
    foreach ($sid in $Rights.Keys) { $grants[$sid] = $Rights[$sid] }
    foreach ($sid in $grants.Keys) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            [System.Security.Principal.SecurityIdentifier]::new($sid),
            [System.Security.AccessControl.FileSystemRights]$grants[$sid],
            'ContainerInherit, ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Invoke-ProbeAsPrincipal {
    <#  One bounded child under one exact disposable principal. Returns the
        recorded child identity; the caller decides what the exit code means. #>
    param([Parameter(Mandatory = $true)][pscustomobject]$Account,
          [Parameter(Mandatory = $true)][string[]]$Arguments,
          [Parameter(Mandatory = $true)][string]$WorkingDirectory,
          [Parameter(Mandatory = $true)][string]$StdOut,
          [Parameter(Mandatory = $true)][string]$StdErr,
          [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
    $record = [ordered]@{
        role = $Account.Role; accountSid = $Account.Sid; launched = $false
        processId = $null; exitCode = $null; timedOut = $false
        stoppedByHarness = $false; timeoutSeconds = $TimeoutSeconds
    }
    $script:receipt.children += , $record
    if ($TimeoutSeconds -le 0) {
        $record['launchFailure'] = 'overall_measurement_budget_exhausted'
        throw 'overall_measurement_budget_exhausted'
    }
    $process = $null
    try {
        $process = Start-Process -FilePath $Arguments[0] `
            -ArgumentList $Arguments[1..($Arguments.Count - 1)] `
            -Credential $Account.Credential -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr `
            -WindowStyle Hidden -PassThru
    }
    catch {
        # Exact bounded launch evidence. Secondary logon or profile-load refusal
        # is recorded as-is; rights are never broadened and the previously failing
        # restricted-token launcher is never substituted for this principal.
        $inner = $_.Exception
        while ($null -ne $inner -and -not ($inner -is [System.ComponentModel.Win32Exception])) {
            $inner = $inner.InnerException
        }
        $record['launchFailure'] = 'ordinary_principal_launch_unavailable'
        $record['exceptionType'] = $_.Exception.GetType().Name
        if ($null -ne $inner) { $record['nativeErrorCode'] = $inner.NativeErrorCode }
        throw 'ordinary_principal_launch_unavailable'
    }
    # The process object itself is the lifetime handle; no name or table lookup.
    $record['launched'] = $true
    $record['processId'] = $process.Id
    $script:OwnedProcesses += , ([pscustomobject]@{
            Record = $record; Process = $process
            Id = $process.Id; StartTime = $process.StartTime })
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $record['timedOut'] = $true
        throw 'child_timeout'
    }
    $record['exitCode'] = $process.ExitCode
    $record['stdoutBytes'] = if (Test-Path -LiteralPath $StdOut) {
        (Get-Item -LiteralPath $StdOut).Length } else { 0 }
    $record['stderrBytesDiscarded'] = if (Test-Path -LiteralPath $StdErr) {
        (Get-Item -LiteralPath $StdErr).Length } else { 0 }
    if ($process.ExitCode -eq $script:StartupFailureExit) {
        # A process that could not initialise produced no access check at all.
        $record['launchFailure'] = 'child_startup_failed_before_measurement'
        throw 'child_startup_failed_before_measurement'
    }
    return $record
}

function Read-ChildReceipt {
    param([Parameter(Mandatory = $true)][string]$Path,
          [Parameter(Mandatory = $true)][string]$ExpectedSid,
          [Parameter(Mandatory = $true)][string]$ExpectedRole)
    if (-not (Test-Path -LiteralPath $Path)) { throw 'child_receipt_missing' }
    $child = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    if ($child.probe -ne 'windows-private-auth' -or $child.role -ne $ExpectedRole) {
        throw 'child_receipt_identity_mismatch'
    }
    if ($child.powerLossProven -ne $false -or $child.activationAuthorized -ne $false) {
        throw 'child_receipt_invalid_proof_claim'
    }
    # The principal is proved by the SID the child read from its own token, not
    # by the username this script launched or by any environment value.
    if ($child.identity.userSid -ne $ExpectedSid) { throw 'child_token_sid_mismatch' }
    if ($child.identity.ordinaryPrincipalVerified -ne $true -or
        $child.identity.elevated -ne $false -or
        $child.identity.adminEnabled -ne $false -or
        $child.identity.integrityRid -ne 8192) {
        throw 'child_token_not_ordinary_principal'
    }
    return $child
}

$script:OwnedProcesses = @()
$script:OwnedAccounts = @()
$script:FixtureRoot = $null
$failure = $null
$exitCode = 1
$clock = [System.Diagnostics.Stopwatch]::StartNew()

try {
    foreach ($path in @($WorkRoot, $Probe, $Receipt)) {
        if (-not [System.IO.Path]::IsPathRooted($path)) { throw 'absolute_paths_required' }
    }
    if (-not (Test-Path -LiteralPath $Probe -PathType Leaf)) { throw 'probe_not_found' }
    $probeItem = Get-Item -LiteralPath $Probe
    $receipt['sourceHashes'] = [ordered]@{
        probe = (Get-FileHash -LiteralPath $Probe -Algorithm SHA256).Hash.ToLowerInvariant()
        runner = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $runId = -join ((1..4 | ForEach-Object {
        '{0:x2}' -f [System.Security.Cryptography.RandomNumberGenerator]::GetInt32(256) }))
    $receipt['runId'] = $runId

    $stage = Join-Path $WorkRoot 'stage'
    $receipts = Join-Path $WorkRoot 'receipts'
    $fixture = Join-Path $WorkRoot 'fixture'
    foreach ($directory in @($WorkRoot, $stage, $receipts, $fixture)) {
        if (-not (Test-Path -LiteralPath $directory)) {
            [void](New-Item -ItemType Directory -Path $directory)
        }
    }
    $script:FixtureRoot = $fixture

    $owner = New-DisposableAccount -Name ("$script:AccountPrefix$runId" + 'o') -Role 'owner'
    $script:OwnedAccounts += , $owner
    $other = New-DisposableAccount -Name ("$script:AccountPrefix$runId" + 'x') -Role 'other'
    $script:OwnedAccounts += , $other
    $receipt['accounts'] = @($script:OwnedAccounts | ForEach-Object {
            [ordered]@{ role = $_.Role; name = $_.Name; sid = $_.Sid
                        groups = @('Users'); inAdministrators = $false
                        privilegesGranted = @() } })

    # Exact, protected, run-owned DACLs. The other principal deliberately has no
    # rights on the fixture parent, so the leaf access check is what is measured.
    Set-ExactDirectoryAccess -Path $stage -Rights @{
        $owner.Sid = 'ReadAndExecute'; $other.Sid = 'ReadAndExecute' }
    Set-ExactDirectoryAccess -Path $receipts -Rights @{
        $owner.Sid = 'Modify'; $other.Sid = 'Modify' }
    Set-ExactDirectoryAccess -Path $fixture -Rights @{ $owner.Sid = 'Modify' }

    $stagedProbe = Join-Path $stage $probeItem.Name
    Copy-Item -LiteralPath $Probe -Destination $stagedProbe
    $stagedHash = (Get-FileHash -LiteralPath $stagedProbe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($stagedHash -ne $receipt['sourceHashes'].probe) { throw 'staged_probe_hash_mismatch' }

    $python = (Get-Command -Name 'python' -CommandType Application |
        Select-Object -First 1).Source
    $receipt['interpreter'] = [ordered]@{ path = $python; pinnedBy = 'actions/setup-python' }

    $ownerReceiptPath = Join-Path $receipts 'owner-receipt.json'
    $remaining = $OverallTimeoutSeconds - [int]$clock.Elapsed.TotalSeconds
    $ownerChild = Invoke-ProbeAsPrincipal -Account $owner -WorkingDirectory $stage `
        -StdOut (Join-Path $receipts 'owner-stdout.txt') `
        -StdErr (Join-Path $receipts 'owner-stderr.txt') `
        -TimeoutSeconds ([Math]::Min($ChildTimeoutSeconds, $remaining)) `
        -Arguments @($python, '-I', $stagedProbe, '--role', 'owner',
                     '--parent', $fixture, '--receipt', $ownerReceiptPath,
                     '--run-id', $runId,
                     '--attest-local-unsynced-disposable-parent')
    $ownerReceipt = Read-ChildReceipt -Path $ownerReceiptPath -ExpectedSid $owner.Sid `
        -ExpectedRole 'owner'
    $receipt['ownerReceipt'] = $ownerReceipt
    if ($ownerChild.exitCode -ne 0 -or $ownerReceipt.status -ne 'owner_private_api_observed_only') {
        throw 'owner_private_creation_unresolved'
    }
    $script:FixtureRoot = $ownerReceipt.fixtureRoot

    $otherReceiptPath = Join-Path $receipts 'other-receipt.json'
    $remaining = $OverallTimeoutSeconds - [int]$clock.Elapsed.TotalSeconds
    $otherChild = Invoke-ProbeAsPrincipal -Account $other -WorkingDirectory $stage `
        -StdOut (Join-Path $receipts 'other-stdout.txt') `
        -StdErr (Join-Path $receipts 'other-stderr.txt') `
        -TimeoutSeconds ([Math]::Min($ChildTimeoutSeconds, $remaining)) `
        -Arguments @($python, '-I', $stagedProbe, '--role', 'other',
                     '--root', $ownerReceipt.fixtureRoot, '--receipt', $otherReceiptPath,
                     '--attest-local-unsynced-disposable-parent')
    $otherReceipt = Read-ChildReceipt -Path $otherReceiptPath -ExpectedSid $other.Sid `
        -ExpectedRole 'other'
    $receipt['otherReceipt'] = $otherReceipt
    if ($otherReceipt.identity.userSid -eq $ownerReceipt.identity.userSid) {
        throw 'two_distinct_principals_required'
    }

    $denied = ($otherChild.exitCode -eq 0 -and
               $otherReceipt.status -eq 'other_principal_denied_by_access_check')
    Add-Control -Name 'two_disposable_ordinary_principals' -State 'passed' -Detail @{
        ownerSid = $owner.Sid; otherSid = $other.Sid }
    Add-Control -Name 'owner_private_access' -State 'passed' -Detail @{
        childExitCode = $ownerChild.exitCode }
    Add-Control -Name 'other_principal_denied' -State $(if ($denied) { 'passed' } else { 'open' }) `
        -Detail @{ childExitCode = $otherChild.exitCode
                   deniedControlCount = $otherReceipt.deniedControlCount
                   deniedControlTotal = $otherReceipt.deniedControlTotal }
    Add-Control -Name 'namespace_durability_barrier' -State 'open' -Detail @{
        note = 'unchanged by this harness; no crash, restart or power-loss evidence' }

    $receipt['ordinaryUserEvidence'] = 'two_verified_ordinary_token_sids_observed'
    if ($denied) {
        $receipt['status'] = 'owner_allowed_other_denied_api_observed_only'
        $exitCode = 0
    }
    else {
        $receipt['status'] = 'other_principal_denial_unresolved'
        $exitCode = 2
    }
}
catch {
    # The original failure is captured here and re-reported after cleanup runs,
    # so a cleanup error can never hide or replace it.
    $failure = $_
    $receipt['status'] = 'harness_failure'
    $receipt['reason'] = "$($_.Exception.Message)"
    $receipt['failureType'] = $_.Exception.GetType().Name
    $exitCode = if ("$($_.Exception.Message)" -in @(
            'ordinary_principal_launch_unavailable', 'child_timeout',
            'child_startup_failed_before_measurement',
            'overall_measurement_budget_exhausted',
            'owner_private_creation_unresolved')) { 2 } else { 1 }
}
finally {
    $receipt['cleanup'].attempted = $true
    $receipt['elapsedSeconds'] = [Math]::Round($clock.Elapsed.TotalSeconds, 3)
    # Stop ONLY processes this script started, matched on the exact recorded
    # identity. Never by image name and never by enumerating the process table.
    foreach ($owned in $script:OwnedProcesses) {
        try {
            if (-not $owned.Process.HasExited -and $owned.Process.Id -eq $owned.Id -and
                $owned.Process.StartTime -eq $owned.StartTime) {
                $owned.Process.Kill()
                [void]$owned.Process.WaitForExit(5000)
                $owned.Record['stoppedByHarness'] = $true
            }
        }
        catch { $receipt['cleanup'].errors += , "child_stop:$($_.Exception.GetType().Name)" }
        finally { $owned.Process.Dispose() }
    }
    # Remove only the fixture tree this run created, by exact path.
    foreach ($path in @($script:FixtureRoot, $WorkRoot)) {
        if ($null -ne $path -and (Test-Path -LiteralPath $path)) {
            try {
                Remove-Item -LiteralPath $path -Recurse -Force
                $receipt['cleanup'].fixtureRemoved = $true
            }
            catch {
                $receipt['cleanup'].errors += , "fixture_remove:$($_.Exception.GetType().Name)"
            }
        }
    }
    # Remove exactly the two recorded accounts and their profiles, keyed on SID.
    # There is no wildcard, prefix sweep or name pattern removal anywhere here.
    foreach ($account in $script:OwnedAccounts) {
        try {
            $profileEntry = Get-CimInstance -ClassName Win32_UserProfile |
                Where-Object { $_.SID -eq $account.Sid }
            if ($null -ne $profileEntry) {
                Remove-CimInstance -InputObject $profileEntry
                $receipt['cleanup'].profilesRemoved += , $account.Sid
            }
        }
        catch { $receipt['cleanup'].errors += , "profile_remove:$($_.Exception.GetType().Name)" }
        try {
            Remove-LocalUser -SID $account.Sid
            $receipt['cleanup'].accountsRemoved += , $account.Sid
        }
        catch { $receipt['cleanup'].errors += , "account_remove:$($_.Exception.GetType().Name)" }
    }
    if ($script:OwnedAccounts.Count -ne $receipt['cleanup'].accountsRemoved.Count) {
        $receipt['cleanup'].errors += , 'not_every_recorded_account_was_removed'
    }
    $receipt['powerLossProven'] = $false
    $receipt['activationAuthorized'] = $false
    try {
        $json = $receipt | ConvertTo-Json -Depth 12
        Set-Content -LiteralPath $Receipt -Value $json -Encoding utf8
    }
    catch {
        Write-Output "Private auth runner: receipt_write_failed; $($_.Exception.GetType().Name)"
        $exitCode = 1
    }
    Write-Output ("Private auth runner: " + $receipt['status'] +
                  "; powerLossProven=false; activationAuthorized=false; O1-O5 unresolved")
    if ($receipt['cleanup'].errors.Count -gt 0) {
        Write-Output ("::warning::Cleanup reported " +
                      $receipt['cleanup'].errors.Count + " error(s); original outcome retained.")
    }
    if ($null -ne $failure) {
        Write-Output ("Private auth runner: original failure retained; " + $receipt['reason'])
    }
}

exit $exitCode
