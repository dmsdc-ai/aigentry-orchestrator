# run-as-user.ps1 - #1167 Windows private-storage ACL prototype, test-only. Two modes:
#  * dot-sourced (no -ChildMode): defines Invoke-PspAsUser, which starts a credentialed process as a fake
#    standard user (CreateProcessWithLogonW via .NET ProcessStartInfo; Secondary Logon). The password is a
#    SecureString that stays in the caller's memory. The child gets a minimal environment (no runner tokens).
#  * child (-ChildMode identity|probe|move-measure|node-test): runs AS that user, reads a request JSON and
#    writes a receipt JSON. probe uses raw Win32 calls and records numeric GetLastError codes; it never
#    loads the product helper (node-test runs acl.test.mjs, which is the only place the helper is loaded).
# Windows PowerShell 5.1 syntax.
[CmdletBinding()]
param([string]$ChildMode, [string]$RequestPath, [string]$ReceiptPath)
Set-StrictMode -Version 2.0

function Get-PspLaunchPrerequisite { param([int]$Code)
  switch ($Code) {
    1058 { 'Secondary Logon (seclogon) service is disabled' }
    1385 { 'account lacks the interactive logon right used by CreateProcessWithLogonW' }
    1326 { 'logon failure for the fake account (credential not accepted)' }
    1327 { 'account restriction (e.g. blank-password or policy)' }
    1331 { 'account disabled' }
    5 { 'access denied starting the credentialed process (working directory or image not accessible to the user)' }
    267 { 'working directory invalid for the user' }
    2 { 'image not found' }
    default { "credentialed launch failed with Win32 error $Code" }
  }
}

function Invoke-PspAsUser {
  param([string]$UserName, [System.Security.SecureString]$Password, [string]$Mode, [string]$Request, [string]$Receipt,
    [string]$WorkDir, [string]$TempDir, [string]$ScriptPath, [string]$ExtraPath, [int]$TimeoutSec = 900)
  $r = [ordered]@{ user = $UserName; mode = $Mode; launched = $false; exitCode = $null; launchError = $null; prerequisite = $null; timedOut = $false; stdout = ''; stderr = '' }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $psi.Arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ChildMode {1} -RequestPath "{2}" -ReceiptPath "{3}"' -f $ScriptPath, $Mode, $Request, $Receipt)
  $psi.UserName = $UserName
  $psi.Domain = $env:COMPUTERNAME
  $psi.Password = $Password
  $psi.UseShellExecute = $false
  $psi.LoadUserProfile = $false
  $psi.WorkingDirectory = $WorkDir
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables.Clear()
  $sysPath = (Join-Path $env:SystemRoot 'System32') + ';' + $env:SystemRoot + ';' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
  if ($ExtraPath) { $sysPath = $ExtraPath + ';' + $sysPath }
  $envVals = [ordered]@{ SystemRoot = $env:SystemRoot; windir = $env:SystemRoot; ComSpec = $env:ComSpec; PATH = $sysPath; PATHEXT = '.COM;.EXE;.BAT;.CMD'
    TEMP = $TempDir; TMP = $TempDir; USERPROFILE = $WorkDir; APPDATA = $TempDir; LOCALAPPDATA = $TempDir; COMPUTERNAME = $env:COMPUTERNAME; NUMBER_OF_PROCESSORS = $env:NUMBER_OF_PROCESSORS
    PROCESSOR_ARCHITECTURE = $env:PROCESSOR_ARCHITECTURE; PSModulePath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules') }
  foreach ($k in $envVals.Keys) { $psi.EnvironmentVariables[$k] = [string]$envVals[$k] }
  $p = $null
  try { $p = [System.Diagnostics.Process]::Start($psi) }
  catch {
    $ex = $_.Exception
    while (($null -ne $ex) -and -not ($ex -is [System.ComponentModel.Win32Exception])) { $ex = $ex.InnerException }
    if ($null -ne $ex) { $r.launchError = $ex.NativeErrorCode; $r.prerequisite = Get-PspLaunchPrerequisite $ex.NativeErrorCode }
    else { $r.launchError = -1; $r.prerequisite = 'credentialed launch threw ' + $_.Exception.GetType().FullName }
    return $r
  }
  $r.launched = $true
  $outTask = $p.StandardOutput.ReadToEndAsync(); $errTask = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) { $r.timedOut = $true; try { $p.Kill() } catch { } ; [void]$p.WaitForExit(10000) }
  else { $p.WaitForExit() }
  $r.exitCode = $p.ExitCode
  if ($r.exitCode -eq -1073741502) { $r.prerequisite = 'child failed to initialize (0xC0000142): window station/desktop not accessible to the fake user' }
  $o = $outTask.Result; $e = $errTask.Result
  if ($o.Length -gt 65536) { $o = $o.Substring(0, 65536) + '...[truncated]' }
  if ($e.Length -gt 65536) { $e = $e.Substring(0, 65536) + '...[truncated]' }
  $r.stdout = $o; $r.stderr = $e
  return $r
}

if (-not $ChildMode) { return }

# ------------------------------- child side (runs as the fake user) -------------------------------
$ErrorActionPreference = 'Stop'
$req = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($req.tempDir) { $env:TEMP = $req.tempDir; $env:TMP = $req.tempDir }

$probeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace Psp1167 {
  public static class Probe {
    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, READ_CONTROL = 0x20000;
    const uint SHARE_ALL = 7, OPEN_EXISTING = 3, CREATE_NEW = 1, FLAG_BACKUP = 0x02000000, FLAG_OPEN_REPARSE = 0x00200000;
    static readonly IntPtr INVALID = new IntPtr(-1);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct FIND { public uint attrs; public uint c1, c2, a1, a2, w1, w2; public uint sizeHigh, sizeLow, r0, r1;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string alt; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string p, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr h, byte[] b, int n, out int r, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool MoveFileExW(string a, string b, uint f);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateHardLinkW(string link, string target, IntPtr sa);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool DeleteFileW(string p);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateDirectoryW(string p, IntPtr sa);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool RemoveDirectoryW(string p);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr FindFirstFileW(string p, out FIND d);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FindClose(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetNamedSecurityInfoW(string n, int t, uint i, out IntPtr o, out IntPtr g, out IntPtr d, out IntPtr s, out IntPtr sd);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr str, out uint len);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

    static int OpenClose(string p, uint access, uint disp, uint flags) {
      IntPtr h = CreateFileW(p, access, SHARE_ALL, IntPtr.Zero, disp, flags, IntPtr.Zero);
      if (h == INVALID) return Marshal.GetLastWin32Error();
      CloseHandle(h); return 0;
    }
    public static int Read(string p) {
      IntPtr h = CreateFileW(p, GENERIC_READ, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FLAG_OPEN_REPARSE, IntPtr.Zero);
      if (h == INVALID) return Marshal.GetLastWin32Error();
      try { byte[] b = new byte[1]; int r; return ReadFile(h, b, 1, out r, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error(); } finally { CloseHandle(h); }
    }
    // Opening for write is the access check; no byte is written.
    public static int WriteOpen(string p) { return OpenClose(p, GENERIC_WRITE, OPEN_EXISTING, FLAG_OPEN_REPARSE); }
    public static int ReadControl(string p) { return OpenClose(p, READ_CONTROL, OPEN_EXISTING, FLAG_OPEN_REPARSE | FLAG_BACKUP); }
    public static int Create(string p) { return OpenClose(p, GENERIC_WRITE, CREATE_NEW, 0); }
    public static int Mkdir(string p) { return CreateDirectoryW(p, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error(); }
    public static int Rmdir(string p) { return RemoveDirectoryW(p) ? 0 : Marshal.GetLastWin32Error(); }
    public static int Rename(string a, string b) { return MoveFileExW(a, b, 0) ? 0 : Marshal.GetLastWin32Error(); }
    public static int RenameReplace(string a, string b) { return MoveFileExW(a, b, 1) ? 0 : Marshal.GetLastWin32Error(); }
    public static int HardLink(string link, string target) { return CreateHardLinkW(link, target, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error(); }
    public static int Delete(string p) { return DeleteFileW(p) ? 0 : Marshal.GetLastWin32Error(); }
    public static int List(string dir) {
      FIND d; IntPtr h = FindFirstFileW(dir + "\\*", out d);
      if (h == INVALID) return Marshal.GetLastWin32Error();
      FindClose(h); return 0;
    }
    public static string Sddl(string p, out int err) {
      IntPtr o, g, d, s, sd; err = (int)GetNamedSecurityInfoW(p, 1, 0x7, out o, out g, out d, out s, out sd);
      if (err != 0) return null;
      try { IntPtr str; uint len; if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x7, out str, out len)) { err = Marshal.GetLastWin32Error(); return null; }
        string v = Marshal.PtrToStringUni(str); LocalFree(str); return v; } finally { LocalFree(sd); }
    }
  }
}
'@

function Write-PspReceipt { param($Obj) ($Obj | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $ReceiptPath -Encoding UTF8 }

function Invoke-PspProbeOp { param($o)
  switch ($o.op) {
    'read' { return [Psp1167.Probe]::Read($o.path) }
    'write-open' { return [Psp1167.Probe]::WriteOpen($o.path) }
    'read-control' { return [Psp1167.Probe]::ReadControl($o.path) }
    'create' { return [Psp1167.Probe]::Create($o.path) }
    'mkdir' { return [Psp1167.Probe]::Mkdir($o.path) }
    'rmdir' { return [Psp1167.Probe]::Rmdir($o.path) }
    'rename' { return [Psp1167.Probe]::Rename($o.path, $o.path2) }
    'hardlink' { return [Psp1167.Probe]::HardLink($o.path, $o.path2) }
    'delete' { return [Psp1167.Probe]::Delete($o.path) }
    'list' { return [Psp1167.Probe]::List($o.path) }
    default { throw "unknown probe op $($o.op)" }
  }
}

$receipt = [ordered]@{ schema = 'aigentry/1167-psp-child/v1'; mode = $ChildMode; startedUtc = (Get-Date).ToUniversalTime().ToString('o'); ok = $false }
try {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $receipt.userSid = $id.User.Value
  $receipt.userName = $id.Name
  switch ($ChildMode) {
    'identity' {
      $ErrorActionPreference = 'Continue'   # native stderr must be recorded, not thrown (PS 5.1 2>&1 semantics)
      $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
      $receipt.isAdministratorRole = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
      $receipt.groupSids = @($id.Groups | ForEach-Object { $_.Value })
      $raw = [ordered]@{}
      foreach ($w in @(@('user', '/user'), @('groups', '/groups'), @('priv', '/priv'))) {
        $out = & whoami.exe $w[1] /fo csv /nh 2>&1 | Out-String
        $raw[$w[0]] = [ordered]@{ exit = $LASTEXITCODE; csv = $out.Trim() }
      }
      $receipt.whoami = $raw
      $receipt.privileges = @(($raw.priv.csv -split "`r?`n") | Where-Object { $_ -match '^"' } | ForEach-Object {
          $c = $_ | ConvertFrom-Csv -Header 'name', 'description', 'state'; [ordered]@{ name = $c.name; state = $c.state } })
      if ($req.node) {
        $n = & $req.node -p "JSON.stringify({version:process.version,arch:process.arch,O_NOFOLLOW:(require('fs').constants.O_NOFOLLOW===undefined?null:require('fs').constants.O_NOFOLLOW)})" 2>&1 | Out-String
        $receipt.node = [ordered]@{ exit = $LASTEXITCODE; out = $n.Trim() }
      }
      $receipt.ok = $true
    }
    'probe' {
      Add-Type -TypeDefinition $probeSource -Language CSharp -IgnoreWarnings
      $results = @()
      foreach ($o in @($req.ops)) {
        $code = Invoke-PspProbeOp $o
        $path2 = $null; if ($o.PSObject.Properties['path2']) { $path2 = $o.path2 }
        $results += ,([ordered]@{ id = $o.id; op = $o.op; path = $o.path; path2 = $path2; expect = [int]$o.expect; code = [int]$code })
      }
      $receipt.results = $results
      $receipt.ok = $true
    }
    'move-measure' {
      Add-Type -TypeDefinition $probeSource -Language CSharp -IgnoreWarnings
      $m = [ordered]@{}
      $tmp = Join-Path $req.srcDir ('psp-tmp-' + [guid]::NewGuid().ToString('N') + '.tmp')
      $target = Join-Path $req.srcDir 'psp-move-target.bin'
      $moved = Join-Path $req.dstDir 'psp-moved.bin'
      [System.IO.File]::WriteAllBytes($tmp, [byte[]](1, 2, 3, 4))
      $e = 0
      $m.srcDirSddl = [Psp1167.Probe]::Sddl($req.srcDir, [ref]$e); $m.srcDirSddlError = $e
      $m.dstDirSddl = [Psp1167.Probe]::Sddl($req.dstDir, [ref]$e); $m.dstDirSddlError = $e
      $m.tmpSddl = [Psp1167.Probe]::Sddl($tmp, [ref]$e); $m.tmpSddlError = $e
      $m.sameDirRenameCode = [Psp1167.Probe]::RenameReplace($tmp, $target)
      $m.afterSameDirRenameSddl = [Psp1167.Probe]::Sddl($target, [ref]$e); $m.afterSameDirRenameSddlError = $e
      $m.crossDirMoveCode = [Psp1167.Probe]::RenameReplace($target, $moved)
      $m.afterCrossDirMoveSddl = [Psp1167.Probe]::Sddl($moved, [ref]$e); $m.afterCrossDirMoveSddlError = $e
      $m.cleanupCode = [Psp1167.Probe]::Delete($moved)
      $receipt.measure = $m
      $receipt.ok = $true
    }
    'node-test' {
      foreach ($p in $req.env.PSObject.Properties) { Set-Item -Path ("Env:" + $p.Name) -Value ([string]$p.Value) }
      # Start-Process redirection: raw bytes, and native stderr cannot become a terminating PowerShell error.
      $np = Start-Process -FilePath $req.node -ArgumentList @('--test', '--test-reporter=tap', $req.testFile) -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $req.tapFile -RedirectStandardError $req.stderrFile
      $receipt.nodeExit = $np.ExitCode
      $receipt.ok = ($np.ExitCode -eq 0)
    }
    default { throw "unknown child mode $ChildMode" }
  }
} catch {
  $receipt.error = $_.Exception.GetType().FullName + ': ' + $_.Exception.Message
}
$receipt.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
Write-PspReceipt $receipt
if ($receipt.ok) { exit 0 } else { exit 1 }
