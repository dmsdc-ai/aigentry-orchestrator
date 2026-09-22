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

  The probe's fixture carries an owner-only protected DACL, so this job's own
  context deliberately holds no rights on it. It is therefore removed by one
  further bounded probe run under the owning principal's own credential, before
  that account and profile are removed, and never by adding an Administrators or
  SYSTEM ACE, taking ownership, repairing an ACL or enabling a privilege.
  Cleanup completeness is decided by this script's own observation of the exact
  paths it composed. It never rewrites the measured status, and an incomplete
  cleanup raises the exit code so the job cannot report a full success.

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
    [int]$ChildTimeoutSeconds = 60,
    # Cleanup has its own bounded budget because it must still run after the
    # measurement budget is exhausted; the job and step timeouts still cap it.
    [int]$CleanupTimeoutSeconds = 45
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$script:AccountPrefix = 'wpa'
$script:UsersGroupSid = [System.Security.Principal.SecurityIdentifier]'S-1-5-32-545'
$script:AdminGroupSid = [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544'
$script:SystemSid = [System.Security.Principal.SecurityIdentifier]'S-1-5-18'
$script:StartupFailureExit = 3221225794  # 0xC0000142, the prior launcher failure
$script:RootPrefix = 'windows-private-auth-'  # ROOT_PREFIX in the pinned probe

$measurementReceipt = [ordered]@{
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
                                        complete = $false; ownerContext = $null
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
    $script:measurementReceipt.controls += , $entry
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
        -Description 'U1 CI test principal; removed at job end'
    # Own the created SID before any later setup can fail, including membership.
    $script:OwnedAccounts += , ([pscustomobject]@{
        Role = $Role; Name = $user.Name; Sid = $user.SID.Value })
    $accountRecord = [ordered]@{
        role = $Role; name = $user.Name; sid = $user.SID.Value
        groups = @(); inAdministrators = $null; privilegesGranted = @()
        setupComplete = $false
    }
    $script:measurementReceipt.accounts += , $accountRecord
    # Ordinary baseline membership only. Administrators is never joined and no
    # privilege, right assignment or policy is granted anywhere in this script.
    Add-LocalGroupMember -SID $script:UsersGroupSid -Member $user
    $accountRecord['groups'] = @('Users')
    $administrators = @(Get-LocalGroupMember -SID $script:AdminGroupSid |
        Where-Object { $_.SID.Value -eq $user.SID.Value })
    $accountRecord['inAdministrators'] = ($administrators.Count -ne 0)
    if ($administrators.Count -ne 0) {
        throw "disposable_account_unexpectedly_in_administrators"
    }
    $credential = [System.Management.Automation.PSCredential]::new(
        ".\$Name", $password)
    $accountRecord['setupComplete'] = $true
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
    $script:measurementReceipt.children += , $record
    if ($TimeoutSeconds -le 0) {
        $record['launchFailure'] = 'overall_measurement_budget_exhausted'
        throw 'overall_measurement_budget_exhausted'
    }
    # Derived UTF-16 code-unit lengths, not observed native bytes. Mirror the
    # supplied v7.6.5 space join and BuildCommandLine quoting, using the input
    # executable (command discovery may resolve a different executable path).
    $structure = [ordered]@{
        complete = $false; units = 'utf16_code_units'; source = 'derived_v7_6_5_input'
        argumentCount = $Arguments.Count - 1; argumentLengths = @()
        argumentsTruncated = ($Arguments.Count -gt 65)
        joinedArgumentLength = $null; commandLineLengthExcludingNul = $null
        executableLength = $null; maxInspectedArgumentLength = 0
    }
    $record['launchStructure'] = $structure
    try {
        $structure['executableLength'] = $Arguments[0].Length
        $sum = [long]0
        for ($i = 1; $i -lt [Math]::Min($Arguments.Count, 65); $i++) {
            $length = if ($null -eq $Arguments[$i]) { 0 } else { $Arguments[$i].Length }
            $structure['argumentLengths'] += , $length
            $sum += $length
            $structure['maxInspectedArgumentLength'] =
                [Math]::Max($structure['maxInspectedArgumentLength'], $length)
        }
        if (-not $structure['argumentsTruncated'] -and $Arguments.Count -ge 2) {
            $joinedLength = $sum + $Arguments.Count - 2
            $structure['joinedArgumentLength'] = $joinedLength
            # Bound the only value transformation; oversized input stays unknown.
            if ($Arguments[0].Length -le 32768) {
                $executable = $Arguments[0].Trim()
                $quotedLength = [long]$executable.Length
                if (-not ($executable.StartsWith('"') -and $executable.EndsWith('"'))) {
                    $quotedLength += 2
                }
                $structure['commandLineLengthExcludingNul'] = $quotedLength +
                    $(if ($joinedLength -gt 0) { 1 + $joinedLength } else { 0 })
                $structure['complete'] = $true
            }
        }
    }
    catch { $structure['complete'] = $false }
    # Read the resolved cmdlet identity without launching anything. Unexpected
    # metadata or capture failure leaves template comparisons disabled.
    $runtime = [ordered]@{ complete = $false; supportedTemplateAndCulture = $false }
    $record['launchRuntime'] = $runtime
    try {
        $command = Get-Command -Name 'Start-Process' -ErrorAction Stop
        $assembly = $command.ImplementingType.Assembly
        $assemblyInfo = $assembly.GetCustomAttributes(
            [System.Reflection.AssemblyInformationalVersionAttribute], $false)
        $metadata = [ordered]@{
            psVersion = $PSVersionTable.PSVersion.ToString()
            framework = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
            osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
            processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
            cmdletType = $command.ImplementingType.FullName
            cmdletAssemblyIdentity = $assembly.FullName
            cmdletAssemblyVersion = $assembly.GetName().Version.ToString()
            cmdletInformationalVersion = $assemblyInfo[0].InformationalVersion
            currentUICulture = [System.Globalization.CultureInfo]::CurrentUICulture.Name
        }
        foreach ($key in $metadata.Keys) {
            $value = $metadata[$key]
            if ($null -eq $value -or $value.Length -gt 256 -or
                $value -cmatch '[\r\n]') { throw 'runtime_metadata_unavailable' }
            $runtime[$key] = $value
        }
        # Only the supplied release's English-US template is supported. This is
        # an explicit compatibility gate, not proof of runtime binary provenance.
        $runtime['supportedTemplateAndCulture'] = (
            $runtime['psVersion'] -ceq '7.6.5' -and
            $runtime['cmdletType'] -ceq 'Microsoft.PowerShell.Commands.StartProcessCommand' -and
            $assembly.GetName().Name -ceq 'Microsoft.PowerShell.Commands.Management' -and
            $runtime['cmdletInformationalVersion'] -cmatch '\A7\.6\.5(?:\+[0-9A-Za-z.-]+| SHA: [0-9a-fA-F]{40}(?:\+[0-9a-fA-F]{40})?)?\z' -and
            $runtime['currentUICulture'] -ceq 'en-US')
        $runtime['complete'] = $true
    }
    catch { $runtime['supportedTemplateAndCulture'] = $false }
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
        # Capture only bounded metadata from the original ErrorRecord. Never
        # serialize messages, targets, invocation details, argument values or
        # credentials. Diagnostic failure must not replace the launch failure.
        $launchError = $_
        $diagnostic = [ordered]@{
            schema = 1; complete = $false; exceptionChain = @()
        }
        $record['launchDiagnostic'] = $diagnostic
        try {
            # Built-in error identifiers only; omit unexpected free-form text.
            foreach ($field in @('fullyQualifiedErrorId', 'categoryReason')) {
                $value = if ($field -eq 'fullyQualifiedErrorId') {
                    $launchError.FullyQualifiedErrorId
                } else { $launchError.CategoryInfo.Reason }
                $allowed = ($null -ne $value -and $value.Length -le 256 -and
                    $value -cmatch '\A[A-Za-z0-9_.,+-]*\z')
                $diagnostic[$field] = if ($allowed) { $value } else { $null }
                $diagnostic[$field + 'Omitted'] = -not $allowed
            }
            $diagnostic['category'] = $launchError.CategoryInfo.Category.ToString()
            $exception = $launchError.Exception
            for ($depth = 0; $null -ne $exception -and $depth -lt 8; $depth++) {
                $entry = [ordered]@{
                    type = $exception.GetType().FullName
                    hResult = $exception.HResult
                    parameterBinding = ($exception -is
                        [System.Management.Automation.ParameterBindingException])
                    objectDisposed = ($exception -is [System.ObjectDisposedException])
                }
                if ($exception -is [System.ComponentModel.Win32Exception]) {
                    $entry['nativeErrorCode'] = $exception.NativeErrorCode
                }
                $diagnostic['exceptionChain'] += , $entry
                $exception = $exception.InnerException
            }
            $diagnostic['exceptionChainTruncated'] = ($null -ne $exception)
            # These observations are after the failed call, in the harness
            # context. Exists=false is not proof of absence or child access.
            $diagnostic['callerRole'] = if ($Account.Role -in
                @('owner', 'other', 'owner_cleanup')) { $Account.Role } else { 'unknown' }
            $diagnostic['argumentArrayType'] = $Arguments.GetType().FullName
            $diagnostic['argumentCountIncludingExecutable'] = $Arguments.Count
            $inspected = [Math]::Min($Arguments.Count, 64)
            $nonempty = 0
            $types = @()
            for ($index = 0; $index -lt $inspected; $index++) {
                if (-not [string]::IsNullOrEmpty($Arguments[$index])) { $nonempty++ }
                $type = if ($null -eq $Arguments[$index]) { 'null' } else {
                    $Arguments[$index].GetType().FullName }
                if ($types -notcontains $type) { $types += $type }
            }
            $diagnostic['argumentsInspected'] = $inspected
            $diagnostic['argumentsTruncated'] = ($Arguments.Count -gt $inspected)
            $diagnostic['nonemptyInspectedArguments'] = $nonempty
            $diagnostic['inspectedArgumentTypes'] = $types
            $diagnostic['executableExistsInHarness'] = [System.IO.File]::Exists($Arguments[0])
            $diagnostic['workingDirectoryExistsInHarness'] =
                [System.IO.Directory]::Exists($WorkingDirectory)
            $diagnostic['complete'] = $true
        }
        catch {
            $diagnostic['captureFailureType'] = $_.Exception.GetType().FullName
            $diagnostic['captureFailureHResult'] = $_.Exception.HResult
        }
        # Upstream discards Win32Exception when formatting InvalidStartProcess.
        # Compare entire formatted strings ordinally; never persist the text,
        # any fragment/hash, or argument values. A candidate is not a cause.
        $discriminator = [ordered]@{
            complete = $false; state = 'unknown'; win32CodeCandidates = @()
            candidateSetExhaustive = $false; invalidApplicationTemplate = $null
            templateSupport = 'powershell_7_6_5_en_US_only'
        }
        $diagnostic['upstreamDiscriminator'] = $discriminator
        try {
            if ($runtime['supportedTemplateAndCulture'] -and
                $launchError.Exception.GetType() -eq [System.InvalidOperationException] -and
                $launchError.FullyQualifiedErrorId -ceq
                    'InvalidOperationException,Microsoft.PowerShell.Commands.StartProcessCommand') {
                $codeCandidates = @()
                foreach ($code in @(3, 5, 87, 193, 206, 267, 740, 1060, 1062,
                                    1314, 1326, 1327, 1331, 1385, 1450)) {
                    $expected = [string]::Format(
                        [System.Globalization.CultureInfo]::CurrentCulture,
                        'This command cannot be run due to the error: {0}',
                        [System.ComponentModel.Win32Exception]::new($code).Message)
                    if ([string]::Equals($launchError.Exception.Message, $expected,
                            [System.StringComparison]::Ordinal)) { $codeCandidates += , $code }
                }
                $discriminator['win32CodeCandidates'] = $codeCandidates
                $discriminator['state'] = if ($codeCandidates.Count -eq 0) { 'unmatched' }
                    elseif ($codeCandidates.Count -eq 1) { 'single_candidate' } else { 'ambiguous' }
                # Separate branch: this boolean never validates the generic map.
                if ($Arguments[0].Length -le 32768) {
                    $expectedApplication = [string]::Format(
                        [System.Globalization.CultureInfo]::CurrentCulture,
                        'This command cannot be run because the input "{0}" is not a valid Application.  Give a valid application and run your command again.',
                        $Arguments[0])
                    $discriminator['invalidApplicationTemplate'] = [string]::Equals(
                        $launchError.Exception.Message, $expectedApplication,
                        [System.StringComparison]::Ordinal)
                }
                $discriminator['complete'] = $true
            }
        }
        catch {
            $discriminator['state'] = 'unknown'
            $discriminator['win32CodeCandidates'] = @()
            $discriminator['invalidApplicationTemplate'] = $null
        }
        throw 'ordinary_principal_launch_unavailable'
    }
    # The process object itself is the lifetime handle; no name or table lookup.
    $record['launched'] = $true
    $record['processId'] = $process.Id
    $script:OwnedProcesses += , ([pscustomobject]@{
            Record = $record; Process = $process; Handled = $false
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

function Stop-OwnedProcesses {
    <#  Stop ONLY processes this script started, matched on the exact recorded
        identity. Never by image name and never by enumerating the process table.
        Each tracked process is handled and disposed exactly once, so this is
        safe to call again after a later child is launched. #>
    foreach ($owned in $script:OwnedProcesses) {
        if ($owned.Handled) { continue }
        $owned.Handled = $true
        try {
            if (-not $owned.Process.HasExited -and $owned.Process.Id -eq $owned.Id -and
                $owned.Process.StartTime -eq $owned.StartTime) {
                $owned.Process.Kill()
                [void]$owned.Process.WaitForExit(5000)
                $owned.Record['stoppedByHarness'] = $true
            }
        }
        catch { $script:measurementReceipt['cleanup'].errors += , "child_stop:$($_.Exception.GetType().Name)" }
        finally { $owned.Process.Dispose() }
    }
}

function Invoke-OwnerFixtureCleanup {
    <#  Removes the probe-created fixture tree inside the ordinary principal that
        owns it, BEFORE that account and profile are removed below.

        That tree carries an owner-only protected DACL by design, so this job's
        own context cannot enumerate it. The answer is to ask the owner, never to
        add an Administrators or SYSTEM ACE, take ownership, repair an ACL or
        enable a privilege: none of those happens anywhere in this script.

        The root is the one THIS script composed from WorkRoot and runId, not a
        path taken from a child receipt. The object list is what the owner child
        recorded, captured before the other child could write to the shared
        receipts directory, and the probe refuses the entire set if any member
        falls outside that exact root. #>
    param([Parameter(Mandatory = $true)][int]$TimeoutSeconds)
    $record = [ordered]@{ attempted = $false }
    $script:measurementReceipt['cleanup'].ownerContext = $record
    if ($null -eq $script:OwnerPrincipal -or $null -eq $script:FixtureRoot -or
        $null -eq $script:StagedProbe -or $null -eq $script:Interpreter) {
        # Partial setup: there is no owner context to clean in, and no deletion
        # target is invented to compensate for the missing one.
        $record['skipped'] = 'owner_context_unavailable'
        return
    }
    if (-not (Test-Path -LiteralPath $script:FixtureRoot)) {
        $record['skipped'] = 'no_owner_fixture_root_present'
        return
    }
    $record['attempted'] = $true
    $record['root'] = $script:FixtureRoot
    $record['recordedObjects'] = $script:OwnerCreatedObjects.Count
    $arguments = @($script:Interpreter, '-I', $script:StagedProbe,
                   '--role', 'cleanup', '--root', $script:FixtureRoot,
                   '--run-id', $script:RunId,
                   '--expect-sid', $script:OwnerPrincipal.Sid,
                   '--receipt', $script:CleanupReceiptPath,
                   '--attest-local-unsynced-disposable-parent')
    foreach ($object in $script:OwnerCreatedObjects) {
        $arguments += @('--object', $object)
    }
    # Same credential, same pinned staged probe, same bounded launch path as the
    # measurement children; only the role differs.
    $principal = [pscustomobject]@{
        Role = 'owner_cleanup'; Name = $script:OwnerPrincipal.Name
        Sid = $script:OwnerPrincipal.Sid; Credential = $script:OwnerPrincipal.Credential }
    try {
        $child = Invoke-ProbeAsPrincipal -Account $principal `
            -WorkingDirectory $script:StagePath `
            -StdOut (Join-Path $script:ReceiptsPath 'cleanup-stdout.txt') `
            -StdErr (Join-Path $script:ReceiptsPath 'cleanup-stderr.txt') `
            -TimeoutSeconds $TimeoutSeconds -Arguments $arguments
        $record['childExitCode'] = $child.exitCode
    }
    catch {
        $script:measurementReceipt['cleanup'].errors += , "owner_cleanup_child:$($_.Exception.Message)"
    }
    finally { Stop-OwnedProcesses }
    # The child's receipt is evidence only. The verdict is this script's own
    # Test-Path on the exact root it composed, so a forged or missing cleanup
    # receipt can never turn an incomplete removal into a reported success.
    if (Test-Path -LiteralPath $script:CleanupReceiptPath) {
        try {
            $record['receipt'] = Get-Content -LiteralPath $script:CleanupReceiptPath `
                -Raw -Encoding utf8 | ConvertFrom-Json
        }
        catch {
            $script:measurementReceipt['cleanup'].errors += , "owner_cleanup_receipt:$($_.Exception.GetType().Name)"
        }
    }
    else {
        $script:measurementReceipt['cleanup'].errors += , 'owner_cleanup_receipt_missing'
    }
}

$script:OwnedProcesses = @()
$script:OwnedAccounts = @()
$script:FixtureRoot = $null
$script:OwnerPrincipal = $null
$script:OwnerCreatedObjects = @()
$script:StagedProbe = $null
$script:StagePath = $null
$script:ReceiptsPath = $null
$script:CleanupReceiptPath = $null
$script:Interpreter = $null
$script:RunId = $null
$failure = $null
$exitCode = 1
$clock = [System.Diagnostics.Stopwatch]::StartNew()

try {
    foreach ($path in @($WorkRoot, $Probe, $Receipt)) {
        if (-not [System.IO.Path]::IsPathRooted($path)) { throw 'absolute_paths_required' }
    }
    if (-not (Test-Path -LiteralPath $Probe -PathType Leaf)) { throw 'probe_not_found' }
    $probeItem = Get-Item -LiteralPath $Probe
    $measurementReceipt['sourceHashes'] = [ordered]@{
        probe = (Get-FileHash -LiteralPath $Probe -Algorithm SHA256).Hash.ToLowerInvariant()
        runner = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $runId = -join ((1..4 | ForEach-Object {
        '{0:x2}' -f [System.Security.Cryptography.RandomNumberGenerator]::GetInt32(256) }))
    $measurementReceipt['runId'] = $runId
    $script:RunId = $runId

    $stage = Join-Path $WorkRoot 'stage'
    $receipts = Join-Path $WorkRoot 'receipts'
    $fixture = Join-Path $WorkRoot 'fixture'
    foreach ($directory in @($WorkRoot, $stage, $receipts, $fixture)) {
        if (-not (Test-Path -LiteralPath $directory)) {
            [void](New-Item -ItemType Directory -Path $directory)
        }
    }
    $script:StagePath = $stage
    $script:ReceiptsPath = $receipts
    $script:CleanupReceiptPath = Join-Path $receipts 'cleanup-receipt.json'
    # The exact root the pinned probe will compose from this parent and run id.
    # Deriving it here, rather than reading it back from a child receipt, is what
    # binds cleanup to a path no child can influence.
    $script:FixtureRoot = Join-Path $fixture ($script:RootPrefix + $runId)

    $owner = New-DisposableAccount -Name ("$script:AccountPrefix$runId" + 'o') -Role 'owner'
    $script:OwnerPrincipal = $owner
    $other = New-DisposableAccount -Name ("$script:AccountPrefix$runId" + 'x') -Role 'other'

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
    if ($stagedHash -ne $measurementReceipt['sourceHashes'].probe) { throw 'staged_probe_hash_mismatch' }
    $script:StagedProbe = $stagedProbe

    $python = (Get-Command -Name 'python' -CommandType Application |
        Select-Object -First 1).Source
    $measurementReceipt['interpreter'] = [ordered]@{ path = $python; pinnedBy = 'actions/setup-python' }
    $script:Interpreter = $python

    # Inert launch-only comparison; never substitutes for the U1 assertions.
    # Frozen Process.cs: space-join arguments, quote trimmed executable, append
    # one space and arguments, then pass that builder to CreateProcessWithLogonW.
    # Microsoft documents 1024 characters, without explicit NUL accounting.
    # These are derived UTF-16 lengths, NOT captured native buffers or bytes.
    $measurementReceipt['launchBoundary'] = [ordered]@{
        sourceUrl = 'https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw'
        sourceBodySha256 = '4c50e61e72139b852b6f4de845b73e2eff56d5d900e24ed9b79202135ca75755'
        documentedMaximumCharacters = 1024; documentedNulAccounting = 'unspecified'
        units = 'utf16_code_units'; nativeBufferObserved = $false
        diagnosticFailure = $false; cases = @()
    }
    foreach ($targetLength in @(900, 1024, 1134)) {
        $case = [ordered]@{
            targetLengthExcludingNul = $targetLength
            derivedActualLengthExcludingNul = $null
            derivedLengthWithOneTerminator = $null
            status = 'unknown'; codeCandidates = @()
            candidateSetExhaustive = $false; childIndex = $null
        }
        $measurementReceipt['launchBoundary'].cases += , $case
        $childIndex = $measurementReceipt.children.Count
        try {
            $executable = $python.Trim()
            $quotedLength = $executable.Length
            if (-not ($executable.StartsWith('"') -and $executable.EndsWith('"'))) {
                $quotedLength += 2
            }
            # Fixed arguments '-c', 'pass', and ONE inert ASCII filler argument:
            # joined length = 2 + 4 + filler + 2 separating spaces.
            $fillerLength = $targetLength - $quotedLength - 1 - 8
            if ($fillerLength -lt 1 -or $fillerLength -gt 1134) {
                throw 'boundary_length_unavailable'
            }
            $remaining = $OverallTimeoutSeconds - [int]$clock.Elapsed.TotalSeconds
            $null = Invoke-ProbeAsPrincipal -Account $owner -WorkingDirectory $stage `
                -StdOut (Join-Path $receipts ("boundary-$targetLength-stdout.txt")) `
                -StdErr (Join-Path $receipts ("boundary-$targetLength-stderr.txt")) `
                -TimeoutSeconds ([Math]::Min(5, $remaining)) `
                -Arguments @($python, '-c', 'pass', ('x' * $fillerLength))
        }
        catch {
            # Recover only from the bounded child record below, never messages.
            # An exception with no complete structural evidence stays unknown.
        }
        finally { Stop-OwnedProcesses }
        try {
            if ($measurementReceipt.children.Count -ne $childIndex + 1) {
                throw 'boundary_child_record_unavailable'
            }
            $case['childIndex'] = $childIndex
            $boundaryChild = $measurementReceipt.children[$childIndex]
            if (-not $boundaryChild.launchStructure.complete) {
                throw 'boundary_structure_unknown'
            }
            $actualLength = $boundaryChild.launchStructure.commandLineLengthExcludingNul
            $case['derivedActualLengthExcludingNul'] = $actualLength
            $case['derivedLengthWithOneTerminator'] = $actualLength + 1
            if ($actualLength -ne $targetLength) { throw 'boundary_length_mismatch' }
            if ($boundaryChild.launched -and -not $boundaryChild.timedOut -and
                $boundaryChild.exitCode -eq 0) {
                $case['status'] = 'exited_zero'
            }
            elseif (-not $boundaryChild.launched -and
                $boundaryChild.launchDiagnostic.complete -and
                $boundaryChild.launchDiagnostic.upstreamDiscriminator.complete) {
                $case['status'] = 'launch_failed'
                $case['codeCandidates'] = @(
                    $boundaryChild.launchDiagnostic.upstreamDiscriminator.win32CodeCandidates)
            }
        }
        catch { $case['status'] = 'unknown'; $case['codeCandidates'] = @() }
        if ($case['status'] -eq 'unknown' -or
            ($targetLength -eq 900 -and $case['status'] -ne 'exited_zero')) {
            $measurementReceipt['launchBoundary'].diagnosticFailure = $true
        }
    }

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
    $measurementReceipt['ownerReceipt'] = $ownerReceipt
    # Capture the owner's exact created-object list NOW: before the status check
    # below can throw and abandon a partially created tree, and before the other
    # child is launched with write access to the shared receipts directory.
    if ($ownerReceipt.PSObject.Properties.Name -contains 'createdObjects') {
        $script:OwnerCreatedObjects = @($ownerReceipt.createdObjects)
    }
    if ($ownerChild.exitCode -ne 0 -or $ownerReceipt.status -ne 'owner_private_api_observed_only') {
        throw 'owner_private_creation_unresolved'
    }

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
    $measurementReceipt['otherReceipt'] = $otherReceipt
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

    $measurementReceipt['ordinaryUserEvidence'] = 'two_verified_ordinary_token_sids_observed'
    if ($denied) {
        $measurementReceipt['status'] = 'owner_allowed_other_denied_api_observed_only'
        $exitCode = 0
    }
    else {
        $measurementReceipt['status'] = 'other_principal_denial_unresolved'
        $exitCode = 2
    }
}
catch {
    # The original failure is captured here and re-reported after cleanup runs,
    # so a cleanup error can never hide or replace it.
    $failure = $_
    $measurementReceipt['status'] = 'harness_failure'
    $measurementReceipt['reason'] = "$($_.Exception.Message)"
    $measurementReceipt['failureType'] = $_.Exception.GetType().Name
    $exitCode = if ("$($_.Exception.Message)" -in @(
            'ordinary_principal_launch_unavailable', 'child_timeout',
            'child_startup_failed_before_measurement',
            'overall_measurement_budget_exhausted',
            'owner_private_creation_unresolved')) { 2 } else { 1 }
}
finally {
    $measurementReceipt['cleanup'].attempted = $true
    $measurementReceipt['elapsedSeconds'] = [Math]::Round($clock.Elapsed.TotalSeconds, 3)
    Stop-OwnedProcesses
    # The probe-created tree is owner-only by construction, so this context
    # cannot enumerate it. It is removed inside its owning ordinary principal
    # here, BEFORE that account and profile are removed below.
    try { Invoke-OwnerFixtureCleanup -TimeoutSeconds $CleanupTimeoutSeconds }
    catch {
        # Cleanup must never abort the rest of this block: the accounts below and
        # the receipt at the end are removed and written on every path.
        $measurementReceipt['cleanup'].errors += , "owner_cleanup:$($_.Exception.GetType().Name)"
    }
    # Remove only the directories this script itself created, by exact path.
    foreach ($path in @($script:FixtureRoot, $WorkRoot)) {
        if ($null -ne $path -and (Test-Path -LiteralPath $path)) {
            try {
                Remove-Item -LiteralPath $path -Recurse -Force
            }
            catch {
                $measurementReceipt['cleanup'].errors += , "fixture_remove:$($_.Exception.GetType().Name)"
            }
        }
    }
    # fixtureRemoved is decided by this script's own observation of the exact
    # recorded paths, never by the absence of an exception and never by a child
    # receipt, so a swallowed error cannot present a leak as a removal.
    try {
        $stillPresent = @(@($script:FixtureRoot, $WorkRoot) | Where-Object {
            $null -ne $_ -and (Test-Path -LiteralPath $_) })
        $measurementReceipt['cleanup'].fixtureRemoved = ($stillPresent.Count -eq 0)
        if ($stillPresent.Count -ne 0) {
            $measurementReceipt['cleanup'].errors += , 'recorded_fixture_paths_still_present'
        }
    }
    catch {
        # Unobservable is not removed; the receipt below is still written.
        $measurementReceipt['cleanup'].errors += , "fixture_verify:$($_.Exception.GetType().Name)"
    }
    # Remove only recorded accounts, including partial setup, and profiles by SID.
    # There is no wildcard, prefix sweep or name pattern removal anywhere here.
    foreach ($account in $script:OwnedAccounts) {
        try {
            $profileEntry = Get-CimInstance -ClassName Win32_UserProfile |
                Where-Object { $_.SID -eq $account.Sid }
            if ($null -ne $profileEntry) {
                Remove-CimInstance -InputObject $profileEntry
                $measurementReceipt['cleanup'].profilesRemoved += , $account.Sid
            }
        }
        catch { $measurementReceipt['cleanup'].errors += , "profile_remove:$($_.Exception.GetType().Name)" }
        try {
            Remove-LocalUser -SID $account.Sid
            $measurementReceipt['cleanup'].accountsRemoved += , $account.Sid
        }
        catch { $measurementReceipt['cleanup'].errors += , "account_remove:$($_.Exception.GetType().Name)" }
    }
    if ($script:OwnedAccounts.Count -ne $measurementReceipt['cleanup'].accountsRemoved.Count) {
        $measurementReceipt['cleanup'].errors += , 'not_every_recorded_account_was_removed'
    }
    $measurementReceipt['cleanup'].complete = (
        $measurementReceipt['cleanup'].fixtureRemoved -and
        $measurementReceipt['cleanup'].errors.Count -eq 0)
    # The measured status is never rewritten by cleanup: the original outcome and
    # any original failure stay exactly as measured, and no success predicate is
    # relaxed. Only the exit code is raised, so a job whose measurement succeeded
    # but whose required cleanup did not is never reported as a full success.
    if (-not $measurementReceipt['cleanup'].complete -and $exitCode -eq 0) {
        $exitCode = 2
        $measurementReceipt['cleanupShortfall'] = 'measurement_observed_but_cleanup_incomplete'
    }
    $measurementReceipt['powerLossProven'] = $false
    $measurementReceipt['activationAuthorized'] = $false
    # Diagnostic failure cannot masquerade as a full functional pass. Existing
    # cleanup, private ACL and ordinary-principal verdicts remain independent.
    if ($measurementReceipt.Contains('launchBoundary') -and
        $measurementReceipt['launchBoundary'].diagnosticFailure -and $exitCode -eq 0) {
        $exitCode = 2
    }
    try {
        $json = $measurementReceipt | ConvertTo-Json -Depth 12
        Set-Content -LiteralPath $Receipt -Value $json -Encoding utf8
    }
    catch {
        Write-Output "Private auth runner: receipt_write_failed; $($_.Exception.GetType().Name)"
        $exitCode = 1
    }
    Write-Output ("Private auth runner: " + $measurementReceipt['status'] +
                  "; powerLossProven=false; activationAuthorized=false; O1-O5 unresolved")
    if ($measurementReceipt['cleanup'].errors.Count -gt 0) {
        Write-Output ("::warning::Cleanup reported " +
                      $measurementReceipt['cleanup'].errors.Count + " error(s); original outcome retained.")
    }
    if (-not $measurementReceipt['cleanup'].complete) {
        Write-Output ("::error::Fixture cleanup incomplete; measured outcome '" +
                      $measurementReceipt['status'] + "' is retained as-is, but this " +
                      "job is not a full success.")
    }
    if ($null -ne $failure) {
        Write-Output ("Private auth runner: original failure retained; " + $measurementReceipt['reason'])
    }
}

exit $exitCode
